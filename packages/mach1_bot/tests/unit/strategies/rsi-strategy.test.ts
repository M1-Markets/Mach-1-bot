import type { StrategyContext } from "@/domains/strategies/core/i-strategy";
import { RSIStrategy } from "@/domains/strategies/examples/example-strategies";

const createContext = (
  overrides: Partial<StrategyContext> = {},
): StrategyContext => ({
  portfolio: {
    totalValue: 10_000,
    dailyPnl: 0,
    dailyReturn: 0,
    sharpeRatio: 0,
    positions: {},
  },
  positions: new Map(),
  marketData: new Map(),
  parameters: {
    rsiPeriod: 5,
    oversoldThreshold: 30,
    overboughtThreshold: 70,
    positionSize: 0.1,
    stopLoss: 0.05,
  },
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
      getCurrentTimestamp: () => 0,
      formatTime: () => "",
      getMarketHours: () => ({ isOpen: true, nextOpen: 0, nextClose: 0 }),
    },
    trading: {
      getPositionQuantity: () => 0,
      getPendingQuantity: () => 0,
      getAvailableCapital: () => 10_000,
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
  ...overrides,
});

const tick = async (
  strategy: RSIStrategy,
  context: StrategyContext,
  price: number,
) => {
  context.marketData.set("ETH/USDC", { close: price } as never);
  return strategy.execute(context);
};

describe("RSIStrategy", () => {
  it("warms up configured market-data pairs and emits a sized entry", async () => {
    const strategy = new RSIStrategy();
    const context = createContext();
    context.utils.indicators.rsi = () => 20;
    context.utils.trading.getAvailableCapital = () => 400;
    await strategy.initialize(context);

    for (let index = 0; index < 4; index += 1) {
      expect((await tick(strategy, context, 100 - index)).signals).toEqual([]);
    }
    const result = await tick(strategy, context, 96);

    expect(result.signals).toEqual([
      expect.objectContaining({
        action: "buy",
        pair: "ETH/USDC",
        quantity: 400 / 96,
        orderType: "market",
      }),
    ]);
  });

  it("does not stack duplicate entries while oversold", async () => {
    const strategy = new RSIStrategy();
    const context = createContext();
    context.utils.indicators.rsi = () => 20;
    for (let index = 0; index < 5; index += 1) {
      await tick(strategy, context, 100);
    }

    expect((await tick(strategy, context, 99)).signals).toEqual([]);
  });

  it("closes the tracked or portfolio position when overbought", async () => {
    const strategy = new RSIStrategy();
    const context = createContext();
    let rsi = 20;
    context.utils.indicators.rsi = () => rsi;
    for (let index = 0; index < 5; index += 1) {
      await tick(strategy, context, 100);
    }
    context.utils.trading.fullCloseQuantity = () => 7;
    rsi = 80;

    expect((await tick(strategy, context, 105)).signals).toEqual([
      expect.objectContaining({ action: "sell", quantity: 7, price: 105 }),
    ]);
    context.utils.trading.getPendingQuantity = (_pair, side) =>
      side === "sell" ? 7 : 0;
    expect((await tick(strategy, context, 106)).signals).toEqual([]);
  });

  it("suppresses entries for existing positions and pending buys", async () => {
    for (const blocker of ["position", "pending"] as const) {
      const strategy = new RSIStrategy();
      const context = createContext();
      context.utils.indicators.rsi = () => 20;
      if (blocker === "position") {
        context.utils.trading.getPositionQuantity = () => 1;
      } else {
        context.utils.trading.getPendingQuantity = () => 1;
      }
      for (let index = 0; index < 5; index += 1) {
        await tick(strategy, context, 100);
      }
      expect((await tick(strategy, context, 99)).signals).toEqual([]);
    }
  });

  it("rejects invalid prices without poisoning warmup history", async () => {
    const strategy = new RSIStrategy();
    const context = createContext();

    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await tick(strategy, context, price);
      expect(result.signals).toEqual([]);
      expect(result.errors).toEqual(["Invalid market price for ETH/USDC"]);
    }
    expect((await tick(strategy, context, 100)).signals).toEqual([]);
  });

  it("reports indicator failures without terminating future execution", async () => {
    const strategy = new RSIStrategy();
    const context = createContext();
    context.utils.indicators.rsi = () => {
      throw new Error("indicator unavailable");
    };
    for (let index = 0; index < 4; index += 1) {
      await tick(strategy, context, 100);
    }

    const result = await tick(strategy, context, 100);
    expect(result.shouldContinue).toBe(true);
    expect(result.errors).toEqual([
      "Strategy execution failed: indicator unavailable",
    ]);
  });

  it("validates parameter types, ranges, and threshold ordering", async () => {
    const strategy = new RSIStrategy();

    expect(
      await strategy.validateParameters({
        rsiPeriod: 14,
        oversoldThreshold: 30,
        overboughtThreshold: 70,
        positionSize: 0.1,
      }),
    ).toEqual([]);
    expect(
      await strategy.validateParameters({
        rsiPeriod: 2,
        oversoldThreshold: 80,
        overboughtThreshold: 70,
        positionSize: 2,
      }),
    ).toEqual([
      "RSI period must be between 5 and 50",
      "Oversold threshold must be less than overbought threshold",
      "Position size must be between 0 and 1",
    ]);
  });
});
