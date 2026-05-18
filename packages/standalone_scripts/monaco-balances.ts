import "dotenv/config";

import { createMonacoSDK } from "@0xmonaco/core";
import type { AccountBalance, GetUserBalancesResponse, TradingPair } from "@0xmonaco/types";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sei, seiTestnet } from "viem/chains";

type TokenEntry = {
  symbol: string;
  contract?: string;
  assetId?: string;
};

const API_URLS: Record<string, string> = {
  mainnet: "https://api.monaco.xyz",
  development: "https://develop.apimonaco.xyz",
  staging: "https://staging.apimonaco.xyz",
  local: "http://localhost:8080",
};

const DEFAULT_RPC_URLS: Record<string, string> = {
  mainnet: "https://evm-rpc.sei-apis.com",
  testnet: "https://evm-rpc-testnet.sei-apis.com",
};

function normalizePrivateKey(value: string): `0x${string}` {
  return value.startsWith("0x") ? (value as `0x${string}`) : (`0x${value}` as `0x${string}`);
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function resolveApiUrl(network: string): string {
  if (isUrl(network)) {
    return network;
  }

  const apiUrl = API_URLS[network];
  if (!apiUrl) {
    throw new Error(`Unsupported MONACO_ENV '${network}'. Expected one of ${Object.keys(API_URLS).join(", ")} or a valid URL.`);
  }

  return apiUrl;
}

function buildWsUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  const base = url.toString().replace(/\/$/, "");
  return `${base}/ws`;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = getString(record[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function parsePairSymbol(symbol?: string): { base?: string; quote?: string } {
  if (!symbol) return {};
  const normalized = symbol.includes("/") ? symbol : symbol.replace("-", "/");
  const [base, quote] = normalized.split("/");
  return { base, quote };
}

function extractTokens(pairs: TradingPair[]): Map<string, TokenEntry> {
  const tokens = new Map<string, TokenEntry>();

  for (const pair of pairs) {
    const parsed = parsePairSymbol(pair.symbol);

    const baseSymbol = pair.base_token || parsed.base || "";
    const quoteSymbol = pair.quote_token || parsed.quote || "";

    const baseContract = pair.base_token_contract;
    const quoteContract = pair.quote_token_contract;

    const baseAssetId = pair.base_asset_id;
    const quoteAssetId = pair.quote_asset_id;

    if (baseContract) {
      const key = baseContract.toLowerCase();
      tokens.set(key, {
        symbol: baseSymbol || tokens.get(key)?.symbol || baseContract,
        contract: baseContract,
        assetId: baseAssetId || tokens.get(key)?.assetId,
      });
    }

    if (quoteContract) {
      const key = quoteContract.toLowerCase();
      tokens.set(key, {
        symbol: quoteSymbol || tokens.get(key)?.symbol || quoteContract,
        contract: quoteContract,
        assetId: quoteAssetId || tokens.get(key)?.assetId,
      });
    }
  }

  return tokens;
}

function findProfileBalance(
  balances: AccountBalance[] | undefined,
  symbol: string,
): AccountBalance | undefined {
  if (!balances?.length) return undefined;
  const target = symbol.toUpperCase();

  return balances.find((balance) => balance.symbol.toUpperCase() === target);
}

function formatProfileBalance(balance: AccountBalance | undefined): string {
  if (!balance) return "n/a";
  const available = balance.available_balance || "0";
  const locked = balance.locked_balance || "0";
  const total = balance.total_balance || "0";
  return `available=${available} locked=${locked} total=${total}`;
}

function formatVaultBalance(balance: unknown): string {
  if (!balance || typeof balance !== "object") return "n/a";
  const record = balance as Record<string, unknown>;
  const formatted = readString(record, ["formatted"]);
  const symbol = readString(record, ["symbol"]);
  if (formatted && symbol) {
    return `${formatted} ${symbol}`;
  }
  if (formatted) {
    return formatted;
  }
  const amount = readString(record, ["amount"]);
  return amount || "n/a";
}

async function fetchAllTradingPairs(sdk: ReturnType<typeof createMonacoSDK>): Promise<TradingPair[]> {
  const pairs: TradingPair[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await sdk.market.getPaginatedTradingPairs({
      page,
      limit: 100,
      is_active: true,
    });

    if (!response?.success || !response.data?.data) {
      throw new Error(`Failed to fetch trading pairs (page ${page}).`);
    }

    pairs.push(...response.data.data);
    totalPages = response.data.total_pages || totalPages;
    page += 1;
  }

  return pairs;
}

async function main(): Promise<void> {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  const clientId = process.env.MONACO_CLIENT_ID;
  const network = process.env.MONACO_ENV || "staging";

  if (!privateKey) {
    throw new Error("WALLET_PRIVATE_KEY is required in .env.");
  }

  if (!clientId) {
    throw new Error("MONACO_CLIENT_ID is required in .env.");
  }

  const apiUrl = resolveApiUrl(network);
  const wsUrl = buildWsUrl(apiUrl);
  const isMainnet = network === "mainnet";

  const rpcUrl =
    process.env.MONACO_RPC_URL ||
    (isMainnet ? DEFAULT_RPC_URLS.mainnet : DEFAULT_RPC_URLS.testnet);

  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const chain = isMainnet ? sei : seiTestnet;

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  const sdk = createMonacoSDK({
    walletClient,
    network,
    seiRpcUrl: rpcUrl,
    wsUrl,
  });

  await sdk.login(clientId, { connectWebSocket: false });

  const profileBalances: GetUserBalancesResponse = await sdk.profile.getUserBalances();
  const pairs = await fetchAllTradingPairs(sdk);
  const tokens = Array.from(extractTokens(pairs).values());

  console.log(`\nFound ${tokens.length} tokens from ${pairs.length} trading pairs.\n`);

  for (const token of tokens) {
    const profileBalance = findProfileBalance(profileBalances.balances, token.symbol);
    let vaultBalance: unknown = "n/a";

    if (token.assetId) {
      try {
        vaultBalance = await sdk.vault.getBalance(token.assetId);
      } catch (error) {
        vaultBalance = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      vaultBalance = "missing asset id";
    }

    console.log(`${token.symbol}`);
    console.log(`  contract: ${token.contract || "n/a"}`);
    console.log(`  assetId: ${token.assetId || "n/a"}`);
    console.log(`  profile: ${formatProfileBalance(profileBalance)}`);
    console.log(`  vault: ${formatVaultBalance(vaultBalance)}`);
    console.log("");
  }

  await sdk.logout().catch(() => undefined);
  sdk.ws?.disconnect?.();
  setTimeout(() => {
    process.exit(0);
  }, 0);
}

main().catch((error) => {
  console.error("\nFailed to fetch balances:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
