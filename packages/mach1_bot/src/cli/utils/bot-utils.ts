/**
 * Bot Utilities for CLI
 *
 * Provides utilities for bot initialization, configuration, and execution.
 * Separated from main.ts for better testability.
 */

import * as fs from "fs";
import { type GetUserBalancesResponse, MonacoCoreSDK } from "mach1_sdk";
import pc from "picocolors";
import { resolveEnvironmentOption } from "@/cli/utils/monaco-session";
import { AIAgent } from "@/domains/bot/ai-agent";
import { Mach1Bot } from "@/domains/bot/mach1-bot";
import type {
  StrategyConfig,
  StrategyContext,
  StrategyMetrics,
  StrategyParameters,
  StrategySignal,
  StrategyUtils,
} from "@/domains/strategies/core/i-strategy";
import type { MarketData } from "@/shared/types";
import type {
  AiOrderDecision,
  AiOrderSnapshot,
  AiStrategyDecision,
  AiStrategySnapshot,
} from "@/shared/types/ai";
import type { BotConfig } from "@/shared/types/bot";
import type { ChainNetwork } from "@/shared/types/common";
import type {
  ConfigModeInput,
  LiveTradingMarketMode,
  PerpsMarginMode,
} from "@/shared/types/config";
import { getDefaultAiPrompt } from "@/shared/utils/ai-utils";
import {
  isConfigModeInput,
  isLiveMode,
  normalizeConfigMode,
} from "@/shared/utils/config-mode";
import {
  normalizeLiveMarketConfig,
  validateLiveMarketConfig,
} from "@/shared/utils/live-market-config";
import {
  getNumberProp,
  getStringProp,
  isRecord,
  type UnknownRecord,
} from "@/shared/utils/record-utils";

// Configuration types
export interface TomlConfig {
  general?: {
    name: string;
    description: string;
  };
  bot?: {
    name: string;
    description: string;
  };
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
    risk_level: "low" | "medium" | "high";
    id?: string; // For using predefined strategies like 'rsi_strategy_v1'
    parameters?: Record<string, unknown>; // Custom strategy parameters
    trading_pairs?: string[]; // Supported trading pairs for the strategy
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

export interface BotInitializationOptions {
  strategyType: string;
  riskLevel: string;
  initialBalance: number;
}

export type BotOrderLogEntry = {
  timestamp: string;
  side: "BUY" | "SELL";
  pair: string;
  amountUsd: number;
  price?: number;
  status: string;
  orderId?: string;
  reason?: string;
};

export type BotRunHooks = {
  onOrder?: (entry: BotOrderLogEntry) => void;
};

const isVerboseLogLevel = (
  logLevel: BotConfig["logLevel"] | undefined,
): boolean =>
  typeof logLevel === "string" && logLevel.toUpperCase() === "DEBUG";

const logIfVerbose = (
  logLevel: BotConfig["logLevel"] | undefined,
  message: string,
): void => {
  if (isVerboseLogLevel(logLevel)) {
    console.log(message);
  }
};

const formatTokenBalance = (
  balance: number,
  valueUsd: number,
  symbol: string,
): string => {
  return `${balance.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  })} ${symbol} (~$${valueUsd.toFixed(2)})`;
};

const getPairBalanceSummary = async (
  bot: Mach1Bot,
  pairSymbol: string,
): Promise<string> => {
  const [baseSymbol, quoteSymbol] = pairSymbol
    .split("/")
    .map((segment) => segment.trim().toUpperCase());
  if (!baseSymbol || !quoteSymbol) return "";

  try {
    const portfolio = await bot.getPortfolio();
    const positions = Object.values(portfolio.positions) as Array<{
      symbol: string;
      balance: number;
      value: number;
    }>;
    const basePosition = positions.find(
      (position) => position.symbol.toUpperCase() === baseSymbol,
    );
    const quotePosition = positions.find(
      (position) => position.symbol.toUpperCase() === quoteSymbol,
    );

    const baseText = basePosition
      ? formatTokenBalance(basePosition.balance, basePosition.value, baseSymbol)
      : `no ${baseSymbol} position`;
    const quoteText = quotePosition
      ? formatTokenBalance(
        quotePosition.balance,
        quotePosition.value,
        quoteSymbol,
      )
      : `no ${quoteSymbol} position`;

    return `Balances: ${baseText} | ${quoteText}`;
  } catch {
    return "";
  }
};

type ProfileClient = {
  getUserBalanceByAssetId: (
    assetId: string,
  ) => Promise<{ available_balance?: string }>;
};

function buildAiSnapshot(
  context: StrategyContext,
  lastSignals?: StrategySignal[],
): AiStrategySnapshot {
  const marketData: MarketData = {};
  for (const [pair, data] of context.marketData.entries()) {
    const direct = data[pair];
    if (direct) {
      marketData[pair] = direct;
      continue;
    }
    const first = Object.values(data)[0];
    if (first) {
      marketData[pair] = first;
    }
  }

  const state: Record<string, unknown> = {};
  for (const [key, value] of context.state.entries()) {
    state[key] = value;
  }

  return {
    marketData,
    portfolio: context.portfolio,
    metrics: {
      totalReturn: context.metrics.totalReturn,
      sharpeRatio: context.metrics.sharpeRatio,
      maxDrawdown: context.metrics.maxDrawdown,
      winRate: context.metrics.winRate,
      totalTrades: context.metrics.totalTrades,
      profitFactor: context.metrics.profitFactor,
    },
    parameters: context.parameters,
    lastSignals: lastSignals?.map((signal) => ({
      action: signal.action,
      pair: signal.pair,
      confidence: signal.confidence,
      reason: signal.reason,
    })),
    state,
  };
}

function buildAiOrderSnapshot(
  context: StrategyContext,
  signal: StrategySignal,
  lastSignals?: StrategySignal[],
): AiOrderSnapshot {
  const base = buildAiSnapshot(context, lastSignals);
  return {
    ...base,
    signal: {
      action: signal.action,
      pair: signal.pair,
      quantity: signal.quantity,
      price: signal.price,
      orderType: signal.orderType,
      confidence: signal.confidence,
      reason: signal.reason,
      metadata: signal.metadata,
    },
  };
}

function shouldSkipForAiDecision(
  decision: AiStrategyDecision,
  logPrefix: string,
): boolean {
  if (decision.action === "stop") {
    console.log(
      pc.red(
        `${logPrefix} AI requested stop: ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`,
      ),
    );
    return true;
  }

  if (decision.action === "pause") {
    console.log(
      pc.yellow(
        `${logPrefix} AI requested pause: ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`,
      ),
    );
    return true;
  }

  return false;
}

function shouldSkipForAiOrderDecision(
  decision: AiOrderDecision,
  logPrefix: string,
): "pause" | "reject" | "approve" {
  if (decision.action === "pause") {
    console.log(
      pc.yellow(
        `${logPrefix} AI paused order: ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`,
      ),
    );
    return "pause";
  }
  if (decision.action === "reject") {
    console.log(
      pc.yellow(
        `${logPrefix} AI rejected order: ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`,
      ),
    );
    return "reject";
  }
  return "approve";
}

function getProfileClient(value: unknown): ProfileClient | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value as ProfileClient;
  return typeof candidate.getUserBalanceByAssetId === "function"
    ? candidate
    : undefined;
}

function createEmptyMetrics(): StrategyMetrics {
  return {
    totalReturn: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    avgHoldingPeriod: 0,
    profitFactor: 0,
    lastUpdate: Date.now(),
  };
}

function createStrategyUtils(logLevel?: BotConfig["logLevel"]): StrategyUtils {
  const indicators = {
    rsi: (prices: number[], period: number) => {
      if (prices.length < period + 1) return 50;

      let gains = 0;
      let losses = 0;

      for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
      }

      const avgGain = gains / period;
      const avgLoss = losses / period;

      if (avgLoss === 0) return 100;

      const rs = avgGain / avgLoss;
      return 100 - 100 / (1 + rs);
    },
    sma: (prices: number[], period: number) => {
      if (prices.length < period) return prices[prices.length - 1] || 0;
      const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
      return sum / period;
    },
    ema: (prices: number[], period: number) => {
      if (prices.length < period) return prices[prices.length - 1] || 0;
      const multiplier = 2 / (period + 1);
      let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

      for (let i = period; i < prices.length; i++) {
        ema = prices[i] * multiplier + ema * (1 - multiplier);
      }

      return ema;
    },
    macd: (
      prices: number[],
      fastPeriod: number,
      slowPeriod: number,
      signalPeriod: number,
    ) => {
      const fastEMA = indicators.ema(prices, fastPeriod);
      const slowEMA = indicators.ema(prices, slowPeriod);
      const macdLine = fastEMA - slowEMA;

      return {
        macd: macdLine,
        signal: macdLine * 0.9,
        histogram: macdLine * 0.1,
      };
    },
    bollingerBands: (prices: number[], period: number, stdDev: number) => {
      const sma = indicators.sma(prices, period);
      const squaredDiffs = prices
        .slice(-period)
        .map((price) => Math.pow(price - sma, 2));
      const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
      const standardDeviation = Math.sqrt(variance);

      return {
        upper: sma + standardDeviation * stdDev,
        middle: sma,
        lower: sma - standardDeviation * stdDev,
      };
    },
    stochastic: (
      high: number[],
      low: number[],
      close: number[],
      period: number,
    ) => {
      if (
        high.length < period ||
        low.length < period ||
        close.length < period
      ) {
        return { k: 0, d: 0 };
      }

      const recentHigh = Math.max(...high.slice(-period));
      const recentLow = Math.min(...low.slice(-period));
      const currentClose = close[close.length - 1];
      const k =
        recentHigh === recentLow
          ? 0
          : ((currentClose - recentLow) / (recentHigh - recentLow)) * 100;
      return { k, d: k };
    },
  };

  return {
    log: {
      info: (msg: string, meta?: unknown) =>
        logIfVerbose(
          logLevel,
          pc.gray(`📊 ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
        ),
      warn: (msg: string, meta?: unknown) =>
        console.log(
          pc.yellow(`⚠️ ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
        ),
      error: (msg: string, meta?: unknown) =>
        console.log(
          pc.red(`❌ ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
        ),
      debug: (msg: string, meta?: unknown) =>
        logIfVerbose(
          logLevel,
          pc.gray(`🔎 ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
        ),
    },
    time: {
      getCurrentTimestamp: () => Date.now(),
      formatTime: (timestamp: number) => new Date(timestamp).toISOString(),
      getMarketHours: () => ({
        isOpen: true,
        nextOpen: Date.now(),
        nextClose: Date.now() + 60 * 60 * 1000,
      }),
    },
    indicators,
    math: {
      mean: (data: number[]) =>
        data.length === 0
          ? 0
          : data.reduce((sum, value) => sum + value, 0) / data.length,
      std: (data: number[]) => {
        if (data.length === 0) return 0;
        const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
        const variance =
          data.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
          data.length;
        return Math.sqrt(variance);
      },
      correlation: (x: number[], y: number[]) => {
        if (x.length === 0 || y.length === 0 || x.length !== y.length) {
          return 0;
        }
        const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
        const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
        let numerator = 0;
        let denomX = 0;
        let denomY = 0;
        for (let i = 0; i < x.length; i++) {
          const diffX = x[i] - meanX;
          const diffY = y[i] - meanY;
          numerator += diffX * diffY;
          denomX += diffX * diffX;
          denomY += diffY * diffY;
        }
        const denominator = Math.sqrt(denomX * denomY);
        return denominator === 0 ? 0 : numerator / denominator;
      },
      percentile: (data: number[], p: number) => {
        if (data.length === 0) return 0;
        const sorted = [...data].sort((a, b) => a - b);
        const clamped = Math.max(0, Math.min(100, p));
        const index = Math.floor((clamped / 100) * (sorted.length - 1));
        return sorted[index];
      },
    },
  };
}

const deriveNetworkFromRpc = (rpcUrl: string): ChainNetwork =>
  rpcUrl.includes("testnet") ? "sei-testnet" : "sei-mainnet";

function extractTradingPairs(
  strategyConfig?: TomlConfig["strategy"],
  registeredStrategy?: { config?: { supportedPairs?: string[] } },
): string[] {
  const configuredPairs =
    Array.isArray(strategyConfig?.trading_pairs) &&
      strategyConfig.trading_pairs.length > 0
      ? strategyConfig.trading_pairs
      : undefined;

  const parameterPair =
    typeof strategyConfig?.parameters?.pair === "string"
      ? [strategyConfig.parameters.pair]
      : undefined;

  const supportedPairs = registeredStrategy?.config?.supportedPairs;

  return configuredPairs || parameterPair || supportedPairs || ["ETH/USDC"];
}

function parseBalance(value: unknown): number {
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return 0;
}

async function getAvailableTokenBalance(
  tokenSymbol: string,
  assetId: string | undefined,
  decimals: number | undefined,
  profileBalances?: GetUserBalancesResponse,
  profile?: unknown,
): Promise<number> {
  const normalizedSymbol = tokenSymbol?.toUpperCase();
  let available = 0;
  let foundInList = false;

  try {
    const detailedBalances = Array.isArray(profileBalances?.balances)
      ? profileBalances.balances
      : [];
    for (const balance of detailedBalances) {
      const balanceRecord: UnknownRecord = isRecord(balance) ? balance : {};
      const balanceSymbol = (
        getStringProp(balanceRecord, "symbol") ||
        getStringProp(balanceRecord, "token") ||
        ""
      ).toUpperCase();
      const balanceAssetId = getStringProp(balanceRecord, "asset_id");
      if (
        balanceSymbol === normalizedSymbol ||
        (assetId && balanceAssetId === assetId)
      ) {
        const raw =
          getNumberProp(balanceRecord, "available_balance") ??
          getNumberProp(balanceRecord, "available") ??
          getNumberProp(balanceRecord, "total_balance") ??
          getNumberProp(balanceRecord, "balance") ??
          0;

        available = Math.max(available, parseBalance(raw));
        foundInList = true;
        break;
      }
    }
  } catch (error) {
    console.warn(
      `⚠️  Unable to read profile balance for ${tokenSymbol}: ${error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!foundInList && assetId) {
    const profileClient = getProfileClient(profile);
    if (profileClient) {
      try {
        const assetBalance =
          await profileClient.getUserBalanceByAssetId(assetId);
        if (assetBalance?.available_balance !== undefined) {
          available = Math.max(
            available,
            parseBalance(assetBalance.available_balance),
          );
        }
      } catch (error) {
        console.warn(
          `⚠️  Unable to read balance for ${tokenSymbol}: ${error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return available;
}

async function validateStrategyBalances(
  botConfig: BotConfig | undefined,
  tradingPairs: string[],
): Promise<void> {
  if (!botConfig || botConfig.mode !== "live") {
    return;
  }

  const pairsToCheck = tradingPairs.filter((pair) => pair && pair !== "*");
  if (pairsToCheck.length === 0) {
    logIfVerbose(
      botConfig.logLevel,
      pc.gray(
        "⚠️  No explicit trading pairs configured. Skipping balance validation.",
      ),
    );
    return;
  }

  const network = deriveNetworkFromRpc(botConfig.rpcUrl);
  const environment = resolveEnvironmentOption(
    process.env.MONACO_ENV,
    "staging",
  );
  const monaco = new MonacoCoreSDK({
    network: network === "sei-mainnet" ? "mainnet" : "testnet",
    privateKey: botConfig.privateKey,
    mode: "live",
    rpcUrl: botConfig.rpcUrl,
    environment,
  });

  logIfVerbose(
    botConfig.logLevel,
    pc.cyan("🔎 Validating available balances for configured trading pairs..."),
  );

  try {
    await monaco.initialize();

    const sdk = monaco.getSDK();
    const resolver = monaco.getTradingPairResolver();
    const profileBalances = await sdk.profile
      .getUserBalances()
      .catch(() => undefined);

    for (const pairSymbol of pairsToCheck) {
      const pairDetails = resolver.getPairBySymbol(pairSymbol);
      if (!pairDetails) {
        throw new Error(
          `Trading pair '${pairSymbol}' not found on Monaco. Check the symbol or update available pairs.`,
        );
      }

      const pairDetailsRecord = pairDetails as unknown as UnknownRecord;
      const baseBalance = await getAvailableTokenBalance(
        pairDetails.base_token,
        pairDetails.base_asset_id ||
        getStringProp(pairDetailsRecord, "base_asset_id"),
        pairDetails.base_decimals,
        profileBalances,
        sdk.profile,
      );

      const quoteBalance = await getAvailableTokenBalance(
        pairDetails.quote_token,
        pairDetails.quote_asset_id ||
        getStringProp(pairDetailsRecord, "quote_asset_id"),
        pairDetails.quote_decimals,
        profileBalances,
        sdk.profile,
      );

      const minOrderSize =
        parseFloat(getStringProp(pairDetailsRecord, "min_order_size") || "0") ||
        0;

      if (baseBalance <= 0 && quoteBalance <= 0) {
        throw new Error(
          `No funds available for ${pairSymbol}. Add ${pairDetails.base_token} or ${pairDetails.quote_token} to your Monaco vault.`,
        );
      }

      if (minOrderSize > 0 && baseBalance > 0 && baseBalance < minOrderSize) {
        throw new Error(
          `Balance for ${pairDetails.base_token} (${baseBalance}) is below the minimum order size (${minOrderSize}) for ${pairSymbol}.`,
        );
      }

      console.log(
        pc.gray(
          `   ${pairSymbol}: base=${baseBalance.toFixed(6)} ${pairDetails.base_token} | quote=${quoteBalance.toFixed(6)} ${pairDetails.quote_token}`,
        ),
      );
    }

    console.log(pc.green("✅ Balance validation passed for configured pairs"));
  } finally {
    try {
      await monaco.shutdown();
    } catch (error) {
      console.warn(
        `⚠️  Failed to shut down Monaco SDK after balance validation: ${error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Parse TOML configuration file
 */
export async function parseTomlConfig(configFile: string): Promise<TomlConfig> {
  if (!fs.existsSync(configFile)) {
    throw new Error(`Configuration file not found: ${configFile}`);
  }

  const configContent = fs.readFileSync(configFile, "utf8");

  // Use dynamic import but allow for easier testing
  let parse: ((input: string) => unknown) | undefined;
  try {
    const tomlModule = await import("smol-toml");
    parse = tomlModule.parse;
  } catch (_error) {
    // Fallback for testing environments that might not support dynamic imports
    try {
      const tomlModule = require("smol-toml");
      parse = tomlModule.parse;
    } catch (_requireError) {
      throw new Error("Could not load TOML parser");
    }
  }

  if (!parse) {
    throw new Error("Could not load TOML parser");
  }

  return parse(configContent) as unknown as TomlConfig;
}

/**
 * Convert TOML config to bot configuration
 */
export function convertToBotConfig(tomlConfig: TomlConfig): BotConfig {
  const resolvedLogLevel =
    process.env.MONACO_LOG_LEVEL ?? process.env.MACH1_LOG_LEVEL ?? "info";
  const mode = normalizeConfigMode(tomlConfig.trading?.mode);

  if (tomlConfig.trading?.mode && !isConfigModeInput(tomlConfig.trading.mode)) {
    throw new Error("mode must be one of: backtest, simulation, live, paper");
  }

  if (isLiveMode(mode) && !tomlConfig.wallet?.private_key) {
    throw new Error("private_key is required in [wallet] section");
  }

  if (isLiveMode(mode) && !tomlConfig.network?.rpc_url) {
    throw new Error("rpc_url is required in [network] section");
  }

  if (isLiveMode(mode) && tomlConfig.network?.rpc_url) {
    try {
      const parsedUrl = new URL(tomlConfig.network.rpc_url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new Error("rpc_url must be a valid http(s) URL");
    }
  }

  const liveMarketConfigErrors = validateLiveMarketConfig({
    mode: tomlConfig.trading?.mode,
    marketMode: tomlConfig.trading?.market_mode,
    perps: tomlConfig.perps
      ? {
        marginMode: tomlConfig.perps.margin_mode,
        leverage: tomlConfig.perps.leverage,
        liquidationThresholdPercent:
          tomlConfig.perps.liquidation_threshold_percent,
      }
      : undefined,
  });

  if (liveMarketConfigErrors.length > 0) {
    throw new Error(liveMarketConfigErrors.join(", "));
  }

  const normalizedLiveMarketConfig = normalizeLiveMarketConfig({
    mode: tomlConfig.trading?.mode,
    marketMode: tomlConfig.trading?.market_mode,
    perps: tomlConfig.perps
      ? {
        marginMode: tomlConfig.perps.margin_mode,
        leverage: tomlConfig.perps.leverage,
        liquidationThresholdPercent:
          tomlConfig.perps.liquidation_threshold_percent,
      }
      : undefined,
  });

  const config: BotConfig = {
    privateKey: tomlConfig.wallet?.private_key ?? "",
    rpcUrl: tomlConfig.network?.rpc_url ?? "",
    mode,
    marketMode: normalizedLiveMarketConfig.marketMode,
    perps: normalizedLiveMarketConfig.perps,
    environment: resolveEnvironmentOption(process.env.MONACO_ENV, "staging"),
    maxPositionSize: tomlConfig.trading?.max_position_size || 1000,
    maxDailyLoss: tomlConfig.trading?.max_daily_loss || 500,
    chainId: tomlConfig.network?.chain_id || 713715,
    logLevel: resolvedLogLevel as BotConfig["logLevel"],
  };

  // Add AI helper configuration if enabled
  if (tomlConfig.ai_helper?.enabled) {
    config.aiHelper = {
      enabled: true,
      provider: tomlConfig.ai_helper.provider,
      apiKey: tomlConfig.ai_helper.api_key,
      prompt: tomlConfig.ai_helper.prompt || getDefaultAiPrompt(),
    };
  }

  return config;
}

/**
 * Initialize and configure Mach1Bot with strategy setup
 */
export async function initializeMach1Bot(
  botConfig: BotConfig,
  options: BotInitializationOptions,
  strategyConfig?: TomlConfig["strategy"],
  hooks?: BotRunHooks,
): Promise<Mach1Bot> {
  logIfVerbose(botConfig.logLevel, pc.blue("🤖 Initializing Mach1Bot..."));

  // Create bot instance
  const bot = new Mach1Bot(botConfig);

  // Ensure enhanced features and strategies are loaded FIRST
  logIfVerbose(
    botConfig.logLevel,
    pc.blue("🔧 Loading enhanced features and strategies..."),
  );
  await bot.ensureInitialized();

  // Set up risk limits based on configuration
  const riskMultiplier =
    options.riskLevel === "low"
      ? 0.5
      : options.riskLevel === "high"
        ? 2.0
        : 1.0;

  await bot.setRiskLimits({
    maxPositionSize: Math.floor(
      (botConfig.maxPositionSize || 1000) * riskMultiplier,
    ),
    maxDailyLoss: Math.floor((botConfig.maxDailyLoss || 500) * riskMultiplier),
    positionLimitPercent: 25,
    stopLossPercent: 5,
    maxDrawdown: 0.15 * riskMultiplier,
    maxLeverage: 1.0,
    maxCorrelation: 0.8,
    maxOrderValue: Math.floor(2000 * riskMultiplier),
  });

  // Set up strategy based on type
  await setupStrategy(
    bot,
    options.strategyType,
    strategyConfig,
    botConfig,
    hooks,
  );

  logIfVerbose(
    botConfig.logLevel,
    pc.green("✅ Mach1Bot initialization complete"),
  );
  return bot;
}

/**
 * Setup strategy for the bot
 */
export async function setupStrategy(
  bot: Mach1Bot,
  strategyType: string,
  strategyConfig?: TomlConfig["strategy"],
  botConfig?: BotConfig,
  hooks?: BotRunHooks,
): Promise<void> {
  const applyParameterDefaults = (
    schema: Record<string, unknown> | undefined,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => {
    const defaults: Record<string, unknown> = {};
    if (schema) {
      for (const [key, def] of Object.entries(schema)) {
        if (isRecord(def) && "default" in def) {
          const defaultValue = (def as UnknownRecord).default;
          if (defaultValue !== undefined) {
            defaults[key] = defaultValue;
          }
        }
      }
    }
    return { ...defaults, ...overrides };
  };

  const aiHelper =
    botConfig?.aiHelper?.enabled && botConfig.aiHelper.apiKey
      ? AIAgent.fromHelperConfig(botConfig.aiHelper)
      : undefined;

  // Check if this is a registered strategy ID (like 'rsi_strategy_v1')
  if (strategyConfig?.id) {
    logIfVerbose(
      botConfig?.logLevel,
      pc.cyan(`🔬 Setting up custom strategy: ${strategyConfig.id}`),
    );

    try {
      // Initialize strategy system if not already done
      await bot.ensureInitialized();

      // Import strategy utilities to ensure strategies are registered
      const strategyUtilsModule = await import("./strategy-utils.js");
      await strategyUtilsModule.initializeBuiltinStrategies();

      // Get the registered strategy
      const strategyRegistryModule = await import(
        "@/domains/strategies/management/strategy-registry.js"
      );
      const registeredStrategy =
        strategyRegistryModule.strategyRegistry.getStrategy(strategyConfig.id);

      if (!registeredStrategy) {
        throw new Error(
          `Strategy '${strategyConfig.id}' not found. No legacy strategies available.`,
        );
      }

      // Setup the custom strategy with parameters
      const parameters = applyParameterDefaults(
        registeredStrategy.config.parametersSchema,
        strategyConfig.parameters || {},
      ) as StrategyParameters;
      const tradingPairs = extractTradingPairs(
        strategyConfig,
        registeredStrategy,
      );

      logIfVerbose(
        botConfig?.logLevel,
        pc.gray(`   Parameters: ${JSON.stringify(parameters)}`),
      );
      logIfVerbose(
        botConfig?.logLevel,
        pc.gray(`   Trading Pairs: ${tradingPairs.join(", ")}`),
      );

      await validateStrategyBalances(botConfig, tradingPairs);
      bot.setPreferredTradingPairs(tradingPairs);

      // Create and configure the strategy
      const strategyInstance = registeredStrategy.factory.createStrategy(
        {
          ...registeredStrategy.config,
          ...parameters,
        } as StrategyConfig,
        {
          supportedPairs: tradingPairs,
          mode: "manual", // CLI-controlled mode
        } as StrategyParameters,
      );

      const strategyState = new Map<string, unknown>();
      const strategyUtils = createStrategyUtils(botConfig?.logLevel);
      const baseMetrics = createEmptyMetrics();
      let lastSignals: StrategySignal[] | undefined;
      let aiStopRequested = false;
      const corePortfolio = await bot.getPortfolio();
      const initialContext: StrategyContext = {
        marketData: new Map<string, MarketData>(),
        parameters,
        portfolio:
          require("@/shared/utils/portfolio-converter").botToSdkPortfolio(
            corePortfolio,
          ),
        positions: new Map(),
        state: strategyState,
        metrics: baseMetrics,
        utils: strategyUtils,
      };

      await strategyInstance.initialize(initialContext);

      // Set up the strategy callback
      bot.strategy(async (data: MarketData) => {
        try {
          if (aiStopRequested) {
            return;
          }
          const contextMarketData = new Map<string, MarketData>();
          for (const [pair, candle] of Object.entries(data)) {
            if (isRecord(candle)) {
              contextMarketData.set(pair, {
                [pair]: candle as MarketData[string],
              });
            }
          }
          const portfolio =
            require("@/shared/utils/portfolio-converter").botToSdkPortfolio(
              await bot.getPortfolio(),
            );
          // Create strategy context
          const context: StrategyContext = {
            marketData: contextMarketData,
            parameters,
            portfolio,
            positions: new Map(), // Will be populated by the bot
            state: strategyState, // Persisted strategy state
            metrics: createEmptyMetrics(),
            utils: strategyUtils,
          };

          if (aiHelper) {
            const snapshot = buildAiSnapshot(context, lastSignals);
            const decision = await aiHelper.analyzeStrategyControl(snapshot);
            if (strategyInstance.onAiDecision) {
              await strategyInstance.onAiDecision(decision, context);
            }

            if (decision.action === "stop") {
              aiStopRequested = true;
              shouldSkipForAiDecision(decision, "🛑");
              return;
            }

            if (decision.action === "pause") {
              shouldSkipForAiDecision(decision, "⏸️");
              return;
            }
          }

          // Execute the strategy
          const result = await strategyInstance.execute(context);
          lastSignals = result.signals;
          if (!result.shouldContinue) {
            aiStopRequested = true;
            console.log(
              pc.yellow(
                "⏸️ Strategy requested stop via shouldContinue=false. Halting further executions.",
              ),
            );
            return;
          }

          // Process signals
          for (const signal of result.signals) {
            try {
              if (
                aiHelper &&
                (signal.action === "buy" || signal.action === "sell")
              ) {
                const orderSnapshot = buildAiOrderSnapshot(
                  context,
                  signal,
                  lastSignals,
                );
                const orderDecision =
                  await aiHelper.analyzeOrderDecision(orderSnapshot);
                const verdict = shouldSkipForAiOrderDecision(
                  orderDecision,
                  "🤖",
                );
                if (verdict === "pause") {
                  return;
                }
                if (verdict === "reject") {
                  continue;
                }
              }
              if (signal.action === "buy") {
                // Use a fixed USD amount for consistency in testing
                const amountUsd = 100;
                const balanceSummary = await getPairBalanceSummary(
                  bot,
                  signal.pair,
                );
                if (balanceSummary) {
                  console.log(
                    pc.yellow(
                      `🔎 Current balances for ${signal.pair}: ${balanceSummary}`,
                    ),
                  );
                }
                console.log(
                  pc.blue(
                    `🔄 Attempting to buy ${signal.pair} ($${amountUsd})...`,
                  ),
                );
                const order = await bot.buy(signal.pair, { amountUsd });
                const priceDisplay =
                  order.price !== undefined
                    ? `$${order.price.toFixed(4)}`
                    : signal.price !== undefined
                      ? `$${Number(signal.price).toFixed(4)}`
                      : "n/a";
                console.log(
                  pc.green(
                    `📈 ${signal.reason} - Bought ${signal.pair} ($${amountUsd}) @ ${priceDisplay} - Order: ${order.id}, Status: ${order.status}`,
                  ),
                );
                const fallbackPrice =
                  typeof signal.price === "number" ? signal.price : undefined;
                hooks?.onOrder?.({
                  timestamp: new Date().toISOString(),
                  side: "BUY",
                  pair: signal.pair,
                  amountUsd,
                  price: order.price ?? fallbackPrice,
                  status: order.status,
                  orderId: order.id,
                  reason: signal.reason,
                });
              } else if (signal.action === "sell") {
                const amountUsd = 100;
                const balanceSummary = await getPairBalanceSummary(
                  bot,
                  signal.pair,
                );
                if (balanceSummary) {
                  console.log(
                    pc.yellow(
                      `🔎 Current balances for ${signal.pair}: ${balanceSummary}`,
                    ),
                  );
                }
                console.log(
                  pc.blue(
                    `🔄 Attempting to sell ${signal.pair} ($${amountUsd})...`,
                  ),
                );
                const order = await bot.sell(signal.pair, { amountUsd });
                const priceDisplay =
                  order.price !== undefined
                    ? `$${order.price.toFixed(4)}`
                    : signal.price !== undefined
                      ? `$${Number(signal.price).toFixed(4)}`
                      : "n/a";
                console.log(
                  pc.red(
                    `📉 ${signal.reason} - Sold ${signal.pair} ($${amountUsd}) @ ${priceDisplay} - Order: ${order.id}, Status: ${order.status}`,
                  ),
                );
                const fallbackPrice =
                  typeof signal.price === "number" ? signal.price : undefined;
                hooks?.onOrder?.({
                  timestamp: new Date().toISOString(),
                  side: "SELL",
                  pair: signal.pair,
                  amountUsd,
                  price: order.price ?? fallbackPrice,
                  status: order.status,
                  orderId: order.id,
                  reason: signal.reason,
                });
              }
            } catch (orderError) {
              console.error(
                pc.red(
                  `❌ Order execution failed for ${signal.pair}: ${orderError instanceof Error ? orderError.message : String(orderError)}`,
                ),
              );
              hooks?.onOrder?.({
                timestamp: new Date().toISOString(),
                side: signal.action === "buy" ? "BUY" : "SELL",
                pair: signal.pair,
                amountUsd: 100,
                status: "error",
                reason:
                  orderError instanceof Error
                    ? orderError.message
                    : String(orderError),
              });
            }
          }
        } catch (error) {
          console.error(
            pc.red(
              `❌ Strategy execution error: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }, registeredStrategy.config.id);

      console.log(
        pc.green(
          `✅ Custom strategy '${strategyConfig.id}' configured successfully`,
        ),
      );
      return;
    } catch (error) {
      console.warn(
        pc.yellow(
          `⚠️ Failed to setup custom strategy: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      throw error;
    }
  }

  // Resolve strategies by registered type/category (legacy strategies removed)
  await bot.ensureInitialized();

  const strategyUtilsModule = await import("./strategy-utils.js");
  await strategyUtilsModule.initializeBuiltinStrategies();

  const strategyRegistryModule = await import(
    "@/domains/strategies/management/strategy-registry.js"
  );
  const registry = strategyRegistryModule.strategyRegistry;
  const strategiesByCategory = registry.getStrategiesByCategory(strategyType);

  if (!strategiesByCategory || strategiesByCategory.length === 0) {
    throw new Error(
      `No registered strategy found for type '${strategyType}'. Legacy strategies have been removed.`,
    );
  }

  const registeredStrategy = strategiesByCategory[0];
  const parameters = applyParameterDefaults(
    registeredStrategy.config.parametersSchema,
    strategyConfig?.parameters || {},
  ) as StrategyParameters;
  const tradingPairs = extractTradingPairs(strategyConfig, registeredStrategy);

  logIfVerbose(
    botConfig?.logLevel,
    pc.cyan(
      `🔬 Setting up registered strategy for type '${strategyType}': ${registeredStrategy.config.id}`,
    ),
  );
  logIfVerbose(
    botConfig?.logLevel,
    pc.gray(`   Parameters: ${JSON.stringify(parameters)}`),
  );
  logIfVerbose(
    botConfig?.logLevel,
    pc.gray(
      `   Trading Pairs: ${Array.isArray(tradingPairs) ? tradingPairs.join(", ") : tradingPairs}`,
    ),
  );

  await validateStrategyBalances(botConfig, tradingPairs);
  bot.setPreferredTradingPairs(
    Array.isArray(tradingPairs) ? tradingPairs : [tradingPairs],
  );

  const strategyInstance = registeredStrategy.factory.createStrategy(
    {
      ...registeredStrategy.config,
      ...parameters,
    } as StrategyConfig,
    {
      supportedPairs: tradingPairs,
      mode: "manual", // CLI-controlled mode
    } as StrategyParameters,
  );

  const strategyState = new Map<string, unknown>();
  const strategyUtils = createStrategyUtils(botConfig?.logLevel);
  const baseMetrics = createEmptyMetrics();
  let lastSignals: StrategySignal[] | undefined;
  let aiStopRequested = false;

  await strategyInstance.initialize({
    marketData: new Map<string, MarketData>(),
    parameters,
    portfolio: await bot.getPortfolio(),
    positions: new Map(),
    state: strategyState,
    metrics: baseMetrics,
    utils: strategyUtils,
  });

  bot.strategy(async (data: MarketData) => {
    try {
      if (aiStopRequested) {
        return;
      }
      const contextMarketData = new Map<string, MarketData>();
      for (const [pair, candle] of Object.entries(data)) {
        if (isRecord(candle)) {
          contextMarketData.set(pair, {
            [pair]: candle as MarketData[string],
          });
        }
      }
      const portfolio = await bot.getPortfolio();
      const context: StrategyContext = {
        marketData: contextMarketData,
        parameters,
        portfolio,
        positions: new Map(), // Will be populated by the bot
        state: strategyState, // Strategy state persists between executions
        metrics: createEmptyMetrics(),
        utils: strategyUtils,
      };

      if (aiHelper) {
        const snapshot = buildAiSnapshot(context, lastSignals);
        const decision = await aiHelper.analyzeStrategyControl(snapshot);
        if (strategyInstance.onAiDecision) {
          await strategyInstance.onAiDecision(decision, context);
        }

        if (decision.action === "stop") {
          aiStopRequested = true;
          shouldSkipForAiDecision(decision, "🛑");
          return;
        }

        if (decision.action === "pause") {
          shouldSkipForAiDecision(decision, "⏸️");
          return;
        }
      }

      const result = await strategyInstance.execute(context);
      lastSignals = result.signals;
      if (!result.shouldContinue) {
        aiStopRequested = true;
        console.log(
          pc.yellow(
            "⏸️ Strategy requested stop via shouldContinue=false. Halting further executions.",
          ),
        );
        return;
      }

      for (const signal of result.signals) {
        try {
          if (
            aiHelper &&
            (signal.action === "buy" || signal.action === "sell")
          ) {
            const orderSnapshot = buildAiOrderSnapshot(
              context,
              signal,
              lastSignals,
            );
            const orderDecision =
              await aiHelper.analyzeOrderDecision(orderSnapshot);
            const verdict = shouldSkipForAiOrderDecision(orderDecision, "🤖");
            if (verdict === "pause") {
              return;
            }
            if (verdict === "reject") {
              continue;
            }
          }
          if (signal.action === "buy") {
            const amountUsd = 100; // Fixed amount for consistent testing
            console.log(
              pc.blue(`🔄 Attempting to buy ${signal.pair} ($${amountUsd})...`),
            );
            const order = await bot.buy(signal.pair, { amountUsd });
            const priceDisplay =
              order.price !== undefined
                ? `$${order.price.toFixed(4)}`
                : signal.price !== undefined
                  ? `$${Number(signal.price).toFixed(4)}`
                  : "n/a";
            console.log(
              pc.green(
                `📈 ${signal.reason} - Bought ${signal.pair} ($${amountUsd}) @ ${priceDisplay} - Order: ${order.id}, Status: ${order.status}`,
              ),
            );
            const fallbackPrice =
              typeof signal.price === "number" ? signal.price : undefined;
            hooks?.onOrder?.({
              timestamp: new Date().toISOString(),
              side: "BUY",
              pair: signal.pair,
              amountUsd,
              price: order.price ?? fallbackPrice,
              status: order.status,
              orderId: order.id,
              reason: signal.reason,
            });
          } else if (signal.action === "sell") {
            const amountUsd = 100; // Fixed amount for consistent testing
            console.log(
              pc.blue(
                `🔄 Attempting to sell ${signal.pair} ($${amountUsd})...`,
              ),
            );
            const order = await bot.sell(signal.pair, { amountUsd });
            const priceDisplay =
              order.price !== undefined
                ? `$${order.price.toFixed(4)}`
                : signal.price !== undefined
                  ? `$${Number(signal.price).toFixed(4)}`
                  : "n/a";
            console.log(
              pc.red(
                `📉 ${signal.reason} - Sold ${signal.pair} ($${amountUsd}) @ ${priceDisplay} - Order: ${order.id}, Status: ${order.status}`,
              ),
            );
            const fallbackPrice =
              typeof signal.price === "number" ? signal.price : undefined;
            hooks?.onOrder?.({
              timestamp: new Date().toISOString(),
              side: "SELL",
              pair: signal.pair,
              amountUsd,
              price: order.price ?? fallbackPrice,
              status: order.status,
              orderId: order.id,
              reason: signal.reason,
            });
          }
        } catch (orderError) {
          console.error(
            pc.red(
              `❌ Order execution failed for ${signal.pair}: ${orderError instanceof Error ? orderError.message : String(orderError)}`,
            ),
          );
          hooks?.onOrder?.({
            timestamp: new Date().toISOString(),
            side: signal.action === "buy" ? "BUY" : "SELL",
            pair: signal.pair,
            amountUsd: 100,
            status: "error",
            reason:
              orderError instanceof Error
                ? orderError.message
                : String(orderError),
          });
        }
      }
    } catch (error) {
      console.error(
        pc.red(
          `❌ Strategy execution error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }, registeredStrategy.config.id);
}

/**
 * Execute bot based on configuration mode
 */
export async function executeBotMode(
  bot: Mach1Bot,
  botConfig: BotConfig,
  initialBalance: number,
): Promise<void> {
  logIfVerbose(botConfig.logLevel, pc.blue("✅ Starting bot execution..."));

  if (botConfig.mode === "backtest") {
    console.log(
      pc.blue("📊 Backtest mode configured - running historical analysis"),
    );
    console.log(
      pc.gray("💡 Enhanced BacktestEngine with pattern-based data loading"),
    );

    // Run backtest with date range that includes available data
    try {
      const backtestResults = await bot.backtest({
        start: "2024-07-01", // Start with available data
        end: "2024-07-02", // End day after to include full day
        initialCapital: initialBalance,
      });

      console.log(pc.green("\n✅ Backtest completed successfully!"));
      console.log(pc.cyan("📈 Backtest Results:"));
      console.log(
        pc.gray(
          `   Total Return: ${(backtestResults.totalReturn * 100).toFixed(2)}%`,
        ),
      );
      console.log(pc.gray(`   Total Trades: ${backtestResults.totalTrades}`));
      console.log(
        pc.gray(`   Win Rate: ${(backtestResults.winRate * 100).toFixed(2)}%`),
      );
      console.log(
        pc.gray(
          `   Max Drawdown: ${(backtestResults.maxDrawdown * 100).toFixed(2)}%`,
        ),
      );
      console.log(
        pc.gray(`   Sharpe Ratio: ${backtestResults.sharpeRatio.toFixed(3)}`),
      );
    } catch (error) {
      console.error(
        pc.red(
          `❌ Backtest failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      console.log(
        pc.gray("💡 Make sure backtest-data directory contains CSV files"),
      );
    }
  } else if (botConfig.mode === "simulation") {
    logIfVerbose(
      botConfig.logLevel,
      pc.green("🎮 Starting simulation mode - paper trading"),
    );
    logIfVerbose(
      botConfig.logLevel,
      pc.gray("💡 Monitor console for simulated trades"),
    );

    // Start paper trading simulation
    await bot.simulate({
      duration: "24h", // Run for 24 hours
      initialCapital: initialBalance,
    });
  } else if (botConfig.mode === "live") {
    logIfVerbose(
      botConfig.logLevel,
      pc.red("🔴 Starting LIVE mode - real trading"),
    );
    logIfVerbose(
      botConfig.logLevel,
      pc.yellow("⚠️ WARNING: Real money is at risk!"),
    );

    // Start live trading
    await bot.goLive({
      confirmations: 1,
    });
  }
}

/**
 * Display configuration summary
 */
export function displayConfigSummary(
  botConfig: BotConfig,
  tomlConfig: TomlConfig,
): void {
  if (!isVerboseLogLevel(botConfig.logLevel)) {
    return;
  }

  console.log(pc.green("✅ Configuration loaded successfully"));
  console.log(pc.gray(`   Mode: ${pc.bold(botConfig.mode)}`));
  console.log(pc.gray(`   Network: ${pc.bold(botConfig.rpcUrl)}`));
  console.log(
    pc.gray(`   Max Position: ${pc.bold("$" + botConfig.maxPositionSize)}`),
  );
  console.log(
    pc.gray(`   Max Daily Loss: ${pc.bold("$" + botConfig.maxDailyLoss)}`),
  );

  // Strategy configuration
  const strategyType = tomlConfig.strategy?.type || "dca";
  const riskLevel = tomlConfig.strategy?.risk_level || "medium";

  console.log(
    pc.magenta(`📈 Strategy: ${pc.bold(strategyType)} (${riskLevel} risk)`),
  );

  // AI Helper configuration
  if (botConfig.aiHelper?.enabled) {
    const providerName =
      botConfig.aiHelper.provider === "gemini"
        ? "Gemini"
        : botConfig.aiHelper.provider === "chatgpt"
          ? "ChatGPT"
          : "Claude";
    console.log(
      pc.cyan(`🤖 AI Helper: ${pc.bold(providerName)} ${pc.green("✓")}`),
    );
  }
}

/**
 * Validate dry run configuration
 */
export function validateDryRun(configFile: string): void {
  console.log(pc.green(`✅ Configuration file found: ${configFile}`));
  console.log(pc.gray("Dry run mode - bot validation would happen here."));
}

export { isVerboseLogLevel };

/**
 * Get the default AI helper prompt for trading analysis
 */
