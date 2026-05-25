import { StrategyOptimizer } from "@/domains/strategies/optimization/strategy-optimizer";

describe("StrategyOptimizer", () => {
  it("returns same best parameters for same seed", async () => {
    const buildOptimizer = () => {
      const backtestEngine = {
        config: {
          startDate: new Date("2024-01-01T00:00:00Z"),
          endDate: new Date("2024-01-31T00:00:00Z"),
        },
        runBacktest: vi.fn().mockResolvedValue({
          totalReturn: 0.12,
          sharpeRatio: 1.8,
          maxDrawdown: 0.08,
          totalTrades: 5,
          winRate: 0.6,
          trades: [
            {
              timestamp: 1_700_000_000_000,
              pair: {
                base: "0x1111111111111111111111111111111111111111",
                quote: "0x2222222222222222222222222222222222222222",
                symbol: "ETH/USDC",
              },
              side: "buy" as const,
              price: 10000n,
              quantity: 100n,
              pnl: 1000n,
            },
            {
              timestamp: 1_700_000_600_000,
              pair: {
                base: "0x1111111111111111111111111111111111111111",
                quote: "0x2222222222222222222222222222222222222222",
                symbol: "ETH/USDC",
              },
              side: "sell" as const,
              price: 10100n,
              quantity: 100n,
              pnl: -200n,
            },
          ],
        }),
      };

      return {
        optimizer: new StrategyOptimizer({} as never, backtestEngine as never),
        backtestEngine,
      };
    };

    const first = buildOptimizer();
    const second = buildOptimizer();
    const config = {
      objective: "sharpe_ratio" as const,
      method: "random_search" as const,
      maxIterations: 5,
      randomSeed: 77,
      backtestPeriod: {
        start: new Date("2024-01-01T00:00:00Z"),
        end: new Date("2024-01-31T00:00:00Z"),
      },
    };
    const space = {
      lookback: {
        type: "continuous" as const,
        min: 5,
        max: 20,
      },
      threshold: {
        type: "discrete" as const,
        values: [20, 30, 40],
      },
    };

    const firstResult = await first.optimizer.optimizeParameters(
      "test-strategy",
      space,
      config,
    );
    const secondResult = await second.optimizer.optimizeParameters(
      "test-strategy",
      space,
      config,
    );

    expect(firstResult.bestParameters).toEqual(secondResult.bestParameters);
    expect(first.backtestEngine.runBacktest).toHaveBeenCalled();
    expect(second.backtestEngine.runBacktest).toHaveBeenCalled();
  });
});
