import { MarketManager } from "@/domains/trading/market-manager";
import { MarketDataUnavailableError } from "@/shared/errors";
import { Address, TradingPair } from "@/shared/types";
import { vi } from "vitest";

describe("MarketManager", () => {
  let marketManager: MarketManager;
  let testPair: TradingPair;

  const livePairMetadata = {
    id: "pair-btc-usdc",
    symbol: "BTC/USDC",
    base_token: "BTC",
    quote_token: "USDC",
    base_asset_id: "btc-asset",
    quote_asset_id: "usdc-asset",
    base_icon_url: "",
    quote_icon_url: "",
    base_token_contract: "0x3333333333333333333333333333333333333333",
    quote_token_contract: "0x0987654321098765432109876543210987654321",
    base_decimals: 8,
    quote_decimals: 6,
    market_type: "SPOT",
    is_active: true,
    maker_fee_bps: 10,
    taker_fee_bps: 20,
    min_order_size: "0.0001",
    max_order_size: "1000",
    tick_size: "0.01",
  };

  const liveMarginPairMetadata = {
    ...livePairMetadata,
    id: "pair-btc-usdc-margin",
    market_type: "MARGIN",
  };

  const livePair: TradingPair = {
    base: livePairMetadata.base_token_contract as Address,
    quote: livePairMetadata.quote_token_contract as Address,
    symbol: livePairMetadata.symbol,
  };

  beforeEach(() => {
    marketManager = new MarketManager({ mode: "simulation" });
    testPair = {
      base: "0x1234567890123456789012345678901234567890",
      quote: "0x0987654321098765432109876543210987654321",
      symbol: "BTC/USDC",
    };
  });

  const createLiveSdk = (overrides?: Record<string, unknown>) =>
    ({
      market: {
        getTradingPairBySymbol: vi.fn().mockResolvedValue(livePairMetadata),
        getCandlesticks: vi.fn().mockResolvedValue([
          {
            T: 1710000000000,
            t: 1710003600000,
            o: "64000",
            h: "65000",
            l: "63000",
            c: "64500",
            v: "12.5",
            s: "BTC/USDC",
            i: "1d",
            n: 42,
          },
        ]),
        getMarketMetadata: vi.fn().mockResolvedValue({
          symbol: "BTC/USDC",
          base_icon_url: "",
          quote_icon_url: "",
          last_price: "64500",
          last_price_timestamp: 1710000000000,
          high_24h: "65000",
          low_24h: "63000",
          volume_24h: "12.5",
          price_change_24h: "1200",
          price_change_percent_24h: "1.86",
          market_initialization_timestamp: 1700000000000,
        }),
        getPaginatedTradingPairs: vi.fn().mockResolvedValue({
          data: {
            data: [livePairMetadata],
            total_pages: 1,
          },
        }),
      },
      orderbook: {
        getOrderbook: vi.fn().mockResolvedValue({
          bids: [{ price: "64400", quantity: "1.25", orderCount: 2 }],
          asks: [{ price: "64600", quantity: "1.5", orderCount: 3 }],
          baseDecimals: 8,
          quoteDecimals: 6,
          tradingPairId: livePairMetadata.id,
          tradingMode: "SPOT",
          timestamp: new Date().toISOString(),
          sequence: 1,
        }),
      },
      trades: {
        getTrades: vi.fn().mockResolvedValue([
          {
            eventType: "trade",
            tradingPairId: livePairMetadata.id,
            tradingMode: "SPOT",
            data: {
              tradeId: "trade-1",
              price: "64550",
              quantity: "0.25",
              makerSide: "BUY",
              executedAt: "2026-05-26T00:00:00.000Z",
            },
          },
        ]),
      },
      ...overrides,
    }) as any;

  describe("constructor", () => {
    it("should initialize market manager", () => {
      expect(marketManager).toBeDefined();
      expect(marketManager).toBeInstanceOf(MarketManager);
    });
  });

  describe("getOrderBook", () => {
    it("should return order book for trading pair in simulation mode", async () => {
      const depth = 10;

      const orderBook = await marketManager.getOrderBook(testPair, depth);

      expect(orderBook).toBeDefined();
      expect(Array.isArray(orderBook.bids)).toBe(true);
      expect(Array.isArray(orderBook.asks)).toBe(true);
      expect(orderBook.bids.length).toBeLessThanOrEqual(depth);
      expect(orderBook.asks.length).toBeLessThanOrEqual(depth);
    });

    it("rejects in live mode when orderbook data missing", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(
        createLiveSdk({
          orderbook: {
            getOrderbook: vi.fn().mockResolvedValue({
              bids: [],
              asks: [],
              baseDecimals: 8,
              quoteDecimals: 6,
              tradingPairId: livePairMetadata.id,
              tradingMode: "SPOT",
              timestamp: new Date().toISOString(),
              sequence: 1,
            }),
          },
        }),
      );

      await expect(liveManager.getOrderBook(livePair)).rejects.toBeInstanceOf(
        MarketDataUnavailableError,
      );
    });

    it("uses live SDK orderbook without touching mock maps", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(createLiveSdk());

      const orderBook = await liveManager.getOrderBook(livePair);

      expect(orderBook).toEqual({
        bids: [{ price: 64400000000n, quantity: 125000000n }],
        asks: [{ price: 64600000000n, quantity: 150000000n }],
      });
      expect(
        (liveManager as any).mockOrderBooks.has(
          `${livePair.base}-${livePair.quote}`,
        ),
      ).toBe(false);
    });
  });

  describe("getBestPrices", () => {
    it("should return best bid and ask prices", async () => {
      const bestPrices = await marketManager.getBestPrices(testPair);

      expect(bestPrices.baseToken).toBe(testPair.base);
      expect(bestPrices.quoteToken).toBe(testPair.quote);
      expect(
        bestPrices.bestBid === null || typeof bestPrices.bestBid === "bigint",
      ).toBe(true);
      expect(
        bestPrices.bestAsk === null || typeof bestPrices.bestAsk === "bigint",
      ).toBe(true);
      expect(
        bestPrices.spread === null || typeof bestPrices.spread === "bigint",
      ).toBe(true);
    });
  });

  describe("getCurrentPrice", () => {
    it("should return current price for trading pair", async () => {
      const price = await marketManager.getCurrentPrice(testPair);

      expect(typeof price).toBe("bigint");
      expect(price).toBeGreaterThan(0n);
    });

    it("throws typed live error when SDK candlestick fetch fails", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(
        createLiveSdk({
          market: {
            getTradingPairBySymbol: vi.fn().mockResolvedValue(livePairMetadata),
            getCandlesticks: vi.fn().mockRejectedValue(new Error("timeout")),
          },
        }),
      );

      await expect(liveManager.getCurrentPrice(livePair)).rejects.toMatchObject(
        {
          name: "MarketDataUnavailableError",
          code: "MARKET_DATA_UNAVAILABLE",
          details: expect.objectContaining({
            interval: "1d",
            originalError: "timeout",
          }),
        },
      );
    });

    it("should synthesize fallback price data in simulation mode", async () => {
      const sdkPair: TradingPair = {
        base: "0x3333333333333333333333333333333333333333" as Address,
        quote: "0x0987654321098765432109876543210987654321" as Address,
        symbol: "AMZN/USDC",
      };

      marketManager.setSDK(
        createLiveSdk({
          market: {
            getTradingPairBySymbol: vi.fn().mockResolvedValue(livePairMetadata),
            getCandlesticks: vi.fn().mockRejectedValue(new Error("timeout")),
          },
        }),
      );

      const price = await marketManager.getCurrentPrice(sdkPair);

      expect(typeof price).toBe("bigint");
      expect(price).toBeGreaterThan(0n);
    });
  });

  describe("getAllTradingPairs", () => {
    it("should return list of available trading pairs", async () => {
      const pairs = await marketManager.getAllTradingPairs();

      expect(Array.isArray(pairs)).toBe(true);
      pairs.forEach((pair) => {
        expect(pair.base_token_contract).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(pair.quote_token_contract).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(typeof pair.symbol).toBe("string");
        expect(typeof pair.is_active).toBe("boolean");
      });
    });

    it("should normalize nested Monaco API responses", async () => {
      marketManager.setSDK(createLiveSdk());

      const pairs = await marketManager.getAllTradingPairs();

      expect(pairs).toEqual([livePairMetadata]);
    });

    it("should select isolated perps pairs when requested", async () => {
      marketManager.setSDK(
        createLiveSdk({
          market: {
            getPaginatedTradingPairs: vi.fn().mockResolvedValue({
              data: {
                data: [livePairMetadata, liveMarginPairMetadata],
                total_pages: 1,
              },
            }),
          },
        }),
      );

      const pairs = await marketManager.getAllTradingPairs({
        marketMode: "isolated_perps",
      });

      expect(pairs).toEqual([liveMarginPairMetadata]);
    });

    it("should reject unsupported market mode requests", async () => {
      await expect(
        marketManager.getAllTradingPairs({
          marketMode: "cross_margin" as never,
        }),
      ).rejects.toThrow("Unsupported live market mode: cross_margin");
    });
  });

  describe("getMarketStats", () => {
    it("should return market statistics", async () => {
      const stats = await marketManager.getMarketStats(testPair);

      expect(typeof stats.spread).toBe("bigint");
      expect(typeof stats.depth).toBe("bigint");
      expect(typeof stats.volume).toBe("bigint");
      expect(typeof stats.volatility).toBe("number");
    });
  });

  describe("getRecentTrades", () => {
    it("should return recent trade history in simulation mode", async () => {
      const trades = await marketManager.getRecentTrades(testPair, 50);

      expect(Array.isArray(trades)).toBe(true);
      expect(trades.length).toBeLessThanOrEqual(50);
      trades.forEach((trade) => {
        expect(typeof trade.price).toBe("bigint");
        expect(typeof trade.quantity).toBe("bigint");
        expect(typeof trade.timestamp).toBe("number");
        expect(["buy", "sell"]).toContain(trade.side);
      });
    });

    it("uses live trades endpoint without touching mock trades", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(createLiveSdk());

      const trades = await liveManager.getRecentTrades(livePair, 10);

      expect(trades).toEqual([
        {
          price: 64550000000n,
          quantity: 25000000n,
          timestamp: Date.parse("2026-05-26T00:00:00.000Z"),
          side: "buy",
        },
      ]);
      expect(
        (liveManager as any).mockTrades.has(`${livePair.base}-${livePair.quote}`),
      ).toBe(false);
    });
  });

  describe("getTicker", () => {
    it("should return market ticker data", async () => {
      const ticker = await marketManager.getTicker(testPair);

      expect(typeof ticker.price).toBe("bigint");
      expect(typeof ticker.volume24h).toBe("bigint");
      expect(typeof ticker.change24h).toBe("number");
      expect(typeof ticker.high24h).toBe("bigint");
      expect(typeof ticker.low24h).toBe("bigint");
    });

    it("uses live market metadata without touching mock state", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(createLiveSdk());

      const ticker = await liveManager.getTicker(livePair);

      expect(ticker.price).toBe(64500000000n);
      expect(ticker.volume24h).toBe(1250000000n);
      expect(ticker.change24h).toBeCloseTo(0.0186);
      expect(ticker.high24h).toBe(65000000000n);
      expect(ticker.low24h).toBe(63000000000n);
      expect(
        (liveManager as any).mockPrices.has(`${livePair.base}-${livePair.quote}`),
      ).toBe(false);
    });
  });

  describe("getCandles", () => {
    it("should return historical price candles in simulation mode", async () => {
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = new Date();
      const candles = await marketManager.getCandles(testPair, "1h", start, end);

      expect(Array.isArray(candles)).toBe(true);
      expect(candles.length).toBeGreaterThan(0);
    });

    it("uses live candlestick endpoint without touching mock candle cache", async () => {
      const liveManager = new MarketManager({ mode: "live" });
      liveManager.setSDK(createLiveSdk());

      const candles = await liveManager.getCandles(
        livePair,
        "1d",
        new Date("2026-05-25T00:00:00.000Z"),
        new Date("2026-05-26T00:00:00.000Z"),
      );

      expect(candles).toEqual([
        {
          timestamp: 1710000000000,
          open: 64000,
          high: 65000,
          low: 63000,
          close: 64500,
          volume: 12.5,
        },
      ]);
      expect(
        (liveManager as any).priceHistory.has(`${livePair.base}-${livePair.quote}`),
      ).toBe(false);
    });
  });

  describe("getTradeHistory", () => {
    it("should return trade history", async () => {
      const trades = await marketManager.getTradeHistory(testPair, 50);

      expect(Array.isArray(trades)).toBe(true);
      expect(trades.length).toBeLessThanOrEqual(50);
    });
  });

  describe("simulatePriceMovement", () => {
    it("should simulate price movement without errors", () => {
      expect(() => {
        marketManager.simulatePriceMovement();
      }).not.toThrow();
    });
  });

  describe("error handling", () => {
    it("should handle invalid trading pair", async () => {
      const invalidPair: TradingPair = {
        base: "invalid_address" as unknown as Address,
        quote: "0x1234567890123456789012345678901234567890",
        symbol: "INVALID/USDC",
      };

      await expect(marketManager.getOrderBook(invalidPair)).rejects.toThrow(
        "No price data for pair INVALID/USDC",
      );
    });
  });
});
