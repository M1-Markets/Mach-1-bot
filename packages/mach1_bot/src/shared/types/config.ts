/**
 * Configuration type definitions
 */

import { type Address, type MonacoEnvironment } from "./common";

// Re-export Address
export type { Address } from "./common";

// Core SDK Configuration
export interface SDKConfig {
  // Required - Network configuration
  rpcUrl: string;

  // Required - Authentication
  privateKey?: string;

  // Required - Trading mode
  mode?: "backtest" | "paper" | "live";

  // Optional - Network settings
  chainId?: number;

  // Optional - Feature flags
  enableWebsockets?: boolean;
  enableCaching?: boolean;

  // Optional - Performance settings
  maxRetries?: number;
  timeoutMs?: number;

  // Optional - Logging
  logLevel?: "debug" | "info" | "warn" | "error" | "none";
}

export interface ContractAddresses {
  clob: Address;
  book: Address;
  state: Address;
  vault: Address;
  dexAdapter?: Address;
}

// Environment-based configuration (optional convenience)
export interface EnvironmentConfig {
  MACH1_PRIVATE_KEY?: string;
  MACH1_RPC_URL?: string;
  MACH1_CHAIN_ID?: string;
  MACH1_MODE?: "backtest" | "paper" | "live";
  MACH1_LOG_LEVEL?: "debug" | "info" | "warn" | "error" | "none";
  MONACO_ENV?: MonacoEnvironment;
  MONACO_CLIENT_ID?: string;
}

// Preset configurations for common networks
export interface NetworkPreset {
  name: string;
  network: "mainnet" | "testnet";
  chainId: number;
  rpcUrl: string;
}

// Configuration validation
export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
