/**
 * Trading-related type definitions
 */

import {
  Address,
  EventCallback,
  TradingPair,
  UnsubscribeFunction,
} from "./common";

export interface PositionData {
  token: Address;
  symbol: string;
  balance: bigint;
  value: bigint;
  averagePrice: bigint;
  unrealizedPnL: bigint;
  realizedPnL: bigint;
  totalFees: bigint;
  lastUpdated: number;
}

export interface TradeRecord {
  orderId: string;
  pair: TradingPair;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
  fees: bigint;
  timestamp: number;
  blockNumber?: number;
  transactionHash?: string;
}

export interface OrderBookStream {
  subscribe(callback: EventCallback<unknown>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface TradeStream {
  subscribe(callback: EventCallback<unknown>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface PriceStream {
  subscribe(
    callback: (data: {
      pair: TradingPair;
      price: bigint;
      timestamp: number;
    }) => void,
  ): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface UserOrderStream {
  subscribe(callback: EventCallback<unknown>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface UserTradeStream {
  subscribe(callback: EventCallback<unknown>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface RiskLimits {
  maxPositionSize: bigint;
  maxDailyLoss: bigint;
  positionLimitPercent: number;
  stopLossPercent: number;
  maxLeverage: number;
  maxCorrelation: number;
  maxDrawdown: number;
  maxOrderValue: bigint;
}

export interface RiskCheckResult {
  approved: boolean;
  warnings: string[];
  rejectionReasons: string[];
  riskScore: number;
}

export interface RiskBreach {
  type:
    | "position_limit"
    | "daily_loss"
    | "max_drawdown"
    | "correlation"
    | "leverage";
  severity: "warning" | "critical";
  message: string;
  currentValue: number;
  limitValue: number;
  timestamp: number;
}
