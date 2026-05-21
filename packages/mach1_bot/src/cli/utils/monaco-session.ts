import * as fs from "fs";
import * as path from "path";
import {
  type Mach1SDK,
  MonacoCoreSDK,
  type MonacoEnvironment,
  type TradingPairResolver,
} from "mach1_sdk";
import pc from "picocolors";
import { createPublicClient, http } from "viem";
import { sei, seiTestnet } from "viem/chains";
import { convertToBotConfig, parseTomlConfig } from "@/cli/utils/bot-utils";
import type { BotConfig } from "@/shared/types/bot";
import type { ChainNetwork } from "@/shared/types/common";

export type MonacoEnvironmentOption = MonacoEnvironment;

const VALID_ENVIRONMENTS: MonacoEnvironmentOption[] = [
  "mainnet",
  "staging",
  "development",
  "local",
];

export const resolveEnvironmentOption = (
  envInput: string | undefined,
  fallback: MonacoEnvironmentOption,
): MonacoEnvironmentOption => {
  const resolved = envInput || process.env.MONACO_ENV || fallback;
  if (!VALID_ENVIRONMENTS.includes(resolved as MonacoEnvironmentOption)) {
    throw new Error(
      `Invalid environment: ${resolved}. Valid values: ${VALID_ENVIRONMENTS.join(", ")}`,
    );
  }
  return resolved as MonacoEnvironmentOption;
};

const deriveNetworkFromRpc = (rpcUrl: string): ChainNetwork => {
  return rpcUrl.includes("testnet") ? "sei-testnet" : "sei-mainnet";
};

const getViemChain = (network: ChainNetwork) => {
  return network === "sei-testnet" ? seiTestnet : sei;
};

const toMonacoNetwork = (network: ChainNetwork): "mainnet" | "testnet" =>
  network === "sei-mainnet" ? "mainnet" : "testnet";

export type PreparedConfig = {
  configFile: string;
  botConfig: BotConfig;
  tomlConfig: ReturnType<typeof parseTomlConfig> extends Promise<infer T>
    ? T
    : never;
  environment: MonacoEnvironmentOption;
  network: ChainNetwork;
};

export const loadBotConfigWithEnv = async (
  configPath: string,
  envInput: string | undefined,
  fallbackEnv: MonacoEnvironmentOption = "staging",
): Promise<PreparedConfig> => {
  const configFile = path.resolve(configPath);
  if (!fs.existsSync(configFile)) {
    throw new Error(`Configuration file not found: ${configFile}`);
  }

  const tomlConfig = await parseTomlConfig(configFile);
  const botConfig = convertToBotConfig(tomlConfig);
  const environment = resolveEnvironmentOption(envInput, fallbackEnv);
  const network = deriveNetworkFromRpc(botConfig.rpcUrl);

  return { configFile, botConfig, tomlConfig, environment, network };
};

const createViemClient = (network: ChainNetwork, rpcUrl: string) =>
  createPublicClient({
    chain: getViemChain(network),
    transport: http(rpcUrl),
  });

export type MonacoSessionContext = {
  network: ChainNetwork;
  sdk: Mach1SDK;
  resolver: TradingPairResolver;
  client: ReturnType<typeof createViemClient>;
  botConfig: BotConfig;
};

export type MonacoSessionStatusHandler = (status: string) => void;

export type MonacoSessionOptions = {
  connectWebSocket?: boolean;
  traceProfileOnInitialize?: boolean;
};

export const withMonacoSession = async (
  prepared: PreparedConfig,
  handler: (context: MonacoSessionContext) => Promise<void>,
  onStatus?: MonacoSessionStatusHandler,
  options?: MonacoSessionOptions,
): Promise<void> => {
  const { botConfig, environment, network } = prepared;

  const monacoSDK = new MonacoCoreSDK({
    network: toMonacoNetwork(network),
    privateKey: botConfig.privateKey,
    mode: "live",
    environment,
    rpcUrl: botConfig.rpcUrl,
    onStatus,
    connectWebSocket: options?.connectWebSocket,
    traceProfileOnInitialize: options?.traceProfileOnInitialize,
  });

  onStatus?.("Initializing Monaco SDK");
  await monacoSDK.initialize();
  onStatus?.("Monaco session ready");
  const sdk = monacoSDK.getSDK();
  const resolver = monacoSDK.getTradingPairResolver();
  const client = createViemClient(network, botConfig.rpcUrl);

  try {
    await handler({ sdk, resolver, client, network, botConfig });
  } finally {
    try {
      await monacoSDK.shutdown();
    } catch (shutdownError) {
      console.warn(
        pc.yellow(
          `⚠️  Failed to cleanly shutdown Monaco SDK: ${
            shutdownError instanceof Error
              ? shutdownError.message
              : String(shutdownError)
          }`,
        ),
      );
    }
  }
};
