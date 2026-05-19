import type {
  Interval,
  Mach1SDK,
  TradingPair as MonacoTradingPair,
} from "mach1_sdk";
import { tradingPairResolver } from "mach1_sdk";
import { Address, OHLCV, TradingPair } from "@/shared/types/common";
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

export class MarketManager {
  private mockPrices: Map<string, bigint> = new Map();
  private mockOrderBooks: Map<string, InternalOrderBook> = new Map();
  private mockTrades: Map<string, InternalTrade[]> = new Map();
  private priceHistory: Map<string, OHLCV[]> = new Map();
  private sdk?: Mach1SDK;
  private ohlcvInterval: Interval = "1d";
  private readonly rng: Rng;
  private readonly clock: Clock;

  constructor(options?: { rng?: Rng; clock?: Clock }) {
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

    this.mockPrices.set(btcUsdc, BigInt(4500000)); // $45,000 with 2 decimals
    this.mockPrices.set(ethUsdc, BigInt(300000)); // $3,000 with 2 decimals

    this.mockOrderBooks.set(
      btcUsdc,
      this.generateMockOrderBook(btcUsdc, BigInt(4500000)),
    );
    this.mockOrderBooks.set(
      ethUsdc,
      this.generateMockOrderBook(ethUsdc, BigInt(300000)),
    );

    this.mockTrades.set(
      btcUsdc,
      this.generateMockTrades(btcUsdc, BigInt(4500000)),
    );
    this.mockTrades.set(
      ethUsdc,
      this.generateMockTrades(ethUsdc, BigInt(300000)),
    );
  }

  /**
   * Attach a Monaco SDK instance so live data can be fetched.
   */
  setSDK(sdk: Mach1SDK): void {
    this.sdk = sdk;
  }

  /**
   * Set the default OHLCV interval to use when fetching live prices.
   */
  setDefaultOHLCVInterval(interval: Interval): void {
    this.ohlcvInterval = interval;
  }

  private getPairKey(baseToken: Address, quoteToken: Address): string {
    return `${baseToken}-${quoteToken}`;
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

  async getCurrentPrice(pair: TradingPair): Promise<bigint> {
    // Prefer live candlestick data when SDK is available
    if (this.sdk) {
      try {
        const normalizedSymbol = tradingPairResolver.normalizeSymbol(
          pair.symbol,
        );
        const pairByContracts = tradingPairResolver.getPairByContracts(
          pair.base,
          pair.quote,
        );
        const tradingPairId =
          pairByContracts?.id ??
          tradingPairResolver.resolveSymbolToId(normalizedSymbol);
        const now = this.clock.now();
        const candles = await this.sdk.market.getCandlesticks(
          tradingPairId,
          this.ohlcvInterval,
          { endTime: now, limit: 1 },
        );

        const latest =
          Array.isArray(candles) && candles.length > 0
            ? candles[candles.length - 1]
            : undefined;

        const close = latest?.c;
        const numericClose = close !== undefined ? Number(close) : undefined;

        if (numericClose !== undefined && Number.isFinite(numericClose)) {
          return BigInt(Math.round(numericClose));
        }
      } catch (error) {
        logger.warn(
          `Falling back to mock price for ${pair.symbol}`,
          {},
          error as Error,
        );
      }
    }

    const pairKey = this.getPairKey(pair.base, pair.quote);
    const price = this.mockPrices.get(pairKey);

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
  ): Promise<
    Array<{
      price: bigint;
      quantity: bigint;
      timestamp: number;
      side: "buy" | "sell";
    }>
  > {
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
      side: trade.isBuy ? ("buy" as const) : ("sell" as const),
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

  async getAllTradingPairs(): Promise<MonacoTradingPair[]> {
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

        pairs.push(...tradingPairs);
        totalPages = fetchedTotalPages;
        page++;
      } while (page <= totalPages);

      return pairs;
    }

    return [
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
    ];
  }

  async getTradeHistory(
    pair: TradingPair,
    limit = 100,
  ): Promise<InternalTrade[]> {
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
