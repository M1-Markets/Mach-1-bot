import { Command } from "commander";
import { vi } from "vitest";
import { registerLiveCommands } from "@/cli/commands/live-commands";

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

vi.mock("@/cli/ui/balance-ui", () => ({
  createBalanceUi: vi.fn(async () => ({
    update: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock("@/cli/ui/faucet-ui", () => ({
  createFaucetUi: vi.fn(async () => ({
    update: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock("@/cli/ui/deposit-ui", () => ({
  createDepositUi: vi.fn(async () => ({
    update: vi.fn(),
    unmount: vi.fn(),
  })),
  promptForDepositInput: vi.fn(async () => ({
    tokenInput: "USDC",
    amountInput: "1",
  })),
}));

vi.mock("@/cli/ui/withdraw-ui", () => ({
  createWithdrawUi: vi.fn(async () => ({
    update: vi.fn(),
    unmount: vi.fn(),
  })),
  promptForWithdrawInput: vi.fn(async () => ({
    tokenInput: "USDC",
    amountInput: "1",
  })),
}));

vi.mock("@/cli/ui/swap-ui", () => ({
  createSwapUi: vi.fn(async () => ({
    update: vi.fn(),
    unmount: vi.fn(),
  })),
  promptForSwapInput: vi.fn(async () => ({
    inputToken: "USDC",
    outputToken: "ETH",
    amountInput: "1",
  })),
  promptForSwapConfirmation: vi.fn(async () => true),
}));

vi.mock("@/cli/utils/live-utils", () => ({
  assertPositiveAmountInput: vi.fn(),
  buildTokenCatalog: vi.fn(() => [
    {
      symbol: "USDC",
      assetId: "usdc-asset",
      address: "0x1111111111111111111111111111111111111111",
      decimals: 6,
    },
    {
      symbol: "ETH",
      assetId: "eth-asset",
      address: "0x2222222222222222222222222222222222222222",
      decimals: 6,
    },
  ]),
  erc20Abi: [],
  fetchWalletBalance: vi.fn(async () => 1000n),
  fetchWalletBalancesForCatalog: vi.fn(async () => {
    return new Map([
      ["0x1111111111111111111111111111111111111111", "100"],
      ["0x2222222222222222222222222222222222222222", "50"],
    ]);
  }),
  findSwapRoute: vi.fn(() => [
    {
      pair: { id: "pair-1" },
      side: "SELL",
      input: { symbol: "USDC", decimals: 6 },
      output: { symbol: "ETH", decimals: 6 },
    },
  ]),
  findTokenInfoByAddress: vi.fn(() => ({ symbol: "USDC", decimals: 6 })),
  formatDecimalAmount: vi.fn(() => "1"),
  formatEstimatedAmount: vi.fn(() => "1"),
  formatFaucetResponse: vi.fn(() => ({
    remainingRequests: 1,
    minted: ["USDC"],
    failed: [],
  })),
  getBestPrices: vi.fn(async () => ({ bestBid: 1, bestAsk: 1 })),
  getCatalogEntryByAddress: vi.fn(
    (address: string, catalog: Array<{ address: string }>) =>
      catalog.find((entry) => entry.address === address),
  ),
  isZeroAddress: vi.fn(() => false),
  resolveAssetIdFromPairs: vi.fn(() => "usdc-asset"),
  resolveFaucetBaseUrl: vi.fn(() => "https://faucet.example.com"),
  resolveTokenInfoFromSelection: vi.fn(async (token: string) => ({
    symbol: token,
    address:
      token === "ETH"
        ? "0x2222222222222222222222222222222222222222"
        : "0x1111111111111111111111111111111111111111",
    decimals: 6,
  })),
}));

vi.mock("@/cli/utils/monaco-session", () => ({
  loadBotConfigWithEnv: vi.fn(async () => ({
    environment: "staging",
  })),
  withMonacoSession: vi.fn(
    async (_prepared: unknown, fn: (value: unknown) => Promise<void>) => {
      const sdk = {
        getAuthState: () => ({ accessToken: "token" }),
        getAccountAddress: () => "0xabc",
        profile: {
          getProfile: async () => ({ id: "1", address: "0xabc" }),
          getUserBalances: async () => ({
            balances: [
              {
                asset_id: "usdc-asset",
                available_balance: "10",
                total_balance: "10",
                locked_balance: "0",
                symbol: "USDC",
              },
              {
                asset_id: "eth-asset",
                available_balance: "5",
                total_balance: "5",
                locked_balance: "0",
                symbol: "ETH",
              },
            ],
          }),
        },
        vault: {
          needsApproval: async () => false,
          approve: async () => ({ hash: "0xapproval" }),
          deposit: async () => ({ status: "confirmed", hash: "0xdep" }),
          withdraw: async () => ({
            status: "confirmed",
            hash: "0xwith",
            nonce: 1n,
          }),
        },
        trading: {
          placeMarketOrder: async () => ({
            order_id: "order-1",
            status: "SUCCESS",
            message: "ok",
          }),
        },
      };
      const resolver = {
        getAllPairs: () => [
          {
            base_token_contract: "0x1111111111111111111111111111111111111111",
            quote_token_contract: "0x2222222222222222222222222222222222222222",
            base_token: "USDC",
            quote_token: "ETH",
            symbol: "USDC/ETH",
            id: "pair-1",
          },
        ],
      };
      const client = {
        readContract: async (args: { functionName: string }) => {
          if (args.functionName === "decimals") return 6;
          return 1000n;
        },
      };
      await fn({ sdk, resolver, client, network: "testnet" });
    },
  ),
}));

const runCommand = async (command: Command, args: string[]) => {
  const exitError = new Error("process.exit");
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    (exitError as Error & { code?: number }).code = code ?? 0;
    throw exitError;
  }) as never);

  try {
    await command.parseAsync(args, { from: "user" });
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

describe("live subcommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ ok: true }),
    })) as unknown as typeof fetch;
  });

  it("runs live balance", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["balance"]);
    expect(code).toBe(0);
  });

  it("runs live faucet", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["faucet"]);
    expect(code).toBe(0);
  });

  it("runs live deposit", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["deposit", "--all"]);
    expect(code).toBe(0);
  });

  it("runs live withdraw", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["withdraw"]);
    expect(code).toBe(0);
  });

  it("runs live swap", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["swap"]);
    expect(code).toBe(0);
  });
});
