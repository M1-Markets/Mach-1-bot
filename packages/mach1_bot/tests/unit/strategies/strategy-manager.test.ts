import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import type {
  IStrategy,
  StrategyConfig,
  StrategyContext,
  StrategyInstance,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
} from "@/domains/strategies/core/i-strategy";
import { StrategyManager } from "@/domains/strategies/management/strategy-manager";
import { StrategyRegistry } from "@/domains/strategies/management/strategy-registry";
import { RiskManager } from "@/domains/trading/risk-manager";

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
    trading: {
      getPositionQuantity: () => 0,
      getPendingQuantity: () => 0,
      getAvailableCapital: () => 0,
      fullCloseQuantity: () => 0,
      partialCloseQuantity: () => 0,
      maxRiskPositionSize: () => 0,
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

  async initialize(_context: StrategyContext): Promise<void> {
    // Intentional no-op for tests.
  }

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
  ): Promise<void> {
    // Intentional no-op for tests.
  }

  async cleanup(_context: StrategyContext): Promise<void> {
    // Intentional no-op for tests.
  }
}

class CapturingStrategy extends TestStrategy {
  contexts: StrategyContext[] = [];

  override async execute(context: StrategyContext): Promise<StrategyResult> {
    this.contexts.push(context);
    return {
      signals: [],
      shouldContinue: true,
    };
  }
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
    await manager.createAndStartStrategy(
      "test-strategy",
      "instance-1",
      {},
      {
        executeInterval: 1_000,
        maxExecutionsPerMinute: 2,
      },
    );

    expect(performStrategyExecution).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(49_000);
    expect(performStrategyExecution).toHaveBeenCalledTimes(3);
  });

  it("pause stops ticks and resume restarts ticks with prior interval", async () => {
    await manager.createAndStartStrategy(
      "test-strategy",
      "instance-2",
      {},
      {
        executeInterval: 2_000,
      },
    );

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
    await manager.createAndStartStrategy(
      "test-strategy",
      "instance-3",
      {},
      {
        executeInterval: 1_000,
      },
    );

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
          message: expect.stringContaining("pair:unsupported_pair"),
        }),
      ]),
    );
  });

  it("returns structured validation errors for invalid confidence", async () => {
    const validation = await (
      manager as unknown as {
        validateStrategySignal: (signal: StrategySignal) => Promise<{
          valid: boolean;
          errors: Array<{ code: string; field: string; message: string }>;
        }>;
      }
    ).validateStrategySignal({
      action: "buy",
      pair: "ETH/USDC",
      quantity: 1,
      confidence: 1.5,
      reason: "test",
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: "invalid_confidence",
        field: "confidence",
      }),
    );
  });

  it("returns structured validation errors for missing quantity", async () => {
    const validation = await (
      manager as unknown as {
        validateStrategySignal: (signal: StrategySignal) => Promise<{
          valid: boolean;
          errors: Array<{ code: string; field: string; message: string }>;
        }>;
      }
    ).validateStrategySignal({
      action: "buy",
      pair: "ETH/USDC",
      confidence: 1,
      reason: "test",
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: "missing_quantity",
        field: "quantity",
      }),
    );
  });

  it("returns structured validation errors for unsupported action", async () => {
    const validation = await (
      manager as unknown as {
        validateStrategySignal: (signal: StrategySignal) => Promise<{
          valid: boolean;
          errors: Array<{ code: string; field: string; message: string }>;
        }>;
      }
    ).validateStrategySignal({
      action: "close_position",
      pair: "ETH/USDC",
      confidence: 1,
      reason: "test",
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: "unsupported_action",
        field: "action",
      }),
    );
  });

  it("skips signal when quantity missing", async () => {
    const instance = {
      id: "instance-5",
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

    const warnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          confidence: 1,
          reason: "test",
        },
      ],
      createMockContext(),
    );

    expect(orderExecutor).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      expect.stringContaining("quantity:missing_quantity"),
    ]);
  });

  it("maps market and limit order types explicitly", async () => {
    const validatingRiskManager = {
      validateOrder: vi.fn().mockResolvedValue({
        approved: true,
        rejectionReasons: [],
      }),
    };
    (
      manager as unknown as {
        riskManager: typeof validatingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = validatingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    const orderExecutor = vi.fn().mockResolvedValue({
      orderId: "order-1",
      status: "filled",
      filledQuantity: 100n,
      remainingQuantity: 0n,
    });
    const instance = {
      id: "instance-6",
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

    manager.setOrderExecutor(orderExecutor);

    await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "market",
          orderType: "market",
        },
        {
          action: "sell",
          pair: "ETH/USDC",
          quantity: 2,
          price: 456.78,
          confidence: 1,
          reason: "limit",
          orderType: "limit",
        },
      ],
      createMockContext(),
    );

    expect(orderExecutor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderType: "market",
      }),
    );
    expect(orderExecutor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderType: "limit",
        price: 45678n,
      }),
    );
  });

  it("skips unsupported order type", async () => {
    const instance = {
      id: "instance-7",
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

    const warnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "test",
          orderType: "stop",
        },
      ],
      createMockContext(),
    );

    expect(orderExecutor).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      expect.stringContaining("orderType:unsupported_order_type"),
    ]);
  });

  it("runs risk check before submitting valid buy signal", async () => {
    const callSequence: string[] = [];
    const validatingRiskManager = {
      validateOrder: vi.fn().mockImplementation(async (request) => {
        callSequence.push(`risk:${request.strategyId}:${request.isBuy}`);
        return {
          approved: true,
          rejectionReasons: [],
        };
      }),
    };
    const orderExecutor = vi.fn().mockImplementation(async (request) => {
      callSequence.push(`order:${request.strategyId}:${request.isBuy}`);
      return {
        orderId: "order-approve-1",
        status: "filled",
        filledQuantity: request.quantity,
        remainingQuantity: 0n,
      };
    });
    const instance = {
      id: "instance-8",
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

    (
      manager as unknown as {
        riskManager: typeof validatingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = validatingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    manager.setOrderExecutor(orderExecutor);

    await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "regression",
        },
      ],
      createMockContext(),
    );

    expect(validatingRiskManager.validateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyId: "instance-8",
        isBuy: true,
        orderType: "market",
      }),
    );
    expect(orderExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyId: "instance-8",
        isBuy: true,
        orderType: "market",
      }),
    );
    expect(callSequence).toEqual([
      "risk:instance-8:true",
      "order:instance-8:true",
    ]);
  });

  it("submits explicit sell exit signals instead of skipping validation", async () => {
    const validatingRiskManager = {
      validateOrder: vi.fn().mockResolvedValue({
        approved: true,
        rejectionReasons: [],
      }),
    };
    const orderExecutor = vi.fn().mockImplementation(async (request) => ({
      orderId: "order-exit-1",
      status: "filled",
      filledQuantity: request.quantity,
      remainingQuantity: 0n,
    }));
    const instance = {
      id: "instance-8b",
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

    (
      manager as unknown as {
        riskManager: typeof validatingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = validatingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    manager.setOrderExecutor(orderExecutor);

    const warnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "sell",
          pair: "ETH/USDC",
          quantity: 1.5,
          confidence: 1,
          reason: "close long",
        },
      ],
      createMockContext(),
    );

    expect(warnings).toEqual([]);
    expect(validatingRiskManager.validateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        isBuy: false,
        quantity: 150n,
      }),
    );
    expect(orderExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        isBuy: false,
        quantity: 150n,
      }),
    );
  });

  it("suppresses duplicate signals inside the execution cooldown window", async () => {
    const validatingRiskManager = {
      validateOrder: vi.fn().mockResolvedValue({
        approved: true,
        rejectionReasons: [],
      }),
    };
    const orderExecutor = vi.fn().mockResolvedValue({
      orderId: "order-dup-1",
      status: "filled",
      filledQuantity: 100n,
      remainingQuantity: 0n,
    });
    const instance = {
      id: "instance-dup",
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

    (
      manager as unknown as {
        riskManager: typeof validatingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = validatingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    manager.setOrderExecutor(orderExecutor);

    const signal: StrategySignal = {
      action: "buy",
      pair: "ETH/USDC",
      quantity: 1,
      confidence: 1,
      reason: "repeat",
    };

    const firstWarnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(instance, [signal], createMockContext());
    const secondWarnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(instance, [signal], createMockContext());

    expect(firstWarnings).toEqual([]);
    expect(secondWarnings).toEqual([
      "Strategy signal suppressed for ETH/USDC: duplicate_signal_cooldown",
    ]);
    expect(orderExecutor).toHaveBeenCalledTimes(1);
  });

  it("suppresses overlapping signals while a pending order exists", async () => {
    const orderExecutor = vi.fn();
    const instance = {
      id: "instance-pending",
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
      subscriptions: new Set(["ETH/USDC"]),
    } satisfies StrategyInstance;
    (
      manager as unknown as {
        instances: Map<string, StrategyInstance>;
      }
    ).instances.set(instance.id, instance);
    manager.setOrderExecutor(orderExecutor);

    await (
      manager as unknown as {
        handleOrderLifecycleEvent: (event: {
          type: "submitted";
          timestamp: number;
          order: {
            localId: string;
            strategyId: string;
            pair: { symbol: string };
            side: "buy" | "sell";
            requestedPrice: bigint;
            requestedQuantity: bigint;
            filledQuantity: bigint;
            remainingQuantity: bigint;
            status: "submitted";
          };
        }) => Promise<void>;
      }
    ).handleOrderLifecycleEvent({
      type: "submitted",
      timestamp: Date.now(),
      order: {
        localId: "pending-order-1",
        strategyId: instance.id,
        pair: {
          base: "0x1111111111111111111111111111111111111111",
          quote: "0x4444444444444444444444444444444444444444",
          symbol: "ETH/USDC",
        },
        side: "buy",
        type: "market",
        requestedPrice: 12345n,
        requestedQuantity: 100n,
        filledQuantity: 0n,
        remainingQuantity: 100n,
        fees: 0n,
        slippage: 0n,
        status: "submitted",
        submittedAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    const pendingContext = createMockContext();
    pendingContext.utils.trading.getPendingQuantity = (_pair, side) =>
      side === "buy" ? 1 : 0;

    const warnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "pending overlap",
        },
      ],
      pendingContext,
    );

    expect(warnings).toEqual([
      "Strategy signal suppressed for ETH/USDC: pending_buy_order_overlap",
    ]);
    expect(orderExecutor).not.toHaveBeenCalled();
  });

  it("exposes position-aware close and risk sizing helpers", () => {
    const instance = {
      id: "instance-utils",
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

    (
      manager as unknown as {
        pendingOrders: Map<
          string,
          {
            strategyId?: string;
            pair: { symbol: string };
            side: "buy" | "sell";
            remainingQuantity: bigint;
            requestedPrice: bigint;
          }
        >;
      }
    ).pendingOrders.set("pending-buy", {
      strategyId: instance.id,
      pair: {
        base: "0x1111111111111111111111111111111111111111",
        quote: "0x4444444444444444444444444444444444444444",
        symbol: "ETH/USDC",
      },
      side: "buy",
      type: "market",
      requestedPrice: 10000n,
      requestedQuantity: 100n,
      filledQuantity: 0n,
      remainingQuantity: 25n,
      fees: 0n,
      slippage: 0n,
      status: "submitted",
      submittedAt: Date.now(),
      updatedAt: Date.now(),
      localId: "pending-buy",
    });

    const utils = (
      manager as unknown as {
        createStrategyUtils: (
          instance: StrategyInstance,
          corePositions: Map<string, { balance: bigint }>,
          portfolio: { totalValue: number },
        ) => StrategyContext["utils"];
      }
    ).createStrategyUtils(
      instance,
      new Map([
        [
          "0x1111111111111111111111111111111111111111",
          {
            balance: 250n,
          },
        ],
      ]),
      {
        totalValue: 10_000,
      } as never,
    );

    expect(utils.trading.fullCloseQuantity("ETH/USDC")).toBe(2.5);
    expect(utils.trading.partialCloseQuantity("ETH/USDC", 0.4)).toBe(1);
    expect(utils.trading.getPendingQuantity("ETH/USDC", "buy")).toBe(0.25);
    expect(utils.trading.getAvailableCapital()).toBe(9_975);
    expect(utils.trading.maxRiskPositionSize(100, 95, 0.02)).toBe(40);
  });

  it("turns valid perps long signal into perps-capable order request", async () => {
    const validatingRiskManager = {
      validateOrder: vi.fn().mockResolvedValue({
        approved: true,
        rejectionReasons: [],
      }),
    };
    const orderExecutor = vi.fn().mockResolvedValue({
      orderId: "perps-order-1",
      status: "pending",
      filledQuantity: 0n,
      remainingQuantity: 100n,
    });
    const instance = {
      id: "instance-perps-1",
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

    (
      manager as unknown as {
        riskManager: typeof validatingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = validatingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    manager.setOrderExecutor(orderExecutor);

    await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "perps long entry",
          direction: "long",
          leverage: 4,
        },
      ],
      createMockContext(),
    );

    expect(validatingRiskManager.validateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "long",
        leverage: 4,
        isBuy: true,
        orderType: "market",
      }),
    );
    expect(orderExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "long",
        leverage: 4,
        isBuy: true,
        orderType: "market",
      }),
    );
  });

  it("skips reduce-only signal when isolated perps direction missing", async () => {
    const instance = {
      id: "instance-perps-2",
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

    const warnings = await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "sell",
          pair: "ETH/USDC",
          quantity: 0.5,
          confidence: 1,
          reason: "reduce without explicit side",
          reduceOnly: true,
        },
      ],
      createMockContext(),
    );

    expect(orderExecutor).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      expect.stringContaining("missing_perps_direction"),
    ]);
  });

  it("prevents order submission when risk rejects valid signal", async () => {
    const rejectingRiskManager = {
      validateOrder: vi.fn().mockResolvedValue({
        approved: false,
        rejectionReasons: ["blocked by risk"],
      }),
    };
    const orderExecutor = vi.fn();
    const instance = {
      id: "instance-9",
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

    (
      manager as unknown as {
        riskManager: typeof rejectingRiskManager;
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).riskManager = rejectingRiskManager;
    (
      manager as unknown as {
        marketManager: { getCurrentPrice: () => Promise<bigint> };
      }
    ).marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(12345n),
    };
    manager.setOrderExecutor(orderExecutor);

    await (
      manager as unknown as {
        processStrategySignals: (
          instance: StrategyInstance,
          signals: StrategySignal[],
          context: StrategyContext,
        ) => Promise<string[]>;
      }
    ).processStrategySignals(
      instance,
      [
        {
          action: "buy",
          pair: "ETH/USDC",
          quantity: 1,
          confidence: 1,
          reason: "risk reject",
        },
      ],
      createMockContext(),
    );

    expect(rejectingRiskManager.validateOrder).toHaveBeenCalledTimes(1);
    expect(orderExecutor).not.toHaveBeenCalled();
    expect(instance.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("blocked by risk"),
        }),
      ]),
    );
  });
});

describe("StrategyManager market data context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("managed strategy receives non-placeholder market data", async () => {
    const registry = new StrategyRegistry();
    const strategy = new CapturingStrategy();

    await registry.registerStrategy(
      strategy.config,
      {
        createStrategy: () => strategy,
      },
      { tags: [] },
    );

    const manager = new StrategyManager(
      registry,
      {
        getCandles: vi.fn().mockResolvedValue(
          Array.from({ length: 40 }, (_, index) => ({
            timestamp: 1_700_000_000_000 + index * 60_000,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100.5 + index,
            volume: 1000 + index,
          })),
        ),
      } as never,
      {} as never,
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map(),
          totalValue: 100000n,
        }),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
        }),
        getPerformanceMetrics: vi.fn().mockResolvedValue({
          sharpeRatio: 0,
        }),
      } as never,
      {
        subscribePrices: vi.fn().mockResolvedValue({
          subscribe: () => () => undefined,
          unsubscribe: () => undefined,
        }),
        getOHLCVSnapshot: vi.fn().mockResolvedValue({
          T: 1_700_000_000_000,
          o: 100,
          h: 110,
          l: 95,
          c: 108,
          v: 12345,
        }),
        getOrderbookSnapshot: vi.fn().mockResolvedValue({
          bids: [{ price: "107.5", quantity: "2" }],
          asks: [{ price: "108.5", quantity: "3" }],
        }),
      } as never,
      {
        validateOrder: vi.fn(),
      } as never,
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await manager.createAndStartStrategy(
      "test-strategy",
      "market-data-1",
      {},
      {},
    );
    await manager.executeStrategy("market-data-1");

    const context = strategy.contexts[strategy.contexts.length - 1];
    const tick = context.marketData.get("ETH/USDC")?.["ETH/USDC"];

    expect(tick).toBeDefined();
    expect(tick).toMatchObject({
      open: 100,
      high: 110,
      low: 95,
      close: 108,
      volume: 12345,
      bestBid: 107.5,
      bestAsk: 108.5,
      spread: 1,
    });
    expect(tick?.rsi).toBeGreaterThan(50);
  });

  it("skips strategy tick when subscribed market data missing", async () => {
    const registry = new StrategyRegistry();
    const execute = vi.fn().mockResolvedValue({
      signals: [],
      shouldContinue: true,
    });

    await registry.registerStrategy(
      new TestStrategy().config,
      {
        createStrategy: () =>
          Object.assign(new TestStrategy(), {
            execute,
          }),
      },
      { tags: [] },
    );

    const manager = new StrategyManager(
      registry,
      {
        getCandles: vi.fn().mockResolvedValue([]),
      } as never,
      {} as never,
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map(),
          totalValue: 100000n,
        }),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
        }),
        getPerformanceMetrics: vi.fn().mockResolvedValue({
          sharpeRatio: 0,
        }),
      } as never,
      {
        subscribePrices: vi.fn().mockResolvedValue({
          subscribe: () => () => undefined,
          unsubscribe: () => undefined,
        }),
        getOHLCVSnapshot: vi.fn().mockResolvedValue(undefined),
        getOrderbookSnapshot: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        validateOrder: vi.fn(),
      } as never,
    );

    await manager.createAndStartStrategy(
      "test-strategy",
      "market-data-2",
      {},
      {},
    );
    const result = await manager.executeStrategy("market-data-2");
    const instance = manager.getInstance("market-data-2");

    expect(execute).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([
      "Missing market data for subscribed pairs: ETH/USDC",
    ]);
    expect(instance?.errors.at(-1)?.severity).toBe("warning");
    expect(instance?.errors.at(-1)?.message).toContain("Missing market data");
  });
});

describe("StrategyManager order events", () => {
  const pairSymbol = "ETH/USDC";

  const emitFilledOrder = (
    store: OrderLifecycleStore,
    strategyId: string,
    side: "buy" | "sell",
    price: bigint,
  ) => {
    const localId = `${strategyId}-${side}-${price}`;
    store.createSubmittedOrder({
      localId,
      strategyId,
      pair: {
        base: "0x1111111111111111111111111111111111111111",
        quote: "0x2222222222222222222222222222222222222222",
        symbol: pairSymbol,
      },
      order: {
        baseToken: "0x1111111111111111111111111111111111111111",
        quoteToken: "0x2222222222222222222222222222222222222222",
        isBuy: side === "buy",
        orderType: "market",
        price,
        quantity: 100n,
        strategyId,
      },
    });
    store.applyUpdate({
      localId,
      type: "accepted",
      status: "pending",
    });
    store.applyUpdate({
      localId,
      type: "filled",
      status: "filled",
      filledQuantity: 100n,
      remainingQuantity: 0n,
      averageFillPrice: price,
    });
  };

  it("strategy receives fill event and unrelated strategy does not", async () => {
    const registry = new StrategyRegistry();
    const relatedOnOrderEvent = vi.fn().mockResolvedValue(undefined);
    const unrelatedOnOrderEvent = vi.fn().mockResolvedValue(undefined);

    class RelatedStrategy extends TestStrategy {
      override onOrderEvent = relatedOnOrderEvent;
    }
    class UnrelatedStrategy extends TestStrategy {
      override readonly config = {
        ...new TestStrategy().config,
        id: "unrelated-strategy",
        supportedPairs: ["BTC/USDC"],
      };
      override onOrderEvent = unrelatedOnOrderEvent;
    }

    await registry.registerStrategy(
      new RelatedStrategy().config,
      { createStrategy: () => new RelatedStrategy() },
      { tags: [] },
    );
    await registry.registerStrategy(
      new UnrelatedStrategy().config,
      { createStrategy: () => new UnrelatedStrategy() },
      { tags: [] },
    );

    const manager = new StrategyManager(
      registry,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const store = new OrderLifecycleStore(new OrderEventEmitter());
    manager.attachOrderEventEmitter(store.getEventEmitter());

    vi.spyOn(
      manager as unknown as {
        createStrategyContext: () => Promise<StrategyContext>;
      },
      "createStrategyContext",
    ).mockResolvedValue(createMockContext());
    vi.spyOn(
      manager as unknown as {
        setupMarketDataSubscriptions: (
          instance: StrategyInstance,
          strategy: { config: { supportedPairs: string[] } },
        ) => Promise<void>;
      },
      "setupMarketDataSubscriptions",
    ).mockImplementation(async (instance, strategy) => {
      for (const pair of strategy.config.supportedPairs) {
        instance.subscriptions.add(pair);
      }
    });
    vi.spyOn(
      manager as unknown as {
        cleanupMarketDataSubscriptions: () => Promise<void>;
      },
      "cleanupMarketDataSubscriptions",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as {
        startStrategyExecution: () => Promise<void>;
      },
      "startStrategyExecution",
    ).mockResolvedValue(undefined);

    await manager.createAndStartStrategy(
      "test-strategy",
      "instance-related",
      {},
    );
    await manager.createAndStartStrategy(
      "unrelated-strategy",
      "instance-unrelated",
      {},
    );

    emitFilledOrder(store, "instance-related", "buy", 10000n);
    await vi.waitFor(() => {
      expect(
        relatedOnOrderEvent.mock.calls.some(
          ([event]) => event.type === "filled",
        ),
      ).toBe(true);
    });
    expect(unrelatedOnOrderEvent).not.toHaveBeenCalled();
  });

  it("records performance from fills only", async () => {
    const registry = new StrategyRegistry();
    await registry.registerStrategy(
      new TestStrategy().config,
      { createStrategy: () => new TestStrategy() },
      { tags: [] },
    );

    const manager = new StrategyManager(
      registry,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const store = new OrderLifecycleStore(new OrderEventEmitter());
    manager.attachOrderEventEmitter(store.getEventEmitter());

    vi.spyOn(
      manager as unknown as {
        createStrategyContext: () => Promise<StrategyContext>;
      },
      "createStrategyContext",
    ).mockResolvedValue(createMockContext());
    vi.spyOn(
      manager as unknown as {
        setupMarketDataSubscriptions: (
          instance: StrategyInstance,
        ) => Promise<void>;
      },
      "setupMarketDataSubscriptions",
    ).mockImplementation(async (instance) => {
      instance.subscriptions.add(pairSymbol);
    });
    vi.spyOn(
      manager as unknown as {
        cleanupMarketDataSubscriptions: () => Promise<void>;
      },
      "cleanupMarketDataSubscriptions",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      manager as unknown as {
        startStrategyExecution: () => Promise<void>;
      },
      "startStrategyExecution",
    ).mockResolvedValue(undefined);

    await manager.createAndStartStrategy("test-strategy", "instance-pnl", {});

    store.createSubmittedOrder({
      localId: "pending-order",
      strategyId: "instance-pnl",
      pair: {
        base: "0x1111111111111111111111111111111111111111",
        quote: "0x2222222222222222222222222222222222222222",
        symbol: pairSymbol,
      },
      order: {
        baseToken: "0x1111111111111111111111111111111111111111",
        quoteToken: "0x2222222222222222222222222222222222222222",
        isBuy: true,
        orderType: "market",
        price: 10000n,
        quantity: 100n,
        strategyId: "instance-pnl",
      },
    });
    store.applyUpdate({
      localId: "pending-order",
      type: "accepted",
      status: "pending",
    });

    let report = await manager.getPerformanceReport("instance-pnl");
    expect(report.performance.totalTrades).toBe(0);

    store.createSubmittedOrder({
      localId: "rejected-order",
      strategyId: "instance-pnl",
      pair: {
        base: "0x1111111111111111111111111111111111111111",
        quote: "0x2222222222222222222222222222222222222222",
        symbol: pairSymbol,
      },
      order: {
        baseToken: "0x1111111111111111111111111111111111111111",
        quoteToken: "0x2222222222222222222222222222222222222222",
        isBuy: true,
        orderType: "market",
        price: 10000n,
        quantity: 100n,
        strategyId: "instance-pnl",
      },
    });
    store.applyUpdate({
      localId: "rejected-order",
      type: "rejected",
      reason: "risk_rejected",
    });

    report = await manager.getPerformanceReport("instance-pnl");
    expect(report.performance.totalTrades).toBe(0);

    emitFilledOrder(store, "instance-pnl", "buy", 10000n);
    emitFilledOrder(store, "instance-pnl", "sell", 11000n);
    await vi.waitFor(async () => {
      const nextReport = await manager.getPerformanceReport("instance-pnl");
      expect(nextReport.performance.totalTrades).toBe(1);
    });

    report = await manager.getPerformanceReport("instance-pnl");
    expect(report.performance.totalTrades).toBe(1);
    expect(report.performance.winRate).toBe(1);
  });

  it("cleans subscribed market pairs before strategy cleanup", async () => {
    const registry = new StrategyRegistry();
    let subscriptionsDuringCleanup = -1;

    class CleanupAwareStrategy extends TestStrategy {
      override async cleanup(): Promise<void> {
        subscriptionsDuringCleanup =
          instanceRef?.subscriptions.size ?? subscriptionsDuringCleanup;
      }
    }

    await registry.registerStrategy(
      new CleanupAwareStrategy().config,
      { createStrategy: () => new CleanupAwareStrategy() },
      { tags: [] },
    );

    const manager = new StrategyManager(
      registry,
      {} as never,
      {} as never,
      {} as never,
      {
        subscribePrices: vi.fn().mockResolvedValue({
          subscribe: () => () => undefined,
          unsubscribe: () => undefined,
        }),
      } as never,
      {} as never,
    );
    let instanceRef: StrategyInstance | undefined;

    vi.spyOn(
      manager as unknown as {
        createStrategyContext: () => Promise<StrategyContext>;
      },
      "createStrategyContext",
    ).mockResolvedValue(createMockContext());
    vi.spyOn(
      manager as unknown as {
        startStrategyExecution: () => Promise<void>;
      },
      "startStrategyExecution",
    ).mockResolvedValue(undefined);

    await manager.createAndStartStrategy(
      "test-strategy",
      "instance-cleanup",
      {},
    );

    instanceRef = manager.getInstance("instance-cleanup");
    expect(instanceRef?.subscriptions.has("ETH/USDC")).toBe(true);

    await manager.stopStrategy("instance-cleanup");

    expect(subscriptionsDuringCleanup).toBe(0);
    expect(manager.getInstance("instance-cleanup")).toBeUndefined();
  });
});

describe("StrategyManager risk events", () => {
  it("strategy receives risk event", async () => {
    const registry = new StrategyRegistry();
    const onRiskEvent = vi.fn().mockResolvedValue(undefined);

    class RiskAwareStrategy extends TestStrategy {
      override onRiskEvent = onRiskEvent;
    }

    await registry.registerStrategy(
      new RiskAwareStrategy().config,
      { createStrategy: () => new RiskAwareStrategy() },
      { tags: [] },
    );

    const riskManager = new RiskManager(
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map([
            [
              "0x9999999999999999999999999999999999999999",
              {
                token: "0x9999999999999999999999999999999999999999",
                balance: 100n,
                value: 500000n,
                unrealizedPnL: 0n,
              },
            ],
          ]),
          totalValue: 100000000n,
          unrealizedPnL: 0n,
        }),
        getPosition: vi.fn().mockResolvedValue({
          token: "0x1111111111111111111111111111111111111111",
          balance: 100n,
          value: 1000000n,
          unrealizedPnL: 0n,
        }),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
          totalValue: 100000000n,
          totalPnL: 0n,
          openPositions: 1,
        }),
        getOpenOrders: vi.fn().mockResolvedValue([]),
      } as never,
      {
        getCandles: vi.fn().mockImplementation(async () =>
          Array.from({ length: 24 }, (_, index) => ({
            timestamp: 1_700_000_000_000 + index * 3_600_000,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100 + index * 2,
            volume: 1000,
          })),
        ),
        getCurrentPrice: vi.fn().mockResolvedValue(10000n),
      } as never,
      {
        cancelAllOrders: vi.fn(),
        getOrderStats: vi.fn().mockReturnValue({
          totalOrders: 0,
          openOrders: 0,
          filledOrders: 0,
          cancelledOrders: 0,
        }),
      } as never,
    );
    await riskManager.setRiskLimits({ maxCorrelation: 0.5 });

    const manager = new StrategyManager(
      registry,
      {
        getCurrentPrice: vi.fn().mockResolvedValue(10000n),
        getCandles: vi.fn().mockResolvedValue([]),
      } as never,
      {
        placeLimitOrder: vi.fn(),
        placeMarketOrder: vi.fn(),
      } as never,
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map(),
          totalValue: 100000n,
        }),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
        }),
        getPerformanceMetrics: vi.fn().mockResolvedValue({
          sharpeRatio: 0,
        }),
      } as never,
      {
        subscribePrices: vi.fn().mockResolvedValue({
          subscribe: () => () => undefined,
          unsubscribe: () => undefined,
        }),
        getOHLCVSnapshot: vi.fn().mockResolvedValue({
          T: 1_700_000_000_000,
          o: 100,
          h: 110,
          l: 95,
          c: 108,
          v: 12345,
        }),
        getOrderbookSnapshot: vi.fn().mockResolvedValue({
          bids: [{ price: "107.5", quantity: "2" }],
          asks: [{ price: "108.5", quantity: "3" }],
        }),
      } as never,
      riskManager,
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await manager.createAndStartStrategy("test-strategy", "risk-instance", {});
    const riskInstance = manager.getInstance("risk-instance");
    expect(riskInstance).toBeDefined();
    const signal: StrategySignal = {
      action: "buy",
      pair: "ETH/USDC",
      quantity: 1,
      confidence: 1,
      reason: "risk warning test",
    };
    const validation = await (
      manager as unknown as {
        validateStrategySignal: (signal: StrategySignal) => Promise<unknown>;
      }
    ).validateStrategySignal(signal);
    await (
      manager as unknown as {
        executeSignal: (
          instance: StrategyInstance,
          signal: StrategySignal,
          validation: unknown,
        ) => Promise<void>;
      }
    ).executeSignal(riskInstance as StrategyInstance, signal, validation);

    await vi.waitFor(() => {
      expect(onRiskEvent).toHaveBeenCalled();
    });
  });

  it("routes liquidation warning events to subscribed strategy instances", async () => {
    const registry = new StrategyRegistry();
    const onRiskEvent = vi.fn().mockResolvedValue(undefined);

    class RiskAwareStrategy extends TestStrategy {
      override onRiskEvent = onRiskEvent;
    }

    await registry.registerStrategy(
      new RiskAwareStrategy().config,
      { createStrategy: () => new RiskAwareStrategy() },
      { tags: [] },
    );

    const riskManager = new RiskManager(
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map(),
          totalValue: 100000n,
          unrealizedPnL: 0n,
        }),
        getPosition: vi.fn().mockResolvedValue(undefined),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
          totalValue: 100000n,
          totalPnL: 0n,
          openPositions: 0,
        }),
        getOpenOrders: vi.fn().mockResolvedValue([]),
      } as never,
      {
        getCurrentPrice: vi.fn().mockResolvedValue(10000n),
        getCandles: vi.fn().mockResolvedValue([]),
      } as never,
      {
        cancelAllOrders: vi.fn(),
        getOrderStats: vi.fn().mockReturnValue({
          totalOrders: 0,
          openOrders: 0,
          filledOrders: 0,
          cancelledOrders: 0,
        }),
      } as never,
    );

    const manager = new StrategyManager(
      registry,
      {
        getCurrentPrice: vi.fn().mockResolvedValue(10000n),
        getCandles: vi.fn().mockResolvedValue([]),
      } as never,
      {
        placeLimitOrder: vi.fn(),
        placeMarketOrder: vi.fn(),
      } as never,
      {
        getPortfolio: vi.fn().mockResolvedValue({
          positions: new Map(),
          totalValue: 100000n,
        }),
        getPositionSummary: vi.fn().mockResolvedValue({
          dailyPnL: 0n,
        }),
        getPerformanceMetrics: vi.fn().mockResolvedValue({
          sharpeRatio: 0,
        }),
      } as never,
      {
        subscribePrices: vi.fn().mockResolvedValue({
          subscribe: () => () => undefined,
          unsubscribe: () => undefined,
        }),
        getOHLCVSnapshot: vi.fn().mockResolvedValue({
          T: 1_700_000_000_000,
          o: 100,
          h: 110,
          l: 95,
          c: 108,
          v: 12345,
        }),
        getOrderbookSnapshot: vi.fn().mockResolvedValue({
          bids: [{ price: "107.5", quantity: "2" }],
          asks: [{ price: "108.5", quantity: "3" }],
        }),
      } as never,
      riskManager,
    );

    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await manager.createAndStartStrategy(
      "test-strategy",
      "liquidation-risk-instance",
      {},
    );

    riskManager.emit("riskEvent", {
      type: "liquidation_warning",
      severity: "warning",
      message: "Liquidation distance below warning threshold",
      data: {
        pair: "ETH/USDC",
      },
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      expect(onRiskEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "liquidation_warning",
          severity: "warning",
        }),
        expect.anything(),
      );
    });
  });
});
