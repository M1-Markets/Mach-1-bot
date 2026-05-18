import pc from "picocolors";
import prompts from "prompts";
import { ConfigResponse } from "./config-utils";

/**
 * Prompt choices for trading mode selection
 */
export const TRADING_MODE_CHOICES = [
  {
    title: pc.green("Simulation") + pc.gray(" (paper trading)"),
    value: "simulation",
  },
  {
    title: pc.blue("Backtest") + pc.gray(" (historical data)"),
    value: "backtest",
  },
  { title: pc.red("Live") + pc.gray(" (real trading)"), value: "live" },
];

/**
 * Prompt choices for strategy type selection
 */
export const STRATEGY_TYPE_CHOICES = [
  { title: "DCA (Dollar Cost Averaging)", value: "dca" },
  { title: "Grid Trading", value: "grid" },
  { title: "Portfolio Management", value: "portfolio" },
];

/**
 * Prompt choices for risk level selection
 */
export const RISK_LEVEL_CHOICES = [
  { title: pc.green("Low"), value: "low" },
  { title: pc.yellow("Medium"), value: "medium" },
  { title: pc.red("High"), value: "high" },
];

/**
 * Configuration prompts for bot initialization
 */
export const CONFIG_PROMPTS = [
  {
    type: "password" as const,
    name: "privateKey" as const,
    message: pc.yellow("Enter your private key"),
    validate: validatePrivateKey,
  },
  {
    type: "select" as const,
    name: "mode" as const,
    message: pc.yellow("Select trading mode"),
    choices: TRADING_MODE_CHOICES,
    initial: 0,
  },
  {
    type: "text" as const,
    name: "rpcUrl" as const,
    message: pc.yellow("RPC URL"),
    initial: "https://evm-rpc-testnet.sei.io",
  },
  {
    type: "number" as const,
    name: "chainId" as const,
    message: pc.yellow("Chain ID"),
    initial: 713715,
  },
  {
    type: "number" as const,
    name: "maxPositionSize" as const,
    message: pc.yellow("Max position size (USD)"),
    initial: 1000,
  },
  {
    type: "number" as const,
    name: "maxDailyLoss" as const,
    message: pc.yellow("Max daily loss (USD)"),
    initial: 500,
  },
  {
    type: "number" as const,
    name: "initialBalance" as const,
    message: pc.yellow("Initial balance (USD)"),
    initial: 10000,
  },
  {
    type: "select" as const,
    name: "strategyType" as const,
    message: pc.yellow("Strategy type"),
    choices: STRATEGY_TYPE_CHOICES,
    initial: 0,
  },
  {
    type: "select" as const,
    name: "riskLevel" as const,
    message: pc.yellow("Risk level"),
    choices: RISK_LEVEL_CHOICES,
    initial: 1,
  },
];

/**
 * Displays welcome message for configuration setup
 */
export function displayWelcomeMessage(): void {
  console.log(pc.cyan("🤖 Welcome to Mach-One Bot Configuration Setup!"));
  console.log(
    pc.gray("📝 Please provide the following configuration values:\n"),
  );
}

/**
 * Displays cancellation message when user exits setup
 */
export function displayCancellationMessage(): void {
  console.log(pc.gray("\n👋 Configuration cancelled."));
}

/**
 * Runs the configuration prompts and returns user responses
 */
export async function runConfigurationPrompts(): Promise<ConfigResponse | null> {
  const response = await prompts(CONFIG_PROMPTS);

  // Handle user cancellation (Ctrl+C)
  if (!response.privateKey) {
    return null;
  }

  return response as ConfigResponse;
}

/**
 * Validates private key input
 */
export function validatePrivateKey(value: string): boolean | string {
  return value.trim().length > 0 ? true : "Private key is required";
}
