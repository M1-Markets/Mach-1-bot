/**
 * @mach-one-sdk/bot
 * High-level bot API for algorithmic trading
 */

import { Mach1Bot } from "./domains/bot/mach1-bot";
import type { BotConfig } from "./shared/types/bot";

// Main bot creation function with descriptive name
export function createMach1Bot(config: BotConfig): Mach1Bot {
  return new Mach1Bot(config);
}

// Re-export types
export type {
  BacktestOptions,
  BacktestResults,
  BotConfig,
  DCAOptions,
  GridOptions,
  LiveOptions,
  MarketData,
  Portfolio,
  SimulationOptions,
  TradeOptions,
} from "./shared/types/bot";
// Re-export the class for advanced usage
export { Mach1Bot };
