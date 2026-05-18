import type { Mach1SDK } from "../sdk";
import { TRADING_PAIR_REFRESH_INTERVAL_MS } from "./constants";
import { createLogger } from "./runtime-utils";

const logger = createLogger("TradingPairResolver");

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
        page_size: 100,
        is_active: true,
      });

      allPairs.push(...response.trading_pairs);
      totalPages = response.total_pages;
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
