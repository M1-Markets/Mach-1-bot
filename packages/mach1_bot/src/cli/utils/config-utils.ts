import * as fs from "fs";
import * as path from "path";
import type {
  ConfigModeInput,
  LiveTradingMarketMode,
  PerpsMarginMode,
  RuntimeMode,
} from "@/shared/types/config";
import { getDefaultAiPrompt } from "@/shared/utils/ai-utils";
import {
  normalizeLiveMarketConfig,
  validateLiveMarketConfig,
} from "@/shared/utils/live-market-config";
import {
  isConfigModeInput,
  isLiveMode,
  normalizeConfigMode,
} from "@/shared/utils/config-mode";
import { getNumber, getRecord, getString } from "@/shared/utils/record-utils";

export interface ConfigResponse {
  privateKey: string;
  mode: ConfigModeInput;
  rpcUrl: string;
  chainId: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  initialBalance: number;
  strategyType: string;
  riskLevel: string;
  enableAiHelper?: boolean;
  aiHelperType?: "gemini" | "chatgpt" | "claude";
  aiHelperApiKey?: string;
}

export interface BotConfig {
  privateKey: string;
  rpcUrl: string;
  mode: RuntimeMode;
  marketMode: LiveTradingMarketMode;
  maxPositionSize: number;
  maxDailyLoss: number;
  chainId: number;
  logLevel: string;
  perps?: {
    marginMode?: PerpsMarginMode;
    leverage?: number;
    liquidationThresholdPercent?: number;
  };
  aiHelper?: {
    enabled: boolean;
    provider: "gemini" | "chatgpt" | "claude";
    apiKey: string;
    prompt: string;
  };
}

export interface TomlConfig {
  wallet?: {
    private_key?: string;
  };
  trading: {
    mode: ConfigModeInput;
    market_mode?: LiveTradingMarketMode;
    base_currency: string;
    initial_balance: number;
    max_position_size: number;
    max_daily_loss: number;
  };
  perps?: {
    margin_mode?: PerpsMarginMode;
    leverage?: number;
    liquidation_threshold_percent?: number;
  };
  strategy: {
    type: string;
    risk_level: string;
  };
  network?: {
    rpc_url?: string;
    chain_id?: number;
  };
  ai_helper?: {
    enabled: boolean;
    provider: "gemini" | "chatgpt" | "claude";
    api_key: string;
    prompt?: string;
  };
}

/**
 * Creates a TOML configuration object from user responses
 */
export function createConfigFromResponse(response: ConfigResponse): TomlConfig {
  return {
    wallet: {
      private_key: response.privateKey,
    },
    trading: {
      mode: normalizeConfigMode(response.mode),
      market_mode: "spot",
      base_currency: "USDC",
      initial_balance: response.initialBalance,
      max_position_size: response.maxPositionSize,
      max_daily_loss: response.maxDailyLoss,
    },
    strategy: {
      type: response.strategyType,
      risk_level: response.riskLevel,
    },
    network: {
      rpc_url: response.rpcUrl,
      chain_id: response.chainId,
    },
    ...(response.enableAiHelper &&
      response.aiHelperType &&
      response.aiHelperApiKey
      ? {
        ai_helper: {
          enabled: true,
          provider: response.aiHelperType,
          api_key: response.aiHelperApiKey,
          prompt: getDefaultAiPrompt(),
        },
      }
      : {}),
  };
}

/**
 * Writes a configuration object to a TOML file
 */
export async function writeConfigToFile(
  config: TomlConfig,
  filePath: string,
  options?: { includeSecrets?: boolean },
): Promise<void> {
  const { stringify } = await import("smol-toml");
  const tomlContent = stringify(
    options?.includeSecrets
      ? config
      : {
        ...config,
        wallet: config.wallet
          ? {
            ...config.wallet,
            private_key: undefined,
          }
          : undefined,
      },
  );
  fs.writeFileSync(filePath, tomlContent);
}

/**
 * Checks if a configuration file exists
 */
export function configFileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Loads and parses a TOML configuration file
 */
export async function loadConfigFromFile(configFile: string): Promise<unknown> {
  const configContent = fs.readFileSync(configFile, "utf8");
  const { parse } = await import("smol-toml");
  return parse(configContent);
}

/**
 * Validates required configuration fields
 */
export function validateConfig(tomlConfig: unknown): void {
  const config = getRecord(tomlConfig);
  const trading = getRecord(config?.trading);
  const modeValue = getString(trading?.mode);
  if (modeValue && !isConfigModeInput(modeValue)) {
    throw new Error(`mode must be one of: backtest, simulation, live, paper`);
  }

  const wallet = getRecord(config?.wallet);
  if (isLiveMode(modeValue) && !getString(wallet?.private_key)) {
    throw new Error("private_key is required in [wallet] section");
  }

  const network = getRecord(config?.network);
  const rpcUrl = getString(network?.rpc_url);
  if (isLiveMode(modeValue) && !rpcUrl) {
    throw new Error("rpc_url is required in [network] section");
  }
  if (isLiveMode(modeValue) && rpcUrl) {
    try {
      const parsedUrl = new URL(rpcUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new Error("rpc_url must be a valid http(s) URL");
    }
  }

  const perps = getRecord(config?.perps);
  const liveMarketConfigErrors = validateLiveMarketConfig({
    mode: modeValue,
    marketMode: getString(trading?.market_mode),
    perps: perps
      ? {
        marginMode: getString(perps.margin_mode),
        leverage: getNumber(perps.leverage),
        liquidationThresholdPercent: getNumber(
          perps.liquidation_threshold_percent,
        ),
      }
      : undefined,
  });

  if (liveMarketConfigErrors.length > 0) {
    throw new Error(liveMarketConfigErrors.join(", "));
  }
}

/**
 * Converts TOML config to bot configuration
 */
export function toBotConfig(tomlConfig: unknown): BotConfig {
  const config = getRecord(tomlConfig);
  const wallet = getRecord(config?.wallet);
  const network = getRecord(config?.network);
  const trading = getRecord(config?.trading);
  const perps = getRecord(config?.perps);
  const normalizedLiveMarketConfig = normalizeLiveMarketConfig({
    mode: getString(trading?.mode),
    marketMode: getString(trading?.market_mode),
    perps: perps
      ? {
        marginMode: getString(perps.margin_mode),
        leverage: getNumber(perps.leverage),
        liquidationThresholdPercent: getNumber(
          perps.liquidation_threshold_percent,
        ),
      }
      : undefined,
  });

  return {
    privateKey: getString(wallet?.private_key) ?? "",
    rpcUrl: getString(network?.rpc_url) ?? "",
    mode: normalizeConfigMode(getString(trading?.mode)),
    marketMode: normalizedLiveMarketConfig.marketMode,
    maxPositionSize: getNumber(trading?.max_position_size) ?? 1000,
    maxDailyLoss: getNumber(trading?.max_daily_loss) ?? 500,
    chainId: getNumber(network?.chain_id) ?? 713715,
    logLevel: "info",
    perps: normalizedLiveMarketConfig.perps,
  };
}

/**
 * Gets strategy information from config
 */
export function getStrategyInfo(tomlConfig: unknown): {
  type: string;
  riskLevel: string;
} {
  const config = getRecord(tomlConfig);
  const strategy = getRecord(config?.strategy);
  return {
    type: getString(strategy?.type) ?? "dca",
    riskLevel: getString(strategy?.risk_level) ?? "medium",
  };
}

/**
 * Resolves a configuration file path
 */
export function resolveConfigPath(configFile: string): string {
  return path.resolve(configFile);
}
