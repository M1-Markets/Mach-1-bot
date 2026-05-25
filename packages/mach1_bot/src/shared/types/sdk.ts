/**
 * SDK-only neutral types and contracts.
 * These are intended for SDK consumers and do NOT include bot-specific
 * runtime fields or aliases. Keep shapes stable and numeric-friendly for
 * UI/analytics layers.
 */

export interface MarketTick {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  orderBookDepth?: { bids: number; asks: number };
  warnings?: string[];
  rsi: number;
  macdSignal: number;
  timestamp: number;
}

export interface MarketData {
  [symbol: string]: MarketTick;
}

export interface SdkPortfolioPosition {
  symbol: string;
  balance: number;
  value: number;
  unrealizedPnl: number;
}

export interface SdkPortfolio {
  totalValue: number;
  dailyPnl: number;
  dailyReturn: number;
  sharpeRatio: number;
  positions: Record<string, SdkPortfolioPosition>;
}
