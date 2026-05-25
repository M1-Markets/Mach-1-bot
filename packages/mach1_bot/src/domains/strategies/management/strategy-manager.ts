/**
 * Strategy Manager
 *
 * Manages the complete lifecycle of strategies including execution, monitoring,
 * and performance tracking. Integrates with the existing Mach1Bot architecture.
 */

import { EventEmitter } from "events";
import type { TradingPair as MonacoTradingPair } from "mach1_sdk";
import { AIAgent } from "@/domains/bot/ai-agent";
import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import {
  IStrategy,
  MarketEvent,
  OrderEvent,
  RiskEvent,
  StrategyContext,
  StrategyMetrics,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
  StrategyUtils,
} from "@/domains/strategies/core/i-strategy";
import { MarketManager } from "@/domains/trading/market-manager";
import { MarketDataService } from "@/domains/trading/market-data-service";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import { RiskManager } from "@/domains/trading/risk-manager";
import { TradingPairService } from "@/domains/trading/trading-pair-service";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import {
  Address,
  MarketData,
  type OrderLifecycleEvent,
  type OrderLifecycleRecord,
  OrderRequest,
  OrderResult,
  Position,
  SdkPortfolio,
  TradingPair,
} from "@/shared/types";
import type {
  AiOrderDecision,
  AiOrderSnapshot,
  AiStrategyDecision,
  AiStrategySnapshot,
} from "@/shared/types/ai";
import type { BotConfig } from "@/shared/types/bot";
import type { TradingPairResolver } from "mach1_sdk";
import { RegisteredStrategy, StrategyRegistry } from "./strategy-registry";

export interface StrategyInstance {
  id: string;
  strategyId: string;
  strategy: IStrategy;
  parameters: StrategyParameters;
  status: StrategyStatus;
  metrics: StrategyMetrics;
  state: Map<string, unknown>;
  lastSignals?: StrategySignal[];
  createdAt: number;
  lastExecuted?: number;
  executionCount: number;
  errors: StrategyError[];
  subscriptions: Set<string>; // Market data subscriptions
}

export type StrategyStatus =
  | "initializing"
  | "running"
  | "paused"
  | "stopped"
  | "error"
  | "cleanup";

export interface StrategyError {
  timestamp: number;
  message: string;
  stack?: string;
  severity: "warning" | "error" | "critical";
}

export interface StrategyExecutionOptions {
  executeInterval?: number; // ms
  maxExecutionsPerMinute?: number;
  timeoutMs?: number;
  enableRiskChecks?: boolean;
  enablePerformanceTracking?: boolean;
}

export interface StrategyPerformanceReport {
  instance: StrategyInstance;
  performance: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    avgTradeDuration: number;
  };
  trades: Array<{
    timestamp: number;
    pair: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    pnl: number;
    commission: number;
  }>;
  riskMetrics: {
    var95: number;
    var99: number;
    expectedShortfall: number;
    correlations: Record<string, number>;
  };
}

type StrategySignalAction = StrategySignal["action"];
type SupportedExecutableOrderType = NonNullable<OrderRequest["orderType"]>;

interface StrategySignalValidationError {
  code:
    | "unsupported_action"
    | "unsupported_order_type"
    | "unsupported_pair"
    | "invalid_confidence"
    | "missing_quantity"
    | "invalid_quantity"
    | "missing_price"
    | "invalid_price";
  field: "action" | "orderType" | "pair" | "confidence" | "quantity" | "price";
  message: string;
}

interface StrategySignalValidationResult {
  valid: boolean;
  errors: StrategySignalValidationError[];
  tradingPair?: TradingPair;
  executionOrderType?: SupportedExecutableOrderType;
}

/**
 * Strategy Manager orchestrates strategy execution and lifecycle
 */
export class StrategyManager extends EventEmitter {
  private instances: Map<string, StrategyInstance> = new Map();
  private executionCoordinators: Map<string, StrategyExecutionCoordinator> =
    new Map();
  private executionOptions: Map<string, StrategyExecutionOptions> = new Map();
  private performanceTrackers: Map<string, PerformanceTracker> = new Map();
  private orderExecutor?: (order: OrderRequest) => Promise<OrderResult>;
  private aiHelper?: AIAgent;
  private aiHelperConfig?: BotConfig["aiHelper"];
  private readonly tradingPairService: TradingPairService;
  private readonly marketDataService: MarketDataService;
  private detachOrderEventEmitter?: () => void;
  private detachRiskEventEmitter?: () => void;

  constructor(
    private registry: StrategyRegistry,
    private marketManager: MarketManager,
    private orderManager: OrderManager,
    private positionTracker: PositionTracker,
    private realtimeManager: RealtimeManager,
    private riskManager: RiskManager,
    aiHelperConfig?: BotConfig["aiHelper"],
    resolverProvider?: () => TradingPairResolver | undefined,
  ) {
    super();
    this.tradingPairService = new TradingPairService(resolverProvider);
    this.marketDataService = new MarketDataService();
    this.setupEventHandlers();
    if (aiHelperConfig) {
      this.setAiHelper(aiHelperConfig);
    }
  }

  /**
   * Create and start a strategy instance
   */
  async createAndStartStrategy(
    strategyId: string,
    instanceId: string,
    parameters: StrategyParameters,
    options: StrategyExecutionOptions = {},
  ): Promise<StrategyInstance> {
    // Check if instance already exists
    if (this.instances.has(instanceId)) {
      throw new Error(`Strategy instance '${instanceId}' already exists`);
    }

    // Create strategy instance from registry
    const strategy = await this.registry.createInstance(
      strategyId,
      instanceId,
      parameters,
    );
    const registeredStrategy = this.registry.getStrategy(strategyId);
    if (!registeredStrategy) {
      throw new Error(`Strategy '${strategyId}' not found in registry`);
    }

    // Create strategy instance record
    const instance: StrategyInstance = {
      id: instanceId,
      strategyId,
      strategy,
      parameters,
      status: "initializing",
      metrics: this.createInitialMetrics(),
      state: new Map(),
      createdAt: Date.now(),
      executionCount: 0,
      errors: [],
      subscriptions: new Set(),
    };

    this.instances.set(instanceId, instance);

    // Initialize performance tracker
    this.performanceTrackers.set(instanceId, new PerformanceTracker());

    try {
      // Initialize strategy
      const context = await this.createStrategyContext(instance);
      await strategy.initialize(context);

      // Subscribe to required market data
      await this.setupMarketDataSubscriptions(instance, registeredStrategy);

      // Start execution
      instance.status = "running";
      await this.startStrategyExecution(instance, options);
      this.emit("strategyStarted", instance);

      console.log(`✅ Strategy instance '${instanceId}' started successfully`);
      return instance;
    } catch (error) {
      instance.status = "error";
      this.addError(instance, error as Error, "critical");
      this.emit("strategyError", instance, error);
      throw error;
    }
  }

  /**
   * Stop a strategy instance
   */
  async stopStrategy(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    instance.status = "cleanup";

    try {
      // Stop execution interval
      const coordinator = this.executionCoordinators.get(instanceId);
      if (coordinator) {
        await coordinator.stop();
        this.executionCoordinators.delete(instanceId);
      }

      // Unsubscribe from market data
      await this.cleanupMarketDataSubscriptions(instance);

      // Cleanup strategy
      const context = await this.createStrategyContext(instance);
      await instance.strategy.cleanup(context);

      // Remove from registry
      await this.registry.removeInstance(instance.strategyId, instanceId);

      // Cleanup tracking
      this.performanceTrackers.delete(instanceId);
      this.executionOptions.delete(instanceId);
      this.instances.delete(instanceId);

      this.emit("strategyStopped", instanceId);
      console.log(`✅ Strategy instance '${instanceId}' stopped successfully`);
    } catch (error) {
      this.addError(instance, error as Error, "error");
      this.emit("strategyError", instance, error);
      throw error;
    }
  }

  /**
   * Override order execution (e.g., route to live trading engine).
   */
  setOrderExecutor(
    executor: (order: OrderRequest) => Promise<OrderResult>,
  ): void {
    this.orderExecutor = executor;
  }

  attachOrderEventEmitter(orderEventEmitter: OrderEventEmitter): void {
    this.detachOrderEventEmitter?.();
    this.detachOrderEventEmitter = orderEventEmitter.on((event) => {
      void this.handleOrderLifecycleEvent(event);
    });
  }

  setAiHelper(aiHelperConfig: BotConfig["aiHelper"]): void {
    this.aiHelperConfig = aiHelperConfig;
    if (aiHelperConfig?.enabled && aiHelperConfig.apiKey) {
      this.aiHelper = AIAgent.fromHelperConfig({
        provider: aiHelperConfig.provider,
        apiKey: aiHelperConfig.apiKey,
        prompt: aiHelperConfig.prompt,
      });
    } else {
      this.aiHelper = undefined;
    }
  }

  /**
   * Pause a strategy instance
   */
  async pauseStrategy(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    if (instance.status !== "running") {
      throw new Error(`Cannot pause strategy in status '${instance.status}'`);
    }

    // Stop execution but keep subscriptions
    const coordinator = this.executionCoordinators.get(instanceId);
    if (coordinator) {
      await coordinator.stop();
      this.executionCoordinators.delete(instanceId);
    }

    instance.status = "paused";
    this.emit("strategyPaused", instance);
    console.log(`⏸️ Strategy instance '${instanceId}' paused`);
  }

  /**
   * Resume a paused strategy instance
   */
  async resumeStrategy(
    instanceId: string,
    options: StrategyExecutionOptions = {},
  ): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    if (instance.status !== "paused") {
      throw new Error(`Cannot resume strategy in status '${instance.status}'`);
    }

    try {
      // Restart execution
      const nextOptions = {
        ...(this.executionOptions.get(instanceId) ?? {}),
        ...options,
      };
      instance.status = "running";
      await this.startStrategyExecution(instance, nextOptions);

      this.emit("strategyResumed", instance);
      console.log(`▶️ Strategy instance '${instanceId}' resumed`);
    } catch (error) {
      instance.status = "error";
      this.addError(instance, error as Error, "critical");
      this.emit("strategyError", instance, error);
      throw error;
    }
  }

  /**
   * Update strategy parameters
   */
  async updateStrategyParameters(
    instanceId: string,
    newParameters: Partial<StrategyParameters>,
  ): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    try {
      const updatedParameters = { ...instance.parameters, ...newParameters };

      // Validate new parameters
      const validationErrors =
        await instance.strategy.validateParameters(updatedParameters);
      if (validationErrors.length > 0) {
        throw new Error(
          `Parameter validation failed: ${validationErrors.join(", ")}`,
        );
      }

      // Update parameters
      const context = await this.createStrategyContext(instance);
      await instance.strategy.updateParameters(newParameters, context);

      instance.parameters = updatedParameters;
      this.emit("strategyParametersUpdated", instance);
      console.log(`✏️ Strategy instance '${instanceId}' parameters updated`);
    } catch (error) {
      this.addError(instance, error as Error, "error");
      this.emit("strategyError", instance, error);
      throw error;
    }
  }

  /**
   * Get strategy instance
   */
  getInstance(instanceId: string): StrategyInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all strategy instances
   */
  getAllInstances(): StrategyInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Get instances by status
   */
  getInstancesByStatus(status: StrategyStatus): StrategyInstance[] {
    return [...this.instances.values()].filter(
      (instance) => instance.status === status,
    );
  }

  /**
   * Get strategy performance report
   */
  async getPerformanceReport(
    instanceId: string,
  ): Promise<StrategyPerformanceReport> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    const tracker = this.performanceTrackers.get(instanceId);
    if (!tracker) {
      throw new Error(
        `Performance tracker not found for instance '${instanceId}'`,
      );
    }

    const context = await this.createStrategyContext(instance);

    // Get custom report from strategy if available
    let customReport;
    if (instance.strategy.generateReport) {
      customReport = await instance.strategy.generateReport(context);
    }

    const performance = tracker.getPerformanceMetrics();
    const trades = tracker.getTrades();
    const riskMetrics = tracker.getRiskMetrics();

    return {
      instance,
      performance,
      trades,
      riskMetrics,
      ...(customReport && { customReport }),
    };
  }

  /**
   * Execute strategy manually (for testing)
   */
  async executeStrategy(instanceId: string): Promise<StrategyResult> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    return await this.performStrategyExecution(instance);
  }

  // Private methods

  private async createStrategyContext(
    instance: StrategyInstance,
  ): Promise<StrategyContext> {
    const corePortfolio = await this.positionTracker.getPortfolio();
    const summary = await this.positionTracker.getPositionSummary();
    const performanceMetrics =
      await this.positionTracker.getPerformanceMetrics();

    // Convert core (bigint) portfolio to SDK numeric view
    const positions: SdkPortfolio["positions"] = {};
    for (const [token, position] of corePortfolio.positions.entries()) {
      positions[token] = {
        symbol: token,
        balance: Number(position.balance),
        value: Number(position.value) / 100,
        unrealizedPnl: Number(position.unrealizedPnL) / 100,
      };
    }

    const portfolio: SdkPortfolio = {
      totalValue: Number(corePortfolio.totalValue) / 100,
      dailyPnl: Number(summary.dailyPnL) / 100,
      dailyReturn: Number(summary.dailyPnL) / Number(corePortfolio.totalValue),
      sharpeRatio: performanceMetrics.sharpeRatio,
      positions,
    };

    const corePositions = new Map<string, Position>();

    // Convert portfolio positions to map
    for (const [token, position] of corePortfolio.positions.entries()) {
      corePositions.set(token, position);
    }

    // Get market data for subscribed pairs
    const marketData = new Map<string, MarketData>();
    for (const pair of instance.subscriptions) {
      const tradingPair = await this.resolveTradingPair(pair);
      const end = new Date();
      const start = new Date(end.getTime() - 60 * 60 * 1000);
      const [ohlcv, orderbook, candleHistory] = await Promise.all([
        this.realtimeManager.getOHLCVSnapshot(pair, "1m"),
        this.realtimeManager.getOrderbookSnapshot(pair),
        this.marketManager.getCandles(tradingPair, "1m", start, end),
      ]);
      const tick = this.marketDataService.buildLiveTick({
        symbol: pair,
        ohlcv,
        orderbook,
        candleHistory,
      });

      if (tick) {
        marketData.set(pair, { [pair]: tick });
      }
    }

    return {
      portfolio,
      positions: corePositions,
      marketData,
      parameters: instance.parameters,
      state: instance.state,
      metrics: instance.metrics,
      utils: this.createStrategyUtils(instance),
    };
  }

  private async getAiDecision(
    instance: StrategyInstance,
    context: StrategyContext,
  ): Promise<AiStrategyDecision | undefined> {
    if (!this.aiHelper || !this.aiHelperConfig?.enabled) {
      return undefined;
    }

    const snapshot = this.buildAiSnapshot(instance, context);
    return this.aiHelper.analyzeStrategyControl(snapshot);
  }

  private async getAiOrderDecision(
    instance: StrategyInstance,
    context: StrategyContext,
    signal: StrategySignal,
  ): Promise<AiOrderDecision | undefined> {
    if (!this.aiHelper || !this.aiHelperConfig?.enabled) {
      return undefined;
    }
    if (signal.action !== "buy" && signal.action !== "sell") {
      return undefined;
    }
    const snapshot = this.buildAiOrderSnapshot(instance, context, signal);
    return this.aiHelper.analyzeOrderDecision(snapshot);
  }

  private buildAiSnapshot(
    instance: StrategyInstance,
    context: StrategyContext,
  ): AiStrategySnapshot {
    const marketData: MarketData = {};
    for (const [pair, data] of context.marketData.entries()) {
      const direct = data[pair];
      if (direct) {
        marketData[pair] = direct;
        continue;
      }
      const first = Object.values(data)[0];
      if (first) {
        marketData[pair] = first;
      }
    }

    const state: Record<string, unknown> = {};
    for (const [key, value] of instance.state.entries()) {
      state[key] = value;
    }

    return {
      marketData,
      portfolio: context.portfolio,
      metrics: {
        totalReturn: context.metrics.totalReturn,
        sharpeRatio: context.metrics.sharpeRatio,
        maxDrawdown: context.metrics.maxDrawdown,
        winRate: context.metrics.winRate,
        totalTrades: context.metrics.totalTrades,
        profitFactor: context.metrics.profitFactor,
      },
      parameters: instance.parameters,
      lastSignals: instance.lastSignals?.map((signal) => ({
        action: signal.action,
        pair: signal.pair,
        confidence: signal.confidence,
        reason: signal.reason,
      })),
      state,
    };
  }

  private buildAiOrderSnapshot(
    instance: StrategyInstance,
    context: StrategyContext,
    signal: StrategySignal,
  ): AiOrderSnapshot {
    const base = this.buildAiSnapshot(instance, context);
    return {
      ...base,
      signal: {
        action: signal.action,
        pair: signal.pair,
        quantity: signal.quantity,
        price: signal.price,
        orderType: signal.orderType,
        confidence: signal.confidence,
        reason: signal.reason,
        metadata: signal.metadata,
      },
    };
  }

  private async applyAiDecision(
    instance: StrategyInstance,
    decision: AiStrategyDecision,
  ): Promise<boolean> {
    if (decision.action === "stop") {
      console.log(
        `🛑 AI requested stop for strategy ${instance.id}: ${decision.reason}`,
      );
      await this.stopStrategy(instance.id);
      return false;
    }

    if (decision.action === "pause") {
      console.log(
        `⏸️ AI requested pause for strategy ${instance.id}: ${decision.reason}`,
      );
      await this.pauseStrategy(instance.id);
      return false;
    }

    return true;
  }

  private async applyAiOrderDecision(
    instance: StrategyInstance,
    decision: AiOrderDecision,
  ): Promise<"approve" | "reject"> {
    if (decision.action === "pause") {
      console.log(
        `⏸️ AI paused order for strategy ${instance.id}: ${decision.reason}`,
      );
      await this.pauseStrategy(instance.id);
      return "reject";
    }
    if (decision.action === "reject") {
      console.log(
        `🧠 AI rejected order for strategy ${instance.id}: ${decision.reason}`,
      );
      return "reject";
    }
    return "approve";
  }

  private createStrategyUtils(instance: StrategyInstance): StrategyUtils {
    return {
      indicators: {
        sma: (data: number[], period: number) => {
          if (data.length < period) return 0;
          const sum = data.slice(-period).reduce((a, b) => a + b, 0);
          return sum / period;
        },
        ema: (data: number[], period: number) => {
          if (data.length === 0) return 0;
          const multiplier = 2 / (period + 1);
          return data.reduce((ema, price, index) => {
            return index === 0 ? price : (price - ema) * multiplier + ema;
          });
        },
        rsi: (data: number[], period: number) => {
          if (data.length < period + 1) return 50;

          let gains = 0,
            losses = 0;
          for (let i = 1; i <= period; i++) {
            const change = data[data.length - i] - data[data.length - i - 1];
            if (change > 0) gains += change;
            else losses -= change;
          }

          const avgGain = gains / period;
          const avgLoss = losses / period;
          const rs = avgGain / avgLoss;
          return 100 - 100 / (1 + rs);
        },
        macd: (data: number[], fast: number, slow: number, signal: number) => {
          const fastEma = this.createStrategyUtils(instance).indicators.ema(
            data,
            fast,
          );
          const slowEma = this.createStrategyUtils(instance).indicators.ema(
            data,
            slow,
          );
          const macdLine = fastEma - slowEma;

          // Simplified signal line calculation
          const signalLine = macdLine * 0.9; // This should be proper EMA of MACD
          const histogram = macdLine - signalLine;

          return { macd: macdLine, signal: signalLine, histogram };
        },
        bollingerBands: (data: number[], period: number, stdDev: number) => {
          const sma = this.createStrategyUtils(instance).indicators.sma(
            data,
            period,
          );
          const variance =
            data.slice(-period).reduce((sum, price) => {
              return sum + Math.pow(price - sma, 2);
            }, 0) / period;
          const std = Math.sqrt(variance);

          return {
            upper: sma + std * stdDev,
            middle: sma,
            lower: sma - std * stdDev,
          };
        },
        stochastic: (
          high: number[],
          low: number[],
          close: number[],
          period: number,
        ) => {
          if (high.length < period) return { k: 50, d: 50 };

          const currentClose = close[close.length - 1];
          const lowestLow = Math.min(...low.slice(-period));
          const highestHigh = Math.max(...high.slice(-period));

          const k =
            ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
          const d = k * 0.9; // Simplified D calculation

          return { k, d };
        },
      },
      math: {
        mean: (data: number[]) => data.reduce((a, b) => a + b, 0) / data.length,
        std: (data: number[]) => {
          const mean = data.reduce((a, b) => a + b, 0) / data.length;
          const variance =
            data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
            data.length;
          return Math.sqrt(variance);
        },
        correlation: (x: number[], y: number[]) => {
          const n = Math.min(x.length, y.length);
          if (n === 0) return 0;

          const xMean = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
          const yMean = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

          let numerator = 0,
            xSumSq = 0,
            ySumSq = 0;
          for (let i = 0; i < n; i++) {
            const xDiff = x[i] - xMean;
            const yDiff = y[i] - yMean;
            numerator += xDiff * yDiff;
            xSumSq += xDiff * xDiff;
            ySumSq += yDiff * yDiff;
          }

          const denominator = Math.sqrt(xSumSq * ySumSq);
          return denominator === 0 ? 0 : numerator / denominator;
        },
        percentile: (data: number[], p: number) => {
          const sorted = [...data].sort((a, b) => a - b);
          const index = (p / 100) * (sorted.length - 1);
          const lower = Math.floor(index);
          const upper = Math.ceil(index);

          if (lower === upper) return sorted[lower];

          const weight = index - lower;
          return sorted[lower] * (1 - weight) + sorted[upper] * weight;
        },
      },
      time: {
        getCurrentTimestamp: () => Date.now(),
        formatTime: (timestamp: number) => new Date(timestamp).toISOString(),
        getMarketHours: () => ({
          isOpen: true, // Crypto markets are always open
          nextOpen: 0,
          nextClose: 0,
        }),
      },
      log: {
        info: (message: string, data?: unknown) => {
          console.log(`[${instance.id}] INFO: ${message}`, data || "");
        },
        warn: (message: string, data?: unknown) => {
          console.warn(`[${instance.id}] WARN: ${message}`, data || "");
        },
        error: (message: string, data?: unknown) => {
          console.error(`[${instance.id}] ERROR: ${message}`, data || "");
          this.addError(instance, new Error(message), "error");
        },
        debug: (message: string, data?: unknown) => {
          console.debug(`[${instance.id}] DEBUG: ${message}`, data || "");
        },
      },
    };
  }

  private async startStrategyExecution(
    instance: StrategyInstance,
    options: StrategyExecutionOptions,
  ): Promise<void> {
    const executeInterval = options.executeInterval || 5000; // 5 seconds default
    const maxExecutionsPerMinute = options.maxExecutionsPerMinute || 12;

    const existingCoordinator = this.executionCoordinators.get(instance.id);
    if (existingCoordinator) {
      await existingCoordinator.stop();
      this.executionCoordinators.delete(instance.id);
    }

    this.executionOptions.set(instance.id, {
      ...options,
      executeInterval,
      maxExecutionsPerMinute,
    });

    let executionCount = 0;
    let lastMinute = Math.floor(Date.now() / 60000);

    const coordinator = new StrategyExecutionCoordinator({
      executor: async () => {
        const currentMinute = Math.floor(Date.now() / 60000);

        // Reset execution count every minute
        if (currentMinute > lastMinute) {
          executionCount = 0;
          lastMinute = currentMinute;
        }

        // Check execution rate limit
        if (executionCount >= maxExecutionsPerMinute) {
          return;
        }

        // Skip if strategy is not running
        if (instance.status !== "running") {
          return;
        }

        try {
          await this.performStrategyExecution(instance);
          executionCount++;
        } catch (error) {
          this.addError(instance, error as Error, "error");
          this.emit("strategyExecutionError", instance, error);
        }
      },
      intervalMs: executeInterval,
    });

    this.executionCoordinators.set(instance.id, coordinator);
    await coordinator.start();
  }

  private async performStrategyExecution(
    instance: StrategyInstance,
  ): Promise<StrategyResult> {
    const startTime = Date.now();

    try {
      // Create context
      const context = await this.createStrategyContext(instance);
      const missingPairs = [...instance.subscriptions].filter(
        (pair) => !context.marketData.has(pair),
      );
      if (missingPairs.length > 0) {
        const warning = `Missing market data for subscribed pairs: ${missingPairs.join(", ")}`;
        this.addError(instance, new Error(warning), "warning");
        return {
          signals: [],
          shouldContinue: true,
          warnings: [warning],
        };
      }

      const aiDecision = await this.getAiDecision(instance, context);
      if (aiDecision) {
        if (instance.strategy.onAiDecision) {
          await instance.strategy.onAiDecision(aiDecision, context);
        }

        const shouldExecute = await this.applyAiDecision(instance, aiDecision);
        if (!shouldExecute) {
          return {
            signals: [],
            shouldContinue: aiDecision.shouldContinue,
            warnings: [aiDecision.reason],
          };
        }
      }

      // Execute strategy
      const result = await instance.strategy.execute(context);

      // Process signals
      const signalWarnings = await this.processStrategySignals(
        instance,
        result.signals,
        context,
      );

      // Update metrics
      instance.executionCount++;
      instance.lastExecuted = Date.now();

      // Update state if provided
      if (result.state) {
        for (const [key, value] of Object.entries(result.state)) {
          instance.state.set(key, value);
        }
      }
      instance.lastSignals = result.signals;

      // Update performance tracking
      const tracker = this.performanceTrackers.get(instance.id);
      if (tracker) {
        tracker.recordExecution(result, Date.now() - startTime);
      }

      if (!result.shouldContinue) {
        await this.pauseStrategy(instance.id);
      }

      if (signalWarnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...signalWarnings];
      }
      this.emit("strategyExecuted", instance, result);
      return result;
    } catch (error) {
      this.addError(instance, error as Error, "error");
      throw error;
    }
  }

  private async processStrategySignals(
    instance: StrategyInstance,
    signals: StrategySignal[],
    context: StrategyContext,
  ): Promise<string[]> {
    const warnings: string[] = [];
    for (const signal of signals) {
      try {
        const validation = await this.validateStrategySignal(signal);
        if (!validation.valid) {
          const message = this.formatStrategySignalValidationMessage(
            signal,
            validation.errors,
          );
          this.addError(instance, new Error(message), "warning");
          warnings.push(message);
          continue;
        }
        if (signal.action === "hold") {
          continue;
        }
        const orderDecision = await this.getAiOrderDecision(
          instance,
          context,
          signal,
        );
        if (orderDecision) {
          const verdict = await this.applyAiOrderDecision(
            instance,
            orderDecision,
          );
          if (verdict === "reject") {
            continue;
          }
        }
        await this.executeSignal(instance, signal, validation);
      } catch (error) {
        this.addError(instance, error as Error, "warning");
        console.warn(`Failed to execute signal for ${instance.id}:`, error);
      }
    }
    return warnings;
  }

  private async executeSignal(
    instance: StrategyInstance,
    signal: StrategySignal,
    validation: StrategySignalValidationResult,
  ): Promise<void> {
    const tradingPair = validation.tradingPair!;
    const executionOrderType = validation.executionOrderType ?? "market";

    if (signal.action === "buy" || signal.action === "sell") {
      const currentPrice =
        await this.marketManager.getCurrentPrice(tradingPair);
      const orderPrice =
        executionOrderType === "limit"
          ? BigInt(Math.floor((signal.price ?? 0) * 100))
          : signal.price !== undefined
            ? BigInt(Math.floor(signal.price * 100))
            : currentPrice;
      const orderQuantity = BigInt(Math.floor((signal.quantity ?? 0) * 100));

      const orderRequest: OrderRequest = {
        baseToken: tradingPair.base,
        quoteToken: tradingPair.quote,
        isBuy: signal.action === "buy",
        strategyId: instance.id,
        orderId: `${instance.id}-${Date.now()}`,
        price: orderPrice,
        quantity: orderQuantity,
        orderType: executionOrderType,
      };

      // Risk validation
      const riskCheck = await this.riskManager.validateOrder(orderRequest);
      if (!riskCheck.approved) {
        throw new Error(
          `Order rejected by risk manager: ${riskCheck.rejectionReasons.join(", ")}`,
        );
      }

      // Execute order
      const executor = this.orderExecutor;
      const _result = executor
        ? await executor(orderRequest)
        : executionOrderType === "limit"
          ? await this.orderManager.placeLimitOrder(orderRequest)
          : await this.orderManager.placeMarketOrder(orderRequest);

      console.log(
        `📊 Strategy ${instance.id} executed ${signal.action} order for ${signal.pair}`,
      );
    }
  }

  private async validateStrategySignal(
    signal: StrategySignal,
  ): Promise<StrategySignalValidationResult> {
    const errors: StrategySignalValidationError[] = [];
    const action = signal.action;
    const executableAction = action === "buy" || action === "sell";

    if (
      action !== "buy" &&
      action !== "sell" &&
      action !== "hold" &&
      action !== "close_position" &&
      action !== "reduce_position"
    ) {
      errors.push({
        code: "unsupported_action",
        field: "action",
        message: `Unsupported strategy action: ${String(action)}`,
      });
    } else if (action === "close_position" || action === "reduce_position") {
      errors.push({
        code: "unsupported_action",
        field: "action",
        message: `Strategy action '${action}' not implemented yet`,
      });
    }

    let tradingPair: TradingPair | undefined;
    try {
      tradingPair = await this.resolveTradingPair(signal.pair);
    } catch (error) {
      errors.push({
        code: "unsupported_pair",
        field: "pair",
        message:
          error instanceof Error
            ? error.message
            : `Unsupported trading pair: ${signal.pair}`,
      });
    }

    if (
      !Number.isFinite(signal.confidence) ||
      signal.confidence < 0 ||
      signal.confidence > 1
    ) {
      errors.push({
        code: "invalid_confidence",
        field: "confidence",
        message: `Signal confidence must be between 0 and 1. Received: ${signal.confidence}`,
      });
    }

    const executionOrderType = this.mapStrategyOrderType(signal, errors);

    if (executableAction) {
      if (signal.quantity === undefined) {
        errors.push({
          code: "missing_quantity",
          field: "quantity",
          message:
            "Signal quantity required for buy/sell actions; skipping order",
        });
      } else if (!(signal.quantity > 0)) {
        errors.push({
          code: "invalid_quantity",
          field: "quantity",
          message: `Signal quantity must be positive. Received: ${signal.quantity}`,
        });
      }
    }

    if (executionOrderType === "limit") {
      if (signal.price === undefined) {
        errors.push({
          code: "missing_price",
          field: "price",
          message: "Limit orders require a price",
        });
      } else if (!(signal.price > 0)) {
        errors.push({
          code: "invalid_price",
          field: "price",
          message: `Signal price must be positive. Received: ${signal.price}`,
        });
      }
    } else if (signal.price !== undefined && !(signal.price > 0)) {
      errors.push({
        code: "invalid_price",
        field: "price",
        message: `Signal price must be positive. Received: ${signal.price}`,
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      tradingPair,
      executionOrderType,
    };
  }

  private mapStrategyOrderType(
    signal: StrategySignal,
    errors: StrategySignalValidationError[],
  ): SupportedExecutableOrderType | undefined {
    const requestedOrderType = signal.orderType ?? "market";
    if (requestedOrderType === "market" || requestedOrderType === "limit") {
      return requestedOrderType;
    }

    errors.push({
      code: "unsupported_order_type",
      field: "orderType",
      message: `Strategy order type '${requestedOrderType}' not implemented yet`,
    });
    return undefined;
  }

  private formatStrategySignalValidationMessage(
    signal: StrategySignal,
    errors: StrategySignalValidationError[],
  ): string {
    return `Strategy signal rejected for ${signal.pair}: ${errors.map((error) => `${error.field}:${error.code}:${error.message}`).join("; ")}`;
  }

  /**
   * Resolve a strategy signal symbol to a TradingPair, preferring live/SDK-derived pairs.
   */
  private async resolveTradingPair(symbol: string): Promise<TradingPair> {
    return this.tradingPairService.resolveSymbol(symbol);
  }

  private async setupMarketDataSubscriptions(
    instance: StrategyInstance,
    registeredStrategy: RegisteredStrategy,
  ): Promise<void> {
    // Subscribe to market data for supported pairs
    for (const pairSymbol of registeredStrategy.config.supportedPairs) {
      try {
        const tradingPair = await this.resolveTradingPair(pairSymbol);

        // Subscribe to price updates
        const priceStream = await this.realtimeManager.subscribePrices([
          tradingPair,
        ]);
        priceStream.subscribe(
          (event: { pair: TradingPair; price: bigint; timestamp: number }) => {
            this.handleMarketEvent(instance, {
              type: "price_change",
              pair: pairSymbol,
              data: event,
              timestamp: Date.now(),
            });
          },
        );

        instance.subscriptions.add(pairSymbol);
      } catch (error) {
        console.warn(
          `Failed to subscribe to market data for ${pairSymbol}:`,
          error,
        );
      }
    }
  }

  private async cleanupMarketDataSubscriptions(
    instance: StrategyInstance,
  ): Promise<void> {
    // In a real implementation, you would unsubscribe from specific streams
    // For now, we'll just clear the subscriptions set
    instance.subscriptions.clear();
  }

  private async handleMarketEvent(
    instance: StrategyInstance,
    event: MarketEvent,
  ): Promise<void> {
    if (instance.strategy.onMarketEvent) {
      try {
        const context = await this.createStrategyContext(instance);
        await instance.strategy.onMarketEvent(event, context);
      } catch (error) {
        this.addError(instance, error as Error, "warning");
      }
    }
  }

  private setupEventHandlers(): void {
    if (
      typeof (this.riskManager as Partial<RiskManager>).on !== "function" ||
      typeof (this.riskManager as Partial<RiskManager>).off !== "function"
    ) {
      return;
    }
    const riskListener = (event: RiskEvent) => {
      void this.handleRiskEvent(event);
    };
    this.detachRiskEventEmitter?.();
    this.detachRiskEventEmitter = () => {
      this.riskManager.off("riskEvent", riskListener);
    };
    this.riskManager.on("riskEvent", riskListener);
  }

  private async handleOrderLifecycleEvent(
    lifecycleEvent: OrderLifecycleEvent,
  ): Promise<void> {
    const strategyOrderEvent: OrderEvent = {
      type: lifecycleEvent.type,
      orderId: lifecycleEvent.order.localId,
      order: lifecycleEvent.order,
      timestamp: lifecycleEvent.timestamp,
    };

    const owner = lifecycleEvent.order.strategyId;
    if (owner) {
      const tracker = this.performanceTrackers.get(owner);
      const instance = this.instances.get(owner);
      if (tracker && instance) {
        tracker.recordOrderEvent(lifecycleEvent.order);
        instance.metrics = {
          ...instance.metrics,
          ...tracker.getPerformanceMetrics(),
          totalTrades: tracker.getPerformanceMetrics().totalTrades,
          lastUpdate: lifecycleEvent.timestamp,
        };
      }
    }

    await this.handleOrderEvent(strategyOrderEvent);
  }

  private async handleOrderEvent(event: OrderEvent): Promise<void> {
    // Notify all relevant strategy instances
    for (const instance of this.instances.values()) {
      const orderRecord =
        "pair" in event.order && "localId" in event.order
          ? (event.order as OrderLifecycleRecord)
          : undefined;
      const isRelevant =
        orderRecord !== undefined &&
        (orderRecord.strategyId === instance.id ||
          instance.subscriptions.has(orderRecord.pair.symbol));
      if (orderRecord && !isRelevant) {
        continue;
      }
      if (instance.strategy.onOrderEvent) {
        try {
          const context = await this.createStrategyContext(instance);
          await instance.strategy.onOrderEvent(event, context);
        } catch (error) {
          this.addError(instance, error as Error, "warning");
        }
      }
    }
  }

  private async handleRiskEvent(event: RiskEvent): Promise<void> {
    for (const instance of this.instances.values()) {
      const eventData =
        event.data && typeof event.data === "object" ? event.data : undefined;
      const strategyId =
        eventData && "strategyId" in eventData
          ? (eventData.strategyId as string | undefined)
          : undefined;
      const pair =
        eventData && "pair" in eventData
          ? (eventData.pair as string | undefined)
          : undefined;
      if (
        strategyId !== undefined &&
        strategyId !== instance.id &&
        (!pair || !instance.subscriptions.has(pair))
      ) {
        continue;
      }
      if (instance.strategy.onRiskEvent) {
        try {
          const context = await this.createStrategyContext(instance);
          await instance.strategy.onRiskEvent(event, context);
        } catch (error) {
          this.addError(instance, error as Error, "warning");
        }
      }
    }
  }

  private createInitialMetrics(): StrategyMetrics {
    return {
      totalReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      totalTrades: 0,
      avgHoldingPeriod: 0,
      profitFactor: 0,
      lastUpdate: Date.now(),
    };
  }

  private addError(
    instance: StrategyInstance,
    error: Error,
    severity: "warning" | "error" | "critical",
  ): void {
    const strategyError: StrategyError = {
      timestamp: Date.now(),
      message: error.message,
      stack: error.stack,
      severity,
    };

    instance.errors.push(strategyError);

    // Keep only last 100 errors
    if (instance.errors.length > 100) {
      instance.errors = instance.errors.slice(-100);
    }

    // Set status to error for critical errors
    if (severity === "critical") {
      instance.status = "error";
    }
  }
}

/**
 * Performance Tracker for individual strategy instances
 */
class PerformanceTracker {
  private trades: Array<{
    timestamp: number;
    pair: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    pnl: number;
    commission: number;
  }> = [];

  private executionTimes: number[] = [];
  private returns: number[] = [];
  private readonly positions = new Map<
    string,
    { quantity: number; averagePrice: number }
  >();

  recordOrderEvent(order: OrderLifecycleRecord): void {
    if (
      order.strategyId === undefined ||
      (order.status !== "filled" && order.status !== "partially_filled") ||
      order.averageFillPrice === undefined ||
      order.filledQuantity <= 0n
    ) {
      return;
    }

    const pair = order.pair.symbol;
    const quantity = Number(order.filledQuantity) / 100;
    const price = Number(order.averageFillPrice) / 100;
    const commission = Number(order.fees) / 100;
    const slippage = Number(order.slippage) / 100;
    const position = this.positions.get(pair) ?? {
      quantity: 0,
      averagePrice: 0,
    };

    if (order.side === "buy") {
      const totalQuantity = position.quantity + quantity;
      position.averagePrice =
        totalQuantity > 0
          ? (position.quantity * position.averagePrice + quantity * price) /
            totalQuantity
          : 0;
      position.quantity = totalQuantity;
      this.positions.set(pair, position);
      return;
    }

    const realizedQuantity = Math.min(quantity, position.quantity);
    const pnl =
      realizedQuantity > 0
        ? (price - position.averagePrice) * realizedQuantity -
          commission -
          slippage
        : 0;
    position.quantity = Math.max(0, position.quantity - realizedQuantity);
    if (position.quantity === 0) {
      position.averagePrice = 0;
    }
    this.positions.set(pair, position);

    this.trades.push({
      timestamp: order.updatedAt,
      pair,
      side: order.side,
      quantity: realizedQuantity,
      price,
      pnl,
      commission,
    });

    this.returns.push(pnl);
  }

  recordExecution(result: StrategyResult, executionTimeMs: number): void {
    this.executionTimes.push(executionTimeMs);
  }

  getPerformanceMetrics(): {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    avgTradeDuration: number;
    totalTrades: number;
  } {
    const totalReturn = this.returns.reduce((sum, ret) => sum + ret, 0);
    const winningTrades = this.returns.filter((ret) => ret > 0);
    const losingTrades = this.returns.filter((ret) => ret < 0);

    const winRate =
      this.returns.length > 0 ? winningTrades.length / this.returns.length : 0;
    const avgWin =
      winningTrades.length > 0
        ? winningTrades.reduce((sum, win) => sum + win, 0) /
          winningTrades.length
        : 0;
    const avgLoss =
      losingTrades.length > 0
        ? Math.abs(losingTrades.reduce((sum, loss) => sum + loss, 0)) /
          losingTrades.length
        : 0;
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;

    // Calculate Sharpe ratio (simplified)
    const avgReturn =
      this.returns.length > 0 ? totalReturn / this.returns.length : 0;
    const returnStd =
      this.returns.length > 1
        ? Math.sqrt(
            this.returns.reduce(
              (sum, ret) => sum + Math.pow(ret - avgReturn, 2),
              0,
            ) /
              (this.returns.length - 1),
          )
        : 0;
    const sharpeRatio = returnStd > 0 ? avgReturn / returnStd : 0;

    // Calculate max drawdown (simplified)
    let peak = 0;
    let maxDrawdown = 0;
    let cumulative = 0;

    for (const ret of this.returns) {
      cumulative += ret;
      if (cumulative > peak) {
        peak = cumulative;
      } else {
        const drawdown = (peak - cumulative) / peak;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    return {
      totalReturn,
      sharpeRatio,
      maxDrawdown,
      winRate,
      profitFactor,
      avgTradeDuration: 0, // Would need to track position open/close times
      totalTrades: this.returns.length,
    };
  }

  getTrades() {
    return [...this.trades];
  }

  getRiskMetrics(): {
    var95: number;
    var99: number;
    expectedShortfall: number;
    correlations: Record<string, number>;
  } {
    if (this.returns.length === 0) {
      return { var95: 0, var99: 0, expectedShortfall: 0, correlations: {} };
    }

    const sortedReturns = [...this.returns].sort((a, b) => a - b);
    const var95Index = Math.floor(sortedReturns.length * 0.05);
    const var99Index = Math.floor(sortedReturns.length * 0.01);

    const var95 = sortedReturns[var95Index] || 0;
    const var99 = sortedReturns[var99Index] || 0;

    const tailReturns = sortedReturns.slice(0, var95Index + 1);
    const expectedShortfall =
      tailReturns.length > 0
        ? tailReturns.reduce((sum, ret) => sum + ret, 0) / tailReturns.length
        : 0;

    return {
      var95,
      var99,
      expectedShortfall,
      correlations: {}, // Would need market data to calculate correlations
    };
  }
}
