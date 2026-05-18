/**
 * @mach-one-sdk/trading
 * Core trading infrastructure
 */

import type { Mach1SDK } from "mach1_sdk";
import { MarketManager } from "./domains/trading/market-manager";
import { OrderManager } from "./domains/trading/order-manager";
import { PositionTracker } from "./domains/trading/position-tracker";
import { RealtimeManager } from "./domains/trading/realtime-manager";
import { RiskManager } from "./domains/trading/risk-manager";

// Factory functions with descriptive names
export function createMarketManager(): MarketManager {
  return new MarketManager();
}

export function createOrderManager(marketManager: MarketManager): OrderManager {
  return new OrderManager(marketManager);
}

export function createPositionTracker(
  marketManager: MarketManager,
  orderManager: OrderManager,
): PositionTracker {
  return new PositionTracker(marketManager, orderManager);
}

export function createRealtimeManager(
  marketManager: MarketManager,
  orderManager: OrderManager,
  sdk?: Mach1SDK,
): RealtimeManager {
  return new RealtimeManager(marketManager, orderManager, sdk);
}

export function createRiskManager(
  positionTracker: PositionTracker,
  marketManager: MarketManager,
  orderManager: OrderManager,
): RiskManager {
  return new RiskManager(positionTracker, marketManager, orderManager);
}

// Re-export types
export type {
  OrderRequest,
  OrderResult,
  PositionData,
  RiskBreach,
  RiskCheckResult,
  RiskLimits,
  TradeRecord,
  TradingPair,
} from "./shared/types";
// Re-export classes for advanced usage
export {
  MarketManager,
  OrderManager,
  PositionTracker,
  RealtimeManager,
  RiskManager,
};
