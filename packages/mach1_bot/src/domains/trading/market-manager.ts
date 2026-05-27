import type {
  Candlestick as MonacoCandlestick,
  Interval,
  Mach1SDK,
  OrderbookEvent as MonacoOrderbookEvent,
  TradeEvent as MonacoTradeEvent,
  TradingPair as MonacoTradingPair,
} from "mach1_sdk";
import { tradingPairResolver } from "mach1_sdk";
import { parseUnits } from "viem";
import { MarketDataUnavailableError } from "@/shared/errors";
import {
  Address,
  type MarketDataMode,
  OHLCV,
  TradingPair,
} from "@/shared/types/common";
import type { LiveTradingMarketMode } from "@/shared/types/config";
import type {
  BestPrices,
  InternalOrderBook,
  InternalTrade,
} from "@/shared/types/internal-events";
import {
  type Clock,
  type Rng,
  realClock,
  realRng,
} from "@/shared/utils/determinism";
import { createLogger } from "@/shared/utils/logger";

const logger = createLogger("MarketManager");

type RecentTrade = {
  price: bigint;
  quantity: bigint;
  timestamp: number;
  side: "buy" | "sell";
};

type LivePairContext = {
  normalizedSymbol: string;
  tradingPairId: string;
  baseDecimals: number;
  quoteDecimals: number;
};

const SUPPORTED_INTERVALS = new Set<Interval>(["1m", "5m", "15m", "1h", "4h", "1d"]);

function normalizeTradingPairsResponse(
  response: unknown,
): MonacoTradingPair[] | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const body = response as {
    trading_pairs?: unknown;
    data?: unknown;
  };

  if (Array.isArray(body.trading_pairs)) {
    return body.trading_pairs as MonacoTradingPair[];
  }

  if (Array.isArray(body.data)) {
    return body.data as MonacoTradingPair[];
  }

  if (!body.data || typeof body.data !== "object") {
    return undefined;
  }

  const nested = body.data as {
    trading_pairs?: unknown;
    data?: unknown;
  };

  if (Array.isArray(nested.trading_pairs)) {
    return nested.trading_pairs as MonacoTradingPair[];
  }

  if (Array.isArray(nested.data)) {
    return nested.data as MonacoTradingPair[];
  }

  return undefined;
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
    total_pages?: unknown;
    total?: unknown;
    data?: unknown;
  };

  const totalFromBody = parseNumber(body.total_pages ?? body.total);
  if (totalFromBody !== undefined) {
    return totalFromBody;
  }

  if (!body.data || typeof body.data !== "object") {
    return undefined;
  }

  const nested = body.data as {
    total_pages?: unknown;
    total?: unknown;
  };

  return parseNumber(nested.total_pages ?? nested.total);
}

function normalizeRequestedMarketType(
  marketMode: LiveTradingMarketMode | string | undefined,
): "SPOT" | "MARGIN" {
  if (marketMode === undefined || marketMode === "spot") {
    return "SPOT";
  }

  if (marketMode === "isolated_perps") {
    return "MARGIN";
  }

  throw new Error(`Unsupported live market mode: ${marketMode}`);
}

function filterTradingPairsByMarketType(
  tradingPairs: MonacoTradingPair[],
  marketType: "SPOT" | "MARGIN",
): MonacoTradingPair[] {
  return tradingPairs.filter(
    (pair) => pair.market_type?.toUpperCase() === marketType,
  );
}

export class MarketManager {
  private mockPrices: Map<string, bigint> = new Map();
  private mockOrderBooks: Map<string, InternalOrderBook> = new Map();
  private mockTrades: Map<string, InternalTrade[]> = new Map();
  private priceHistory: Map<string, OHLCV[]> = new Map();
  private liveOrderBooks = new Map<string, MonacoOrderbookEvent>();
  private liveCandles = new Map<string, MonacoCandlestick>();
  private liveRecentTrades = new Map<string, RecentTrade[]>();
  private sdk?: Mach1SDK;
  private mode: MarketDataMode;
  private ohlcvInterval: Interval = "1d";
  private readonly rng: Rng;
  private readonly clock: Clock;

  constructor(options?: { mode?: MarketDataMode; rng?: Rng; clock?: Clock }) {
    this.mode = options?.mode ?? "simulation";
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
    this.initializeMockData();
  }

  private initializeMockData(): void {
    const btcUsdc = this.getPairKey(
      "0x1234567890123456789012345678901234567890",
      "0x0987654321098765432109876543210987654321",
    );
    const ethUsdc = this.getPairKey(
      "0x1111111111111111111111111111111111111111",
      "0x0987654321098765432109876543210987654321",
    );

    this.mockPrices.set(btcUsdc, 4500000n);
    this.mockPrices.set(ethUsdc, 300000n);

    this.mockOrderBooks.set(
      btcUsdc,
      this.generateMockOrderBook(btcUsdc, 4500000n),
    );
    this.mockOrderBooks.set(
      ethUsdc,
      this.generateMockOrderBook(ethUsdc, 300000n),
    );

    this.mockTrades.set(
      btcUsdc,
      this.generateMockTrades(btcUsdc, 4500000n),
    );
    this.mockTrades.set(
      ethUsdc,
      this.generateMockTrades(ethUsdc, 300000n),
    );
  }

  setMode(mode: MarketDataMode): void {
    this.mode = mode;
  }

  seedSimulationPair(pair: TradingPair, price: bigint): void {
    if (!this.isSimulationMode()) {
      return;
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    this.mockPrices.set(pairKey, price);
    this.mockOrderBooks.set(
      pairKey,
      this.generateMockOrderBook(pairKey, price),
    );
    this.mockTrades.set(pairKey, this.generateMockTrades(pairKey, price));
  }

  getMode(): MarketDataMode {
    return this.mode;
  }

  setSDK(sdk: Mach1SDK): void {
    this.sdk = sdk;
  }

  setDefaultOHLCVInterval(interval: Interval): void {
    this.ohlcvInterval = interval;
  }

  cacheOrderbook(symbol: string, orderbook: MonacoOrderbookEvent): void {
    this.liveOrderBooks.set(
      tradingPairResolver.normalizeSymbol(symbol),
      orderbook,
    );
  }

  cacheCandlestick(
    symbol: string,
    interval: Interval,
    candlestick: MonacoCandlestick,
  ): void {
    this.liveCandles.set(
      `${tradingPairResolver.normalizeSymbol(symbol)}:${interval}`,
      candlestick,
    );
  }

  cacheTrade(symbol: string, trade: MonacoTradeEvent): void {
    const pairKey = tradingPairResolver.normalizeSymbol(symbol);
    const existing = this.liveRecentTrades.get(pairKey) ?? [];
    const nextTrade = this.normalizeLiveTradeEvent(pairKey, trade);
    this.liveRecentTrades.set(pairKey, [nextTrade, ...existing].slice(0, 100));
  }

  private getPairKey(baseToken: Address, quoteToken: Address): string {
    return `${baseToken}-${quoteToken}`;
  }

  private isSimulationMode(): boolean {
    return this.mode !== "live";
  }

  private isValidAddress(value: string): value is Address {
    return /^0x[a-fA-F0-9]{40}$/.test(value);
  }

  private deriveInitialMockPrice(pair: TradingPair): bigint {
    const symbol = pair.symbol.toUpperCase();
    const baseSymbol = symbol.split("/")[0] || symbol;

    if (baseSymbol.includes("BTC")) return 4_500_000n;
    if (baseSymbol.includes("ETH")) return 300_000n;
    if (baseSymbol.includes("SOL")) return 15_000n;
    if (baseSymbol === "USDC" || baseSymbol === "USDT") return 100n;

    let hash = 0;
    for (const char of baseSymbol) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }

    return BigInt(10_000 + (hash % 490_000));
  }

  private ensureMockDataForPair(pair: TradingPair): bigint | undefined {
    const pairKey = this.getPairKey(pair.base, pair.quote);
    const existingPrice = this.mockPrices.get(pairKey);

    if (existingPrice) {
      return existingPrice;
    }

    if (!this.isValidAddress(pair.base) || !this.isValidAddress(pair.quote)) {
      return undefined;
    }

    const initialPrice = this.deriveInitialMockPrice(pair);
    this.mockPrices.set(pairKey, initialPrice);
    this.mockOrderBooks.set(
      pairKey,
      this.generateMockOrderBook(pairKey, initialPrice),
    );
    this.mockTrades.set(
      pairKey,
      this.generateMockTrades(pairKey, initialPrice),
    );

    return initialPrice;
  }

  private generateMockOrderBook(
    pairKey: string,
    midPrice: bigint,
  ): InternalOrderBook {
    const baseToken = pairKey.split("-")[0] as Address;
    const quoteToken = pairKey.split("-")[1] as Address;

    const bids = [];
    const asks = [];

    for (let i = 1; i <= 10; i++) {
      const bidPrice = midPrice - BigInt(i * 100);
      const askPrice = midPrice + BigInt(i * 100);
      const quantity = BigInt(Math.floor(this.rng.next() * 1000000) + 100000);

      bids.push({ price: bidPrice, quantity });
      asks.push({ price: askPrice, quantity });
    }

    return {
      baseToken,
      quoteToken,
      bids: bids.sort((a, b) => Number(b.price - a.price)),
      asks: asks.sort((a, b) => Number(a.price - b.price)),
      lastUpdate: this.clock.now(),
    };
  }

  private generateMockTrades(
    pairKey: string,
    midPrice: bigint,
  ): InternalTrade[] {
    const baseToken = pairKey.split("-")[0] as Address;
    const quoteToken = pairKey.split("-")[1] as Address;
    const trades = [];

    for (let i = 0; i < 50; i++) {
      const priceVariation = BigInt(Math.floor(this.rng.next() * 2000) - 1000);
      const price = midPrice + priceVariation;
      const quantity = BigInt(Math.floor(this.rng.next() * 100000) + 10000);

      trades.push({
        id: `trade_${i}`,
        baseToken,
        quoteToken,
        price,
        quantity,
        isBuy: this.rng.next() > 0.5,
        maker: "0x1234567890123456789012345678901234567890" as Address,
        taker: "0x0987654321098765432109876543210987654321" as Address,
        timestamp: this.clock.now() - i * 60000,
        blockNumber: 1000000 - i,
        transactionHash: `0xabcdef${i.toString().padStart(58, "0")}`,
      });
    }

    return trades.sort((a, b) => b.timestamp - a.timestamp);
  }

  private getRequiredSDK(): Mach1SDK {
    if (!this.sdk) {
      throw new Error("Monaco SDK unavailable");
    }

    return this.sdk;
  }

  private requireLiveInterval(timeframe: string): Interval {
    if (SUPPORTED_INTERVALS.has(timeframe as Interval)) {
      return timeframe as Interval;
    }

    throw new Error(`Unsupported interval: ${timeframe}`);
  }

  private async resolveLivePairContext(
    pair: TradingPair,
  ): Promise<LivePairContext> {
    const sdk = this.getRequiredSDK();
    const normalizedSymbol = tradingPairResolver.normalizeSymbol(pair.symbol);
    const resolvedPair =
      tradingPairResolver.getPairByContracts(pair.base, pair.quote) ??
      tradingPairResolver.getPairBySymbol(normalizedSymbol) ??
      tradingPairResolver.getPairBySymbol(pair.symbol) ??
      (await sdk.market.getTradingPairBySymbol(normalizedSymbol));

    if (!resolvedPair) {
      throw new Error(`Trading pair metadata unavailable for ${pair.symbol}`);
    }

    return {
      normalizedSymbol,
      tradingPairId: resolvedPair.id,
      baseDecimals: resolvedPair.base_decimals,
      quoteDecimals: resolvedPair.quote_decimals,
    };
  }

  private parseLiveUnits(
    value: string | number | bigint | null | undefined,
    decimals: number,
    label: string,
  ): bigint {
    if (value === null || value === undefined) {
      throw new Error(`Missing ${label}`);
    }

    const normalized =
      typeof value === "string" ? value.trim() : String(value).trim();
    if (normalized.length === 0) {
      throw new Error(`Missing ${label}`);
    }

    return parseUnits(normalized, decimals);
  }

  private toMarketDataUnavailableError(
    pair: TradingPair,
    dataType: "price" | "orderbook" | "ticker" | "candles" | "trades",
    details: Record<string, unknown>,
    error?: unknown,
  ): MarketDataUnavailableError {
    const message =
      error instanceof Error ? error.message : error ? String(error) : undefined;

    return new MarketDataUnavailableError(pair.symbol, dataType, {
      ...details,
      originalError: message,
    });
  }

  private normalizeLiveOrderbook(
    orderbook: MonacoOrderbookEvent,
    baseDecimals: number,
    quoteDecimals: number,
    depth: number,
  ): {
    bids: Array<{ price: bigint; quantity: bigint }>;
    asks: Array<{ price: bigint; quantity: bigint }>;
  } {
    return {
      bids: orderbook.bids.slice(0, depth).map((level) => ({
        price: this.parseLiveUnits(level.price, quoteDecimals, "bid price"),
        quantity: this.parseLiveUnits(
          level.quantity,
          baseDecimals,
          "bid quantity",
        ),
      })),
      asks: orderbook.asks.slice(0, depth).map((level) => ({
        price: this.parseLiveUnits(level.price, quoteDecimals, "ask price"),
        quantity: this.parseLiveUnits(
          level.quantity,
          baseDecimals,
          "ask quantity",
        ),
      })),
    };
  }

  private normalizeLiveTradeEvent(
    pairSymbol: string,
    trade: MonacoTradeEvent,
    decimals?: { baseDecimals: number; quoteDecimals: number },
  ): RecentTrade {
    const pairMetadata =
      tradingPairResolver.getPairById(trade.tradingPairId) ??
      tradingPairResolver.getPairBySymbol(pairSymbol);
    const quoteDecimals =
      decimals?.quoteDecimals ?? pairMetadata?.quote_decimals ?? 6;
    const baseDecimals =
      decimals?.baseDecimals ?? pairMetadata?.base_decimals ?? 18;

    return {
      price: this.parseLiveUnits(
        trade.data.price,
        quoteDecimals,
        "trade price",
      ),
      quantity: this.parseLiveUnits(
        trade.data.quantity,
        baseDecimals,
        "trade quantity",
      ),
      timestamp: Date.parse(trade.data.executedAt),
      side: trade.data.makerSide === "BUY" ? "buy" : "sell",
    };
  }

  async getCurrentPrice(pair: TradingPair): Promise<bigint> {
    if (!this.isSimulationMode()) {
      try {
        const sdk = this.getRequiredSDK();
        const livePair = await this.resolveLivePairContext(pair);
        const now = this.clock.now();
        const candles = await sdk.market.getCandlesticks(
          livePair.tradingPairId,
          this.ohlcvInterval,
          { endTime: now, limit: 1 },
        );
        const latest =
          Array.isArray(candles) && candles.length > 0
            ? candles[candles.length - 1]
            : undefined;

        if (!latest?.c) {
          throw new Error("No candlestick close returned");
        }

        return this.parseLiveUnits(
          latest.c,
          livePair.quoteDecimals,
          "candlestick close",
        );
      } catch (error) {
        throw this.toMarketDataUnavailableError(
          pair,
          "price",
          {
            interval: this.ohlcvInterval,
            mode: this.mode,
          },
          error,
        );
      }
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    const price = this.ensureMockDataForPair(pair);

    if (!price) {
      throw new Error(`No price data for pair ${pair.symbol}`);
    }

    const volatility = BigInt(Math.floor(this.rng.next() * 1000) - 500);
    const currentPrice = price + volatility;
    this.mockPrices.set(pairKey, currentPrice);

    return currentPrice;
  }

  async getBestPrices(pair: TradingPair): Promise<BestPrices> {
    const orderBook = await this.getOrderBook(pair);

    const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : null;
    const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : null;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

    return {
      baseToken: pair.base,
      quoteToken: pair.quote,
      bestBid,
      bestAsk,
      spread,
    };
  }

  async getOrderBook(
    pair: TradingPair,
    depth = 10,
  ): Promise<{
    bids: Array<{ price: bigint; quantity: bigint }>;
    asks: Array<{ price: bigint; quantity: bigint }>;
  }> {
    if (!this.isSimulationMode()) {
      try {
        const sdk = this.getRequiredSDK();
        const livePair = await this.resolveLivePairContext(pair);
        const cached = this.liveOrderBooks.get(livePair.normalizedSymbol);
        const orderbook =
          cached ??
          (await sdk.orderbook?.getOrderbook?.(livePair.tradingPairId, {
            depth,
            tradingMode: "SPOT",
          }));

        if (!orderbook) {
          throw new Error("Orderbook endpoint unavailable");
        }

        if (orderbook.bids.length === 0 && orderbook.asks.length === 0) {
          throw new Error("Orderbook empty");
        }

        return this.normalizeLiveOrderbook(
          orderbook,
          livePair.baseDecimals,
          livePair.quoteDecimals,
          depth,
        );
      } catch (error) {
        throw this.toMarketDataUnavailableError(
          pair,
          "orderbook",
          { depth, mode: this.mode },
          error,
        );
      }
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    let orderBook = this.mockOrderBooks.get(pairKey);

    if (!orderBook) {
      const currentPrice = await this.getCurrentPrice(pair);
      orderBook = this.generateMockOrderBook(pairKey, currentPrice);
      this.mockOrderBooks.set(pairKey, orderBook);
    }

    orderBook.bids.forEach((bid: { price: bigint; quantity: bigint }) => {
      bid.quantity = BigInt(Math.floor(this.rng.next() * 1000000) + 100000);
    });
    orderBook.asks.forEach((ask: { price: bigint; quantity: bigint }) => {
      ask.quantity = BigInt(Math.floor(this.rng.next() * 1000000) + 100000);
    });
    orderBook.lastUpdate = this.clock.now();

    return {
      bids: orderBook.bids.slice(0, depth),
      asks: orderBook.asks.slice(0, depth),
    };
  }

  async getTicker(pair: TradingPair): Promise<{
    price: bigint;
    volume24h: bigint;
    change24h: number;
    high24h: bigint;
    low24h: bigint;
  }> {
    if (!this.isSimulationMode()) {
      try {
        const sdk = this.getRequiredSDK();
        const livePair = await this.resolveLivePairContext(pair);
        const metadata = await sdk.market.getMarketMetadata(
          livePair.tradingPairId,
        );

        return {
          price: this.parseLiveUnits(
            metadata.last_price,
            livePair.quoteDecimals,
            "ticker last price",
          ),
          volume24h: this.parseLiveUnits(
            metadata.volume_24h ?? "0",
            livePair.baseDecimals,
            "ticker 24h volume",
          ),
          change24h: Number(metadata.price_change_percent_24h ?? "0") / 100,
          high24h: this.parseLiveUnits(
            metadata.high_24h,
            livePair.quoteDecimals,
            "ticker 24h high",
          ),
          low24h: this.parseLiveUnits(
            metadata.low_24h,
            livePair.quoteDecimals,
            "ticker 24h low",
          ),
        };
      } catch (error) {
        throw this.toMarketDataUnavailableError(
          pair,
          "ticker",
          { mode: this.mode },
          error,
        );
      }
    }

    const currentPrice = await this.getCurrentPrice(pair);
    const yesterdayPrice =
      currentPrice - BigInt(Math.floor(this.rng.next() * 10000) - 5000);
    const change24h =
      Number(currentPrice - yesterdayPrice) / Number(yesterdayPrice);

    return {
      price: currentPrice,
      volume24h: BigInt(Math.floor(this.rng.next() * 10000000) + 1000000),
      change24h,
      high24h: currentPrice + BigInt(Math.floor(this.rng.next() * 5000)),
      low24h: currentPrice - BigInt(Math.floor(this.rng.next() * 5000)),
    };
  }

  async getCandles(
    pair: TradingPair,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<OHLCV[]> {
    if (!this.isSimulationMode()) {
      try {
        const sdk = this.getRequiredSDK();
        const interval = this.requireLiveInterval(timeframe);
        const livePair = await this.resolveLivePairContext(pair);
        const limit = Math.min(
          500,
          Math.max(
            1,
            Math.ceil((end.getTime() - start.getTime()) / this.getIntervalMs(interval)) +
            1,
          ),
        );
        const candles = await sdk.market.getCandlesticks(
          livePair.tradingPairId,
          interval,
          {
            startTime: start.getTime(),
            endTime: end.getTime(),
            limit,
          },
        );

        if (!Array.isArray(candles) || candles.length === 0) {
          throw new Error("No candles returned");
        }

        return candles.map((candle) => ({
          timestamp: candle.T,
          open: Number(candle.o),
          high: Number(candle.h),
          low: Number(candle.l),
          close: Number(candle.c),
          volume: Number(candle.v),
        }));
      } catch (error) {
        throw this.toMarketDataUnavailableError(
          pair,
          "candles",
          {
            timeframe,
            start: start.toISOString(),
            end: end.toISOString(),
            mode: this.mode,
          },
          error,
        );
      }
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    let candles = this.priceHistory.get(pairKey);

    if (!candles) {
      candles = this.generateMockCandles(pair, timeframe, start, end);
      this.priceHistory.set(pairKey, candles);
    }

    return candles.filter(
      (candle) =>
        candle.timestamp >= start.getTime() &&
        candle.timestamp <= end.getTime(),
    );
  }

  private generateMockCandles(
    pair: TradingPair,
    timeframe: string,
    start: Date,
    end: Date,
  ): OHLCV[] {
    const candles: OHLCV[] = [];
    const intervalMs = this.getIntervalMs(timeframe);
    const currentPrice =
      Number(
        this.mockPrices.get(this.getPairKey(pair.base, pair.quote)) || 0n,
      ) / 100;

    let timestamp = start.getTime();
    let price = currentPrice;

    while (timestamp <= end.getTime()) {
      const volatility = (this.rng.next() - 0.5) * 0.02;
      const open = price;
      const high = open * (1 + Math.abs(volatility) + this.rng.next() * 0.01);
      const low = open * (1 - Math.abs(volatility) - this.rng.next() * 0.01);
      const close = open * (1 + volatility);
      const volume = this.rng.next() * 1000000 + 100000;

      candles.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume,
      });

      price = close;
      timestamp += intervalMs;
    }

    return candles;
  }

  private getIntervalMs(timeframe: string): number {
    const intervals: Record<string, number> = {
      "1m": 60 * 1000,
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "4h": 4 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };
    return intervals[timeframe] || intervals["1h"];
  }

  async getRecentTrades(
    pair: TradingPair,
    limit = 50,
  ): Promise<RecentTrade[]> {
    if (!this.isSimulationMode()) {
      try {
        const sdk = this.getRequiredSDK();
        const livePair = await this.resolveLivePairContext(pair);
        const cached = this.liveRecentTrades.get(livePair.normalizedSymbol);
        const recentTrades =
          cached && cached.length > 0
            ? cached
            : sdk.trades?.getTrades
              ? (await sdk.trades.getTrades(livePair.tradingPairId, {
                page: 1,
                page_size: limit,
              })).map((trade) =>
                this.normalizeLiveTradeEvent(livePair.normalizedSymbol, trade, {
                  baseDecimals: livePair.baseDecimals,
                  quoteDecimals: livePair.quoteDecimals,
                }),
              )
              : undefined;

        if (!recentTrades) {
          throw new Error("Trades endpoint unavailable");
        }

        if (recentTrades.length === 0) {
          throw new Error("No recent trades returned");
        }

        return recentTrades.slice(0, limit);
      } catch (error) {
        throw this.toMarketDataUnavailableError(
          pair,
          "trades",
          { limit, mode: this.mode },
          error,
        );
      }
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    let trades = this.mockTrades.get(pairKey);

    if (!trades) {
      const currentPrice = await this.getCurrentPrice(pair);
      trades = this.generateMockTrades(pairKey, currentPrice);
      this.mockTrades.set(pairKey, trades);
    }

    return trades.slice(0, limit).map((trade) => ({
      price: trade.price,
      quantity: trade.quantity,
      timestamp: trade.timestamp,
      side: trade.isBuy ? "buy" : "sell",
    }));
  }

  async getMarketStats(pair: TradingPair): Promise<{
    spread: bigint;
    depth: bigint;
    volume: bigint;
    volatility: number;
  }> {
    const orderBook = await this.getOrderBook(pair);
    const ticker = await this.getTicker(pair);

    const bestBid = orderBook.bids[0]?.price || 0n;
    const bestAsk = orderBook.asks[0]?.price || 0n;
    const spread = bestAsk > bestBid ? bestAsk - bestBid : 0n;

    const bidDepth = orderBook.bids.reduce(
      (sum, bid) => sum + bid.quantity,
      0n,
    );
    const askDepth = orderBook.asks.reduce(
      (sum, ask) => sum + ask.quantity,
      0n,
    );
    const depth = bidDepth + askDepth;

    const volatility = Math.abs(ticker.change24h);

    return {
      spread,
      depth,
      volume: ticker.volume24h,
      volatility,
    };
  }

  async getAllTradingPairs(options?: {
    marketMode?: LiveTradingMarketMode | string;
  }): Promise<MonacoTradingPair[]> {
    const requestedMarketType = normalizeRequestedMarketType(
      options?.marketMode,
    );

    if (this.sdk) {
      const pairs: MonacoTradingPair[] = [];
      let page = 1;
      let totalPages = 1;

      do {
        const response = await this.sdk.market.getPaginatedTradingPairs({
          page,
          page_size: 100,
          is_active: true,
        });

        const tradingPairs = normalizeTradingPairsResponse(response);
        const fetchedTotalPages = getTradingPairsTotalPages(response);

        if (!tradingPairs || fetchedTotalPages === undefined) {
          throw new Error("Failed to fetch trading pairs from Monaco SDK");
        }

        pairs.push(
          ...filterTradingPairsByMarketType(tradingPairs, requestedMarketType),
        );
        totalPages = fetchedTotalPages;
        page++;
      } while (page <= totalPages);

      return pairs;
    }

    return filterTradingPairsByMarketType(
      [
        {
          id: "BTC_USDC",
          base_token: "BTC",
          quote_token: "USDC",
          base_asset_id: "btc-asset",
          quote_asset_id: "usdc-asset",
          base_icon_url: "",
          quote_icon_url: "",
          base_token_contract: "0x1234567890123456789012345678901234567890",
          quote_token_contract: "0x0987654321098765432109876543210987654321",
          symbol: "BTC/USDC",
          base_decimals: 8,
          quote_decimals: 6,
          market_type: "SPOT",
          is_active: true,
          maker_fee_bps: 10,
          taker_fee_bps: 20,
          min_order_size: "0.0001",
          max_order_size: "1000",
          tick_size: "0.01",
        },
        {
          id: "ETH_USDC",
          base_token: "ETH",
          quote_token: "USDC",
          base_asset_id: "eth-asset",
          quote_asset_id: "usdc-asset",
          base_icon_url: "",
          quote_icon_url: "",
          base_token_contract: "0x1111111111111111111111111111111111111111",
          quote_token_contract: "0x0987654321098765432109876543210987654321",
          symbol: "ETH/USDC",
          base_decimals: 18,
          quote_decimals: 6,
          market_type: "SPOT",
          is_active: true,
          maker_fee_bps: 10,
          taker_fee_bps: 20,
          min_order_size: "0.001",
          max_order_size: "10000",
          tick_size: "0.01",
        },
      ],
      requestedMarketType,
    );
  }

  async getTradeHistory(
    pair: TradingPair,
    limit = 100,
  ): Promise<InternalTrade[]> {
    if (!this.isSimulationMode()) {
      const recentTrades = await this.getRecentTrades(pair, limit);
      return recentTrades.map((trade, index) => ({
        id: `live_trade_${trade.timestamp}_${index}`,
        baseToken: pair.base,
        quoteToken: pair.quote,
        price: trade.price,
        quantity: trade.quantity,
        isBuy: trade.side === "buy",
        maker: "0x0000000000000000000000000000000000000000" as Address,
        taker: "0x0000000000000000000000000000000000000000" as Address,
        timestamp: trade.timestamp,
        blockNumber: 0,
        transactionHash:
          `0x${String(index).padStart(64, "0")}` as `0x${string}`,
      }));
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    const trades = this.mockTrades.get(pairKey) || [];
    return trades.slice(0, limit);
  }

  simulatePriceMovement(): void {
    for (const [pairKey, currentPrice] of this.mockPrices.entries()) {
      const volatility = BigInt(Math.floor(this.rng.next() * 2000) - 1000);
      const newPrice = currentPrice + volatility;
      this.mockPrices.set(pairKey, newPrice > 0n ? newPrice : currentPrice);

      this.mockOrderBooks.set(
        pairKey,
        this.generateMockOrderBook(pairKey, newPrice),
      );
    }
  }
}
