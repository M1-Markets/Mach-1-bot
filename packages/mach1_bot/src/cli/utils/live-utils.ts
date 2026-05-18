import type { Mach1SDK } from "mach1_sdk";
import pc from "picocolors";
import prompts from "prompts";
import { createPublicClient, formatUnits, zeroAddress } from "viem";
import { resolveMonacoApiUrl } from "@/shared/constants/monaco";
import type { ChainNetwork, MonacoEnvironment } from "@/shared/types/common";
import {
  getNumberProp,
  getStringProp,
  isRecord,
} from "@/shared/utils/record-utils";

export const erc20Abi = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type TokenInfo = {
  address: `0x${string}`;
  symbol?: string;
  decimals?: number;
};

export type TokenLikePair = {
  id?: string;
  base_token: string;
  quote_token: string;
  base_asset_id?: string;
  quote_asset_id?: string;
  base_token_contract: string;
  quote_token_contract: string;
  base_decimals: number;
  quote_decimals: number;
  symbol?: string;
};

export type TokenCatalogEntry = {
  symbol: string;
  assetId: string;
  address: `0x${string}`;
  decimals: number;
};

export type SwapStep = {
  pair: TokenLikePair;
  input: TokenCatalogEntry;
  output: TokenCatalogEntry;
  side: "BUY" | "SELL";
};

export type SwapLeg = {
  step: SwapStep;
  estimatedOutput: number;
  quantityString: string;
};

export const isHexAddress = (value: string): value is `0x${string}` =>
  /^0x[a-fA-F0-9]{40}$/.test(value);

export const isZeroAddress = (value: string): value is `0x${string}` =>
  value.toLowerCase() === zeroAddress;

export const buildTokenCatalog = (
  pairs: TokenLikePair[],
): TokenCatalogEntry[] => {
  const catalog = new Map<string, TokenCatalogEntry>();

  for (const pair of pairs) {
    if (pair.base_asset_id && isHexAddress(pair.base_token_contract)) {
      const key = pair.base_token_contract.toLowerCase();
      if (!catalog.has(key)) {
        catalog.set(key, {
          symbol: pair.base_token,
          assetId: pair.base_asset_id,
          address: pair.base_token_contract as `0x${string}`,
          decimals: pair.base_decimals,
        });
      }
    }

    if (pair.quote_asset_id && isHexAddress(pair.quote_token_contract)) {
      const key = pair.quote_token_contract.toLowerCase();
      if (!catalog.has(key)) {
        catalog.set(key, {
          symbol: pair.quote_token,
          assetId: pair.quote_asset_id,
          address: pair.quote_token_contract as `0x${string}`,
          decimals: pair.quote_decimals,
        });
      }
    }
  }

  return Array.from(catalog.values()).sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
};

export const renderTokenCatalog = (catalog: TokenCatalogEntry[]): void => {
  console.log(pc.cyan("Available tokens:"));
  catalog.forEach((entry, index) => {
    console.log(
      `   ${index + 1}) ${pc.bold(entry.symbol)} ${pc.gray(
        `(${entry.assetId})`,
      )}`,
    );
  });
};

export const fetchWalletBalancesForCatalog = async (
  client: ReturnType<typeof createPublicClient>,
  catalog: TokenCatalogEntry[],
  walletAddress: string,
): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    catalog.map(async (entry) => {
      const balance = await fetchWalletBalance(
        client,
        entry.address,
        walletAddress,
      );

      return [
        entry.address.toLowerCase(),
        formatUnits(balance, entry.decimals),
      ] as const;
    }),
  );

  return new Map(entries);
};

export const fetchWalletBalance = async (
  client: ReturnType<typeof createPublicClient>,
  tokenAddress: `0x${string}`,
  walletAddress: string,
): Promise<bigint> =>
  isZeroAddress(tokenAddress)
    ? await client.getBalance({
        address: walletAddress as `0x${string}`,
      })
    : ((await client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress as `0x${string}`],
      })) as bigint);

export const renderTokenCatalogWithBalances = (
  catalog: TokenCatalogEntry[],
  balances: Map<string, string>,
): void => {
  console.log(pc.cyan("Available tokens:"));
  catalog.forEach((entry, index) => {
    const formattedBalance = balances.get(entry.address.toLowerCase()) ?? "0";
    console.log(
      `   ${index + 1}) ${pc.bold(entry.symbol)} ${pc.gray(
        `(${entry.assetId})`,
      )} ${pc.gray(`wallet: ${formattedBalance}`)}`,
    );
  });
};

export const resolveTokenSelectionInput = async (
  tokenInput: string | undefined,
  catalog: TokenCatalogEntry[],
  options?: {
    renderList?: boolean;
    promptMessage?: string;
    walletBalances?: Map<string, string>;
  },
): Promise<string> => {
  const trimmed = tokenInput?.trim() ?? "";
  if (trimmed.length > 0) {
    return trimmed;
  }

  if (catalog.length === 0) {
    throw new Error("No tokens available from trading pairs.");
  }

  if (options?.renderList !== false) {
    if (options?.walletBalances) {
      renderTokenCatalogWithBalances(catalog, options.walletBalances);
    } else {
      renderTokenCatalog(catalog);
    }
  }
  const response = await prompts({
    type: "text",
    name: "token",
    message: pc.yellow(
      options?.promptMessage ?? "Enter number, symbol, asset id, or address",
    ),
  });

  const selected = String(response.token ?? "").trim();
  if (!selected) {
    throw new Error("Token selection is required.");
  }

  return selected;
};

export const getCatalogEntryBySelection = (
  tokenInput: string,
  catalog: TokenCatalogEntry[],
): TokenCatalogEntry | undefined => {
  const trimmed = tokenInput.trim();
  const parsedIndex = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(parsedIndex) && String(parsedIndex) === trimmed) {
    return catalog[parsedIndex - 1];
  }

  const normalized = trimmed.toLowerCase();
  return catalog.find(
    (entry) =>
      entry.symbol.toLowerCase() === normalized ||
      entry.assetId.toLowerCase() === normalized ||
      entry.address.toLowerCase() === normalized,
  );
};

export const getCatalogEntryByAddress = (
  address: `0x${string}`,
  catalog: TokenCatalogEntry[],
): TokenCatalogEntry | undefined => {
  const normalized = address.toLowerCase();
  return catalog.find((entry) => entry.address.toLowerCase() === normalized);
};

export const resolveAssetIdFromPairs = (
  tokenAddress: `0x${string}`,
  pairs: TokenLikePair[],
): string | undefined => {
  const normalized = tokenAddress.toLowerCase();
  for (const pair of pairs) {
    if (pair.base_token_contract?.toLowerCase() === normalized) {
      return pair.base_asset_id;
    }
    if (pair.quote_token_contract?.toLowerCase() === normalized) {
      return pair.quote_asset_id;
    }
  }
  return undefined;
};

export const findTokenInfoFromPairs = (
  tokenInput: string,
  pairs: TokenLikePair[],
): TokenInfo | undefined => {
  const normalized = tokenInput.toUpperCase();

  for (const pair of pairs) {
    if (pair.base_token.toUpperCase() === normalized) {
      return {
        address: pair.base_token_contract as `0x${string}`,
        symbol: pair.base_token,
        decimals: pair.base_decimals,
      };
    }

    if (pair.quote_token.toUpperCase() === normalized) {
      return {
        address: pair.quote_token_contract as `0x${string}`,
        symbol: pair.quote_token,
        decimals: pair.quote_decimals,
      };
    }
  }

  return undefined;
};

export const findTokenInfoByAssetId = (
  assetIdInput: string,
  pairs: TokenLikePair[],
): TokenInfo | undefined => {
  const normalized = assetIdInput.trim().toLowerCase();

  for (const pair of pairs) {
    if (pair.base_asset_id?.toLowerCase() === normalized) {
      return {
        address: pair.base_token_contract as `0x${string}`,
        symbol: pair.base_token,
        decimals: pair.base_decimals,
      };
    }

    if (pair.quote_asset_id?.toLowerCase() === normalized) {
      return {
        address: pair.quote_token_contract as `0x${string}`,
        symbol: pair.quote_token,
        decimals: pair.quote_decimals,
      };
    }
  }

  return undefined;
};

export const findTokenInfoByAddress = (
  tokenAddress: string,
  pairs: TokenLikePair[],
): TokenInfo | undefined => {
  const normalized = tokenAddress.toLowerCase();

  for (const pair of pairs) {
    if (pair.base_token_contract?.toLowerCase() === normalized) {
      return {
        address: pair.base_token_contract as `0x${string}`,
        symbol: pair.base_token,
        decimals: pair.base_decimals,
      };
    }

    if (pair.quote_token_contract?.toLowerCase() === normalized) {
      return {
        address: pair.quote_token_contract as `0x${string}`,
        symbol: pair.quote_token,
        decimals: pair.quote_decimals,
      };
    }
  }

  return undefined;
};

export const resolveTokenInfo = async (
  tokenInput: string,
  pairs: TokenLikePair[],
  client: ReturnType<typeof createPublicClient>,
  decimalsOverride?: number,
): Promise<TokenInfo> => {
  let tokenInfo: TokenInfo | undefined;
  const trimmedInput = tokenInput.trim();

  tokenInfo = findTokenInfoByAssetId(trimmedInput, pairs);

  if (!tokenInfo) {
    if (isHexAddress(trimmedInput)) {
      tokenInfo = findTokenInfoByAddress(trimmedInput, pairs) || {
        address: trimmedInput as `0x${string}`,
      };
    } else {
      tokenInfo = findTokenInfoFromPairs(trimmedInput, pairs);
    }
  }

  if (!tokenInfo) {
    throw new Error(
      `Token '${tokenInput}' not found in known trading pairs. Please provide a token address instead.`,
    );
  }

  if (typeof decimalsOverride === "number" && !Number.isNaN(decimalsOverride)) {
    tokenInfo.decimals = decimalsOverride;
  }

  if (tokenInfo.decimals === undefined) {
    if (isZeroAddress(tokenInfo.address)) {
      return tokenInfo;
    }
    const decimals = (await client.readContract({
      address: tokenInfo.address,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;

    tokenInfo.decimals = decimals;
  }

  return tokenInfo;
};

export const resolveTokenInfoFromSelection = async (
  tokenInput: string,
  pairs: TokenLikePair[],
  client: ReturnType<typeof createPublicClient>,
  decimalsOverride: number | undefined,
  catalog: TokenCatalogEntry[],
): Promise<TokenInfo> => {
  const selected = getCatalogEntryBySelection(tokenInput, catalog);
  if (selected) {
    return resolveTokenInfo(selected.address, pairs, client, decimalsOverride);
  }

  return resolveTokenInfo(tokenInput, pairs, client, decimalsOverride);
};

export const assertPositiveAmountInput = (amountInput: string): void => {
  const parsedAmount = Number(amountInput);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Amount must be a positive number");
  }
};

export const promptForAmountInput = async (
  promptMessage: string,
  maxFormatted: string,
): Promise<string> => {
  const response = await prompts({
    type: "text",
    name: "amount",
    message: pc.yellow(promptMessage),
    initial: maxFormatted,
    validate: (value) => {
      const trimmed = String(value).trim();
      if (!trimmed) {
        return true;
      }
      const parsedAmount = Number(trimmed);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return "Amount must be a positive number";
      }
      return true;
    },
  });

  const amountInput = String(response.amount ?? "").trim();
  return amountInput.length > 0 ? amountInput : maxFormatted;
};

export const findPairBetween = (
  left: `0x${string}`,
  right: `0x${string}`,
  pairs: TokenLikePair[],
): TokenLikePair | undefined => {
  const leftNormalized = left.toLowerCase();
  const rightNormalized = right.toLowerCase();

  return pairs.find((pair) => {
    const base = pair.base_token_contract?.toLowerCase();
    const quote = pair.quote_token_contract?.toLowerCase();
    return (
      (base === leftNormalized && quote === rightNormalized) ||
      (base === rightNormalized && quote === leftNormalized)
    );
  });
};

export const resolveSwapStep = (
  input: TokenCatalogEntry,
  output: TokenCatalogEntry,
  pair: TokenLikePair,
): SwapStep => {
  const base = pair.base_token_contract.toLowerCase();
  const quote = pair.quote_token_contract.toLowerCase();

  if (
    input.address.toLowerCase() === base &&
    output.address.toLowerCase() === quote
  ) {
    return { pair, input, output, side: "SELL" };
  }

  if (
    input.address.toLowerCase() === quote &&
    output.address.toLowerCase() === base
  ) {
    return { pair, input, output, side: "BUY" };
  }

  throw new Error(
    `Trading pair ${pair.symbol ?? pair.base_token}/${pair.quote_token} does not match requested swap.`,
  );
};

export const findSwapRoute = (
  input: TokenCatalogEntry,
  output: TokenCatalogEntry,
  pairs: TokenLikePair[],
  catalog: TokenCatalogEntry[],
): SwapStep[] => {
  const directPair = findPairBetween(input.address, output.address, pairs);
  if (directPair) {
    return [resolveSwapStep(input, output, directPair)];
  }

  const catalogByAddress = new Map(
    catalog.map((entry) => [entry.address.toLowerCase(), entry]),
  );

  const neighbors = new Map<string, TokenCatalogEntry>();
  for (const pair of pairs) {
    const base = pair.base_token_contract?.toLowerCase();
    const quote = pair.quote_token_contract?.toLowerCase();

    if (base === input.address.toLowerCase()) {
      const neighbor = catalogByAddress.get(quote ?? "");
      if (neighbor) {
        neighbors.set(neighbor.address.toLowerCase(), neighbor);
      }
    }

    if (quote === input.address.toLowerCase()) {
      const neighbor = catalogByAddress.get(base ?? "");
      if (neighbor) {
        neighbors.set(neighbor.address.toLowerCase(), neighbor);
      }
    }
  }

  const preferred = Array.from(neighbors.values()).sort((left, right) => {
    const leftIsUsdc = left.symbol.toUpperCase() === "USDC";
    const rightIsUsdc = right.symbol.toUpperCase() === "USDC";
    if (leftIsUsdc !== rightIsUsdc) {
      return leftIsUsdc ? -1 : 1;
    }
    return left.symbol.localeCompare(right.symbol);
  });

  for (const middle of preferred) {
    const firstPair = findPairBetween(input.address, middle.address, pairs);
    const secondPair = findPairBetween(middle.address, output.address, pairs);
    if (firstPair && secondPair) {
      return [
        resolveSwapStep(input, middle, firstPair),
        resolveSwapStep(middle, output, secondPair),
      ];
    }
  }

  throw new Error(
    `No swap route found between ${input.symbol} and ${output.symbol}.`,
  );
};

export const parseOrderbookPrice = (label: string, value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label} from orderbook: ${value}`);
  }
  return parsed;
};

export const getBestPrices = async (
  sdk: Mach1SDK,
  pairId: string,
): Promise<{ bestBid: number; bestAsk: number }> => {
  const orderbook = await sdk.orderbook.getOrderbook(pairId, {
    depth: 1,
    tradingMode: "SPOT",
    magnitude: 1,
    denomination: "BASE",
  });

  const bestBidRaw =
    orderbook.bestBid ??
    (orderbook.bids.length > 0 ? orderbook.bids[0].price : undefined);
  const bestAskRaw =
    orderbook.bestAsk ??
    (orderbook.asks.length > 0 ? orderbook.asks[0].price : undefined);

  if (!bestBidRaw || !bestAskRaw) {
    throw new Error("Orderbook missing best bid/ask pricing.");
  }

  return {
    bestBid: parseOrderbookPrice("best bid", bestBidRaw),
    bestAsk: parseOrderbookPrice("best ask", bestAskRaw),
  };
};

export const formatDecimalAmount = (
  value: number,
  decimals: number,
): string => {
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "");
};

export const formatEstimatedAmount = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
};

export const resolveFaucetBaseUrl = (
  network: ChainNetwork,
  environment: MonacoEnvironment,
): string => {
  const isTestnet = environment !== "mainnet" && network !== "mainnet";
  if (!isTestnet) {
    throw new Error("Faucet is only available on testnet environments.");
  }

  return resolveMonacoApiUrl(environment);
};

export const formatFaucetResponse = (
  data: unknown,
): {
  success: boolean;
  remainingRequests?: number;
  minted: Array<{
    assetId: string;
    symbol: string;
    amount: string;
    txHash: string;
  }>;
  failed: Array<{
    assetId: string;
    symbol: string;
    error: string;
  }>;
} => {
  const record = isRecord(data) ? data : {};
  const minted = Array.isArray(record.minted) ? record.minted : [];
  const failed = Array.isArray(record.failed) ? record.failed : [];

  return {
    success: record.success === true,
    remainingRequests:
      getNumberProp(record, "remaining_requests_24h") ?? undefined,
    minted: minted.map((entry) => {
      const item = isRecord(entry) ? entry : {};
      return {
        assetId: getStringProp(item, "asset_id") ?? "unknown",
        symbol: getStringProp(item, "symbol") ?? "UNKNOWN",
        amount: getStringProp(item, "amount") ?? "0",
        txHash: getStringProp(item, "tx_hash") ?? "unknown",
      };
    }),
    failed: failed.map((entry) => {
      const item = isRecord(entry) ? entry : {};
      return {
        assetId: getStringProp(item, "asset_id") ?? "unknown",
        symbol: getStringProp(item, "symbol") ?? "UNKNOWN",
        error: getStringProp(item, "error") ?? "unknown error",
      };
    }),
  };
};
