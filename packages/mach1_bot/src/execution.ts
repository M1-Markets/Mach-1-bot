/**
 * @mach-one-sdk/execution
 * Trading execution engines for backtest, paper trading, and live trading
 */

import { BacktestEngine } from "./domains/execution/backtest-engine";
import { LiveTradingEngine } from "./domains/execution/live-trading-engine";
import { PaperTradingEngine } from "./domains/execution/paper-trading-engine";
import type { MarketManager } from "./domains/trading/market-manager";
import type { RealtimeManager } from "./domains/trading/realtime-manager";
import type {
  BacktestConfig,
  LiveTradingConfig,
  PaperTradingConfig,
} from "./shared/types";

// Factory functions with descriptive names
export function createBacktestEngine(config: BacktestConfig): BacktestEngine {
  return new BacktestEngine(config);
}

export function createPaperTradingEngine(
  config: PaperTradingConfig,
  marketManager: MarketManager,
  realtimeManager: RealtimeManager,
): PaperTradingEngine {
  return new PaperTradingEngine(config, marketManager, realtimeManager);
}

export function createLiveTradingEngine(
  config: LiveTradingConfig,
  marketManager: MarketManager,
  realtimeManager: RealtimeManager,
): LiveTradingEngine {
  return new LiveTradingEngine(config, marketManager, realtimeManager);
}

// Re-export types
export type {
  BacktestConfig,
  BacktestResult,
  MarketState,
  OrderBookSnapshot,
  TradeData,
} from "./shared/types";
// Re-export classes for advanced usage
export { BacktestEngine, LiveTradingEngine, PaperTradingEngine };
