import { StrategyManager } from "@/domains/strategies/management/strategy-manager";
import { StrategyRegistry } from "@/domains/strategies/management/strategy-registry";
import type {
  IStrategy,
  StrategyConfig,
  StrategyContext,
  StrategyInstance,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
} from "@/domains/strategies/core/i-strategy";

const createMockContext = (): StrategyContext => ({
  portfolio: {
    totalValue: 0,
    dailyPnl: 0,
    dailyReturn: 0,
    sharpeRatio: 0,
    positions: {},
  },
  positions: new Map(),
  marketData: new Map(),
  parameters: {},
  state: new Map(),
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
});

class TestStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "test-strategy",
    name: "Test Strategy",
    description: "Test",
    version: "1.0.0",
    author: "test",
    supportedPairs: ["ETH/USDC"],
    category: "custom",
    riskLevel: 1,
    minCapital: 0,
    parametersSchema: {},
  };

  async initialize(_context: StrategyContext): Promise<void> {}

  async execute(_context: StrategyContext): Promise<StrategyResult> {
    return {
      signals: [],
      shouldContinue: true,
    };
  }

  async validateParameters(_parameters: StrategyParameters): Promise<string[]> {
    return [];
  }

  async updateParameters(
    _parameters: Partial<StrategyParameters>,
    _context: StrategyContext,
  ): Promise<void> {}

  async cleanup(_context: StrategyContext): Promise<void> {}
}

describe("StrategyManager coordinator scheduling", () => {
  let registry: StrategyRegistry;
  let manager: StrategyManager;
  let performStrategyExecution: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    registry = new StrategyRegistry();
    await registry.registerStrategy(
      new TestStrategy().config,
      {
        createStrategy: () => new TestStrategy(),
      },
      { tags: [] },
    );

    manager = new StrategyManager(
      registry,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    vi.spyOn(
      manager as unknown as {
        createStrategyContext: () => Promise<StrategyContext>;
      },
      "createStrategyContext",
    ).mockResolvedValue(createMockContext());
    vi.spyOn(
      manager as unknown as {
        setupMarketDataSubscriptions: () => Promise<void>;
      },
      "setupMarketDataSubscriptions",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as {
        cleanupMarketDataSubscriptions: () => Promise<void>;
      },
      "cleanupMarketDataSubscriptions",
    ).mockResolvedValue(undefined);
    performStrategyExecution = vi
      .spyOn(
        manager as unknown as {
          performStrategyExecution: () => Promise<StrategyResult>;
        },
        "performStrategyExecution",
      )
      .mockResolvedValue({
        signals: [],
        shouldContinue: true,
      });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves maxExecutionsPerMinute while using coordinator", async () => {
    await manager.createAndStartStrategy("test-strategy", "instance-1", {}, {
      executeInterval: 1_000,
      maxExecutionsPerMinute: 2,
    });

    expect(performStrategyExecution).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(49_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(3);
  });

  it("pause stops ticks and resume restarts ticks with prior interval", async () => {
    await manager.createAndStartStrategy("test-strategy", "instance-2", {}, {
      executeInterval: 2_000,
    });

    expect(performStrategyExecution).toHaveBeenCalledTimes(1);

    await manager.pauseStrategy("instance-2");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(1);

    await manager.resumeStrategy("instance-2");
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(performStrategyExecution).toHaveBeenCalledTimes(3);
  });

  it("stop cleans coordinator resources and prevents later ticks", async () => {
    await manager.createAndStartStrategy("test-strategy", "instance-3", {}, {
      executeInterval: 1_000,
    });

    expect(performStrategyExecution).toHaveBeenCalledTimes(1);

    await manager.stopStrategy("instance-3");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(performStrategyExecution).toHaveBeenCalledTimes(1);
    expect(manager.getInstance("instance-3")).toBeUndefined();
    expect(
      (
        manager as unknown as {
          executionCoordinators: Map<string, unknown>;
        }
      ).executionCoordinators.size,
    ).toBe(0);
  });

  it("records warning and skips order for unknown pair signals", async () => {
    const instance = {
      id: "instance-4",
      strategyId: "test-strategy",
      strategy: new TestStrategy(),
      parameters: {},
      status: "running",
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
      state: new Map(),
      createdAt: Date.now(),
      executionCount: 0,
      errors: [],
      subscriptions: new Set(),
    } satisfies StrategyInstance;
    const orderExecutor = vi.fn();

    manager.setOrderExecutor(orderExecutor);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<void>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "DOGE/USDC",
          confidence: 1,
          reason: "test",
        },
      ],
      createMockContext(),
    );

    expect(orderExecutor).not.toHaveBeenCalled();
    expect(instance.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: "Unsupported trading pair: DOGE/USDC",
        }),
      ]),
    );
  });
});
