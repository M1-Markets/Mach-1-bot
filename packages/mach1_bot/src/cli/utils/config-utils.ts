import * as fs from "fs";
import * as path from "path";
import { getDefaultAiPrompt } from "@/shared/utils/ai-utils";
import { getNumber, getRecord, getString } from "@/shared/utils/record-utils";

export interface ConfigResponse {
  privateKey: string;
  mode: string;
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
  mode: string;
  maxPositionSize: number;
  maxDailyLoss: number;
  chainId: number;
  logLevel: string;
  aiHelper?: {
    enabled: boolean;
    provider: "gemini" | "chatgpt" | "claude";
    apiKey: string;
    prompt: string;
  };
}

export interface TomlConfig {
  wallet: {
    private_key: string;
  };
  trading: {
    mode: string;
    base_currency: string;
    initial_balance: number;
    max_position_size: number;
    max_daily_loss: number;
  };
  strategy: {
    type: string;
    risk_level: string;
  };
  network: {
    rpc_url: string;
    chain_id: number;
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
      mode: response.mode,
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
): Promise<void> {
  const { stringify } = await import("smol-toml");
  const tomlContent = stringify(config);
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
  const wallet = getRecord(config?.wallet);
  if (!getString(wallet?.private_key)) {
    throw new Error("private_key is required in [wallet] section");
  }

  const network = getRecord(config?.network);
  if (!getString(network?.rpc_url)) {
    throw new Error("rpc_url is required in [network] section");
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
  return {
    privateKey: getString(wallet?.private_key) ?? "",
    rpcUrl: getString(network?.rpc_url) ?? "",
    mode: getString(trading?.mode) ?? "simulation",
    maxPositionSize: getNumber(trading?.max_position_size) ?? 1000,
    maxDailyLoss: getNumber(trading?.max_daily_loss) ?? 500,
    chainId: getNumber(network?.chain_id) ?? 713715,
    logLevel: "info",
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
