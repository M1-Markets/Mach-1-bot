import * as fs from "fs";
import * as path from "path";
import { vi } from "vitest";
import {
  configFileExists,
  createConfigFromResponse,
  getStrategyInfo,
  loadConfigFromFile,
  resolveConfigPath,
  type TomlConfig,
  toBotConfig,
  validateConfig,
  writeConfigToFile,
} from "@/cli/utils/config-utils";

vi.mock("fs");
vi.mock("path", () => ({
  resolve: vi.fn((value: string) => `/resolved/${value}`),
}));
vi.mock("smol-toml", () => ({
  stringify: vi.fn(() => '[wallet]\nprivate_key = "test"'),
  parse: vi.fn(() => ({
    wallet: { private_key: "test-key" },
    network: { rpc_url: "https://test.com" },
  })),
}));

describe("config utils", () => {
  const mockFs = vi.mocked(fs);
  const mockPath = vi.mocked(path);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates config from prompt response", () => {
    const result = createConfigFromResponse({
      privateKey: "test-key",
      mode: "simulation",
      rpcUrl: "https://test.com",
      chainId: 713715,
      maxPositionSize: 1000,
      maxDailyLoss: 500,
      initialBalance: 10000,
      strategyType: "dca",
      riskLevel: "medium",
      enableAiHelper: true,
      aiHelperType: "chatgpt",
      aiHelperApiKey: "secret",
    });

    expect(result.wallet.private_key).toBe("test-key");
    expect(result.network.rpc_url).toBe("https://test.com");
    expect(result.ai_helper?.provider).toBe("chatgpt");
  });

  it("writes config to file", async () => {
    const config: TomlConfig = {
      wallet: { private_key: "test" },
      trading: {
        mode: "simulation",
        base_currency: "USDC",
        initial_balance: 10000,
        max_position_size: 1000,
        max_daily_loss: 500,
      },
      strategy: { type: "dca", risk_level: "medium" },
      network: { rpc_url: "https://test.com", chain_id: 713715 },
    };

    await writeConfigToFile(config, "/test/path.toml");

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/test/path.toml",
      expect.stringContaining("[wallet]"),
    );
  });

  it("checks config file existence", () => {
    mockFs.existsSync.mockReturnValue(true);

    expect(configFileExists("/test/path.toml")).toBe(true);
    expect(mockFs.existsSync).toHaveBeenCalledWith("/test/path.toml");
  });

  it("loads config from file", async () => {
    mockFs.readFileSync.mockReturnValue('mock = "content"');

    const result = await loadConfigFromFile("/test/path.toml");

    expect(mockFs.readFileSync).toHaveBeenCalledWith("/test/path.toml", "utf8");
    expect(result).toEqual({
      wallet: { private_key: "test-key" },
      network: { rpc_url: "https://test.com" },
    });
  });

  it("validates required fields", () => {
    expect(() =>
      validateConfig({
        wallet: { private_key: "test-key" },
        network: { rpc_url: "https://test.com" },
      }),
    ).not.toThrow();

    expect(() =>
      validateConfig({ network: { rpc_url: "https://test.com" } }),
    ).toThrow("private_key is required in [wallet] section");
    expect(() =>
      validateConfig({ wallet: { private_key: "test-key" } }),
    ).toThrow("rpc_url is required in [network] section");
  });

  it("converts config to bot config", () => {
    expect(
      toBotConfig({
        wallet: { private_key: "test-key" },
        network: { rpc_url: "https://test.com", chain_id: 12345 },
        trading: {
          mode: "live",
          max_position_size: 2000,
          max_daily_loss: 1000,
        },
      }),
    ).toEqual({
      privateKey: "test-key",
      rpcUrl: "https://test.com",
      mode: "live",
      maxPositionSize: 2000,
      maxDailyLoss: 1000,
      chainId: 12345,
      logLevel: "info",
    });
  });

  it("extracts strategy info", () => {
    expect(getStrategyInfo({})).toEqual({
      type: "dca",
      riskLevel: "medium",
    });

    expect(
      getStrategyInfo({
        strategy: { type: "grid", risk_level: "high" },
      }),
    ).toEqual({
      type: "grid",
      riskLevel: "high",
    });
  });

  it("resolves config path", () => {
    expect(resolveConfigPath("config.toml")).toBe("/resolved/config.toml");
    expect(mockPath.resolve).toHaveBeenCalledWith("config.toml");
  });
});
