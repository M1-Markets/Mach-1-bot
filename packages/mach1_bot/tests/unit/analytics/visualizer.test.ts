import { Visualizer } from "@/domains/analytics/visualizer";
import type { CompletedTrade } from "@/shared/types/analytics";
import type { Portfolio } from "@/shared/types/bot";

describe("Visualizer", () => {
  let visualizer: Visualizer;

  beforeEach(() => {
    visualizer = new Visualizer();
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
  ];

  const portfolio: Portfolio = {
    totalValue: 10000,
    dailyPnl: 150,
    dailyReturn: 0.015,
    sharpeRatio: 1.2,
    positions: {},
  };

  it("plots equity curve", async () => {
    await expect(
      visualizer.plotEquityCurve([{ timestamp: Date.now(), equity: 10000 }]),
    ).resolves.toBe("equity_curve_chart_url_or_base64");
  });

  it("plots drawdown", async () => {
    await expect(
      visualizer.plotDrawdown([{ timestamp: Date.now(), drawdown: 0.1 }]),
    ).resolves.toBe("drawdown_chart_url_or_base64");
  });

  it("plots returns distribution", async () => {
    await expect(
      visualizer.plotReturnsDistribution([0.05, -0.02, 0.03]),
    ).resolves.toBe("returns_distribution_url_or_base64");
  });

  it("plots rolling sharpe ratio", async () => {
    await expect(
      visualizer.plotRollingSharpRatio([new Date()], [1.5]),
    ).resolves.toBe("rolling_sharpe_url_or_base64");
  });

  it("plots monthly returns", async () => {
    await expect(
      visualizer.plotMonthlyReturns([{ month: "2024-01", return: 0.05 }]),
    ).resolves.toBe("monthly_returns_url_or_base64");
  });

  it("plots trade size distribution", async () => {
    await expect(visualizer.plotTradeSizeDistribution(trades)).resolves.toBe(
      "trade_size_distribution_url_or_base64",
    );
  });

  it("plots pnl by symbol", async () => {
    await expect(visualizer.plotPnLBySymbol(trades)).resolves.toBe(
      "pnl_by_symbol_url_or_base64",
    );
  });

  it("plots portfolio allocation", async () => {
    await expect(visualizer.plotPortfolioAllocation(portfolio)).resolves.toBe(
      "portfolio_allocation_url_or_base64",
    );
  });

  it("plots risk heatmap", async () => {
    await expect(
      visualizer.plotRiskHeatmap(
        [
          [1, 0.8],
          [0.8, 1],
        ],
        ["ETH/USDC", "BTC/USDC"],
      ),
    ).resolves.toBe("risk_heatmap_url_or_base64");
  });

  it("plots candlestick chart", async () => {
    await expect(
      visualizer.plotCandlestickChart(
        [
          {
            timestamp: Date.now(),
            open: 100,
            high: 110,
            low: 95,
            close: 105,
            volume: 1000,
          },
        ],
        "ETH/USDC",
      ),
    ).resolves.toBe("candlestick_chart_url_or_base64");
  });

  it("creates dashboard", async () => {
    const result = await visualizer.createDashboard(portfolio, trades);

    expect(result.html).toBe("<div>Interactive Dashboard (stub)</div>");
    expect(Array.isArray(result.assets)).toBe(true);
    expect(typeof result.updateData).toBe("function");
  });

  it("exports chart buffer", async () => {
    const result = await visualizer.exportChart("chart", "png");

    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("chart_data_stub");
  });

  it("creates animated chart", async () => {
    await expect(
      visualizer.createAnimatedChart([
        { timestamp: Date.now(), data: [{ x: [1], y: [2], type: "line" }] },
      ]),
    ).resolves.toBe("animated_chart_url_or_base64");
  });

  it("generates performance report", async () => {
    const result = await visualizer.generatePerformanceReport({
      totalReturn: 0.15,
    });

    expect(result.html).toBe("<html>Performance Report (stub)</html>");
    expect(result.pdf).toBeInstanceOf(Buffer);
    expect(Array.isArray(result.charts)).toBe(true);
  });

  it("creates realtime chart", async () => {
    const result = await visualizer.createRealTimeChart("ETH/USDC");

    expect(result.chartId).toBe("realtime_chart_stub");
    expect(typeof result.update).toBe("function");
    expect(typeof result.destroy).toBe("function");
  });

  it("compares strategies", async () => {
    await expect(
      visualizer.compareStrategies([
        { name: "A", equityCurve: [1, 2, 3], metrics: {} },
      ]),
    ).resolves.toBe("strategy_comparison_url_or_base64");
  });
});
