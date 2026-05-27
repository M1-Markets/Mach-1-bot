/**
 * Internal Event Types
 *
 * These are internal types for the SDK that wrap or extend Monaco Protocol types.
 * They are not part of the official Monaco SDK but are used internally for consistency.
 */

import { OrderStatus as MonacoOrderStatus } from "mach1_sdk";
import type { Order } from "mach1_sdk";
import type { Address } from "./common";

export type InternalOrderStatus =
  (typeof MonacoOrderStatus)[keyof typeof MonacoOrderStatus];
export type InternalOrderType =
  | "LIMIT"
  | "MARKET"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "STOP_LIMIT"
  | "TRAILING_STOP"
  | "POST_ONLY"
  | "IOC"
  | "FOK";

/**
 * Internal order structure using bigint for precision
 * This differs from Monaco's Order type which uses strings
 */
export interface InternalOrder {
  id: string;
  trader: Address;
  baseToken: Address;
  quoteToken: Address;
  price: bigint;
  quantity: bigint;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  orderType: InternalOrderType;
  status: InternalOrderStatus;
  isBuy: boolean;
  timestamp: number;
  blockNumber?: number;
  transactionHash?: string;
}

/**
 * Internal order book structure using bigint
 */
export interface InternalOrderBook {
  baseToken: Address;
  quoteToken: Address;
  bids: Array<{ price: bigint; quantity: bigint }>;
  asks: Array<{ price: bigint; quantity: bigint }>;
  lastUpdate: number;
}

/**
 * Internal trade structure using bigint
 */
export interface InternalTrade {
  id: string;
  baseToken: Address;
  quoteToken: Address;
  price: bigint;
  quantity: bigint;
  isBuy: boolean;
  maker: Address;
  taker: Address;
  timestamp: number;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Best prices structure
 */
export interface BestPrices {
  baseToken: Address;
  quoteToken: Address;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  spread: bigint | null;
}

/**
 * Order book update event
 */
export interface OrderBookEvent {
  type: "order_book_update";
  baseToken: Address;
  quoteToken: Address;
  orderBook: InternalOrderBook;
}

/**
 * Trade event
 */
export interface TradeEvent {
  type: "trade";
  baseToken: Address;
  quoteToken: Address;
  trade: InternalTrade;
}

/**
 * Order update event (from API)
 */
export interface OrderEvent {
  type: "order_update";
  order: Order;
  previousStatus?: InternalOrderStatus;
  newStatus?: InternalOrderStatus;
}

/**
 * Internal order update event (using internal order structure)
 */
export interface InternalOrderEvent {
  type: "order_update";
  order: InternalOrder;
  previousStatus?: InternalOrderStatus;
  newStatus?: InternalOrderStatus;
}

/**
 * OHLCV event (wrapper for candlestick updates)
 */
export interface OHLCVEvent {
  type: "ohlcv";
  symbol: string;
  interval: string;
  candlestick: {
    timestamp: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  };
}
