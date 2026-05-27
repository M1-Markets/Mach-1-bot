import { BaseTradingMode } from "@/domains/execution/trading-mode";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import { MarketManager } from "@/domains/trading/market-manager";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import { TradingPairService } from "@/domains/trading/trading-pair-service";
import type { PaperTradingConfig } from "@/shared/types";
import {
  Address,
  type CancellationResult,
  type ExecutionOrderRecord,
  type ExecutionOrderStatusResult,
  type ExecutionTrade,
  MarketData,
  OrderRequest,
  OrderResult,
  Position,
  TradingPair,
} from "@/shared/types";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import {
  createIdGenerator,
  type Clock,
  type IdGenerator,
  type Rng,
  realClock,
  realRng,
  realScheduler,
  type Scheduler,
} from "@/shared/utils/determinism";
import { createLogger } from "@/shared/utils/logger";

const logger = createLogger("PaperTradingEngine");

export interface PaperTrade {
  timestamp: number;
  pair: TradingPair;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
  pnl: bigint;
  commission: bigint;
  slippage: bigint;
}

export interface PaperOrderData extends ExecutionOrderRecord {
  order: OrderRequest;
  timestamp: number;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  executionPrice?: bigint;
  commission?: bigint;
  slippage?: bigint;
}

export class PaperTradingEngine extends BaseTradingMode {
  private config: PaperTradingConfig;
  private marketManager: MarketManager;
  private realtimeManager: RealtimeManager;
  private positions: Map<Address, bigint> = new Map();
  private cash = 0n;
  private orders: Map<string, PaperOrderData> = new Map();
  private executedTrades: PaperTrade[] = [];
  private portfolioValues: Array<{ timestamp: number; value: bigint }> = [];
  private entryPrices: Map<Address, bigint> = new Map(); // Track average entry prices for P&L calculation
  private maxDrawdown = 0;
  private peakValue = 0n;

  // Strategy execution support
  private strategyCallback?: (data: MarketData) => Promise<void>;
  private strategyExecutionInterval = 300000; // 5 minutes default
  private lastStrategyExecution = 0;
  private strategyExecutionCoordinator?: StrategyExecutionCoordinator;
  private isRunning = false;
  private readonly tradingPairService = new TradingPairService();

  private readonly rng: Rng;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly orderLifecycleStore: OrderLifecycleStore;
  private readonly orderIdGenerator: IdGenerator;

  constructor(
    config: PaperTradingConfig,
    marketManager: MarketManager,
    realtimeManager: RealtimeManager,
    options?: {
      rng?: Rng;
      clock?: Clock;
      scheduler?: Scheduler;
      orderLifecycleStore?: OrderLifecycleStore;
    },
  ) {
    super();
    this.config = config;
    this.marketManager = marketManager;
    this.realtimeManager = realtimeManager;
    if (
      "setMode" in this.marketManager &&
      typeof this.marketManager.setMode === "function"
    ) {
      this.marketManager.setMode("simulation");
    }
    if (
      "setMode" in this.realtimeManager &&
      typeof this.realtimeManager.setMode === "function"
    ) {
      this.realtimeManager.setMode("simulation");
    }
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
    this.scheduler = options?.scheduler ?? realScheduler;
    this.orderLifecycleStore =
      options?.orderLifecycleStore ?? new OrderLifecycleStore();
    this.orderIdGenerator = createIdGenerator("paper", {
      clock: this.clock,
      rng: this.rng,
    });
    this.cash = config.initialCapital;
    this.peakValue = config.initialCapital;

    // Initial portfolio value tracking
    this.updatePortfolioValue();
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const orderId = this.orderIdGenerator.next();
    const pair: TradingPair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    };

    this.orderLifecycleStore.createSubmittedOrder({
      localId: orderId,
      strategyId: order.strategyId,
      pair,
      order,
      timestamp: this.clock.now(),
    });

    // Validate order first
    if (!this.validateOrder(order)) {
      this.orders.set(orderId, {
        orderId,
        order,
        status: "rejected",
        timestamp: this.clock.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "rejected",
        reason: "validation_failed",
        timestamp: this.clock.now(),
      });
      return {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
    }

    this.orders.set(orderId, {
      orderId,
      order,
      status: "pending",
      timestamp: this.clock.now(),
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    });
    this.orderLifecycleStore.applyUpdate({
      localId: orderId,
      type: "accepted",
      status: "pending",
      timestamp: this.clock.now(),
    });

    this.scheduler.setTimeout(() => {
      this.simulateOrderFill(orderId);
    }, this.config.latencyMs);

    return {
      orderId,
      status: "pending",
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    };
  }

  private async simulateOrderFill(orderId: string): Promise<void> {
    const orderData = this.orders.get(orderId);
    if (!orderData || orderData.status !== "pending") return;

    try {
      const pair: TradingPair = {
        base: orderData.order.baseToken,
        quote: orderData.order.quoteToken,
        symbol: `${orderData.order.baseToken}/${orderData.order.quoteToken}`,
      };

      // Get current market price
      const currentPrice = await this.getCurrentPrice(pair);

      if (currentPrice === 0n) {
        // Market price unavailable, reject order
        orderData.status = "rejected";
        this.orderLifecycleStore.applyUpdate({
          localId: orderId,
          type: "rejected",
          reason: "price_unavailable",
          timestamp: this.clock.now(),
        });
        return;
      }

      // Validate order against available balance
      if (
        !(await this.validateOrderAgainstBalance(orderData.order, currentPrice))
      ) {
        orderData.status = "rejected";
        this.orderLifecycleStore.applyUpdate({
          localId: orderId,
          type: "rejected",
          reason: "insufficient_balance",
          timestamp: this.clock.now(),
        });
        return;
      }

      // Calculate slippage and commission
      const slippage = this.calculateSlippage(orderData.order, currentPrice);
      const commission = this.calculateCommission(
        orderData.order,
        currentPrice,
      );

      // Calculate execution price with slippage
      const executionPrice = orderData.order.isBuy
        ? currentPrice + slippage
        : currentPrice - slippage;

      // Execute the trade
      await this.executeTrade(
        orderData.order,
        executionPrice,
        commission,
        slippage,
      );

      // Update order status
      orderData.status = "filled";
      orderData.filledQuantity = orderData.order.quantity;
      orderData.remainingQuantity = 0n;
      orderData.executionPrice = executionPrice;
      orderData.commission = commission;
      orderData.slippage = slippage;
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "filled",
        status: "filled",
        filledQuantity: orderData.order.quantity,
        remainingQuantity: 0n,
        averageFillPrice: executionPrice,
        fees: commission,
        feeCurrency: orderData.order.quoteToken,
        slippage,
        timestamp: this.clock.now(),
      });

      // Log the trade
      this.logTrade(orderData.order, {
        orderId,
        status: "filled",
        filledQuantity: orderData.order.quantity,
        remainingQuantity: 0n,
      });
    } catch (error) {
      logger.warn(
        `Failed to simulate order fill for ${orderId}`,
        {},
        error as Error,
      );
      orderData.status = "rejected";
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "rejected",
        reason: error instanceof Error ? error.message : String(error),
        timestamp: this.clock.now(),
      });
    }
  }

  /**
   * Validate order against available balance
   */
  private async validateOrderAgainstBalance(
    order: OrderRequest,
    currentPrice: bigint,
  ): Promise<boolean> {
    if (order.isBuy) {
      // Check if we have enough cash to buy
      const totalCost =
        (currentPrice * order.quantity) / 100n +
        this.calculateCommission(order, currentPrice);
      return this.cash >= totalCost;
    } else {
      // Check if we have enough tokens to sell
      const currentBalance = this.positions.get(order.baseToken) ?? 0n;
      return currentBalance >= order.quantity;
    }
  }

  /**
   * Calculate realistic slippage based on order size and market conditions
   */
  private calculateSlippage(order: OrderRequest, currentPrice: bigint): bigint {
    // Base slippage from config
    const baseSlippage = BigInt(Math.floor(this.config.slippage * 10000)); // Convert to basis points

    // Calculate order size relative to typical volume (simplified for paper trading)
    const orderValue = (currentPrice * order.quantity) / 100n;

    // For paper trading, use a simplified slippage model
    // In a real implementation, this would use live orderbook depth
    let sizeMultiplier = 100n; // Default multiplier (1.0)

    // Increase slippage for larger orders (simplified)
    if (orderValue > 100000n * 100n) {
      // Orders larger than $100,000
      sizeMultiplier = 200n; // 2.0x slippage
    } else if (orderValue > 10000n * 100n) {
      // Orders larger than $10,000
      sizeMultiplier = 150n; // 1.5x slippage
    }

    const totalSlippage =
      (currentPrice * baseSlippage * sizeMultiplier) / (100n * 100n * 100n);
    return totalSlippage;
  }

  /**
   * Calculate commission fees
   */
  private calculateCommission(
    order: OrderRequest,
    currentPrice: bigint,
  ): bigint {
    const orderValue = (currentPrice * order.quantity) / 100n;
    const commissionRate = BigInt(Math.floor(this.config.commission * 10000)); // Convert to basis points
    return (orderValue * commissionRate) / 10000n;
  }

  /**
   * Execute trade and update positions
   */
  private async executeTrade(
    order: OrderRequest,
    executionPrice: bigint,
    commission: bigint,
    slippage: bigint,
  ): Promise<void> {
    const pair: TradingPair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    };

    if (order.isBuy) {
      // Buy: Spend quote token (cash), get base token
      const totalCost = (executionPrice * order.quantity) / 100n + commission;
      this.cash -= totalCost;

      const currentBase = this.positions.get(order.baseToken) ?? 0n;
      const newBalance = currentBase + order.quantity;
      this.positions.set(order.baseToken, newBalance);

      // Update average entry price for P&L calculations
      this.updateEntryPrice(
        order.baseToken,
        currentBase,
        newBalance,
        executionPrice,
      );
    } else {
      // Sell: Spend base token, get quote token (cash)
      const totalReceived =
        (executionPrice * order.quantity) / 100n - commission;
      this.cash += totalReceived;

      const currentBase = this.positions.get(order.baseToken) ?? 0n;
      this.positions.set(order.baseToken, currentBase - order.quantity);
    }

    // Calculate P&L for this trade
    const pnl = order.isBuy
      ? -(executionPrice * order.quantity) / 100n - commission
      : (executionPrice * order.quantity) / 100n - commission;

    // Record the executed trade
    this.executedTrades.push({
      timestamp: this.clock.now(),
      pair,
      side: order.isBuy ? "buy" : "sell",
      price: executionPrice,
      quantity: order.quantity,
      pnl,
      commission,
      slippage,
    });

    // Update portfolio value tracking
    this.updatePortfolioValue();
  }

  /**
   * Update average entry price for position tracking
   */
  private updateEntryPrice(
    token: Address,
    oldBalance: bigint,
    newBalance: bigint,
    executionPrice: bigint,
  ): void {
    if (oldBalance === 0n) {
      // New position
      this.entryPrices.set(token, executionPrice);
    } else {
      // Update weighted average entry price
      const oldEntryPrice = this.entryPrices.get(token) ?? executionPrice;
      const addedQuantity = newBalance - oldBalance;

      const totalCost =
        (oldBalance * oldEntryPrice) / 100n +
        (addedQuantity * executionPrice) / 100n;
      const avgEntryPrice = (totalCost * 100n) / newBalance;

      this.entryPrices.set(token, avgEntryPrice);
    }
  }

  async cancelOrder(orderId: string): Promise<CancellationResult> {
    const orderData = this.orders.get(orderId);
    if (orderData && orderData.status === "pending") {
      orderData.status = "cancelled";
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "cancelled",
        reason: "cancelled_by_user",
        timestamp: this.clock.now(),
      });
      return {
        orderId,
        status: "cancelled",
        filledQuantity: orderData.filledQuantity,
        remainingQuantity: orderData.remainingQuantity,
        cancellationApplied: true,
        reason: "cancelled_by_user",
      };
    } else if (!orderData) {
      throw new Error("Order not found");
    } else {
      throw new Error(`Cannot cancel order in status: ${orderData.status}`);
    }
  }

  getOrderLifecycleStore(): OrderLifecycleStore {
    return this.orderLifecycleStore;
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    const balance = this.positions.get(pair.base) ?? 0n;
    const currentPrice = await this.getCurrentPrice(pair);
    const value = (balance * currentPrice) / 100n;

    // Calculate unrealized P&L
    const unrealizedPnL = this.calculateUnrealizedPnL(
      pair.base,
      balance,
      currentPrice,
    );

    return {
      token: pair.base,
      balance,
      value,
      unrealizedPnL,
    };
  }

  async getBalance(token: Address): Promise<bigint> {
    if (token === ("0x0000000000000000000000000000000000000000" as Address)) {
      return this.cash;
    }
    return this.positions.get(token) ?? 0n;
  }

  /**
   * Calculate unrealized P&L for a position
   */
  private calculateUnrealizedPnL(
    token: Address,
    balance: bigint,
    currentPrice: bigint,
  ): bigint {
    if (balance === 0n) return 0n;

    const entryPrice = this.entryPrices.get(token);
    if (!entryPrice) return 0n;

    const currentValue = (balance * currentPrice) / 100n;
    const entryValue = (balance * entryPrice) / 100n;

    return currentValue - entryValue;
  }

  private async getCurrentPrice(pair: TradingPair): Promise<bigint> {
    try {
      // Use MarketManager to get live market price
      return await this.marketManager.getCurrentPrice(pair);
    } catch (error) {
      logger.warn(
        `Failed to get current price for ${pair.symbol}`,
        {},
        error as Error,
      );
      return 0n;
    }
  }

  /**
   * Update portfolio value tracking
   */
  private updatePortfolioValue(): void {
    const timestamp = this.clock.now();

    // Calculate total portfolio value (async operation, but we'll handle it separately)
    this.calculatePortfolioValueAsync()
      .then((totalValue) => {
        this.portfolioValues.push({
          timestamp,
          value: totalValue,
        });

        // Update peak value and drawdown tracking
        if (totalValue > this.peakValue) {
          this.peakValue = totalValue;
        } else if (this.peakValue > 0n) {
          const currentDrawdown =
            Number(this.peakValue - totalValue) / Number(this.peakValue);
          this.maxDrawdown = Math.max(this.maxDrawdown, currentDrawdown);
        }
      })
      .catch((error) => {
        logger.warn("Failed to calculate portfolio value", {}, error as Error);
      });
  }

  /**
   * Calculate total portfolio value using live prices
   */
  private async calculatePortfolioValueAsync(): Promise<bigint> {
    let totalValue = this.cash;

    for (const [token, balance] of this.positions) {
      if (balance > 0n) {
        try {
          // Create a trading pair for this token (assume it's paired with a quote token)
          const pair: TradingPair = {
            base: token,
            quote: "0x0000000000000000000000000000000000000000" as Address, // Placeholder - in real implementation this should be the actual quote token
            symbol: "TOKEN/USD",
          };

          const price = await this.getCurrentPrice(pair);
          totalValue += (balance * price) / 100n;
        } catch (error) {
          logger.warn(
            `Failed to get price for token ${token}`,
            {},
            error as Error,
          );
          // Skip this position in valuation if price unavailable
        }
      }
    }

    return totalValue;
  }

  async getOrderStatus(orderId: string): Promise<ExecutionOrderStatusResult> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error("Order not found");
    }

    return {
      orderId,
      status: orderData.status,
      filledQuantity: orderData.filledQuantity,
      remainingQuantity: orderData.remainingQuantity,
    };
  }

  async getPortfolioValue(): Promise<bigint> {
    return await this.calculatePortfolioValueAsync();
  }

  async getPaperTradingStats(): Promise<{
    totalTrades: number;
    winRate: number;
    totalPnL: bigint;
    currentDrawdown: number;
    sharpeRatio: number;
    profitFactor: number;
    avgTradeReturn: number;
    totalCommission: number;
    totalSlippage: number;
  }> {
    const totalTrades = this.executedTrades.length;

    if (totalTrades === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        totalPnL: 0n,
        currentDrawdown: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        avgTradeReturn: 0,
        totalCommission: 0,
        totalSlippage: 0,
      };
    }

    // Calculate win rate
    const winningTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) > 0,
    );
    const winRate = winningTrades.length / totalTrades;

    // Calculate total P&L
    const totalPnL = this.executedTrades.reduce(
      (sum, trade) => sum + trade.pnl,
      0n,
    );

    // Calculate current drawdown
    const currentDrawdown = this.maxDrawdown;

    // Calculate Sharpe ratio from portfolio value changes
    const sharpeRatio = this.calculateSharpeRatio();

    // Calculate profit factor
    const profitFactor = this.calculateProfitFactor();

    // Calculate average trade return
    const avgTradeReturn = Number(totalPnL) / totalTrades;

    // Calculate total commission and slippage
    const totalCommission = this.executedTrades.reduce(
      (sum, trade) => sum + Number(trade.commission),
      0,
    );
    const totalSlippage = this.executedTrades.reduce(
      (sum, trade) => sum + Number(trade.slippage),
      0,
    );

    return {
      totalTrades,
      winRate,
      totalPnL,
      currentDrawdown,
      sharpeRatio,
      profitFactor,
      avgTradeReturn,
      totalCommission,
      totalSlippage,
    };
  }

  /**
   * Calculate Sharpe ratio from portfolio value changes
   */
  private calculateSharpeRatio(): number {
    if (this.portfolioValues.length < 2) return 0;

    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < this.portfolioValues.length; i++) {
      const prevValue = Number(this.portfolioValues[i - 1].value);
      const currentValue = Number(this.portfolioValues[i].value);

      if (prevValue > 0) {
        returns.push((currentValue - prevValue) / prevValue);
      }
    }

    if (returns.length === 0) return 0;

    // Calculate mean and standard deviation
    const meanReturn =
      returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance =
      returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) /
      returns.length;
    const stdDev = Math.sqrt(variance);

    // Sharpe ratio (assuming risk-free rate of 0)
    return stdDev > 0 ? meanReturn / stdDev : 0;
  }

  /**
   * Calculate profit factor
   */
  private calculateProfitFactor(): number {
    const winningTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) > 0,
    );
    const losingTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) < 0,
    );

    const grossProfit = winningTrades.reduce(
      (sum, trade) => sum + Number(trade.pnl),
      0,
    );
    const grossLoss = Math.abs(
      losingTrades.reduce((sum, trade) => sum + Number(trade.pnl), 0),
    );

    return grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;
  }

  async reset(): Promise<void> {
    // Stop strategy execution if running
    if (this.isRunning) {
      await this.stopPaperTrading();
    }

    this.positions.clear();
    this.orders.clear();
    this.executedTrades = [];
    this.portfolioValues = [];
    this.entryPrices.clear();
    this.cash = this.config.initialCapital;
    this.maxDrawdown = 0;
    this.peakValue = this.config.initialCapital;
    this.lastStrategyExecution = 0;

    // Initial portfolio value tracking
    this.updatePortfolioValue();
  }

  /**
   * Enhanced order validation with risk checks
   */
  protected validateOrder(order: OrderRequest): boolean {
    // Basic validation
    if (order.quantity <= 0n) {
      logger.warn("Invalid order quantity", { quantity: order.quantity });
      return false;
    }

    if (order.price <= 0n) {
      logger.warn("Invalid order price", { price: order.price });
      return false;
    }

    // Validation will be completed in validateOrderAgainstBalance during execution
    return true;
  }

  /**
   * Get all executed trades for analysis
   */
  getExecutedTrades(): ExecutionTrade[] {
    return [...this.executedTrades];
  }

  /**
   * Get current portfolio positions
   */
  getAllPositions(): Map<Address, bigint> {
    return new Map(this.positions);
  }

  /**
   * Get order history
   */
  getOrderHistory(): Map<string, ExecutionOrderRecord> {
    return new Map(this.orders);
  }

  /**
   * Set the strategy callback to be executed during paper trading
   */
  setStrategyCallback(
    callback: (data: MarketData) => Promise<void>,
    executionInterval = 300000,
  ): void {
    this.strategyCallback = callback;
    this.strategyExecutionInterval = executionInterval;
  }

  /**
   * Start paper trading with strategy execution
   */
  async startPaperTrading(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Paper trading is already running");
      return;
    }

    console.log("🎮 Starting paper trading with live strategy execution...");
    this.isRunning = true;

    // Connect to live market data
    await this.enableLiveMarketData();

    this.strategyExecutionCoordinator = new StrategyExecutionCoordinator({
      executor: async () => {
        if (!this.strategyCallback) {
          return;
        }

        const marketData = await this.constructLiveMarketData();
        if (Object.keys(marketData).length > 0) {
          await this.strategyCallback?.(marketData);
          this.lastStrategyExecution = this.clock.now();
        }
      },
      intervalMs: this.strategyExecutionInterval,
    });

    await this.strategyExecutionCoordinator.start();

    console.log(
      `📈 Strategy will execute every ${this.strategyExecutionInterval / 1000} seconds`,
    );
  }

  /**
   * Stop paper trading and strategy execution
   */
  async stopPaperTrading(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("Paper trading is not running");
      return;
    }

    console.log("🛑 Stopping paper trading...");
    this.isRunning = false;

    if (this.strategyExecutionCoordinator) {
      await this.strategyExecutionCoordinator.stop();
      this.strategyExecutionCoordinator = undefined;
    }

    // Disconnect from live market data
    await this.disableLiveMarketData();

    console.log("✅ Paper trading stopped");
  }

  /**
   * Construct live market data for strategy execution
   */
  private async constructLiveMarketData(): Promise<MarketData> {
    const marketData: MarketData = {};

    try {
      // Get available trading pairs from the market manager
      const availablePairs = await this.getAvailableTradingPairs();

      for (const pair of availablePairs) {
        try {
          // Get current market price
          const currentPrice = await this.getCurrentPrice(pair);
          if (currentPrice === 0n) continue;

          // Get basic market data (in a real implementation, this would come from RealtimeManager)
          const price = Number(currentPrice) / 100; // Convert from scaled bigint

          marketData[pair.symbol] = {
            open: price * 0.998, // Mock OHLC with small variations
            high: price * 1.002,
            low: price * 0.997,
            close: price,
            volume: this.rng.next() * 1000000,
            rsi: 45 + this.rng.next() * 20,
            macdSignal: (this.rng.next() - 0.5) * 2,
            timestamp: this.clock.now(),
          };
        } catch (error) {
          logger.warn(
            `Failed to get market data for ${pair.symbol}`,
            {},
            error as Error,
          );
          continue;
        }
      }
    } catch (error) {
      logger.warn("Failed to construct live market data", {}, error as Error);
    }

    return marketData;
  }

  /**
   * Get available trading pairs (simplified)
   */
  private async getAvailableTradingPairs(): Promise<TradingPair[]> {
    try {
      if (
        "getAllTradingPairs" in this.marketManager &&
        typeof this.marketManager.getAllTradingPairs === "function"
      ) {
        const pairs = await this.marketManager.getAllTradingPairs();
        const resolvedPairs = pairs
          .map((pair) => {
            try {
              return this.tradingPairService.resolveSymbol(pair.symbol);
            } catch {
              if (
                /^0x[a-fA-F0-9]{40}$/.test(pair.base_token_contract) &&
                /^0x[a-fA-F0-9]{40}$/.test(pair.quote_token_contract)
              ) {
                return {
                  base: pair.base_token_contract as Address,
                  quote: pair.quote_token_contract as Address,
                  symbol: this.tradingPairService.normalizeSymbol(pair.symbol),
                };
              }
              return null;
            }
          })
          .filter((pair): pair is TradingPair => pair !== null);

        if (resolvedPairs.length > 0) {
          return resolvedPairs;
        }
      }
    } catch (error) {
      logger.warn("Failed to get available trading pairs", {}, error as Error);
    }

    return this.tradingPairService
      .getAllSymbols()
      .map((symbol) => this.tradingPairService.resolveSymbol(symbol));
  }

  /**
   * Subscribe to real-time market data for enhanced simulation
   */
  async enableLiveMarketData(): Promise<void> {
    try {
      if (
        "connect" in this.realtimeManager &&
        typeof this.realtimeManager.connect === "function"
      ) {
        await this.realtimeManager.connect();
      }
      console.log("✅ Connected to live market data for paper trading");
    } catch (error) {
      logger.warn("Failed to connect to live market data", {}, error as Error);
      logger.info("Paper trading will continue with basic price simulation");
    }
  }

  /**
   * Disconnect from live market data
   */
  async disableLiveMarketData(): Promise<void> {
    if (
      "disconnect" in this.realtimeManager &&
      typeof this.realtimeManager.disconnect === "function"
    ) {
      await this.realtimeManager.disconnect();
    }
    console.log("📴 Disconnected from live market data");
  }

  /**
   * Get connection status for live market data
   */
  getMarketDataStatus(): {
    connected: boolean;
    activeSubscriptions: number;
    totalEventListeners: number;
  } {
    if (
      "getConnectionStatus" in this.realtimeManager &&
      typeof this.realtimeManager.getConnectionStatus === "function"
    ) {
      return this.realtimeManager.getConnectionStatus();
    }

    return {
      connected: false,
      activeSubscriptions: 0,
      totalEventListeners: 0,
    };
  }

  /**
   * Check if paper trading is currently running
   */
  isStrategyRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get strategy execution stats
   */
  getStrategyExecutionStats(): {
    isRunning: boolean;
    hasStrategy: boolean;
    executionInterval: number;
    lastExecution: number;
    timeSinceLastExecution: number;
    state?: string;
    lastError?: string | null;
  } {
    const stats = this.strategyExecutionCoordinator?.getStats();
    return {
      isRunning: this.isRunning,
      hasStrategy: !!this.strategyCallback,
      executionInterval: this.strategyExecutionInterval,
      lastExecution: this.lastStrategyExecution,
      timeSinceLastExecution: this.clock.now() - this.lastStrategyExecution,
      state: stats?.state,
      lastError: stats?.lastError,
    };
  }

  /**
   * Manually trigger strategy execution (useful for testing)
   */
  async executeStrategyNow(): Promise<void> {
    if (!this.strategyExecutionCoordinator) {
      throw new Error(
        "No strategy execution coordinator available. Start paper trading first.",
      );
    }

    await this.strategyExecutionCoordinator.executeNow();
  }
}

export type { PaperTradingConfig };
