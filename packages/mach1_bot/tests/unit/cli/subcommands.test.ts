import * as fs from "fs";
import { Command } from "commander";
import prompts from "prompts";
import { vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
}));

vi.mock("path", () => ({
  resolve: vi.fn((value: string) => `/resolved/${value}`),
  parse: vi.fn((value: string) => ({
    name: value.replace(/\.[^/.]+$/, ""),
  })),
  basename: vi.fn((value: string) => value),
}));

vi.mock("prompts", () => ({
  default: vi.fn(),
}));

vi.mock("smol-toml", () => ({
  stringify: vi.fn(() => "toml"),
  parse: vi.fn(() => ({})),
}));

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

const mockUtils = {
  BotInitializationOptions: {},
  convertToBotConfig: vi.fn(() => ({
    privateKey: "0x1",
    rpcUrl: "https://test",
    mode: "simulation",
    environment: "staging",
    maxPositionSize: 1000,
    maxDailyLoss: 500,
    chainId: 713715,
    logLevel: "info",
  })),
  displayConfigSummary: vi.fn(),
  displayStrategiesByCategory: vi.fn(),
  displayStrategiesTable: vi.fn(),
  displayStrategyDetails: vi.fn(),
  executeBotMode: vi.fn(),
  getAvailableCategories: vi.fn(async () => ["dca"]),
  getAvailableStrategies: vi.fn(async () => []),
  getAvailableTags: vi.fn(async () => ["tag"]),
  getDefaultAiPrompt: vi.fn(() => "prompt"),
  getStrategiesByCategory: vi.fn(async () => []),
  getStrategyById: vi.fn(async () => ({
    id: "dca",
    name: "DCA",
  })),
  initializeMach1Bot: vi.fn(async () => ({
    emergencyStop: vi.fn(),
  })),
  parseTomlConfig: vi.fn(async () => ({
    wallet: { private_key: "0x1" },
    network: { rpc_url: "https://test" },
    trading: { mode: "simulation", initial_balance: 10000 },
    strategy: { type: "dca", risk_level: "medium" },
  })),
  searchStrategies: vi.fn(async () => []),
  validateDryRun: vi.fn(),
};

vi.mock("@/cli/utils", () => mockUtils);

vi.mock("@/cli/utils/monaco-session", () => ({
  resolveEnvironmentOption: vi.fn(() => "staging"),
}));

vi.mock("@/cli/ui/run-ui", () => ({
  createRunUi: vi.fn(async () => ({
    addOrder: vi.fn(),
    addLog: vi.fn(),
    setStatus: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock("@/cli/ui/supervisor-ui", () => ({
  createSupervisorUi: vi.fn(async () => ({
    appendLine: vi.fn(),
    setPaneStatus: vi.fn(),
    setStatus: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock("@/cli/commands/live-commands", () => ({
  registerLiveCommands: vi.fn(),
}));

const mockPrompts = vi.mocked(prompts);
const mockFs = vi.mocked(fs);

const createProgram = async () => {
  const { createCliProgram, registerCliCommands } = await import("@/cli/main");
  const program = createCliProgram();
  registerCliCommands(program);
  return program;
};

const runCommand = async (program: Command, args: string[]) => {
  const exitError = new Error("process.exit");
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    (exitError as Error & { code?: number }).code = code ?? 0;
    throw exitError;
  }) as never);

  try {
    await program.parseAsync(args, { from: "user" });
    return 0;
  } catch (error) {
    if (error === exitError) {
      return (exitError as Error & { code?: number }).code ?? 0;
    }
    throw error;
  } finally {
    exitSpy.mockRestore();
  }
};

describe("CLI subcommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MACH_ONE_NO_UI = "1";
  });

  afterEach(() => {
    delete process.env.MACH_ONE_NO_UI;
  });

  it("runs init", async () => {
    mockPrompts.mockResolvedValue({
      privateKey: "0x1",
      mode: "simulation",
      rpcUrl: "https://test",
      chainId: 713715,
      maxPositionSize: 1000,
      maxDailyLoss: 500,
      initialBalance: 10000,
      strategyType: "dca",
      riskLevel: "medium",
    });

    const program = await createProgram();
    const code = await runCommand(program, ["init", "--file", "bot.toml"]);

    expect(code).toBe(0);
  });

  it("runs run --dry-run", async () => {
    mockFs.existsSync.mockReturnValue(true);
    const program = await createProgram();
    const code = await runCommand(program, [
      "run",
      "--dry-run",
      "-c",
      "a.toml",
    ]);

    expect(code).toBe(0);
    expect(mockUtils.validateDryRun).toHaveBeenCalledWith("/resolved/a.toml");
  });

  it("runs run --no-ui --dry-run", async () => {
    mockFs.existsSync.mockReturnValue(true);
    delete process.env.MACH_ONE_NO_UI;

    const program = await createProgram();
    const code = await runCommand(program, [
      "run",
      "--no-ui",
      "--dry-run",
      "-c",
      "a.toml",
    ]);

    expect(code).toBe(0);
    expect(process.env.MACH_ONE_NO_UI).toBe("1");
    expect(mockUtils.validateDryRun).toHaveBeenCalledWith("/resolved/a.toml");
  });

  it("runs strategy list", async () => {
    const program = await createProgram();
    const code = await runCommand(program, ["strategy", "list"]);

    expect(code).toBe(0);
    expect(mockUtils.getAvailableStrategies).toHaveBeenCalled();
    expect(mockUtils.displayStrategiesTable).toHaveBeenCalled();
  });

  it("runs strategy show <id>", async () => {
    const program = await createProgram();
    const code = await runCommand(program, ["strategy", "show", "dca"]);

    expect(code).toBe(0);
    expect(mockUtils.getStrategyById).toHaveBeenCalledWith("dca");
    expect(mockUtils.displayStrategyDetails).toHaveBeenCalled();
  });
});
