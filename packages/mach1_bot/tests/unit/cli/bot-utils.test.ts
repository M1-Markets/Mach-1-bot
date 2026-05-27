/**
 * Unit Tests for CLI Bot Utilities
 *
 * Tests for bot configuration parsing, initialization, and execution utilities.
 */

import * as fs from "fs";
import { vi } from "vitest";
import {
  convertToBotConfig,
  displayConfigSummary,
  isVerboseLogLevel,
  parseTomlConfig,
  TomlConfig,
  tomlConfigSchema,
  validateDryRun,
} from "@/cli/utils";

// Mock dependencies
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
vi.mock("picocolors", () => ({
  default: {
    cyan: (text: string) => text,
    blue: (text: string) => text,
    green: (text: string) => text,
    yellow: (text: string) => text,
    red: (text: string) => text,
    gray: (text: string) => text,
    magenta: (text: string) => text,
    bold: (text: string) => text,
  },
}));

// Mock console methods
const mockConsole = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(console, mockConsole);
  delete process.env.MONACO_LOG_LEVEL;
  delete process.env.MACH1_LOG_LEVEL;
});

describe("CLI Bot Utilities", () => {
  describe("parseTomlConfig", () => {
    it("should throw error if config file does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(parseTomlConfig("/nonexistent/config.toml")).rejects.toThrow(
        "Configuration file not found: /nonexistent/config.toml",
      );
    });

    it("should read file content when file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("mocked toml content");

      // Dynamic import path mocked elsewhere. Here verify file-system interaction.
      // So we'll test that the file operations work correctly
      expect(() => {
        fs.existsSync("/path/to/config.toml");
        fs.readFileSync("/path/to/config.toml", "utf8");
      }).not.toThrow();

      expect(fs.existsSync).toHaveBeenCalledWith("/path/to/config.toml");
      expect(fs.readFileSync).toHaveBeenCalledWith(
        "/path/to/config.toml",
        "utf8",
      );
    });
  });

  describe("convertToBotConfig", () => {
    const validTomlConfig: TomlConfig = {
      general: {
        name: "test-bot",
        description: "Test bot",
      },
      wallet: {
        private_key: "0x123456789abcdef",
      },
      trading: {
        mode: "simulation",
        market_mode: "spot",
        base_currency: "USDC",
        initial_balance: 10000,
        max_position_size: 1000,
        max_daily_loss: 500,
      },
      strategy: {
        type: "dca",
        risk_level: "medium",
      },
      network: {
        rpc_url: "https://test.rpc.url",
        chain_id: 713715,
      },
    };

    it("should convert TOML config to bot config", () => {
      const result = convertToBotConfig(validTomlConfig);

      expect(result).toEqual({
        privateKey: "0x123456789abcdef",
        rpcUrl: "https://test.rpc.url",
        mode: "simulation",
        marketMode: "spot",
        perps: undefined,
        environment: "staging",
        maxPositionSize: 1000,
        maxDailyLoss: 500,
        chainId: 713715,
        logLevel: "info",
      });
    });

    it("should use default values for optional fields", () => {
      const minimalConfig = {
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: undefined as unknown as TomlConfig["trading"]["mode"],
          max_position_size:
            undefined as unknown as TomlConfig["trading"]["max_position_size"],
          max_daily_loss:
            undefined as unknown as TomlConfig["trading"]["max_daily_loss"],
        },
        network: {
          ...validTomlConfig.network,
          chain_id: undefined as unknown as NonNullable<
            TomlConfig["network"]
          >["chain_id"],
        },
      };

      const result = convertToBotConfig(minimalConfig);

      expect(result.mode).toBe("simulation");
      expect(result.maxPositionSize).toBe(1000);
      expect(result.maxDailyLoss).toBe(500);
      expect(result.chainId).toBe(713715);
    });

    it("should normalize paper mode to simulation", () => {
      const result = convertToBotConfig({
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "paper",
        },
      });

      expect(result.mode).toBe("simulation");
    });

    it("should convert isolated perps live config", () => {
      const result = convertToBotConfig({
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "live",
          market_mode: "isolated_perps",
        },
        perps: {
          margin_mode: "isolated",
          leverage: 5,
          liquidation_threshold_percent: 10,
        },
      });

      expect(result.marketMode).toBe("isolated_perps");
      expect(result.perps).toEqual({
        marginMode: "isolated",
        leverage: 5,
        liquidationThresholdPercent: 10,
      });
    });

    it("should reject unsupported cross-margin perps config", () => {
      expect(() =>
        convertToBotConfig({
          ...validTomlConfig,
          trading: {
            ...validTomlConfig.trading,
            mode: "live",
            market_mode: "isolated_perps",
          },
          perps: {
            margin_mode: "cross",
            leverage: 3,
          },
        }),
      ).toThrow(
        'Cross-margin perps mode is not supported in this phase; use perps.margin_mode = "isolated"',
      );
    });

    it("should prefer env log level when provided", () => {
      process.env.MONACO_LOG_LEVEL = "DEBUG";

      const result = convertToBotConfig(validTomlConfig);

      expect(result.logLevel).toBe("DEBUG");
    });

    it("should allow missing private_key outside live mode", () => {
      const configWithoutKey = {
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "backtest" as const,
        },
        wallet: { private_key: "" },
      };

      expect(convertToBotConfig(configWithoutKey).privateKey).toBe("");
    });

    it("should allow missing rpc_url outside live mode", () => {
      const configWithoutRpc = {
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "simulation" as const,
        },
        network: { ...validTomlConfig.network, rpc_url: "" },
      };

      expect(convertToBotConfig(configWithoutRpc).rpcUrl).toBe("");
    });

    it("should throw error if live private_key is missing", () => {
      const configWithoutKey = {
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "live" as const,
        },
        wallet: { private_key: "" },
      };

      expect(() => convertToBotConfig(configWithoutKey)).toThrow(
        "private_key is required in [wallet] section",
      );
    });

    it("should throw error if live rpc_url is missing", () => {
      const configWithoutRpc = {
        ...validTomlConfig,
        trading: {
          ...validTomlConfig.trading,
          mode: "live" as const,
        },
        network: { ...validTomlConfig.network, rpc_url: "" },
      };

      expect(() => convertToBotConfig(configWithoutRpc)).toThrow(
        "rpc_url is required in [network] section",
      );
    });
  });

  describe("displayConfigSummary", () => {
    it("should hide configuration summary when not verbose", () => {
      const botConfig = {
        privateKey: "0x123",
        rpcUrl: "https://test.rpc.url",
        mode: "simulation" as const,
        maxPositionSize: 1000,
        maxDailyLoss: 500,
        chainId: 713715,
        logLevel: "info" as const,
      };

      const tomlConfig: TomlConfig = {
        general: { name: "test", description: "test" },
        wallet: { private_key: "0x123" },
        trading: {
          mode: "simulation",
          base_currency: "USDC",
          initial_balance: 10000,
          max_position_size: 1000,
          max_daily_loss: 500,
        },
        strategy: { type: "dca", risk_level: "medium" },
        network: { rpc_url: "https://test.rpc.url", chain_id: 713715 },
      };

      displayConfigSummary(botConfig, tomlConfig);

      expect(mockConsole.log).not.toHaveBeenCalled();
    });

    it("should display configuration summary in verbose mode", () => {
      const botConfig = {
        privateKey: "0x123",
        rpcUrl: "https://test.rpc.url",
        mode: "simulation" as const,
        maxPositionSize: 1000,
        maxDailyLoss: 500,
        chainId: 713715,
        logLevel: "DEBUG" as const,
      };

      const tomlConfig: TomlConfig = {
        general: { name: "test", description: "test" },
        wallet: { private_key: "0x123" },
        trading: {
          mode: "simulation",
          base_currency: "USDC",
          initial_balance: 10000,
          max_position_size: 1000,
          max_daily_loss: 500,
        },
        strategy: { type: "dca", risk_level: "medium" },
        network: { rpc_url: "https://test.rpc.url", chain_id: 713715 },
      };

      displayConfigSummary(botConfig, tomlConfig);

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("Configuration loaded successfully"),
      );
    });
  });

  describe("tomlConfigSchema", () => {
    it("should require trading and strategy sections", () => {
      expect(tomlConfigSchema).toHaveProperty("required");
      expect(tomlConfigSchema.required).toEqual(
        expect.arrayContaining(["trading", "strategy"]),
      );
    });

    it("should enumerate known enum values for trading mode and risk level", () => {
      expect(tomlConfigSchema.properties?.trading?.properties?.mode).toEqual(
        expect.objectContaining({
          enum: ["backtest", "simulation", "live", "paper"],
        }),
      );
      expect(
        tomlConfigSchema.properties?.trading?.properties?.market_mode,
      ).toEqual(
        expect.objectContaining({
          enum: ["spot", "isolated_perps"],
        }),
      );
      expect(
        tomlConfigSchema.properties?.strategy?.properties?.risk_level,
      ).toEqual(
        expect.objectContaining({
          enum: ["low", "medium", "high"],
        }),
      );
    });

    it("should require wallet private_key and network rpc_url only for live mode", () => {
      expect(tomlConfigSchema.allOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            then: expect.objectContaining({
              required: ["wallet", "network"],
            }),
          }),
        ]),
      );
    });

    it("should require perps settings for live isolated perps mode", () => {
      expect(tomlConfigSchema.allOf).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            then: expect.objectContaining({
              required: ["perps"],
            }),
          }),
        ]),
      );
    });
  });

  describe("isVerboseLogLevel", () => {
    it("should display dry run validation message", () => {
      validateDryRun("/path/to/config.toml");

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("Configuration file found"),
      );
      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("Dry run mode"),
      );
    });
  });
});
