import { PerformanceAnalyzer } from "@/domains/analytics/performance-analyzer";
import type { CompletedTrade } from "@/shared/types/analytics";

describe("PerformanceAnalyzer", () => {
  let analyzer: PerformanceAnalyzer;

  beforeEach(() => {
    analyzer = new PerformanceAnalyzer();
  });

  const trades: CompletedTrade[] = [
    {
      symbol: "ETH/USDC",
      side: "buy",
      size: 1000,
      price: 3000,
      timestamp: Date.now(),
      pnl: 100,
    },
    {
      symbol: "ETH/USDC",
      side: "sell",
      size: 500,
      price: 3100,
      timestamp: Date.now() + 1000,
      pnl: -50,
    },
    {
      symbol: "BTC/USDC",
      side: "buy",
      size: 2000,
      price: 45000,
      timestamp: Date.now() + 2000,
      pnl: 0,
    },
  ];

  it("calculates metrics", async () => {
    const result = await analyzer.calculateMetrics(trades, 10000);

    expect(result.totalTrades).toBe(trades.length);
    expect(typeof result.totalReturn).toBe("number");
    expect(typeof result.sharpeRatio).toBe("number");
  });

  it("analyzes drawdowns", async () => {
    const result = await analyzer.analyzeDrawdowns([1000, 1100, 900, 1200]);

    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.start).toBeInstanceOf(Date);
    expect(result[0]?.end).toBeInstanceOf(Date);
  });

  it("analyzes trade buckets", async () => {
    const result = await analyzer.analyzeTrades(trades);

    expect(result.winningTrades).toHaveLength(1);
    expect(result.losingTrades).toHaveLength(1);
    expect(result.breakEvenTrades).toHaveLength(1);
    expect(Array.isArray(result.profitDistribution)).toBe(true);
  });

  it("generates empty equity curve stub", async () => {
    const result = await analyzer.generateEquityCurve(trades, 10000);

    expect(result).toEqual([]);
  });

  it("generates empty rolling metrics stub", async () => {
    const result = await analyzer.calculateRollingMetrics(trades, 30);

    expect(result).toEqual([]);
  });

  it("builds performance report", async () => {
    const result = await analyzer.generatePerformanceReport(trades, 10000);

    expect(result.summary.totalTrades).toBe(trades.length);
    expect(Array.isArray(result.monthlyReturns)).toBe(true);
    expect(Array.isArray(result.drawdowns)).toBe(true);
    expect(result.tradeAnalysis.winningTrades).toHaveLength(1);
    expect(typeof result.riskMetrics.var95).toBe("number");
  });

  it("compares benchmark", async () => {
    const result = await analyzer.benchmarkComparison(
      [0.05, 0.02, -0.01],
      [0.04, 0.01, 0],
    );

    expect(typeof result.alpha).toBe("number");
    expect(typeof result.beta).toBe("number");
    expect(typeof result.correlation).toBe("number");
  });

  it("exports reports in supported formats", async () => {
    await expect(analyzer.exportReport({ a: 1 }, "json")).resolves.toContain(
      '"a": 1',
    );
    await expect(analyzer.exportReport({ a: 1 }, "csv")).resolves.toBe(
      "CSV format not implemented",
    );
    await expect(analyzer.exportReport({ a: 1 }, "html")).resolves.toContain(
      "<html>",
    );
  });
});
