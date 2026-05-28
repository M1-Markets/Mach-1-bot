import type { StrategyContext } from "@/domains/strategies/core/i-strategy";
import {
  MovingAverageCrossoverStrategy,
  MultiIndicatorStrategy,
  PairsTradingStrategy,
  RSIStrategy,
} from "@/domains/strategies/examples/example-strategies";

const createContext = (
  parameters: Record<string, unknown> = {},
): StrategyContext =>
  ({
    portfolio: {
      totalValue: 10_000,
      dailyPnl: 0,
      dailyReturn: 0,
      sharpeRatio: 0,
      positions: {},
    },
    positions: new Map(),
    marketData: new Map(),
    parameters,
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
        std: () => 1,
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
  }) as unknown as StrategyContext;

describe("example strategy exit sizing", () => {
  it("RSI strategy emits explicit sell quantity after an entry", () => {
    const strategy = new RSIStrategy();
    const context = createContext({
      positionSize: 0.1,
      oversoldThreshold: 30,
      overboughtThreshold: 70,
    });

    const buySignal = (
      strategy as unknown as {
        checkForSignals: (
          pair: string,
          rsi: number,
          currentPrice: number,
          context: StrategyContext,
        ) => { quantity?: number } | null;
      }
    ).checkForSignals("ETH/USDC", 20, 100, context);
    const sellSignal = (
      strategy as unknown as {
        checkForSignals: (
          pair: string,
          rsi: number,
          currentPrice: number,
          context: StrategyContext,
        ) => { action: string; quantity?: number } | null;
      }
    ).checkForSignals("ETH/USDC", 80, 100, context);

    expect(buySignal?.quantity).toBe(10);
    expect(sellSignal).toMatchObject({ action: "sell", quantity: 10 });
  });

  it("moving-average strategy emits explicit sell quantity after bullish entry", () => {
    const strategy = new MovingAverageCrossoverStrategy();
    const context = createContext({ positionSize: 0.2 });
    (
      strategy as unknown as {
        lastCrossover: Map<string, "bull" | "bear" | null>;
      }
    ).lastCrossover.set("ETH/USDC", "bear");

    const buySignal = (
      strategy as unknown as {
        checkCrossover: (
          pair: string,
          fastMA: number,
          slowMA: number,
          currentPrice: number,
          context: StrategyContext,
        ) => { quantity?: number } | null;
      }
    ).checkCrossover("ETH/USDC", 110, 100, 100, context);
    const sellSignal = (
      strategy as unknown as {
        checkCrossover: (
          pair: string,
          fastMA: number,
          slowMA: number,
          currentPrice: number,
          context: StrategyContext,
        ) => { action: string; quantity?: number } | null;
      }
    ).checkCrossover("ETH/USDC", 90, 100, 100, context);

    expect(buySignal?.quantity).toBe(20);
    expect(sellSignal).toMatchObject({ action: "sell", quantity: 20 });
  });

  it("multi-indicator strategy emits explicit sell quantity after bullish confluence entry", () => {
    const strategy = new MultiIndicatorStrategy();
    const context = createContext({ confluenceThreshold: 2 });
    const marketConditions = {
      allowed: true,
      trendBias: "neutral" as const,
      trendStrength: 0,
    };

    const buySignal = (
      strategy as unknown as {
        checkConfluence: (
          pair: string,
          state: {
            rsiSignal: "buy" | "sell" | "neutral";
            macdSignal: "buy" | "sell" | "neutral";
            bbSignal: "buy" | "sell" | "neutral";
          },
          currentPrice: number,
          context: StrategyContext,
          marketConditions: {
            allowed: boolean;
            trendBias: "bull" | "bear" | "neutral";
            trendStrength: number;
          },
        ) => { quantity?: number } | null;
      }
    ).checkConfluence(
      "ETH/USDC",
      {
        rsiSignal: "buy",
        macdSignal: "buy",
        bbSignal: "neutral",
      },
      100,
      context,
      marketConditions,
    );
    context.utils.trading.fullCloseQuantity = () => 15;
    const sellSignal = (
      strategy as unknown as {
        checkConfluence: (
          pair: string,
          state: {
            rsiSignal: "buy" | "sell" | "neutral";
            macdSignal: "buy" | "sell" | "neutral";
            bbSignal: "buy" | "sell" | "neutral";
          },
          currentPrice: number,
          context: StrategyContext,
          marketConditions: {
            allowed: boolean;
            trendBias: "bull" | "bear" | "neutral";
            trendStrength: number;
          },
        ) => { action: string; quantity?: number } | null;
      }
    ).checkConfluence(
      "ETH/USDC",
      {
        rsiSignal: "sell",
        macdSignal: "sell",
        bbSignal: "neutral",
      },
      100,
      context,
      marketConditions,
    );

    expect(buySignal?.quantity).toBe(15);
    expect(sellSignal).toMatchObject({ action: "sell", quantity: 15 });
  });

  it("multi-indicator strategy skips bullish confluence against a strong bearish regime", () => {
    const strategy = new MultiIndicatorStrategy();
    const context = createContext({ confluenceThreshold: 2 });

    const signal = (
      strategy as unknown as {
        checkConfluence: (
          pair: string,
          state: {
            rsiSignal: "buy" | "sell" | "neutral";
            macdSignal: "buy" | "sell" | "neutral";
            bbSignal: "buy" | "sell" | "neutral";
          },
          currentPrice: number,
          context: StrategyContext,
          marketConditions: {
            allowed: boolean;
            trendBias: "bull" | "bear" | "neutral";
            trendStrength: number;
          },
        ) => { quantity?: number } | null;
      }
    ).checkConfluence(
      "ETH/USDC",
      {
        rsiSignal: "buy",
        macdSignal: "buy",
        bbSignal: "neutral",
      },
      100,
      context,
      {
        allowed: true,
        trendBias: "bear",
        trendStrength: 0.08,
      },
    );

    expect(signal).toBeNull();
  });

  it("multi-indicator strategy skips low-liquidity markets during execution", async () => {
    const strategy = new MultiIndicatorStrategy();
    const context = createContext();
    context.marketData.set("ETH/USDC", {
      "ETH/USDC": {
        close: 100,
        spread: 0.1,
        orderBookDepth: { bids: 1, asks: 1 },
      },
    } as never);
    context.utils.indicators.rsi = () => 20;
    context.utils.indicators.macd = () => ({
      macd: 2,
      signal: 1,
      histogram: 1,
    });
    context.utils.indicators.bollingerBands = () => ({
      upper: 120,
      middle: 110,
      lower: 105,
    });
    context.utils.indicators.ema = (_prices, period) =>
      period <= 10 ? 101 : 100;
    context.utils.math.std = () => 0.01;
    (
      strategy as unknown as {
        marketState: Map<
          string,
          {
            prices: number[];
            rsiSignal: "buy" | "sell" | "neutral";
            macdSignal: "buy" | "sell" | "neutral";
            bbSignal: "buy" | "sell" | "neutral";
          }
        >;
      }
    ).marketState.set("ETH/USDC", {
      prices: Array.from({ length: 40 }, (_, index) => 100 + index * 0.05),
      rsiSignal: "neutral",
      macdSignal: "neutral",
      bbSignal: "neutral",
    });

    const result = await strategy.execute(context);

    expect(result.signals).toEqual([]);
  });

  it("multi-indicator strategy skips high-volatility markets during execution", async () => {
    const strategy = new MultiIndicatorStrategy();
    const context = createContext();
    context.marketData.set("ETH/USDC", {
      "ETH/USDC": {
        close: 100,
        spread: 0.1,
        orderBookDepth: { bids: 5, asks: 5 },
      },
    } as never);
    context.utils.indicators.rsi = () => 20;
    context.utils.indicators.macd = () => ({
      macd: 2,
      signal: 1,
      histogram: 1,
    });
    context.utils.indicators.bollingerBands = () => ({
      upper: 120,
      middle: 110,
      lower: 105,
    });
    context.utils.indicators.ema = (_prices, period) =>
      period <= 10 ? 101 : 100;
    context.utils.math.std = () => 0.09;
    (
      strategy as unknown as {
        marketState: Map<
          string,
          {
            prices: number[];
            rsiSignal: "buy" | "sell" | "neutral";
            macdSignal: "buy" | "sell" | "neutral";
            bbSignal: "buy" | "sell" | "neutral";
          }
        >;
      }
    ).marketState.set("ETH/USDC", {
      prices: Array.from(
        { length: 40 },
        (_, index) => 100 + index * (index % 2 === 0 ? 1 : -1),
      ),
      rsiSignal: "neutral",
      macdSignal: "neutral",
      bbSignal: "neutral",
    });

    const result = await strategy.execute(context);

    expect(result.signals).toEqual([]);
  });

  it("pairs strategy emits explicit quantities for both exit legs", () => {
    const strategy = new PairsTradingStrategy();
    const context = createContext({
      positionSize: 0.3,
      entryThreshold: 2,
      exitThreshold: 0.5,
    });

    const entrySignals = (
      strategy as unknown as {
        generatePairSignals: (
          zScore: number,
          btcPrice: number,
          ethPrice: number,
          context: StrategyContext,
        ) => Array<{ quantity?: number }>;
      }
    ).generatePairSignals(2.5, 50_000, 2_500, context);
    const exitSignals = (
      strategy as unknown as {
        generatePairSignals: (
          zScore: number,
          btcPrice: number,
          ethPrice: number,
          context: StrategyContext,
        ) => Array<{ action: string; quantity?: number }>;
      }
    ).generatePairSignals(0.1, 50_000, 2_500, context);

    expect(entrySignals).toHaveLength(2);
    expect(exitSignals).toHaveLength(2);
    expect(exitSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quantity: expect.any(Number) }),
      ]),
    );
    expect(exitSignals.every((signal) => (signal.quantity ?? 0) > 0)).toBe(
      true,
    );
  });
});
