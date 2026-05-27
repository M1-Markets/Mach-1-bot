import { MarketManager } from "@/domains/trading/market-manager";
import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import { OrderManager } from "@/domains/trading/order-manager";
import {
  Address,
  type MarketDataMode,
  type OrderLifecycleEvent,
  type OrderLifecycleRecord,
  Portfolio,
  Position,
  TradingPair,
} from "@/shared/types";
import type { InternalOrder } from "@/shared/types/internal-events";
import { calculateScaledNotionalValue } from "@/shared/utils";

export interface PositionData {
  token: Address;
  symbol: string;
  balance: bigint;
  value: bigint;
  averagePrice: bigint;
  unrealizedPnL: bigint;
  realizedPnL: bigint;
  totalFees: bigint;
  lastUpdated: number;
}

export interface TradeRecord {
  orderId: string;
  pair: TradingPair;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
  fees: bigint;
  feeCurrency?: Address;
  slippage: bigint;
  realizedPnL: bigint;
  timestamp: number;
  blockNumber?: number;
  transactionHash?: string;
}

export interface PositionTrackerOptions {
  mode?: Extract<MarketDataMode, "live" | "simulation" | "test">;
  startingBalances?: Record<Address, bigint>;
}

type TradingPairMetadata = {
  pair: TradingPair;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
};

type FillAccounting = {
  realizedPnL: bigint;
  appliedQuantity: bigint;
};

const DEFAULT_SIMULATION_BALANCES: Record<Address, bigint> = {
  "0x0987654321098765432109876543210987654321": 1_000_000_000n,
  "0x1234567890123456789012345678901234567890": 50_000n,
  "0x1111111111111111111111111111111111111111": 1_000_000n,
};

const CASH_TOKEN_SYMBOLS = new Set(["USD", "USDC", "USDT", "DAI"]);
const BUILTIN_TOKEN_METADATA: Record<
  Address,
  { symbol: string; decimals: number; isCash: boolean }
> = {
  "0x1111111111111111111111111111111111111111": {
    symbol: "ETH",
    decimals: 18,
    isCash: false,
  },
  "0x2222222222222222222222222222222222222222": {
    symbol: "BTC",
    decimals: 18,
    isCash: false,
  },
  "0x3333333333333333333333333333333333333333": {
    symbol: "SOL",
    decimals: 9,
    isCash: false,
  },
  "0x4444444444444444444444444444444444444444": {
    symbol: "USDC",
    decimals: 6,
    isCash: true,
  },
};

export class PositionTracker {
  private positions: Map<Address, PositionData> = new Map();
  private balances: Map<Address, bigint> = new Map();
  private tradeHistory: TradeRecord[] = [];
  private marketManager: MarketManager;
  private orderManager: OrderManager;
  private startTime: number;
  private appliedOrderFills: Map<
    string,
    { filledQuantity: bigint; fees: bigint; slippage: bigint }
  > = new Map();
  private readonly mode: Extract<MarketDataMode, "live" | "simulation" | "test">;
  private tradingPairMetadataPromise?: Promise<
    Map<string, TradingPairMetadata>
  >;

  constructor(
    marketManager: MarketManager,
    orderManager: OrderManager,
    options: PositionTrackerOptions = {},
  ) {
    this.marketManager = marketManager;
    this.orderManager = orderManager;
    this.startTime = Date.now();
    this.mode = options.mode ?? this.resolveModeFromMarketManager();
    this.initializeBalances(options.startingBalances);
  }

  private resolveModeFromMarketManager(): Extract<
    MarketDataMode,
    "live" | "simulation" | "test"
  > {
    if (
      "getMode" in this.marketManager &&
      typeof this.marketManager.getMode === "function"
    ) {
      return this.marketManager.getMode();
    }

    return "live";
  }

  private initializeBalances(startingBalances?: Record<Address, bigint>): void {
    this.balances.clear();

    if (startingBalances) {
      for (const [token, balance] of Object.entries(startingBalances)) {
        this.balances.set(token as Address, balance);
      }
      return;
    }

    if (this.mode !== "simulation") {
      return;
    }

    for (const [token, balance] of Object.entries(DEFAULT_SIMULATION_BALANCES)) {
      this.balances.set(token as Address, balance);
    }
  }

  async recordTrade(
    order: InternalOrder,
    fillPrice: bigint,
    fillQuantity: bigint,
    options?: {
      feeAmount?: bigint;
      feeCurrency?: Address;
      timestamp?: number;
    },
  ): Promise<void> {
    const { amount: fees, currency: feeCurrency } =
      await this.resolveFillFees(
        {
          pair: {
            base: order.baseToken,
            quote: order.quoteToken,
            symbol: `${order.baseToken}/${order.quoteToken}`,
          },
          type: order.orderType === "LIMIT" ? "limit" : "market",
        },
        fillPrice,
        fillQuantity,
        options?.feeAmount,
        options?.feeCurrency,
      );
    const syntheticOrder: OrderLifecycleRecord = {
      localId: order.id,
      pair: {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: `${order.baseToken}/${order.quoteToken}`,
      },
      side: order.isBuy ? "buy" : "sell",
      type: order.orderType === "LIMIT" ? "limit" : "market",
      requestedPrice: order.price,
      requestedQuantity: order.quantity,
      filledQuantity: fillQuantity,
      remainingQuantity: order.quantity - fillQuantity,
      averageFillPrice: fillPrice,
      fees,
      feeCurrency,
      slippage: 0n,
      status: "filled",
      submittedAt: options?.timestamp ?? order.timestamp,
      updatedAt: options?.timestamp ?? Date.now(),
    };
    await this.applyOrderFill(
      syntheticOrder,
      fillQuantity,
      syntheticOrder.fees,
      syntheticOrder.feeCurrency,
      syntheticOrder.slippage,
      options?.timestamp,
    );
  }

  attachOrderEventEmitter(orderEventEmitter: OrderEventEmitter): () => void {
    return orderEventEmitter.on((event) => {
      void this.handleOrderLifecycleEvent(event);
    });
  }

  async handleOrderLifecycleEvent(event: OrderLifecycleEvent): Promise<void> {
    if (event.type !== "partially_filled" && event.type !== "filled") {
      return;
    }

    const applied = this.appliedOrderFills.get(event.order.localId) ?? {
      filledQuantity: 0n,
      fees: 0n,
      slippage: 0n,
    };
    const deltaQuantity = event.order.filledQuantity - applied.filledQuantity;
    if (deltaQuantity <= 0n) {
      return;
    }

    const deltaFees = event.order.fees - applied.fees;
    const deltaSlippage = event.order.slippage - applied.slippage;
    await this.applyOrderFill(
      event.order,
      deltaQuantity,
      deltaFees > 0n ? deltaFees : 0n,
      event.order.feeCurrency,
      deltaSlippage > 0n ? deltaSlippage : 0n,
      event.timestamp,
    );
    this.appliedOrderFills.set(event.order.localId, {
      filledQuantity: event.order.filledQuantity,
      fees: event.order.fees,
      slippage: event.order.slippage,
    });
  }

  private async applyOrderFill(
    order: OrderLifecycleRecord,
    fillQuantity: bigint,
    fees: bigint,
    feeCurrency: Address | undefined,
    slippage: bigint,
    timestamp = Date.now(),
  ): Promise<void> {
    const fillPrice = order.averageFillPrice ?? 0n;
    const { amount: normalizedFees, currency: normalizedFeeCurrency } =
      await this.resolveFillFees(
        order,
        fillPrice,
        fillQuantity,
        fees,
        feeCurrency,
      );
    const accounting = this.updatePosition(
      order.pair.base,
      order.side === "buy",
      fillPrice,
      fillQuantity,
      normalizedFees,
    );

    const tradeRecord: TradeRecord = {
      orderId: order.localId,
      pair: order.pair,
      side: order.side,
      price: fillPrice,
      quantity: accounting.appliedQuantity,
      fees: normalizedFees,
      feeCurrency: normalizedFeeCurrency,
      slippage,
      realizedPnL: accounting.realizedPnL,
      timestamp,
    };

    this.tradeHistory.push(tradeRecord);
    this.updateBalances(
      order,
      fillPrice,
      accounting.appliedQuantity,
      normalizedFees,
    );
  }

  private updatePosition(
    baseToken: Address,
    isBuy: boolean,
    price: bigint,
    quantity: bigint,
    fees: bigint,
  ): FillAccounting {
    const token = baseToken;
    let position = this.positions.get(token);

    if (!position) {
      if (!isBuy) {
        return {
          realizedPnL: 0n,
          appliedQuantity: 0n,
        };
      }

      position = {
        token,
        symbol: "BASE",
        balance: 0n,
        value: 0n,
        averagePrice: 0n,
        unrealizedPnL: 0n,
        realizedPnL: 0n,
        totalFees: 0n,
        lastUpdated: Date.now(),
      };
      this.positions.set(token, position);
    }

    if (isBuy) {
      const oldValue = position.balance * position.averagePrice;
      const newValue = quantity * price;
      const totalQuantity = position.balance + quantity;

      if (totalQuantity > 0n) {
        position.averagePrice = (oldValue + newValue) / totalQuantity;
      }
      position.balance += quantity;
      position.value = (position.balance * position.averagePrice) / 100n;
      position.totalFees += fees;
      position.lastUpdated = Date.now();
      return {
        realizedPnL: 0n,
        appliedQuantity: quantity,
      };
    } else {
      const soldQuantity =
        quantity > position.balance ? position.balance : quantity;
      if (soldQuantity <= 0n) {
        return {
          realizedPnL: 0n,
          appliedQuantity: 0n,
        };
      }

      const realizedPnL =
        ((price - position.averagePrice) * soldQuantity) / 100n;
      position.realizedPnL += realizedPnL;
      position.balance -= soldQuantity;
      if (position.balance === 0n) {
        position.averagePrice = 0n;
      }
      position.value = (position.balance * position.averagePrice) / 100n;
      position.totalFees += fees;
      position.lastUpdated = Date.now();
      return {
        realizedPnL,
        appliedQuantity: soldQuantity,
      };
    }
  }

  private updateBalances(
    order: Pick<OrderLifecycleRecord, "pair" | "side" | "localId"> & {
      baseToken?: Address;
      quoteToken?: Address;
    },
    fillPrice: bigint,
    fillQuantity: bigint,
    fees: bigint,
  ): void {
    const baseToken = order.baseToken ?? order.pair.base;
    const quoteToken = order.quoteToken ?? order.pair.quote;
    const baseBalance = this.balances.get(baseToken) || 0n;
    const quoteBalance = this.balances.get(quoteToken) || 0n;

    if (order.side === "buy") {
      const cost = (fillPrice * fillQuantity) / BigInt(100) + fees;
      this.balances.set(baseToken, baseBalance + fillQuantity);
      this.balances.set(quoteToken, quoteBalance - cost);
    } else {
      const proceeds = (fillPrice * fillQuantity) / BigInt(100) - fees;
      this.balances.set(baseToken, baseBalance - fillQuantity);
      this.balances.set(quoteToken, quoteBalance + proceeds);
    }
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    const position = this.positions.get(pair.base);
    const balance = position?.balance ?? (this.balances.get(pair.base) || 0n);

    if (balance <= 0n) {
      return {
        token: pair.base,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      };
    }

    try {
      const currentPrice = await this.marketManager.getCurrentPrice(pair);
      const currentValue = (balance * currentPrice) / BigInt(100);
      const unrealizedPnL =
        position
          ? currentValue - (position.balance * position.averagePrice) / 100n
          : 0n;

      return {
        token: pair.base,
        balance,
        value: currentValue,
        unrealizedPnL,
      };
    } catch (_error) {
      return {
        token: pair.base,
        balance,
        value: position?.value ?? 0n,
        unrealizedPnL: position?.unrealizedPnL ?? 0n,
      };
    }
  }

  async getBalance(token: Address): Promise<bigint> {
    return this.balances.get(token) || 0n;
  }

  async getPortfolio(): Promise<Portfolio> {
    const portfolio = new Map<Address, Position>();
    let totalValue = 0n;
    let totalUnrealizedPnL = 0n;

    const tradingPairs = await this.marketManager.getAllTradingPairs();
    const metadataByToken = this.createMetadataByToken();
    for (const pair of tradingPairs) {
      const baseToken = pair.base_token_contract as Address;
      const quoteToken = pair.quote_token_contract as Address;
      metadataByToken.set(baseToken, {
        symbol: pair.base_token,
        decimals: pair.base_decimals,
        isCash: false,
      });
      metadataByToken.set(quoteToken, {
        symbol: pair.quote_token,
        decimals: pair.quote_decimals,
        isCash: CASH_TOKEN_SYMBOLS.has(pair.quote_token.toUpperCase()),
      });
    }

    for (const monacoTradingPair of tradingPairs) {
      const pair: TradingPair = {
        base: monacoTradingPair.base_token as Address,
        quote: monacoTradingPair.quote_token as Address,
        symbol: monacoTradingPair.symbol,
      };

      const position = await this.getPosition(pair);
      if (position.balance > 0n) {
        portfolio.set(position.token, position);
        totalValue += position.value;
        totalUnrealizedPnL += position.unrealizedPnL;
      }
    }

    for (const [token, balance] of this.balances.entries()) {
      if (balance > 0n && !portfolio.has(token)) {
        const tokenMetadata = metadataByToken.get(token);
        let value = tokenMetadata?.isCash
          ? this.convertRawBalanceToPortfolioValue(balance, tokenMetadata.decimals)
          : balance;

        if (tokenMetadata && !tokenMetadata.isCash) {
          const pair =
            tradingPairs.find(
              (currentPair) =>
                (currentPair.base_token_contract as Address) === token,
            ) ?? this.getBuiltInTradingPairForToken(token);

          if (pair) {
            value = await this.estimateBalanceValue(
              balance,
              {
                base:
                  "base_token_contract" in pair
                    ? (pair.base_token_contract as Address)
                    : pair.base,
                quote:
                  "quote_token_contract" in pair
                    ? (pair.quote_token_contract as Address)
                    : pair.quote,
                symbol: pair.symbol,
              },
            );
          }
        }

        portfolio.set(token, {
          token,
          balance,
          value,
          unrealizedPnL: 0n,
        });
        totalValue += value;
      }
    }

    return {
      positions: portfolio,
      totalValue,
      unrealizedPnL: totalUnrealizedPnL,
    };
  }

  async getOpenOrders(): Promise<
    Array<{
      orderId: string;
      pair: TradingPair;
      side: "buy" | "sell";
      price: bigint;
      quantity: bigint;
      filled: bigint;
      timestamp: number;
    }>
  > {
    const openOrders = await this.orderManager.getOpenOrders();

    return openOrders.map((order) => ({
      orderId: order.id,
      pair: {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: `${order.baseToken}/${order.quoteToken}`,
      },
      side: order.isBuy ? ("buy" as const) : ("sell" as const),
      price: order.price,
      quantity: order.quantity,
      filled: order.filledQuantity,
      timestamp: order.timestamp,
    }));
  }

  async getOrderHistory(
    pair?: TradingPair,
    limit = 100,
  ): Promise<
    Array<{
      orderId: string;
      pair: TradingPair;
      side: "buy" | "sell";
      price: bigint;
      quantity: bigint;
      filled: bigint;
      status: string;
      timestamp: number;
    }>
  > {
    const orderHistory = await this.orderManager.getOrderHistory(
      undefined,
      limit,
    );

    let filteredOrders = orderHistory;
    if (pair) {
      filteredOrders = orderHistory.filter(
        (order) =>
          order.baseToken === pair.base && order.quoteToken === pair.quote,
      );
    }

    return filteredOrders.map((order) => ({
      orderId: order.id,
      pair: {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: `${order.baseToken}/${order.quoteToken}`,
      },
      side: order.isBuy ? ("buy" as const) : ("sell" as const),
      price: order.price,
      quantity: order.quantity,
      filled: order.filledQuantity,
      status: order.status.toLowerCase(),
      timestamp: order.timestamp,
    }));
  }

  async calculatePnL(
    pair: TradingPair,
    period?: string,
  ): Promise<{
    realized: bigint;
    unrealized: bigint;
    fees: bigint;
    roi: number;
  }> {
    const position = this.positions.get(pair.base);
    const currentPosition = await this.getPosition(pair);

    let periodStart = this.startTime;
    if (period === "24h") {
      periodStart = Date.now() - 24 * 60 * 60 * 1000;
    } else if (period === "7d") {
      periodStart = Date.now() - 7 * 24 * 60 * 60 * 1000;
    } else if (period === "30d") {
      periodStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
    }

    const relevantTrades = this.tradeHistory.filter(
      (trade) =>
        trade.timestamp >= periodStart &&
        trade.pair.base === pair.base &&
        trade.pair.quote === pair.quote,
    );

    const totalFees = relevantTrades.reduce(
      (sum, trade) => sum + trade.fees,
      0n,
    );
    const realized = position?.realizedPnL || 0n;
    const unrealized = currentPosition.unrealizedPnL;

    const totalInvested = relevantTrades
      .filter((trade) => trade.side === "buy")
      .reduce(
        (sum, trade) =>
          sum + calculateScaledNotionalValue(trade.price, trade.quantity),
        0n,
      );

    const roi =
      totalInvested > 0n
        ? Number(realized + unrealized) / Number(totalInvested)
        : 0;

    return {
      realized,
      unrealized,
      fees: totalFees,
      roi,
    };
  }

  async getPositionSummary(): Promise<{
    totalValue: bigint;
    totalPnL: bigint;
    openPositions: number;
    dailyPnL: bigint;
  }> {
    const portfolio = await this.getPortfolio();
    const totalValue = portfolio.totalValue;
    const totalUnrealizedPnL = portfolio.unrealizedPnL;
    const totalRealizedPnL = Array.from(this.positions.values()).reduce(
      (sum, pos) => sum + pos.realizedPnL,
      0n,
    );

    const totalPnL = totalRealizedPnL + totalUnrealizedPnL;
    const openPositions = await this.countOpenBasePositions(portfolio);

    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const dailyTrades = this.tradeHistory.filter(
      (trade) => trade.timestamp >= dayStart,
    );
    const realizedDailyPnL = dailyTrades.reduce((sum, trade) => {
      const realizedComponent = trade.side === "sell" ? trade.realizedPnL : 0n;
      return sum + realizedComponent - trade.fees;
    }, 0n);
    const dailyUnrealizedPnL =
      await this.calculateDailyUnrealizedPnLChange(dayStart);
    const dailyPnL = realizedDailyPnL + dailyUnrealizedPnL;

    return {
      totalValue,
      totalPnL,
      openPositions,
      dailyPnL,
    };
  }

  async getTradeHistory(
    pair?: TradingPair,
    limit = 100,
  ): Promise<TradeRecord[]> {
    let trades = this.tradeHistory;

    if (pair) {
      trades = trades.filter(
        (trade) =>
          trade.pair.base === pair.base && trade.pair.quote === pair.quote,
      );
    }

    return trades.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async getPerformanceMetrics(): Promise<{
    totalTrades: number;
    winRate: number;
    averageWin: bigint;
    averageLoss: bigint;
    profitFactor: number;
    sharpeRatio: number;
  }> {
    const trades = this.tradeHistory;
    const sellTrades = trades.filter((trade) => trade.side === "sell");

    if (sellTrades.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        averageWin: 0n,
        averageLoss: 0n,
        profitFactor: 0,
        sharpeRatio: 0,
      };
    }

    const wins = sellTrades.filter((trade) => {
      return trade.realizedPnL > 0n;
    });

    const losses = sellTrades.filter((trade) => {
      return trade.realizedPnL <= 0n;
    });

    const totalWins = wins.reduce((sum, trade) => sum + trade.realizedPnL, 0n);
    const totalLosses = losses.reduce(
      (sum, trade) => sum + (trade.realizedPnL < 0n ? -trade.realizedPnL : 0n),
      0n,
    );

    const winRate = wins.length / sellTrades.length;
    const averageWin = wins.length > 0 ? totalWins / BigInt(wins.length) : 0n;
    const averageLoss =
      losses.length > 0 ? totalLosses / BigInt(losses.length) : 0n;
    const profitFactor =
      totalLosses > 0n ? Number(totalWins) / Number(totalLosses) : 0;

    const returns = sellTrades.map((trade) => {
      const invested = Number((trade.price * trade.quantity) / 100n);
      return invested > 0 ? Number(trade.realizedPnL) / invested : 0;
    });

    const avgReturn =
      returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance =
      returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) /
      returns.length;
    const sharpeRatio = variance > 0 ? avgReturn / Math.sqrt(variance) : 0;

    return {
      totalTrades: sellTrades.length,
      winRate,
      averageWin,
      averageLoss,
      profitFactor,
      sharpeRatio,
    };
  }

  reset(): void {
    this.positions.clear();
    this.tradeHistory = [];
    this.appliedOrderFills.clear();
    this.initializeBalances();
  }

  private async resolveFillFees(
    order: Pick<OrderLifecycleRecord, "pair" | "type">,
    fillPrice: bigint,
    fillQuantity: bigint,
    suppliedFeeAmount?: bigint,
    suppliedFeeCurrency?: Address,
  ): Promise<{ amount: bigint; currency?: Address }> {
    if (suppliedFeeAmount !== undefined) {
      return {
        amount: suppliedFeeAmount,
        currency: suppliedFeeCurrency ?? order.pair.quote,
      };
    }

    const metadata = await this.getTradingPairMetadata(order.pair);
    const feeBps =
      order.type === "limit"
        ? metadata?.makerFeeBps ?? 0n
        : metadata?.takerFeeBps ?? 0n;

    return {
      amount:
        (calculateScaledNotionalValue(fillPrice, fillQuantity) * feeBps) /
        10_000n,
      currency: suppliedFeeCurrency ?? metadata?.pair.quote ?? order.pair.quote,
    };
  }

  private async getTradingPairMetadata(
    pair: TradingPair,
  ): Promise<TradingPairMetadata | undefined> {
    if (!this.tradingPairMetadataPromise) {
      this.tradingPairMetadataPromise = this.marketManager
        .getAllTradingPairs()
        .then((pairs) => {
          const metadata = new Map<string, TradingPairMetadata>();
          for (const currentPair of pairs) {
            metadata.set(
              this.getPairMetadataKey(
                currentPair.base_token_contract as Address,
                currentPair.quote_token_contract as Address,
              ),
              {
                pair: {
                  base: currentPair.base_token_contract as Address,
                  quote: currentPair.quote_token_contract as Address,
                  symbol: currentPair.symbol,
                },
                baseSymbol: currentPair.base_token,
                quoteSymbol: currentPair.quote_token,
                baseDecimals: currentPair.base_decimals,
                quoteDecimals: currentPair.quote_decimals,
                makerFeeBps: BigInt(currentPair.maker_fee_bps ?? 0),
                takerFeeBps: BigInt(currentPair.taker_fee_bps ?? 0),
              },
            );
          }
          return metadata;
        });
    }

    return (await this.tradingPairMetadataPromise).get(
      this.getPairMetadataKey(pair.base, pair.quote),
    );
  }

  private getPairMetadataKey(base: Address, quote: Address): string {
    return `${base}:${quote}`;
  }

  private createMetadataByToken(): Map<
    Address,
    { symbol: string; decimals: number; isCash: boolean }
  > {
    return new Map(
      Object.entries(BUILTIN_TOKEN_METADATA).map(([token, metadata]) => [
        token as Address,
        metadata,
      ]),
    );
  }

  private convertRawBalanceToPortfolioValue(
    balance: bigint,
    decimals: number,
  ): bigint {
    const unit = 10n ** BigInt(Math.max(decimals, 0));
    return unit > 0n ? (balance * 100n) / unit : balance;
  }

  private async estimateBalanceValue(
    balance: bigint,
    pair: TradingPair,
  ): Promise<bigint> {
    try {
      const currentPrice = await this.marketManager.getCurrentPrice(pair);
      return (balance * currentPrice) / 100n;
    } catch {
      return balance;
    }
  }

  private getBuiltInTradingPairForToken(token: Address): TradingPair | null {
    switch (token.toLowerCase()) {
      case "0x1111111111111111111111111111111111111111":
        return {
          base: token,
          quote: "0x4444444444444444444444444444444444444444" as Address,
          symbol: "ETH/USDC",
        };
      case "0x2222222222222222222222222222222222222222":
        return {
          base: token,
          quote: "0x4444444444444444444444444444444444444444" as Address,
          symbol: "BTC/USDC",
        };
      case "0x3333333333333333333333333333333333333333":
        return {
          base: token,
          quote: "0x4444444444444444444444444444444444444444" as Address,
          symbol: "SOL/USDC",
        };
      default:
        return null;
    }
  }

  private async countOpenBasePositions(portfolio: Portfolio): Promise<number> {
    let count = 0;

    for (const position of portfolio.positions.values()) {
      if (position.balance <= 0n) {
        continue;
      }

      if (await this.isCashToken(position.token)) {
        continue;
      }

      count++;
    }

    return count;
  }

  private async isCashToken(token: Address): Promise<boolean> {
    const metadata = await this.getTradingPairMetadataByToken(token);
    return metadata?.isCash ?? false;
  }

  private async getTradingPairMetadataByToken(
    token: Address,
  ): Promise<{ symbol: string; decimals: number; isCash: boolean } | undefined> {
    const pairs = await this.marketManager.getAllTradingPairs();

    for (const pair of pairs) {
      if ((pair.quote_token_contract as Address) === token) {
        return {
          symbol: pair.quote_token,
          decimals: pair.quote_decimals,
          isCash: CASH_TOKEN_SYMBOLS.has(pair.quote_token.toUpperCase()),
        };
      }

      if ((pair.base_token_contract as Address) === token) {
        return {
          symbol: pair.base_token,
          decimals: pair.base_decimals,
          isCash: CASH_TOKEN_SYMBOLS.has(pair.base_token.toUpperCase()),
        };
      }
    }

    return undefined;
  }

  private async calculateDailyUnrealizedPnLChange(
    dayStart: number,
  ): Promise<bigint> {
    let total = 0n;

    for (const [token, position] of this.positions.entries()) {
      if (position.balance <= 0n) {
        continue;
      }

      const baselineTrade = [...this.tradeHistory]
        .filter(
          (trade) => trade.pair.base === token && trade.timestamp < dayStart,
        )
        .sort((left, right) => right.timestamp - left.timestamp)[0];

      if (!baselineTrade) {
        continue;
      }

      try {
        const currentPrice = await this.marketManager.getCurrentPrice(
          baselineTrade.pair,
        );
        total +=
          ((currentPrice - baselineTrade.price) * position.balance) / 100n;
      } catch {
        continue;
      }
    }

    return total;
  }
}
