#!/usr/bin/env node
import { createMonacoSDK } from "@0xmonaco/core";
import type { OrderSide, TradingMode } from "@0xmonaco/types";
import { Command, Option } from "commander";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { parse as parseToml } from "smol-toml";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sei, seiTestnet } from "viem/chains";

type SideMode = "buy" | "sell" | "alternate";

interface FileConfig {
  network?: string;
  rpcUrl?: string;
  wsUrl?: string;
  privateKey?: string;
  privateKeys?: string[];
  clientId?: string;
  tradingPair?: string;
  quantity?: string;
  ordersPerSec?: number;
  workers?: number;
  durationSec?: number;
  maxOrders?: number;
  side?: SideMode;
  tradingMode?: TradingMode;
  slippageBps?: number;
  logEverySec?: number;
}

interface StressConfig {
  network: string;
  rpcUrl: string;
  wsUrl: string;
  privateKey: `0x${string}`;
  walletId: number;
  clientId: string;
  tradingPair: string;
  quoteQuantity: string;
  quoteQuantityValue: number;
  ordersPerSec: number;
  workers: number;
  durationSec?: number;
  maxOrders?: number;
  side: SideMode;
  tradingMode: TradingMode;
  slippageTolerance?: number;
  logEverySec: number;
}

type MonacoClient = ReturnType<typeof createMonacoSDK>;

interface RunStats {
  startedAtMs: number;
  attempted: number;
  success: number;
  failed: number;
  inflight: number;
  latencySamplesMs: number[];
  latencySumMs: number;
  latencyMinMs?: number;
  latencyMaxMs?: number;
  errorCounts: Map<string, number>;
}

const DEFAULTS = {
  network: "staging",
  durationSec: 60,
  workers: 1,
  ordersPerSec: 10,
  side: "alternate" as SideMode,
  tradingMode: "SPOT" as TradingMode,
  logEverySec: 5,
};

const MAX_LATENCY_SAMPLES = 50_000;

function normalizePrivateKey(key: string): `0x${string}` {
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Invalid private key. Expected 32-byte hex string.");
  }
  return normalized as `0x${string}`;
}

function parsePositiveInt(name: string, value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNonNegativeInt(name: string, value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseOptionalPositiveInt(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parsePositiveInt(name, value);
}

function parseOptionalNonNegativeNumber(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}

function resolveWsUrl(network: string, explicitWsUrl?: string): string {
  if (explicitWsUrl) {
    return explicitWsUrl;
  }

  const preset = {
    local: "ws://localhost:8080/ws",
    development: "wss://develop.apimonaco.xyz/ws",
    staging: "wss://staging.apimonaco.xyz/ws",
    mainnet: "wss://api.monaco.xyz/ws",
  } as const;

  if (network in preset) {
    return preset[network as keyof typeof preset];
  }

  const networkUrl = new URL(network);
  const wsProtocol = networkUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${networkUrl.host}/ws`;
}

function resolveRpcUrl(network: string, explicitRpcUrl?: string): string {
  if (explicitRpcUrl) {
    return explicitRpcUrl;
  }
  return network === "mainnet"
    ? "https://evm-rpc.sei-apis.com"
    : "https://evm-rpc-testnet.sei-apis.com";
}

function getSide(mode: SideMode, requestIndex: number): OrderSide {
  if (mode === "buy") {
    return "BUY";
  }
  if (mode === "sell") {
    return "SELL";
  }
  return requestIndex % 2 === 0 ? "BUY" : "SELL";
}

function pushLatency(stats: RunStats, latencyMs: number): void {
  stats.latencySumMs += latencyMs;
  stats.latencyMinMs = stats.latencyMinMs === undefined ? latencyMs : Math.min(stats.latencyMinMs, latencyMs);
  stats.latencyMaxMs = stats.latencyMaxMs === undefined ? latencyMs : Math.max(stats.latencyMaxMs, latencyMs);

  if (stats.latencySamplesMs.length < MAX_LATENCY_SAMPLES) {
    stats.latencySamplesMs.push(latencyMs);
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeErrors(errorCounts: Map<string, number>, limit = 3): string {
  const entries = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([message, count]) => `${count}x ${message}`).join(" | ");
}

function humanError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(undefined), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function getConfigValue<T>(
  cliValue: T | undefined,
  fileValue: T | undefined,
  envValue: T | undefined,
  fallback: T | undefined = undefined,
): T | undefined {
  if (cliValue !== undefined) return cliValue;
  if (fileValue !== undefined) return fileValue;
  if (envValue !== undefined) return envValue;
  return fallback;
}

async function loadFileConfig(configPath?: string): Promise<FileConfig> {
  if (!configPath) {
    return {};
  }

  const file = await readFile(configPath, "utf8");
  const parsed = parseToml(file) as Record<string, unknown>;

  return {
    network: typeof parsed.network === "string" ? parsed.network : undefined,
    rpcUrl: typeof parsed.rpcUrl === "string" ? parsed.rpcUrl : undefined,
    wsUrl: typeof parsed.wsUrl === "string" ? parsed.wsUrl : undefined,
    privateKey: typeof parsed.privateKey === "string" ? parsed.privateKey : undefined,
    privateKeys:
      Array.isArray(parsed.privateKeys) && parsed.privateKeys.every((value) => typeof value === "string")
        ? (parsed.privateKeys as string[])
        : undefined,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : undefined,
    tradingPair: typeof parsed.tradingPair === "string" ? parsed.tradingPair : undefined,
    quantity: typeof parsed.quantity === "string" ? parsed.quantity : undefined,
    ordersPerSec: typeof parsed.ordersPerSec === "number" ? parsed.ordersPerSec : undefined,
    workers: typeof parsed.workers === "number" ? parsed.workers : undefined,
    durationSec: typeof parsed.durationSec === "number" ? parsed.durationSec : undefined,
    maxOrders: typeof parsed.maxOrders === "number" ? parsed.maxOrders : undefined,
    side: parsed.side === "buy" || parsed.side === "sell" || parsed.side === "alternate" ? parsed.side : undefined,
    tradingMode: parsed.tradingMode === "SPOT" || parsed.tradingMode === "MARGIN" ? parsed.tradingMode : undefined,
    slippageBps: typeof parsed.slippageBps === "number" ? parsed.slippageBps : undefined,
    logEverySec: typeof parsed.logEverySec === "number" ? parsed.logEverySec : undefined,
  };
}

async function createConfig(cliOptions: Record<string, unknown>): Promise<StressConfig> {
  const fileConfig = await loadFileConfig(typeof cliOptions.config === "string" ? cliOptions.config : undefined);

  const network = getConfigValue(
    typeof cliOptions.network === "string" ? cliOptions.network : undefined,
    fileConfig.network,
    process.env.MONACO_NETWORK,
    DEFAULTS.network,
  );

  if (!network) {
    throw new Error("network is required");
  }

  const rpcUrl = resolveRpcUrl(
    network,
    getConfigValue(
      typeof cliOptions.rpcUrl === "string" ? cliOptions.rpcUrl : undefined,
      fileConfig.rpcUrl,
      process.env.MONACO_RPC_URL,
    ),
  );

  const wsUrl = resolveWsUrl(
    network,
    getConfigValue(
      typeof cliOptions.wsUrl === "string" ? cliOptions.wsUrl : undefined,
      fileConfig.wsUrl,
      process.env.MONACO_WS_URL,
    ),
  );

  const walletId = parseNonNegativeInt(
    "wallet-id",
    getConfigValue(
      typeof cliOptions.walletId === "string" || typeof cliOptions.walletId === "number" ? cliOptions.walletId : undefined,
      undefined,
      process.env.MONACO_WALLET_ID,
      0,
    ),
  );

  const keyFromArray =
    fileConfig.privateKeys !== undefined
      ? (() => {
          if (fileConfig.privateKeys.length === 0) {
            throw new Error("privateKeys array is empty in config.");
          }
          if (walletId >= fileConfig.privateKeys.length) {
            throw new Error(
              `wallet-id ${walletId} is out of bounds for privateKeys array length ${fileConfig.privateKeys.length}.`,
            );
          }
          return fileConfig.privateKeys[walletId];
        })()
      : undefined;

  const privateKeyRaw =
    (typeof cliOptions.privateKey === "string" ? cliOptions.privateKey : undefined) ??
    process.env.MONACO_PRIVATE_KEY ??
    keyFromArray ??
    fileConfig.privateKey;

  if (!privateKeyRaw) {
    throw new Error(
      "private key is required. Pass --private-key, set MONACO_PRIVATE_KEY, or provide privateKeys/privateKey in config.",
    );
  }

  const clientId = getConfigValue(
    typeof cliOptions.clientId === "string" ? cliOptions.clientId : undefined,
    fileConfig.clientId,
    process.env.MONACO_CLIENT_ID,
  );
  if (!clientId) {
    throw new Error("client id is required. Pass --client-id or set MONACO_CLIENT_ID.");
  }

  const tradingPair = getConfigValue(
    typeof cliOptions.pair === "string" ? cliOptions.pair : undefined,
    fileConfig.tradingPair,
    process.env.MONACO_TRADING_PAIR,
  );
  if (!tradingPair) {
    throw new Error("trading pair is required. Pass --pair or set MONACO_TRADING_PAIR.");
  }

  const quantityRaw = getConfigValue(
    typeof cliOptions.quantity === "string" ? cliOptions.quantity : undefined,
    fileConfig.quantity,
    process.env.MONACO_ORDER_QUANTITY,
  );
  if (!quantityRaw) {
    throw new Error("quantity is required. Pass --quantity or set MONACO_ORDER_QUANTITY.");
  }
  const quoteQuantityValue = Number(quantityRaw);
  if (!Number.isFinite(quoteQuantityValue) || quoteQuantityValue <= 0) {
    throw new Error("quantity must be a positive number representing quote notional amount.");
  }

  const ordersPerSec = parsePositiveInt(
    "orders-per-sec",
    getConfigValue(
      typeof cliOptions.ordersPerSec === "string" || typeof cliOptions.ordersPerSec === "number"
        ? cliOptions.ordersPerSec
        : undefined,
      fileConfig.ordersPerSec,
      process.env.MONACO_ORDERS_PER_SEC,
      DEFAULTS.ordersPerSec,
    ),
  );

  const workers = parsePositiveInt(
    "workers",
    getConfigValue(
      typeof cliOptions.workers === "string" || typeof cliOptions.workers === "number" ? cliOptions.workers : undefined,
      fileConfig.workers,
      process.env.MONACO_WORKERS,
      DEFAULTS.workers,
    ),
  );

  const durationSec = parseOptionalPositiveInt(
    "duration-sec",
    getConfigValue(
      typeof cliOptions.durationSec === "string" || typeof cliOptions.durationSec === "number"
        ? cliOptions.durationSec
        : undefined,
      fileConfig.durationSec,
      process.env.MONACO_DURATION_SEC,
      DEFAULTS.durationSec,
    ),
  );

  const maxOrders = parseOptionalPositiveInt(
    "max-orders",
    getConfigValue(
      typeof cliOptions.maxOrders === "string" || typeof cliOptions.maxOrders === "number" ? cliOptions.maxOrders : undefined,
      fileConfig.maxOrders,
      process.env.MONACO_MAX_ORDERS,
    ),
  );

  const side = getConfigValue(
    typeof cliOptions.side === "string" ? (cliOptions.side as SideMode) : undefined,
    fileConfig.side,
    process.env.MONACO_SIDE as SideMode | undefined,
    DEFAULTS.side,
  );
  if (side !== "buy" && side !== "sell" && side !== "alternate") {
    throw new Error('side must be one of "buy", "sell", "alternate"');
  }

  const tradingMode = getConfigValue(
    typeof cliOptions.tradingMode === "string" ? (cliOptions.tradingMode as TradingMode) : undefined,
    fileConfig.tradingMode,
    process.env.MONACO_TRADING_MODE as TradingMode | undefined,
    DEFAULTS.tradingMode,
  );

  if (tradingMode !== "SPOT" && tradingMode !== "MARGIN") {
    throw new Error('trading-mode must be one of "SPOT" or "MARGIN"');
  }

  const slippageBps = parseOptionalNonNegativeNumber(
    "slippage-bps",
    getConfigValue(
      typeof cliOptions.slippageBps === "string" || typeof cliOptions.slippageBps === "number"
        ? cliOptions.slippageBps
        : undefined,
      fileConfig.slippageBps,
      process.env.MONACO_SLIPPAGE_BPS,
    ),
  );

  const logEverySec = parsePositiveInt(
    "log-every-sec",
    getConfigValue(
      typeof cliOptions.logEverySec === "string" || typeof cliOptions.logEverySec === "number"
        ? cliOptions.logEverySec
        : undefined,
      fileConfig.logEverySec,
      process.env.MONACO_LOG_EVERY_SEC,
      DEFAULTS.logEverySec,
    ),
  );

  if (maxOrders === undefined && durationSec === undefined) {
    throw new Error("at least one stop condition is required: --duration-sec and/or --max-orders");
  }

  return {
    network,
    rpcUrl,
    wsUrl,
    privateKey: normalizePrivateKey(privateKeyRaw),
    walletId,
    clientId,
    tradingPair,
    quoteQuantity: quantityRaw,
    quoteQuantityValue,
    ordersPerSec,
    workers,
    durationSec,
    maxOrders,
    side,
    tradingMode,
    slippageTolerance: slippageBps === undefined ? undefined : slippageBps / 10_000,
    logEverySec,
  };
}

async function resolveTradingPairId(
  sdk: MonacoClient,
  pairInput: string,
): Promise<{ symbol: string; id: string; baseDecimals: number; baseToken: string; quoteToken: string }> {
  const bySymbol = await sdk.market.getTradingPairBySymbol(pairInput);
  if (!bySymbol) {
    throw new Error(`Trading pair not found: ${pairInput}`);
  }

  if (!bySymbol.is_active) {
    throw new Error(`Trading pair is inactive: ${pairInput}`);
  }

  return {
    symbol: bySymbol.symbol,
    id: bySymbol.id,
    baseDecimals: bySymbol.base_decimals,
    baseToken: bySymbol.base_token,
    quoteToken: bySymbol.quote_token,
  };
}

function printConfig(
  config: StressConfig,
  resolvedPair?: { symbol: string; id: string; baseToken: string; quoteToken: string },
): void {
  console.log("Starting Monaco stress test with:");
  console.log(`- network: ${config.network}`);
  console.log(`- rpcUrl: ${config.rpcUrl}`);
  console.log(`- wsUrl: ${config.wsUrl}`);
  console.log(`- walletId: ${config.walletId}`);
  console.log(`- tradingPair: ${resolvedPair ? `${resolvedPair.symbol} (${resolvedPair.id})` : config.tradingPair}`);
  console.log(
    `- quantity (quote notional): ${config.quoteQuantity}${
      resolvedPair?.quoteToken ? ` ${resolvedPair.quoteToken}` : ""
    }`,
  );
  console.log(`- ordersPerSec: ${config.ordersPerSec}`);
  console.log(`- workers: ${config.workers}`);
  console.log(`- side: ${config.side}`);
  console.log(`- tradingMode: ${config.tradingMode}`);
  console.log(
    `- slippageTolerance: ${config.slippageTolerance === undefined ? "default" : `${(config.slippageTolerance * 100).toFixed(4)}%`}`,
  );
  console.log(`- durationSec: ${config.durationSec ?? "none"}`);
  console.log(`- maxOrders: ${config.maxOrders ?? "none"}`);
  console.log("");
}

function formatBaseQuantity(rawQty: number, baseDecimals: number): string {
  const fixed = rawQty.toFixed(baseDecimals);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed.length > 0 ? trimmed : "0";
}

async function resolveBaseQuantityFromQuote(
  sdk: MonacoClient,
  pairId: string,
  side: OrderSide,
  quoteNotional: number,
  tradingMode: TradingMode,
  baseDecimals: number,
): Promise<string> {
  const orderbook = await sdk.orderbook.getOrderbook(pairId, {
    depth: 1,
    tradingMode,
    denomination: "BASE",
  });

  const referencePrice = side === "BUY" ? orderbook.bestAsk : orderbook.bestBid;
  if (!referencePrice) {
    throw new Error(`No ${side === "BUY" ? "ask" : "bid"} price available in orderbook.`);
  }

  const parsedPrice = Number(referencePrice);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    throw new Error(`Invalid orderbook price: ${referencePrice}`);
  }

  const baseQty = quoteNotional / parsedPrice;
  if (!Number.isFinite(baseQty) || baseQty <= 0) {
    throw new Error("Calculated base quantity is invalid.");
  }

  const formatted = formatBaseQuantity(baseQty, baseDecimals);
  if (formatted === "0") {
    throw new Error("Calculated base quantity rounds to zero; increase quote quantity.");
  }

  return formatted;
}

async function runStress(config: StressConfig): Promise<void> {
  const account = privateKeyToAccount(config.privateKey);
  const chain = config.network === "mainnet" ? sei : seiTestnet;

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });

  const sdk = createMonacoSDK({
    walletClient,
    network: config.network,
    seiRpcUrl: config.rpcUrl,
    wsUrl: config.wsUrl,
  });

  const cleanup = async (): Promise<void> => {
    try {
      sdk.ws.disconnect();
    } catch {
      // Best-effort cleanup
    }

    await withTimeout(sdk.logout().catch(() => undefined), 3_000);
  };

  try {
    await sdk.login(config.clientId);
    const pair = await resolveTradingPairId(sdk, config.tradingPair);
    printConfig(config, pair);

    const stats: RunStats = {
      startedAtMs: Date.now(),
      attempted: 0,
      success: 0,
      failed: 0,
      inflight: 0,
      latencySamplesMs: [],
      latencySumMs: 0,
      errorCounts: new Map<string, number>(),
    };

    let pending = 0;
    let sequence = 0;
    let stop = false;
    let interruptedBySignal: NodeJS.Signals | null = null;
    let completedResolvers: Array<() => void> = [];

    const wakeWorkers = (): void => {
      const resolvers = completedResolvers;
      completedResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    };

    const waitForWork = (): Promise<void> =>
      new Promise((resolve) => {
        completedResolvers.push(resolve);
      });

    const canSchedule = (): boolean => {
      if (stop) {
        return false;
      }
      if (config.maxOrders !== undefined && stats.attempted + pending >= config.maxOrders) {
        return false;
      }
      return true;
    };

    const requestShutdown = (signal?: NodeJS.Signals): void => {
      if (stop) {
        return;
      }
      interruptedBySignal = signal ?? null;
      stop = true;
      pending = 0;
      wakeWorkers();
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      console.log(`\nReceived ${signal}. Gracefully shutting down...`);
      requestShutdown(signal);
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const scheduler = setInterval(() => {
      if (stop) {
        return;
      }

      let allowance = config.ordersPerSec;
      if (config.maxOrders !== undefined) {
        const remaining = config.maxOrders - (stats.attempted + pending);
        allowance = Math.max(0, Math.min(allowance, remaining));
      }

      if (allowance > 0) {
        pending += allowance;
        wakeWorkers();
      }

      if (config.maxOrders !== undefined && stats.attempted >= config.maxOrders && stats.inflight === 0 && pending === 0) {
        stop = true;
        wakeWorkers();
      }
    }, 1_000);

    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    if (config.durationSec !== undefined) {
      durationTimer = setTimeout(() => {
        requestShutdown();
      }, config.durationSec * 1_000);
    }

    const logTimer = setInterval(() => {
      const elapsedSec = (Date.now() - stats.startedAtMs) / 1_000;
      const attemptsPerSec = elapsedSec > 0 ? stats.attempted / elapsedSec : 0;
      const successPerSec = elapsedSec > 0 ? stats.success / elapsedSec : 0;
      const avgLatency = stats.success > 0 ? stats.latencySumMs / stats.success : undefined;

      console.log(
        [
          `elapsed=${elapsedSec.toFixed(1)}s`,
          `attempted=${stats.attempted}`,
          `success=${stats.success}`,
          `failed=${stats.failed}`,
          `inflight=${stats.inflight}`,
          `targetOps=${config.ordersPerSec}/s`,
          `actualAttemptOps=${attemptsPerSec.toFixed(2)}/s`,
          `actualSuccessOps=${successPerSec.toFixed(2)}/s`,
          `avgLatency=${avgLatency === undefined ? "n/a" : `${avgLatency.toFixed(2)}ms`}`,
        ].join(" | "),
      );
    }, config.logEverySec * 1_000);

    const worker = async (): Promise<void> => {
      while (true) {
        if (stop && pending === 0) {
          return;
        }

        if (pending <= 0) {
          await waitForWork();
          continue;
        }

        if (!canSchedule()) {
          requestShutdown();
          continue;
        }

        pending -= 1;
        const requestIndex = sequence;
        sequence += 1;

        const side = getSide(config.side, requestIndex);
        stats.attempted += 1;
        stats.inflight += 1;
        const start = performance.now();

        try {
          const marketOrderOptions: { tradingMode: TradingMode; slippageTolerance?: number } = {
            tradingMode: config.tradingMode,
            slippageTolerance: config.slippageTolerance,
          };

          const baseQuantity = await resolveBaseQuantityFromQuote(
            sdk,
            pair.id,
            side,
            config.quoteQuantityValue,
            config.tradingMode,
            pair.baseDecimals,
          );

          await sdk.trading.placeMarketOrder(pair.id, side, baseQuantity, marketOrderOptions);
          stats.success += 1;
          pushLatency(stats, performance.now() - start);
        } catch (error) {
          stats.failed += 1;
          const message = humanError(error);
          stats.errorCounts.set(message, (stats.errorCounts.get(message) ?? 0) + 1);
        } finally {
          stats.inflight -= 1;
        }

        if (config.maxOrders !== undefined && stats.attempted >= config.maxOrders) {
          requestShutdown();
        }
      }
    };

    const workers = Array.from({ length: config.workers }, () => worker());

    await Promise.all(workers);

    clearInterval(scheduler);
    clearInterval(logTimer);
    if (durationTimer) {
      clearTimeout(durationTimer);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    const elapsedSec = (Date.now() - stats.startedAtMs) / 1_000;
    const avgLatency = stats.success > 0 ? stats.latencySumMs / stats.success : undefined;
    const p95Latency = percentile(stats.latencySamplesMs, 95);

    console.log("\nStress test complete:");
    console.log(`- elapsed: ${elapsedSec.toFixed(2)}s`);
    console.log(`- attempted: ${stats.attempted}`);
    console.log(`- success: ${stats.success}`);
    console.log(`- failed: ${stats.failed}`);
    console.log(`- attempt ops/sec: ${(stats.attempted / Math.max(1, elapsedSec)).toFixed(2)}`);
    console.log(`- success ops/sec: ${(stats.success / Math.max(1, elapsedSec)).toFixed(2)}`);
    console.log(`- avg latency: ${avgLatency === undefined ? "n/a" : `${avgLatency.toFixed(2)}ms`}`);
    console.log(`- p95 latency: ${p95Latency === undefined ? "n/a" : `${p95Latency.toFixed(2)}ms`}`);
    console.log(`- min latency: ${stats.latencyMinMs === undefined ? "n/a" : `${stats.latencyMinMs.toFixed(2)}ms`}`);
    console.log(`- max latency: ${stats.latencyMaxMs === undefined ? "n/a" : `${stats.latencyMaxMs.toFixed(2)}ms`}`);
    console.log(`- top errors: ${summarizeErrors(stats.errorCounts)}`);
    if (interruptedBySignal) {
      console.log(`- shutdown reason: ${interruptedBySignal}`);
    }
  } finally {
    await cleanup();
  }
}

const program = new Command();

program
  .name("autosiege")
  .description("CLI for stress testing Monaco trading endpoints by bulk market order placement.")
  .option("-c, --config <path>", "Path to TOML config file")
  .option("--network <network>", "Monaco network preset or custom API URL")
  .option("--rpc-url <url>", "Sei RPC URL")
  .option("--ws-url <url>", "Monaco websocket URL")
  .option("--private-key <hex>", "Wallet private key")
  .option("--wallet-id <number>", "Index of private key from config privateKeys array (0-based)", "0")
  .option("--client-id <id>", "Monaco application client ID")
  .option("--pair <symbol>", "Trading pair symbol, e.g. BTC/USDC")
  .option("--quantity <amount>", "Quote notional amount per order (e.g. USDC amount)")
  .option("--orders-per-sec <number>", "Target number of orders to place per second")
  .option("--workers <number>", "Concurrent worker count")
  .option("--duration-sec <seconds>", "Run duration in seconds")
  .option("--max-orders <number>", "Stop after this many order attempts")
  .addOption(new Option("--side <mode>", "Order side mode").choices(["buy", "sell", "alternate"]))
  .addOption(new Option("--trading-mode <mode>", "Trading mode").choices(["SPOT", "MARGIN"]))
  .option("--slippage-bps <bps>", "Slippage tolerance in bps (100 = 1%)")
  .option("--log-every-sec <seconds>", "Progress log interval")
  .action(async (options: Record<string, unknown>) => {
    try {
      const config = await createConfig(options);
      await runStress(config);
    } catch (error) {
      console.error(`Error: ${humanError(error)}`);
      process.exitCode = 1;
    }
  });

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program
  .parseAsync(process.argv)
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    console.error(`Fatal: ${humanError(error)}`);
    process.exit(1);
  });
