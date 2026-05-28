/**
 * High-level bot API type definitions
 */

import type { ChainNetwork, MonacoEnvironment } from "./common";
import type { IsolatedPerpsConfig, LiveTradingMarketMode } from "./config";

export type { CompletedTrade } from "./analytics";
// Re-export for backward compatibility
export type { Address } from "./common";

export interface BotConfig {
  // Required fields
  privateKey: string;
  rpcUrl: string;

  // Execution mode
  mode?: "backtest" | "simulation" | "live";
  marketMode?: LiveTradingMarketMode;
  perps?: IsolatedPerpsConfig;

  // Monaco Protocol settings
  network?: ChainNetwork;
  environment?: MonacoEnvironment;
  clientId?: string;
  skipAuthentication?: boolean;

  // Trading limits
  maxPositionSize?: number;
  maxDailyLoss?: number;

  // Risk settings
  defaultSlippage?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;

  // Rate limiting configuration
  rateLimitConfig?: Partial<RateLimitConfig>;

  // WebSocket configuration
  websocketConfig?: Partial<WebSocketConfig>;

  // Callbacks
  onTradingPaused?: () => void;

  // Optional settings
  chainId?: number;
  logLevel?:
    | "DEBUG"
    | "INFO"
    | "WARN"
    | "ERROR"
    | "debug"
    | "info"
    | "warn"
    | "error"
    | "none";

  // Enhanced features
  enableEnhancedFeatures?: boolean;

  // AI Helper configuration
  aiHelper?: {
    enabled: boolean;
    provider: "gemini" | "chatgpt" | "claude";
    apiKey: string;
    prompt?: string;
  };
}

export interface TradeOptions {
  amountUsd?: number;
  amountPercent?: number;
  amount?: number;
  slippage?: number;
  orderType?: "market" | "limit";
}

export interface DCAOptions {
  amountUsd: number;
  frequency: "hourly" | "daily" | "weekly";
  duration?: string;
}

export interface GridOptions {
  lower: number;
  upper: number;
  grids: number;
  totalAmount: number;
  mode?: "neutral" | "long" | "short";
}

export interface StopLossOptions {
  stopPrice: number;
  limitPrice?: number;
}

export interface TakeProfitOptions {
  targetPrice: number;
  amountPercent: number;
}

export interface TrailingStopOptions {
  trailDistance: number;
  side: "buy" | "sell";
}

export interface BacktestOptions {
  start: string;
  end: string;
  initialCapital?: number;
  strategyExecutionIntervalMs?: number;
}

export interface SimulationOptions {
  duration: string;
  initialCapital?: number;
}

export interface LiveOptions {
  confirmations?: number;
  gasPrice?: string;
  strategyExecutionIntervalMs?: number;
  marketMode?: LiveTradingMarketMode;
  perps?: IsolatedPerpsConfig;
}

export interface MarketData {
  [symbol: string]: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
    orderBookDepth?: {
      bids: number;
      asks: number;
    };
    warnings?: string[];
    rsi: number;
    macdSignal: number;
    timestamp: number;
  };
}

export interface Trade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  timestamp: number;
}

export interface OrderBook {
  symbol: string;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  spread: number;
}

export interface Portfolio {
  totalValue: number;
  dailyPnl: number;
  dailyReturn: number;
  sharpeRatio: number;
  positions: Record<
    string,
    {
      symbol: string;
      balance: number;
      value: number;
      unrealizedPnl: number;
    }
  >;
}

export interface BacktestResults {
  totalReturn: number;
  annualReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  plotEquityCurve(): Promise<void>;
  plotDrawdown(): Promise<void>;
  exportTrades(filename: string): Promise<void>;
  getEquityCurveData(): Array<{ timestamp: number; equity: number }>;
  getDrawdownData(): Array<{ timestamp: number; drawdown: number }>;
}

export interface RiskLimits {
  maxDailyLoss?: number;
  maxPositionSize?: number;
  maxPortfolioRisk?: number;
  correlationLimit?: number;
  positionLimitPercent?: number;
  stopLossPercent?: number;
  maxLeverage?: number;
  maxCorrelation?: number;
  maxDrawdown?: number;
  maxOrderValue?: number;
}

export interface RebalanceResult {
  executed: boolean;
  trades: Array<{
    symbol: string;
    side: "buy" | "sell";
    amount: number;
  }>;
  newAllocation: Record<string, number>;
}

export interface BotOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  direction?: "long" | "short";
  type: string;
  price: number;
  size: number;
  status: string;
  leverage?: number;
  reduceOnly?: boolean;
  closeOnly?: boolean;
}

export interface DCAStrategy {
  id: string;
  symbol: string;
  totalAmount: number;
  executedAmount: number;
  remainingAmount: number;
  averagePrice: number;
  status: "active" | "completed" | "cancelled";
}

export interface GridStrategy {
  id: string;
  symbol: string;
  lowerBound: number;
  upperBound: number;
  gridCount: number;
  totalProfit: number;
  status: "active" | "paused" | "stopped";
}

// Rate limiting configuration
export interface RateLimitConfig {
  maxRequestsPerSecond: number;
  burstCapacity: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

// WebSocket configuration
export interface WebSocketConfig {
  autoConnect: boolean;
  reconnectAttempts: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
}
