/**
 * Analytics and performance tracking type definitions
 */

export interface PerformanceMetrics {
  totalReturn: number;
  annualReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  totalTrades: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

export interface DrawdownPeriod {
  start: Date;
  end: Date;
  duration: number;
  depth: number;
  recovery: Date | null;
}

export interface TradeAnalysis {
  winningTrades: CompletedTrade[];
  losingTrades: CompletedTrade[];
  breakEvenTrades: CompletedTrade[];
  holdingPeriods: number[];
  profitDistribution: Array<{ range: string; count: number }>;
}

export interface CompletedTrade {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  timestamp: number;
  pnl: number;
}

// Type aliases for backward compatibility
export type { CompletedTrade as BotCompletedTrade };
