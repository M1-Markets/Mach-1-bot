/**
 * Execution engine type definitions
 */

import type { Interval } from "mach1_sdk";
import type {
  Address,
  ChainNetwork,
  MonacoEnvironment,
  NormalizedOrderStatus,
  OrderRequest,
  OrderResult,
  Position,
  TradingPair,
} from "./common";
import type { IsolatedPerpsConfig, LiveTradingMarketMode } from "./config";

export type ExecutionOrderStatus = NormalizedOrderStatus;

export interface ExecutionTrade {
  timestamp: number;
  pair: TradingPair;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
}

export interface ExecutionOrderStatusResult extends OrderResult {
  status: ExecutionOrderStatus;
  [key: string]: unknown;
}

export interface CancellationResult extends ExecutionOrderStatusResult {
  cancellationApplied: boolean;
  reason?: string;
}

export interface ExecutionOrderRecord extends ExecutionOrderStatusResult {
  order: OrderRequest;
  timestamp: number;
}

export type OrderLifecycleStatus =
  | "submitted"
  | "accepted"
  | NormalizedOrderStatus;

export type OrderLifecycleEventType =
  | "submitted"
  | "accepted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface OrderLifecycleRecord {
  localId: string;
  engineOrderId?: string;
  exchangeOrderId?: string;
  strategyId?: string;
  pair: TradingPair;
  side: "buy" | "sell";
  direction?: OrderRequest["direction"];
  type: "market" | "limit";
  requestedPrice: bigint;
  requestedQuantity: bigint;
  leverage?: number;
  reduceOnly?: boolean;
  closeOnly?: boolean;
  filledQuantity: bigint;
  remainingQuantity: bigint;
  averageFillPrice?: bigint;
  fees: bigint;
  feeCurrency?: Address;
  slippage: bigint;
  status: OrderLifecycleStatus;
  submittedAt: number;
  acceptedAt?: number;
  filledAt?: number;
  rejectedAt?: number;
  cancelledAt?: number;
  updatedAt: number;
  rejectedReason?: string;
  cancelledReason?: string;
}

export interface OrderLifecycleEvent {
  type: OrderLifecycleEventType;
  previousStatus?: OrderLifecycleStatus;
  order: OrderLifecycleRecord;
  timestamp: number;
}

export interface ExecutionEngine {
  initialize?(): Promise<void>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<CancellationResult>;
  getOrderStatus(orderId: string): Promise<ExecutionOrderStatusResult>;
  getPosition(pair: TradingPair): Promise<Position>;
  getBalance(token: Address): Promise<bigint>;
  getExecutedTrades(): ExecutionTrade[];
  getOrderHistory(): Map<string, ExecutionOrderRecord>;
}

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: bigint;
  commission: number;
  slippage: number;
  /** Directory containing CSV data files. Defaults to `<cwd>/backtest-data`. */
  dataDirectory?: string;
  /** Restrict backtest to these trading pairs. Defaults to all discovered pairs. */
  tradingPairs?: string[];
  /** Seed for deterministic RNG during backtest. */
  seed?: number;
  /** Override starting token balances (token address → raw amount). */
  startingBalances?: Record<string, bigint>;
}

export interface TradeData {
  tradeId: number;
  price: number;
  quantity: number;
  volume: number;
  timestamp: number;
  isBuyerMaker: boolean;
  bestMatch: boolean;
  tradingPair?: string;
  sourceFile?: string;
}

export interface DataFileInfo {
  filePath: string;
  tradingPair: string;
  date: Date;
  directory: string;
  fileSize: number;
}

export interface OrderBookSnapshot {
  timestamp: number;
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
  midPrice: number;
  spread: number;
}

export interface MarketState {
  currentPrice: number;
  volume24h: number;
  volatility: number;
  liquidity: number;
  orderbook: OrderBookSnapshot;
}

export interface BacktestResult {
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
  trades: Array<{
    timestamp: number;
    pair: TradingPair;
    side: "buy" | "sell";
    price: bigint;
    quantity: bigint;
    pnl: bigint;
  }>;
}

export interface PaperTradingConfig {
  initialCapital: bigint;
  commission: number;
  slippage: number;
  latencyMs: number;
  /** Seed for deterministic RNG during paper trading. */
  seed?: number;
  /** Override starting token balances (token address → raw amount). */
  startingBalances?: Record<string, bigint>;
}

export interface LiveTradingConfig {
  privateKey: string;
  network: ChainNetwork;
  environment?: MonacoEnvironment;
  rpcUrl?: string;
  marketMode?: LiveTradingMarketMode;
  perps?: IsolatedPerpsConfig;
  maxSlippage: number;
  confirmations?: number;
  maxRetries?: number;
  retryDelay?: number;
  tradingPairs?: string[];
  ohlcvInterval?: Interval;
  pitPassCode?: string;
  gasPrice?: string;
  onTradingPaused?: () => void;
}
