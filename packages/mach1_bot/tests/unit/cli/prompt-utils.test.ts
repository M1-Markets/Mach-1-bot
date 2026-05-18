import prompts from "prompts";
import { vi } from "vitest";
import {
  CONFIG_PROMPTS,
  displayCancellationMessage,
  displayWelcomeMessage,
  runConfigurationPrompts,
  validatePrivateKey,
} from "@/cli/utils/prompt-utils";

vi.mock("prompts", () => ({
  default: vi.fn(),
}));
vi.mock("picocolors", () => ({
  default: {
    cyan: (text: string) => text,
    blue: (text: string) => text,
    green: (text: string) => text,
    yellow: (text: string) => text,
    red: (text: string) => text,
    gray: (text: string) => text,
  },
}));

describe("prompt utils", () => {
  const mockPrompts = vi.mocked(prompts);
  // biome-ignore lint/suspicious/noEmptyBlockStatements: this is a mock implementation
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defines expected prompt fields", () => {
    const promptNames = CONFIG_PROMPTS.map((prompt) => prompt.name);

    expect(promptNames).toEqual([
      "privateKey",
      "mode",
      "rpcUrl",
      "chainId",
      "maxPositionSize",
      "maxDailyLoss",
      "initialBalance",
      "strategyType",
      "riskLevel",
    ]);
  });

  it("keeps expected defaults", () => {
    const rpcUrlPrompt = CONFIG_PROMPTS.find(
      (prompt) => prompt.name === "rpcUrl",
    );
    const chainIdPrompt = CONFIG_PROMPTS.find(
      (prompt) => prompt.name === "chainId",
    );

    expect(rpcUrlPrompt?.initial).toBe("https://evm-rpc-testnet.sei.io");
    expect(chainIdPrompt?.initial).toBe(713715);
  });

  it("prints welcome message", () => {
    displayWelcomeMessage();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Welcome to Mach-One Bot Configuration Setup!"),
    );
  });

  it("prints cancellation message", () => {
    displayCancellationMessage();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Configuration cancelled."),
    );
  });

  it("returns prompt response", async () => {
    const response = {
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
    mockPrompts.mockResolvedValue(response);

    await expect(runConfigurationPrompts()).resolves.toEqual(response);
    expect(mockPrompts).toHaveBeenCalledWith(CONFIG_PROMPTS);
  });

  it("returns null on cancel", async () => {
    mockPrompts.mockResolvedValue({});

    await expect(runConfigurationPrompts()).resolves.toBeNull();
  });

  it("validates private key", () => {
    expect(validatePrivateKey("test-private-key")).toBe(true);
    expect(validatePrivateKey("")).toBe("Private key is required");
    expect(validatePrivateKey("   ")).toBe("Private key is required");
  });
});
