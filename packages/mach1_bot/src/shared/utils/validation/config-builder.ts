import { NETWORK_PRESETS } from "@/shared/constants/networks";
import { BotConfig } from "@/shared/types/bot";
import type { MonacoEnvironment } from "@/shared/types/common";
import type { ConfigModeInput } from "@/shared/types/config";
import { normalizeConfigMode } from "@/shared/utils/config-mode";

export class ConfigBuilder {
  private config: Partial<BotConfig> = {};

  static create(): ConfigBuilder {
    return new ConfigBuilder();
  }

  withPrivateKey(privateKey: string): ConfigBuilder {
    this.config.privateKey = privateKey;
    return this;
  }

  withNetwork(preset: keyof typeof NETWORK_PRESETS & string): ConfigBuilder {
    const networkConfig = NETWORK_PRESETS[preset];
    if (!networkConfig) {
      throw new Error(`Unknown network preset: ${preset}`);
    }

    this.config.rpcUrl = networkConfig.rpcUrl;
    this.config.chainId = networkConfig.chainId;
    this.config.network = networkConfig.network;
    return this;
  }

  withCustomRpc(rpcUrl: string, chainId?: number): ConfigBuilder {
    this.config.rpcUrl = rpcUrl;
    this.config.chainId = chainId;
    return this;
  }

  withMode(mode: ConfigModeInput): ConfigBuilder {
    this.config.mode = normalizeConfigMode(mode);

    // Auto-set skipAuthentication for simulation mode
    if (this.config.mode === "simulation") {
      this.config.skipAuthentication = true;
    }
    return this;
  }

  withEnvironment(environment: MonacoEnvironment): ConfigBuilder {
    this.config.environment = environment;
    return this;
  }

  withClientId(clientId: string): ConfigBuilder {
    this.config.clientId = clientId;
    return this;
  }

  withRateLimiting(
    config: Partial<BotConfig["rateLimitConfig"]>,
  ): ConfigBuilder {
    this.config.rateLimitConfig = config;
    return this;
  }

  withWebSocket(config: Partial<BotConfig["websocketConfig"]>): ConfigBuilder {
    this.config.websocketConfig = config;
    return this;
  }

  withLogLevel(level: BotConfig["logLevel"]): ConfigBuilder {
    this.config.logLevel = level;
    return this;
  }

  onTradingPaused(callback: () => void): ConfigBuilder {
    this.config.onTradingPaused = callback;
    return this;
  }

  withRiskLimits(maxPositionSize: number, maxDailyLoss: number): ConfigBuilder {
    this.config.maxPositionSize = maxPositionSize;
    this.config.maxDailyLoss = maxDailyLoss;
    return this;
  }

  build(): BotConfig {
    const errors: string[] = [];

    if (!this.config.privateKey) {
      errors.push("Private key is required");
    }
    if (!this.config.rpcUrl) {
      errors.push("RPC URL is required");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join("\n")}`);
    }

    return {
      privateKey: this.config.privateKey ?? "",
      rpcUrl: this.config.rpcUrl ?? "",
      ...this.config,
    } as BotConfig;
  }
}
