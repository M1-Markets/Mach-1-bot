import type { Interval, Mach1SDK } from "../sdk";
import { DEFAULT_ENVIRONMENT, type MonacoEnvironment } from "./constants";
import {
  MonacoSDKAdapter,
  type MonacoSDKAdapterConfig,
} from "./monaco-sdk-adapter";
import { createLogger } from "./runtime-utils";
import {
  type TradingPairResolver,
  tradingPairResolver,
} from "./trading-pair-resolver";

const logger = createLogger("MonacoCoreSDK");

export type MonacoChainNetwork = "mainnet" | "testnet";
export type MonacoAddress = `0x${string}`;

export interface MonacoCoreOrderRequest {
  baseToken: MonacoAddress;
  quoteToken: MonacoAddress;
  isBuy: boolean;
  orderType?: "market" | "limit";
  price: bigint;
  quantity: bigint;
  pitpassCode?: string;
}

export interface MonacoCoreOrderResult {
  orderId: string;
  status: "pending" | "filled" | "cancelled" | "rejected";
  filledQuantity: bigint;
  remainingQuantity: bigint;
  price?: number;
  size?: number;
}

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user?: unknown;
}

export interface MonacoCoreSDKConfig {
  network: MonacoChainNetwork;
  privateKey: string;
  mode?: "backtest" | "simulation" | "live";
  environment?: MonacoEnvironment;
  rpcUrl?: string;
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

export class MonacoCoreSDK {
  private readonly adapter: MonacoSDKAdapter;
  private readonly config: MonacoCoreSDKConfig;
  private initialized = false;

  constructor(config: MonacoCoreSDKConfig) {
    this.config = config;

    const adapterConfig: MonacoSDKAdapterConfig = {
      network: config.network,
      privateKey: config.privateKey,
      environment: config.environment,
      skipAuth: config.mode === "simulation",
      rpcUrl: config.rpcUrl,
    };

    this.adapter = new MonacoSDKAdapter(adapterConfig);

    logger.debug("Monaco Core SDK created", {
      network: config.network,
      mode: config.mode || "live",
      environment: config.environment || DEFAULT_ENVIRONMENT,
      authEnabled: config.mode !== "simulation",
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn("SDK already initialized");
      return;
    }

    await this.adapter.initialize();
    this.initialized = true;
  }

  async placeOrder(
    request: MonacoCoreOrderRequest,
  ): Promise<MonacoCoreOrderResult> {
    this.ensureInitialized();
    return this.adapter.adaptOrderRequest(request);
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.ensureInitialized();
    await this.adapter.cancelOrder(orderId);
  }

  getSDK(): Mach1SDK {
    this.ensureInitialized();
    return this.adapter.getSDK();
  }

  getAuthState(): AuthState | undefined {
    return this.adapter.getAuthState();
  }

  isAuthenticated(): boolean {
    return this.adapter.isAuthenticated();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isPaused(): boolean {
    return this.adapter.isPaused();
  }

  pauseTrading(): void {
    this.adapter.pauseTrading();
  }

  async refreshAuthToken(): Promise<void> {
    await this.adapter.refreshAuthToken();
  }

  resumeTrading(): void {
    this.adapter.resumeTrading();
  }

  onTradingPaused(callback: () => void): void {
    this.adapter.onTradingPaused = callback;
  }

  getRateLimitStatus() {
    return this.adapter.getRateLimitStatus();
  }

  getTradingPairResolver(): TradingPairResolver {
    return tradingPairResolver;
  }

  async shutdown(): Promise<void> {
    await this.adapter.shutdown();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("Monaco SDK not initialized. Call initialize() first.");
    }
  }
}

export class TradingAPI {
  constructor(private readonly sdk: MonacoCoreSDK) {}

  async placeLimitOrder(
    request: MonacoCoreOrderRequest,
  ): Promise<MonacoCoreOrderResult> {
    return this.sdk.placeOrder(request);
  }

  async placeMarketOrder(
    request: MonacoCoreOrderRequest,
  ): Promise<MonacoCoreOrderResult> {
    return this.sdk.placeOrder(request);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.sdk.cancelOrder(orderId);
  }
}

export class MarketAPI {
  constructor(private readonly sdk: MonacoCoreSDK) {}

  async getTradingPairs() {
    return this.sdk.getSDK().market.getPaginatedTradingPairs();
  }

  async getCandlesticks(
    symbol: string,
    interval: Interval,
    startTime: number,
    endTime: number,
  ) {
    const pairId = tradingPairResolver.resolveSymbolToId(symbol);
    const pair = tradingPairResolver.getPairById(pairId);

    if (!pair) {
      throw new Error(`Trading pair not found: ${symbol}`);
    }

    return this.sdk
      .getSDK()
      .market.getCandlesticks(pair.id, interval, { startTime, endTime });
  }
}

export class AccountAPI {
  constructor(private readonly sdk: MonacoCoreSDK) {}

  getAddress(): string {
    return this.sdk.getSDK().getAccountAddress();
  }
}

export class EventsAPI {
  constructor(private readonly sdk: MonacoCoreSDK) {
    void this.sdk;
  }

  subscribeToOrders(_callback: (event: unknown) => void) {
    return () => undefined;
  }
}

export class UtilsAPI {
  constructor(private readonly sdk: MonacoCoreSDK) {
    void this.sdk;
  }

  formatPrice(price: bigint, decimals?: number): string {
    return (Number(price) / Math.pow(10, decimals || 6)).toFixed(decimals || 6);
  }

  formatQuantity(quantity: bigint, decimals?: number): string {
    return (Number(quantity) / Math.pow(10, decimals || 18)).toFixed(8);
  }
}
