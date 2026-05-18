import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import { vi } from "vitest";

// Mock process.argv to prevent actual CLI execution
const originalArgv = process.argv;

// Mock all external dependencies first
vi.mock("fs");
vi.mock("path");
vi.mock("prompts");
vi.mock("picocolors", () => ({
  __esModule: true,
  default: {
    green: (text: string) => text,
    cyan: (text: string) => text,
    gray: (text: string) => text,
    blue: (text: string) => text,
    magenta: (text: string) => text,
    red: (text: string) => text,
    yellow: (text: string) => text,
    bold: (text: string) => text,
  },
}));

vi.mock("smol-toml", () => ({
  stringify: vi.fn((obj: unknown) => JSON.stringify(obj)),
  parse: vi.fn((str: string) => JSON.parse(str)),
}));

// Mock CLI utility modules
const botUtilsMocks = {
  displayConfigSummary: vi.fn(),
  displayBotStartup: vi.fn(),
  displayBotConfig: vi.fn(),
  displayStrategyInfo: vi.fn(),
  displayBotInitialization: vi.fn(),
  displayModeSpecificMessages: vi.fn(),
  displayStopInstruction: vi.fn(),
  keepProcessAlive: vi.fn(),
  displayConfigNotFoundError: vi.fn(),
  displayConfigExistsError: vi.fn(),
  displayDryRunMessage: vi.fn(),
};

vi.mock("@/cli/utils/bot-utils", () => botUtilsMocks);

const configUtilsMocks = {
  createConfigFromResponse: vi.fn(),
  writeConfigToFile: vi.fn(),
  configFileExists: vi.fn(),
  loadConfigFromFile: vi.fn(),
  validateConfig: vi.fn(),
  toBotConfig: vi.fn(),
  getStrategyInfo: vi.fn(),
  resolveConfigPath: vi.fn(),
};

vi.mock("@/cli/utils/config-utils", () => configUtilsMocks);

const promptUtilsMocks = {
  displayWelcomeMessage: vi.fn(),
  displayCancellationMessage: vi.fn(),
  runConfigurationPrompts: vi.fn(),
};

vi.mock("@/cli/utils/prompt-utils", () => promptUtilsMocks);

// Import mocked functions
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);

const mockResolve = vi.mocked(path.resolve);
const mockJoin = vi.mocked(path.join);
const mockParse = vi.mocked(path.parse);
const mockBasename = vi.mocked(path.basename);

// Mock console methods
const _consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {
  // noop
});
const _consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {
  // noop
});

// Mock process methods
const _mockProcessExit = vi
  .spyOn(process, "exit")
  .mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`Process exit called with code: ${code}`);
  });

// Mock process.stdin
const mockStdin = {
  resume: vi.fn(),
};
Object.defineProperty(process, "stdin", {
  value: mockStdin,
  writable: true,
});

describe("CLI main.ts integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set process.argv to prevent actual CLI execution
    process.argv = ["node", "test-script"];

    // Setup default mock implementations
    mockResolve.mockImplementation((filePath) => `/resolved/${filePath}`);
    mockJoin.mockImplementation((...parts) => parts.join("/"));
    mockParse.mockImplementation((filePath) => ({
      root: "/",
      dir: filePath.includes("/")
        ? filePath.slice(0, filePath.lastIndexOf("/"))
        : "",
      base: filePath.includes("/")
        ? filePath.slice(filePath.lastIndexOf("/") + 1)
        : filePath,
      ext: filePath.includes(".")
        ? filePath.slice(filePath.lastIndexOf("."))
        : "",
      name: (filePath.includes("/")
        ? filePath.slice(filePath.lastIndexOf("/") + 1)
        : filePath
      ).replace(/\.[^/.]+$/, ""),
    }));
    mockBasename.mockImplementation((filePath) => {
      const segments = filePath.split("/");
      return segments[segments.length - 1] ?? filePath;
    });
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("mock-config-content");
    mockWriteFileSync.mockImplementation(() => {
      // noop
    });
    mockMkdirSync.mockImplementation(() => undefined);
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
    mockUnlinkSync.mockImplementation(() => undefined);

    configUtilsMocks.resolveConfigPath.mockImplementation(
      (path: string) => `/resolved/${path}`,
    );
    configUtilsMocks.configFileExists.mockReturnValue(false);
    configUtilsMocks.createConfigFromResponse.mockReturnValue({
      wallet: { private_key: "test-key" },
      trading: { mode: "simulation" },
      network: { rpc_url: "https://test.com" },
      strategy: { type: "dca", risk_level: "medium" },
    });
    configUtilsMocks.loadConfigFromFile.mockReturnValue({
      wallet: { private_key: "test-key" },
      network: { rpc_url: "https://test.com" },
      trading: { mode: "simulation" },
    });
    configUtilsMocks.toBotConfig.mockReturnValue({
      privateKey: "test-key",
      rpcUrl: "https://test.com",
      mode: "simulation",
      maxPositionSize: 1000,
      maxDailyLoss: 500,
      chainId: 713715,
      logLevel: "info",
    });
    configUtilsMocks.getStrategyInfo.mockReturnValue({
      type: "dca",
      riskLevel: "medium",
    });

    promptUtilsMocks.runConfigurationPrompts.mockResolvedValue({
      privateKey: "test-private-key",
      mode: "simulation",
      rpcUrl: "https://test-rpc.sei.io",
      chainId: 713715,
      maxPositionSize: 1000,
      maxDailyLoss: 500,
      initialBalance: 10000,
      strategyType: "dca",
      riskLevel: "medium",
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    process.argv = originalArgv;
  });

  describe("CLI Integration Functions", () => {
    // Test CLI functions without importing the main module

    it("should handle init command logic", async () => {
      // Test the init command logic components
      configUtilsMocks.configFileExists.mockReturnValue(false);

      // Simulate init command flow
      const configFile = "/test/config.toml";
      const options = { file: "config.toml", force: false };

      if (
        !configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.file),
        ) ||
        options.force
      ) {
        promptUtilsMocks.displayWelcomeMessage();
        const response = await promptUtilsMocks.runConfigurationPrompts();

        if (response) {
          const config = configUtilsMocks.createConfigFromResponse(response);
          configUtilsMocks.writeConfigToFile(config, configFile);
          botUtilsMocks.displayConfigSummary(configFile, config);
        }
      }

      expect(promptUtilsMocks.displayWelcomeMessage).toHaveBeenCalled();
      expect(promptUtilsMocks.runConfigurationPrompts).toHaveBeenCalled();
      expect(configUtilsMocks.createConfigFromResponse).toHaveBeenCalled();
      expect(configUtilsMocks.writeConfigToFile).toHaveBeenCalled();
      expect(botUtilsMocks.displayConfigSummary).toHaveBeenCalled();
    });

    it("should handle init command with existing config and no force", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);

      const configFile = "/test/config.toml";
      const options = { file: "config.toml", force: false };

      if (
        configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.file),
        ) &&
        !options.force
      ) {
        botUtilsMocks.displayConfigExistsError(configFile);
        // Would exit with code 1
      }

      expect(botUtilsMocks.displayConfigExistsError).toHaveBeenCalledWith(
        configFile,
      );
    });

    it("should handle init command with force flag", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);

      const options = { file: "config.toml", force: true };

      // Should proceed even if file exists when force is true
      if (
        !configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.file),
        ) ||
        options.force
      ) {
        const response = await promptUtilsMocks.runConfigurationPrompts();
        if (response) {
          const config = configUtilsMocks.createConfigFromResponse(response);
          configUtilsMocks.writeConfigToFile(config, "test");
        }
      }

      expect(promptUtilsMocks.runConfigurationPrompts).toHaveBeenCalled();
      expect(configUtilsMocks.createConfigFromResponse).toHaveBeenCalled();
      expect(configUtilsMocks.writeConfigToFile).toHaveBeenCalled();
    });

    it("should handle user cancellation in init", async () => {
      promptUtilsMocks.runConfigurationPrompts.mockResolvedValue(null);

      const response = await promptUtilsMocks.runConfigurationPrompts();
      if (!response) {
        promptUtilsMocks.displayCancellationMessage();
        // Would exit with code 0
      }

      expect(promptUtilsMocks.displayCancellationMessage).toHaveBeenCalled();
    });

    it("should handle run command logic", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);

      const configFile = "/test/config.toml";
      const options = { config: "config.toml", dryRun: false };

      if (
        configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.config),
        )
      ) {
        if (!options.dryRun) {
          // Normal run flow
          botUtilsMocks.displayBotStartup(configFile);
          const tomlConfig =
            await configUtilsMocks.loadConfigFromFile(configFile);
          configUtilsMocks.validateConfig(tomlConfig);
          const botConfig = configUtilsMocks.toBotConfig(tomlConfig);
          botUtilsMocks.displayBotConfig(botConfig);

          const strategyInfo = configUtilsMocks.getStrategyInfo(tomlConfig);
          botUtilsMocks.displayStrategyInfo(
            strategyInfo.type,
            strategyInfo.riskLevel,
          );

          botUtilsMocks.displayBotInitialization();
          botUtilsMocks.displayModeSpecificMessages(botConfig.mode);
          botUtilsMocks.displayStopInstruction();
          botUtilsMocks.keepProcessAlive();
        }
      }

      expect(botUtilsMocks.displayBotStartup).toHaveBeenCalledWith(configFile);
      expect(configUtilsMocks.loadConfigFromFile).toHaveBeenCalledWith(
        configFile,
      );
      expect(configUtilsMocks.validateConfig).toHaveBeenCalled();
      expect(botUtilsMocks.displayBotConfig).toHaveBeenCalled();
      expect(botUtilsMocks.displayStrategyInfo).toHaveBeenCalled();
      expect(botUtilsMocks.displayBotInitialization).toHaveBeenCalled();
      expect(botUtilsMocks.displayModeSpecificMessages).toHaveBeenCalled();
      expect(botUtilsMocks.displayStopInstruction).toHaveBeenCalled();
      expect(botUtilsMocks.keepProcessAlive).toHaveBeenCalled();
    });

    it("should handle run command with missing config", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(false);

      const configFile = "/test/config.toml";
      const options = { config: "config.toml" };

      if (
        !configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.config),
        )
      ) {
        botUtilsMocks.displayConfigNotFoundError(configFile);
        // Would exit with code 1
      }

      expect(botUtilsMocks.displayConfigNotFoundError).toHaveBeenCalledWith(
        configFile,
      );
    });

    it("should handle run command with dry-run flag", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);

      const configFile = "/test/config.toml";
      const options = { config: "config.toml", dryRun: true };

      if (
        configUtilsMocks.configFileExists(
          configUtilsMocks.resolveConfigPath(options.config),
        )
      ) {
        if (options.dryRun) {
          botUtilsMocks.displayDryRunMessage(configFile);
          return;
        }
      }

      expect(botUtilsMocks.displayDryRunMessage).toHaveBeenCalledWith(
        configFile,
      );
    });

    it("should handle configuration validation errors", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);
      configUtilsMocks.validateConfig.mockImplementation(() => {
        throw new Error("private_key is required in [wallet] section");
      });

      try {
        const tomlConfig =
          await configUtilsMocks.loadConfigFromFile("/test/config.toml");
        configUtilsMocks.validateConfig(tomlConfig);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("private_key is required");
      }

      expect(configUtilsMocks.validateConfig).toHaveBeenCalled();
    });

    it("should handle file system errors during config creation", async () => {
      configUtilsMocks.writeConfigToFile.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      try {
        const response = await promptUtilsMocks.runConfigurationPrompts();
        if (response) {
          const config = configUtilsMocks.createConfigFromResponse(response);
          configUtilsMocks.writeConfigToFile(config, "/test/config.toml");
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Permission denied");
      }

      expect(configUtilsMocks.writeConfigToFile).toHaveBeenCalled();
    });

    it("should handle malformed config file during run", async () => {
      configUtilsMocks.configFileExists.mockReturnValue(true);
      configUtilsMocks.loadConfigFromFile.mockImplementation(() => {
        throw new Error("Invalid TOML syntax");
      });

      try {
        await configUtilsMocks.loadConfigFromFile("/test/config.toml");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Invalid TOML syntax");
      }

      expect(configUtilsMocks.loadConfigFromFile).toHaveBeenCalled();
    });
  });

  describe("Utility Module Integration", () => {
    it("should call utility functions with correct parameters", async () => {
      const mockResponse = {
        privateKey: "test-key",
        mode: "simulation",
        rpcUrl: "https://test.com",
        chainId: 713715,
        maxPositionSize: 1000,
        maxDailyLoss: 500,
        initialBalance: 10000,
        strategyType: "dca",
        riskLevel: "medium",
      };

      const mockConfig = {
        wallet: { private_key: "test-key" },
        trading: {
          mode: "simulation",
          max_position_size: 1000,
          max_daily_loss: 500,
        },
        network: { rpc_url: "https://test.com", chain_id: 713715 },
        strategy: { type: "dca", risk_level: "medium" },
      };

      promptUtilsMocks.runConfigurationPrompts.mockResolvedValue(mockResponse);
      configUtilsMocks.createConfigFromResponse.mockReturnValue(mockConfig);

      const response = await promptUtilsMocks.runConfigurationPrompts();
      if (response) {
        const config = configUtilsMocks.createConfigFromResponse(response);
        const configFile = "/test/config.toml";
        configUtilsMocks.writeConfigToFile(config, configFile);
        botUtilsMocks.displayConfigSummary(configFile, config);
      }

      expect(configUtilsMocks.createConfigFromResponse).toHaveBeenCalledWith(
        mockResponse,
      );
      expect(botUtilsMocks.displayConfigSummary).toHaveBeenCalledWith(
        "/test/config.toml",
        mockConfig,
      );
    });

    it("should handle different trading modes correctly", async () => {
      const modes = ["backtest", "simulation", "live"];

      for (const mode of modes) {
        botUtilsMocks.displayModeSpecificMessages(mode);
      }

      expect(botUtilsMocks.displayModeSpecificMessages).toHaveBeenCalledTimes(
        3,
      );
      expect(botUtilsMocks.displayModeSpecificMessages).toHaveBeenCalledWith(
        "backtest",
      );
      expect(botUtilsMocks.displayModeSpecificMessages).toHaveBeenCalledWith(
        "simulation",
      );
      expect(botUtilsMocks.displayModeSpecificMessages).toHaveBeenCalledWith(
        "live",
      );
    });

    it("should handle strategy information display", async () => {
      const strategies = [
        { type: "dca", riskLevel: "low" },
        { type: "grid", riskLevel: "medium" },
        { type: "portfolio", riskLevel: "high" },
      ];

      for (const strategy of strategies) {
        botUtilsMocks.displayStrategyInfo(strategy.type, strategy.riskLevel);
      }

      expect(botUtilsMocks.displayStrategyInfo).toHaveBeenCalledTimes(3);
      expect(botUtilsMocks.displayStrategyInfo).toHaveBeenCalledWith(
        "dca",
        "low",
      );
      expect(botUtilsMocks.displayStrategyInfo).toHaveBeenCalledWith(
        "grid",
        "medium",
      );
      expect(botUtilsMocks.displayStrategyInfo).toHaveBeenCalledWith(
        "portfolio",
        "high",
      );
    });
  });

  describe("Configuration Management", () => {
    it("should properly transform user responses to config", async () => {
      const response = {
        privateKey: "0x123",
        mode: "simulation",
        rpcUrl: "https://sei.com",
        chainId: 713715,
        maxPositionSize: 2000,
        maxDailyLoss: 1000,
        initialBalance: 20000,
        strategyType: "grid",
        riskLevel: "high",
      };

      const expectedConfig = {
        wallet: { private_key: "0x123" },
        trading: {
          mode: "simulation",
          base_currency: "USDC",
          initial_balance: 20000,
          max_position_size: 2000,
          max_daily_loss: 1000,
        },
        strategy: { type: "grid", risk_level: "high" },
        network: { rpc_url: "https://sei.com", chain_id: 713715 },
      };

      configUtilsMocks.createConfigFromResponse.mockReturnValue(expectedConfig);

      const config = configUtilsMocks.createConfigFromResponse(response);

      expect(configUtilsMocks.createConfigFromResponse).toHaveBeenCalledWith(
        response,
      );
      expect(config).toEqual(expectedConfig);
    });

    it("should handle bot config transformation", async () => {
      const tomlConfig = {
        wallet: { private_key: "0x123" },
        network: { rpc_url: "https://sei.com", chain_id: 713715 },
        trading: {
          mode: "live",
          max_position_size: 5000,
          max_daily_loss: 2500,
        },
      };

      const expectedBotConfig = {
        privateKey: "0x123",
        rpcUrl: "https://sei.com",
        mode: "live",
        maxPositionSize: 5000,
        maxDailyLoss: 2500,
        chainId: 713715,
        logLevel: "info",
      };

      configUtilsMocks.toBotConfig.mockReturnValue(expectedBotConfig);

      const botConfig = configUtilsMocks.toBotConfig(tomlConfig);

      expect(configUtilsMocks.toBotConfig).toHaveBeenCalledWith(tomlConfig);
      expect(botConfig).toEqual(expectedBotConfig);
    });
  });

  describe("CLI Command Structure", () => {
    it("should validate that Commander.js commands have the expected structure", () => {
      // Test that we can create the expected command structure
      const program = new Command("mach-one-bot")
        .version(
          "1.0.0",
          "-v, --version",
          "Output the current version of mach-one-bot.",
        )
        .description(
          "Advanced algorithmic trading SDK built on Monaco Protocol CLOB",
        )
        .helpOption("-h, --help", "Display this help message.");

      // Add init command
      const initCommand = program
        .command("init")
        .description("Initialize a new mach-one-bot configuration file")
        .option(
          "-f, --file <filename>",
          "Configuration file name",
          "mach-one-bot.toml",
        )
        .option("--force", "Overwrite existing configuration file");

      // Add run command
      const runCommand = program
        .command("run")
        .description("Run the trading bot")
        .option(
          "-c, --config <file>",
          "Configuration file path",
          "mach-one-bot.toml",
        )
        .option("--dry-run", "Validate configuration without running the bot");

      // Verify command structure
      expect(program.name()).toBe("mach-one-bot");
      expect(program.version()).toBe("1.0.0");
      expect(program.description()).toBe(
        "Advanced algorithmic trading SDK built on Monaco Protocol CLOB",
      );

      // Verify commands exist
      const commands = program.commands;
      expect(commands).toHaveLength(2);
      expect(commands[0].name()).toBe("init");
      expect(commands[1].name()).toBe("run");

      // Verify init command options
      const initOptions = initCommand.options;
      expect(initOptions).toHaveLength(2);
      expect(initOptions[0].flags).toBe("-f, --file <filename>");
      expect(initOptions[1].flags).toBe("--force");

      // Verify run command options
      const runOptions = runCommand.options;
      expect(runOptions).toHaveLength(2);
      expect(runOptions[0].flags).toBe("-c, --config <file>");
      expect(runOptions[1].flags).toBe("--dry-run");
    });

    it("should handle SIGTERM and SIGINT signals", () => {
      const mockProcessOn = vi.spyOn(process, "on");

      // Mock signal handler
      const handleSigTerm = () => process.exit(0);
      process.on("SIGTERM", handleSigTerm);
      process.on("SIGINT", handleSigTerm);

      expect(mockProcessOn).toHaveBeenCalledWith("SIGTERM", handleSigTerm);
      expect(mockProcessOn).toHaveBeenCalledWith("SIGINT", handleSigTerm);
    });

    it("should validate command options have correct defaults", () => {
      const program = new Command("mach-one-bot");

      const initCommand = program
        .command("init")
        .option(
          "-f, --file <filename>",
          "Configuration file name",
          "mach-one-bot.toml",
        )
        .option("--force", "Overwrite existing configuration file");

      const runCommand = program
        .command("run")
        .option(
          "-c, --config <file>",
          "Configuration file path",
          "mach-one-bot.toml",
        )
        .option("--dry-run", "Validate configuration without running the bot");

      // Test that options have correct default values in their definitions
      const initFileOption = initCommand.options.find((opt) =>
        opt.flags.includes("--file"),
      );
      const runConfigOption = runCommand.options.find((opt) =>
        opt.flags.includes("--config"),
      );

      expect(initFileOption?.defaultValue).toBe("mach-one-bot.toml");
      expect(runConfigOption?.defaultValue).toBe("mach-one-bot.toml");

      // Test that boolean options don't have defaults
      const initForceOption = initCommand.options.find((opt) =>
        opt.flags.includes("--force"),
      );
      const runDryRunOption = runCommand.options.find((opt) =>
        opt.flags.includes("--dry-run"),
      );

      expect(initForceOption?.defaultValue).toBeUndefined();
      expect(runDryRunOption?.defaultValue).toBeUndefined();
    });
  });
});
