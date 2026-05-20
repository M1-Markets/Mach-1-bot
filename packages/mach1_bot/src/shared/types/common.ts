/**
 * Common types shared across the SDK
 */

export type Address = `0x${string}`;
export type ChainNetwork = "sei-mainnet" | "sei-testnet";
export type MonacoEnvironment = "mainnet" | "staging" | "development" | "local";

// Event system types
export type EventCallback<T> = (event: T) => void | Promise<void>;
export type UnsubscribeFunction = () => void;

export interface TradingPair {
  base: Address;
  quote: Address;
  symbol: string;
}

export interface OrderRequest {
  baseToken: Address;
  quoteToken: Address;
  isBuy: boolean;
  /**
   * Optional order type hint. When set to "market", downstream adapters will
   * route to market-order placement even if a price is provided for sizing
   * or risk calculations.
   */
  orderType?: "market" | "limit";
  price: bigint;
  quantity: bigint;
  pitpassCode?: string;
}

export interface OrderResult {
  orderId: string;
  status: "pending" | "filled" | "cancelled" | "rejected";
  filledQuantity: bigint;
  remainingQuantity: bigint;
  // Optional convenience fields for higher-level code (e.g., bot wrappers)
  price?: number;
  size?: number;
}

export interface Position {
  token: Address;
  balance: bigint;
  value: bigint;
  unrealizedPnL: bigint;
}

export interface Portfolio {
  positions: Map<Address, Position>;
  totalValue: bigint;
  unrealizedPnL: bigint;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
