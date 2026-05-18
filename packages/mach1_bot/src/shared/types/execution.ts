/**
 * Execution engine type definitions
 */

import type { Interval } from "mach1_sdk";
import type { ChainNetwork, MonacoEnvironment, TradingPair } from "./common";

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
