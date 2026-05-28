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
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import { BaseTradingMode } from "@/domains/execution/trading-mode";
import { MarketDataService } from "@/domains/trading/market-data-service";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import {
  type RiskCheckResult,
  RiskManager,
} from "@/domains/trading/risk-manager";
import { PriceUnavailableError } from "@/shared/errors";
import type { LiveTradingConfig } from "@/shared/types";
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
  UnsubscribeFunction,
} from "@/shared/types";
import {
  type Clock,
  createIdGenerator,
  type IdGenerator,
  type Rng,
  realClock,
  realRng,
} from "@/shared/utils/determinism";
import { createLogger } from "@/shared/utils/logger";
import { retryWithBackoff } from "@/shared/utils/rate-limiter";
import { getStringProp, isRecord } from "@/shared/utils/record-utils";
import { calculateScaledNotionalValue } from "@/shared/utils/trading-utils";

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

const NON_RETRYABLE_ORDER_ERROR_PATTERNS = [
  "bad request",
  "insufficient liquidity",
  "validation failed",
  "invalid order",
  "insufficient balance",
  "insufficient funds",
  "unauthorized",
  "forbidden",
] as const;

const RETRYABLE_ORDER_ERROR_PATTERNS = [
  "rate limit",
  "too many requests",
  "timeout",
  "temporarily unavailable",
  "connection reset",
  "network error",
  "service unavailable",
  "gateway timeout",
] as const;

const isRetryableOrderPlacementError = (error: unknown): boolean => {
  if (isRecord(error)) {
    const retryable = error.retryable;
    if (typeof retryable === "boolean") {
      return retryable;
    }

    const statusCode = error.statusCode;
    if (typeof statusCode === "number") {
      if (statusCode === 429 || statusCode >= 500) {
        return true;
      }
      if (statusCode >= 400) {
        return false;
      }
    }
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  if (
    NON_RETRYABLE_ORDER_ERROR_PATTERNS.some((pattern) =>
      message.includes(pattern),
    )
  ) {
    return false;
  }

  if (
    RETRYABLE_ORDER_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
  ) {
    return true;
  }

  return true;
};

export interface LiveOrderData extends ExecutionOrderRecord {
  engineOrderId?: string;
  exchangeOrderId?: string;
  order: OrderRequest;
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

type LivePairMetadata = {
  symbol: string;
  tradingPairId?: string;
  baseDecimals: number;
  quoteDecimals: number;
};

type LiveMarketDataSnapshot = {
  marketData: MarketData;
  missingSymbols: string[];
};

type NormalizedOrderbookLevel = {
  priceInQuoteBaseUnits: bigint;
  quantityInBaseUnits: bigint;
};

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
  private readonly marketDataService = new MarketDataService();
  private readonly orderLifecycleStore: OrderLifecycleStore;
  private readonly rng: Rng;
  private readonly clock: Clock;
  private readonly orderIdGenerator: IdGenerator;

  // Strategy execution support
  private strategyCallback?: (data: MarketData) => Promise<void>;
  private strategyExecutionInterval = 300000; // 5 minutes default
  private lastStrategyExecution = 0;
  private strategyExecutionCoordinator?: StrategyExecutionCoordinator;
  private isRunning = false;

  // Trading statistics
  private totalGasUsed = 0n;
  private totalFees = 0n;
  private successfulTrades = 0;
  private failedTrades = 0;
  private confirmationTimes: number[] = [];
  /** True when the caller supplied their own RealtimeManager instance. */
  private readonly _realtimeManagerProvided: boolean;

  private resolvePairSymbolFromContracts(
    baseToken: Address,
    quoteToken: Address,
  ): string {
    const resolver =
      typeof this.monacoSDK.getTradingPairResolver === "function"
        ? this.monacoSDK.getTradingPairResolver()
        : undefined;
    if (!resolver) {
      return `${baseToken}/${quoteToken}`;
    }
    const pair = resolver.getPairByContracts(baseToken, quoteToken);

    if (pair?.symbol) {
      return resolver.normalizeSymbol(pair.symbol);
    }

    return `${baseToken}/${quoteToken}`;
  }

  constructor(
    config: LiveTradingConfig,
    marketManager?: MarketManager,
    realtimeManager?: RealtimeManager,
    riskManager?: RiskManager,
    orderLifecycleStore?: OrderLifecycleStore,
    options?: { rng?: Rng; clock?: Clock },
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
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
    this.orderLifecycleStore = orderLifecycleStore ?? new OrderLifecycleStore();
    this.orderIdGenerator = createIdGenerator("live", {
      clock: this.clock,
      rng: this.rng,
    });

    logger.debug("Initializing LiveTradingEngine", {
      network: config.network,
      environment: config.environment || "staging",
    });

    // Initialize Monaco SDK with new configuration
    const sdkConfig: MonacoCoreSDKConfig = {
      network: config.network === "sei-mainnet" ? "mainnet" : "testnet",
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
    this.marketManager = marketManager || new MarketManager({ mode: "live" });
    this.marketManager.setMode("live");
    this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);
    this._realtimeManagerProvided = !!realtimeManager;

    // Initialize RealtimeManager - will be connected after SDK initialization
    this.realtimeManager =
      realtimeManager ||
      new RealtimeManager(
        this.marketManager,
        new OrderManager(this.marketManager),
        undefined,
        {
          mode: "live",
          rng: this.rng,
          clock: this.clock,
          orderEventEmitter: this.orderLifecycleStore.getEventEmitter(),
        },
      );
    this.realtimeManager.setMode("live");
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
      this.marketManager.setMode("live");
      this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);

      if (this._realtimeManagerProvided) {
        // Honour the injected manager: wire SDK in rather than replacing.
        this.realtimeManager.setSDK(sdk);
        this.realtimeManager.setMode("live");
      } else {
        // Internal manager: replace with a fully-configured live instance.
        this.realtimeManager = new RealtimeManager(
          this.marketManager,
          new OrderManager(this.marketManager),
          sdk,
          {
            mode: "live",
            rng: this.rng,
            clock: this.clock,
            orderEventEmitter: this.orderLifecycleStore.getEventEmitter(),
          },
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

    const orderId = this.orderIdGenerator.next();
    const pair: TradingPair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: this.resolvePairSymbolFromContracts(
        order.baseToken,
        order.quoteToken,
      ),
    };
    const pairMetadata = this.resolveLivePairMetadata(pair);
    this.orderLifecycleStore.createSubmittedOrder({
      localId: orderId,
      strategyId: order.strategyId,
      pair,
      order,
      timestamp: this.clock.now(),
    });

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

    const riskResult = await this.applyRiskChecks(order, orderId);
    if (riskResult && !riskResult.approved) {
      this.orders.set(orderId, {
        orderId,
        order,
        status: "rejected",
        timestamp: Date.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "rejected",
        reason: (riskResult.rejectionReasons || []).join("; "),
        timestamp: Date.now(),
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
        orderId,
        order,
        status: "rejected",
        timestamp: Date.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "rejected",
        reason: "pre_trade_checks_failed",
        timestamp: Date.now(),
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
      orderId,
      order,
      status: "pending",
      timestamp: Date.now(),
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    });
    this.orderLifecycleStore.applyUpdate({
      localId: orderId,
      type: "accepted",
      status: "pending",
      timestamp: Date.now(),
    });

    try {
      // Execute order through Monaco SDK Adapter with backoff
      logger.debug("Placing order via Monaco SDK", {
        orderId,
        side: order.isBuy ? "BUY" : "SELL",
        price: order.price.toString(),
        quantity: order.quantity.toString(),
      });

      const sdkOrder = this.toSdkSpotOrder(order, pairMetadata);

      const result = await retryWithBackoff(
        async () => this.monacoSDK.placeOrder(sdkOrder),
        {
          maxRetries: this.config.maxRetries,
          baseDelayMs: this.config.retryDelay,
          shouldRetry: isRetryableOrderPlacementError,
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
      const normalizedResult = this.fromSdkSpotOrderResult(
        result,
        pairMetadata,
      );
      orderData.status = normalizedResult.status;
      orderData.engineOrderId = result.orderId;
      orderData.exchangeOrderId = result.orderId;
      orderData.filledQuantity = normalizedResult.filledQuantity;
      orderData.remainingQuantity = normalizedResult.remainingQuantity;
      this.orderLifecycleStore.applyResult(orderId, normalizedResult, {
        engineOrderId: result.orderId,
        exchangeOrderId: result.orderId,
        averageFillPrice:
          normalizedResult.filledQuantity > 0n ? order.price : undefined,
        timestamp: Date.now(),
      });

      // Track statistics
      if (normalizedResult.status === "filled") {
        this.successfulTrades++;
        this.logTrade(order, normalizedResult);
      }

      logger.debug("Order placed successfully", {
        orderId,
        exchangeOrderId: result.orderId,
        status: result.status,
      });

      return {
        ...normalizedResult,
        orderId,
      };
    } catch (error) {
      logger.error("Failed to place order", { orderId }, error as Error);

      // Update order status
      const orderData = this.orders.get(orderId);
      if (orderData) {
        orderData.status = "rejected";
      }
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "rejected",
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });

      this.failedTrades++;

      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<CancellationResult> {
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
      const exchangeOrderId =
        orderData.exchangeOrderId ?? orderData.engineOrderId;
      if (!exchangeOrderId) {
        throw new Error(`Exchange order ID missing for ${orderId}`);
      }

      logger.info("Cancelling order", { orderId, exchangeOrderId });
      await this.monacoSDK.cancelOrder(exchangeOrderId);
      orderData.status = "cancelled";
      this.orderLifecycleStore.applyUpdate({
        localId: orderId,
        type: "cancelled",
        engineOrderId: orderData.engineOrderId,
        exchangeOrderId: orderData.exchangeOrderId,
        reason: "cancelled_by_user",
        timestamp: Date.now(),
      });
      logger.info("Order cancelled successfully", { orderId });
      return {
        orderId,
        status: "cancelled",
        filledQuantity: orderData.filledQuantity,
        remainingQuantity: orderData.remainingQuantity,
        cancellationApplied: true,
        reason: "cancelled_by_user",
      };
    } catch (error) {
      logger.error("Failed to cancel order", { orderId }, error as Error);
      throw error;
    }
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    try {
      const pairMetadata = this.resolveLivePairMetadata(pair);
      const balanceInBaseUnits = await this.getAvailableBalanceInTokenBaseUnits(
        pair.base,
      );
      const balance = this.fromTokenBaseUnits(
        balanceInBaseUnits,
        pairMetadata.baseDecimals,
      );

      // Get current market price
      const currentPrice = await this.getCurrentPrice(pair);
      const value = calculateScaledNotionalValue(currentPrice, balance);

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
    const resolver = this.monacoSDK.getTradingPairResolver();
    const decimals = this.resolveTokenDecimals(token, resolver);

    try {
      const availableRaw =
        await this.getAvailableBalanceInTokenBaseUnits(token);

      logger.debug("Fetched profile balance", {
        token,
        amount: availableRaw.toString(),
      });

      return this.fromTokenBaseUnits(availableRaw, decimals);
    } catch (error) {
      logger.warn("Failed to get balance from profile", {
        token,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async getAvailableBalanceInTokenBaseUnits(
    token: Address,
  ): Promise<bigint> {
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

    return availableRaw;
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
    const directBalance = await sdk.profile.getUserBalanceByAssetId(assetId);
    const directBalanceRecord = isRecord(directBalance)
      ? directBalance
      : undefined;
    const directAvailable = getStringProp(
      directBalanceRecord,
      "available_balance",
    );

    if (directAvailable) {
      return directAvailable;
    }

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

  private async calculateSlippage(
    order: OrderRequest,
    pairMetadata: LivePairMetadata,
    referencePriceInQuoteBaseUnits: bigint,
  ): Promise<number> {
    try {
      const orderbook = await this.realtimeManager.getOrderbookSnapshot(
        pairMetadata.symbol,
      );

      if (!orderbook || (!orderbook.bids.length && !orderbook.asks.length)) {
        return this.config.maxSlippage;
      }

      const bookSide = this.toNormalizedOrderbookLevels(
        order.isBuy ? orderbook.asks : orderbook.bids,
        pairMetadata,
        order.isBuy ? "ask" : "bid",
      );
      return this.calculateOrderBookSlippage(
        order,
        bookSide,
        referencePriceInQuoteBaseUnits,
        pairMetadata.baseDecimals,
      );
    } catch (error) {
      logger.warn("Failed to calculate slippage", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.config.maxSlippage;
    }
  }

  private calculateOrderBookSlippage(
    order: OrderRequest,
    bookSide: NormalizedOrderbookLevel[],
    referencePriceInQuoteBaseUnits: bigint,
    baseDecimals: number,
  ): number {
    const orderQuantityInBaseUnits = this.toTokenBaseUnits(
      order.quantity,
      baseDecimals,
    );
    let remainingQuantityInBaseUnits = orderQuantityInBaseUnits;
    let totalNotionalInQuoteBaseUnits = 0n;
    const baseUnitScale = 10n ** BigInt(baseDecimals);

    for (const level of bookSide) {
      if (remainingQuantityInBaseUnits <= 0n) {
        break;
      }

      const fillQuantityInBaseUnits =
        remainingQuantityInBaseUnits < level.quantityInBaseUnits
          ? remainingQuantityInBaseUnits
          : level.quantityInBaseUnits;
      totalNotionalInQuoteBaseUnits +=
        (level.priceInQuoteBaseUnits * fillQuantityInBaseUnits) / baseUnitScale;
      remainingQuantityInBaseUnits -= fillQuantityInBaseUnits;
    }

    if (remainingQuantityInBaseUnits > 0n || orderQuantityInBaseUnits <= 0n) {
      // Order cannot be fully filled, high slippage
      return this.config.maxSlippage;
    }

    const avgExecutionPriceInQuoteBaseUnits =
      (totalNotionalInQuoteBaseUnits * baseUnitScale) /
      orderQuantityInBaseUnits;
    if (referencePriceInQuoteBaseUnits <= 0n) {
      return this.config.maxSlippage;
    }
    const slippage =
      Math.abs(
        Number(
          avgExecutionPriceInQuoteBaseUnits - referencePriceInQuoteBaseUnits,
        ),
      ) / Number(referencePriceInQuoteBaseUnits);

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
      const metadata = this.resolveLivePairMetadata(pair);
      const snapshot = await this.realtimeManager.getOrderbookSnapshot(
        pair.symbol,
      );
      if (!snapshot) {
        logger.warn("Orderbook snapshot unavailable", { symbol: pair.symbol });
        return { bids: [], asks: [] };
      }

      return {
        bids: snapshot.bids.map((level) => ({
          price: this.parseTokenUnits(
            level.price,
            metadata.quoteDecimals,
            "orderbook bid price",
          ),
          quantity: this.parseTokenUnits(
            level.quantity,
            metadata.baseDecimals,
            "orderbook bid quantity",
          ),
        })),
        asks: snapshot.asks.map((level) => ({
          price: this.parseTokenUnits(
            level.price,
            metadata.quoteDecimals,
            "orderbook ask price",
          ),
          quantity: this.parseTokenUnits(
            level.quantity,
            metadata.baseDecimals,
            "orderbook ask quantity",
          ),
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
      const pair: TradingPair = {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: this.resolvePairSymbolFromContracts(
          order.baseToken,
          order.quoteToken,
        ),
      };
      const pairMetadata = this.resolveLivePairMetadata(pair);
      const referencePrice =
        order.orderType === "market"
          ? await this.getLivePriceInQuoteBaseUnits(pair)
          : order.price;
      const referencePriceInQuoteBaseUnits =
        order.orderType === "market"
          ? referencePrice
          : this.toTokenBaseUnits(referencePrice, pairMetadata.quoteDecimals);

      // Check if user has sufficient balance
      let balance: bigint;
      try {
        balance = await this.getAvailableBalanceInTokenBaseUnits(
          order.isBuy ? order.quoteToken : order.baseToken,
        );
      } catch (error) {
        if (isAuthError(error)) {
          logger.warn("Auth error during pre-trade check, refreshing token");
          await this.monacoSDK.refreshAuthToken();
          balance = await this.getAvailableBalanceInTokenBaseUnits(
            order.isBuy ? order.quoteToken : order.baseToken,
          );
        } else {
          throw error;
        }
      }
      const requiredAmount = order.isBuy
        ? this.calculateQuoteNotional(
            this.toTokenBaseUnits(order.quantity, pairMetadata.baseDecimals),
            referencePriceInQuoteBaseUnits,
            pairMetadata.baseDecimals,
          )
        : this.toTokenBaseUnits(order.quantity, pairMetadata.baseDecimals);

      const hasFunds = balance >= requiredAmount;

      // Estimate gas and slippage
      const estimatedGas = await this.estimateGas(order);
      const estimatedSlippage = await this.calculateSlippage(
        order,
        pairMetadata,
        referencePriceInQuoteBaseUnits,
      );

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
      if (error instanceof PriceUnavailableError) {
        throw error;
      }
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
    return this.getLivePrice(pair);
  }

  async getLivePrice(pair: TradingPair): Promise<bigint> {
    const metadata = this.resolveLivePairMetadata(pair);
    return this.fromTokenBaseUnits(
      await this.getLivePriceInQuoteBaseUnits(pair),
      metadata.quoteDecimals,
    );
  }

  private async getLivePriceInQuoteBaseUnits(
    pair: TradingPair,
  ): Promise<bigint> {
    const metadata = this.resolveLivePairMetadata(pair);
    const orderbook =
      this.orderbooks.get(metadata.symbol) ??
      (await this.realtimeManager.getOrderbookSnapshot(metadata.symbol));
    const bestBidRaw = orderbook?.bids?.[0]?.price;
    const bestAskRaw = orderbook?.asks?.[0]?.price;

    if (bestBidRaw !== undefined && bestAskRaw !== undefined) {
      const bestBid = this.parseTokenUnits(
        bestBidRaw,
        metadata.quoteDecimals,
        "orderbook best bid",
      );
      const bestAsk = this.parseTokenUnits(
        bestAskRaw,
        metadata.quoteDecimals,
        "orderbook best ask",
      );
      return (bestBid + bestAsk) / 2n;
    }

    if (bestAskRaw !== undefined) {
      return this.parseTokenUnits(
        bestAskRaw,
        metadata.quoteDecimals,
        "orderbook best ask",
      );
    }

    if (bestBidRaw !== undefined) {
      return this.parseTokenUnits(
        bestBidRaw,
        metadata.quoteDecimals,
        "orderbook best bid",
      );
    }

    const candle =
      this.candles.get(metadata.symbol) ??
      (await this.realtimeManager.getOHLCVSnapshot(
        metadata.symbol,
        this.ohlcvInterval,
      ));
    const close =
      candle?.c ?? (isRecord(candle) ? (candle.close ?? candle.c) : undefined);
    if (
      close !== undefined &&
      close !== null &&
      (typeof close === "string" ||
        typeof close === "number" ||
        typeof close === "bigint")
    ) {
      return this.parseTokenUnits(close, metadata.quoteDecimals, "OHLCV close");
    }

    throw new PriceUnavailableError(metadata.symbol, {
      sourcesTried: ["orderbook", "ohlcv"],
    });
  }

  private calculateUnrealizedPnL(
    token: Address,
    balance: bigint,
    currentPrice: bigint,
  ): bigint {
    if (balance === 0n) return 0n;

    const buyTrades = this.executedTrades.filter(
      (trade) => trade.pair.base === token && trade.side === "buy",
    );
    if (buyTrades.length === 0) {
      return 0n;
    }

    let totalBought = 0n;
    let totalSold = 0n;
    let totalCost = 0n;
    for (const trade of buyTrades) {
      totalBought += trade.quantity;
      totalCost += trade.price * trade.quantity;
    }
    for (const trade of this.executedTrades) {
      if (trade.pair.base === token && trade.side === "sell") {
        totalSold += trade.quantity;
      }
    }

    const openQuantity = totalBought - totalSold;
    if (openQuantity <= 0n) {
      return 0n;
    }

    const averageEntryPrice = totalCost / totalBought;
    return ((currentPrice - averageEntryPrice) * balance) / 100n;
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
            symbol: this.resolvePairSymbolFromContracts(
              orderData.order.baseToken,
              orderData.order.quoteToken,
            ),
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
        this.orderLifecycleStore.applyUpdate({
          localId: orderId,
          type: "filled",
          status: "filled",
          filledQuantity: orderData.filledQuantity,
          remainingQuantity: orderData.remainingQuantity,
          averageFillPrice: orderData.executionPrice ?? orderData.order.price,
          fees: orderData.gasUsed ?? 0n,
          feeCurrency: orderData.order.quoteToken,
          timestamp: Date.now(),
        });
      } else {
        // Transaction failed
        orderData.status = "rejected";
        this.failedTrades++;
        this.orderLifecycleStore.applyUpdate({
          localId: orderId,
          type: "rejected",
          reason: "transaction_failed",
          timestamp: Date.now(),
        });

        logger.error(`❌ Order ${orderId} transaction failed. TX: ${txHash}`);
      }
    } catch (error) {
      logger.error(`Failed to monitor transaction ${txHash}:`, error);

      // Update order status to rejected on monitoring failure
      const orderData = this.orders.get(orderId);
      if (orderData) {
        orderData.status = "rejected";
        this.failedTrades++;
        this.orderLifecycleStore.applyUpdate({
          localId: orderId,
          type: "rejected",
          reason: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
      }
    }
  }

  getOrderLifecycleStore(): OrderLifecycleStore {
    return this.orderLifecycleStore;
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
      this.strategyExecutionCoordinator = new StrategyExecutionCoordinator({
        executor: async () => {
          if (!this.strategyCallback) {
            return;
          }

          const { marketData, missingSymbols } =
            await this.buildLiveMarketDataSnapshot();

          if (missingSymbols.length > 0) {
            logger.warn(
              "Skipping live strategy tick due to missing market data",
              {
                missingSymbols,
              },
            );
            return;
          }

          if (Object.keys(marketData).length > 0) {
            await this.strategyCallback(marketData);
            this.lastStrategyExecution = Date.now();
          }
        },
        intervalMs: this.strategyExecutionInterval,
      });

      await this.strategyExecutionCoordinator.start();

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

    if (this.strategyExecutionCoordinator) {
      await this.strategyExecutionCoordinator.stop();
      this.strategyExecutionCoordinator = undefined;
    }

    // Disconnect from live market data
    await this.disableLiveMarketData();

    logger.info("✅ Live trading stopped");
  }

  /**
   * Construct live market data for strategy execution
   */
  private async constructLiveMarketData(): Promise<MarketData> {
    const { marketData } = await this.buildLiveMarketDataSnapshot();
    return marketData;
  }

  private async buildLiveMarketDataSnapshot(): Promise<LiveMarketDataSnapshot> {
    const marketData: MarketData = {};
    const missingSymbols: string[] = [];

    try {
      for (const pairSymbol of this.tradingPairs) {
        const pair = this.parseSymbolToPair(pairSymbol);
        if (!pair) {
          missingSymbols.push(pairSymbol);
          continue;
        }

        try {
          const candle = this.candles.get(pairSymbol);
          const orderbook = this.orderbooks.get(pairSymbol);
          const candleHistory = await this.fetchCandleHistory(pairSymbol, pair);
          const tick = this.marketDataService.buildLiveTick({
            symbol: pairSymbol,
            ohlcv: candle,
            orderbook,
            candleHistory,
          });

          if (tick) {
            marketData[pairSymbol] = tick;
          } else {
            missingSymbols.push(pairSymbol);
          }
        } catch (error) {
          missingSymbols.push(pairSymbol);
          logger.warn(`Failed to get market data for ${pairSymbol}:`, error);
        }
      }
    } catch (error) {
      logger.warn("Failed to construct live market data:", error);
    }

    return {
      marketData,
      missingSymbols,
    };
  }

  private async fetchCandleHistory(
    symbol: string,
    pair: TradingPair,
  ): Promise<Candlestick[]> {
    try {
      const sdk = this.monacoSDK.getSDK();
      const resolver = this.monacoSDK.getTradingPairResolver();
      const normalized = resolver.normalizeSymbol(symbol);
      const pairByContracts = resolver.getPairByContracts(
        pair.base,
        pair.quote,
      );
      const tradingPairId =
        pairByContracts?.id ?? resolver.resolveSymbolToId(normalized);
      const candles = await sdk.market.getCandlesticks(
        tradingPairId,
        this.ohlcvInterval,
        { endTime: Date.now(), limit: 50 },
      );

      return Array.isArray(candles) ? candles : [];
    } catch (error) {
      logger.warn("Failed to fetch candle history for indicators", {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
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
    state?: string;
    lastError?: string | null;
  } {
    const stats = this.strategyExecutionCoordinator?.getStats();
    return {
      isRunning: this.isRunning,
      hasStrategy: !!this.strategyCallback,
      executionInterval: this.strategyExecutionInterval,
      lastExecution: this.lastStrategyExecution,
      timeSinceLastExecution: Date.now() - this.lastStrategyExecution,
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
        "No strategy execution coordinator available. Start live trading first.",
      );
    }

    await this.strategyExecutionCoordinator.executeNow();
  }

  /**
   * Get all executed trades for analysis
   */
  getExecutedTrades(): ExecutionTrade[] {
    return [...this.executedTrades];
  }

  /**
   * Get order history
   */
  getOrderHistory(): Map<string, ExecutionOrderRecord> {
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

  private resolveLivePairMetadata(pair: TradingPair): LivePairMetadata {
    const resolver = this.monacoSDK.getTradingPairResolver();
    const normalizedSymbol = resolver.normalizeSymbol(pair.symbol);
    const pairMetadata =
      resolver.getPairByContracts(pair.base, pair.quote) ??
      resolver.getPairBySymbol(normalizedSymbol) ??
      resolver.getPairBySymbol(pair.symbol);

    if (!pairMetadata) {
      throw new PriceUnavailableError(pair.symbol, {
        reason: "pair_metadata_unavailable",
      });
    }

    return {
      symbol: resolver.normalizeSymbol(pairMetadata.symbol ?? pair.symbol),
      tradingPairId: pairMetadata.id,
      baseDecimals: pairMetadata.base_decimals,
      quoteDecimals: pairMetadata.quote_decimals,
    };
  }

  private parseTokenUnits(
    value: string | number | bigint,
    decimals: number,
    label: string,
  ): bigint {
    const normalized =
      typeof value === "string" ? value.trim() : String(value).trim();
    if (normalized.length === 0) {
      throw new Error(`Invalid ${label}: empty value`);
    }

    try {
      return parseUnits(normalized, decimals);
    } catch (error) {
      throw new Error(
        `Invalid ${label}: ${normalized} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  private toNormalizedOrderbookLevels(
    levels: Array<{
      price: string | number | bigint;
      quantity: string | number | bigint;
    }>,
    pairMetadata: LivePairMetadata,
    side: "bid" | "ask",
  ): NormalizedOrderbookLevel[] {
    return levels.map((level) => ({
      priceInQuoteBaseUnits: this.parseTokenUnits(
        level.price,
        pairMetadata.quoteDecimals,
        `orderbook ${side} price`,
      ),
      quantityInBaseUnits: this.parseTokenUnits(
        level.quantity,
        pairMetadata.baseDecimals,
        `orderbook ${side} quantity`,
      ),
    }));
  }

  private calculateQuoteNotional(
    quantityInBaseUnits: bigint,
    priceInQuoteBaseUnits: bigint,
    baseDecimals: number,
  ): bigint {
    const baseUnitScale = 10n ** BigInt(baseDecimals);
    return (quantityInBaseUnits * priceInQuoteBaseUnits) / baseUnitScale;
  }

  private toTokenBaseUnits(value: bigint, decimals: number): bigint {
    return (value * 10n ** BigInt(decimals)) / 100n;
  }

  private fromTokenBaseUnits(value: bigint, decimals: number): bigint {
    return (value * 100n) / 10n ** BigInt(decimals);
  }

  private toSdkSpotOrder(
    order: OrderRequest,
    pairMetadata: LivePairMetadata,
  ): OrderRequest {
    return {
      ...order,
      price: this.toTokenBaseUnits(order.price, pairMetadata.quoteDecimals),
      quantity: this.toTokenBaseUnits(
        order.quantity,
        pairMetadata.baseDecimals,
      ),
    };
  }

  private fromSdkSpotOrderResult(
    result: OrderResult,
    pairMetadata: LivePairMetadata,
  ): OrderResult {
    return {
      ...result,
      filledQuantity: this.fromTokenBaseUnits(
        result.filledQuantity,
        pairMetadata.baseDecimals,
      ),
      remainingQuantity: this.fromTokenBaseUnits(
        result.remainingQuantity,
        pairMetadata.baseDecimals,
      ),
    };
  }
}

export type { LiveTradingConfig };
