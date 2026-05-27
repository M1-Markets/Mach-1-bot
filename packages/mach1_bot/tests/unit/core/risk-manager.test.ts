import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import {
  type EmittedRiskEventDetails,
  type PerpsRiskContext,
  RiskLimits,
  RiskManager,
} from "@/domains/trading/risk-manager";
import { Address, OrderRequest, Portfolio, Position } from "@/shared/types";

describe("RiskManager", () => {
  let riskManager: RiskManager;
  let mockPositionTracker: PositionTracker;
  let mockMarketManager: MarketManager;
  let mockOrderManager: OrderManager;
  const baseToken =
    "0x1234567890123456789012345678901234567890" as Address;
  const quoteToken =
    "0x0987654321098765432109876543210987654321" as Address;

  const createPerpsContext = (
    overrides: Partial<PerpsRiskContext> = {},
    positionOverrides: Partial<Position> = {},
  ): PerpsRiskContext => ({
    marketMode: "isolated_perps",
    maxConfiguredLeverage: 5,
    liquidationThresholdPercent: 10,
    accountState: {
      equity: 100000n,
      freeCollateral: 80000n,
      maintenanceMargin: 5000n,
      updatedAt: Date.now(),
    },
    getPosition: vi.fn().mockResolvedValue({
      token: baseToken,
      balance: 0n,
      value: 0n,
      unrealizedPnL: 0n,
      ...positionOverrides,
    }),
    funding: {
      status: "unsupported",
      warning: "Funding rate unavailable from Monaco; skipping funding adjustment.",
    },
    ...overrides,
  });

  beforeEach(() => {
    // Create mocks
    mockPositionTracker = {
      getPortfolio: vi.fn(),
      getPosition: vi.fn(),
      getPositionSummary: vi.fn(),
      getOpenOrders: vi.fn(),
    } as unknown as PositionTracker;

    mockMarketManager = {
      getCandles: vi.fn().mockResolvedValue([]),
    } as unknown as MarketManager;

    mockOrderManager = {
      cancelAllOrders: vi.fn(),
      getOrderStats: vi.fn(),
    } as unknown as OrderManager;

    // Setup default mock returns
    const mockPortfolio: Portfolio = {
      positions: new Map(),
      totalValue: BigInt(100000000), // 1000 USDC
      unrealizedPnL: BigInt(0),
    };

    const mockPosition: Position = {
      token: "0x1234567890123456789012345678901234567890" as Address,
      balance: BigInt(100000000), // 1000 tokens
      value: BigInt(300000000), // 3000 USDC
      unrealizedPnL: BigInt(0),
    };

    vi.mocked(mockPositionTracker.getPortfolio).mockResolvedValue(
      mockPortfolio,
    );
    vi.mocked(mockPositionTracker.getPosition).mockResolvedValue(mockPosition);
    vi.mocked(mockPositionTracker.getPositionSummary).mockResolvedValue({
      totalValue: BigInt(100000000),
      dailyPnL: BigInt(0),
      totalPnL: BigInt(0),
      openPositions: 0,
    });
    vi.mocked(mockPositionTracker.getOpenOrders).mockResolvedValue([]);
    vi.mocked(mockOrderManager.getOrderStats).mockReturnValue({
      totalOrders: 0,
      openOrders: 0,
      filledOrders: 0,
      cancelledOrders: 0,
    });

    riskManager = new RiskManager(
      mockPositionTracker,
      mockMarketManager,
      mockOrderManager,
    );
  });

  describe("constructor", () => {
    it("should initialize risk manager with dependencies", () => {
      expect(riskManager).toBeDefined();
      expect(riskManager).toBeInstanceOf(RiskManager);
    });
  });

  describe("setRiskLimits", () => {
    it("should set risk limits", async () => {
      const limits: Partial<RiskLimits> = {
        maxDailyLoss: BigInt(50000000), // 500 USDC
        maxPositionSize: BigInt(200000000), // 2000 USDC
        maxDrawdown: 0.15,
      };

      await expect(riskManager.setRiskLimits(limits)).resolves.not.toThrow();
    });
  });

  describe("getRiskLimits", () => {
    it("should return current risk limits", async () => {
      const limits = await riskManager.getRiskLimits();

      expect(limits).toBeDefined();
      expect(typeof limits.maxPositionSize).toBe("bigint");
      expect(typeof limits.maxDailyLoss).toBe("bigint");
      expect(typeof limits.positionLimitPercent).toBe("number");
      expect(typeof limits.stopLossPercent).toBe("number");
      expect(typeof limits.maxLeverage).toBe("number");
      expect(typeof limits.maxCorrelation).toBe("number");
      expect(typeof limits.maxDrawdown).toBe("number");
      expect(typeof limits.maxOrderValue).toBe("bigint");
    });
  });

  describe("validateOrder", () => {
    it("should validate order correctly", async () => {
      const order: OrderRequest = {
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: BigInt(300000), // 3000 USDC
        quantity: BigInt(10000), // 100 tokens
      };

      const result = await riskManager.validateOrder(order);

      expect(result).toBeDefined();
      expect(result.warnings).toBeInstanceOf(Array);
      expect(result.rejectionReasons).toBeInstanceOf(Array);
      expect(typeof result.riskScore).toBe("number");
      expect(typeof result.approved).toBe("boolean");
    });

    it("should reject oversized order", async () => {
      const order: OrderRequest = {
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: BigInt(300000), // 3000 USDC
        quantity: BigInt(1000000000), // 10M tokens (very large)
      };

      const result = await riskManager.validateOrder(order);

      expect(result).toBeDefined();
      expect(result.approved).toBe(false);
      expect(result.rejectionReasons.length).toBeGreaterThan(0);
    });

    it("rejects zero-balance sell without divide-by-zero", async () => {
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: "0x1234567890123456789012345678901234567890" as Address,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });

      const order: OrderRequest = {
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: false,
        price: 300000n,
        quantity: 10000n,
      };

      await expect(riskManager.checkMaxLoss(order)).resolves.toBe(false);

      const result = await riskManager.validateOrder(order);
      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContain(
        "Order would exceed daily loss limit of 5000000 USDC",
      );
    });

    it("uses deterministic historical correlation result", async () => {
      const candles = Array.from({ length: 24 }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index * 3_600_000,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100 + index * 2,
        volume: 1000,
      }));

      vi.mocked(mockPositionTracker.getPortfolio).mockResolvedValue({
        positions: new Map([
          [
            "0x9999999999999999999999999999999999999999" as Address,
            {
              token: "0x9999999999999999999999999999999999999999" as Address,
              balance: 100n,
              value: 500000n,
              unrealizedPnL: 0n,
            },
          ],
        ]),
        totalValue: 100000000n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: "0x1234567890123456789012345678901234567890" as Address,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockMarketManager.getCandles).mockImplementation(async () => [
        ...candles,
      ]);
      await riskManager.setRiskLimits({ maxCorrelation: 0.5 });

      const result = await riskManager.validateOrder({
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: 10000n,
        quantity: 100n,
      });

      expect(result.warnings[0]).toContain("High correlation risk detected");
    });

    it("warns when correlation history unavailable without random rejection", async () => {
      vi.mocked(mockPositionTracker.getPortfolio).mockResolvedValue({
        positions: new Map([
          [
            "0x9999999999999999999999999999999999999999" as Address,
            {
              token: "0x9999999999999999999999999999999999999999" as Address,
              balance: 100n,
              value: 500000n,
              unrealizedPnL: 0n,
            },
          ],
        ]),
        totalValue: 100000000n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: "0x1234567890123456789012345678901234567890" as Address,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockMarketManager.getCandles).mockResolvedValue(
        Array.from({ length: 5 }, (_, index) => ({
          timestamp: 1_700_000_000_000 + index * 3_600_000,
          open: 100,
          high: 101,
          low: 99,
          close: 100 + index,
          volume: 1000,
        })),
      );

      const result = await riskManager.validateOrder({
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: 10000n,
        quantity: 100n,
      });

      expect(result.approved).toBe(true);
      expect(result.warnings).toContain(
        "Correlation history unavailable; skipping correlation rejection.",
      );
    });

    it("rejects isolated perps leverage above configured max", async () => {
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext({ maxConfiguredLeverage: 4 }),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 10000n,
        quantity: 100n,
        leverage: 5,
      });

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContain(
        "Perps leverage 5 exceeds configured max leverage 3",
      );
    });

    it("rejects isolated perps order when free collateral is insufficient", async () => {
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: baseToken,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext({
          accountState: {
            equity: 100000n,
            freeCollateral: 1000n,
            maintenanceMargin: 5000n,
            updatedAt: Date.now(),
          },
        }),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 25000n,
        quantity: 100n,
        leverage: 5,
      });

      expect(result.approved).toBe(false);
      expect(
        result.rejectionReasons.some((reason) =>
          reason.includes("Required collateral"),
        ),
      ).toBe(true);
    });

    it("keeps spot validation path unchanged when no perps context exists", async () => {
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: baseToken,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      const spotOrder: OrderRequest = {
        baseToken,
        quoteToken,
        isBuy: true,
        price: 10000n,
        quantity: 100n,
      };

      const result = await riskManager.validateOrder(spotOrder);

      expect(result.approved).toBe(true);
      expect(result.rejectionReasons).toHaveLength(0);
    });

    it("warns and skips funding adjustment when Monaco funding data is unsupported", async () => {
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: baseToken,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext({
          funding: {
            status: "unsupported",
            warning:
              "Funding rate unavailable from Monaco; skipping funding adjustment.",
          },
        }),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 10000n,
        quantity: 100n,
        leverage: 2,
      });

      expect(result.approved).toBe(true);
      expect(result.warnings).toContain(
        "Funding rate unavailable from Monaco; skipping funding adjustment.",
      );
    });

    it("emits liquidation warning events before threshold breach", async () => {
      const receivedTypes: string[] = [];
      riskManager.on("riskEvent", (event) => {
        receivedTypes.push(event.type);
      });
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: baseToken,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext(
          {},
          {
            balance: 100n,
            value: 1000000n,
            markPrice: 10000n,
            liquidationPrice: 8500n,
            maintenanceMargin: 2500n,
            collateral: 15000n,
            side: "long",
          },
        ),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 10000n,
        quantity: 25n,
        leverage: 2,
      });

      expect(result.approved).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("Liquidation distance"))).toBe(true);
      expect(receivedTypes).toEqual(
        expect.arrayContaining(["liquidation_warning", "margin_warning"]),
      );
    });

    it("emits critical liquidation events and rejects risk-increasing orders", async () => {
      const receivedTypes: string[] = [];
      riskManager.on("riskEvent", (event) => {
        receivedTypes.push(event.type);
      });
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext(
          {},
          {
            balance: 100n,
            value: 1000000n,
            markPrice: 10000n,
            liquidationPrice: 9500n,
            maintenanceMargin: 2500n,
            collateral: 15000n,
            side: "long",
          },
        ),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 10000n,
        quantity: 25n,
        leverage: 2,
      });

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons.some((reason) => reason.includes("Liquidation distance"))).toBe(true);
      expect(receivedTypes).toContain("liquidation_triggered");
    });

    it("blocks isolated perps approval when mark data is stale", async () => {
      riskManager.setPerpsContextProvider(() =>
        createPerpsContext(
          {
            accountState: {
              equity: 100000n,
              freeCollateral: 80000n,
              maintenanceMargin: 5000n,
              updatedAt: Date.now() - 60_000,
            },
            markDataStaleAfterMs: 1_000,
          },
          {
            balance: 100n,
            value: 1000000n,
            markPrice: 10000n,
            liquidationPrice: 9000n,
            maintenanceMargin: 2500n,
            collateral: 15000n,
            side: "long",
          },
        ),
      );

      const result = await riskManager.validateOrder({
        baseToken,
        quoteToken,
        isBuy: true,
        direction: "long",
        price: 10000n,
        quantity: 25n,
        leverage: 2,
      });

      expect(result.approved).toBe(false);
      expect(result.rejectionReasons).toContain(
        "Perps mark price or maintenance margin data is stale; rejecting order fail-closed",
      );
    });

    it("emits risk events for warning and rejection cases", async () => {
      const received: EmittedRiskEventDetails[] = [];
      riskManager.on("riskEvent", (event) => {
        received.push(event.data as EmittedRiskEventDetails);
      });

      const candles = Array.from({ length: 24 }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index * 3_600_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100 + index,
        volume: 1000,
      }));
      vi.mocked(mockPositionTracker.getPortfolio).mockResolvedValue({
        positions: new Map([
          [
            "0x9999999999999999999999999999999999999999" as Address,
            {
              token: "0x9999999999999999999999999999999999999999" as Address,
              balance: 100n,
              value: 500000n,
              unrealizedPnL: 0n,
            },
          ],
        ]),
        totalValue: 100000000n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockPositionTracker.getPosition).mockResolvedValue({
        token: "0x1234567890123456789012345678901234567890" as Address,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      });
      vi.mocked(mockMarketManager.getCandles).mockImplementation(async () => [
        ...candles,
      ]);
      await riskManager.setRiskLimits({ maxCorrelation: 0.1 });

      await riskManager.validateOrder({
        orderId: "warn-order",
        strategyId: "strategy-1",
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: 10000n,
        quantity: 100n,
      });
      await riskManager.validateOrder({
        orderId: "reject-order",
        strategyId: "strategy-1",
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: 300000n,
        quantity: 1000000000n,
      });

      expect(received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderId: "warn-order",
            strategyId: "strategy-1",
            reason: expect.stringContaining("High correlation risk"),
          }),
          expect.objectContaining({
            orderId: "reject-order",
            strategyId: "strategy-1",
          }),
        ]),
      );
    });
  });

  describe("checkPositionLimit", () => {
    it("should check position limits correctly", async () => {
      const order: OrderRequest = {
        baseToken: "0x1234567890123456789012345678901234567890" as Address,
        quoteToken: "0x0987654321098765432109876543210987654321" as Address,
        isBuy: true,
        price: BigInt(300000), // 3000 USDC
        quantity: BigInt(10000), // 100 tokens
      };

      const result = await riskManager.checkPositionLimit(order);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("calculatePortfolioRisk", () => {
    it("should calculate portfolio risk metrics", async () => {
      const portfolio: Portfolio = {
        positions: new Map([
          [
            "0x1234567890123456789012345678901234567890" as Address,
            {
              token: "0x1234567890123456789012345678901234567890" as Address,
              balance: BigInt(100000000),
              value: BigInt(300000000),
              unrealizedPnL: BigInt(5000000),
            },
          ],
        ]),
        totalValue: BigInt(300000000),
        unrealizedPnL: BigInt(5000000),
      };

      const risk = await riskManager.calculatePortfolioRisk(portfolio);

      expect(risk).toBeDefined();
      expect(typeof risk.totalRisk).toBe("number");
      expect(typeof risk.concentrationRisk).toBe("number");
      expect(typeof risk.liquidityRisk).toBe("number");
      expect(typeof risk.correlationRisk).toBe("number");
      expect(risk.totalRisk).toBeGreaterThanOrEqual(0);
      expect(risk.totalRisk).toBeLessThanOrEqual(100);
    });
  });

  describe("monitorRisk", () => {
    it("should monitor portfolio risk", async () => {
      const riskMonitoring = await riskManager.monitorRisk();

      expect(riskMonitoring).toBeDefined();
      expect(typeof riskMonitoring.currentRisk).toBe("number");
      expect(typeof riskMonitoring.maxRisk).toBe("number");
      expect(typeof riskMonitoring.exceedsLimits).toBe("boolean");
      expect(Array.isArray(riskMonitoring.recommendations)).toBe(true);
    });
  });

  describe("calculateVaR", () => {
    it("should calculate Value at Risk", async () => {
      const portfolio: Portfolio = {
        positions: new Map([
          [
            "0x1234567890123456789012345678901234567890" as Address,
            {
              token: "0x1234567890123456789012345678901234567890" as Address,
              balance: BigInt(100000000),
              value: BigInt(300000000),
              unrealizedPnL: BigInt(0),
            },
          ],
        ]),
        totalValue: BigInt(300000000),
        unrealizedPnL: BigInt(0),
      };

      const var95 = await riskManager.calculateVaR(portfolio, 0.95, 1);
      const var99 = await riskManager.calculateVaR(portfolio, 0.99, 1);

      expect(typeof var95).toBe("bigint");
      expect(typeof var99).toBe("bigint");
      expect(var99).toBeGreaterThan(var95);
    });
  });

  describe("triggerRiskReduction", () => {
    it("should provide risk reduction recommendations", async () => {
      const portfolio: Portfolio = {
        positions: new Map(),
        totalValue: BigInt(100000000),
        unrealizedPnL: BigInt(0),
      };

      const reduction = await riskManager.triggerRiskReduction(portfolio);

      expect(reduction).toBeDefined();
      expect(Array.isArray(reduction.actions)).toBe(true);
      expect(Array.isArray(reduction.ordersToCancel)).toBe(true);
      expect(Array.isArray(reduction.positionsToReduce)).toBe(true);
    });
  });

  describe("getStressTestResults", () => {
    it("should perform stress testing", async () => {
      const scenarios = ["market_crash", "flash_crash", "high_volatility"];
      const results = await riskManager.getStressTestResults(scenarios);

      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBe(scenarios.length);

      for (const scenario of scenarios) {
        const result = results.get(scenario);
        expect(result).toBeDefined();
        expect(typeof result?.portfolioValue).toBe("bigint");
        expect(typeof result?.maxLoss).toBe("bigint");
        expect(typeof result?.timeToRecover).toBe("number");
      }
    });
  });

  describe("recordLoss", () => {
    it("should record daily losses", async () => {
      const lossAmount = BigInt(10000000); // 100 USDC

      await expect(riskManager.recordLoss(lossAmount)).resolves.not.toThrow();
    });
  });

  describe("getRiskBreaches", () => {
    it("should return risk breaches", async () => {
      const breaches = await riskManager.getRiskBreaches();

      expect(Array.isArray(breaches)).toBe(true);
    });

    it("should limit number of breaches returned", async () => {
      const limit = 10;
      const breaches = await riskManager.getRiskBreaches(limit);

      expect(breaches.length).toBeLessThanOrEqual(limit);
    });
  });

  describe("clearRiskBreaches", () => {
    it("should clear risk breaches", async () => {
      await expect(riskManager.clearRiskBreaches()).resolves.not.toThrow();

      const breaches = await riskManager.getRiskBreaches();
      expect(breaches.length).toBe(0);
    });
  });

  describe("emergencyStop", () => {
    it("should execute emergency stop procedures", async () => {
      vi.mocked(mockOrderManager.cancelAllOrders).mockResolvedValue(undefined);
      vi.mocked(mockOrderManager.getOrderStats).mockReturnValue({
        totalOrders: 5,
        openOrders: 3,
        filledOrders: 2,
        cancelledOrders: 0,
      });

      const result = await riskManager.emergencyStop();

      expect(result).toBeDefined();
      expect(typeof result.ordersCancelled).toBe("number");
      expect(typeof result.positionsReduced).toBe("number");
      expect(Array.isArray(result.actions)).toBe(true);
      expect(mockOrderManager.cancelAllOrders).toHaveBeenCalled();
    });
  });
});
