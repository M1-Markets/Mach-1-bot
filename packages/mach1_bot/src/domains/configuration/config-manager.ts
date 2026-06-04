import { DEFAULT_CONTRACT_ADDRESSES } from "@/shared/constants";
import { Address } from "@/shared/types/common";
import type { RuntimeMode, SDKConfig } from "@/shared/types/config";
import {
  isConfigModeInput,
  isLiveMode,
  normalizeConfigMode,
} from "@/shared/utils/config-mode";
import {
  normalizeLiveMarketConfig,
  validateLiveMarketConfig,
} from "@/shared/utils/live-market-config";

export interface ContractAddresses {
  clob: Address;
  book: Address;
  state: Address;
  vault: Address;
}

export interface FullSDKConfig extends SDKConfig {
  contractAddresses: ContractAddresses;
  maxRetries?: number;
  timeout?: number;
  // Risk limits kept for backwards compat with CLI
  maxPositionSize?: number;
  maxDailyLoss?: number;
  defaultSlippage?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
}

export class ConfigManager {
  private config: FullSDKConfig | null = null;
  private defaults: Partial<FullSDKConfig> = {
    mode: "simulation",
    marketMode: "spot",
    maxRetries: 3,
    timeout: 30000,
    maxPositionSize: 1000,
    maxDailyLoss: 200,
    defaultSlippage: 0.5,
    stopLossPercent: 5,
    takeProfitPercent: undefined,
    contractAddresses: DEFAULT_CONTRACT_ADDRESSES,
    logLevel: "info",
  };

  constructor() {
    // Non-singleton for testing
  }

  loadConfig(config: Partial<FullSDKConfig>): FullSDKConfig {
    const normalizedConfig: Partial<FullSDKConfig> = {
      ...config,
      mode: normalizeConfigMode(config.mode),
      ...normalizeLiveMarketConfig({
        mode: config.mode,
        marketMode: config.marketMode,
        perps: config.perps
          ? {
              marginMode: config.perps.marginMode,
              leverage: config.perps.leverage,
              liquidationThresholdPercent:
                config.perps.liquidationThresholdPercent,
              marginAccountId: config.perps.marginAccountId,
            }
          : undefined,
      }),
    };

    this.validateConfig(normalizedConfig);

    const fullConfig: FullSDKConfig = {
      ...this.defaults,
      ...normalizedConfig,
      contractAddresses: {
        ...(this.defaults.contractAddresses ?? {}),
        ...normalizedConfig.contractAddresses,
      },
    } as FullSDKConfig;

    this.config = fullConfig;
    return fullConfig;
  }

  validateConfig(config: Partial<FullSDKConfig>): void {
    const errors: string[] = [];
    const rawMode = config.mode;
    const mode =
      typeof rawMode === "string"
        ? normalizeConfigMode(rawMode)
        : normalizeConfigMode(this.defaults.mode);

    if (typeof rawMode === "string" && !isConfigModeInput(rawMode)) {
      errors.push("Mode must be one of: backtest, simulation, live, paper");
    }

    errors.push(
      ...validateLiveMarketConfig({
        mode: rawMode,
        marketMode: config.marketMode,
        perps: config.perps
          ? {
              marginMode: config.perps.marginMode,
              leverage: config.perps.leverage,
              liquidationThresholdPercent:
                config.perps.liquidationThresholdPercent,
              marginAccountId: config.perps.marginAccountId,
            }
          : undefined,
      }),
    );

    if (
      isLiveMode(mode) &&
      (!config.privateKey || typeof config.privateKey !== "string")
    ) {
      errors.push("Private key is required");
    } else if (
      config.privateKey &&
      (!config.privateKey.startsWith("0x") || config.privateKey.length !== 66)
    ) {
      errors.push("Invalid private key format");
    }

    if (
      isLiveMode(mode) &&
      (!config.rpcUrl || typeof config.rpcUrl !== "string")
    ) {
      errors.push("RPC URL is required");
    } else if (config.rpcUrl) {
      try {
        new URL(config.rpcUrl);
        if (
          !config.rpcUrl.startsWith("http://") &&
          !config.rpcUrl.startsWith("https://")
        ) {
          errors.push("Invalid RPC URL format");
        }
      } catch {
        errors.push("Invalid RPC URL format");
      }
    }

    // Validate contract addresses
    if (config.contractAddresses) {
      const addresses = config.contractAddresses;
      const addressFields = ["clob", "book", "state", "vault"] as const;

      for (const field of addressFields) {
        const address = addresses[field];
        if (
          address &&
          (typeof address !== "string" || !address.match(/^0x[a-fA-F0-9]{40}$/))
        ) {
          errors.push(`Invalid contract address for ${field}`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join(", "));
    }
  }

  getConfig(sanitized = false): FullSDKConfig {
    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    if (sanitized) {
      const sanitizedConfig = { ...this.config };
      if (sanitizedConfig.privateKey) {
        sanitizedConfig.privateKey = "0x****...****";
      }
      return sanitizedConfig;
    }

    return this.config;
  }

  updateConfig(updates: Partial<FullSDKConfig>): void {
    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    // Validate updates before applying
    const testConfig = { ...this.config, ...updates };
    this.validateConfig(testConfig);

    // Apply updates
    this.config = { ...this.config, ...updates };
  }

  resetToDefaults(): void {
    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    const { privateKey, rpcUrl, contractAddresses } = this.config;
    this.config = {
      ...this.defaults,
      privateKey,
      rpcUrl,
      contractAddresses,
    } as FullSDKConfig;
  }

  exportConfig(excludeSensitive = false): string {
    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    if (excludeSensitive) {
      const { privateKey, ...configWithoutSensitive } = this.config;
      return JSON.stringify(configWithoutSensitive, null, 2);
    }

    return JSON.stringify(this.config, null, 2);
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      // Use require instead of dynamic import for better Jest compatibility
      const fs = require("fs").promises;
      const content = await fs.readFile(filePath, "utf-8");
      const config = JSON.parse(content);
      this.loadConfig(config);
    } catch (error) {
      throw new Error(`Failed to load configuration from file: ${error}`);
    }
  }

  async saveToFile(
    filePath: string,
    options?: { includeSecrets?: boolean },
  ): Promise<void> {
    if (!this.config) {
      throw new Error("No configuration loaded");
    }

    try {
      // Use require instead of dynamic import for better Jest compatibility
      const fs = require("fs").promises;
      const content = this.exportConfig(!(options?.includeSecrets ?? false));
      await fs.writeFile(filePath, content, "utf-8");
    } catch (error) {
      throw new Error(`Failed to save configuration to file: ${error}`);
    }
  }

  /**
   * @deprecated Use direct configuration instead of environment variables
   */
  loadFromEnv(): FullSDKConfig {
    const envMode = process.env.MACH1_MODE;
    const resolvedMode =
      typeof envMode === "string" && isConfigModeInput(envMode)
        ? normalizeConfigMode(envMode)
        : (this.defaults.mode as RuntimeMode);

    const missingVars: string[] = [];
    if (resolvedMode === "live" && !process.env.MACH1_PRIVATE_KEY) {
      missingVars.push("MACH1_PRIVATE_KEY");
    }
    if (resolvedMode === "live" && !process.env.MACH1_RPC_URL) {
      missingVars.push("MACH1_RPC_URL");
    }
    if (!process.env.MACH1_CLOB_ADDRESS) missingVars.push("MACH1_CLOB_ADDRESS");
    if (!process.env.MACH1_BOOK_ADDRESS) missingVars.push("MACH1_BOOK_ADDRESS");
    if (!process.env.MACH1_STATE_ADDRESS)
      missingVars.push("MACH1_STATE_ADDRESS");
    if (!process.env.MACH1_VAULT_ADDRESS)
      missingVars.push("MACH1_VAULT_ADDRESS");

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}`,
      );
    }

    const privateKey = process.env.MACH1_PRIVATE_KEY;
    const rpcUrl = process.env.MACH1_RPC_URL;
    if (resolvedMode === "live" && (!privateKey || !rpcUrl)) {
      throw new Error("Required environment variables missing");
    }

    return {
      privateKey,
      rpcUrl,
      mode: resolvedMode,
      maxPositionSize:
        parseInt(process.env.MACH1_MAX_POSITION_SIZE || "0") ||
        this.defaults.maxPositionSize,
      maxDailyLoss:
        parseInt(process.env.MACH1_MAX_DAILY_LOSS || "0") ||
        this.defaults.maxDailyLoss,
      chainId: process.env.MACH1_CHAIN_ID
        ? parseInt(process.env.MACH1_CHAIN_ID)
        : undefined,
      contractAddresses: DEFAULT_CONTRACT_ADDRESSES,
    } as FullSDKConfig;
  }
}
