import type {
  Candlestick,
  Interval,
  Mach1SDK,
  MonacoCoreSDKConfig,
  OrderbookEvent as MonacoOrderbookEvent,
  TradingPairResolver,
} from "mach1_sdk";
import { MonacoCoreSDK } from "mach1_sdk";
import { parseUnits } from "viem";
import { BaseTradingMode } from "@/domains/execution/trading-mode";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import {
  type RiskCheckResult,
  RiskManager,
} from "@/domains/trading/risk-manager";
import type { LiveTradingConfig } from "@/shared/types";
import {
  Address,
  MarketData,
  OrderRequest,
  OrderResult,
  Position,
  TradingPair,
  UnsubscribeFunction,
} from "@/shared/types";
import { createLogger } from "@/shared/utils/logger";
import { retryWithBackoff } from "@/shared/utils/rate-limiter";
import { getStringProp, isRecord } from "@/shared/utils/record-utils";

const logger = createLogger("LiveTradingEngine");

const isAuthError = (error: unknown): boolean => {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("auth")
  );
};

export interface LiveOrderData {
  order: OrderRequest;
  status: "pending" | "filled" | "cancelled" | "rejected" | "partially_filled";
  timestamp: number;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  executionPrice?: bigint;
  transactionHash?: string;
  gasUsed?: bigint;
  actualSlippage?: number;
  confirmations?: number;
}

export interface LiveTrade {
  timestamp: number;
  pair: TradingPair;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
  transactionHash: string;
  gasUsed: bigint;
  blockNumber: number;
  actualSlippage: number;
}

export class LiveTradingEngine extends BaseTradingMode {
  private config: LiveTradingConfig;
  private marketManager: MarketManager;
  private realtimeManager: RealtimeManager;
  private monacoSDK: MonacoCoreSDK;
  private riskManager?: RiskManager;
  private tradingPairs: string[];
  private ohlcvInterval: Interval;
  private candles: Map<string, Candlestick> = new Map();
  private orderbooks: Map<string, MonacoOrderbookEvent> = new Map();
  private marketSubscriptions: UnsubscribeFunction[] = [];
  private orders: Map<string, LiveOrderData> = new Map();
  private executedTrades: LiveTrade[] = [];
  private pendingTransactions: Map<
    string,
    { orderId: string; timestamp: number }
  > = new Map();

  // Strategy execution support
  private strategyCallback?: (data: MarketData) => Promise<void>;
  private strategyExecutionInterval = 300000; // 5 minutes default
  private lastStrategyExecution = 0;
  private strategyExecutionTimer?: NodeJS.Timeout;
  private isRunning = false;

  // Trading statistics
  private totalGasUsed = 0n;
  private totalFees = 0n;
  private successfulTrades = 0;
  private failedTrades = 0;
  private confirmationTimes: number[] = [];
  /** True when the caller supplied their own RealtimeManager instance. */
  private readonly _realtimeManagerProvided: boolean;

  constructor(
    config: LiveTradingConfig,
    marketManager?: MarketManager,
    realtimeManager?: RealtimeManager,
    riskManager?: RiskManager,
  ) {
    super();
    this.config = {
      ...config,
      confirmations: config.confirmations || 1,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 5000,
    };
    this.tradingPairs =
      config.tradingPairs && config.tradingPairs.length > 0
        ? config.tradingPairs
        : ["ETH/USDC", "BTC/USDC", "SOL/USDC"];
    this.ohlcvInterval = config.ohlcvInterval || "1d";
    this.riskManager = riskManager;

    logger.debug("Initializing LiveTradingEngine", {
      network: config.network,
      environment: config.environment || "staging",
    });

    // Initialize Monaco SDK with new configuration
    const sdkConfig: MonacoCoreSDKConfig = {
      network: config.network,
      privateKey: config.privateKey,
      mode: "live",
      environment: config.environment,
      rpcUrl: config.rpcUrl,
    };

    this.monacoSDK = new MonacoCoreSDK(sdkConfig);

    // Set trading paused callback
    this.monacoSDK.onTradingPaused(() => {
      logger.warn("Trading paused due to authentication or critical error");
      this.isRunning = false;
      if (this.config.onTradingPaused) {
        this.config.onTradingPaused();
      }
    });

    // Create or use provided managers
    this.marketManager = marketManager || new MarketManager();
    this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);
    this._realtimeManagerProvided = !!realtimeManager;

    // Initialize RealtimeManager - will be connected after SDK initialization
    this.realtimeManager =
      realtimeManager ||
      new RealtimeManager(
        this.marketManager,
        new OrderManager(this.marketManager),
      );
  }

  /**
   * Initialize the Monaco SDK and connect to live trading
   */
  async initialize(): Promise<void> {
    try {
      logger.debug("Initializing Monaco SDK for live trading");
      await this.monacoSDK.initialize();

      logger.debug("Monaco SDK initialized successfully", {
        authenticated: this.monacoSDK.isAuthenticated(),
      });

      // Connect realtime manager with SDK
      const sdk = this.monacoSDK.getSDK();
      this.marketManager.setSDK(sdk);
      this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);

      if (this._realtimeManagerProvided) {
        // Honour the injected manager: wire SDK in rather than replacing.
        this.realtimeManager.setSDK(sdk);
      } else {
        // Internal manager: replace with a fully-configured live instance.
        this.realtimeManager = new RealtimeManager(
          this.marketManager,
          new OrderManager(this.marketManager),
          sdk,
        );
      }
      await this.realtimeManager.connect();

      logger.debug("LiveTradingEngine initialization complete");
    } catch (error) {
      logger.error(
        "Failed to initialize LiveTradingEngine",
        {},
        error as Error,
      );
      throw error;
    }
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.monacoSDK.isInitialized()) {
      throw new Error(
        "LiveTradingEngine not initialized. Call initialize() first.",
      );
    }

    if (this.monacoSDK.isPaused()) {
      throw new Error("Trading is paused. Cannot place orders.");
    }

    const orderId = `live_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Validate order first
    if (!this.validateOrder(order)) {
      logger.warn("Order rejected: validation failed", {
        orderId,
        side: order.isBuy ? "BUY" : "SELL",
        baseToken: order.baseToken,
        quoteToken: order.quoteToken,
        price: order.price.toString(),
        quantity: order.quantity.toString(),
      });
      this.orders.set(orderId, {
        order,
        status: "rejected",
        timestamp: Date.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });

      return {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
    }

    const riskResult = await this.applyRiskChecks(order, orderId);
    if (riskResult && !riskResult.approved) {
      this.orders.set(orderId, {
        order,
        status: "rejected",
        timestamp: Date.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });

      throw new Error(
        `Order rejected by risk controls: ${(riskResult.rejectionReasons || []).join("; ")}`,
      );
    }

    // Pre-trade validation
    const preTradeCheck = await this.checkPreTradeConditions(order);
    if (
      !preTradeCheck.hasPermission ||
      !preTradeCheck.hasFunds ||
      !preTradeCheck.withinLimits
    ) {
      logger.warn("Order rejected: pre-trade checks failed", {
        orderId,
        hasPermission: preTradeCheck.hasPermission,
        hasFunds: preTradeCheck.hasFunds,
        withinLimits: preTradeCheck.withinLimits,
        estimatedSlippage: preTradeCheck.estimatedSlippage,
        maxSlippage: this.config.maxSlippage,
        estimatedGas: preTradeCheck.estimatedGas.toString(),
      });
      this.orders.set(orderId, {
        order,
        status: "rejected",
        timestamp: Date.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });

      return {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
    }

    // Create order record
    this.orders.set(orderId, {
      order,
      status: "pending",
      timestamp: Date.now(),
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    });

    try {
      // Execute order through Monaco SDK Adapter with backoff
      logger.debug("Placing order via Monaco SDK", {
        orderId,
        side: order.isBuy ? "BUY" : "SELL",
        price: order.price.toString(),
        quantity: order.quantity.toString(),
      });

      const result = await retryWithBackoff(
        async () => this.monacoSDK.placeOrder(order),
        {
          maxRetries: this.config.maxRetries,
          baseDelayMs: this.config.retryDelay,
          onRetry: (attempt, error, delay) => {
            logger.warn("Order placement retry scheduled", {
              orderId,
              attempt,
              delayMs: delay,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );

      // Update order data with result
      const orderData = this.orders.get(orderId);
      if (!orderData) {
        throw new Error(`Order data not found for ${orderId}`);
      }
      orderData.status = result.status;
      orderData.filledQuantity = result.filledQuantity;
      orderData.remainingQuantity = result.remainingQuantity;

      // Track statistics
      if (result.status === "filled") {
        this.successfulTrades++;
        this.logTrade(order, result);
      }

      logger.debug("Order placed successfully", {
        orderId: result.orderId,
        status: result.status,
      });

      return result;
    } catch (error) {
      logger.error("Failed to place order", { orderId }, error as Error);

      // Update order status
      const orderData = this.orders.get(orderId);
      if (orderData) {
        orderData.status = "rejected";
      }

      this.failedTrades++;

      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (
      orderData.status !== "pending" &&
      orderData.status !== "partially_filled"
    ) {
      throw new Error(`Cannot cancel order in status: ${orderData.status}`);
    }

    try {
      logger.info("Cancelling order", { orderId });
      await this.monacoSDK.cancelOrder(orderId);
      orderData.status = "cancelled";
      logger.info("Order cancelled successfully", { orderId });
    } catch (error) {
      logger.error("Failed to cancel order", { orderId }, error as Error);
      throw error;
    }
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    try {
      // TODO: Get balance from Monaco SDK vault or profile API
      const balance = await this.getBalance(pair.base);

      // Get current market price
      const currentPrice = await this.getCurrentPrice(pair);
      const value = (balance * currentPrice) / 100n;

      // Calculate unrealized P&L based on executed trades
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
    } catch (error) {
      logger.warn("Failed to get position", {
        symbol: pair.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        token: pair.base,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      };
    }
  }

  async getBalance(token: Address): Promise<bigint> {
    try {
      const sdk = this.monacoSDK.getSDK();
      const resolver = this.monacoSDK.getTradingPairResolver();
      const assetId = resolver.getAssetIdByTokenAddress(token);

      if (!assetId) {
        throw new Error(`Asset ID not found for token ${token}`);
      }

      const availableBalance = await this.getProfileAvailableBalance(
        sdk,
        assetId,
      );
      const decimals = this.resolveTokenDecimals(token, resolver);
      const availableRaw = parseUnits(availableBalance, decimals);

      logger.debug("Fetched profile balance", {
        token,
        assetId,
        amount: availableRaw.toString(),
        formatted: availableBalance,
      });

      return availableRaw;
    } catch (error) {
      logger.warn("Failed to get balance from profile", {
        token,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private resolveTokenDecimals(
    token: Address,
    resolver: TradingPairResolver,
  ): number {
    const normalized = token.toLowerCase();
    const pairs = resolver.getAllPairs();
    for (const pair of pairs) {
      if (pair.base_token_contract?.toLowerCase() === normalized) {
        return pair.base_decimals;
      }
      if (pair.quote_token_contract?.toLowerCase() === normalized) {
        return pair.quote_decimals;
      }
    }
    throw new Error(`Token decimals not found for ${token}`);
  }

  private async getProfileAvailableBalance(
    sdk: Mach1SDK,
    assetId: string,
  ): Promise<string> {
    const balances = await sdk.profile.getUserBalances();
    const balancesRecord = isRecord(balances) ? balances : undefined;
    const balanceEntries = balancesRecord?.balances;
    if (!Array.isArray(balanceEntries)) {
      throw new Error("Profile balances response missing balances array.");
    }

    for (const entry of balanceEntries) {
      if (!isRecord(entry)) {
        continue;
      }
      const entryAssetId = getStringProp(entry, "asset_id");
      if (entryAssetId !== assetId) {
        continue;
      }
      const available = getStringProp(entry, "available_balance");
      if (!available) {
        throw new Error(
          `Profile balance entry missing available_balance for asset ${assetId}.`,
        );
      }
      return available;
    }

    throw new Error(`No profile balance found for asset ${assetId}.`);
  }

  private async estimateGas(_transaction: unknown): Promise<bigint> {
    // Gas estimation handled by Monaco SDK internally
    return 0n;
  }

  private async calculateSlippage(order: OrderRequest): Promise<number> {
    try {
      const pairSymbol = `${order.baseToken}/${order.quoteToken}`;
      const orderbook =
        await this.realtimeManager.getOrderbookSnapshot(pairSymbol);

      if (!orderbook || (!orderbook.bids.length && !orderbook.asks.length)) {
        return this.config.maxSlippage;
      }

      const bookSide = (order.isBuy ? orderbook.asks : orderbook.bids).map(
        (level) => ({
          price: BigInt(level.price),
          quantity: BigInt(level.quantity),
        }),
      );
      return this.calculateOrderBookSlippage(order, bookSide);
    } catch (error) {
      logger.warn("Failed to calculate slippage", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.config.maxSlippage;
    }
  }

  private calculateOrderBookSlippage(
    order: OrderRequest,
    bookSide: Array<{ price: bigint; quantity: bigint }>,
  ): number {
    let remainingQuantity = order.quantity;
    let weightedPrice = 0n;

    for (const level of bookSide) {
      if (remainingQuantity <= 0n) break;

      const fillQuantity =
        remainingQuantity > level.quantity ? level.quantity : remainingQuantity;
      weightedPrice += level.price * fillQuantity;
      remainingQuantity -= fillQuantity;
    }

    if (remainingQuantity > 0n) {
      // Order cannot be fully filled, high slippage
      return this.config.maxSlippage;
    }

    const avgExecutionPrice = weightedPrice / order.quantity;
    const slippage =
      Math.abs(Number(avgExecutionPrice - order.price)) / Number(order.price);

    return Math.min(slippage, this.config.maxSlippage);
  }

  private async applyRiskChecks(
    order: OrderRequest,
    orderId?: string,
  ): Promise<RiskCheckResult | null> {
    if (!this.riskManager) {
      return null;
    }

    try {
      const result = await this.riskManager.validateOrder(order);
      if (!result.approved) {
        logger.warn("Order rejected by risk manager", {
          orderId: orderId || "unassigned",
          reasons: result.rejectionReasons,
          warnings: result.warnings,
        });
      }
      return result;
    } catch (error) {
      logger.error("Risk manager validation failed", {}, error as Error);
      throw error;
    }
  }

  async getTransactionStatus(txHash: string): Promise<{
    status: "pending" | "confirmed" | "failed";
    blockNumber?: number;
    gasUsed?: bigint;
  }> {
    try {
      // In a real implementation, this would check the blockchain
      // For now, simulate confirmed transaction
      return {
        status: "confirmed",
        blockNumber: 123456,
        gasUsed: 21000n,
      };
    } catch (error) {
      logger.warn(`Failed to get transaction status for ${txHash}:`, error);
      return {
        status: "failed",
      };
    }
  }

  async waitForConfirmation(
    txHash: string,
    confirmations = 1,
  ): Promise<boolean> {
    try {
      // In a real implementation, this would monitor the blockchain
      // For now, simulate successful confirmation after a delay
      await new Promise((resolve) => setTimeout(resolve, 3000)); // 3 second delay
      return true;
    } catch (error) {
      logger.error(`Failed to wait for confirmation of ${txHash}:`, error);
      return false;
    }
  }

  async getOrderBook(pair: TradingPair): Promise<{
    bids: Array<{ price: bigint; quantity: bigint }>;
    asks: Array<{ price: bigint; quantity: bigint }>;
  }> {
    try {
      const snapshot = await this.realtimeManager.getOrderbookSnapshot(
        pair.symbol,
      );
      if (!snapshot) {
        logger.warn("Orderbook snapshot unavailable", { symbol: pair.symbol });
        return { bids: [], asks: [] };
      }

      return {
        bids: snapshot.bids.map((level) => ({
          price: BigInt(level.price),
          quantity: BigInt(level.quantity),
        })),
        asks: snapshot.asks.map((level) => ({
          price: BigInt(level.price),
          quantity: BigInt(level.quantity),
        })),
      };
    } catch (error) {
      logger.warn("Failed to get order book", {
        symbol: pair.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        bids: [],
        asks: [],
      };
    }
  }

  async checkPreTradeConditions(order: OrderRequest): Promise<{
    hasPermission: boolean;
    hasFunds: boolean;
    withinLimits: boolean;
    estimatedGas: bigint;
    estimatedSlippage: number;
  }> {
    try {
      // Check if user has sufficient balance
      let balance: bigint;
      try {
        balance = await this.getBalance(
          order.isBuy ? order.quoteToken : order.baseToken,
        );
      } catch (error) {
        if (isAuthError(error)) {
          logger.warn("Auth error during pre-trade check, refreshing token");
          await this.monacoSDK.refreshAuthToken();
          balance = await this.getBalance(
            order.isBuy ? order.quoteToken : order.baseToken,
          );
        } else {
          throw error;
        }
      }
      const requiredAmount = order.isBuy
        ? (order.quantity * order.price) / 100n
        : order.quantity;

      const hasFunds = balance >= requiredAmount;

      // Estimate gas and slippage
      const estimatedGas = await this.estimateGas(order);
      const estimatedSlippage = await this.calculateSlippage(order);

      // Check slippage limits
      const withinLimits = estimatedSlippage <= this.config.maxSlippage;

      if (!hasFunds || !withinLimits) {
        logger.warn("Pre-trade check failed", {
          baseToken: order.baseToken,
          quoteToken: order.quoteToken,
          isBuy: order.isBuy,
          requiredAmount: requiredAmount.toString(),
          availableBalance: balance.toString(),
          estimatedSlippage,
          maxSlippage: this.config.maxSlippage,
        });
      }

      return {
        hasPermission: true, // Simplified - would check token approvals in real implementation
        hasFunds,
        withinLimits,
        estimatedGas,
        estimatedSlippage,
      };
    } catch (error) {
      logger.warn("Failed to check pre-trade conditions:", error);
      return {
        hasPermission: false,
        hasFunds: false,
        withinLimits: false,
        estimatedGas: 0n,
        estimatedSlippage: this.config.maxSlippage,
      };
    }
  }

  async emergencyStop(): Promise<void> {
    try {
      logger.info(
        "🚨 Emergency stop initiated - cancelling all open orders...",
      );

      // Get all pending orders
      const pendingOrders = Array.from(this.orders.entries()).filter(
        ([_, orderData]) =>
          orderData.status === "pending" ||
          orderData.status === "partially_filled",
      );

      // Cancel all pending orders
      const cancellationPromises = pendingOrders.map(async ([orderId, _]) => {
        try {
          await this.cancelOrder(orderId);
          logger.info(`✅ Cancelled order ${orderId}`);
        } catch (error) {
          logger.error(`❌ Failed to cancel order ${orderId}:`, error);
        }
      });

      await Promise.allSettled(cancellationPromises);

      // Stop strategy execution if running
      if (this.isRunning) {
        await this.stopLiveTrading();
      }

      logger.info("🛑 Emergency stop completed");
    } catch (error) {
      logger.error("❌ Emergency stop failed:", error);
      throw error;
    }
  }

  async getLiveTradingStats(): Promise<{
    totalGasUsed: bigint;
    totalFees: bigint;
    successRate: number;
    averageConfirmationTime: number;
  }> {
    const totalTrades = this.successfulTrades + this.failedTrades;
    const successRate =
      totalTrades > 0 ? this.successfulTrades / totalTrades : 0;

    const averageConfirmationTime =
      this.confirmationTimes.length > 0
        ? this.confirmationTimes.reduce((sum, time) => sum + time, 0) /
          this.confirmationTimes.length
        : 0;

    return {
      totalGasUsed: this.totalGasUsed,
      totalFees: this.totalFees,
      successRate,
      averageConfirmationTime,
    };
  }

  // Private helper methods
  private async getCurrentPrice(pair: TradingPair): Promise<bigint> {
    try {
      // Use MarketManager to get live market price
      return await this.marketManager.getCurrentPrice(pair);
    } catch (error) {
      logger.warn(`Failed to get current price for ${pair.symbol}:`, error);
      // Return a fallback price
      return 100n * 100n; // Default price scaled by 100
    }
  }

  private calculateUnrealizedPnL(
    token: Address,
    balance: bigint,
    currentPrice: bigint,
  ): bigint {
    if (balance === 0n) return 0n;

    // In live trading, we'd track average entry prices from executed trades
    // For now, return 0 as a simplified implementation
    return 0n;
  }

  // Order execution now handled by MonacoSDKAdapter.placeOrder()
  // No need for separate executeOrderOnChain method

  private async monitorTransaction(
    txHash: string,
    orderId: string,
  ): Promise<void> {
    try {
      const confirmationStart = Date.now();

      // Wait for transaction confirmation
      const confirmations = this.config.confirmations ?? 1;
      const success = await this.waitForConfirmation(txHash, confirmations);

      const confirmationTime = Date.now() - confirmationStart;
      this.confirmationTimes.push(confirmationTime);

      // Remove from pending transactions
      this.pendingTransactions.delete(txHash);

      const orderData = this.orders.get(orderId);
      if (!orderData) return;

      if (success) {
        // Get transaction details
        const txStatus = await this.getTransactionStatus(txHash);

        // Update order status
        orderData.status = "filled";
        orderData.filledQuantity = orderData.order.quantity;
        orderData.remainingQuantity = 0n;
        orderData.executionPrice = orderData.order.price; // In live trading, this could be different
        orderData.gasUsed = txStatus.gasUsed || 0n;
        orderData.confirmations = this.config.confirmations;

        // Track successful trade
        this.successfulTrades++;
        this.totalGasUsed += orderData.gasUsed ?? 0n;

        // Record the executed trade
        this.executedTrades.push({
          timestamp: Date.now(),
          pair: {
            base: orderData.order.baseToken,
            quote: orderData.order.quoteToken,
            symbol: `${orderData.order.baseToken}/${orderData.order.quoteToken}`,
          },
          side: orderData.order.isBuy ? "buy" : "sell",
          price: orderData.executionPrice ?? orderData.order.price,
          quantity: orderData.filledQuantity,
          transactionHash: txHash,
          gasUsed: orderData.gasUsed ?? 0n,
          blockNumber: txStatus.blockNumber || 0,
          actualSlippage: orderData.actualSlippage || 0,
        });

        logger.info(`✅ Order ${orderId} confirmed and filled. TX: ${txHash}`);

        // Log the successful trade
        this.logTrade(orderData.order, {
          orderId,
          status: "filled",
          filledQuantity: orderData.filledQuantity,
          remainingQuantity: orderData.remainingQuantity,
        });
      } else {
        // Transaction failed
        orderData.status = "rejected";
        this.failedTrades++;

        logger.error(`❌ Order ${orderId} transaction failed. TX: ${txHash}`);
      }
    } catch (error) {
      logger.error(`Failed to monitor transaction ${txHash}:`, error);

      // Update order status to rejected on monitoring failure
      const orderData = this.orders.get(orderId);
      if (orderData) {
        orderData.status = "rejected";
        this.failedTrades++;
      }
    }
  }

  /**
   * Strategy execution methods - similar to PaperTradingEngine
   */

  /**
   * Set the strategy callback to be executed during live trading
   */
  setStrategyCallback(
    callback: (data: MarketData) => Promise<void>,
    executionInterval = 300000,
  ): void {
    this.strategyCallback = callback;
    this.strategyExecutionInterval = executionInterval;
  }

  /**
   * Start live trading with strategy execution
   */
  async startLiveTrading(): Promise<void> {
    if (this.isRunning) {
      logger.warn("⚠️  Live trading is already running");
      return;
    }

    logger.info("🚀 Starting live trading with real strategy execution...");
    this.isRunning = true;

    try {
      // Connect to live market data
      await this.enableLiveMarketData();

      // Start strategy execution loop
      this.startStrategyExecutionLoop();

      logger.info(
        `📈 Strategy will execute every ${this.strategyExecutionInterval / 1000} seconds`,
      );
      logger.info("⚠️  WARNING: This is LIVE TRADING with real funds!");
    } catch (error) {
      logger.error("❌ Failed to start live trading:", error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop live trading and strategy execution
   */
  async stopLiveTrading(): Promise<void> {
    if (!this.isRunning) {
      logger.warn("⚠️  Live trading is not running");
      return;
    }

    logger.info("🛑 Stopping live trading...");
    this.isRunning = false;

    // Stop strategy execution timer
    if (this.strategyExecutionTimer) {
      clearInterval(this.strategyExecutionTimer);
      this.strategyExecutionTimer = undefined;
    }

    // Disconnect from live market data
    await this.disableLiveMarketData();

    logger.info("✅ Live trading stopped");
  }

  /**
   * Start the strategy execution loop
   */
  private startStrategyExecutionLoop(): void {
    if (!this.strategyCallback) {
      logger.warn(
        "⚠️  No strategy callback set. Call setStrategyCallback() first.",
      );
      return;
    }

    this.strategyExecutionTimer = setInterval(async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        // Construct live market data for strategy
        const marketData = await this.constructLiveMarketData();

        if (Object.keys(marketData).length > 0) {
          await this.strategyCallback?.(marketData);
          this.lastStrategyExecution = Date.now();
        }
      } catch (error) {
        logger.warn(`⚠️  Strategy execution error:`, error);
      }
    }, this.strategyExecutionInterval);

    // Execute once immediately to avoid waiting for the first interval
    (async () => {
      try {
        const marketData = await this.constructLiveMarketData();
        if (Object.keys(marketData).length > 0) {
          await this.strategyCallback?.(marketData);
          this.lastStrategyExecution = Date.now();
        }
      } catch (error) {
        logger.warn(`⚠️  Strategy execution error:`, error);
      }
    })();
  }

  /**
   * Construct live market data for strategy execution
   */
  private async constructLiveMarketData(): Promise<MarketData> {
    const marketData: MarketData = {};

    try {
      for (const pairSymbol of this.tradingPairs) {
        const pair = this.parseSymbolToPair(pairSymbol);
        if (!pair) continue;

        try {
          const candle = this.candles.get(pairSymbol);
          const orderbook = this.orderbooks.get(pairSymbol);

          let close = candle ? Number(candle.c) : undefined;
          let open = candle ? Number(candle.o) : close;
          let high = candle ? Number(candle.h) : close;
          let low = candle ? Number(candle.l) : close;
          let volume = candle ? Number(candle.v) : undefined;

          if (!candle) {
            const ticker = await this.marketManager.getTicker(pair);
            close = Number(ticker.price) / 100;
            open = close;
            high = Number(ticker.high24h) / 100;
            low = Number(ticker.low24h) / 100;
            volume = Number(ticker.volume24h);
          }

          const bestBid = orderbook?.bids?.length
            ? parseFloat(orderbook.bids[0].price)
            : null;
          const bestAsk = orderbook?.asks?.length
            ? parseFloat(orderbook.asks[0].price)
            : null;

          let spread =
            bestBid !== null && bestAsk !== null
              ? bestAsk - bestBid
              : undefined;

          if (spread === undefined || Number.isNaN(spread)) {
            const fallbackBook = await this.marketManager.getOrderBook(pair);
            const fbBid = fallbackBook.bids[0]?.price
              ? Number(fallbackBook.bids[0].price) / 100
              : undefined;
            const fbAsk = fallbackBook.asks[0]?.price
              ? Number(fallbackBook.asks[0].price) / 100
              : undefined;
            spread =
              fbBid !== undefined && fbAsk !== undefined ? fbAsk - fbBid : 0;
          }

          const price = close ?? 0;

          marketData[pairSymbol] = {
            open: open ?? price,
            high: high ?? price,
            low: low ?? price,
            close: price,
            volume: volume ?? 0,
            bestBid: bestBid ?? price,
            bestAsk: bestAsk ?? price,
            spread: spread ?? price * 0.002,
            orderBookDepth: {
              bids: orderbook?.bids?.length || 0,
              asks: orderbook?.asks?.length || 0,
            },
            timestamp: candle?.T || Date.now(),
            // Simple technical placeholders until analytics module is wired for live data
            rsi: 50,
            macdSignal: 0,
          };
        } catch (error) {
          logger.warn(`Failed to get market data for ${pairSymbol}:`, error);
        }
      }
    } catch (error) {
      logger.warn("Failed to construct live market data:", error);
    }

    return marketData;
  }

  /**
   * Parse symbol string to TradingPair object
   */
  private parseSymbolToPair(symbol: string): TradingPair | null {
    try {
      const resolver = this.monacoSDK.getTradingPairResolver();
      const normalized = resolver.normalizeSymbol(symbol);
      const pairMeta =
        resolver.getPairBySymbol(normalized) ||
        resolver.getPairBySymbol(normalized.toUpperCase()) ||
        resolver.getPairBySymbol(symbol);

      if (!pairMeta) {
        logger.warn("Trading pair not found in resolver", {
          symbol,
          normalized,
        });
        return null;
      }

      const baseAddr = pairMeta.base_token_contract as Address | undefined;
      const quoteAddr = pairMeta.quote_token_contract as Address | undefined;

      if (!baseAddr || !quoteAddr) {
        logger.warn("Resolver returned pair without contract addresses", {
          symbol,
          base: pairMeta.base_token_contract,
          quote: pairMeta.quote_token_contract,
        });
        return null;
      }

      return {
        base: baseAddr,
        quote: quoteAddr,
        symbol: resolver.normalizeSymbol(pairMeta.symbol),
      };
    } catch (error) {
      logger.warn(`Failed to parse symbol ${symbol}:`, error);
      return null;
    }
  }

  /**
   * Fetch an initial snapshot (ticker + orderbook) for configured pairs before streaming.
   */
  private async fetchTradingPairSnapshots(): Promise<void> {
    for (const symbol of this.tradingPairs) {
      const pair = this.parseSymbolToPair(symbol);
      if (!pair) continue;

      try {
        // Use Monaco SDK candlesticks if available to seed OHLCV cache
        const sdk = this.monacoSDK.getSDK();
        const resolver = this.monacoSDK.getTradingPairResolver();
        const normalized = resolver.normalizeSymbol(symbol);
        const pairByContracts = resolver.getPairByContracts(
          pair.base,
          pair.quote,
        );
        const tradingPairId =
          pairByContracts?.id ?? resolver.resolveSymbolToId(normalized);
        const now = Date.now();
        const candles = await sdk.market.getCandlesticks(
          tradingPairId,
          this.ohlcvInterval,
          { endTime: now, limit: 1 },
        );

        const candle =
          Array.isArray(candles) && candles.length > 0
            ? candles[candles.length - 1]
            : undefined;
        if (candle) {
          this.candles.set(symbol, candle);
        }
      } catch (error) {
        logger.warn("Failed to fetch initial candlestick snapshot", {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Subscribe to OHLCV and orderbook streams for configured pairs.
   */
  private async subscribeToMarketStreams(): Promise<void> {
    for (const symbol of this.tradingPairs) {
      try {
        const unsubscribeOHLCV = await this.realtimeManager.subscribeOHLCV(
          symbol,
          this.ohlcvInterval,
          (candlestick: Candlestick) => this.candles.set(symbol, candlestick),
        );
        this.marketSubscriptions.push(unsubscribeOHLCV);
      } catch (error) {
        logger.warn("Failed to subscribe to OHLCV", {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const unsubscribeOrderbook =
          await this.realtimeManager.subscribeOrderbookUpdates(
            symbol,
            (orderbook: MonacoOrderbookEvent) =>
              this.orderbooks.set(symbol, orderbook),
          );
        this.marketSubscriptions.push(unsubscribeOrderbook);
      } catch (error) {
        logger.warn("Failed to subscribe to orderbook", {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private clearMarketSubscriptions(): void {
    this.marketSubscriptions.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (error) {
        logger.warn("Failed to clean up subscription", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.marketSubscriptions = [];
  }

  /**
   * Subscribe to real-time market data for live trading
   */
  async enableLiveMarketData(): Promise<void> {
    try {
      await this.fetchTradingPairSnapshots();
      await this.realtimeManager.connect();
      await this.subscribeToMarketStreams();
      logger.info(
        "✅ Connected to live market data for live trading (snapshots + streams)",
      );
    } catch (error) {
      logger.warn("⚠️  Failed to connect to live market data:", error);
      logger.info("📊 Live trading will continue with basic market data");
    }
  }

  /**
   * Disconnect from live market data
   */
  async disableLiveMarketData(): Promise<void> {
    this.clearMarketSubscriptions();
    await this.realtimeManager.disconnect();
    logger.info("📴 Disconnected from live market data");
  }

  /**
   * Check if live trading is currently running
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
  } {
    return {
      isRunning: this.isRunning,
      hasStrategy: !!this.strategyCallback,
      executionInterval: this.strategyExecutionInterval,
      lastExecution: this.lastStrategyExecution,
      timeSinceLastExecution: Date.now() - this.lastStrategyExecution,
    };
  }

  /**
   * Manually trigger strategy execution (useful for testing)
   */
  async executeStrategyNow(): Promise<void> {
    if (!this.strategyCallback) {
      throw new Error(
        "No strategy callback set. Call setStrategyCallback() first.",
      );
    }

    try {
      logger.info("🔄 Manually executing strategy...");
      const marketData = await this.constructLiveMarketData();

      if (Object.keys(marketData).length > 0) {
        await this.strategyCallback(marketData);
        this.lastStrategyExecution = Date.now();
        logger.info("✅ Strategy executed successfully");
      } else {
        logger.warn("⚠️  No market data available for strategy execution");
      }
    } catch (error) {
      logger.error("❌ Strategy execution failed:", error);
      throw error;
    }
  }

  /**
   * Get all executed trades for analysis
   */
  getExecutedTrades(): LiveTrade[] {
    return [...this.executedTrades];
  }

  /**
   * Get order history
   */
  getOrderHistory(): Map<string, LiveOrderData> {
    return new Map(this.orders);
  }

  /**
   * Get pending transactions
   */
  getPendingTransactions(): Map<
    string,
    { orderId: string; timestamp: number }
  > {
    return new Map(this.pendingTransactions);
  }

  /**
   * Get order status with detailed information
   */
  async getOrderStatus(orderId: string): Promise<{
    status:
      | "pending"
      | "filled"
      | "cancelled"
      | "rejected"
      | "partially_filled";
    filledQuantity: bigint;
    remainingQuantity: bigint;
    transactionHash?: string;
    gasUsed?: bigint;
    confirmations?: number;
  }> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error("Order not found");
    }

    return {
      status: orderData.status,
      filledQuantity: orderData.filledQuantity,
      remainingQuantity: orderData.remainingQuantity,
      transactionHash: orderData.transactionHash,
      gasUsed: orderData.gasUsed,
      confirmations: orderData.confirmations,
    };
  }

  /**
   * Expose realtime manager for consumers needing live websocket data.
   */
  getRealtimeManager(): RealtimeManager {
    return this.realtimeManager;
  }

  /**
   * Expose trading pair resolver so callers can map symbols to live pairs.
   */
  getTradingPairResolver(): TradingPairResolver {
    return this.monacoSDK.getTradingPairResolver();
  }

  getOHLCVInterval(): Interval {
    return this.ohlcvInterval;
  }
}

export type { LiveTradingConfig };
