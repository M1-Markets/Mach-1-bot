import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import { RiskLimits, RiskManager } from "@/domains/trading/risk-manager";
import { Address, OrderRequest, Portfolio, Position } from "@/shared/types";

describe("RiskManager", () => {
  let riskManager: RiskManager;
  let mockPositionTracker: PositionTracker;
  let mockMarketManager: MarketManager;
  let mockOrderManager: OrderManager;

  beforeEach(() => {
    // Create mocks
    mockPositionTracker = {
      getPortfolio: vi.fn(),
      getPosition: vi.fn(),
      getPositionSummary: vi.fn(),
      getOpenOrders: vi.fn(),
    } as unknown as PositionTracker;

    mockMarketManager = {} as unknown as MarketManager;

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
