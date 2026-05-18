import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { Address, Portfolio, Position, TradingPair } from "@/shared/types";
import type { InternalOrder } from "@/shared/types/internal-events";

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
  timestamp: number;
  blockNumber?: number;
  transactionHash?: string;
}

export class PositionTracker {
  private positions: Map<Address, PositionData> = new Map();
  private balances: Map<Address, bigint> = new Map();
  private tradeHistory: TradeRecord[] = [];
  private marketManager: MarketManager;
  private orderManager: OrderManager;
  private startTime: number;

  constructor(marketManager: MarketManager, orderManager: OrderManager) {
    this.marketManager = marketManager;
    this.orderManager = orderManager;
    this.startTime = Date.now();
    this.initializeMockBalances();
  }

  private initializeMockBalances(): void {
    this.balances.set(
      "0x0987654321098765432109876543210987654321" as Address,
      BigInt(1000000000),
    ); // 10,000 USDC
    this.balances.set(
      "0x1234567890123456789012345678901234567890" as Address,
      BigInt(50000),
    ); // 0.5 BTC
    this.balances.set(
      "0x1111111111111111111111111111111111111111" as Address,
      BigInt(1000000),
    ); // 10 ETH
  }

  async recordTrade(
    order: InternalOrder,
    fillPrice: bigint,
    fillQuantity: bigint,
  ): Promise<void> {
    const fees = (fillPrice * fillQuantity) / BigInt(10000);
    const pair: TradingPair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    };

    const tradeRecord: TradeRecord = {
      orderId: order.id,
      pair,
      side: order.isBuy ? "buy" : "sell",
      price: fillPrice,
      quantity: fillQuantity,
      fees,
      timestamp: Date.now(),
      blockNumber: order.blockNumber,
      transactionHash: order.transactionHash,
    };

    this.tradeHistory.push(tradeRecord);
    this.updatePosition(
      order.baseToken,
      order.quoteToken,
      order.isBuy,
      fillPrice,
      fillQuantity,
      fees,
    );
    this.updateBalances(order, fillPrice, fillQuantity, fees);
  }

  private updatePosition(
    baseToken: Address,
    quoteToken: Address,
    isBuy: boolean,
    price: bigint,
    quantity: bigint,
    fees: bigint,
  ): void {
    const token = isBuy ? baseToken : quoteToken;
    let position = this.positions.get(token);

    if (!position) {
      position = {
        token,
        symbol: token === baseToken ? "BASE" : "QUOTE",
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
    } else {
      if (position.balance >= quantity) {
        const realizedPnL = (price - position.averagePrice) * quantity;
        position.realizedPnL += realizedPnL;
        position.balance -= quantity;
      }
    }

    position.totalFees += fees;
    position.lastUpdated = Date.now();
  }

  private updateBalances(
    order: InternalOrder,
    fillPrice: bigint,
    fillQuantity: bigint,
    fees: bigint,
  ): void {
    const baseBalance = this.balances.get(order.baseToken) || 0n;
    const quoteBalance = this.balances.get(order.quoteToken) || 0n;

    if (order.isBuy) {
      const cost = (fillPrice * fillQuantity) / BigInt(100) + fees;
      this.balances.set(order.baseToken, baseBalance + fillQuantity);
      this.balances.set(order.quoteToken, quoteBalance - cost);
    } else {
      const proceeds = (fillPrice * fillQuantity) / BigInt(100) - fees;
      this.balances.set(order.baseToken, baseBalance - fillQuantity);
      this.balances.set(order.quoteToken, quoteBalance + proceeds);
    }
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    const position = this.positions.get(pair.base);

    if (!position) {
      return {
        token: pair.base,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      };
    }

    try {
      const currentPrice = await this.marketManager.getCurrentPrice(pair);
      const currentValue = (position.balance * currentPrice) / BigInt(100);
      const unrealizedPnL =
        currentValue - (position.balance * position.averagePrice) / BigInt(100);

      return {
        token: pair.base,
        balance: position.balance,
        value: currentValue,
        unrealizedPnL,
      };
    } catch (_error) {
      return {
        token: pair.base,
        balance: position.balance,
        value: position.value,
        unrealizedPnL: position.unrealizedPnL,
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
        portfolio.set(token, {
          token,
          balance,
          value: balance,
          unrealizedPnL: 0n,
        });
        totalValue += balance;
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
        (sum, trade) => sum + (trade.price * trade.quantity) / BigInt(100),
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
    const openPositions = portfolio.positions.size;

    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const dailyTrades = this.tradeHistory.filter(
      (trade) => trade.timestamp >= dayStart,
    );
    const dailyPnL = dailyTrades.reduce((sum, trade) => {
      return (
        sum +
        (trade.side === "sell"
          ? (trade.price * trade.quantity) / BigInt(100)
          : 0n)
      );
    }, 0n);

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
      const position = this.positions.get(trade.pair.base);
      return position && trade.price > position.averagePrice;
    });

    const losses = sellTrades.filter((trade) => {
      const position = this.positions.get(trade.pair.base);
      return position && trade.price <= position.averagePrice;
    });

    const totalWins = wins.reduce((sum, trade) => {
      const position = this.positions.get(trade.pair.base);
      if (position) {
        return sum + (trade.price - position.averagePrice) * trade.quantity;
      }
      return sum;
    }, 0n);

    const totalLosses = losses.reduce((sum, trade) => {
      const position = this.positions.get(trade.pair.base);
      if (position) {
        return sum + (position.averagePrice - trade.price) * trade.quantity;
      }
      return sum;
    }, 0n);

    const winRate = wins.length / sellTrades.length;
    const averageWin = wins.length > 0 ? totalWins / BigInt(wins.length) : 0n;
    const averageLoss =
      losses.length > 0 ? totalLosses / BigInt(losses.length) : 0n;
    const profitFactor =
      totalLosses > 0n ? Number(totalWins) / Number(totalLosses) : 0;

    const returns = sellTrades.map((trade) => {
      const position = this.positions.get(trade.pair.base);
      if (position) {
        return (
          Number(trade.price - position.averagePrice) /
          Number(position.averagePrice)
        );
      }
      return 0;
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
    this.initializeMockBalances();
  }
}
