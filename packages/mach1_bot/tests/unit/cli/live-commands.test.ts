import { Command } from "commander";
import { vi } from "vitest";
import { registerLiveCommands } from "@/cli/commands/live-commands";
import { createBalanceUi } from "@/cli/ui/balance-ui";
import { fetchWalletBalancesForCatalog } from "@/cli/utils/live-utils";
import { withMonacoSession } from "@/cli/utils/monaco-session";

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
    async (
      _prepared: unknown,
      fn: (value: unknown) => Promise<void>,
      onStatus?: (status: string) => void,
      _options?: unknown,
    ) => {
      onStatus?.("Authenticating with Monaco");
      onStatus?.("Loading trading pairs");
      const sdk = {
        getAuthState: () => ({ accessToken: "token" }),
        getAccountAddress: () => "0xabc",
        perps: {
          listMarginAccounts: async () => ({
            accounts: [{ margin_account_id: "margin-1" }],
          }),
          getMarginAccountSummary: async () => ({
            equity: "1500",
            free_collateral: "1200",
            initial_margin_required: "100",
            maintenance_margin_required: "50",
            withdrawable_collateral: "1100",
            realized_pnl: "10",
            unrealized_pnl: "25",
          }),
          listOpenPositions: async () => ({
            positions: [
              {
                trading_pair_id: "pair-1",
                side: "LONG",
                size: "1.25",
                entry_price: "3200",
                mark_price: "3210",
                leverage: "5",
                isolated_margin: "250",
                unrealized_pnl: "12.5",
                liquidation_price: "2900",
              },
            ],
          }),
        },
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
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ ok: true }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("runs live balance", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["balance"]);
    expect(code).toBe(0);
    const balanceController =
      await vi.mocked(createBalanceUi).mock.results[0].value;
    expect(fetchWalletBalancesForCatalog).toHaveBeenCalled();
    expect(balanceController.update).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "loading",
        status: "Connecting to Monaco",
      }),
    );
    expect(balanceController.update).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "loading",
        status: "Authenticating with Monaco",
      }),
    );
    expect(balanceController.update).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "loading",
        status: "Fetching Monaco account balances",
      }),
    );
    expect(balanceController.update).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "done",
        status: "Loaded 2 account balances and 2 wallet balances",
        balances: [
          {
            symbol: "USDC",
            available: "10",
            locked: "0",
            total: "10",
          },
          {
            symbol: "ETH",
            available: "5",
            locked: "0",
            total: "5",
          },
        ],
        walletBalances: [
          {
            label: "0x1111111111111111111111111111111111111111 (USDC)",
            balance: "100",
          },
          {
            label: "0x2222222222222222222222222222222222222222 (ETH)",
            balance: "50",
          },
        ],
      }),
    );
  });

  it("runs live balance with --no-ui", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["balance", "--no-ui"]);
    expect(code).toBe(0);
    expect(createBalanceUi).not.toHaveBeenCalled();
    expect(withMonacoSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      {
        connectWebSocket: false,
        traceProfileOnInitialize: false,
      },
    );
    expect(logSpy).toHaveBeenCalledWith("[balance] Connecting to Monaco");
    expect(logSpy).toHaveBeenCalledWith("Live account balances");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        address: "0xabc",
        profileId: "1",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith("Account Balances");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        symbol: "USDC",
        total: "10",
        available: "10",
        locked: "0",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith("Wallet Balances (On-chain)");
  });

  it("fails live balance on malformed Monaco balance payload", async () => {
    vi.mocked(withMonacoSession).mockImplementationOnce(
      async (
        _prepared: unknown,
        fn: (value: unknown) => Promise<void>,
        onStatus?: (status: string) => void,
        _options?: unknown,
      ) => {
        onStatus?.("Authenticating with Monaco");
        const sdk = {
          getAccountAddress: () => "0xabc",
          profile: {
            getProfile: async () => ({ id: "1", address: "0xabc" }),
            getUserBalances: async () => ({
              balances: [{ wrong: "shape" }],
            }),
          },
        };
        const resolver = {
          getAllPairs: () => [],
        };
        const client = {};
        await fn({ sdk, resolver, client, network: "testnet" });
      },
    );

    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["balance"]);
    expect(code).toBe(1);

    const balanceController =
      await vi.mocked(createBalanceUi).mock.results[0].value;
    expect(balanceController.update).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "error",
        status: "Balance fetch failed",
        errorMessage:
          "Profile balances response structure did not match expected Monaco fields.",
      }),
    );

    errorSpy.mockRestore();
  });

  it("runs live faucet", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["faucet"]);
    expect(code).toBe(0);
  });

  it("formats empty isolated perps account state", async () => {
    vi.mocked(withMonacoSession).mockImplementationOnce(
      async (
        _prepared: unknown,
        fn: (value: unknown) => Promise<void>,
        onStatus?: (status: string) => void,
        _options?: unknown,
      ) => {
        onStatus?.("Authenticating with Monaco");
        const sdk = {
          perps: {
            listMarginAccounts: async () => ({ accounts: [] }),
            getMarginAccountSummary: async () => {
              throw new Error("should not be called");
            },
            listOpenPositions: async () => ({ positions: [] }),
          },
        };
        await fn({ sdk, network: "testnet" });
      },
    );

    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["perps"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("[balance] Connecting to Monaco");
    expect(logSpy).toHaveBeenCalledWith("Isolated perps account");
    expect(logSpy).toHaveBeenCalledWith("  none");
    expect(logSpy).toHaveBeenCalledWith("Open Perps Positions");
    expect(logSpy).toHaveBeenCalledWith("  none");
  });

  it("formats active isolated perps position state", async () => {
    const program = new Command("live");
    registerLiveCommands(program);
    const code = await runCommand(program, ["perps"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("Isolated perps account");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        marginAccountId: "margin-1",
        equity: "1500",
        freeCollateral: "1200",
        usedMargin: "100",
        maintenanceMargin: "50",
        withdrawableCollateral: "1100",
        realizedPnl: "10",
        unrealizedPnl: "25",
      }),
    );
    expect(logSpy).toHaveBeenCalledWith("Open Perps Positions");
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({
        tradingPairId: "pair-1",
        side: "LONG",
        size: "1.25",
        entryPrice: "3200",
        markPrice: "3210",
        leverage: "5",
        collateral: "250",
        unrealizedPnl: "12.5",
        liquidationPrice: "2900",
        fundingRate: "unavailable",
        accruedFunding: "unavailable",
      }),
    );
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
