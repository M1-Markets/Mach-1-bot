import { MarketManager } from "@/domains/trading/market-manager";
import { Address, TradingPair } from "@/shared/types";

describe("MarketManager", () => {
  let marketManager: MarketManager;
  let testPair: TradingPair;

  beforeEach(() => {
    marketManager = new MarketManager();
    // Use the same addresses that are initialized in MarketManager's mock data
    testPair = {
      base: "0x1234567890123456789012345678901234567890",
      quote: "0x0987654321098765432109876543210987654321",
      symbol: "BTC/USDC",
    };
  });

  describe("constructor", () => {
    it("should initialize market manager", () => {
      expect(marketManager).toBeDefined();
      expect(marketManager).toBeInstanceOf(MarketManager);
    });
  });

  describe("getOrderBook", () => {
    it("should return order book for trading pair", async () => {
      const depth = 10;

      const orderBook = await marketManager.getOrderBook(testPair, depth);

      expect(orderBook).toBeDefined();
      expect(Array.isArray(orderBook.bids)).toBe(true);
      expect(Array.isArray(orderBook.asks)).toBe(true);
      expect(orderBook.bids.length).toBeLessThanOrEqual(depth);
      expect(orderBook.asks.length).toBeLessThanOrEqual(depth);

      // Verify bid/ask structure
      orderBook.bids.forEach((bid) => {
        expect(typeof bid.price).toBe("bigint");
        expect(typeof bid.quantity).toBe("bigint");
        expect(bid.price).toBeGreaterThan(0n);
        expect(bid.quantity).toBeGreaterThan(0n);
      });

      orderBook.asks.forEach((ask) => {
        expect(typeof ask.price).toBe("bigint");
        expect(typeof ask.quantity).toBe("bigint");
        expect(ask.price).toBeGreaterThan(0n);
        expect(ask.quantity).toBeGreaterThan(0n);
      });
    });

    it("should handle different depth values", async () => {
      const orderBook5 = await marketManager.getOrderBook(testPair, 5);
      const orderBook20 = await marketManager.getOrderBook(testPair, 20);

      expect(orderBook5.bids.length).toBeLessThanOrEqual(5);
      expect(orderBook5.asks.length).toBeLessThanOrEqual(5);
      expect(orderBook20.bids.length).toBeLessThanOrEqual(20);
      expect(orderBook20.asks.length).toBeLessThanOrEqual(20);
    });
  });

  describe("getBestPrices", () => {
    it("should return best bid and ask prices", async () => {
      const bestPrices = await marketManager.getBestPrices(testPair);

      expect(bestPrices).toBeDefined();
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
  });

  describe("getMarketStats", () => {
    it("should return market statistics", async () => {
      const stats = await marketManager.getMarketStats(testPair);

      expect(stats).toBeDefined();
      expect(typeof stats.spread).toBe("bigint");
      expect(typeof stats.depth).toBe("bigint");
      expect(typeof stats.volume).toBe("bigint");
      expect(typeof stats.volatility).toBe("number");
    });
  });

  describe("getRecentTrades", () => {
    it("should return recent trade history", async () => {
      const limit = 50;

      const trades = await marketManager.getRecentTrades(testPair, limit);

      expect(Array.isArray(trades)).toBe(true);
      expect(trades.length).toBeLessThanOrEqual(limit);

      trades.forEach((trade) => {
        expect(typeof trade.price).toBe("bigint");
        expect(typeof trade.quantity).toBe("bigint");
        expect(typeof trade.timestamp).toBe("number");
        expect(["buy", "sell"]).toContain(trade.side);
      });
    });
  });

  describe("getTicker", () => {
    it("should return market ticker data", async () => {
      const ticker = await marketManager.getTicker(testPair);

      expect(ticker).toBeDefined();
      expect(typeof ticker.price).toBe("bigint");
      expect(typeof ticker.volume24h).toBe("bigint");
      expect(typeof ticker.change24h).toBe("number");
      expect(typeof ticker.high24h).toBe("bigint");
      expect(typeof ticker.low24h).toBe("bigint");
    });
  });

  describe("getCandles", () => {
    it("should return historical price candles", async () => {
      const start = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const end = new Date();
      const timeframe = "1h";

      const candles = await marketManager.getCandles(
        testPair,
        timeframe,
        start,
        end,
      );

      expect(Array.isArray(candles)).toBe(true);
      candles.forEach((candle) => {
        expect(typeof candle.timestamp).toBe("number");
        expect(typeof candle.open).toBe("number");
        expect(typeof candle.high).toBe("number");
        expect(typeof candle.low).toBe("number");
        expect(typeof candle.close).toBe("number");
        expect(typeof candle.volume).toBe("number");
      });
    });
  });

  describe("getTradeHistory", () => {
    it("should return trade history", async () => {
      const limit = 50;

      const trades = await marketManager.getTradeHistory(testPair, limit);

      expect(Array.isArray(trades)).toBe(true);
      expect(trades.length).toBeLessThanOrEqual(limit);

      trades.forEach((trade) => {
        expect(typeof trade.price).toBe("bigint");
        expect(typeof trade.quantity).toBe("bigint");
        expect(typeof trade.timestamp).toBe("number");
        expect(typeof trade.isBuy).toBe("boolean");
        expect(trade.baseToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(trade.quoteToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
      });
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

      // Should throw an error for invalid trading pair not in mock data
      await expect(marketManager.getOrderBook(invalidPair)).rejects.toThrow(
        "No price data for pair INVALID/USDC",
      );
    });

    it("should handle network connectivity issues", async () => {
      // Test would mock network failure scenarios
      // For now, we just ensure the method exists and returns something
      const result = await marketManager.getOrderBook(testPair);
      expect(result).toBeDefined();
    });
  });
});
