import type { MarketData, SdkPortfolio } from "./sdk";

export type AIProvider = "gemini" | "chatgpt" | "claude";

export type AiStrategyDecisionAction = "continue" | "pause" | "stop";

export interface AiStrategyDecision {
  action: AiStrategyDecisionAction;
  shouldContinue: boolean;
  confidence: number;
  reason: string;
  recommendations?: string[];
  rawResponse?: string;
}

export interface AiStrategySnapshot {
  marketData: MarketData;
  portfolio?: SdkPortfolio;
  metrics?: {
    totalReturn?: number;
    sharpeRatio?: number;
    maxDrawdown?: number;
    winRate?: number;
    totalTrades?: number;
    profitFactor?: number;
  };
  parameters?: Record<string, unknown>;
  lastSignals?: Array<{
    action: string;
    pair: string;
    confidence?: number;
    reason?: string;
  }>;
  state?: Record<string, unknown>;
}

export type AiOrderDecisionAction = "approve" | "reject" | "pause";

export interface AiOrderDecision {
  action: AiOrderDecisionAction;
  confidence: number;
  reason: string;
  recommendations?: string[];
  rawResponse?: string;
}

export interface AiOrderSnapshot extends AiStrategySnapshot {
  signal: {
    action: "buy" | "sell" | "hold" | "close_position" | "reduce_position";
    pair: string;
    quantity?: number;
    price?: number;
    orderType?: "market" | "limit" | "stop" | "stop_limit";
    confidence?: number;
    reason?: string;
    metadata?: Record<string, unknown>;
  };
}
