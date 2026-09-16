import type { Mach1SDK } from "../sdk";
import { TRADING_PAIR_REFRESH_INTERVAL_MS } from "./constants";
import { createLogger } from "./runtime-utils";

const logger = createLogger("TradingPairResolver");

function normalizeTradingPair(value: unknown): ResolvedTradingPair | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const pair = value as Record<string, unknown>;
  const readString = (camel: string, snake: string): string => {
    const field = pair[camel] ?? pair[snake];
    return typeof field === "string" ? field : "";
  };
  const readNumber = (camel: string, snake: string): number => {
    const field = pair[camel] ?? pair[snake];
    return typeof field === "number" && Number.isFinite(field) ? field : 0;
  };

  const normalized: ResolvedTradingPair = {
    id: readString("id", "id"),
    symbol: readString("symbol", "symbol"),
    base_token: readString("baseToken", "base_token"),
    quote_token: readString("quoteToken", "quote_token"),
    base_token_contract: readString("baseTokenContract", "base_token_contract"),
    quote_token_contract: readString(
      "quoteTokenContract",
      "quote_token_contract",
    ),
    base_decimals: readNumber("baseDecimals", "base_decimals"),
    quote_decimals: readNumber("quoteDecimals", "quote_decimals"),
    market_type: readString("marketType", "market_type"),
    is_active: Boolean(pair.isActive ?? pair.is_active),
    maker_fee_bps: readNumber("makerFeeBps", "maker_fee_bps"),
    taker_fee_bps: readNumber("takerFeeBps", "taker_fee_bps"),
    min_order_size: readString("minOrderSize", "min_order_size"),
    max_order_size: readString("maxOrderSize", "max_order_size"),
    quantity_step_size: readString("quantityStepSize", "quantity_step_size"),
    tick_size: readString("tickSize", "tick_size"),
  };

  const baseAssetId = readString("baseAssetId", "base_asset_id");
  const quoteAssetId = readString("quoteAssetId", "quote_asset_id");
  if (baseAssetId) normalized.base_asset_id = baseAssetId;
  if (quoteAssetId) normalized.quote_asset_id = quoteAssetId;

  return normalized.id && normalized.symbol && normalized.market_type
    ? normalized
    : undefined;
}

function normalizeTradingPairsResponse(
  response: unknown,
): ResolvedTradingPair[] | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const body = response as Record<string, unknown>;
  const nested =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : undefined;
  const candidates = [
    body.tradingPairs,
    body.trading_pairs,
    Array.isArray(body.data) ? body.data : undefined,
    nested?.tradingPairs,
    nested?.trading_pairs,
    nested?.data,
  ];
  const rows = candidates.find(Array.isArray);

  if (!rows) {
    return undefined;
  }

  return rows
    .map((pair) => normalizeTradingPair(pair))
    .filter((pair): pair is ResolvedTradingPair => pair !== undefined);
}

function getTradingPairsTotalPages(response: unknown): number | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const parseNumber = (value: unknown): number | undefined => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  };

  const body = response as {
    totalPages?: unknown;
    total_pages?: unknown;
    total?: unknown;
    data?: unknown;
  };

  const totalFromBody = parseNumber(
    body.totalPages ?? body.total_pages ?? body.total,
  );
  if (totalFromBody !== undefined) {
    return totalFromBody;
  }

  if (!body.data || typeof body.data !== "object") {
    return undefined;
  }

  const nested = body.data as {
    totalPages?: unknown;
    total_pages?: unknown;
    total?: unknown;
  };

  return parseNumber(nested.totalPages ?? nested.total_pages ?? nested.total);
}

function filterSpotTradingPairs(
  tradingPairs: ResolvedTradingPair[],
): ResolvedTradingPair[] {
  return tradingPairs.filter(
    (pair) => pair.market_type?.toUpperCase() === "SPOT",
  );
}

export interface ResolvedTradingPair {
  id: string;
  symbol: string;
  base_token: string;
  quote_token: string;
  base_asset_id?: string;
  quote_asset_id?: string;
  base_token_contract: string;
  quote_token_contract: string;
  base_decimals: number;
  quote_decimals: number;
  market_type: string;
  is_active: boolean;
  maker_fee_bps: number;
  taker_fee_bps: number;
  min_order_size: string;
  max_order_size: string;
  quantity_step_size: string;
  tick_size: string;
}

export class TradingPairResolver {
  private symbolToId: Map<string, string> = new Map();
  private idToSymbol: Map<string, string> = new Map();
  private idToFullPair: Map<string, ResolvedTradingPair> = new Map();
  private sdk: Mach1SDK | null = null;
  private refreshTimer?: NodeJS.Timeout;
  private lastRefreshTime = 0;
  private isInitialized = false;

  async initialize(sdk: Mach1SDK): Promise<void> {
    this.sdk = sdk;

    logger.debug("Initializing trading pair resolver");

    try {
      await this.fetchAllTradingPairs();
      this.isInitialized = true;
      this.startBackgroundRefresh();

      logger.debug("Trading pair resolver initialized", {
        totalPairs: this.symbolToId.size,
        nextRefresh: new Date(
          Date.now() + TRADING_PAIR_REFRESH_INTERVAL_MS,
        ).toISOString(),
      });
    } catch (error) {
      logger.error(
        "Failed to initialize trading pair resolver",
        {},
        error as Error,
      );
      throw error;
    }
  }

  private async fetchAllTradingPairs(): Promise<void> {
    if (!this.sdk) {
      throw new Error("SDK not initialized. Call initialize() first.");
    }

    const allPairs: ResolvedTradingPair[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const response = await this.sdk.market.getPaginatedTradingPairs({
        page,
        pageSize: 100,
        isActive: true,
      });

      const tradingPairs = normalizeTradingPairsResponse(response);
      const fetchedTotalPages = getTradingPairsTotalPages(response);

      if (!tradingPairs || fetchedTotalPages === undefined) {
        throw new Error("Failed to fetch trading pairs from Monaco SDK");
      }

      allPairs.push(...filterSpotTradingPairs(tradingPairs));
      totalPages = fetchedTotalPages;
      page++;
    }

    this.buildMappings(allPairs);
    this.lastRefreshTime = Date.now();
  }

  private buildMappings(pairs: ResolvedTradingPair[]): void {
    this.symbolToId.clear();
    this.idToSymbol.clear();
    this.idToFullPair.clear();

    for (const pair of pairs) {
      const normalizedSymbol = this.normalizeSymbol(pair.symbol);
      this.symbolToId.set(normalizedSymbol, pair.id);
      this.idToSymbol.set(pair.id, normalizedSymbol);
      this.idToFullPair.set(pair.id, pair);
      this.symbolToId.set(pair.symbol, pair.id);
    }
  }

  normalizeSymbol(monacoSymbol: string): string {
    let normalized = monacoSymbol.replace("-", "/");

    normalized = normalized
      .replace(/^WETH\//, "ETH/")
      .replace(/^WBTC\//, "BTC/")
      .replace(/^WSOL\//, "SOL/");

    return normalized;
  }

  private toMonacoFormat(internalSymbol: string): string {
    let monacoSymbol = internalSymbol.replace("/", "-");

    monacoSymbol = monacoSymbol
      .replace(/^ETH-/, "WETH-")
      .replace(/^BTC-/, "WBTC-")
      .replace(/^SOL-/, "WSOL-");

    return monacoSymbol;
  }

  resolveSymbolToId(symbol: string): string {
    if (!this.isInitialized) {
      throw new Error(
        "TradingPairResolver not initialized. Call initialize() first.",
      );
    }

    let pairId = this.symbolToId.get(symbol);

    if (!pairId) {
      pairId = this.symbolToId.get(this.toMonacoFormat(symbol));
    }

    if (!pairId) {
      const timeUntilRefresh = Math.max(
        0,
        this.lastRefreshTime + TRADING_PAIR_REFRESH_INTERVAL_MS - Date.now(),
      );
      const hoursUntilRefresh = Math.ceil(timeUntilRefresh / (60 * 60 * 1000));

      throw new Error(
        `Trading pair symbol not found: ${symbol}. Cache will refresh in approximately ${hoursUntilRefresh} hours. Available symbols: ${Array.from(this.symbolToId.keys()).slice(0, 5).join(", ")}...`,
      );
    }

    return pairId;
  }

  resolvePairIdToSymbol(pairId: string): string | undefined {
    return this.idToSymbol.get(pairId);
  }

  getPairById(pairId: string): ResolvedTradingPair | undefined {
    return this.idToFullPair.get(pairId);
  }

  getPairBySymbol(symbol: string): ResolvedTradingPair | undefined {
    const pairId = this.symbolToId.get(symbol);
    return pairId ? this.idToFullPair.get(pairId) : undefined;
  }

  getPairByContracts(
    base: string,
    quote: string,
  ): ResolvedTradingPair | undefined {
    const baseNorm = base.toLowerCase();
    const quoteNorm = quote.toLowerCase();

    for (const pair of this.idToFullPair.values()) {
      if (
        pair.base_token_contract?.toLowerCase() === baseNorm &&
        pair.quote_token_contract?.toLowerCase() === quoteNorm
      ) {
        return pair;
      }
    }

    return undefined;
  }

  getAssetIdByTokenAddress(tokenAddress: string): string | undefined {
    const normalized = tokenAddress.toLowerCase();

    for (const pair of this.idToFullPair.values()) {
      if (pair.base_token_contract?.toLowerCase() === normalized) {
        return pair.base_asset_id;
      }
      if (pair.quote_token_contract?.toLowerCase() === normalized) {
        return pair.quote_asset_id;
      }
    }

    return undefined;
  }

  getAllSymbols(): string[] {
    return Array.from(this.symbolToId.keys());
  }

  private startBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(() => {
      this.refreshInBackground().catch((error) => {
        logger.debug("Background refresh failed (will retry)", {
          error: error instanceof Error ? error.message : String(error),
          nextRetry: new Date(
            Date.now() + TRADING_PAIR_REFRESH_INTERVAL_MS,
          ).toISOString(),
        });
      });
    }, TRADING_PAIR_REFRESH_INTERVAL_MS);

    this.refreshTimer.unref?.();
  }

  private async refreshInBackground(): Promise<void> {
    if (!this.sdk) {
      return;
    }

    try {
      await this.fetchAllTradingPairs();
    } catch (error) {
      logger.debug("Background refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async refresh(): Promise<void> {
    if (!this.sdk) {
      throw new Error("SDK not initialized. Call initialize() first.");
    }

    await this.fetchAllTradingPairs();
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  getCacheStats(): {
    totalPairs: number;
    lastRefresh: Date;
    nextRefresh: Date;
    isInitialized: boolean;
  } {
    return {
      totalPairs: this.symbolToId.size,
      lastRefresh: new Date(this.lastRefreshTime),
      nextRefresh: new Date(
        this.lastRefreshTime + TRADING_PAIR_REFRESH_INTERVAL_MS,
      ),
      isInitialized: this.isInitialized,
    };
  }

  getAllPairs(): ResolvedTradingPair[] {
    if (!this.isInitialized) {
      throw new Error(
        "TradingPairResolver not initialized. Call initialize() first.",
      );
    }

    return Array.from(this.idToFullPair.values());
  }
}

export const tradingPairResolver = new TradingPairResolver();
