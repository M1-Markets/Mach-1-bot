/**
 * Base Strategy Interface
 *
 * Defines the contract that all strategies must implement to be pluggable
 * into the Mach-One SDK. Provides hooks for the complete strategy lifecycle.
 */

import type { SdkPortfolio } from "@/shared/types";
import { MarketData, OrderResult, Position } from "@/shared/types";
import type { AiStrategyDecision } from "@/shared/types/ai";
import type { BotOrder } from "@/shared/types/bot";

export interface StrategyConfig {
  /** Unique identifier for the strategy */
  id: string;
  /** Human-readable name */
  name: string;
  /** Strategy description */
  description: string;
  /** Strategy version */
  version: string;
  /** Strategy author */
  author: string;
  /** Trading pairs this strategy supports */
  supportedPairs: string[];
  /** Strategy category */
  category:
    | "dca"
    | "grid"
    | "arbitrage"
    | "momentum"
    | "mean_reversion"
    | "ml"
    | "custom"
    | "stress_test";
  /** Risk level (1-10) */
  riskLevel: number;
  /** Minimum capital required */
  minCapital: number;
  /** Strategy parameters schema */
  parametersSchema: Record<string, ParameterSchema>;
}

export interface ParameterSchema {
  type: "number" | "string" | "boolean" | "select" | "range";
  default: unknown;
  min?: number;
  max?: number;
  options?: string[];
  description: string;
  validation?: (value: unknown) => boolean | string;
}

export interface StrategyParameters {
  [key: string]: unknown;
}

export interface StrategyContext {
  /** Current portfolio state */
  portfolio: SdkPortfolio;
  /** Current positions */
  positions: Map<string, Position>;
  /** Market data for subscribed pairs */
  marketData: Map<string, MarketData>;
  /** Strategy parameters */
  parameters: StrategyParameters;
  /** Strategy state storage */
  state: Map<string, unknown>;
  /** Performance metrics */
  metrics: StrategyMetrics;
  /** Utility functions */
  utils: StrategyUtils;
}

export interface StrategyMetrics {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  avgHoldingPeriod: number;
  profitFactor: number;
  lastUpdate: number;
}

export interface StrategyUtils {
  /** Technical indicators */
  indicators: {
    sma(data: number[], period: number): number;
    ema(data: number[], period: number): number;
    rsi(data: number[], period: number): number;
    macd(
      data: number[],
      fast: number,
      slow: number,
      signal: number,
    ): { macd: number; signal: number; histogram: number };
    bollingerBands(
      data: number[],
      period: number,
      stdDev: number,
    ): { upper: number; middle: number; lower: number };
    stochastic(
      high: number[],
      low: number[],
      close: number[],
      period: number,
    ): { k: number; d: number };
  };
  /** Math utilities */
  math: {
    mean(data: number[]): number;
    std(data: number[]): number;
    correlation(x: number[], y: number[]): number;
    percentile(data: number[], p: number): number;
  };
  /** Time utilities */
  time: {
    getCurrentTimestamp(): number;
    formatTime(timestamp: number): string;
    getMarketHours(): { isOpen: boolean; nextOpen: number; nextClose: number };
  };
  /** Logging */
  log: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    debug(message: string, data?: unknown): void;
  };
}

export interface StrategySignal {
  action: "buy" | "sell" | "hold" | "close_position" | "reduce_position";
  pair: string;
  quantity?: number;
  price?: number;
  orderType?: "market" | "limit" | "stop" | "stop_limit";
  confidence: number; // 0-1
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface StrategyResult {
  signals: StrategySignal[];
  shouldContinue: boolean;
  nextExecutionTime?: number;
  errors?: string[];
  warnings?: string[];
  state?: Record<string, unknown>;
}

/**
 * Main Strategy Interface
 *
 * All strategies must implement this interface to be compatible with the SDK
 */
export interface IStrategy {
  /** Strategy configuration */
  readonly config: StrategyConfig;

  /**
   * Initialize the strategy
   * Called once when the strategy is first loaded
   */
  initialize(context: StrategyContext): Promise<void>;

  /**
   * Main strategy execution logic
   * Called on each market data update or at scheduled intervals
   */
  execute(context: StrategyContext): Promise<StrategyResult>;

  /**
   * Validate strategy parameters
   * Called before strategy initialization and parameter updates
   */
  validateParameters(parameters: StrategyParameters): Promise<string[]>;

  /**
   * Update strategy parameters
   * Called when user modifies strategy parameters during runtime
   */
  updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void>;

  /**
   * Handle market events (price changes, orderbook updates, trades)
   * Optional: implement if strategy needs real-time market event handling
   */
  onMarketEvent?(event: MarketEvent, context: StrategyContext): Promise<void>;

  /**
   * Handle order events (fills, cancellations, rejections)
   * Optional: implement if strategy needs order state management
   */
  onOrderEvent?(event: OrderEvent, context: StrategyContext): Promise<void>;

  /**
   * Handle risk events (limit breaches, margin calls)
   * Optional: implement if strategy needs custom risk handling
   */
  onRiskEvent?(event: RiskEvent, context: StrategyContext): Promise<void>;

  /**
   * Handle AI helper decisions about strategy continuation
   * Optional: implement if strategy needs to react to AI gating decisions
   */
  onAiDecision?(
    decision: AiStrategyDecision,
    context: StrategyContext,
  ): Promise<void>;

  /**
   * Cleanup when strategy is stopped or removed
   * Called when strategy is paused, stopped, or removed
   */
  cleanup(context: StrategyContext): Promise<void>;

  /**
   * Generate strategy-specific performance report
   * Optional: implement for custom performance metrics
   */
  generateReport?(context: StrategyContext): Promise<StrategyReport>;

  /**
   * Optimize strategy parameters
   * Optional: implement for custom parameter optimization
   */
  optimize?(
    objectiveFunction: string,
    context: StrategyContext,
  ): Promise<OptimizationResult>;
}

export interface MarketEvent {
  type: "price_change" | "orderbook_update" | "trade" | "volume_spike";
  pair: string;
  data: unknown;
  timestamp: number;
}

export interface OrderEvent {
  type: "filled" | "partially_filled" | "cancelled" | "rejected";
  orderId: string;
  // Order can be SDK OrderResult (low-level) or bot-level BotOrder (rich fields)
  order: OrderResult | BotOrder;
  timestamp: number;
}

export interface RiskEvent {
  type: "position_limit" | "loss_limit" | "drawdown_limit" | "exposure_limit";
  severity: "warning" | "critical";
  message: string;
  data: unknown;
  timestamp: number;
}

export interface StrategyReport {
  summary: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
  };
  trades: Array<{
    timestamp: number;
    pair: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    pnl: number;
  }>;
  customMetrics?: Record<string, unknown>;
  charts?: Array<{
    title: string;
    type: "line" | "bar" | "scatter";
    data: unknown[];
  }>;
}

export interface OptimizationResult {
  bestParameters: StrategyParameters;
  bestScore: number;
  allResults: Array<{
    parameters: StrategyParameters;
    score: number;
    metrics: StrategyMetrics;
  }>;
}

/**
 * Strategy Factory Interface
 *
 * Used for creating strategy instances with dependency injection
 */
export interface IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy;
}
