import {
  StressTestStrategy,
  type StressTestParameters,
} from "@/domains/strategies/builtin/stress-test-strategy";
import type { StrategyContext } from "@/domains/strategies/core/i-strategy";

const createContext = (
  parameters: StressTestParameters,
  state = new Map<string, unknown>(),
): StrategyContext =>
  ({
    portfolio: {
      totalValue: 100000,
      dailyPnl: 0,
      dailyReturn: 0,
      sharpeRatio: 0,
      positions: {
        BTC: {
          symbol: "BTC",
          balance: 10,
          value: 1000,
          unrealizedPnl: 0,
        },
        USDC: {
          symbol: "USDC",
          balance: 10000,
          value: 10000,
          unrealizedPnl: 0,
        },
      },
    },
    positions: new Map(),
    marketData: new Map([
      [
        "BTC/USDC",
        {
          close: 100,
        } as never,
      ],
    ]),
    parameters,
    state,
    metrics: {
      totalReturn: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      totalTrades: 0,
      avgHoldingPeriod: 0,
      profitFactor: 0,
      lastUpdate: 0,
    },
    utils: {
      indicators: {
        sma: () => 0,
        ema: () => 0,
        rsi: () => 50,
        macd: () => ({ macd: 0, signal: 0, histogram: 0 }),
        bollingerBands: () => ({ upper: 0, middle: 0, lower: 0 }),
        stochastic: () => ({ k: 50, d: 50 }),
      },
      math: {
        mean: () => 0,
        std: () => 0,
        correlation: () => 0,
        percentile: () => 0,
      },
      time: {
        getCurrentTimestamp: () => Date.now(),
        formatTime: (timestamp: number) => new Date(timestamp).toISOString(),
        getMarketHours: () => ({ isOpen: true, nextOpen: 0, nextClose: 0 }),
      },
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    },
  }) satisfies StrategyContext;

describe("StressTestStrategy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits repeatable signals with same seed", async () => {
    const parameters: StressTestParameters = {
      pair: "BTC/USDC",
      maxOrders: 10,
      ordersPerBatch: 4,
      intervalMs: 500,
      minOrderUsd: 10,
      maxOrderUsd: 25,
      seed: 99,
    };
    const firstStrategy = new StressTestStrategy();
    const secondStrategy = new StressTestStrategy();
    const firstContext = createContext(parameters);
    const secondContext = createContext(parameters);

    await firstStrategy.initialize(firstContext);
    await secondStrategy.initialize(secondContext);

    const firstResult = await firstStrategy.execute(firstContext);
    const secondResult = await secondStrategy.execute(secondContext);

    expect(firstResult.signals).toEqual(secondResult.signals);
  });
});
