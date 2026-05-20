#!/usr/bin/env node

import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import pc from "picocolors";
import prompts from "prompts";
import { registerLiveCommands } from "@/cli/commands/live-commands";
import {
  createRunUi,
  type RunLogEntry,
  type RunUiController,
} from "@/cli/ui/run-ui";
import {
  createSupervisorUi,
  type SupervisorUiController,
  type SupervisorUiState,
} from "@/cli/ui/supervisor-ui";
import {
  BotInitializationOptions,
  type BotOrderLogEntry,
  type BotRunHooks,
  convertToBotConfig,
  displayConfigSummary,
  displayStrategiesByCategory,
  displayStrategiesTable,
  displayStrategyDetails,
  executeBotMode,
  getAvailableCategories,
  getAvailableStrategies,
  getAvailableTags,
  getDefaultAiPrompt,
  getStrategiesByCategory,
  getStrategyById,
  isVerboseLogLevel,
  initializeMach1Bot,
  parseTomlConfig,
  searchStrategies,
  TomlConfig,
  validateDryRun,
} from "@/cli/utils";
import { resolveEnvironmentOption } from "@/cli/utils/monaco-session";
import { Mach1Bot } from "@/domains/bot/mach1-bot";
import type { StrategyFilter } from "@/domains/strategies/management/strategy-registry";
import { getWalletAddressFromPrivateKey } from "@/shared/utils/crypto-utils";
import { isRecord } from "@/shared/utils/record-utils";

// User Prompt Response Structure
interface PromptResponse {
  privateKey: string;
  mode: "backtest" | "simulation" | "live";
  rpcUrl: string;
  chainId: number;
  maxPositionSize: number;
  maxDailyLoss: number;
  initialBalance: number;
  strategyType: string;
  riskLevel: "low" | "medium" | "high";
  enableAiHelper?: boolean;
  aiHelperType?: "gemini" | "chatgpt" | "claude";
  aiHelperApiKey?: string;
}

// Global state for graceful shutdown
let isShuttingDown = false;
let activeBot: Mach1Bot | null = null;
let activeChildren: ChildProcess[] = [];
let supervisorUi: SupervisorUiController | undefined;

const hasEmergencyStop = (
  value: unknown,
): value is { emergencyStop: () => Promise<void> } =>
  isRecord(value) && typeof value.emergencyStop === "function";

const stripAnsi = (value: string): string =>
  value.replace(new RegExp("\\u001b\\[[0-9;]*m", "g"), "");

const sendSupervisorLog = (entry: RunLogEntry): void => {
  if (process.env.MACH_ONE_SUPERVISED !== "1") return;
  const send = (
    process as NodeJS.Process & {
      send?: (message: unknown) => void;
    }
  ).send;
  if (typeof send !== "function") return;
  try {
    send({ type: "log", payload: entry });
  } catch {
    // Ignore IPC failures to avoid crashing supervised runs.
  }
};

const INSTANCE_CONFIGS: Record<
  string,
  { configFile: string; logPrefix: string }
> = {
  alpha: { configFile: "mach-one-bot.toml", logPrefix: "alpha" },
  beta: { configFile: "mach-one-bot-1.toml", logPrefix: "beta" },
};

const sanitizeLogPrefix = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");

const rotateLogs = (logsDir: string, prefix: string, keep = 5): void => {
  const files = fs
    .readdirSync(logsDir)
    .filter(
      (name) => name.startsWith(`${prefix}-run-`) && name.endsWith(".log"),
    )
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(logsDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length < keep) return;
  for (const file of files.slice(keep - 1)) {
    fs.unlinkSync(path.join(logsDir, file.name));
  }
};

const buildRunLogPath = (configFile: string, logPrefix?: string): string => {
  const logsDir = path.resolve(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const parsed = path.parse(configFile);
  const prefix = sanitizeLogPrefix(logPrefix ?? parsed.name);
  rotateLogs(logsDir, prefix);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(logsDir, `${prefix}-run-${timestamp}-${process.pid}.log`);
};

const handleGracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    console.log(
      pc.yellow(`\n⚠️  Force shutdown (${signal}) - terminating immediately...`),
    );
    process.exit(1);
  }

  isShuttingDown = true;
  console.log(pc.cyan(`\n🛑 Received ${signal} - shutting down gracefully...`));

  // Set a backup timer to force exit after 3 seconds
  const forceExitTimer = setTimeout(() => {
    console.log(pc.red("\n💥 Force exit - graceful shutdown took too long"));
    process.exit(1);
  }, 3000);

  try {
    // Stop the active bot if it exists
    if (activeBot) {
      console.log(pc.gray("   Stopping bot operations..."));
      await Promise.race([
        activeBot.emergencyStop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 2000),
        ), // Reduced timeout to 2s
      ]);
      console.log(pc.green("   ✅ Bot stopped successfully"));
    }
    if (activeChildren.length > 0) {
      console.log(pc.gray("   Stopping supervised bot processes..."));
      await Promise.all(
        activeChildren.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.killed) {
                resolve();
                return;
              }
              child.once("exit", () => resolve());
              child.kill("SIGINT");
              setTimeout(() => {
                if (!child.killed) {
                  child.kill("SIGKILL");
                }
              }, 1500);
            }),
        ),
      );
      activeChildren = [];
      console.log(pc.green("   ✅ Supervised processes stopped"));
    }
    supervisorUi?.unmount();
  } catch (error) {
    console.error(pc.red("   ❌ Error during shutdown:"), error);
  } finally {
    clearTimeout(forceExitTimer);
    console.log(pc.cyan("👋 Goodbye!"));
    process.exit(0);
  }
};

// Make signal handlers more aggressive and immediate
let signalCount = 0;

process.on("SIGTERM", () => {
  signalCount++;
  console.log(`\n🛑 SIGTERM received (${signalCount})`);

  if (signalCount === 1) {
    handleGracefulShutdown("SIGTERM").catch(() => process.exit(1));
  } else {
    console.log("🔥 Force exit due to repeated signals");
    process.exit(1);
  }
});

process.on("SIGINT", () => {
  signalCount++;
  console.log(`\n🛑 SIGINT received (${signalCount})`);

  if (signalCount === 1) {
    handleGracefulShutdown("SIGINT").catch(() => process.exit(1));
  } else {
    console.log("🔥 Force exit due to repeated signals");
    process.exit(1);
  }
});

// Add more aggressive handlers
process.on("SIGUSR1", () => process.exit(0));
process.on("SIGUSR2", () => process.exit(0));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

export const createCliProgram = (): Command =>
  new Command("mach-one-bot")
    .version(
      "1.0.0",
      "-v, --version",
      "Output the current version of mach-one-bot.",
    )
    .description(
      "Advanced algorithmic trading SDK built on Monaco Protocol CLOB",
    )
    .helpOption("-h, --help", "Display this help message.");

const program = createCliProgram();

export const registerCliCommands = (target: Command): Command => {
  // Init command
  target
    .command("init")
    .description("Initialize a new mach-one-bot configuration file")
    .option(
      "-f, --file <filename>",
      "Configuration file name",
      "mach-one-bot.toml",
    )
    .option("--force", "Overwrite existing configuration file")
    .action(async (options) => {
      const configFile = path.resolve(options.file);

      if (fs.existsSync(configFile) && !options.force) {
        console.error(
          pc.red(
            `❌ Configuration file ${configFile} already exists. Use --force to overwrite.`,
          ),
        );
        process.exit(1);
      }

      console.log(pc.cyan("🤖 Welcome to Mach-One Bot Configuration Setup!"));
      console.log(
        pc.gray("📝 Please provide the following configuration values:\n"),
      );

      try {
        const response: PromptResponse = await prompts([
          {
            type: "password",
            name: "privateKey",
            message: pc.yellow("Enter your private key"),
            validate: (value) =>
              value.length > 0 ? true : "Private key is required",
          },
          {
            type: "select",
            name: "mode",
            message: pc.yellow("Select trading mode"),
            choices: [
              {
                title: pc.green("Simulation") + pc.gray(" (paper trading)"),
                value: "simulation",
              },
              {
                title: pc.blue("Backtest") + pc.gray(" (historical data)"),
                value: "backtest",
              },
              {
                title: pc.red("Live") + pc.gray(" (real trading)"),
                value: "live",
              },
            ],
            initial: 0,
          },
          {
            type: "text",
            name: "rpcUrl",
            message: pc.yellow("RPC URL"),
            initial: "https://evm-rpc-testnet.sei-apis.com",
          },
          {
            type: "number",
            name: "chainId",
            message: pc.yellow("Chain ID"),
            initial: 1328,
          },
          {
            type: "number",
            name: "maxPositionSize",
            message: pc.yellow("Max position size (USD)"),
            initial: 1000,
          },
          {
            type: "number",
            name: "maxDailyLoss",
            message: pc.yellow("Max daily loss (USD)"),
            initial: 500,
          },
          {
            type: "number",
            name: "initialBalance",
            message: pc.yellow("Initial balance (USD)"),
            initial: 10000,
          },
          {
            type: "select",
            name: "strategyType",
            message: pc.yellow("Strategy type"),
            choices: [
              { title: "DCA (Dollar Cost Averaging)", value: "dca" },
              { title: "Grid Trading", value: "grid" },
              { title: "Portfolio Management", value: "portfolio" },
            ],
            initial: 0,
          },
          {
            type: "select",
            name: "riskLevel",
            message: pc.yellow("Risk level"),
            choices: [
              { title: pc.green("Low"), value: "low" },
              { title: pc.yellow("Medium"), value: "medium" },
              { title: pc.red("High"), value: "high" },
            ],
            initial: 1,
          },
          {
            type: "confirm",
            name: "enableAiHelper",
            message: pc.cyan("Enable AI helper?"),
            initial: false,
          },
          {
            type: (prev) => (prev ? "select" : null),
            name: "aiHelperType",
            message: pc.cyan("Which AI helper?"),
            choices: [
              { title: "Gemini", value: "gemini" },
              { title: "ChatGPT", value: "chatgpt" },
              { title: "Claude", value: "claude" },
            ],
            initial: 0,
          },
          {
            type: (prev, values) => (values.enableAiHelper ? "password" : null),
            name: "aiHelperApiKey",
            message: (prev, values) => {
              const helperName =
                values.aiHelperType === "gemini"
                  ? "Gemini"
                  : values.aiHelperType === "chatgpt"
                    ? "ChatGPT (OpenAI)"
                    : "Claude (Anthropic)";
              return pc.cyan(`Enter ${helperName} API key`);
            },
          },
        ]);

        // Handle user cancellation (Ctrl+C)
        if (!response.privateKey) {
          console.log(pc.gray("\n👋 Configuration cancelled."));
          process.exit(0);
        }

        const config: TomlConfig = {
          general: {
            name: "my-trading-bot-config-1",
            description: "An optimized trading bot config",
          },
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

        const { stringify } = await import("smol-toml");
        const tomlContent = stringify(config);
        fs.writeFileSync(configFile, tomlContent);

        console.log(pc.green(`\n✅ Configuration file created: ${configFile}`));
        console.log(pc.cyan("📋 Configuration summary:"));
        console.log(pc.gray(`   Mode: ${pc.bold(config.trading.mode)}`));
        console.log(pc.gray(`   Network: ${pc.bold(config.network.rpc_url)}`));
        console.log(
          pc.gray(
            `   Chain ID: ${pc.bold(config.network.chain_id.toString())}`,
          ),
        );
        console.log(
          pc.gray(
            `   Strategy: ${pc.bold(config.strategy.type)} (${config.strategy.risk_level} risk)`,
          ),
        );
        console.log(
          pc.gray(
            `   Max Position: ${pc.bold("$" + config.trading.max_position_size)}`,
          ),
        );
        console.log(
          pc.gray(
            `   Max Daily Loss: ${pc.bold("$" + config.trading.max_daily_loss)}`,
          ),
        );
        if (config.ai_helper?.enabled) {
          const providerName =
            config.ai_helper.provider === "gemini"
              ? "Gemini"
              : config.ai_helper.provider === "chatgpt"
                ? "ChatGPT"
                : "Claude";
          console.log(
            pc.gray(`   AI Helper: ${pc.bold(providerName)} ${pc.green("✓")}`),
          );
        }
        console.log(
          pc.green(
            "\n🚀 Ready to run! Use 'mach-one-bot run' to start your bot.",
          ),
        );
      } catch (error) {
        console.error(
          pc.red(
            `❌ Failed to create configuration file: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

  // Run command
  target
    .command("run")
    .description("Run the trading bot")
    .option("-c, --config <file...>", "Configuration file path(s)", [
      "mach-one-bot.toml",
    ])
    .option("--dry-run", "Validate configuration without running the bot")
    .option("--test", "Test mode: auto-exit after 2 minutes")
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .option("--client-id <id>", "Override Monaco client ID")
    .option("--rate-limit <rps>", "Rate limit (requests per second)", parseInt)
    .option("--log-level <level>", "Log level: DEBUG, INFO, WARN, or ERROR")
    .option(
      "--log-prefix <prefix>",
      "Prefix for log file name (stored under ./logs)",
    )
    .option(
      "--instance <name>",
      "Run a named bot instance (alpha, beta) with predefined config/log prefix",
    )
    .action(async (options) => {
      const instanceName =
        typeof options.instance === "string"
          ? options.instance.toLowerCase()
          : undefined;
      const instanceConfig = instanceName
        ? INSTANCE_CONFIGS[instanceName]
        : undefined;
      if (instanceName && !instanceConfig) {
        console.error(
          pc.red(
            `❌ Unknown instance: ${options.instance}. Valid instances: ${Object.keys(
              INSTANCE_CONFIGS,
            ).join(", ")}`,
          ),
        );
        process.exit(1);
      }
      const configFiles = (
        Array.isArray(options.config) ? options.config : [options.config]
      )
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value: string) => path.resolve(value));
      const configFile = path.resolve(
        instanceConfig?.configFile ?? configFiles[0] ?? "mach-one-bot.toml",
      );
      const logPrefix = options.logPrefix ?? instanceConfig?.logPrefix;

      if (instanceConfig) {
        if (!fs.existsSync(configFile)) {
          console.error(
            pc.red(`❌ Configuration file not found: ${configFile}`),
          );
          console.log(
            pc.gray("Run 'mach-one-bot init' to create a configuration file."),
          );
          process.exit(1);
        }
      } else {
        for (const file of configFiles) {
          if (!fs.existsSync(file)) {
            console.error(pc.red(`❌ Configuration file not found: ${file}`));
            console.log(
              pc.gray(
                "Run 'mach-one-bot init' to create a configuration file.",
              ),
            );
            process.exit(1);
          }
        }
      }

      // Process environment-related CLI options (precedence: CLI > config > env > defaults)
      if (options.env) {
        try {
          const resolvedEnv = resolveEnvironmentOption(options.env, "staging");
          process.env.MONACO_ENV = resolvedEnv;
          console.log(pc.gray(`📍 Environment: ${pc.bold(resolvedEnv)}`));
        } catch (envError) {
          const message =
            envError instanceof Error ? envError.message : String(envError);
          console.error(pc.red(`❌ ${message}`));
          process.exit(1);
        }
      }

      if (options.clientId) {
        process.env.MONACO_CLIENT_ID = options.clientId;
        console.log(
          pc.gray(
            `🔑 Client ID: ${pc.bold(options.clientId.substring(0, 8))}...`,
          ),
        );
      }

      if (options.rateLimit) {
        if (options.rateLimit <= 0) {
          console.error(pc.red(`❌ Rate limit must be positive`));
          process.exit(1);
        }
        process.env.MONACO_RATE_LIMIT_RPS = options.rateLimit.toString();
        console.log(
          pc.gray(`⏱️  Rate limit: ${pc.bold(options.rateLimit)} req/s`),
        );
      }

      if (options.logLevel) {
        const validLevels = ["DEBUG", "INFO", "WARN", "ERROR"];
        const level = options.logLevel.toUpperCase();
        if (!validLevels.includes(level)) {
          console.error(
            pc.red(
              `❌ Invalid log level: ${options.logLevel}. Valid values: ${validLevels.join(", ")}`,
            ),
          );
          process.exit(1);
        }
        process.env.MONACO_LOG_LEVEL = level;
        console.log(pc.gray(`📝 Log level: ${pc.bold(level)}`));
      }

      if (options.dryRun) {
        for (const file of configFiles) {
          validateDryRun(file);
        }
        return;
      }

      try {
        const isSupervisor =
          !process.env.MACH_ONE_SUPERVISED &&
          !instanceConfig &&
          configFiles.length > 1;
        if (isSupervisor) {
          console.log(
            pc.cyan(
              `🧭 Supervisor starting ${configFiles.length} bot instances...`,
            ),
          );
          const supervisorState: SupervisorUiState = {
            status: "Starting",
            panes: configFiles.map((file: string) => ({
              id: file,
              title: path.basename(file),
              lines: [],
            })),
            viewport: {
              width: Math.max(40, process.stdout.columns ?? 80),
              height: Math.max(12, process.stdout.rows ?? 24),
            },
          };
          supervisorUi = await createSupervisorUi(supervisorState);
          const childArgsBase = [
            "run",
            "--env",
            resolveEnvironmentOption(process.env.MONACO_ENV, "staging"),
          ];
          if (options.clientId) {
            childArgsBase.push("--client-id", String(options.clientId));
          }
          if (options.rateLimit) {
            childArgsBase.push("--rate-limit", String(options.rateLimit));
          }
          if (options.logLevel) {
            childArgsBase.push("--log-level", String(options.logLevel));
          }
          if (options.test) {
            childArgsBase.push("--test");
          }
          activeChildren = configFiles.map((file: string) => {
            const prefix =
              logPrefix ??
              sanitizeLogPrefix(path.parse(file).name) ??
              undefined;
            const args = [
              ...childArgsBase,
              "--config",
              file,
              ...(prefix ? ["--log-prefix", prefix] : []),
            ];
            const child = spawn(
              process.execPath,
              [...process.execArgv, __filename, ...args],
              {
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                env: {
                  ...process.env,
                  MACH_ONE_SUPERVISED: "1",
                  MACH_ONE_NO_UI: "1",
                },
              },
            );
            child.on("message", (message: unknown) => {
              if (!isRecord(message)) return;
              if (message.type !== "log") return;
              const payload = message.payload;
              if (!isRecord(payload)) return;
              if (typeof payload.message !== "string") return;
              const level =
                typeof payload.level === "string" ? payload.level : "INFO";
              const line = `[${level}] ${payload.message}`;
              supervisorUi?.appendLine(file, line);
            });
            child.on("exit", (code, signal) => {
              const label = pc.gray(
                `${path.basename(file)} exited with ${
                  signal ? `signal ${signal}` : `code ${code ?? 0}`
                }`,
              );
              supervisorUi?.setPaneStatus(
                file,
                signal ? `signal ${signal}` : `code ${code ?? 0}`,
              );
              supervisorUi?.appendLine(file, label);
            });
            return child;
          });
          await Promise.all(
            activeChildren.map(
              (child) =>
                new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                }),
            ),
          );
          supervisorUi?.setStatus("All children exited");
          supervisorUi?.unmount();
          return;
        }

        await runBot(configFile, {
          testMode: Boolean(options.test),
          logPrefix,
        });
      } catch (error) {
        console.error(
          pc.red(
            `❌ Failed to start bot: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

  // Live utilities command group
  const liveCommand = target
    .command("live")
    .description("Live trading utilities");
  registerLiveCommands(liveCommand);

  // List strategies command
  target
    .command("list-strategies")
    .description("List all available trading strategies")
    .option("-c, --category <category>", "Filter by strategy category")
    .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
    .option("-r, --risk <min,max>", "Filter by risk level range (e.g., 1,5)")
    .option("-a, --author <author>", "Filter by strategy author")
    .option(
      "-d, --dir <directories>",
      "Include custom strategy directories (comma-separated paths)",
    )
    .option("--detailed", "Show detailed information for each strategy")
    .option("--by-category", "Group strategies by category")
    .option("--show-categories", "Show available categories")
    .option("--show-tags", "Show available tags")
    .action(async (options) => {
      try {
        // Show available categories
        if (options.showCategories) {
          const categories = await getAvailableCategories();
          console.log(pc.cyan("\n📂 Available Strategy Categories:\n"));
          categories.forEach((category) => {
            console.log(`   ${pc.bold(category)}`);
          });
          console.log();
          return;
        }

        // Show available tags
        if (options.showTags) {
          const tags = await getAvailableTags();
          console.log(pc.cyan("\n🏷️  Available Strategy Tags:\n"));
          const tagGroups = [];
          for (let i = 0; i < tags.length; i += 5) {
            tagGroups.push(tags.slice(i, i + 5));
          }
          tagGroups.forEach((group) => {
            console.log(
              `   ${group.map((tag) => pc.gray(`#${tag}`)).join("  ")}`,
            );
          });
          console.log();
          return;
        }

        // Build filters
        const filters: StrategyFilter = {};

        if (options.category) {
          filters.category = [options.category];
        }

        if (options.tags) {
          filters.tags = options.tags
            .split(",")
            .map((tag: string) => tag.trim());
        }

        if (options.risk) {
          const [min, max] = options.risk
            .split(",")
            .map((r: string) => parseInt(r.trim()));
          filters.riskLevel = { min, max };
        }

        if (options.author) {
          filters.author = options.author;
        }

        // Parse custom directories if provided
        let customDirectories: string[] = [];
        if (options.dir) {
          customDirectories = options.dir
            .split(",")
            .map((dir: string) => dir.trim())
            .filter(Boolean);
        }

        // Get strategies
        let strategies;
        if (Object.keys(filters).length > 0) {
          strategies = await searchStrategies(filters, customDirectories);
        } else if (options.category) {
          strategies = await getStrategiesByCategory(
            options.category,
            customDirectories,
          );
        } else {
          strategies = await getAvailableStrategies(customDirectories);
        }

        // Display strategies
        if (options.byCategory) {
          displayStrategiesByCategory(strategies);
        } else if (options.detailed) {
          console.log(pc.cyan(`\n📊 Found ${strategies.length} strategies:\n`));
          strategies.forEach((strategy, index) => {
            if (index > 0) console.log("\n" + "─".repeat(80));
            displayStrategyDetails(strategy);
          });
        } else {
          displayStrategiesTable(strategies);
        }

        // Show usage hint
        if (!options.detailed && strategies.length > 0) {
          console.log(
            pc.gray("💡 Use --detailed flag to see full strategy information"),
          );
          console.log(
            pc.gray("💡 Use --by-category to group strategies by category"),
          );
          console.log(
            pc.gray("💡 Use --show-categories to see available categories"),
          );
          console.log(pc.gray("💡 Use --show-tags to see available tags"));
          console.log(
            pc.gray(
              "💡 Use --dir <path> to include custom strategy directories",
            ),
          );
        }
      } catch (error) {
        console.error(
          pc.red(
            `❌ Failed to list strategies: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

  // Strategy details command
  target
    .command("strategy <strategyId>")
    .description("Show detailed information about a specific strategy")
    .action(async (strategyId) => {
      try {
        const strategy = await getStrategyById(strategyId);

        if (!strategy) {
          console.error(pc.red(`❌ Strategy '${strategyId}' not found`));
          console.log(
            pc.gray(
              "Use 'mach-one-bot list-strategies' to see available strategies",
            ),
          );
          process.exit(1);
        }

        displayStrategyDetails(strategy);
      } catch (error) {
        console.error(
          pc.red(
            `❌ Failed to get strategy details: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

  // Demo command - quick end-to-end smoke test using .env from cwd
  target
    .command("demo")
    .description(
      "Run a quick demo buy of ETH/USDC on sei-testnet. Mode (simulation/live) is read from .env.",
    )
    .action(async () => {
      try {
        // Load .env from where the user invoked the CLI. The bin launcher
        // exports MACH1_INVOCATION_CWD because the bot CLI itself spawns
        // with cwd=packages/mach1_bot, which would otherwise hide the
        // repo-root .env.
        // biome-ignore lint/security/detectNonLiteralRequire: dotenv is a known fixed module
        const dotenv = require("dotenv");
        const envCwd = process.env.MACH1_INVOCATION_CWD || process.cwd();
        dotenv.config({ path: path.resolve(envCwd, ".env") });

        const privateKey = process.env.PRIVATE_KEY;
        const rpcUrl = process.env.SEI_RPC_URL;

        if (!privateKey) {
          console.error(
            pc.red(
              "❌ Missing PRIVATE_KEY in environment. Add it to your .env file at the repo root.",
            ),
          );
          console.error(
            pc.gray("   See .env.example for the expected format."),
          );
          process.exit(1);
        }

        if (!rpcUrl) {
          console.error(
            pc.red(
              "❌ Missing SEI_RPC_URL in environment. Add it to your .env file at the repo root.",
            ),
          );
          console.error(
            pc.gray("   See .env.example for the expected format."),
          );
          process.exit(1);
        }

        // Resolve mode from .env (default: paper). Only "live" is
        // routed through the on-chain Monaco engine; "paper" and
        // "simulation" both use the simulated execution path internally.
        const rawMode = (process.env.MODE || "paper").toLowerCase();
        const validModes = ["paper", "simulation", "live"] as const;
        const mode = (
          validModes.includes(rawMode as (typeof validModes)[number])
            ? rawMode
            : "paper"
        ) as "paper" | "simulation" | "live";

        if (rawMode !== mode) {
          console.warn(
            pc.yellow(
              `⚠️  Unknown MODE="${rawMode}" in .env. Falling back to "paper".`,
            ),
          );
        }

        if (mode === "live") {
          console.log(
            pc.red("\n⚠️  LIVE MODE — this will place a real on-chain order."),
          );
          console.log(
            pc.red(
              "   $100 ETH/USDC buy will hit the Monaco protocol on sei-testnet using the wallet in PRIVATE_KEY.",
            ),
          );
          console.log(
            pc.yellow("   Press Ctrl+C in the next 5 seconds to abort.\n"),
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        console.log(
          pc.cyan(`🚀 Running mach1 demo (mode=${mode} on sei-testnet)...`),
        );

        const bot = new Mach1Bot({
          privateKey,
          rpcUrl,
          mode,
          network: "sei-testnet",
        });

        const order = await bot.buy("ETH/USDC", { amountUsd: 100 });

        const orderRejected = order.status === "rejected";
        const header = orderRejected
          ? pc.yellow("\n⚠️  Demo order was REJECTED by the protocol")
          : pc.green("\n✅ Demo trade submitted successfully");

        console.log(header);
        console.log(pc.gray("   Order:"));
        console.log(
          pc.gray(
            `     id=${order.id} symbol=${order.symbol} side=${order.side} type=${order.type} size=${order.size} price=${order.price} status=${order.status}`,
          ),
        );

        if (orderRejected && mode === "live") {
          console.log(
            pc.yellow(
              "\n   Common cause: no collateral in the Monaco vault for the quote asset.",
            ),
          );
          console.log(
            pc.gray(
              "   Use a config + the live commands to deposit, e.g.:",
            ),
          );
          console.log(
            pc.gray(
              "     mach1 live faucet  --config <bot.toml>   # claim testnet tokens",
            ),
          );
          console.log(
            pc.gray(
              "     mach1 live deposit --token USDC --amount 100 --config <bot.toml>",
            ),
          );
          console.log(
            pc.gray(
              "   Sample configs: packages/mach1_bot/example_configs/",
            ),
          );
        } else if (mode !== "live") {
          console.log(
            pc.gray(
              "\n   This order was simulated locally — no on-chain transaction occurred.",
            ),
          );
        }
        console.log(
          pc.cyan(
            "\n💡 Next steps: explore packages/mach1_bot/examples/ for strategy and backtest demos.",
          ),
        );
        process.exit(orderRejected ? 2 : 0);
      } catch (error) {
        console.error(
          pc.red(
            `❌ Demo failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        process.exit(1);
      }
    });

  return target;
};

type RunOptions = { testMode?: boolean; logPrefix?: string };

async function runBot(configFile: string, runOptions: RunOptions = {}) {
  let runUi: RunUiController | undefined;
  let restoreConsole: (() => void) | undefined;
  const disableUi = process.env.MACH_ONE_NO_UI === "1";

  try {
    // Load and parse TOML configuration
    const tomlConfig = await parseTomlConfig(configFile);

    // Convert TOML config to bot configuration
    const botConfig = convertToBotConfig(tomlConfig);
    const verbose = isVerboseLogLevel(botConfig.logLevel);

    // Get additional config for bot initialization
    const initialBalance = tomlConfig.trading?.initial_balance || 10000;
    const strategyType = tomlConfig.strategy?.type || "dca";
    const riskLevel = tomlConfig.strategy?.risk_level || "medium";
    const network = botConfig.rpcUrl.includes("testnet")
      ? "sei-testnet"
      : "sei-mainnet";
    const environment = resolveEnvironmentOption(
      process.env.MONACO_ENV,
      "staging",
    );
    const walletAddress = getWalletAddressFromPrivateKey(botConfig.privateKey);
    const viewport = {
      width: Math.max(40, process.stdout.columns ?? 80),
      height: Math.max(12, process.stdout.rows ?? 24),
    };

    // Display configuration summary
    displayConfigSummary(botConfig, tomlConfig);

    const runUiState = {
      status: "Initializing",
      walletAddress,
      mode: botConfig.mode,
      strategy: strategyType,
      environment,
      network,
      orders: [],
      logs: [],
      viewport,
    };
    const logFilePath = buildRunLogPath(configFile, runOptions.logPrefix);
    let hooks: BotRunHooks | undefined;
    if (!disableUi) {
      runUi = await createRunUi(runUiState);
      restoreConsole = attachRunUiLogger(runUi, logFilePath);
      hooks = {
        onOrder: (entry: BotOrderLogEntry) => {
          runUi?.addOrder(entry);
        },
      };
    } else {
      restoreConsole = attachFileLogger(logFilePath);
    }
    if (verbose) {
      console.log(pc.cyan(`🚀 Starting mach-one-bot with config: ${configFile}`));
      console.log(pc.blue("📖 Loading configuration..."));
      console.log(pc.gray(`📝 Logging to ${logFilePath}`));
    }

    // Initialize Mach1Bot with configuration
    const initOptions: BotInitializationOptions = {
      strategyType,
      riskLevel,
      initialBalance,
    };

    const bot = await initializeMach1Bot(
      botConfig,
      initOptions,
      tomlConfig.strategy,
      hooks,
    );

    // Assign to global variable for graceful shutdown
    activeBot = bot;

    // Execute bot based on mode
    await executeBotMode(bot, botConfig, initialBalance);
    runUi?.setStatus("Running");

    if (verbose) {
      console.log(pc.gray("🛑 Press Ctrl+C to stop the bot"));
    }

    if (runOptions.testMode) {
      if (verbose) {
        console.log(pc.gray("⏱️ Test mode: bot will auto-exit after 1 minutes"));
      }
      setTimeout(
        async () => {
          try {
            if (activeBot && hasEmergencyStop(activeBot)) {
              await activeBot.emergencyStop();
            }
          } catch (stopError) {
            console.warn(
              pc.yellow(
                `⚠️  Failed to stop bot cleanly: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
              ),
            );
          }
          restoreConsole?.();
          runUi?.unmount();
          process.exit(0);
        },
        2 * 60 * 1000,
      );
    } else {
      // Keep the process alive
      process.stdin.resume();
    }
  } catch (error) {
    restoreConsole?.();
    runUi?.unmount();
    throw new Error(
      `Failed to initialize bot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const attachFileLogger = (logFilePath: string): (() => void) => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const logStream = fs.createWriteStream(logFilePath, { flags: "a" });

  const toMessage = (args: unknown[]): string =>
    args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }
        if (arg instanceof Error) {
          return arg.message;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

  const detectLevel = (
    args: unknown[],
    fallback: RunLogEntry["level"],
  ): RunLogEntry["level"] => {
    const first = args.find((arg) => typeof arg === "string");
    if (typeof first !== "string") {
      return fallback;
    }
    if (first.includes("[DEBUG]")) return "DEBUG";
    if (first.includes("[INFO]")) return "INFO";
    if (first.includes("[WARN]")) return "WARN";
    if (first.includes("[ERROR]")) return "ERROR";
    return fallback;
  };

  const write = (level: RunLogEntry["level"], args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const resolvedLevel = detectLevel(args, level);
    const message = toMessage(args);
    sendSupervisorLog({
      timestamp,
      level: resolvedLevel,
      message,
    });
    logStream.write(`${timestamp} [${resolvedLevel}] ${stripAnsi(message)}\n`);
  };

  console.log = (...args: unknown[]) => {
    write("INFO", args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    write("WARN", args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    write("ERROR", args);
    original.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    write("DEBUG", args);
    original.debug(...args);
  };

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
    logStream.end();
  };
};

const attachRunUiLogger = (
  ui: RunUiController,
  logFilePath?: string,
): (() => void) => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const logStream = logFilePath
    ? fs.createWriteStream(logFilePath, { flags: "a" })
    : null;

  const toMessage = (args: unknown[]): string =>
    args
      .map((arg) => {
        if (typeof arg === "string") {
          return arg;
        }
        if (arg instanceof Error) {
          return arg.message;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

  const detectLevel = (
    args: unknown[],
    fallback: RunLogEntry["level"],
  ): RunLogEntry["level"] => {
    const first = args.find((arg) => typeof arg === "string");
    if (typeof first !== "string") {
      return fallback;
    }
    if (first.includes("[DEBUG]")) return "DEBUG";
    if (first.includes("[INFO]")) return "INFO";
    if (first.includes("[WARN]")) return "WARN";
    if (first.includes("[ERROR]")) return "ERROR";
    return fallback;
  };

  const push = (level: RunLogEntry["level"], args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const resolvedLevel = detectLevel(args, level);
    const message = toMessage(args);
    sendSupervisorLog({
      timestamp,
      level: resolvedLevel,
      message,
    });
    ui.addLog({
      timestamp,
      level: resolvedLevel,
      message,
    });
    if (logStream) {
      logStream.write(
        `${timestamp} [${resolvedLevel}] ${stripAnsi(message)}\n`,
      );
    }
  };

  console.log = (...args: unknown[]) => {
    push("INFO", args);
    original.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("WARN", args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("ERROR", args);
    original.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    push("DEBUG", args);
    original.debug(...args);
  };

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
    if (logStream) {
      logStream.end();
    }
  };
};

registerCliCommands(program);

if (require.main === module) {
  program.parse(process.argv);
}
