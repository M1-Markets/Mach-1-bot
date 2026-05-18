/**
 * Strategy system type definitions
 */

export interface StrategyConfig {
  name: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
}

export interface StrategyResult {
  success: boolean;
  signals?: Array<{
    action: "buy" | "sell" | "hold";
    symbol: string;
    confidence: number;
  }>;
  errors?: string[];
}

export interface StrategyMetrics {
  totalSignals: number;
  successfulTrades: number;
  failedTrades: number;
  averageReturn: number;
  sharpeRatio: number;
}
