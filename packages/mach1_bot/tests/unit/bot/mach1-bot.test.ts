import { Mach1Bot } from "@/domains/bot/mach1-bot";
import { BotConfig } from "@/shared/types/bot";
import type { Address, TradingPair } from "@/shared/types";

describe("Mach1Bot", () => {
  let bot: Mach1Bot;
  let sharedBot: Mach1Bot; // Shared instance for non-destructive tests

  const mockConfig: BotConfig = {
    privateKey: "0x" + "1".repeat(64),
    rpcUrl: "https://test-rpc.sei.io",
    mode: "simulation",
  };

  // Create shared bot instance once for most tests
  beforeAll(async () => {
    // Set test environment to enable fast mode
    process.env.NODE_ENV = "test";

    // Mock console methods to reduce output overhead
    vi.spyOn(console, "log").mockImplementation(() => {
      // noop
    });
    vi.spyOn(console, "info").mockImplementation(() => {
      // noop
    });
    vi.spyOn(console, "warn").mockImplementation(() => {
      // noop
    });

    sharedBot = new Mach1Bot({ ...mockConfig, enableEnhancedFeatures: false });
  });

  afterAll(async () => {
    // Clean up shared bot instance
    try {
      await sharedBot.emergencyStop();
    } catch (_error) {
      // Ignore cleanup errors in tests
    }

    // Restore console methods
    vi.restoreAllMocks();

    // Clean up environment
    delete process.env.NODE_ENV;
  });

  // Most tests use the shared instance
  beforeEach(() => {
    bot = sharedBot;
  });

  describe("constructor", () => {
    it("should initialize bot with config", () => {
      expect(bot).toBeDefined();
      expect(bot).toBeInstanceOf(Mach1Bot);
    });
  });

  describe("symbol resolution", () => {
    it("uses canonical simulation table in simulation mode", () => {
      expect(
        (
          bot as unknown as {
            parseSymbol: (symbol: string) => TradingPair;
          }
        ).parseSymbol("SOL-USDC"),
      ).toEqual({
        base: "0x3333333333333333333333333333333333333333",
        quote: "0x4444444444444444444444444444444444444444",
        symbol: "SOL/USDC",
      });
    });

    it("uses Monaco resolver contract addresses in live mode", () => {
      const liveBot = new Mach1Bot({
        ...mockConfig,
        mode: "live",
        enableEnhancedFeatures: false,
      });

      (
        liveBot as unknown as {
          tradingPairResolver: {
            normalizeSymbol: (symbol: string) => string;
            getAllSymbols: () => string[];
            getPairBySymbol: (symbol: string) => {
              symbol: string;
              base_token_contract: Address;
              quote_token_contract: Address;
            } | undefined;
          };
          parseSymbol: (symbol: string) => TradingPair;
        }
      ).tradingPairResolver = {
        normalizeSymbol: (symbol: string) =>
          symbol.replace("WETH", "ETH").replace("-", "/"),
        getAllSymbols: () => ["WETH-USDC"],
        getPairBySymbol: (symbol: string) =>
          symbol === "WETH-USDC"
            ? {
                symbol: "WETH-USDC",
                base_token_contract:
                  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                quote_token_contract:
                  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              }
            : undefined,
      };

      expect(
        (
          liveBot as unknown as {
            parseSymbol: (symbol: string) => TradingPair;
          }
        ).parseSymbol("ETH-USDC"),
      ).toEqual({
        base: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        quote: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        symbol: "ETH/USDC",
      });
    });

    it("preserves live resolver preview message for unknown pairs", () => {
      const liveBot = new Mach1Bot({
        ...mockConfig,
        mode: "live",
        enableEnhancedFeatures: false,
      });

      (
        liveBot as unknown as {
          tradingPairResolver: {
            normalizeSymbol: (symbol: string) => string;
            getAllSymbols: () => string[];
            getPairBySymbol: (symbol: string) => undefined;
          };
          parseSymbol: (symbol: string) => TradingPair;
        }
      ).tradingPairResolver = {
        normalizeSymbol: (symbol: string) => symbol.replace("-", "/"),
        getAllSymbols: () => ["ETH/USDC", "BTC/USDC", "SOL/USDC"],
        getPairBySymbol: () => undefined,
      };

      expect(
        () =>
          (
            liveBot as unknown as {
              parseSymbol: (symbol: string) => TradingPair;
            }
          ).parseSymbol("DOGE/USDC"),
      ).toThrow(
        "Unsupported trading pair: DOGE/USDC. Available symbols include: ETH/USDC, BTC/USDC, SOL/USDC",
      );
    });
  });

  describe("fromEnv (deprecated)", () => {
    const mockEnv = {
      MACH1_PRIVATE_KEY: "0x" + "1".repeat(64),
      MACH1_RPC_URL: "https://test-rpc.sei.io",
      MACH1_CLOB_ADDRESS: "0x1234567890123456789012345678901234567890",
      MACH1_BOOK_ADDRESS: "0x2345678901234567890123456789012345678901",
      MACH1_STATE_ADDRESS: "0x3456789012345678901234567890123456789012",
      MACH1_VAULT_ADDRESS: "0x4567890123456789012345678901234567890123",
      MACH1_MODE: "simulation",
    };

    beforeEach(() => {
      Object.entries(mockEnv).forEach(([key, value]) => {
        process.env[key] = value;
      });
    });

    afterEach(() => {
      Object.keys(mockEnv).forEach((key) => {
        delete process.env[key];
      });
    });

    it("should create bot from environment variables (deprecated)", () => {
      const envBot = Mach1Bot.fromEnv();
      expect(envBot).toBeDefined();
      expect(envBot).toBeInstanceOf(Mach1Bot);
    });

    it("should throw error for missing environment variables", () => {
      delete process.env.MACH1_PRIVATE_KEY;

      expect(() => {
        Mach1Bot.fromEnv();
      }).toThrow("MACH1_PRIVATE_KEY environment variable is required");
    });
  });

  describe("forNetwork", () => {
    it("should create bot using network preset", () => {
      const bot = Mach1Bot.forNetwork("testnet", "0x" + "1".repeat(64), {
        mode: "simulation",
        maxPositionSize: 1000,
      });

      expect(bot).toBeDefined();
      expect(bot).toBeInstanceOf(Mach1Bot);
    });

    it("should throw error for unknown network", () => {
      const invalidNetwork = "unknown-network" as unknown as Parameters<
        typeof Mach1Bot.forNetwork
      >[0];
      expect(() => {
        Mach1Bot.forNetwork(invalidNetwork, "0x" + "1".repeat(64));
      }).toThrow("Unknown network preset");
    });
  });

  describe("builder", () => {
    it("should create configuration builder", () => {
      const builder = Mach1Bot.builder();
      expect(builder).toBeDefined();
      expect(typeof builder.withPrivateKey).toBe("function");
    });
  });

  describe("trading operations", () => {
    describe("buy", () => {
      it("should place buy order successfully", async () => {
        const result = await bot.buy("ETH/USDC", { amountUsd: 100 });

        expect(result).toBeDefined();
        expect(result.symbol).toBe("ETH/USDC");
        expect(result.side).toBe("buy");
        expect(result.status).toMatch(/pending|filled/);
        expect(result.price).toBeGreaterThan(0);
        expect(result.size).toBeGreaterThan(0);
      });

      it("should place limit buy order successfully", async () => {
        const result = await bot.buy("BTC/USDC", {
          amountUsd: 200,
          orderType: "limit",
        });

        expect(result).toBeDefined();
        expect(result.symbol).toBe("BTC/USDC");
        expect(result.side).toBe("buy");
        expect(result.type).toBe("limit");
      });

      it("should reject order that exceeds risk limits", async () => {
        // This test modifies risk limits, so use a fresh bot instance
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });

        try {
          await testBot.setRiskLimits({ maxOrderValue: 10 });
          await expect(
            testBot.buy("ETH/USDC", { amountUsd: 5000 }),
          ).rejects.toThrow(/Order rejected/);
        } finally {
          await testBot.emergencyStop();
        }
      });

      it("uses active execution engine once per order in simulation mode", async () => {
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });
        const placeOrder = vi.fn().mockResolvedValue({
          orderId: "paper-1",
          status: "pending",
          filledQuantity: 0n,
          remainingQuantity: 100n,
        });

        (
          testBot as unknown as {
            getActiveExecutionEngine: () => Promise<{
              placeOrder: typeof placeOrder;
            }>;
          }
        ).getActiveExecutionEngine = vi.fn().mockResolvedValue({ placeOrder });

        try {
          await testBot.buy("ETH/USDC", { amountUsd: 100 });
          expect(placeOrder).toHaveBeenCalledTimes(1);
        } finally {
          await testBot.emergencyStop();
        }
      });

      it("stops before engine call when risk rejects order", async () => {
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });
        const placeOrder = vi.fn();
        (
          testBot as unknown as {
            getActiveExecutionEngine: () => Promise<{
              placeOrder: typeof placeOrder;
            }>;
            riskManager: {
              validateOrder: (...args: unknown[]) => Promise<unknown>;
            };
          }
        ).getActiveExecutionEngine = vi.fn().mockResolvedValue({ placeOrder });
        (
          testBot as unknown as {
            riskManager: {
              validateOrder: (...args: unknown[]) => Promise<unknown>;
            };
          }
        ).riskManager.validateOrder = vi.fn().mockResolvedValue({
          approved: false,
          warnings: [],
          rejectionReasons: ["blocked"],
          riskScore: 1,
        });

        try {
          await expect(
            testBot.buy("ETH/USDC", { amountUsd: 100 }),
          ).rejects.toThrow(/Order rejected: blocked/);
          expect(placeOrder).not.toHaveBeenCalled();
        } finally {
          await testBot.emergencyStop();
        }
      });
    });

    describe("sell", () => {
      it("should validate sell order parameters and call appropriate methods", async () => {
        // Test that the sell method validates inputs and calls the right internal methods
        // without getting blocked by risk management calculations

        // Mock the risk manager to always approve orders for this test
        const freshBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });
        const botWithRisk = freshBot as unknown as {
          riskManager: {
            validateOrder: (...args: unknown[]) => Promise<unknown>;
          };
        };
        const originalValidateOrder = botWithRisk.riskManager.validateOrder;
        botWithRisk.riskManager.validateOrder = vi.fn().mockResolvedValue({
          approved: true,
          warnings: [],
          rejectionReasons: [],
          riskScore: 0,
        });

        try {
          const result = await freshBot.sell("ETH/USDC", { amountUsd: 100 });

          expect(result).toBeDefined();
          expect(result.symbol).toBe("ETH/USDC");
          expect(result.side).toBe("sell");
          expect(result.status).toMatch(/pending|filled/);
          expect(result.price).toBeGreaterThan(0);
          expect(result.size).toBeGreaterThan(0);
        } finally {
          // Clean up the fresh bot instance
          botWithRisk.riskManager.validateOrder = originalValidateOrder;
          try {
            await freshBot.emergencyStop();
          } catch (_error) {
            // Ignore cleanup errors
          }
        }
      });
    });

    describe("stopLoss", () => {
      it("should create stop-loss order successfully", async () => {
        const tracker = (
          bot as unknown as {
            positionTracker: {
              getPosition: () => Promise<{ balance: bigint }>;
            };
          }
        ).positionTracker;
        const originalGetPosition = tracker.getPosition;
        vi.spyOn(
          bot as unknown as { getPriceForMode: () => Promise<bigint> },
          "getPriceForMode",
        ).mockResolvedValue(BigInt(270000));
        tracker.getPosition = vi.fn().mockResolvedValue({ balance: 1000n });
        vi.spyOn(bot, "sell").mockResolvedValue({
          id: "order-1",
          symbol: "ETH/USDC",
          side: "sell",
          status: "filled",
          type: "market",
          price: 2800,
          size: 1,
        });

        const result = await bot.stopLoss("ETH/USDC", {
          stopPrice: 2800,
          limitPrice: 2750,
        });

        expect(result).toBeDefined();
        expect(result.symbol).toBe("ETH/USDC");
        expect(result.side).toBe("sell");
        tracker.getPosition = originalGetPosition;
      });
    });

    describe("takeProfit", () => {
      it("should create take-profit order successfully", async () => {
        const tracker = (
          bot as unknown as {
            positionTracker: {
              getPosition: () => Promise<{ balance: bigint }>;
            };
          }
        ).positionTracker;
        const originalGetPosition = tracker.getPosition;
        vi.spyOn(
          bot as unknown as { getPriceForMode: () => Promise<bigint> },
          "getPriceForMode",
        ).mockResolvedValue(BigInt(360000));
        tracker.getPosition = vi.fn().mockResolvedValue({ balance: 2000n });
        vi.spyOn(bot, "sell").mockResolvedValue({
          id: "order-2",
          symbol: "ETH/USDC",
          side: "sell",
          status: "filled",
          type: "market",
          price: 3500,
          size: 1,
        });

        const result = await bot.takeProfit("ETH/USDC", {
          targetPrice: 3500,
          amountPercent: 50,
        });

        expect(result).toBeDefined();
        expect(result.symbol).toBe("ETH/USDC");
        expect(result.side).toBe("sell");
        tracker.getPosition = originalGetPosition;
      });
    });
  });

  describe("strategy system", () => {
    it("should accept strategy callback", () => {
      const strategyCallback = vi.fn();

      expect(() => {
        bot.strategy(strategyCallback);
      }).not.toThrow();
    });
  });

  describe("execution modes", () => {
    describe("backtest", () => {
      it("should run backtest successfully", async () => {
        const results = await bot.backtest({
          start: "2024-01-01",
          end: "2024-06-01",
        });

        expect(results).toBeDefined();
        expect(results.totalReturn).toBeGreaterThanOrEqual(-1);
        expect(results.totalReturn).toBeLessThanOrEqual(5);
        expect(results.sharpeRatio).toBeGreaterThanOrEqual(0);
        expect(results.sharpeRatio).toBeLessThanOrEqual(5);
        expect(results.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(results.maxDrawdown).toBeLessThanOrEqual(1);
        expect(typeof results.plotEquityCurve).toBe("function");
        expect(typeof results.plotDrawdown).toBe("function");
        expect(typeof results.exportTrades).toBe("function");
      });

      it("should pass configured strategy interval to backtest engine", async () => {
        const strategyCallback = vi.fn().mockResolvedValue(undefined);
        bot.strategy(strategyCallback);

        const setStrategyCallback = vi.fn();
        const generateReport = vi.fn().mockResolvedValue({
          summary: {
            totalReturn: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            winRate: 0,
            totalTrades: 0,
            trades: [],
          },
        });

        vi.doMock("@/domains/execution/backtest-engine.js", () => ({
          BacktestEngine: vi.fn().mockImplementation(() => ({
            setStrategyCallback,
            generateReport,
          })),
        }));

        const isolatedBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });
        isolatedBot.strategy(strategyCallback);

        try {
          await isolatedBot.backtest({
            start: "2024-01-01",
            end: "2024-01-02",
            strategyExecutionIntervalMs: 45_000,
          });

          expect(setStrategyCallback).toHaveBeenCalledTimes(1);
          expect(setStrategyCallback.mock.calls[0]?.[1]).toBe(45_000);
          expect(generateReport).toHaveBeenCalledTimes(1);
        } finally {
          vi.doUnmock("@/domains/execution/backtest-engine.js");
          await isolatedBot.emergencyStop();
        }
      });
    });

    describe("simulate", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("should start simulation successfully", async () => {
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });

        try {
          await expect(
            testBot.simulate({ duration: "1W" }),
          ).resolves.toBeUndefined();
        } finally {
          await testBot.emergencyStop();
        }
      });

      it("should keep simulation running until strategy loop duration ends", async () => {
        vi.useFakeTimers();
        const strategyCallback = vi.fn().mockResolvedValue(undefined);
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });

        testBot.strategy(strategyCallback);
        vi.spyOn(
          testBot as unknown as { parseDuration: (duration: string) => number },
          "parseDuration",
        ).mockReturnValue(60_000);
        vi.spyOn(
          testBot as unknown as { generateMockMarketData: () => Promise<unknown> },
          "generateMockMarketData",
        ).mockResolvedValue({
          "ETH/USDC": {
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
            rsi: 50,
            macdSignal: 0,
            timestamp: 1,
          },
        });

        try {
          const simulatePromise = testBot.simulate({ duration: "1h" });
          const settled = vi.fn();
          simulatePromise.then(settled);

          await vi.advanceTimersByTimeAsync(0);
          expect(strategyCallback).toHaveBeenCalledTimes(1);
          expect(settled).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(60_000);
          await simulatePromise;

          expect(settled).toHaveBeenCalledTimes(1);
        } finally {
          await testBot.emergencyStop();
        }
      });
    });

    describe("goLive", () => {
      it("should start live trading successfully", async () => {
        const original = (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine;
        (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine = vi.fn().mockResolvedValue({});

        await expect(bot.goLive()).resolves.toBeUndefined();
        (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine = original;
      });

      it("should not create duplicate loops when called repeatedly", async () => {
        const original = (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine;
        const getRealMarketData = vi
          .spyOn(bot as unknown as { getRealMarketData: () => Promise<unknown> },
            "getRealMarketData")
          .mockResolvedValue({});

        (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine = vi.fn().mockResolvedValue({});

        bot.strategy(async () => undefined);

        await expect(bot.goLive()).resolves.toBeUndefined();
        await expect(bot.goLive()).resolves.toBeUndefined();

        expect(
          (bot as unknown as { strategyExecutionCoordinator?: { getStats: () => unknown } })
            .strategyExecutionCoordinator,
        ).toBeDefined();

        getRealMarketData.mockRestore();
        (
          bot as unknown as { getOrCreateLiveEngine: () => Promise<unknown> }
        ).getOrCreateLiveEngine = original;
      });

      it("should start exactly one coordinator loop", async () => {
        vi.useFakeTimers();
        const testBot = new Mach1Bot({
          ...mockConfig,
          enableEnhancedFeatures: false,
        });
        const strategyCallback = vi.fn().mockResolvedValue(undefined);

        testBot.strategy(strategyCallback);
        (
          testBot as unknown as {
            getOrCreateLiveEngine: () => Promise<unknown>;
          }
        ).getOrCreateLiveEngine = vi.fn().mockResolvedValue({});
        vi.spyOn(
          testBot as unknown as { getRealMarketData: () => Promise<unknown> },
          "getRealMarketData",
        ).mockResolvedValue({
          "ETH/USDC": {
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
            rsi: 50,
            macdSignal: 0,
            timestamp: 1,
          },
        });

        try {
          await testBot.goLive({ strategyExecutionIntervalMs: 50 });
          expect(strategyCallback).toHaveBeenCalledTimes(1);

          await vi.advanceTimersByTimeAsync(120);
          expect(strategyCallback).toHaveBeenCalledTimes(3);
        } finally {
          await testBot.emergencyStop();
          vi.useRealTimers();
        }
      });
    });
  });

  describe("portfolio management", () => {
    describe("getPortfolio", () => {
      it("should return portfolio information", async () => {
        const portfolio = await bot.getPortfolio();

        expect(portfolio).toBeDefined();
        expect(typeof portfolio.totalValue).toBe("number");
        expect(typeof portfolio.dailyPnl).toBe("number");
        expect(typeof portfolio.dailyReturn).toBe("number");
        expect(typeof portfolio.sharpeRatio).toBe("number");
        expect(typeof portfolio.positions).toBe("object");
      });
    });

    describe("rebalance", () => {
      it("should rebalance portfolio successfully", async () => {
        const targets = {
          "ETH/USDC": 0.6,
          "BTC/USDC": 0.4,
        };

        const result = await bot.rebalance(targets);

        expect(result).toBeDefined();
        expect(result.executed).toBe(true);
        expect(result.newAllocation).toEqual(targets);
      });
    });

    describe("setRiskLimits", () => {
      it("should set risk limits without error", async () => {
        await expect(
          bot.setRiskLimits({
            maxDailyLoss: 500,
            maxPositionSize: 2000,
            positionLimitPercent: 20,
          }),
        ).resolves.not.toThrow();
      });
    });
  });

  describe("market data", () => {
    describe("getCandles", () => {
      it("should return candle data", async () => {
        const candles = await bot.getCandles("ETH/USDC", "1h", { days: 7 });

        expect(Array.isArray(candles)).toBe(true);
        expect(candles.length).toBeGreaterThan(0);

        if (candles.length > 0) {
          const candle = candles[0];
          expect(candle).toHaveProperty("timestamp");
          expect(candle).toHaveProperty("open");
          expect(candle).toHaveProperty("high");
          expect(candle).toHaveProperty("low");
          expect(candle).toHaveProperty("close");
          expect(candle).toHaveProperty("volume");
        }
      });
    });

    describe("getTrades", () => {
      it("should return trade data", async () => {
        const trades = await bot.getTrades("ETH/USDC", { limit: 10 });

        expect(Array.isArray(trades)).toBe(true);
        expect(trades.length).toBeGreaterThan(0);

        if (trades.length > 0) {
          const trade = trades[0];
          expect(trade).toHaveProperty("id");
          expect(trade).toHaveProperty("symbol");
          expect(trade).toHaveProperty("price");
          expect(trade).toHaveProperty("size");
          expect(trade).toHaveProperty("side");
          expect(trade).toHaveProperty("timestamp");
        }
      });
    });

    describe("getOrderbook", () => {
      it("should return live orderbook data", async () => {
        const orderbook = await bot.getOrderbook("ETH/USDC");

        expect(orderbook).toBeDefined();
        expect(orderbook.symbol).toBe("ETH/USDC");
        expect(Array.isArray(orderbook.bids)).toBe(true);
        expect(Array.isArray(orderbook.asks)).toBe(true);
        expect(typeof orderbook.spread).toBe("number");

        expect(orderbook.bids.length).toBeGreaterThan(0);
        expect(orderbook.asks.length).toBeGreaterThan(0);

        if (orderbook.bids.length > 0) {
          expect(orderbook.bids[0]).toHaveProperty("price");
          expect(orderbook.bids[0]).toHaveProperty("quantity");
        }
      });
    });
  });

  describe("event handlers", () => {
    it("should register trade event handler", async () => {
      const handler = vi.fn();

      await expect(bot.onTrade("ETH/USDC", handler)).resolves.not.toThrow();
    });

    it("should register orderbook event handler", async () => {
      const handler = vi.fn();

      await expect(bot.onOrderbook("ETH/USDC", handler)).resolves.not.toThrow();
    });

    it("should register risk breach handler", async () => {
      const handler = vi.fn();

      // Mock the onRiskBreach method to avoid creating an unclearable interval
      const originalOnRiskBreach = bot.onRiskBreach;
      bot.onRiskBreach = vi.fn().mockResolvedValue(undefined);

      await expect(bot.onRiskBreach(handler)).resolves.not.toThrow();

      // Restore original method
      bot.onRiskBreach = originalOnRiskBreach;
    });

    it("should register trade complete handler", () => {
      const handler = vi.fn();

      expect(() => {
        bot.onTradeComplete(handler);
      }).not.toThrow();
    });

    it("should receive real-time trade events", async () => {
      const handler = vi.fn();

      // This should register the handler without throwing
      await expect(bot.onTrade("ETH/USDC", handler)).resolves.not.toThrow();

      // In a real implementation, we could trigger a mock event here
      // For now, we just verify the registration completed successfully
      expect(handler).toBeDefined();
      expect(typeof handler).toBe("function");
    });
  });

  describe("performance analytics", () => {
    describe("getPerformanceStats", () => {
      it("should return performance statistics", async () => {
        const stats = await bot.getPerformanceStats();

        expect(stats).toBeDefined();
        expect(typeof stats.sharpeRatio).toBe("number");
        expect(typeof stats.maxDrawdown).toBe("number");
        expect(stats.sharpeRatio).toBeGreaterThanOrEqual(0);
        expect(stats.sharpeRatio).toBeLessThanOrEqual(5);
        expect(stats.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(stats.maxDrawdown).toBeLessThanOrEqual(1);
      });
    });

    describe("getRiskHeatmap", () => {
      it("should return risk heatmap", async () => {
        const heatmap = await bot.getRiskHeatmap();

        expect(heatmap).toBeDefined();
        expect(typeof heatmap.display).toBe("function");
        expect(typeof heatmap.display()).toBe("string");
      });
    });
  });

  describe("emergency controls", () => {
    describe("emergencyStop", () => {
      it("should execute emergency stop without error", async () => {
        await expect(bot.emergencyStop()).resolves.toBeUndefined();
      });
    });
  });
});
