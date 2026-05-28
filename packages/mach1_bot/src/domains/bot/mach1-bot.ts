import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Interval, TradingPairResolver } from "mach1_sdk";
import { OrderEventEmitter, OrderLifecycleStore } from "@/domains/execution";
import type { BacktestEngine } from "@/domains/execution/backtest-engine";
import type { PaperTradingEngine } from "@/domains/execution/paper-trading-engine";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import type { RiskEvent as StrategyRiskEvent } from "@/domains/strategies/core/i-strategy";
import { EXAMPLE_STRATEGIES } from "@/domains/strategies/examples/example-strategies";
import type { StrategyPerformanceReport } from "@/domains/strategies/management/strategy-manager";
// Enhanced strategy system imports (optional dependencies)
import {
  type StrategyInstance,
  StrategyManager,
} from "@/domains/strategies/management/strategy-manager";
import {
  type StrategyExample,
  strategyRegistry,
} from "@/domains/strategies/management/strategy-registry";
import {
  type OptimizationConfig,
  type OptimizationSpace,
  StrategyOptimizer,
} from "@/domains/strategies/optimization/strategy-optimizer";
import { MarketDataService } from "@/domains/trading/market-data-service";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import { RiskBreach, RiskManager } from "@/domains/trading/risk-manager";
import { TradingPairService } from "@/domains/trading/trading-pair-service";
import { EnvironmentConfig, MACH1_PIT_PASS, NETWORK_PRESETS } from "@/shared";
import { InvalidConfigError, MissingConfigError } from "@/shared/errors";
import { CompletedTrade } from "@/shared/types/analytics";
import type { BacktestResults, BotConfig, BotOrder } from "@/shared/types/bot";
import {
  BacktestOptions,
  OrderBook as BotOrderBook,
  Portfolio as BotPortfolio,
  RiskLimits as BotRiskLimits,
  Trade as BotTrade,
  LiveOptions,
  MarketData,
  RebalanceResult,
  SimulationOptions,
  StopLossOptions,
  TakeProfitOptions,
  TradeOptions,
  TrailingStopOptions,
} from "@/shared/types/bot";
import type {
  Address,
  ChainNetwork,
  Portfolio as CorePortfolio,
  OrderRequest,
  TradingPair,
} from "@/shared/types/common";
import type { ExecutionEngine } from "@/shared/types/execution";
import { LiveTradingConfig } from "@/shared/types/execution";
import type {
  OrderBookEvent,
  TradeEvent,
} from "@/shared/types/internal-events";
import { RiskLimits as TradingRiskLimits } from "@/shared/types/trading";
import { createSeededRng } from "@/shared/utils/determinism";
import { isRecord } from "@/shared/utils/record-utils";
import { ConfigBuilder } from "@/shared/utils/validation/config-builder";

const isBotTrade = (value: unknown): value is BotTrade =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.symbol === "string" &&
  typeof value.price === "number" &&
  typeof value.size === "number" &&
  (value.side === "buy" || value.side === "sell") &&
  typeof value.timestamp === "number";

const isBotOrderBook = (value: unknown): value is BotOrderBook =>
  isRecord(value) &&
  typeof value.symbol === "string" &&
  Array.isArray(value.bids) &&
  Array.isArray(value.asks) &&
  typeof value.spread === "number";

const isRiskBreach = (value: unknown): value is RiskBreach =>
  isRecord(value) &&
  typeof value.type === "string" &&
  typeof value.message === "string" &&
  typeof value.timestamp === "number" &&
  typeof value.currentValue === "number" &&
  typeof value.limitValue === "number";

const isCompletedTrade = (value: unknown): value is CompletedTrade =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.symbol === "string";

const optimizationObjectives = new Set<OptimizationConfig["objective"]>([
  "sharpe_ratio",
  "total_return",
  "profit_factor",
  "calmar_ratio",
  "sortino_ratio",
  "custom",
]);

const optimizationMethods = new Set<OptimizationConfig["method"]>([
  "grid_search",
  "random_search",
  "genetic_algorithm",
  "bayesian_optimization",
]);

const isOptimizationObjective = (
  value: unknown,
): value is OptimizationConfig["objective"] =>
  typeof value === "string" &&
  optimizationObjectives.has(value as OptimizationConfig["objective"]);

const isOptimizationMethod = (
  value: unknown,
): value is OptimizationConfig["method"] =>
  typeof value === "string" &&
  optimizationMethods.has(value as OptimizationConfig["method"]);

const isVerboseLogLevel = (
  logLevel: BotConfig["logLevel"] | undefined,
): boolean =>
  typeof logLevel === "string" && logLevel.toUpperCase() === "DEBUG";

const NETWORK_PRESET_ALIASES: Record<string, keyof typeof NETWORK_PRESETS> = {
  mainnet: "sei-mainnet",
  testnet: "sei-testnet",
};
const SIMULATION_ETH_USDC_PAIR: TradingPair = {
  base: "0x1111111111111111111111111111111111111111" as Address,
  quote: "0x4444444444444444444444444444444444444444" as Address,
  symbol: "ETH/USDC",
};
const SIMULATION_BTC_USDC_PAIR: TradingPair = {
  base: "0x2222222222222222222222222222222222222222" as Address,
  quote: "0x4444444444444444444444444444444444444444" as Address,
  symbol: "BTC/USDC",
};
const SIMULATION_SOL_USDC_PAIR: TradingPair = {
  base: "0x3333333333333333333333333333333333333333" as Address,
  quote: "0x4444444444444444444444444444444444444444" as Address,
  symbol: "SOL/USDC",
};
const SIMULATION_CASH_TOKEN =
  "0x4444444444444444444444444444444444444444" as Address;
const SIMULATION_STARTING_BALANCE = 1_000_000_000n;

type StrategySummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  riskLevel: number;
  minCapital: number;
  supportedPairs: string[];
  tags: string[];
  examples: StrategyExample[];
};

type StrategyInstanceSummary = Pick<
  StrategyInstance,
  | "id"
  | "strategyId"
  | "status"
  | "parameters"
  | "metrics"
  | "createdAt"
  | "lastExecuted"
  | "executionCount"
  | "errors"
>;

type BacktestEquityPoint = { timestamp: number; equity: number };
type BacktestDrawdownPoint = { timestamp: number; drawdown: number };

type ActiveLiveExecutionEngine = ExecutionEngine & {
  initialize(): Promise<void>;
  getRealtimeManager(): RealtimeManager;
  getTradingPairResolver(): TradingPairResolver;
  getOHLCVInterval?(): Interval;
  getLivePrice?(pair: TradingPair): Promise<bigint>;
  stopLiveTrading?(): Promise<void>;
};

type PerpsRiskAwareLiveEngine = ActiveLiveExecutionEngine & {
  getAccountState():
    | {
        equity: bigint;
        freeCollateral: bigint;
        maintenanceMargin: bigint;
        updatedAt: number;
      }
    | undefined;
  getFundingState?: (pair: TradingPair) =>
    | {
        status: "available" | "unsupported" | "missing" | "stale";
        rate?: bigint;
        accruedFunding?: bigint;
        updatedAt?: number;
        warning?: string;
      }
    | undefined;
};

const isPerpsRiskAwareLiveEngine = (
  engine: ActiveLiveExecutionEngine | undefined,
): engine is PerpsRiskAwareLiveEngine =>
  !!engine &&
  typeof (engine as PerpsRiskAwareLiveEngine).getAccountState === "function";

export class Mach1Bot {
  private strategyCallback?: (data: MarketData) => Promise<void>;
  private eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  private activeIntervals: Set<NodeJS.Timeout> = new Set();
  private strategyExecutionCoordinator?: StrategyExecutionCoordinator;
  private config: BotConfig;

  // Core managers
  private marketManager: MarketManager;
  private orderManager: OrderManager;
  private positionTracker: PositionTracker;
  private realtimeManager: RealtimeManager;
  private riskManager: RiskManager;
  private liveEngine?: ActiveLiveExecutionEngine;
  private paperEngine?: PaperTradingEngine;
  private tradingPairResolver?: TradingPairResolver;
  private readonly tradingPairService: TradingPairService;
  private readonly marketDataService: MarketDataService;
  private readonly orderEventEmitter: OrderEventEmitter;
  private readonly orderLifecycleStore: OrderLifecycleStore;

  // Enhanced strategy system (optional)
  public strategyManager?: StrategyManager;
  public strategyOptimizer?: StrategyOptimizer;
  private enhancedFeaturesEnabled = false;
  private strategyLabel?: string;
  private preferredTradingPairs: string[] = [];
  private takeProfitPercent?: number;
  private activeTakeProfitTriggers = new Set<string>();
  private liquidationRiskPaused = false;

  // Backtest mode support
  private backtestEngine?: BacktestEngine; // BacktestEngine instance during backtesting
  private isBacktesting = false;

  constructor(
    config: BotConfig & {
      enableEnhancedFeatures?: boolean;
    } = {} as BotConfig & { enableEnhancedFeatures?: boolean },
  ) {
    // Validate required configuration
    this.validateConfig(config);
    this.config = config;
    this.takeProfitPercent = config.takeProfitPercent;

    // Initialize core managers
    this.marketManager = new MarketManager({
      mode: config.mode === "live" ? "live" : "simulation",
    });
    if (config.mode !== "live") {
      this.marketManager.seedSimulationPair(SIMULATION_ETH_USDC_PAIR, 300_000n);
      this.marketManager.seedSimulationPair(SIMULATION_BTC_USDC_PAIR, 45_000n);
      this.marketManager.seedSimulationPair(SIMULATION_SOL_USDC_PAIR, 1_500n);
    }
    this.orderManager = new OrderManager(this.marketManager);
    this.positionTracker = new PositionTracker(
      this.marketManager,
      this.orderManager,
      config.mode === "live"
        ? undefined
        : {
            mode: "simulation",
            startingBalances: {
              [SIMULATION_CASH_TOKEN]: SIMULATION_STARTING_BALANCE,
            },
          },
    );
    this.orderEventEmitter = new OrderEventEmitter();
    this.orderLifecycleStore = new OrderLifecycleStore(this.orderEventEmitter);
    this.positionTracker.attachOrderEventEmitter(this.orderEventEmitter);
    this.realtimeManager = new RealtimeManager(
      this.marketManager,
      this.orderManager,
      undefined,
      {
        mode: config.mode === "live" ? "live" : "simulation",
        orderEventEmitter: this.orderEventEmitter,
      },
    );
    this.riskManager = new RiskManager(
      this.positionTracker,
      this.marketManager,
      this.orderManager,
    );
    this.riskManager.setPerpsContextProvider(async (order) => {
      if (
        this.config.mode !== "live" ||
        this.config.marketMode !== "isolated_perps"
      ) {
        return undefined;
      }

      const pair = {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: `${order.baseToken}/${order.quoteToken}`,
      };

      if (!isPerpsRiskAwareLiveEngine(this.liveEngine)) {
        return {
          marketMode: "isolated_perps" as const,
          maxConfiguredLeverage: this.config.perps?.leverage,
          liquidationThresholdPercent:
            this.config.perps?.liquidationThresholdPercent,
          accountState: undefined,
          funding: {
            status: "missing" as const,
            warning:
              "Funding data unavailable for isolated perps order; rejecting fail-closed",
          },
        };
      }

      const liveEngine = this.liveEngine;

      return {
        marketMode: "isolated_perps" as const,
        maxConfiguredLeverage: this.config.perps?.leverage,
        liquidationThresholdPercent:
          this.config.perps?.liquidationThresholdPercent,
        accountState: liveEngine.getAccountState(),
        getPosition: async (requestedPair: TradingPair) =>
          liveEngine.getPosition(requestedPair),
        funding: liveEngine.getFundingState?.(pair),
      };
    });
    this.riskManager.on("riskEvent", (event: StrategyRiskEvent) => {
      if (this.isCriticalLiquidationRiskEvent(event)) {
        void this.activateLiquidationRiskPause();
      }
    });
    this.tradingPairService = new TradingPairService(
      () => this.tradingPairResolver,
    );
    this.marketDataService = new MarketDataService({
      rng: createSeededRng(1337),
    });

    // Initialize enhanced features if requested or if strategy-related methods are called
    if (config.enableEnhancedFeatures !== false) {
      // Note: Enhanced features initialization is async, but we'll handle it later
      // to avoid making the constructor async. We'll expose an ensureInitialized method.
    }
  }

  /**
   * Initialize enhanced strategy features
   * This is called automatically unless explicitly disabled
   */
  private async initializeEnhancedFeatures(): Promise<void> {
    if (this.enhancedFeaturesEnabled) {
      return; // Already initialized
    }

    try {
      // Initialize strategy system components
      this.strategyManager = new StrategyManager(
        strategyRegistry,
        this.marketManager,
        this.orderManager,
        this.positionTracker,
        this.realtimeManager,
        this.riskManager,
        this.config.aiHelper,
        () => this.tradingPairResolver,
      );
      this.strategyManager.attachOrderEventEmitter(this.orderEventEmitter);

      this.strategyOptimizer = new StrategyOptimizer(
        this.strategyManager,
        // BacktestEngine would be passed here in a real implementation
        this.backtestEngine ?? (undefined as unknown as BacktestEngine),
      );

      this.enhancedFeaturesEnabled = true;

      // Register example strategies and wait for completion
      await this.registerExampleStrategies();
    } catch (error) {
      console.warn(
        "⚠️ Enhanced features not available - strategy extensions may not be installed:",
        error,
      );
      this.enhancedFeaturesEnabled = false;
    }
  }

  /**
   * Register all example and builtin strategies
   */
  private async registerExampleStrategies(): Promise<void> {
    if (!this.strategyManager) return;

    try {
      // Register builtin strategies first
      await this.registerBuiltinStrategies();

      // Then register example strategies
      for (const strategy of Object.values(EXAMPLE_STRATEGIES)) {
        await strategyRegistry.registerStrategy(
          strategy.config,
          strategy.factory,
          strategy.metadata,
        );
      }
    } catch (error) {
      console.warn("⚠️ Failed to register some example strategies:", error);
    }
  }

  /**
   * Register built-in strategies (DCA, Grid, Portfolio)
   */
  private async registerBuiltinStrategies(): Promise<void> {
    try {
      // Use dynamic import to avoid bundling issues with ncc
      const builtinModule = await import(
        "@/domains/strategies/builtin/index.js"
      );
      const BUILTIN_STRATEGIES = builtinModule.BUILTIN_STRATEGIES;

      for (const strategyDef of BUILTIN_STRATEGIES) {
        await strategyRegistry.registerStrategy(
          strategyDef.config,
          strategyDef.factory,
          strategyDef.metadata,
        );
      }
    } catch (error) {
      console.warn("⚠️ Failed to register built-in strategies:", error);
      // Built-in strategies are essential, so we should still continue
    }
  }

  /**
   * Ensure that enhanced features and strategies are fully initialized
   * This should be called before using strategy-related functionality
   */
  async ensureInitialized(): Promise<void> {
    if (
      this.config.enableEnhancedFeatures !== false &&
      !this.enhancedFeaturesEnabled
    ) {
      await this.initializeEnhancedFeatures();
    }
  }

  /**
   * Convenience method to create bot from environment variables
   * @deprecated Use constructor with explicit config instead
   */
  static fromEnv(): Mach1Bot {
    const env = process.env as EnvironmentConfig;

    // Validate required environment variables
    if (!env.MACH1_PRIVATE_KEY) {
      throw new MissingConfigError(
        "MACH1_PRIVATE_KEY environment variable is required",
      );
    }
    if (!env.MACH1_RPC_URL) {
      throw new MissingConfigError(
        "MACH1_RPC_URL environment variable is required",
      );
    }

    const config: BotConfig = {
      privateKey: env.MACH1_PRIVATE_KEY,
      rpcUrl: env.MACH1_RPC_URL,
      mode:
        env.MACH1_MODE === "paper"
          ? ("simulation" as BotConfig["mode"]) // normalize 'paper' to 'simulation'
          : (env.MACH1_MODE as BotConfig["mode"]) ||
            ("simulation" as BotConfig["mode"]),
      chainId: env.MACH1_CHAIN_ID ? parseInt(env.MACH1_CHAIN_ID) : undefined,
      logLevel: env.MACH1_LOG_LEVEL || "info",
    };

    return new Mach1Bot(config);
  }

  /**
   * Create bot using network preset for convenience
   */
  static forNetwork(
    networkName: keyof typeof NETWORK_PRESETS,
    privateKey: string,
    options?: Partial<BotConfig>,
  ): Mach1Bot {
    const presetKey =
      NETWORK_PRESETS[networkName] !== undefined
        ? networkName
        : NETWORK_PRESET_ALIASES[String(networkName)];
    const preset = presetKey ? NETWORK_PRESETS[presetKey] : undefined;
    if (!preset) {
      throw new InvalidConfigError(
        "network",
        networkName,
        "Unknown network preset",
      );
    }

    const config: BotConfig = {
      privateKey,
      rpcUrl: preset.rpcUrl,
      chainId: preset.chainId,
      ...options,
    };

    return new Mach1Bot(config);
  }

  /**
   * Create bot using configuration builder
   */
  static builder(): ConfigBuilder {
    return ConfigBuilder.create();
  }

  private validateConfig(config: BotConfig): void {
    const errors: string[] = [];

    if (!config.privateKey) {
      errors.push("privateKey is required");
    }
    if (!config.rpcUrl) {
      errors.push("rpcUrl is required");
    }

    if (errors.length > 0) {
      throw new InvalidConfigError("configuration", config, errors.join(", "));
    }
  }

  async buy(symbol: string, options: TradeOptions): Promise<BotOrder> {
    if (this.config.mode === "live" && !this.liveEngine) {
      await this.getOrCreateLiveEngine();
    }

    const pair = this.parseSymbol(symbol);
    const currentPrice = await this.getPriceForMode(pair);
    const orderType = options.orderType || "market";

    const quantity = this.calculateOrderQuantity(currentPrice, options);

    const orderRequest: OrderRequest = {
      baseToken: pair.base,
      quoteToken: pair.quote,
      isBuy: true,
      orderType,
      price: currentPrice,
      quantity,
    };

    const result = await this.placeBotOrder(orderRequest);
    const botOrder = this.toBotOrder(
      result,
      symbol,
      "buy",
      orderType,
      currentPrice,
      quantity,
    );

    if (this.takeProfitPercent !== undefined) {
      this.scheduleDefaultTakeProfit(symbol, currentPrice);
    }

    return botOrder;
  }

  async sell(symbol: string, options: TradeOptions): Promise<BotOrder> {
    if (this.config.mode === "live" && !this.liveEngine) {
      await this.getOrCreateLiveEngine();
    }

    const pair = this.parseSymbol(symbol);
    const currentPrice = await this.getPriceForMode(pair);
    const orderType = options.orderType || "market";

    const quantity = this.calculateOrderQuantity(currentPrice, options);

    const orderRequest: OrderRequest = {
      baseToken: pair.base,
      quoteToken: pair.quote,
      isBuy: false,
      orderType,
      price: currentPrice,
      quantity,
    };

    const result = await this.placeBotOrder(orderRequest);
    return this.toBotOrder(
      result,
      symbol,
      "sell",
      orderType,
      currentPrice,
      quantity,
    );
  }

  private async placeBotOrder(orderRequest: OrderRequest) {
    if (this.liquidationRiskPaused) {
      throw new Error(
        "Live trading paused due to critical liquidation risk. Explicit operator action required before resuming.",
      );
    }

    const executionEngine = await this.getActiveExecutionEngine();

    if (!this.isBacktesting || !this.backtestEngine) {
      const riskCheck = await this.riskManager.validateOrder(orderRequest);
      if (!riskCheck.approved) {
        throw new Error(
          `Order rejected: ${riskCheck.rejectionReasons.join(", ")}`,
        );
      }
    }

    const result = await executionEngine.placeOrder(orderRequest);
    return await this.awaitOrderSettlement(executionEngine, result);
  }

  private async awaitOrderSettlement(
    executionEngine: Awaited<ReturnType<Mach1Bot["getActiveExecutionEngine"]>>,
    result: {
      orderId: string;
      status: string;
      filledQuantity?: bigint;
      remainingQuantity?: bigint;
    },
  ) {
    if (this.config.mode === "live" || result.status !== "pending") {
      return result;
    }

    if (typeof executionEngine.getOrderStatus !== "function") {
      return result;
    }

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const status = await executionEngine.getOrderStatus(result.orderId);
      if (status.status !== "pending") {
        return status.status === "rejected" ? result : status;
      }
    }

    return result;
  }

  private toBotOrder(
    result: { orderId: string; status: string },
    symbol: string,
    side: "buy" | "sell",
    orderType: string,
    currentPrice: bigint,
    quantity: bigint,
  ): BotOrder {
    return {
      id: result.orderId,
      symbol,
      side,
      type: orderType,
      price: Number(currentPrice) / 100,
      size: Number(quantity),
      status: result.status,
    };
  }

  private calculateOrderQuantity(
    currentPrice: bigint,
    options: TradeOptions,
  ): bigint {
    if (options.amountUsd !== undefined) {
      const rawQuantity = Math.floor(
        ((options.amountUsd * 100) / Number(currentPrice)) * 100,
      );

      // Preserve tiny notional orders in simulation instead of rounding to zero.
      return BigInt(options.amountUsd > 0 ? Math.max(rawQuantity, 1) : 0);
    }

    return BigInt(options.amount || 0);
  }

  private parseSymbol(symbol: string): TradingPair {
    if (this.config.mode === "live") {
      if (!this.tradingPairResolver) {
        throw new Error(
          "Trading pair resolver not ready for live trading. Initialize the live engine first.",
        );
      }
    }
    return this.tradingPairService.resolveSymbol(symbol);
  }

  /**
   * Resolve the current price based on the active mode.
   * Live mode pulls best bid/ask from the Monaco orderbook via WebSocket;
   * simulation/backtest fall back to the mock MarketManager.
   */
  private async getPriceForMode(pair: TradingPair): Promise<bigint> {
    if (this.config.mode === "live") {
      try {
        if (!this.liveEngine) {
          await this.getOrCreateLiveEngine();
        }
        if (!this.liveEngine) {
          throw new Error("Live trading engine unavailable");
        }
        if (typeof this.liveEngine.getLivePrice !== "function") {
          throw new Error(
            "Active live engine does not expose live price lookup",
          );
        }
        return await this.liveEngine.getLivePrice(pair);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Live price lookup failed for ${pair.symbol}: ${message}`,
        );
      }
    }

    if (this.isBacktesting && this.backtestEngine) {
      return this.backtestEngine.getCurrentPrice(pair);
    }

    return await this.marketManager.getCurrentPrice(pair);
  }

  async stopLoss(symbol: string, options: StopLossOptions): Promise<BotOrder> {
    const pair = this.parseSymbol(symbol);
    const stopPrice = BigInt(Math.floor(options.stopPrice * 100));
    const limitPrice = options.limitPrice
      ? BigInt(Math.floor(options.limitPrice * 100))
      : undefined;

    return this.waitForPriceTrigger(
      symbol,
      pair,
      (current) => current <= stopPrice,
      async () => {
        const position = await this.positionTracker.getPosition(pair);
        if (position.balance <= 0n) {
          throw new Error(`No position to protect for ${symbol}`);
        }

        return this.sell(symbol, {
          amount: Number(position.balance),
          orderType: limitPrice ? "limit" : "market",
          ...(limitPrice
            ? {
                amountUsd: Number((position.balance * limitPrice) / 100n) / 100,
              }
            : {}),
        });
      },
    );
  }

  async takeProfit(
    symbol: string,
    options: TakeProfitOptions,
  ): Promise<BotOrder> {
    return this.startTakeProfitTrigger(symbol, options);
  }

  private async startTakeProfitTrigger(
    symbol: string,
    options: TakeProfitOptions,
  ): Promise<BotOrder> {
    const pair = this.parseSymbol(symbol);
    const targetPrice = BigInt(Math.floor(options.targetPrice * 100));
    const triggerKey = this.tradingPairService.normalizeSymbol(symbol);

    this.activeTakeProfitTriggers.add(triggerKey);

    try {
      return await this.waitForPriceTrigger(
        symbol,
        pair,
        (current) => current >= targetPrice,
        async () => {
          const position = await this.positionTracker.getPosition(pair);
          if (position.balance <= 0n) {
            throw new Error(`No position to take profit on for ${symbol}`);
          }

          const amountToSell =
            options.amountPercent && options.amountPercent > 0
              ? (position.balance *
                  BigInt(Math.floor(options.amountPercent * 100))) /
                BigInt(10000)
              : position.balance;

          return this.sell(symbol, {
            amount: Number(amountToSell),
            orderType: "market",
          });
        },
      );
    } finally {
      this.activeTakeProfitTriggers.delete(triggerKey);
    }
  }

  async trailingStop(
    symbol: string,
    options: TrailingStopOptions,
  ): Promise<BotOrder> {
    const pair = this.parseSymbol(symbol);
    const trailDistance = BigInt(Math.floor(options.trailDistance * 100));
    let peakPrice: bigint | null = null;

    return this.waitForPriceTrigger(
      symbol,
      pair,
      (current) => {
        if (options.side === "sell") {
          peakPrice =
            peakPrice === null
              ? current
              : current > peakPrice
                ? current
                : peakPrice;
          return peakPrice !== null && current <= peakPrice - trailDistance;
        } else {
          peakPrice =
            peakPrice === null
              ? current
              : current < peakPrice
                ? current
                : peakPrice;
          return peakPrice !== null && current >= peakPrice + trailDistance;
        }
      },
      async () => {
        const position = await this.positionTracker.getPosition(pair);
        const sideIsSell = options.side === "sell";
        const quantity =
          position.balance > 0n && sideIsSell
            ? position.balance
            : BigInt(Math.floor(options.trailDistance));

        const orderOptions: TradeOptions = {
          amount: Number(quantity),
          orderType: "market",
        };

        return sideIsSell
          ? this.sell(symbol, orderOptions)
          : this.buy(symbol, { ...orderOptions, amountUsd: undefined });
      },
    );
  }

  strategy(
    callback: (data: MarketData) => Promise<void>,
    label?: string,
  ): void {
    this.strategyCallback = callback;
    if (label) {
      this.strategyLabel = label;
    }
  }

  /**
   * Set the trading pairs the bot should focus on (from config/strategy).
   */
  setPreferredTradingPairs(pairs: string[]): void {
    const cleaned = Array.from(
      new Set(
        (pairs || [])
          .filter(Boolean)
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
    );
    this.preferredTradingPairs = cleaned;
  }

  private async getAllLiveSymbols(): Promise<string[]> {
    const resolver = this.tradingPairResolver;
    const pairs = await this.marketManager.getAllTradingPairs();

    return pairs.map((pair) => {
      const symbol = pair.symbol.includes("-")
        ? pair.symbol.replace("-", "/")
        : pair.symbol;
      return resolver ? resolver.normalizeSymbol(symbol) : symbol;
    });
  }

  /**
   * Wait for a price condition to trigger an order, polling live prices.
   */
  private async waitForPriceTrigger(
    symbol: string,
    pair: TradingPair,
    condition: (currentPrice: bigint) => boolean,
    onTrigger: () => Promise<BotOrder>,
  ): Promise<BotOrder> {
    const pollIntervalMs = 30_000;

    const checkAndMaybeExecute = async (): Promise<BotOrder | null> => {
      const current = await this.getPriceForMode(pair);
      if (condition(current)) {
        return onTrigger();
      }
      return null;
    };

    // Immediate check
    const immediate = await checkAndMaybeExecute();
    if (immediate) {
      return immediate;
    }

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const result = await checkAndMaybeExecute();
          if (result) {
            clearInterval(interval);
            this.activeIntervals.delete(interval);
            resolve(result);
          }
        } catch (error) {
          clearInterval(interval);
          this.activeIntervals.delete(interval);
          reject(error);
        }
      }, pollIntervalMs);

      this.activeIntervals.add(interval);
    });
  }

  private scheduleDefaultTakeProfit(symbol: string, entryPrice: bigint): void {
    if (this.takeProfitPercent === undefined || this.takeProfitPercent <= 0) {
      return;
    }

    const triggerKey = this.tradingPairService.normalizeSymbol(symbol);
    if (this.activeTakeProfitTriggers.has(triggerKey)) {
      return;
    }

    const targetPrice =
      (Number(entryPrice) / 100) * (1 + this.takeProfitPercent / 100);
    void this.startTakeProfitTrigger(symbol, {
      targetPrice,
      amountPercent: 100,
    }).catch(() => {
      // Background trigger failures should not fail already-filled entry orders.
    });
  }

  async backtest(options: BacktestOptions): Promise<BacktestResults> {
    // Import BacktestEngine
    const { BacktestEngine } = await import(
      "@/domains/execution/backtest-engine.js"
    );

    // Parse dates
    const startDate = new Date(options.start);
    const endDate = new Date(options.end);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new Error("Invalid date format. Use YYYY-MM-DD format.");
    }

    if (startDate >= endDate) {
      throw new Error("Start date must be before end date.");
    }

    // Create backtest configuration
    const backtestConfig = {
      startDate,
      endDate,
      initialCapital: BigInt((options.initialCapital || 10000) * 100), // Convert to cents
      commission: 0.001, // 0.1% commission
      slippage: 0.0005, // 0.05% slippage
    };

    // Initialize BacktestEngine
    const backtestEngine = new BacktestEngine(backtestConfig, {
      orderLifecycleStore: this.orderLifecycleStore,
    });

    // Set backtest mode
    this.isBacktesting = true;
    this.backtestEngine = backtestEngine;

    try {
      // Set up strategy execution if a strategy callback is defined
      if (this.strategyCallback) {
        // Create a wrapper to pass the bot instance to the strategy
        const strategyWrapper = async (data: MarketData) => {
          try {
            // Bind 'this' context to provide access to bot methods
            await this.strategyCallback?.call(this, data);
          } catch (error) {
            console.warn("⚠️  Strategy execution error:", error);
          }
        };

        // Pass the strategy callback to the backtest engine
        backtestEngine.setStrategyCallback(
          strategyWrapper,
          options.strategyExecutionIntervalMs ?? 300_000,
        );
      } else {
        console.log(
          "⚠️  No strategy defined - running backtest without strategy execution",
        );
      }

      // Generate comprehensive report (this runs the actual backtest)
      console.log(
        `📊 Running backtest from ${options.start} to ${options.end}...`,
      );
      const report = await backtestEngine.generateReport();

      // The actual backtest results are in the report.summary
      const backtestResult = report.summary;
      const equityCurveData = this.buildBacktestEquityCurveData(
        options,
        report.dailyReturns ?? [],
        options.initialCapital || 10000,
      );
      const drawdownData = this.buildBacktestDrawdownData(
        equityCurveData,
        report.drawdownCurve ?? [],
      );

      console.log(`🔍 Mach1Bot received backtest result after completion:`, {
        totalTrades: backtestResult.totalTrades,
        totalReturn: (backtestResult.totalReturn * 100).toFixed(2) + "%",
        winRate: (backtestResult.winRate * 100).toFixed(2) + "%",
        trades: backtestResult.trades.length,
      });

      // Convert results to expected format
      const results: BacktestResults = {
        totalReturn: backtestResult.totalReturn,
        annualReturn: this.calculateAnnualizedReturn(
          backtestResult.totalReturn,
          startDate,
          endDate,
        ),
        sharpeRatio: backtestResult.sharpeRatio,
        maxDrawdown: backtestResult.maxDrawdown,
        winRate: backtestResult.winRate,
        totalTrades: backtestResult.totalTrades,
        plotEquityCurve: async () => {
          await this.writeBacktestDataFile(
            "equity-curve.json",
            equityCurveData,
          );
        },
        plotDrawdown: async () => {
          await this.writeBacktestDataFile("drawdown-curve.json", drawdownData);
        },
        exportTrades: async (filename: string) => {
          const header = [
            "timestamp",
            "symbol",
            "side",
            "price",
            "quantity",
            "pnl",
          ];
          const rows = backtestResult.trades.map((trade) =>
            [
              trade.timestamp.toString(),
              trade.pair.symbol,
              trade.side,
              (Number(trade.price) / 100).toFixed(2),
              Number(trade.quantity).toString(),
              (Number(trade.pnl) / 100).toFixed(2),
            ].join(","),
          );
          await this.writeBacktestDataFile(filename, [
            header.join(","),
            ...rows,
          ]);
        },
        getEquityCurveData: () => equityCurveData,
        getDrawdownData: () => drawdownData,
      };

      console.log(`🎯 Mach1Bot final results:`, {
        totalTrades: results.totalTrades,
        totalReturn: (results.totalReturn * 100).toFixed(2) + "%",
        winRate: (results.winRate * 100).toFixed(2) + "%",
      });

      console.log("✅ Backtest completed successfully");
      return results;
    } finally {
      // Reset backtest mode
      this.isBacktesting = false;
      this.backtestEngine = undefined;
    }
  }

  private calculateAnnualizedReturn(
    totalReturn: number,
    startDate: Date,
    endDate: Date,
  ): number {
    const daysInPeriod =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const yearsInPeriod = daysInPeriod / 365.25;

    if (yearsInPeriod <= 0) return 0;

    return Math.pow(1 + totalReturn, 1 / yearsInPeriod) - 1;
  }

  private buildBacktestEquityCurveData(
    options: BacktestOptions,
    dailyReturns: number[],
    initialCapital: number,
  ): BacktestEquityPoint[] {
    const startDate = new Date(options.start);
    const dayMs = 24 * 60 * 60 * 1000;
    let equity = initialCapital;

    return dailyReturns.map((dailyReturn, index) => {
      equity *= 1 + dailyReturn;
      return {
        timestamp: startDate.getTime() + dayMs * (index + 1),
        equity,
      };
    });
  }

  private buildBacktestDrawdownData(
    equityCurveData: BacktestEquityPoint[],
    drawdownCurve: number[],
  ): BacktestDrawdownPoint[] {
    return drawdownCurve.map((drawdown, index) => ({
      timestamp:
        equityCurveData[index]?.timestamp ??
        equityCurveData[equityCurveData.length - 1]?.timestamp ??
        Date.now(),
      drawdown,
    }));
  }

  private async writeBacktestDataFile(
    filename: string,
    payload: string[] | object,
  ): Promise<void> {
    const outputPath = resolve(filename);
    await mkdir(dirname(outputPath), { recursive: true });
    const data = Array.isArray(payload)
      ? payload.join("\n") + "\n"
      : JSON.stringify(payload, null, 2);
    await writeFile(outputPath, data, "utf8");
  }

  private findTradingPairForToken(token: Address): TradingPair | null {
    for (const symbol of this.tradingPairService.getAllSymbols()) {
      const pair = this.parseSymbol(symbol);
      if (pair.base.toLowerCase() === token.toLowerCase()) {
        return pair;
      }
    }

    return null;
  }

  private calculateCoreAllocationBySymbol(
    portfolio: CorePortfolio,
    symbols?: string[],
  ): Record<string, number> {
    const allocations = new Map<string, number>();
    const totalValueUsd = Number(portfolio.totalValue) / 100;
    const requestedSymbols = symbols
      ? symbols.map((symbol) => this.tradingPairService.normalizeSymbol(symbol))
      : undefined;

    if (totalValueUsd <= 0) {
      return Object.fromEntries(
        (requestedSymbols ?? []).map((symbol) => [symbol, 0]),
      );
    }

    for (const position of portfolio.positions.values()) {
      const pair = this.findTradingPairForToken(position.token);
      if (!pair) {
        continue;
      }

      const normalizedSymbol = this.tradingPairService.normalizeSymbol(
        pair.symbol,
      );
      allocations.set(
        normalizedSymbol,
        Number(position.value) / 100 / totalValueUsd,
      );
    }

    for (const symbol of requestedSymbols ?? []) {
      if (!allocations.has(symbol)) {
        allocations.set(symbol, 0);
      }
    }

    return Object.fromEntries(
      Array.from(allocations.entries()).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }

  private labelRisk(score: number): "LOW" | "MODERATE" | "HIGH" {
    if (score >= 0.6) {
      return "HIGH";
    }
    if (score >= 0.25) {
      return "MODERATE";
    }
    return "LOW";
  }

  async simulate(options: SimulationOptions): Promise<void> {
    // Import PaperTradingEngine
    const { PaperTradingEngine } = await import(
      "@/domains/execution/paper-trading-engine.js"
    );

    console.log(`🎮 Starting simulation mode for ${options.duration}...`);

    // Parse duration (e.g., "24h", "1W", "30d")
    const durationMs = this.parseDuration(options.duration);
    const endTime = Date.now() + durationMs;

    // Create paper trading configuration
    const paperConfig = {
      initialCapital: BigInt((options.initialCapital || 10000) * 100), // Convert to cents
      commission: 0.001, // 0.1% commission
      slippage: 0.0005, // 0.05% slippage
      latencyMs: 100, // 100ms latency simulation
    };

    // Initialize PaperTradingEngine
    const paperEngine = new PaperTradingEngine(
      paperConfig,
      this.marketManager,
      this.realtimeManager,
      { orderLifecycleStore: this.orderLifecycleStore },
    );
    this.paperEngine = paperEngine;

    console.log("✅ Paper trading simulation started");
    console.log(`💰 Initial capital: $${options.initialCapital || 10000}`);
    console.log(`⏱️  Duration: ${options.duration}`);

    if (this.strategyCallback) {
      console.log("🔄 Executing strategy in simulation mode...");
      const strategyExecutionIntervalMs = 60_000;

      // Set up strategy execution loop
      const executeStrategy = async () => {
        while (Date.now() < endTime) {
          try {
            // Create mock market data for strategy
            const marketData = await this.generateMockMarketData();

            // Execute strategy callback
            await this.strategyCallback?.(marketData);

            if (Date.now() >= endTime) {
              break;
            }

            // Wait before next execution.
            await new Promise((resolve) =>
              setTimeout(resolve, strategyExecutionIntervalMs),
            );
          } catch (error) {
            console.error("❌ Strategy execution error:", error);
          }
        }

        console.log("✅ Simulation completed");
      };

      // Keep simulation alive until strategy loop completes.
      await executeStrategy();
    } else {
      console.log(
        "⚠️ No strategy defined. Use bot.strategy() to set a trading strategy.",
      );
    }
  }

  /**
   * Lazily create and initialize the live trading engine so live mode routes
   * orders through Monaco instead of the simulated OrderManager.
   */
  private async getOrCreateLiveEngine(options?: LiveOptions) {
    if (this.liveEngine) {
      return this.liveEngine;
    }

    const [{ IsolatedPerpsLiveTradingEngine }, { LiveTradingEngine }] =
      await Promise.all([
        import("@/domains/execution/isolated-perps-live-trading-engine.js"),
        import("@/domains/execution/live-trading-engine.js"),
      ]);

    const network: ChainNetwork = this.config.rpcUrl.includes("testnet")
      ? "sei-testnet"
      : "sei-mainnet";
    const tradingPairs = await this.getTargetSymbolsForLiveData();

    const liveConfig: LiveTradingConfig = {
      pitPassCode: MACH1_PIT_PASS,
      network,
      environment: this.config.environment ?? "staging",
      marketMode: this.config.marketMode,
      perps: this.config.perps,
      rpcUrl: this.config.rpcUrl,
      privateKey: this.config.privateKey,
      maxSlippage: 0.01,
      confirmations: options?.confirmations || 1,
      tradingPairs: tradingPairs.length > 0 ? tradingPairs : undefined,
    };

    const liveEngine: ActiveLiveExecutionEngine =
      this.config.marketMode === "isolated_perps"
        ? new IsolatedPerpsLiveTradingEngine(
            liveConfig,
            this.marketManager,
            this.realtimeManager,
            this.orderLifecycleStore,
          )
        : new LiveTradingEngine(
            liveConfig,
            this.marketManager,
            this.realtimeManager,
            undefined,
            this.orderLifecycleStore,
          );
    await liveEngine.initialize();
    // Replace the realtime manager with the live, SDK-backed instance
    this.realtimeManager = liveEngine.getRealtimeManager();
    this.tradingPairResolver = liveEngine.getTradingPairResolver();
    this.liveEngine = liveEngine;

    // Route strategy-driven orders through live engine when available
    if (this.strategyManager) {
      this.strategyManager.setOrderExecutor(async (orderRequest) => {
        return liveEngine.placeOrder(orderRequest);
      });
    }

    return liveEngine;
  }

  private async getOrCreatePaperEngine(): Promise<PaperTradingEngine> {
    if (this.paperEngine) {
      return this.paperEngine;
    }

    const { PaperTradingEngine } = await import(
      "@/domains/execution/paper-trading-engine.js"
    );

    this.paperEngine = new PaperTradingEngine(
      {
        initialCapital: 10000n * 100n,
        commission: 0.001,
        slippage: 0.0005,
        latencyMs: 100,
      },
      this.marketManager,
      this.realtimeManager,
      { orderLifecycleStore: this.orderLifecycleStore },
    );

    return this.paperEngine;
  }

  private async getActiveExecutionEngine(): Promise<ExecutionEngine> {
    if (this.config.mode === "live") {
      return this.getOrCreateLiveEngine();
    }

    if (this.isBacktesting && this.backtestEngine) {
      return this.backtestEngine;
    }

    return this.getOrCreatePaperEngine();
  }

  private isCriticalLiquidationRiskEvent(event: StrategyRiskEvent): boolean {
    return (
      this.config.mode === "live" &&
      this.config.marketMode === "isolated_perps" &&
      event.severity === "critical" &&
      event.type === "liquidation_triggered"
    );
  }

  private async activateLiquidationRiskPause(): Promise<void> {
    if (this.liquidationRiskPaused) {
      return;
    }

    this.liquidationRiskPaused = true;
    await this.strategyExecutionCoordinator?.stop();
    this.strategyExecutionCoordinator = undefined;
    await this.liveEngine?.stopLiveTrading?.();
    this.config.onTradingPaused?.();
  }

  async goLive(options?: LiveOptions): Promise<void> {
    await this.ensureInitialized();

    if (this.liquidationRiskPaused) {
      throw new Error(
        "Live trading paused due to critical liquidation risk. Explicit operator action required before resuming.",
      );
    }

    if (
      this.strategyExecutionCoordinator &&
      this.strategyExecutionCoordinator.getStats().state !== "stopped" &&
      this.strategyExecutionCoordinator.getStats().state !== "idle"
    ) {
      console.log("⚠️ Strategy execution is already running");
      return;
    }

    // Initialize LiveTradingEngine and keep it for order routing
    const _liveEngine = await this.getOrCreateLiveEngine(options);

    if (isVerboseLogLevel(this.config.logLevel)) {
      console.log("✅ Live trading engine initialized");
      console.log(`🌐 Connected to: ${this.config.rpcUrl}`);
      console.log(`📊 Max slippage: 1.00%`);
    }

    if (this.strategyCallback) {
      const strategyLabel = this.getActiveStrategyLabel();
      if (isVerboseLogLevel(this.config.logLevel)) {
        console.log(
          `🔄 Executing strategy in LIVE mode${strategyLabel ? `: ${strategyLabel}` : ""}...`,
        );
      }

      // Set up real-time strategy execution
      const executeStrategy = async () => {
        try {
          // Get real market data
          const marketData = await this.getRealMarketData();

          // Execute strategy callback
          await this.strategyCallback?.(marketData);
        } catch (error) {
          console.error("❌ Live strategy execution error:", error);
        }
      };

      const strategyIntervalMs = options?.strategyExecutionIntervalMs ?? 60_000;

      this.strategyExecutionCoordinator = new StrategyExecutionCoordinator({
        executor: executeStrategy,
        intervalMs: strategyIntervalMs,
      });

      await this.strategyExecutionCoordinator.start();
    } else {
      console.log(
        "⚠️ No strategy defined. Use bot.strategy() to set a trading strategy.",
      );
    }

    console.log(
      "🛑 Live trading is active. Press Ctrl+C or call bot.emergencyStop() to stop.",
    );
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([hHdDwWmM])$/);
    if (!match) {
      throw new Error(
        "Invalid duration format. Use format like '24h', '7d', '1W'",
      );
    }

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "h":
        return value * 60 * 60 * 1000; // hours
      case "d":
        return value * 24 * 60 * 60 * 1000; // days
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000; // weeks
      case "m":
        return value * 30 * 24 * 60 * 60 * 1000; // months (approximate)
      default:
        throw new Error("Unsupported duration unit. Use h, d, w, or m");
    }
  }

  private async generateMockMarketData(): Promise<MarketData> {
    return this.marketDataService.buildSimulationMarketData(
      this.getTargetSymbolsForSimulationData(),
    );
  }

  private getTargetSymbolsForSimulationData(): string[] {
    if (this.preferredTradingPairs.length > 0) {
      return this.preferredTradingPairs.map((symbol) =>
        this.tradingPairService.normalizeSymbol(symbol),
      );
    }

    return this.tradingPairService.getAllSymbols();
  }

  private async getRealMarketData(): Promise<MarketData> {
    try {
      if (this.config.mode === "live") {
        if (!this.liveEngine) {
          await this.getOrCreateLiveEngine();
        }

        const rtManager =
          this.liveEngine?.getRealtimeManager() || this.realtimeManager;
        const ohlcvInterval = this.liveEngine?.getOHLCVInterval?.() || "1m";
        const resolver = this.tradingPairResolver;
        const targetSymbols = await this.getTargetSymbolsForLiveData();

        if (targetSymbols.length === 0) {
          console.warn("⚠️ No trading pairs configured for live data.");
          return {};
        }

        const marketData: MarketData = {};

        for (const symbol of targetSymbols) {
          const monacoSymbol = (() => {
            if (!resolver) return symbol;
            const normalized = resolver.normalizeSymbol(symbol);
            const pair =
              resolver.getPairBySymbol(normalized) ||
              resolver.getPairBySymbol(normalized.toUpperCase());
            return pair ? resolver.normalizeSymbol(pair.symbol) : normalized;
          })();

          const [ohlcv, orderbook] = await Promise.all([
            rtManager.getOHLCVSnapshot(monacoSymbol, ohlcvInterval),
            rtManager.getOrderbookSnapshot(monacoSymbol),
          ]);

          try {
            const pair = this.parseSymbol(monacoSymbol);
            const end = new Date();
            const start = new Date(end.getTime() - 60 * 60 * 1000);
            const candles = await this.marketManager.getCandles(
              pair,
              ohlcvInterval,
              start,
              end,
            );
            const tick = this.marketDataService.buildLiveTick({
              symbol: monacoSymbol,
              ohlcv,
              orderbook,
              candleHistory: candles,
            });

            if (tick) {
              marketData[monacoSymbol] = tick;
            }
          } catch {
            const tick = this.marketDataService.buildLiveTick({
              symbol: monacoSymbol,
              ohlcv,
              orderbook,
            });
            if (tick) {
              marketData[monacoSymbol] = tick;
            }
          }
        }

        if (Object.keys(marketData).length > 0) {
          return marketData;
        }

        console.warn(
          "⚠️ No live market data available for requested symbols. Skipping strategy tick.",
        );
        return {};
      }

      // Simulation or backtest mode - use mock data
      return await this.generateMockMarketData();
    } catch (error) {
      console.warn("⚠️ Failed to fetch real market data:", error);
      return this.config.mode === "live"
        ? {}
        : await this.generateMockMarketData();
    }
  }

  /**
   * Determine which symbols to fetch for live data, preferring configured pairs.
   */
  private async getTargetSymbolsForLiveData(): Promise<string[]> {
    const resolver = this.tradingPairResolver;

    if (this.preferredTradingPairs.length > 0) {
      const normalizedPreferredPairs = this.preferredTradingPairs.map(
        (symbol) => (resolver ? resolver.normalizeSymbol(symbol) : symbol),
      );

      if (
        normalizedPreferredPairs.some(
          (symbol) => symbol === "*" || symbol.toLowerCase() === "all",
        )
      ) {
        return this.getAllLiveSymbols();
      }

      return normalizedPreferredPairs;
    }

    return this.getAllLiveSymbols();
  }

  /**
   * Friendly label for the active strategy (if using enhanced features/manager).
   */
  private getActiveStrategyLabel(): string | null {
    if (!this.strategyManager) {
      return null;
    }

    const running = this.strategyManager.getInstancesByStatus("running");
    if (running.length === 0) {
      return this.strategyLabel || null;
    }

    // If multiple, show first and count
    if (running.length === 1) {
      return running[0].strategyId;
    }
    return `${running[0].strategyId} (+${running.length - 1} more)`;
  }

  async getPortfolio(): Promise<BotPortfolio> {
    const corePortfolio = await this.positionTracker.getPortfolio();
    const summary = await this.positionTracker.getPositionSummary();
    const performanceMetrics =
      await this.positionTracker.getPerformanceMetrics();

    const positions: BotPortfolio["positions"] = {};
    for (const [token, position] of corePortfolio.positions.entries()) {
      positions[token] = {
        symbol: token,
        balance: Number(position.balance),
        value: Number(position.value) / 100,
        unrealizedPnl: Number(position.unrealizedPnL) / 100,
      };
    }

    const totalValueNumber = Number(corePortfolio.totalValue) / 100;
    const dailyPnlNumber = Number(summary.dailyPnL) / 100;
    const dailyReturn =
      totalValueNumber === 0 ? 0 : dailyPnlNumber / totalValueNumber;

    return {
      totalValue: totalValueNumber,
      dailyPnl: dailyPnlNumber,
      dailyReturn,
      sharpeRatio: performanceMetrics.sharpeRatio,
      positions,
    };
  }

  async rebalance(targets: Record<string, number>): Promise<RebalanceResult> {
    const normalizedTargets = new Map<string, number>();
    for (const [symbol, weight] of Object.entries(targets)) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`Invalid target weight for ${symbol}`);
      }
      normalizedTargets.set(
        this.tradingPairService.normalizeSymbol(symbol),
        weight,
      );
    }

    const corePortfolio = await this.positionTracker.getPortfolio();
    const totalValueUsd = Number(corePortfolio.totalValue) / 100;
    if (totalValueUsd <= 0) {
      return { executed: false, trades: [], newAllocation: {} };
    }

    const currentValues = new Map<string, number>();
    for (const position of corePortfolio.positions.values()) {
      const pair = this.findTradingPairForToken(position.token);
      if (!pair) {
        continue;
      }
      currentValues.set(pair.symbol, Number(position.value) / 100);
      if (!normalizedTargets.has(pair.symbol)) {
        normalizedTargets.set(pair.symbol, 0);
      }
    }

    const trades: RebalanceResult["trades"] = [];
    for (const [symbol, targetWeight] of normalizedTargets.entries()) {
      const currentValueUsd = currentValues.get(symbol) ?? 0;
      const targetValueUsd = totalValueUsd * targetWeight;
      const deltaUsd = targetValueUsd - currentValueUsd;

      if (Math.abs(deltaUsd) < 0.01) {
        continue;
      }

      if (deltaUsd > 0) {
        const order = await this.buy(symbol, { amountUsd: deltaUsd });
        trades.push({
          symbol,
          side: "buy",
          amount: order.size,
        });
      } else {
        const order = await this.sell(symbol, {
          amountUsd: Math.abs(deltaUsd),
        });
        trades.push({
          symbol,
          side: "sell",
          amount: order.size,
        });
      }
    }

    const newAllocation = Object.fromEntries(
      Array.from(normalizedTargets.entries()).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );

    return {
      executed: trades.length > 0,
      trades,
      newAllocation,
    };
  }

  async setRiskLimits(limits: BotRiskLimits): Promise<void> {
    const riskLimits: Partial<TradingRiskLimits> = {};

    if (limits.maxPositionSize !== undefined) {
      riskLimits.maxPositionSize =
        typeof limits.maxPositionSize === "bigint"
          ? limits.maxPositionSize
          : BigInt(Math.floor(Number(limits.maxPositionSize) * 100));
    }

    if (limits.maxDailyLoss !== undefined) {
      riskLimits.maxDailyLoss =
        typeof limits.maxDailyLoss === "bigint"
          ? limits.maxDailyLoss
          : BigInt(Math.floor(Number(limits.maxDailyLoss) * 100));
    }

    if (limits.maxOrderValue !== undefined) {
      riskLimits.maxOrderValue =
        typeof limits.maxOrderValue === "bigint"
          ? limits.maxOrderValue
          : BigInt(Math.floor(Number(limits.maxOrderValue) * 100));
    }

    if (limits.positionLimitPercent !== undefined) {
      riskLimits.positionLimitPercent = limits.positionLimitPercent;
    }

    if (limits.stopLossPercent !== undefined) {
      riskLimits.stopLossPercent = limits.stopLossPercent;
    }

    if (limits.maxLeverage !== undefined) {
      riskLimits.maxLeverage = limits.maxLeverage;
    }

    if (limits.maxCorrelation !== undefined) {
      riskLimits.maxCorrelation = limits.maxCorrelation;
    }

    if (limits.maxDrawdown !== undefined) {
      riskLimits.maxDrawdown = limits.maxDrawdown;
    }

    if (Object.keys(riskLimits).length === 0) {
      return;
    }

    await this.riskManager.setRiskLimits(riskLimits);
  }

  async setStopLossPercent(percent: number): Promise<void> {
    await this.riskManager.setRiskLimits({ stopLossPercent: percent });
  }

  async setTakeProfitPercent(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent <= 0) {
      throw new Error("Take-profit percent must be greater than 0");
    }

    this.takeProfitPercent = percent;
    this.config.takeProfitPercent = percent;
  }

  async getRiskHeatmap(): Promise<{
    display(): string;
  }> {
    const portfolio = await this.positionTracker.getPortfolio();
    const performance = await this.getPerformanceStats();
    const entries = Object.entries(
      this.calculateCoreAllocationBySymbol(portfolio),
    ).sort(([left], [right]) => left.localeCompare(right));

    const totalExposure = entries.reduce((sum, [, weight]) => sum + weight, 0);
    const largestWeight = entries.reduce(
      (max, [, weight]) => Math.max(max, weight),
      0,
    );
    const concentrationRisk = entries.reduce(
      (sum, [, weight]) => sum + weight * weight,
      0,
    );
    const correlationRisk =
      entries.length === 0
        ? 0
        : entries.length === 1
          ? 1
          : Math.min(1, 0.5 + concentrationRisk / 2);

    const lines =
      entries.length === 0
        ? [
            "Risk Heatmap",
            "Exposure: 0.00%",
            "Drawdown: 0.00%",
            "Concentration: 0.00%",
            "Correlation: 0.00%",
            "Overall: LOW",
          ]
        : [
            "Risk Heatmap",
            ...entries.map(
              ([symbol, weight]) =>
                `${symbol} exposure ${(weight * 100).toFixed(2)}% ${this.labelRisk(weight)}`,
            ),
            `Exposure ${(totalExposure * 100).toFixed(2)}%`,
            `Drawdown ${(performance.maxDrawdown * 100).toFixed(2)}% ${this.labelRisk(performance.maxDrawdown)}`,
            `Concentration ${(concentrationRisk * 100).toFixed(2)}% ${this.labelRisk(concentrationRisk)}`,
            `Correlation ${(correlationRisk * 100).toFixed(2)}% ${this.labelRisk(correlationRisk)}`,
            `Overall: ${this.labelRisk(
              Math.max(
                largestWeight,
                concentrationRisk,
                correlationRisk,
                performance.maxDrawdown,
              ),
            )}`,
          ];

    return {
      display: () => lines.join("\n"),
    };
  }

  async getCandles(
    symbol: string,
    timeframe: string,
    options?: { days?: number },
  ): Promise<
    Array<{
      timestamp: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>
  > {
    const pair = this.parseSymbol(symbol);
    const days = options?.days || 30;
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    const candles = await this.marketManager.getCandles(
      pair,
      timeframe,
      start,
      end,
    );
    return candles;
  }

  async getTrades(
    symbol: string,
    options?: { limit?: number },
  ): Promise<BotTrade[]> {
    const pair = this.parseSymbol(symbol);
    const trades = await this.marketManager.getRecentTrades(
      pair,
      options?.limit,
    );

    return trades.map((trade) => ({
      id: `${trade.timestamp}`,
      symbol,
      price: Number(trade.price) / 100,
      size: Number(trade.quantity),
      side: trade.side,
      timestamp: trade.timestamp,
    }));
  }

  async getOrderbook(symbol: string): Promise<BotOrderBook> {
    const pair = this.parseSymbol(symbol);
    const orderbook = await this.marketManager.getOrderBook(pair);

    return {
      symbol,
      bids: orderbook.bids.map((bid) => ({
        price: Number(bid.price) / 100,
        quantity: Number(bid.quantity),
      })),
      asks: orderbook.asks.map((ask) => ({
        price: Number(ask.price) / 100,
        quantity: Number(ask.quantity),
      })),
      spread:
        orderbook.asks.length > 0 && orderbook.bids.length > 0
          ? Number(orderbook.asks[0].price - orderbook.bids[0].price) / 100
          : 0,
    };
  }

  async getPerformanceStats(): Promise<{
    sharpeRatio: number;
    maxDrawdown: number;
  }> {
    const performanceMetrics =
      await this.positionTracker.getPerformanceMetrics();
    return {
      sharpeRatio: performanceMetrics.sharpeRatio,
      maxDrawdown: 0.08, // TODO: Calculate actual max drawdown
    };
  }

  // Event handlers
  async onTrade(
    symbol: string,
    handler: (trade: BotTrade) => void,
  ): Promise<void> {
    const pair = this.parseSymbol(symbol);
    const tradeStream = await this.realtimeManager.subscribeTrades(pair);

    tradeStream.subscribe((event: TradeEvent) => {
      const trade: BotTrade = {
        id: event.trade.id,
        symbol,
        price: Number(event.trade.price) / 100,
        size: Number(event.trade.quantity),
        side: event.trade.isBuy ? "buy" : "sell",
        timestamp: event.trade.timestamp,
      };
      handler(trade);
    });

    const key = `trade:${symbol}`;
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, []);
    }
    const tradeHandlers = this.eventHandlers.get(key);
    if (tradeHandlers) {
      tradeHandlers.push((payload) => {
        if (isBotTrade(payload)) {
          handler(payload);
        }
      });
    }
  }

  async onOrderbook(
    symbol: string,
    handler: (book: BotOrderBook) => void,
  ): Promise<void> {
    const pair = this.parseSymbol(symbol);
    const orderBookStream = await this.realtimeManager.subscribeOrderBook(pair);

    orderBookStream.subscribe((event: OrderBookEvent) => {
      const book: BotOrderBook = {
        symbol,
        bids: event.orderBook.bids.map((bid) => ({
          price: Number(bid.price) / 100,
          quantity: Number(bid.quantity),
        })),
        asks: event.orderBook.asks.map((ask) => ({
          price: Number(ask.price) / 100,
          quantity: Number(ask.quantity),
        })),
        spread:
          event.orderBook.asks.length > 0 && event.orderBook.bids.length > 0
            ? Number(
                event.orderBook.asks[0].price - event.orderBook.bids[0].price,
              ) / 100
            : 0,
      };
      handler(book);
    });

    const key = `orderbook:${symbol}`;
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, []);
    }
    const orderbookHandlers = this.eventHandlers.get(key);
    if (orderbookHandlers) {
      orderbookHandlers.push((payload) => {
        if (isBotOrderBook(payload)) {
          handler(payload);
        }
      });
    }
  }

  async onRiskBreach(handler: (breach: RiskBreach) => void): Promise<void> {
    // Use faster polling in test environment
    const pollInterval = process.env.NODE_ENV === "test" ? 100 : 5000;

    const intervalId = setInterval(async () => {
      const breaches = await this.riskManager.getRiskBreaches(1);
      if (breaches.length > 0) {
        const latestBreach = breaches[0];
        const breach: RiskBreach = {
          type: latestBreach.type,
          message: latestBreach.message,
          timestamp: latestBreach.timestamp,
          severity: latestBreach.severity,
          currentValue: latestBreach.currentValue,
          limitValue: latestBreach.limitValue,
        };
        handler(breach);
      }
    }, pollInterval);

    // Track the interval for cleanup
    this.activeIntervals.add(intervalId);

    const key = "risk_breach";
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, []);
    }
    const riskHandlers = this.eventHandlers.get(key);
    if (riskHandlers) {
      riskHandlers.push((payload) => {
        if (isRiskBreach(payload)) {
          handler(payload);
        }
      });
    }
  }

  onTradeComplete(handler: (trade: CompletedTrade) => void): void {
    const key = "trade_complete";
    if (!this.eventHandlers.has(key)) {
      this.eventHandlers.set(key, []);
    }
    const tradeCompleteHandlers = this.eventHandlers.get(key);
    if (tradeCompleteHandlers) {
      tradeCompleteHandlers.push((payload) => {
        if (isCompletedTrade(payload)) {
          handler(payload);
        }
      });
    }
  }

  // For testing purposes - reset daily loss tracking
  resetDailyLosses(): void {
    this.riskManager.resetDailyLosses();
  }

  // ========================================
  // ENHANCED STRATEGY FEATURES
  // ========================================

  /**
   * Ensure enhanced features are available for strategy operations
   */
  private ensureEnhancedFeatures(): void {
    if (!this.enhancedFeaturesEnabled) {
      this.initializeEnhancedFeatures();
    }
    if (!this.strategyManager) {
      throw new Error(
        "Enhanced strategy features are not available. Please ensure strategy extensions are installed.",
      );
    }
  }

  private requireStrategyManager(): StrategyManager {
    this.ensureEnhancedFeatures();
    if (!this.strategyManager) {
      throw new Error("Strategy manager is not initialized");
    }
    return this.strategyManager;
  }

  private requireStrategyOptimizer(): StrategyOptimizer {
    this.ensureEnhancedFeatures();
    if (!this.strategyOptimizer) {
      throw new Error("Strategy optimizer is not initialized");
    }
    return this.strategyOptimizer;
  }

  /**
   * Create and start a custom strategy
   */
  async startStrategy(
    strategyId: string,
    instanceId: string,
    parameters: Record<string, unknown> = {},
    options: {
      executeInterval?: number;
      enableRiskChecks?: boolean;
      enablePerformanceTracking?: boolean;
    } = {},
  ): Promise<string> {
    this.ensureEnhancedFeatures();

    try {
      const instance =
        await this.requireStrategyManager().createAndStartStrategy(
          strategyId,
          instanceId,
          parameters,
          {
            executeInterval: options.executeInterval || 30000,
            enableRiskChecks: options.enableRiskChecks !== false,
            enablePerformanceTracking:
              options.enablePerformanceTracking !== false,
          },
        );

      this.strategyLabel = strategyId;
      return instance.id;
    } catch (error) {
      throw new Error(
        `Failed to start strategy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Stop a running strategy
   */
  async stopStrategy(instanceId: string): Promise<void> {
    this.ensureEnhancedFeatures();
    await this.requireStrategyManager().stopStrategy(instanceId);
  }

  /**
   * Pause a running strategy
   */
  async pauseStrategy(instanceId: string): Promise<void> {
    this.ensureEnhancedFeatures();
    await this.requireStrategyManager().pauseStrategy(instanceId);
  }

  /**
   * Resume a paused strategy
   */
  async resumeStrategy(instanceId: string): Promise<void> {
    this.ensureEnhancedFeatures();
    await this.requireStrategyManager().resumeStrategy(instanceId);
  }

  /**
   * Update strategy parameters
   */
  async updateStrategyParameters(
    instanceId: string,
    parameters: Record<string, unknown>,
  ): Promise<void> {
    this.ensureEnhancedFeatures();
    await this.requireStrategyManager().updateStrategyParameters(
      instanceId,
      parameters,
    );
  }

  /**
   * Get strategy performance report
   */
  async getStrategyPerformance(
    instanceId: string,
  ): Promise<StrategyPerformanceReport> {
    this.ensureEnhancedFeatures();
    return await this.requireStrategyManager().getPerformanceReport(instanceId);
  }

  /**
   * List all available strategies
   */
  getAvailableStrategies(filter?: {
    category?: string[];
    riskLevel?: { min?: number; max?: number };
    author?: string;
    tags?: string[];
  }): StrategySummary[] {
    this.ensureEnhancedFeatures();
    const result = strategyRegistry.searchStrategies(filter || {});
    return result.strategies.map((s) => ({
      id: s.config.id,
      name: s.config.name,
      description: s.config.description,
      version: s.config.version,
      author: s.config.author,
      category: s.config.category,
      riskLevel: s.config.riskLevel,
      minCapital: s.config.minCapital,
      supportedPairs: s.config.supportedPairs,
      tags: s.metadata.tags,
      examples: s.metadata.examples ?? [],
    }));
  }

  /**
   * Get all running strategy instances
   */
  getRunningStrategies(): StrategyInstanceSummary[] {
    this.ensureEnhancedFeatures();
    return this.requireStrategyManager()
      .getAllInstances()
      .map((instance) => ({
        id: instance.id,
        strategyId: instance.strategyId,
        status: instance.status,
        parameters: instance.parameters,
        metrics: instance.metrics,
        createdAt: instance.createdAt,
        lastExecuted: instance.lastExecuted,
        executionCount: instance.executionCount,
        errors: instance.errors,
      }));
  }

  /**
   * Optimize strategy parameters
   */
  async optimizeStrategy(
    strategyId: string,
    parameterSpace: OptimizationSpace,
    options: {
      objective?: string;
      method?: string;
      maxIterations?: number;
      backtestPeriod?: { start: string | Date; end: string | Date };
    } = {},
  ): Promise<unknown> {
    this.ensureEnhancedFeatures();
    const objective = isOptimizationObjective(options.objective)
      ? options.objective
      : "sharpe_ratio";
    const method = isOptimizationMethod(options.method)
      ? options.method
      : "grid_search";
    return await this.requireStrategyOptimizer().optimizeParameters(
      strategyId,
      parameterSpace,
      {
        objective,
        method,
        maxIterations: options.maxIterations || 100,
        backtestPeriod: options.backtestPeriod || {
          start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
          end: new Date(),
        },
      },
    );
  }

  /**
   * Run walk-forward analysis
   */
  async walkForwardAnalysis(
    strategyId: string,
    parameterSpace: OptimizationSpace,
    options: {
      totalPeriodDays?: number;
      inSampleDays?: number;
      outSampleDays?: number;
      reoptimizeFrequencyDays?: number;
    } = {},
  ): Promise<unknown> {
    this.ensureEnhancedFeatures();
    const endDate = new Date();
    const startDate = new Date(
      endDate.getTime() -
        (options.totalPeriodDays || 365) * 24 * 60 * 60 * 1000,
    );

    return await this.requireStrategyOptimizer().walkForwardAnalysis(
      strategyId,
      parameterSpace,
      {
        totalPeriod: { start: startDate, end: endDate },
        inSampleLength: options.inSampleDays || 90,
        outSampleLength: options.outSampleDays || 30,
        reoptimizeFrequency: options.reoptimizeFrequencyDays || 30,
        optimizationConfig: {
          objective: "sharpe_ratio",
          method: "grid_search",
          maxIterations: 50,
        },
      },
    );
  }

  /**
   * Enhanced strategy method that works with the pluggable system
   */
  customStrategy(
    strategyId: string,
    parameters: Record<string, unknown> = {},
    options: {
      instanceId?: string;
      autoStart?: boolean;
    } = {},
  ): {
    start: () => Promise<string>;
    stop: () => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    getPerformance: () => Promise<unknown>;
    updateParameters: (params: Record<string, unknown>) => Promise<void>;
  } {
    this.ensureEnhancedFeatures();
    const instanceId = options.instanceId || `${strategyId}_${Date.now()}`;

    return {
      start: async () => {
        return await this.startStrategy(strategyId, instanceId, parameters);
      },

      stop: async () => {
        await this.stopStrategy(instanceId);
      },

      pause: async () => {
        await this.pauseStrategy(instanceId);
      },

      resume: async () => {
        await this.resumeStrategy(instanceId);
      },

      getPerformance: async () => {
        return await this.getStrategyPerformance(instanceId);
      },

      updateParameters: async (params: Record<string, unknown>) => {
        await this.updateStrategyParameters(instanceId, params);
      },
    };
  }

  /**
   * Strategy marketplace - discover and run community strategies
   */
  strategyMarketplace() {
    this.ensureEnhancedFeatures();
    return {
      search: (
        query: {
          category?: string[];
          riskLevel?: { min?: number; max?: number };
          tags?: string[];
          author?: string;
        } = {},
      ) => {
        return this.getAvailableStrategies(query);
      },

      getByCategory: (category: string) => {
        return strategyRegistry.getStrategiesByCategory(category).map((s) => ({
          id: s.config.id,
          name: s.config.name,
          description: s.config.description,
          author: s.config.author,
          riskLevel: s.config.riskLevel,
          tags: s.metadata.tags,
        }));
      },

      getByAuthor: (author: string) => {
        return strategyRegistry.getStrategiesByAuthor(author).map((s) => ({
          id: s.config.id,
          name: s.config.name,
          description: s.config.description,
          category: s.config.category,
          riskLevel: s.config.riskLevel,
        }));
      },

      getExamples: (strategyId: string) => {
        const strategy = strategyRegistry.getStrategy(strategyId);
        return strategy?.metadata.examples || [];
      },

      getStats: () => {
        return strategyRegistry.getRegistryStats();
      },
    };
  }

  /**
   * Strategy performance analytics
   */
  strategyAnalytics() {
    this.ensureEnhancedFeatures();
    return {
      getPortfolioStrategies: () => {
        return this.getRunningStrategies();
      },

      compareStrategies: async (instanceIds: string[]) => {
        const performances = await Promise.all(
          instanceIds.map((id) => this.getStrategyPerformance(id)),
        );

        return {
          strategies: performances.map((perf, index) => ({
            instanceId: instanceIds[index],
            performance: perf.performance,
          })),
          comparison: {
            bestSharpe: performances.reduce(
              (best, current, index) =>
                current.performance.sharpeRatio > best.sharpeRatio
                  ? { ...current.performance, instanceId: instanceIds[index] }
                  : best,
              { sharpeRatio: -Infinity, instanceId: "" },
            ),

            bestReturn: performances.reduce(
              (best, current, index) =>
                current.performance.totalReturn > best.totalReturn
                  ? { ...current.performance, instanceId: instanceIds[index] }
                  : best,
              { totalReturn: -Infinity, instanceId: "" },
            ),

            lowestDrawdown: performances.reduce(
              (best, current, index) =>
                current.performance.maxDrawdown < best.maxDrawdown
                  ? { ...current.performance, instanceId: instanceIds[index] }
                  : best,
              { maxDrawdown: Infinity, instanceId: "" },
            ),
          },
        };
      },

      getRiskMetrics: async (instanceId: string) => {
        const report = await this.getStrategyPerformance(instanceId);
        return report.riskMetrics;
      },

      generateReport: async (instanceId: string) => {
        const performance = await this.getStrategyPerformance(instanceId);
        const instance = this.requireStrategyManager().getInstance(instanceId);

        return {
          summary: {
            strategyName: instance?.strategyId,
            instanceId,
            status: instance?.status,
            runningTime: instance?.createdAt
              ? Date.now() - instance.createdAt
              : 0,
            totalExecutions: instance?.executionCount || 0,
          },
          performance: performance.performance,
          trades: performance.trades,
          riskMetrics: performance.riskMetrics,
          errors: instance?.errors || [],
        };
      },
    };
  }

  async emergencyStop(): Promise<void> {
    // Cancel ongoing backtest if running
    if (this.isBacktesting && this.backtestEngine) {
      console.log("🛑 Stopping backtest operation...");
      this.backtestEngine.cancel();
    }

    // Stop all running strategies first (if enhanced features are enabled)
    if (this.enhancedFeaturesEnabled && this.strategyManager) {
      const runningStrategies = this.getRunningStrategies();
      for (const strategy of runningStrategies) {
        try {
          await this.stopStrategy(strategy.id);
        } catch (error) {
          console.warn(`Failed to stop strategy ${strategy.id}:`, error);
        }
      }
    }

    // Stop the strategy execution coordinator if running
    if (this.strategyExecutionCoordinator) {
      await this.strategyExecutionCoordinator.stop();
      this.strategyExecutionCoordinator = undefined;
    }

    // Clear all active intervals
    this.activeIntervals.forEach((intervalId) => {
      clearInterval(intervalId);
    });
    this.activeIntervals.clear();

    // Clear event handlers
    this.eventHandlers.clear();

    await this.riskManager.emergencyStop();
    await this.realtimeManager.disconnect();
  }

  private emit(event: string, data: unknown): void {
    // TODO: Emit events to registered handlers
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach((handler) => handler(data));
  }

  // ========================================
  // BUILTIN STRATEGY CONVENIENCE METHODS
  // ========================================

  /**
   * Start a DCA (Dollar Cost Averaging) strategy
   */
  async startDCA(parameters: {
    pair: string;
    totalAmountUsd: number;
    intervalMinutes: number;
    orderCount: number;
    priceStrategy?: "market" | "limit" | "twap";
  }): Promise<{ instanceId: string; strategyId: string }> {
    this.ensureEnhancedFeatures();
    const instanceId = `dca_${Date.now()}`;
    await this.startStrategy("builtin.dca", instanceId, parameters);
    return { instanceId, strategyId: "builtin.dca" };
  }

  /**
   * Start a Grid Trading strategy
   */
  async startGrid(parameters: {
    pair: string;
    lowerBound: number;
    upperBound: number;
    gridCount: number;
    totalAmount: number;
    mode?: "neutral" | "long" | "short";
  }): Promise<{ instanceId: string; strategyId: string }> {
    this.ensureEnhancedFeatures();
    const instanceId = `grid_${Date.now()}`;
    await this.startStrategy("builtin.grid", instanceId, parameters);
    return { instanceId, strategyId: "builtin.grid" };
  }

  /**
   * Start a Portfolio Management strategy
   */
  async startPortfolio(parameters: {
    allocationTargets: Array<{
      token: string;
      targetPercent: number;
      minPercent?: number;
      maxPercent?: number;
    }>;
    rebalanceThreshold?: number;
    rebalanceInterval?: number;
    riskTolerance?: number;
  }): Promise<{ instanceId: string; strategyId: string }> {
    this.ensureEnhancedFeatures();
    const instanceId = `portfolio_${Date.now()}`;
    await this.startStrategy("builtin.portfolio", instanceId, parameters);
    return { instanceId, strategyId: "builtin.portfolio" };
  }

  /**
   * Get all available builtin strategies
   */
  getBuiltinStrategies(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    riskLevel: number;
    examples: StrategyExample[];
  }> {
    this.ensureEnhancedFeatures();
    const builtinIds = ["builtin.dca", "builtin.grid", "builtin.portfolio"];
    return this.getAvailableStrategies().filter((s) =>
      builtinIds.includes(s.id),
    );
  }
}

// ========================================
// FACTORY FUNCTIONS
// ========================================

/**
 * Factory function to create bot with enhanced features enabled by default
 * @deprecated Use new Mach1Bot(config) instead. Enhanced features are now built-in.
 */
export function createEnhancedBot(config: BotConfig): Mach1Bot {
  return new Mach1Bot({ ...config, enableEnhancedFeatures: true });
}

/**
 * Convenience function for network-based bot with enhanced features
 * @deprecated Use Mach1Bot.forNetwork() instead. Enhanced features are now built-in.
 */
export function createEnhancedBotForNetwork(
  networkName: keyof typeof NETWORK_PRESETS,
  privateKey: string,
  options?: Partial<BotConfig>,
): Mach1Bot {
  const presetKey =
    NETWORK_PRESETS[networkName] !== undefined
      ? networkName
      : NETWORK_PRESET_ALIASES[String(networkName)];
  const preset = presetKey ? NETWORK_PRESETS[presetKey] : undefined;
  if (!preset) {
    throw new InvalidConfigError(
      "network",
      networkName,
      "Unknown network preset",
    );
  }

  const config: BotConfig = {
    privateKey,
    rpcUrl: preset.rpcUrl,
    chainId: preset.chainId,
    enableEnhancedFeatures: true,
    ...options,
  };

  return new Mach1Bot(config);
}
