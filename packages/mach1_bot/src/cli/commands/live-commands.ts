import type { Command } from "commander";
import {
  buildMonacoSessionHeaders,
  CreateMarginAccountResponse,
  GetAvailableCollateralResponse,
  GetUserBalancesResponse,
  ListMarginAccountsResponse,
  ListPositionsResponse,
  MarginAccountSummary,
  TransferCollateralResponse,
  UserProfile,
} from "mach1_sdk";
import pc from "picocolors";
import { formatUnits, parseUnits } from "viem";
import {
  type BalanceRow,
  type BalanceUiController,
  createBalanceUi,
  type WalletBalanceRow,
} from "@/cli/ui/balance-ui";
import {
  createDepositUi,
  type DepositTokenOption,
  type DepositUiController,
  type DepositUiState,
  promptForDepositInput,
} from "@/cli/ui/deposit-ui";
import {
  createFaucetUi,
  type FaucetUiController,
  type FaucetUiState,
} from "@/cli/ui/faucet-ui";
import {
  createSwapUi,
  promptForSwapConfirmation,
  promptForSwapInput,
  type SwapTokenOption,
  type SwapUiController,
  type SwapUiState,
} from "@/cli/ui/swap-ui";
import {
  createWithdrawUi,
  promptForWithdrawInput,
  type WithdrawTokenOption,
  type WithdrawUiController,
  type WithdrawUiState,
} from "@/cli/ui/withdraw-ui";
import {
  assertPositiveAmountInput,
  buildTokenCatalog,
  fetchWalletBalance,
  fetchWalletBalancesForCatalog,
  findSwapRoute,
  formatDecimalAmount,
  formatEstimatedAmount,
  formatFaucetResponse,
  getBestPrices,
  getCatalogEntryByAddress,
  isZeroAddress,
  resolveAssetIdFromPairs,
  resolveFaucetBaseUrl,
  resolveTokenInfoFromSelection,
  type SwapLeg,
  type TokenLikePair,
} from "@/cli/utils/live-utils";
import {
  loadBotConfigWithEnv,
  withMonacoSession,
} from "@/cli/utils/monaco-session";
import { getStringProp, isRecord } from "@/shared/utils/record-utils";

const SEISCAN_TESTNET_TX_BASE_URL = "https://seiscan.com/testnet/tx";

const buildSeiscanTxUrl = (hash: string): string =>
  `${SEISCAN_TESTNET_TX_BASE_URL}/${hash}`;

type ProfileBalanceEntry = {
  assetId: string;
  available: string;
  total: string;
  locked: string;
  symbol: string | undefined;
};

type LiveBalanceResult = {
  profile: UserProfile;
  address: string;
  accountRows: BalanceRow[];
  walletRows: WalletBalanceRow[];
};

type IsolatedPerpsSummaryRow = {
  marginAccountId: string;
  equity: string;
  freeCollateral: string;
  usedMargin: string;
  maintenanceMargin: string;
  withdrawableCollateral: string;
  realizedPnl: string;
  unrealizedPnl: string;
};

type IsolatedPerpsPositionRow = {
  tradingPairId: string;
  side: string;
  size: string;
  entryPrice: string;
  markPrice: string;
  leverage: string;
  collateral: string;
  unrealizedPnl: string;
  liquidationPrice: string;
  fundingRate: string;
  accruedFunding: string;
};

type LivePerpsResult = {
  summary?: IsolatedPerpsSummaryRow;
  positions: IsolatedPerpsPositionRow[];
};

type MarginAccountListRow = {
  marginAccountId: string;
  label: string;
  state: string;
  collateralAsset: string;
  equity: string;
  freeCollateral: string;
  withdrawableCollateral: string;
  updatedAt: string;
};

const shouldTraceMonacoApi = (): boolean =>
  process.env.MACH1_TRACE_MONACO === "1" ||
  process.env.MACH1_TRACE_MONACO === "true";

const getCliViewport = () => ({
  width: Math.max(40, process.stdout.columns ?? 80),
  height: Math.max(12, process.stdout.rows ?? 24),
});

const summarizeRecord = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).slice(0, 8);
  return Object.fromEntries(
    entries.map(([key, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return [key, `[array:${entryValue.length}]`];
      }
      if (isRecord(entryValue)) {
        return [key, `[object keys:${Object.keys(entryValue).join(",")}]`];
      }
      return [key, entryValue];
    }),
  );
};

const traceMonacoApi = (label: string, value: unknown): void => {
  if (!shouldTraceMonacoApi()) {
    return;
  }

  const summary = Array.isArray(value)
    ? { type: "array", length: value.length, first: summarizeRecord(value[0]) }
    : (summarizeRecord(value) ?? { type: typeof value, value });
  console.log(pc.gray(`[trace] ${label}: ${JSON.stringify(summary)}`));
};

const traceMonacoApiPayload = (label: string, value: unknown): void => {
  if (!shouldTraceMonacoApi()) {
    return;
  }

  console.log(
    pc.gray(`[trace] ${label} payload:\n${JSON.stringify(value, null, 2)}`),
  );
};

const parseUserProfile = (profile: UserProfile): UserProfile => {
  traceMonacoApi("profile.getProfile", profile);
  if (!isRecord(profile)) {
    throw new Error("Profile response is not an object.");
  }

  const id = getStringProp(profile, "id");
  const address = getStringProp(profile, "address");
  if (!id || !address) {
    throw new Error("Profile response missing required id or address.");
  }

  return profile;
};

const parseProfileBalances = (
  balances: GetUserBalancesResponse,
): ProfileBalanceEntry[] => {
  traceMonacoApi("profile.getUserBalances", balances);
  if (!Array.isArray(balances?.balances)) {
    throw new Error("Profile balances response missing balances array.");
  }
  const entries = balances.balances;
  const parsed = entries
    .map((entry) => {
      if (!isRecord(entry)) {
        return undefined;
      }
      const assetId = getStringProp(entry, "asset_id");
      const available = getStringProp(entry, "available_balance");
      const total = getStringProp(entry, "total_balance");
      const locked = getStringProp(entry, "locked_balance");
      if (!assetId || !available || !total || !locked) {
        return undefined;
      }
      const symbol = getStringProp(entry, "symbol") || undefined;
      return { assetId, available, total, locked, symbol };
    })
    .filter((entry): entry is ProfileBalanceEntry => entry !== undefined);

  if (entries.length > 0 && parsed.length === 0) {
    throw new Error(
      "Profile balances response structure did not match expected Monaco fields.",
    );
  }

  return parsed;
};

const fetchLiveBalanceResult = async (
  sdk: {
    profile: {
      getProfile: () => Promise<UserProfile>;
      getUserBalances: () => Promise<GetUserBalancesResponse>;
    };
    getAccountAddress: () => string;
  },
  resolver: { getAllPairs: () => unknown },
  client: Parameters<typeof fetchWalletBalancesForCatalog>[0],
  onStatus: (status: string) => void,
): Promise<LiveBalanceResult> => {
  onStatus("Reading trading pairs");
  const resolverPairs = resolver.getAllPairs();
  if (!Array.isArray(resolverPairs)) {
    throw new Error(
      "Trading pair resolver returned an invalid response shape.",
    );
  }

  const pairs = resolverPairs as TokenLikePair[];
  traceMonacoApi("resolver.getAllPairs", pairs);
  const catalog = buildTokenCatalog(pairs);

  onStatus("Fetching profile");
  const profile: UserProfile = parseUserProfile(await sdk.profile.getProfile());

  onStatus("Fetching Monaco account balances");
  const rawProfileBalances = await sdk.profile.getUserBalances();
  traceMonacoApiPayload("profile.getUserBalances", rawProfileBalances);
  const profileBalances = parseProfileBalances(rawProfileBalances);

  onStatus("Resolving wallet address");
  const address: string = sdk.getAccountAddress();

  const accountRows: BalanceRow[] = profileBalances.map((balance) => {
    return {
      symbol: balance.symbol ?? balance.assetId,
      available: balance.available,
      locked: balance.locked,
      total: balance.total,
    };
  });

  onStatus("Fetching on-chain wallet balances");
  const walletBalances = await fetchWalletBalancesForCatalog(
    client,
    catalog,
    address,
  );
  const walletRows: WalletBalanceRow[] = catalog.map((entry) => ({
    label: `${entry.address} (${entry.symbol})`,
    balance: walletBalances.get(entry.address.toLowerCase()) ?? "0",
  }));
  traceMonacoApi("walletBalances", walletRows);

  return {
    profile,
    address,
    accountRows,
    walletRows,
  };
};

const logBalanceStatus = (status: string): void => {
  console.log(pc.gray(`[balance] ${status}`));
};

const logBalanceRows = (
  title: string,
  rows: Array<Record<string, string>>,
): void => {
  console.log(pc.cyan(title));
  if (rows.length === 0) {
    console.log(pc.gray("  none"));
    return;
  }

  for (const row of rows) {
    console.log(JSON.stringify(row));
  }
};

const parseMarginAccountId = (
  response: ListMarginAccountsResponse,
): string | undefined => {
  if (!Array.isArray(response?.accounts)) {
    throw new Error("Margin accounts response missing accounts array.");
  }

  for (const account of response.accounts) {
    if (!isRecord(account)) {
      continue;
    }

    const marginAccountId = getStringProp(account, "margin_account_id");
    if (marginAccountId) {
      return marginAccountId;
    }
  }

  return undefined;
};

const parseMarginAccountRows = (
  response: ListMarginAccountsResponse,
): MarginAccountListRow[] => {
  if (!Array.isArray(response?.accounts)) {
    throw new Error("Margin accounts response missing accounts array.");
  }

  return response.accounts.flatMap((account) => {
    if (!isRecord(account)) {
      return [];
    }

    const marginAccountId = getStringProp(account, "margin_account_id");
    if (!marginAccountId) {
      return [];
    }

    return [
      {
        marginAccountId,
        label: getStringProp(account, "label") ?? "",
        state: getStringProp(account, "account_state") ?? "unknown",
        collateralAsset:
          getStringProp(account, "collateral_asset") ?? "unavailable",
        equity: getStringProp(account, "equity") ?? "0",
        freeCollateral: getStringProp(account, "free_collateral") ?? "0",
        withdrawableCollateral:
          getStringProp(account, "withdrawable_collateral") ?? "0",
        updatedAt: getStringProp(account, "updated_at") ?? "unavailable",
      },
    ];
  });
};

const parseCreatedMarginAccount = (
  response: CreateMarginAccountResponse,
): MarginAccountListRow => {
  traceMonacoApiPayload("marginAccounts.createMarginAccount", response);
  if (!isRecord(response)) {
    throw new Error("Create margin account response is not an object.");
  }

  const marginAccountId = getStringProp(response, "margin_account_id");
  if (!marginAccountId) {
    throw new Error(
      "Create margin account response missing margin_account_id.",
    );
  }

  return {
    marginAccountId,
    label: getStringProp(response, "label") ?? "",
    state: getStringProp(response, "account_state") ?? "unknown",
    collateralAsset:
      getStringProp(response, "collateral_asset") ?? "unavailable",
    equity: "0",
    freeCollateral: "0",
    withdrawableCollateral: "0",
    updatedAt: getStringProp(response, "created_at") ?? "unavailable",
  };
};

const parseTransferCollateral = (
  response: TransferCollateralResponse,
): TransferCollateralResponse => {
  traceMonacoApiPayload("marginAccounts.transferCollateral", response);
  if (!isRecord(response)) {
    throw new Error("Transfer collateral response is not an object.");
  }

  const movementId = getStringProp(response, "movement_id");
  const marginAccountId = getStringProp(response, "margin_account_id");
  const asset = getStringProp(response, "asset");
  const amount = getStringProp(response, "amount");
  const status = getStringProp(response, "status");
  const newEquity = getStringProp(response, "new_equity");
  const newTotalCollateralValue = getStringProp(
    response,
    "new_total_collateral_value",
  );
  const newWithdrawableCollateral = getStringProp(
    response,
    "new_withdrawable_collateral",
  );

  if (
    !movementId ||
    !marginAccountId ||
    !asset ||
    !amount ||
    !status ||
    !newEquity ||
    !newTotalCollateralValue ||
    !newWithdrawableCollateral
  ) {
    throw new Error(
      "Transfer collateral response missing required Monaco fields.",
    );
  }

  return {
    movement_id: movementId,
    margin_account_id: marginAccountId,
    asset,
    amount,
    status,
    new_equity: newEquity,
    new_total_collateral_value: newTotalCollateralValue,
    new_withdrawable_collateral: newWithdrawableCollateral,
  };
};

const parseAvailableCollateral = (
  response: GetAvailableCollateralResponse,
): GetAvailableCollateralResponse => {
  traceMonacoApiPayload("perps.getAvailableCollateral", response);
  if (!isRecord(response)) {
    throw new Error("Available collateral response is not an object.");
  }

  const asset = getStringProp(response, "asset");
  const walletAvailable = getStringProp(response, "wallet_available");
  const walletLocked = getStringProp(response, "wallet_locked");
  if (!asset || !walletAvailable || !walletLocked) {
    throw new Error(
      "Available collateral response missing required Monaco fields.",
    );
  }

  return {
    asset,
    wallet_available: walletAvailable,
    wallet_locked: walletLocked,
    margin_transferable:
      getStringProp(response, "margin_transferable") ?? undefined,
  };
};

const resolveMarginAccountId = async (
  sdk: {
    perps: {
      listMarginAccounts: (params?: {
        state?: string;
      }) => Promise<ListMarginAccountsResponse>;
    };
  },
  requestedMarginAccountId: string | undefined,
): Promise<string> => {
  if (requestedMarginAccountId) {
    return requestedMarginAccountId;
  }

  const rawAccounts = await sdk.perps.listMarginAccounts({ state: "ACTIVE" });
  traceMonacoApiPayload("perps.listMarginAccounts", rawAccounts);
  const marginAccountId = parseMarginAccountId(rawAccounts);
  if (!marginAccountId) {
    throw new Error("No active isolated margin account available");
  }

  return marginAccountId;
};

const parseMarginAccountSummary = (
  marginAccountId: string,
  summary: MarginAccountSummary,
): IsolatedPerpsSummaryRow => {
  traceMonacoApi("perps.getMarginAccountSummary", summary);
  if (!isRecord(summary)) {
    throw new Error("Margin account summary response is not an object.");
  }

  return {
    marginAccountId,
    equity: getStringProp(summary, "equity") ?? "0",
    freeCollateral: getStringProp(summary, "free_collateral") ?? "0",
    usedMargin: getStringProp(summary, "initial_margin_required") ?? "0",
    maintenanceMargin:
      getStringProp(summary, "maintenance_margin_required") ?? "0",
    withdrawableCollateral:
      getStringProp(summary, "withdrawable_collateral") ?? "0",
    realizedPnl: getStringProp(summary, "realized_pnl") ?? "0",
    unrealizedPnl: getStringProp(summary, "unrealized_pnl") ?? "0",
  };
};

const parsePerpsPositions = (
  response: ListPositionsResponse,
): IsolatedPerpsPositionRow[] => {
  traceMonacoApiPayload("perps.listOpenPositions", response);
  if (!Array.isArray(response?.positions)) {
    throw new Error("Perps positions response missing positions array.");
  }

  return response.positions.flatMap((position) => {
    if (!isRecord(position)) {
      return [];
    }

    const tradingPairId = getStringProp(position, "trading_pair_id");
    const side = getStringProp(position, "side");
    const size = getStringProp(position, "size");
    if (!tradingPairId || !side || !size) {
      return [];
    }

    return [
      {
        tradingPairId,
        side,
        size,
        entryPrice: getStringProp(position, "entry_price") ?? "0",
        markPrice: getStringProp(position, "mark_price") ?? "0",
        leverage: getStringProp(position, "leverage") ?? "unavailable",
        collateral: getStringProp(position, "isolated_margin") ?? "0",
        unrealizedPnl: getStringProp(position, "unrealized_pnl") ?? "0",
        liquidationPrice:
          getStringProp(position, "liquidation_price") ?? "unavailable",
        fundingRate: getStringProp(position, "funding_rate") ?? "unavailable",
        accruedFunding:
          getStringProp(position, "accrued_funding") ?? "unavailable",
      },
    ];
  });
};

const fetchLivePerpsResult = async (
  sdk: {
    perps: {
      listMarginAccounts: (params?: {
        state?: string;
      }) => Promise<ListMarginAccountsResponse>;
      getMarginAccountSummary: (
        marginAccountId: string,
      ) => Promise<MarginAccountSummary>;
      listOpenPositions: (params?: {
        margin_account_id?: string;
      }) => Promise<ListPositionsResponse>;
    };
  },
  onStatus: (status: string) => void,
): Promise<LivePerpsResult> => {
  onStatus("Fetching isolated margin accounts");
  const rawAccounts = await sdk.perps.listMarginAccounts({ state: "ACTIVE" });
  traceMonacoApiPayload("perps.listMarginAccounts", rawAccounts);
  const marginAccountId = parseMarginAccountId(rawAccounts);

  if (!marginAccountId) {
    return {
      summary: undefined,
      positions: [],
    };
  }

  onStatus("Fetching isolated margin account summary");
  const rawSummary = await sdk.perps.getMarginAccountSummary(marginAccountId);

  onStatus("Fetching open perps positions");
  const rawPositions = await sdk.perps.listOpenPositions({
    margin_account_id: marginAccountId,
  });

  return {
    summary: parseMarginAccountSummary(marginAccountId, rawSummary),
    positions: parsePerpsPositions(rawPositions),
  };
};

export const registerLiveCommands = (liveCommand: Command): void => {
  liveCommand
    .command("balance")
    .alias("balances")
    .description("Show live Monaco account balances")
    .option("--no-ui", "Disable terminal UI and print logs only")
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      let balanceUi: BalanceUiController | undefined;
      const useUi = options.ui !== false;
      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        if (useUi) {
          balanceUi = await createBalanceUi({
            stage: "loading",
            status: "Preparing balance check",
            viewport: getCliViewport(),
          });
        }

        const updateLoadingState = (status: string) => {
          if (useUi) {
            balanceUi?.update({
              stage: "loading",
              status,
              viewport: getCliViewport(),
            });
            return;
          }

          logBalanceStatus(status);
        };

        updateLoadingState("Connecting to Monaco");

        await withMonacoSession(
          prepared,
          async ({ sdk, resolver, client }) => {
            const result = await fetchLiveBalanceResult(
              sdk,
              resolver,
              client,
              updateLoadingState,
            );

            if (useUi) {
              balanceUi?.update({
                stage: "done",
                status: `Loaded ${result.accountRows.length} account balances and ${result.walletRows.length} wallet balances`,
                profile: result.profile,
                address: result.address,
                balances: result.accountRows,
                walletBalances: result.walletRows,
                viewport: getCliViewport(),
              });
              return;
            }

            console.log(pc.cyan("Live account balances"));
            console.log(
              JSON.stringify({
                address: result.address,
                profileId: result.profile.id,
              }),
            );
            logBalanceRows(
              "Account Balances",
              result.accountRows.map((row) => ({
                symbol: row.symbol,
                total: row.total,
                available: row.available,
                locked: row.locked,
              })),
            );
            logBalanceRows(
              "Wallet Balances (On-chain)",
              result.walletRows.map((row) => ({
                token: row.label,
                balance: row.balance,
              })),
            );
          },
          updateLoadingState,
          {
            connectWebSocket: false,
            traceProfileOnInitialize: false,
          },
        );
      } catch (error) {
        exitCode = 1;
        if (balanceUi) {
          balanceUi.update({
            stage: "error",
            status: "Balance fetch failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
            viewport: getCliViewport(),
          });
        }
        if (!useUi) {
          logBalanceStatus("Balance fetch failed");
        }
        console.error(
          pc.red(
            `❌ Failed to fetch live balances: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        balanceUi?.unmount();
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("perps")
    .description("Show isolated perps margin balances and open positions")
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        logBalanceStatus("Connecting to Monaco");
        await withMonacoSession(
          prepared,
          async ({ sdk }) => {
            const result = await fetchLivePerpsResult(sdk, logBalanceStatus);

            console.log(pc.cyan("Isolated perps account"));
            if (!result.summary) {
              console.log(pc.gray("  none"));
            } else {
              console.log(JSON.stringify(result.summary));
            }

            logBalanceRows(
              "Open Perps Positions",
              result.positions.map((position) => ({
                tradingPairId: position.tradingPairId,
                side: position.side,
                size: position.size,
                entryPrice: position.entryPrice,
                markPrice: position.markPrice,
                leverage: position.leverage,
                collateral: position.collateral,
                unrealizedPnl: position.unrealizedPnl,
                liquidationPrice: position.liquidationPrice,
                fundingRate: position.fundingRate,
                accruedFunding: position.accruedFunding,
              })),
            );
          },
          logBalanceStatus,
          {
            connectWebSocket: false,
            traceProfileOnInitialize: false,
          },
        );
      } catch (error) {
        exitCode = 1;
        logBalanceStatus("Perps fetch failed");
        console.error(
          pc.red(
            `❌ Failed to fetch isolated perps state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        process.exit(exitCode);
      }
    });

  const marginAccountCommand = liveCommand
    .command("margin-account")
    .description("Manage isolated perps margin accounts");

  marginAccountCommand
    .command("list")
    .description("List isolated perps margin accounts")
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        logBalanceStatus("Connecting to Monaco");
        await withMonacoSession(
          prepared,
          async ({ sdk }) => {
            logBalanceStatus("Fetching isolated margin accounts");
            const rawAccounts = await sdk.perps.listMarginAccounts();
            traceMonacoApiPayload("perps.listMarginAccounts", rawAccounts);
            const rows = parseMarginAccountRows(rawAccounts);

            console.log(pc.cyan("Margin Accounts"));
            if (rows.length === 0) {
              console.log(pc.gray("  none"));
              return;
            }

            for (const row of rows) {
              console.log(JSON.stringify(row));
            }
          },
          logBalanceStatus,
          {
            connectWebSocket: false,
            traceProfileOnInitialize: false,
          },
        );
      } catch (error) {
        exitCode = 1;
        logBalanceStatus("Margin account list failed");
        console.error(
          pc.red(
            `❌ Failed to list margin accounts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        process.exit(exitCode);
      }
    });

  marginAccountCommand
    .command("create")
    .description("Create isolated perps margin account")
    .option("--label <label>", "Optional account label")
    .option(
      "--collateral-asset <asset>",
      "Optional collateral asset symbol or asset id",
    )
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        logBalanceStatus("Connecting to Monaco");
        await withMonacoSession(
          prepared,
          async ({ sdk }) => {
            logBalanceStatus("Creating isolated margin account");
            const created = parseCreatedMarginAccount(
              await sdk.marginAccounts.createMarginAccount({
                label: options.label,
                collateralAsset: options.collateralAsset,
              }),
            );

            console.log(pc.cyan("Created Margin Account"));
            console.log(JSON.stringify(created));
          },
          logBalanceStatus,
          {
            connectWebSocket: false,
            traceProfileOnInitialize: false,
          },
        );
      } catch (error) {
        exitCode = 1;
        logBalanceStatus("Margin account create failed");
        console.error(
          pc.red(
            `❌ Failed to create margin account: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("transfer")
    .description("Transfer collateral between spot vault and isolated perps")
    .option(
      "--direction <direction>",
      "Transfer direction: spot-to-perps or perps-to-spot",
    )
    .option("-t, --token <token>", "Token address or symbol to transfer")
    .option("-a, --amount <amount>", "Amount to transfer (human-readable)")
    .option(
      "--margin-account-id <marginAccountId>",
      "Target isolated margin account id",
    )
    .option(
      "-d, --decimals <decimals>",
      "Token decimals (override auto-detected)",
      parseInt,
    )
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      if (
        options.decimals !== undefined &&
        (Number.isNaN(options.decimals) || options.decimals < 0)
      ) {
        console.error(pc.red("❌ Decimals must be a non-negative integer"));
        process.exit(1);
      }

      const direction = String(options.direction ?? "").toLowerCase();
      if (direction !== "spot-to-perps" && direction !== "perps-to-spot") {
        console.error(
          pc.red("❌ Direction must be one of: spot-to-perps, perps-to-spot"),
        );
        process.exit(1);
      }

      let exitCode = 0;
      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        console.log(pc.cyan("🔗 Connecting to Monaco..."));
        await withMonacoSession(prepared, async ({ sdk, resolver, client }) => {
          const pairs = resolver.getAllPairs() as TokenLikePair[];
          const catalog = buildTokenCatalog(pairs);
          const tokenInfo = await resolveTokenInfoFromSelection(
            options.token,
            pairs,
            client,
            options.decimals,
            catalog,
          );
          const decimals = tokenInfo.decimals;

          if (decimals === undefined) {
            throw new Error(
              `Unable to determine decimals for token ${options.token}. Provide --decimals explicitly.`,
            );
          }

          assertPositiveAmountInput(options.amount);
          const amount = parseUnits(options.amount, decimals);
          const assetId = resolveAssetIdFromPairs(tokenInfo.address, pairs);
          if (!assetId) {
            throw new Error(
              `Unable to resolve asset ID for token ${
                tokenInfo.symbol || tokenInfo.address
              }`,
            );
          }

          const marginAccountId = await resolveMarginAccountId(
            sdk,
            options.marginAccountId,
          );
          const tokenLabel = tokenInfo.symbol || tokenInfo.address;

          if (direction === "spot-to-perps") {
            console.log(pc.cyan("📤 Transferring collateral to perps..."));
            const transferResult = parseTransferCollateral(
              await sdk.marginAccounts.transferCollateralToMarginAccount(
                marginAccountId,
                {
                  asset: assetId,
                  amount: amount.toString(),
                },
              ),
            );
            console.log(pc.green("✅ Transfer processed"));
            console.log(pc.gray(`   Direction: spot -> perps`));
            console.log(pc.gray(`   Token: ${tokenLabel}`));
            console.log(pc.gray(`   Amount: ${options.amount}`));
            console.log(pc.gray(`   Asset ID: ${assetId}`));
            console.log(pc.gray(`   Margin Account: ${marginAccountId}`));
            console.log(
              pc.gray(`   Movement ID: ${transferResult.movement_id}`),
            );
            console.log(pc.gray(`   Status: ${transferResult.status}`));
            return;
          }

          const collateral = parseAvailableCollateral(
            await sdk.perps.getAvailableCollateral({ asset: assetId }),
          );
          const transferable = collateral.margin_transferable ?? "0";
          const transferableRaw = parseUnits(transferable, decimals);
          if (transferableRaw < amount) {
            throw new Error(
              `Insufficient perps collateral. Requested ${options.amount}, transferable: ${transferable}`,
            );
          }

          console.log(pc.cyan("📥 Transferring collateral to spot..."));
          const transferResult = parseTransferCollateral(
            await sdk.marginAccounts.transferCollateralFromMarginAccount(
              marginAccountId,
              {
                asset: assetId,
                amount: amount.toString(),
              },
            ),
          );
          console.log(pc.green("✅ Transfer processed"));
          console.log(pc.gray(`   Direction: perps -> spot`));
          console.log(pc.gray(`   Token: ${tokenLabel}`));
          console.log(pc.gray(`   Amount: ${options.amount}`));
          console.log(pc.gray(`   Asset ID: ${assetId}`));
          console.log(pc.gray(`   Margin Account: ${marginAccountId}`));
          console.log(pc.gray(`   Movement ID: ${transferResult.movement_id}`));
          console.log(pc.gray(`   Status: ${transferResult.status}`));
        });
      } catch (error) {
        exitCode = 1;
        console.error(
          pc.red(
            `❌ Failed to transfer collateral: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("faucet")
    .description("Mint all testnet tokens to your Monaco account")
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      let faucetUi: FaucetUiController | undefined;
      let faucetUrl = "";

      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        console.log(pc.cyan("🔗 Connecting to Monaco..."));
        await withMonacoSession(prepared, async ({ sdk, network }) => {
          const authState = sdk.getAuthState();

          if (!authState) {
            throw new Error(
              "Missing Monaco session credentials. Ensure authentication succeeds before calling faucet.",
            );
          }

          const baseUrl = resolveFaucetBaseUrl(network, prepared.environment);
          faucetUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/faucet/mint`;
          faucetUi = await createFaucetUi({
            stage: "requesting",
            endpoint: faucetUrl,
          });

          const faucetPath = new URL(faucetUrl).pathname;
          const response = await fetch(faucetUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...buildMonacoSessionHeaders(authState, faucetPath, {
                method: "POST",
              }),
            },
          });

          faucetUi.update({
            stage: "processing",
            endpoint: faucetUrl,
          });

          const responseText = await response.text();
          let responseBody: unknown = null;
          if (responseText) {
            try {
              responseBody = JSON.parse(responseText);
            } catch {
              responseBody = responseText;
            }
          }

          if (!response.ok) {
            const message = isRecord(responseBody)
              ? getStringProp(responseBody, "message") ||
                getStringProp(responseBody, "error")
              : undefined;
            throw new Error(
              message ||
                `Faucet request failed with status ${response.status} ${response.statusText}`,
            );
          }

          const formatted = formatFaucetResponse(responseBody);
          const uiState: FaucetUiState = {
            stage: "done",
            endpoint: faucetUrl,
            remainingRequests: formatted.remainingRequests,
            minted: formatted.minted,
            failed: formatted.failed,
          };
          faucetUi.update(uiState);

          if (formatted.failed.length > 0) {
            exitCode = 1;
          }
        });

        faucetUi?.unmount();
      } catch (error) {
        exitCode = 1;
        if (faucetUi) {
          faucetUi.update({
            stage: "error",
            endpoint: faucetUrl || undefined,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          faucetUi.unmount();
        }
        console.error(
          pc.red(
            `❌ Faucet request failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("deposit")
    .description("Deposit funds into your live trading account")
    .option("-t, --token <token>", "Token address or symbol to deposit")
    .option("-a, --amount <amount>", "Amount to deposit (human-readable)")
    .option("--all", "Deposit full balances of all tokens with wallet balance")
    .option("--to <destination>", "Deposit destination: spot or perps", "spot")
    .option(
      "--margin-account-id <marginAccountId>",
      "Target isolated margin account id when depositing to perps",
    )
    .option(
      "-d, --decimals <decimals>",
      "Token decimals (override auto-detected)",
      parseInt,
    )
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      if (
        options.decimals !== undefined &&
        (Number.isNaN(options.decimals) || options.decimals < 0)
      ) {
        console.error(pc.red("❌ Decimals must be a non-negative integer"));
        process.exit(1);
      }

      let exitCode = 0;
      let depositUi: DepositUiController | undefined;

      try {
        const destination = String(options.to ?? "spot").toLowerCase();
        if (destination !== "spot" && destination !== "perps") {
          throw new Error("Deposit destination must be one of: spot, perps");
        }

        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        console.log(pc.cyan("🔗 Connecting to Monaco..."));
        await withMonacoSession(prepared, async ({ sdk, resolver, client }) => {
          const pairs = resolver.getAllPairs() as TokenLikePair[];
          const catalog = buildTokenCatalog(pairs);
          const walletAddress = sdk.getAccountAddress();
          const walletBalances = await fetchWalletBalancesForCatalog(
            client,
            catalog,
            walletAddress,
          );
          const tokenOptions: DepositTokenOption[] = catalog.map((entry) => ({
            symbol: entry.symbol,
            assetId: entry.assetId,
            address: entry.address,
            balance: walletBalances.get(entry.address.toLowerCase()) ?? "0",
          }));
          const viewport = {
            width: Math.max(40, process.stdout.columns ?? 80),
            height: Math.max(12, process.stdout.rows ?? 24),
          };
          const inputResult = options.all
            ? { tokenInput: "all", amountInput: "all" }
            : options.token && options.amount
              ? { tokenInput: options.token, amountInput: options.amount }
              : await promptForDepositInput({
                  tokenOptions,
                  initialToken: options.token,
                  initialAmount: options.amount,
                  viewport,
                });
          const { tokenInput, amountInput } = inputResult;
          const trimmedTokenInput = tokenInput.trim();
          const normalizedTokenInput = trimmedTokenInput.toLowerCase();
          const isAllSelection =
            options.all ||
            normalizedTokenInput === "all" ||
            trimmedTokenInput === "*";

          if (isAllSelection) {
            if (options.decimals !== undefined) {
              throw new Error(
                "Decimals override is not supported when depositing all tokens.",
              );
            }

            const vault = sdk.vault;
            const balancesToDeposit: Array<{
              entry: (typeof catalog)[number];
              balance: bigint;
            }> = [];

            for (const entry of catalog) {
              const balance = await fetchWalletBalance(
                client,
                entry.address,
                walletAddress,
              );
              if (balance > 0n) {
                balancesToDeposit.push({ entry, balance });
              }
            }

            if (balancesToDeposit.length === 0) {
              throw new Error("No wallet balances available to deposit.");
            }

            console.log(
              pc.cyan(
                `📦 Depositing ${balancesToDeposit.length} token balance${
                  balancesToDeposit.length === 1 ? "" : "s"
                }...`,
              ),
            );

            for (const { entry, balance } of balancesToDeposit) {
              if (isZeroAddress(entry.address)) {
                console.log(
                  pc.gray(
                    `ℹ️  Skipping ${entry.symbol} - native token deposits are disabled for --all.`,
                  ),
                );
                continue;
              }
              const assetId = resolveAssetIdFromPairs(entry.address, pairs);
              if (!assetId) {
                console.log(
                  pc.yellow(`⚠️  Skipping ${entry.symbol} - missing asset id.`),
                );
                exitCode = 1;
                continue;
              }

              let depositBalance = balance;
              if (isZeroAddress(entry.address)) {
                const reserve = parseUnits("2", entry.decimals);
                if (balance <= reserve) {
                  console.log(
                    pc.yellow(
                      `⚠️  Skipping ${entry.symbol} - balance ${formatUnits(
                        balance,
                        entry.decimals,
                      )} is not enough to keep 2 ${entry.symbol} for gas.`,
                    ),
                  );
                  exitCode = 1;
                  continue;
                }
                depositBalance = balance - reserve;
              }

              const amountFormatted = formatUnits(
                depositBalance,
                entry.decimals,
              );
              console.log(
                pc.cyan(
                  `\n📤 Depositing ${entry.symbol}: ${amountFormatted} (raw: ${depositBalance.toString()})`,
                ),
              );

              if (!isZeroAddress(entry.address)) {
                const needsApproval = await vault.needsApproval(
                  assetId,
                  depositBalance,
                );
                if (needsApproval) {
                  console.log(
                    pc.cyan("📝 Approval required - submitting transaction..."),
                  );
                  const approvalResult = await vault.approve(
                    assetId,
                    depositBalance,
                    true,
                  );
                  console.log(
                    pc.gray(`   Approval tx: ${approvalResult.hash}`),
                  );
                  console.log(
                    pc.gray(
                      `   Approval url: ${buildSeiscanTxUrl(
                        approvalResult.hash,
                      )}`,
                    ),
                  );
                } else {
                  console.log(pc.green("✅ Approval already sufficient"));
                }
              } else {
                console.log(pc.gray("ℹ️  Native token - no approval required"));
              }

              const depositResult = await vault.deposit(
                assetId,
                depositBalance,
                true,
              );
              const statusIcon =
                depositResult.status === "confirmed"
                  ? pc.green("✅")
                  : pc.yellow("⚠️");
              console.log(`${statusIcon} Deposit processed`);
              console.log(pc.gray(`   Tx Hash: ${depositResult.hash}`));
              console.log(
                pc.gray(`   Tx Url: ${buildSeiscanTxUrl(depositResult.hash)}`),
              );
              console.log(pc.gray(`   Status: ${depositResult.status}`));

              if (depositResult.status !== "confirmed") {
                exitCode = 1;
                continue;
              }

              if (destination === "perps") {
                const marginAccountId = await resolveMarginAccountId(
                  sdk,
                  options.marginAccountId,
                );
                const transferResult = parseTransferCollateral(
                  await sdk.marginAccounts.transferCollateralToMarginAccount(
                    marginAccountId,
                    {
                      asset: assetId,
                      amount: depositBalance.toString(),
                    },
                  ),
                );
                console.log(pc.green("✅ Perps transfer processed"));
                console.log(pc.gray(`   Margin Account: ${marginAccountId}`));
                console.log(
                  pc.gray(`   Movement ID: ${transferResult.movement_id}`),
                );
                console.log(pc.gray(`   Status: ${transferResult.status}`));
              }
            }

            return;
          }
          const tokenInfo = await resolveTokenInfoFromSelection(
            tokenInput,
            pairs,
            client,
            options.decimals,
            catalog,
          );
          const decimals = tokenInfo.decimals;

          if (decimals === undefined) {
            throw new Error(
              `Unable to determine decimals for token ${tokenInput}. Provide --decimals explicitly.`,
            );
          }

          console.log(pc.cyan("💰 Checking wallet balance..."));
          const walletBalance = await fetchWalletBalance(
            client,
            tokenInfo.address,
            walletAddress,
          );

          if (walletBalance <= 0n) {
            throw new Error(
              `Wallet balance is zero for ${
                tokenInfo.symbol || tokenInfo.address
              }.`,
            );
          }

          const maxFormatted = formatUnits(walletBalance, decimals);

          assertPositiveAmountInput(amountInput);
          let amount = parseUnits(amountInput, decimals);
          if (isZeroAddress(tokenInfo.address)) {
            const reserve = parseUnits("2", decimals);
            if (walletBalance <= reserve) {
              throw new Error(
                `Wallet balance is too low to keep 2 ${tokenInfo.symbol ?? "native"} for gas.`,
              );
            }
            if (amount > walletBalance - reserve) {
              amount = walletBalance - reserve;
              const adjusted = formatUnits(amount, decimals);
              console.log(
                pc.yellow(
                  `⚠️  Native token deposit adjusted to ${adjusted} to keep 2 for gas.`,
                ),
              );
            }
          }

          if (walletBalance < amount) {
            const available = walletBalance.toString();
            console.error(
              pc.red(
                `❌ Insufficient wallet balance. Requested ${amountInput}, available (raw): ${available}`,
              ),
            );
            exitCode = 1;
            return;
          }

          const vault = sdk.vault;
          const assetId = resolveAssetIdFromPairs(tokenInfo.address, pairs);

          if (!assetId) {
            throw new Error(
              `Unable to resolve asset ID for token ${
                tokenInfo.symbol || tokenInfo.address
              }`,
            );
          }

          const tokenLabel = tokenInfo.symbol || tokenInfo.address;
          const baseUiState: DepositUiState = {
            stage: "preparing",
            token: tokenLabel,
            amount: amountInput,
            walletBalance: maxFormatted,
            status: "Preparing transaction",
            viewport: {
              width: Math.max(40, process.stdout.columns ?? 80),
              height: Math.max(12, process.stdout.rows ?? 24),
            },
          };
          depositUi = await createDepositUi(baseUiState);

          if (!isZeroAddress(tokenInfo.address)) {
            console.log(pc.cyan("🛂 Checking allowance..."));
            const needsApproval = await vault.needsApproval(assetId, amount);
            if (needsApproval) {
              depositUi.update({
                ...baseUiState,
                stage: "approving",
                status: "Submitting approval",
              });
              console.log(
                pc.cyan("📝 Approval required - submitting transaction..."),
              );
              const approvalResult = await vault.approve(assetId, amount, true);
              console.log(pc.gray(`   Approval tx: ${approvalResult.hash}`));
              console.log(
                pc.gray(
                  `   Approval url: ${buildSeiscanTxUrl(approvalResult.hash)}`,
                ),
              );
              baseUiState.approvalTxHash = approvalResult.hash;
              baseUiState.approvalTxUrl = buildSeiscanTxUrl(
                approvalResult.hash,
              );
            } else {
              baseUiState.status = "Approval already sufficient";
              console.log(pc.green("✅ Approval already sufficient"));
            }
          } else {
            baseUiState.status = "Native token - no approval required";
            console.log(pc.gray("ℹ️  Native token - no approval required"));
          }

          depositUi.update({
            ...baseUiState,
            stage: "depositing",
            status:
              destination === "perps"
                ? "Submitting deposit and perps transfer"
                : "Submitting deposit",
          });
          console.log(pc.cyan("📤 Submitting deposit..."));
          const depositResult = await vault.deposit(assetId, amount, true);

          const statusIcon =
            depositResult.status === "confirmed"
              ? pc.green("✅")
              : pc.yellow("⚠️");
          console.log(`${statusIcon} Deposit processed`);
          console.log(
            pc.gray(`   Token: ${tokenInfo.symbol || tokenInfo.address}`),
          );
          console.log(pc.gray(`   Destination: ${destination}`));
          console.log(
            pc.gray(`   Amount: ${amountInput} (raw: ${amount.toString()})`),
          );
          console.log(pc.gray(`   Tx Hash: ${depositResult.hash}`));
          console.log(
            pc.gray(`   Tx Url: ${buildSeiscanTxUrl(depositResult.hash)}`),
          );
          console.log(pc.gray(`   Status: ${depositResult.status}`));

          if (depositResult.status === "confirmed" && destination === "perps") {
            const marginAccountId = await resolveMarginAccountId(
              sdk,
              options.marginAccountId,
            );
            const transferResult = parseTransferCollateral(
              await sdk.marginAccounts.transferCollateralToMarginAccount(
                marginAccountId,
                {
                  asset: assetId,
                  amount: amount.toString(),
                },
              ),
            );
            console.log(pc.cyan("📤 Moving deposited collateral to perps..."));
            console.log(pc.green("✅ Perps transfer processed"));
            console.log(pc.gray(`   Margin Account: ${marginAccountId}`));
            console.log(
              pc.gray(`   Movement ID: ${transferResult.movement_id}`),
            );
            console.log(pc.gray(`   Status: ${transferResult.status}`));
          }

          depositUi.update({
            ...baseUiState,
            stage: depositResult.status === "confirmed" ? "done" : "error",
            status: depositResult.status,
            depositTxHash: depositResult.hash,
            depositTxUrl: buildSeiscanTxUrl(depositResult.hash),
          });

          if (depositResult.status !== "confirmed") {
            exitCode = 1;
          }
        });
      } catch (error) {
        exitCode = 1;
        if (depositUi) {
          depositUi.update({
            stage: "error",
            token: "Unknown",
            amount: "-",
            walletBalance: "-",
            status: "Failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
            viewport: {
              width: Math.max(40, process.stdout.columns ?? 80),
              height: Math.max(12, process.stdout.rows ?? 24),
            },
          });
        }
        console.error(
          pc.red(
            `❌ Failed to deposit funds: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        depositUi?.unmount();
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("withdraw")
    .description("Withdraw funds from your live trading account")
    .option("-t, --token <token>", "Token address or symbol to withdraw")
    .option("-a, --amount <amount>", "Amount to withdraw (human-readable)")
    .option("--from <source>", "Withdraw source: spot or perps", "spot")
    .option(
      "--margin-account-id <marginAccountId>",
      "Source isolated margin account id when withdrawing from perps",
    )
    .option(
      "-d, --decimals <decimals>",
      "Token decimals (override auto-detected)",
      parseInt,
    )
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      if (
        options.decimals !== undefined &&
        (Number.isNaN(options.decimals) || options.decimals < 0)
      ) {
        console.error(pc.red("❌ Decimals must be a non-negative integer"));
        process.exit(1);
      }

      let exitCode = 0;
      let withdrawUi: WithdrawUiController | undefined;

      try {
        const source = String(options.from ?? "spot").toLowerCase();
        if (source !== "spot" && source !== "perps") {
          throw new Error("Withdraw source must be one of: spot, perps");
        }

        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        console.log(pc.cyan("🔗 Connecting to Monaco..."));
        await withMonacoSession(prepared, async ({ sdk, resolver, client }) => {
          const pairs = resolver.getAllPairs() as TokenLikePair[];
          const catalog = buildTokenCatalog(pairs);
          const profileBalances = parseProfileBalances(
            await sdk.profile.getUserBalances(),
          );
          const balanceByAssetId = new Map(
            profileBalances.map((entry) => [entry.assetId, entry]),
          );
          const tokenOptions: WithdrawTokenOption[] = catalog
            .map((entry) => {
              const balanceEntry = balanceByAssetId.get(entry.assetId);
              if (!balanceEntry) {
                return undefined;
              }
              return {
                symbol: entry.symbol,
                assetId: entry.assetId,
                address: entry.address,
                balance: balanceEntry.available,
              };
            })
            .filter(
              (entry): entry is WithdrawTokenOption => entry !== undefined,
            );
          const viewport = {
            width: Math.max(40, process.stdout.columns ?? 80),
            height: Math.max(12, process.stdout.rows ?? 24),
          };
          const { tokenInput, amountInput } =
            options.token && options.amount
              ? { tokenInput: options.token, amountInput: options.amount }
              : await promptForWithdrawInput({
                  tokenOptions,
                  initialToken: options.token,
                  initialAmount: options.amount,
                  viewport,
                });
          const tokenInfo = await resolveTokenInfoFromSelection(
            tokenInput,
            pairs,
            client,
            options.decimals,
            catalog,
          );
          const decimals = tokenInfo.decimals;

          if (decimals === undefined) {
            throw new Error(
              `Unable to determine decimals for token ${tokenInput}. Provide --decimals explicitly.`,
            );
          }

          const vault = sdk.vault;
          const assetId = resolveAssetIdFromPairs(tokenInfo.address, pairs);

          if (!assetId) {
            throw new Error(
              `Unable to resolve asset ID for token ${
                tokenInfo.symbol || tokenInfo.address
              }`,
            );
          }

          assertPositiveAmountInput(amountInput);
          const amount = parseUnits(amountInput, decimals);
          let maxFormatted = "0";

          if (source === "spot") {
            console.log(pc.cyan("💰 Checking profile balance..."));
            const balanceEntry = balanceByAssetId.get(assetId);
            if (!balanceEntry) {
              throw new Error(
                `No balance data returned for asset ${assetId} from Monaco profile.`,
              );
            }

            const availableRaw = parseUnits(balanceEntry.available, decimals);
            if (availableRaw <= 0n) {
              throw new Error(
                `Vault balance is zero for ${
                  tokenInfo.symbol || tokenInfo.address
                }.`,
              );
            }

            maxFormatted = balanceEntry.available;

            if (availableRaw < amount) {
              console.error(
                pc.red(
                  `❌ Insufficient vault balance. Requested ${amountInput}, available: ${maxFormatted}`,
                ),
              );
              exitCode = 1;
              return;
            }
          } else {
            console.log(
              pc.cyan("💰 Checking transferable perps collateral..."),
            );
            const collateral = parseAvailableCollateral(
              await sdk.perps.getAvailableCollateral({ asset: assetId }),
            );
            maxFormatted = collateral.margin_transferable ?? "0";
            const transferableRaw = parseUnits(maxFormatted, decimals);
            if (transferableRaw <= 0n) {
              throw new Error(
                `Perps transferable collateral is zero for ${
                  tokenInfo.symbol || tokenInfo.address
                }.`,
              );
            }

            if (transferableRaw < amount) {
              console.error(
                pc.red(
                  `❌ Insufficient perps collateral. Requested ${amountInput}, transferable: ${maxFormatted}`,
                ),
              );
              exitCode = 1;
              return;
            }
          }

          const tokenLabel = tokenInfo.symbol || tokenInfo.address;
          const baseUiState: WithdrawUiState = {
            stage: "preparing",
            token: tokenLabel,
            amount: amountInput,
            vaultBalance: maxFormatted,
            status:
              source === "perps"
                ? "Preparing perps transfer and withdrawal"
                : "Preparing transaction",
            viewport,
          };
          withdrawUi = await createWithdrawUi(baseUiState);

          withdrawUi.update({
            ...baseUiState,
            stage: "withdrawing",
            status:
              source === "perps"
                ? "Submitting perps transfer and withdrawal"
                : "Submitting withdrawal",
          });

          if (source === "perps") {
            const marginAccountId = await resolveMarginAccountId(
              sdk,
              options.marginAccountId,
            );
            console.log(pc.cyan("📥 Moving collateral from perps to spot..."));
            const transferResult = parseTransferCollateral(
              await sdk.marginAccounts.transferCollateralFromMarginAccount(
                marginAccountId,
                {
                  asset: assetId,
                  amount: amount.toString(),
                },
              ),
            );
            console.log(pc.green("✅ Perps transfer processed"));
            console.log(pc.gray(`   Margin Account: ${marginAccountId}`));
            console.log(
              pc.gray(`   Movement ID: ${transferResult.movement_id}`),
            );
            console.log(pc.gray(`   Status: ${transferResult.status}`));
          }

          console.log(pc.cyan("📤 Submitting withdrawal..."));
          const withdrawResult = await vault.withdraw(assetId, amount, true);

          const statusIcon =
            withdrawResult.status === "confirmed"
              ? pc.green("✅")
              : pc.yellow("⚠️");
          console.log(`${statusIcon} Withdrawal processed`);
          console.log(
            pc.gray(`   Token: ${tokenInfo.symbol || tokenInfo.address}`),
          );
          console.log(pc.gray(`   Source: ${source}`));
          console.log(
            pc.gray(`   Amount: ${amountInput} (raw: ${amount.toString()})`),
          );
          console.log(pc.gray(`   Tx Hash: ${withdrawResult.hash}`));
          console.log(
            pc.gray(`   Tx Url: ${buildSeiscanTxUrl(withdrawResult.hash)}`),
          );
          console.log(pc.gray(`   Status: ${withdrawResult.status}`));
          console.log(pc.gray(`   Nonce: ${withdrawResult.nonce.toString()}`));
          withdrawUi.update({
            ...baseUiState,
            stage: withdrawResult.status === "confirmed" ? "done" : "error",
            status: withdrawResult.status,
            withdrawTxHash: withdrawResult.hash,
            withdrawTxUrl: buildSeiscanTxUrl(withdrawResult.hash),
          });

          if (withdrawResult.status !== "confirmed") {
            exitCode = 1;
          }
        });
      } catch (error) {
        exitCode = 1;
        if (withdrawUi) {
          withdrawUi.update({
            stage: "error",
            token: "Unknown",
            amount: "-",
            vaultBalance: "-",
            status: "Failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
            viewport: {
              width: Math.max(40, process.stdout.columns ?? 80),
              height: Math.max(12, process.stdout.rows ?? 24),
            },
          });
        }
        console.error(
          pc.red(
            `❌ Failed to withdraw funds: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        withdrawUi?.unmount();
        process.exit(exitCode);
      }
    });

  liveCommand
    .command("swap")
    .description("Swap tokens in your live trading account")
    .option("-i, --input <token>", "Token address or symbol to swap from")
    .option("-o, --output <token>", "Token address or symbol to swap to")
    .option("-a, --amount <amount>", "Amount to swap (human-readable)")
    .option(
      "-c, --config <file>",
      "Configuration file path",
      "mach-one-bot.toml",
    )
    .option(
      "--env <environment>",
      "Environment: mainnet, staging, development, or local",
    )
    .action(async (options) => {
      let exitCode = 0;
      let swapUi: SwapUiController | undefined;

      try {
        const prepared = await loadBotConfigWithEnv(
          options.config,
          options.env,
          "staging",
        );

        console.log(pc.cyan("🔗 Connecting to Monaco..."));
        await withMonacoSession(prepared, async ({ sdk, resolver, client }) => {
          const pairs = resolver.getAllPairs() as TokenLikePair[];
          const catalog = buildTokenCatalog(pairs);
          const profileBalances = parseProfileBalances(
            await sdk.profile.getUserBalances(),
          );
          const balanceByAssetId = new Map(
            profileBalances.map((entry) => [entry.assetId, entry]),
          );
          const tokenOptions: SwapTokenOption[] = catalog
            .map((entry) => {
              const balanceEntry = balanceByAssetId.get(entry.assetId);
              if (!balanceEntry) {
                return undefined;
              }
              return {
                symbol: entry.symbol,
                assetId: entry.assetId,
                address: entry.address,
                balance: balanceEntry.available,
              };
            })
            .filter((entry): entry is SwapTokenOption => entry !== undefined);
          const viewport = {
            width: Math.max(40, process.stdout.columns ?? 80),
            height: Math.max(12, process.stdout.rows ?? 24),
          };
          const { inputToken, outputToken, amountInput } =
            await promptForSwapInput({
              tokenOptions,
              initialInput: options.input,
              initialOutput: options.output,
              initialAmount: options.amount,
              viewport,
            });

          const inputTokenInfo = await resolveTokenInfoFromSelection(
            inputToken,
            pairs,
            client,
            undefined,
            catalog,
          );
          const outputTokenInfo = await resolveTokenInfoFromSelection(
            outputToken,
            pairs,
            client,
            undefined,
            catalog,
          );

          if (inputTokenInfo.decimals === undefined) {
            throw new Error(
              `Unable to determine decimals for token ${inputToken}.`,
            );
          }

          if (outputTokenInfo.decimals === undefined) {
            throw new Error(
              `Unable to determine decimals for token ${outputToken}.`,
            );
          }

          if (
            inputTokenInfo.address.toLowerCase() ===
            outputTokenInfo.address.toLowerCase()
          ) {
            throw new Error("Input and output tokens must be different.");
          }

          const inputEntry = getCatalogEntryByAddress(
            inputTokenInfo.address,
            catalog,
          );
          const outputEntry = getCatalogEntryByAddress(
            outputTokenInfo.address,
            catalog,
          );

          if (!inputEntry || !outputEntry) {
            throw new Error("Unable to resolve token metadata for swap.");
          }

          const route = findSwapRoute(inputEntry, outputEntry, pairs, catalog);
          const routeSymbols = [
            inputEntry.symbol,
            ...route.map((step) => step.output.symbol),
          ];

          const assetId = resolveAssetIdFromPairs(
            inputTokenInfo.address,
            pairs,
          );
          if (!assetId) {
            throw new Error(
              `Unable to resolve asset ID for token ${inputEntry.symbol}`,
            );
          }

          console.log(pc.cyan("💰 Checking profile balance..."));
          const balanceEntry = balanceByAssetId.get(assetId);
          if (!balanceEntry) {
            throw new Error(
              `No balance data returned for asset ${assetId} from Monaco profile.`,
            );
          }
          const availableRaw = parseUnits(
            balanceEntry.available,
            inputTokenInfo.decimals,
          );
          if (availableRaw <= 0n) {
            throw new Error(`Vault balance is zero for ${inputEntry.symbol}.`);
          }

          const maxFormatted = balanceEntry.available;

          assertPositiveAmountInput(amountInput);
          const amountParsed = Number(amountInput);
          if (!Number.isFinite(amountParsed)) {
            throw new Error("Amount must be a valid number.");
          }

          const amountRaw = parseUnits(amountInput, inputTokenInfo.decimals);
          if (availableRaw < amountRaw) {
            console.error(
              pc.red(
                `❌ Insufficient vault balance. Requested ${amountInput}, available: ${maxFormatted}`,
              ),
            );
            exitCode = 1;
            return;
          }

          console.log(pc.cyan(`🧭 Route: ${routeSymbols.join(" -> ")}`));

          let runningAmount = amountParsed;
          const legs: SwapLeg[] = [];

          for (const step of route) {
            if (!step.pair.id) {
              throw new Error("Trading pair is missing an identifier.");
            }

            const { bestBid, bestAsk } = await getBestPrices(sdk, step.pair.id);
            const price = step.side === "SELL" ? bestBid : bestAsk;
            const estimatedOutput =
              step.side === "SELL"
                ? runningAmount * price
                : runningAmount / price;

            if (!Number.isFinite(estimatedOutput) || estimatedOutput <= 0) {
              throw new Error("Unable to estimate swap output from orderbook.");
            }

            const baseQuantity =
              step.side === "SELL" ? runningAmount : estimatedOutput;
            if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
              throw new Error("Invalid swap quantity derived from orderbook.");
            }
            const baseDecimals =
              step.side === "SELL" ? step.input.decimals : step.output.decimals;
            const quantityString = formatDecimalAmount(
              baseQuantity,
              baseDecimals,
            );

            legs.push({
              step,
              estimatedOutput,
              quantityString,
            });

            runningAmount = estimatedOutput;
          }

          const estimatedOutputFormatted = formatEstimatedAmount(runningAmount);
          const confirmation = await promptForSwapConfirmation(
            `Swap ${amountInput} ${inputEntry.symbol} → ~${estimatedOutputFormatted} ${outputEntry.symbol}. Continue?`,
            viewport,
          );

          if (!confirmation) {
            console.log(pc.gray("Swap cancelled."));
            return;
          }

          const baseUiState: SwapUiState = {
            stage: "preparing",
            inputToken: inputEntry.symbol,
            outputToken: outputEntry.symbol,
            amount: amountInput,
            vaultBalance: maxFormatted,
            route: routeSymbols.join(" -> "),
            estimatedOutput: `${estimatedOutputFormatted} ${outputEntry.symbol}`,
            status: "Preparing swap",
            viewport,
          };
          swapUi = await createSwapUi(baseUiState);

          for (const [index, leg] of legs.entries()) {
            const { step, quantityString, estimatedOutput } = leg;

            swapUi.update({
              ...baseUiState,
              stage: "executing",
              status: `Executing leg ${index + 1}`,
              currentLeg: index + 1,
              totalLegs: legs.length,
            });

            console.log(
              pc.cyan(
                `🔁 Executing leg ${index + 1}/${legs.length}: ${step.input.symbol} -> ${step.output.symbol}`,
              ),
            );

            const result = await sdk.trading.placeMarketOrder(
              step.pair.id as string,
              step.side,
              quantityString,
              { tradingMode: "SPOT" },
            );

            console.log(
              pc.gray(
                `   Order: ${result.order_id} | Status: ${result.status} | Message: ${result.message}`,
              ),
            );

            if (result.status !== "SUCCESS") {
              exitCode = 1;
              swapUi.update({
                ...baseUiState,
                stage: "error",
                status: result.status,
                currentLeg: index + 1,
                totalLegs: legs.length,
              });
              break;
            }

            if (index === legs.length - 1) {
              console.log(
                pc.green(
                  `✅ Swap completed. Estimated output: ~${formatEstimatedAmount(
                    estimatedOutput,
                  )} ${outputEntry.symbol}`,
                ),
              );
              swapUi.update({
                ...baseUiState,
                stage: "done",
                status: "SUCCESS",
                currentLeg: index + 1,
                totalLegs: legs.length,
              });
            }
          }
        });
      } catch (error) {
        exitCode = 1;
        if (swapUi) {
          swapUi.update({
            stage: "error",
            inputToken: "Unknown",
            outputToken: "Unknown",
            amount: "-",
            vaultBalance: "-",
            status: "Failed",
            errorMessage:
              error instanceof Error ? error.message : String(error),
            viewport: {
              width: Math.max(40, process.stdout.columns ?? 80),
              height: Math.max(12, process.stdout.rows ?? 24),
            },
          });
        }
        console.error(
          pc.red(
            `❌ Failed to swap tokens: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      } finally {
        swapUi?.unmount();
        process.exit(exitCode);
      }
    });
};
