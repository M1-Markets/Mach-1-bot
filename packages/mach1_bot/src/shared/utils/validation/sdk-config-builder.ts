import { NETWORK_PRESETS } from "@/shared/constants/networks";
import type { SDKConfig } from "@/shared/types/config";

export class SDKConfigBuilder {
  private config: Partial<SDKConfig> = {};

  static create(): SDKConfigBuilder {
    return new SDKConfigBuilder();
  }

  withRpcUrl(rpcUrl: string): SDKConfigBuilder {
    this.config.rpcUrl = rpcUrl;
    return this;
  }

  withMode(
    mode: "backtest" | "paper" | "live" | "simulation",
  ): SDKConfigBuilder {
    // Map legacy 'simulation' to canonical 'paper'
    this.config.mode =
      mode === "simulation" ? "paper" : (mode as SDKConfig["mode"]);
    return this;
  }

  withNetworkPreset(
    preset: keyof typeof NETWORK_PRESETS & string,
  ): SDKConfigBuilder {
    const networkConfig = NETWORK_PRESETS[preset];
    if (!networkConfig) throw new Error(`Unknown network preset: ${preset}`);
    this.config.rpcUrl = networkConfig.rpcUrl;
    this.config.chainId = networkConfig.chainId;
    return this;
  }

  withChainId(chainId: number): SDKConfigBuilder {
    this.config.chainId = chainId;
    return this;
  }

  withTimeout(timeoutMs: number): SDKConfigBuilder {
    this.config.timeoutMs = timeoutMs;
    return this;
  }

  withLogLevel(level: SDKConfig["logLevel"]): SDKConfigBuilder {
    this.config.logLevel = level;
    return this;
  }

  build(): SDKConfig {
    const errors: string[] = [];
    if (!this.config.rpcUrl) errors.push("RPC URL is required");
    if (errors.length > 0)
      throw new Error(`Configuration validation failed:\n${errors.join("\n")}`);
    return this.config as SDKConfig;
  }
}

export default SDKConfigBuilder;
