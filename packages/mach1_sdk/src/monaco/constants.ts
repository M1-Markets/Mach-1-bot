import { EMBEDDED_KEY_MATERIAL } from "../internal/embedded-key-material";

export type MonacoEnvironment =
  | "mainnet"
  | "staging"
  | "development"
  | "local";

export const DEFAULT_ENVIRONMENT: MonacoEnvironment = "staging";

export const MONACO_API_URLS: Record<MonacoEnvironment, string> = {
  mainnet: "https://api.monaco.xyz",
  development: "https://develop.apimonaco.xyz",
  staging: "https://staging.apimonaco.xyz",
  local: "http://localhost:8080",
};

export const OrderStatus = {
  PENDING: "PENDING" as const,
  SUBMITTED: "SUBMITTED" as const,
  PARTIALLY_FILLED: "PARTIALLY_FILLED" as const,
  FILLED: "FILLED" as const,
  SETTLED_ON_CHAIN: "SETTLED_ON_CHAIN" as const,
  SETTLED: "SETTLED" as const,
  CANCELLED: "CANCELLED" as const,
  REJECTED: "REJECTED" as const,
  EXPIRED: "EXPIRED" as const,
} as const;

export const OrderType = {
  LIMIT: "LIMIT" as const,
  MARKET: "MARKET" as const,
  STOP_LOSS: "STOP_LOSS" as const,
  TAKE_PROFIT: "TAKE_PROFIT" as const,
  STOP_LIMIT: "STOP_LIMIT" as const,
  TRAILING_STOP: "TRAILING_STOP" as const,
} as const;

export const OrderSide = {
  BUY: "BUY" as const,
  SELL: "SELL" as const,
} as const;

export const WEBSOCKET_CONFIG = {
  reconnect: true,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  reconnectAttempts: 10,
  autoConnect: true,
  reconnectDelayMs: 1000,
  maxReconnectDelayMs: 30000,
};

export const DEFAULT_RATE_LIMIT = {
  maxRequestsPerSecond: 10,
  burstCapacity: 20,
  backoffBaseMs: 100,
  backoffMaxMs: 30000,
};

export const TOKEN_REFRESH_CONFIG = {
  maxRetries: 3,
  retryDelayMs: 2000,
  bufferMs: 5 * 60 * 1000,
};

export const TRADING_PAIR_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_MAINNET_RPC_URL = "https://evm-rpc.sei-apis.com";
const DEFAULT_TESTNET_RPC_URL = "https://evm-rpc-testnet.sei-apis.com";

export const NETWORK_RPC_URLS = {
  mainnet: process.env.MONACO_RPC_MAINNET || DEFAULT_MAINNET_RPC_URL,
  testnet: process.env.MONACO_RPC_TESTNET || DEFAULT_TESTNET_RPC_URL,
} as const;

export const MONACO_CLIENT_IDS: Record<MonacoEnvironment, string> = {
  mainnet: EMBEDDED_KEY_MATERIAL,
  development: EMBEDDED_KEY_MATERIAL,
  staging: EMBEDDED_KEY_MATERIAL,
  local: EMBEDDED_KEY_MATERIAL,
};

export function getMonacoConfig(
  environment: MonacoEnvironment = DEFAULT_ENVIRONMENT,
): { clientId: string; environment: MonacoEnvironment } {
  return {
    clientId: MONACO_CLIENT_IDS[environment] || EMBEDDED_KEY_MATERIAL,
    environment,
  };
}

export function getClientId(
  environment: MonacoEnvironment = DEFAULT_ENVIRONMENT,
): string {
  return getMonacoConfig(environment).clientId;
}

export function resolveMonacoApiUrl(network: MonacoEnvironment | string): string {
  if (network in MONACO_API_URLS) {
    return MONACO_API_URLS[network as MonacoEnvironment];
  }

  return network;
}