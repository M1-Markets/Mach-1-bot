/**
 * Example Strategy Implementations
 *
 * Comprehensive examples showing how users can extend the Mach-One SDK
 * with custom strategies using the pluggable interface.
 */

import {
  IStrategy,
  IStrategyFactory,
  MarketEvent,
  RiskEvent,
  StrategyConfig,
  StrategyContext,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
} from "@/domains/strategies/core/i-strategy";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const getNumberParam = (value: unknown, fallback: number): number =>
  isNumber(value) ? value : fallback;

type MultiIndicatorMarketConditions = {
  allowed: boolean;
  trendBias: "bull" | "bear" | "neutral";
  trendStrength: number;
};

// =============================================================================
// Example 1: Simple RSI Strategy
// =============================================================================

export class RSIStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "rsi_strategy_v1",
    name: "RSI Mean Reversion Strategy",
    description:
      "Buys when RSI is oversold (< 30) and sells when overbought (> 70)",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["*"],
    category: "mean_reversion",
    riskLevel: 4,
    minCapital: 1000,
    parametersSchema: {
      rsiPeriod: {
        type: "number",
        default: 14,
        min: 5,
        max: 50,
        description: "RSI calculation period",
      },
      oversoldThreshold: {
        type: "number",
        default: 30,
        min: 10,
        max: 40,
        description: "RSI oversold threshold for buy signals",
      },
      overboughtThreshold: {
        type: "number",
        default: 70,
        min: 60,
        max: 90,
        description: "RSI overbought threshold for sell signals",
      },
      positionSize: {
        type: "number",
        default: 0.1,
        min: 0.01,
        max: 1.0,
        description: "Position size as fraction of portfolio",
      },
      stopLoss: {
        type: "number",
        default: 0.05,
        min: 0.01,
        max: 0.2,
        description: "Stop loss percentage",
      },
    },
  };

  private priceHistory: Map<string, number[]> = new Map();
  private openQuantities: Map<string, number> = new Map();

  async initialize(context: StrategyContext): Promise<void> {
    context.utils.log.info("RSI Strategy initialized", {
      parameters: context.parameters,
      supportedPairs: this.config.supportedPairs,
    });

    // Initialize price history for each pair
    for (const pair of this.config.supportedPairs) {
      this.priceHistory.set(pair, []);
    }
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const signals: StrategySignal[] = [];
    const errors: string[] = [];

    try {
      // Process each supported pair
      for (const pair of this.config.supportedPairs) {
        const marketData = context.marketData.get(pair);
        if (!marketData) {
          errors.push(`No market data available for ${pair}`);
          continue;
        }

        // Update price history
        const prices = this.priceHistory.get(pair) || [];

        // marketData is the market data object for this pair
        let currentPrice = 0;
        if (typeof marketData === "object" && marketData !== null) {
          const marketDataRecord = marketData as Record<string, unknown>;
          // Check if marketData has a close price directly
          if (
            "close" in marketDataRecord &&
            typeof marketDataRecord.close === "number"
          ) {
            currentPrice = marketDataRecord.close;
          }
          // Or if it's nested under the pair name
          else if (pair in marketDataRecord) {
            const pairData = marketDataRecord[pair];
            if (typeof pairData === "object" && pairData !== null) {
              const pairRecord = pairData as { close?: number };
              currentPrice = pairRecord.close ?? 0;
            }
          }
        }

        if (currentPrice > 0) {
          prices.push(currentPrice);

          // Keep only last 100 prices
          if (prices.length > 100) {
            prices.shift();
          }

          this.priceHistory.set(pair, prices);
        }

        // Calculate RSI if we have enough data
        const rsiPeriod = getNumberParam(context.parameters.rsiPeriod, 14);
        if (prices.length >= rsiPeriod) {
          const rsi = context.utils.indicators.rsi(prices, rsiPeriod);

          // Check for signals
          const signal = this.checkForSignals(pair, rsi, currentPrice, context);
          if (signal) {
            signals.push(signal);
          }
        }
      }

      return {
        signals,
        shouldContinue: true,
        nextExecutionTime: Date.now() + 30000, // Execute every 30 seconds
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        signals: [],
        shouldContinue: true,
        errors: [
          `Strategy execution failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];

    const rsiPeriod = getNumberParam(parameters.rsiPeriod, 14);
    if (!isNumber(parameters.rsiPeriod)) {
      errors.push("RSI period must be a number");
    }
    if (rsiPeriod < 5 || rsiPeriod > 50) {
      errors.push("RSI period must be between 5 and 50");
    }

    const oversoldThreshold = getNumberParam(parameters.oversoldThreshold, 30);
    const overboughtThreshold = getNumberParam(
      parameters.overboughtThreshold,
      70,
    );
    if (
      !isNumber(parameters.oversoldThreshold) ||
      !isNumber(parameters.overboughtThreshold)
    ) {
      errors.push("RSI thresholds must be numbers");
    }
    if (oversoldThreshold >= overboughtThreshold) {
      errors.push("Oversold threshold must be less than overbought threshold");
    }

    const positionSize = getNumberParam(parameters.positionSize, 0.1);
    if (!isNumber(parameters.positionSize)) {
      errors.push("Position size must be a number");
    }
    if (positionSize <= 0 || positionSize > 1) {
      errors.push("Position size must be between 0 and 1");
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    context.utils.log.info("RSI Strategy parameters updated", parameters);
  }

  async cleanup(context: StrategyContext): Promise<void> {
    this.priceHistory.clear();
    this.openQuantities.clear();
    context.utils.log.info("RSI Strategy cleaned up");
  }

  private checkForSignals(
    pair: string,
    rsi: number,
    currentPrice: number,
    context: StrategyContext,
  ): StrategySignal | null {
    const portfolioValue = context.portfolio.totalValue;
    const positionSize =
      portfolioValue * getNumberParam(context.parameters.positionSize, 0.1);
    const oversoldThreshold = getNumberParam(
      context.parameters.oversoldThreshold,
      30,
    );
    const overboughtThreshold = getNumberParam(
      context.parameters.overboughtThreshold,
      70,
    );

    // Buy signal: RSI oversold
    if (rsi < oversoldThreshold) {
      const quantity = positionSize / currentPrice;
      this.openQuantities.set(pair, quantity);
      return {
        action: "buy",
        pair,
        quantity,
        price: currentPrice,
        orderType: "market",
        confidence: Math.max(0, (oversoldThreshold - rsi) / oversoldThreshold),
        reason: `RSI oversold: ${rsi.toFixed(2)} < ${oversoldThreshold}`,
        metadata: { rsi, currentPrice },
      };
    }

    // Sell signal: RSI overbought
    if (rsi > overboughtThreshold) {
      const quantity = this.openQuantities.get(pair);
      if (!(quantity && quantity > 0)) {
        return null;
      }
      this.openQuantities.delete(pair);
      return {
        action: "sell",
        pair,
        quantity,
        orderType: "market",
        confidence: Math.max(
          0,
          (rsi - overboughtThreshold) / (100 - overboughtThreshold),
        ),
        reason: `RSI overbought: ${rsi.toFixed(2)} > ${overboughtThreshold}`,
        metadata: { rsi, currentPrice },
      };
    }

    return null;
  }
}

export class RSIStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new RSIStrategy();
  }
}

// =============================================================================
// Example 2: Moving Average Crossover Strategy
// =============================================================================

export class MovingAverageCrossoverStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "ma_crossover_v1",
    name: "Moving Average Crossover Strategy",
    description: "Trades based on fast and slow moving average crossovers",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["BTC/USDC", "ETH/USDC"],
    category: "momentum",
    riskLevel: 5,
    minCapital: 2000,
    parametersSchema: {
      fastPeriod: {
        type: "number",
        default: 10,
        min: 5,
        max: 50,
        description: "Fast moving average period",
      },
      slowPeriod: {
        type: "number",
        default: 30,
        min: 20,
        max: 200,
        description: "Slow moving average period",
      },
      maType: {
        type: "select",
        default: "sma",
        options: ["sma", "ema"],
        description: "Moving average type",
      },
      positionSize: {
        type: "number",
        default: 0.2,
        min: 0.05,
        max: 0.5,
        description: "Position size as fraction of portfolio",
      },
    },
  };

  private priceHistory: Map<string, number[]> = new Map();
  private lastCrossover: Map<string, "bull" | "bear" | null> = new Map();
  private openQuantities: Map<string, number> = new Map();

  async initialize(context: StrategyContext): Promise<void> {
    for (const pair of this.config.supportedPairs) {
      this.priceHistory.set(pair, []);
      this.lastCrossover.set(pair, null);
    }

    context.utils.log.info("MA Crossover Strategy initialized");
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const signals: StrategySignal[] = [];

    for (const pair of this.config.supportedPairs) {
      const marketData = context.marketData.get(pair);
      if (!marketData) continue;

      const prices = this.priceHistory.get(pair) || [];
      const currentPrice = marketData[pair]?.close || 0;
      const fastPeriod = getNumberParam(context.parameters.fastPeriod, 10);
      const slowPeriod = getNumberParam(context.parameters.slowPeriod, 30);
      const maType = context.parameters.maType === "ema" ? "ema" : "sma";

      if (currentPrice > 0) {
        prices.push(currentPrice);
        if (prices.length > Math.max(slowPeriod * 2, 200)) {
          prices.shift();
        }
        this.priceHistory.set(pair, prices);
      }

      // Calculate moving averages
      if (prices.length >= slowPeriod) {
        const fastMA =
          maType === "ema"
            ? context.utils.indicators.ema(prices, fastPeriod)
            : context.utils.indicators.sma(prices, fastPeriod);

        const slowMA =
          maType === "ema"
            ? context.utils.indicators.ema(prices, slowPeriod)
            : context.utils.indicators.sma(prices, slowPeriod);

        // Check for crossover
        const signal = this.checkCrossover(
          pair,
          fastMA,
          slowMA,
          currentPrice,
          context,
        );
        if (signal) {
          signals.push(signal);
        }
      }
    }

    return {
      signals,
      shouldContinue: true,
      nextExecutionTime: Date.now() + 60000, // Execute every minute
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];

    const fastPeriod = getNumberParam(parameters.fastPeriod, 10);
    const slowPeriod = getNumberParam(parameters.slowPeriod, 30);
    if (!isNumber(parameters.fastPeriod) || !isNumber(parameters.slowPeriod)) {
      errors.push("Moving average periods must be numbers");
    }
    if (fastPeriod >= slowPeriod) {
      errors.push("Fast period must be less than slow period");
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    // Reset crossover tracking when parameters change
    for (const pair of this.config.supportedPairs) {
      this.lastCrossover.set(pair, null);
    }
  }

  async cleanup(context: StrategyContext): Promise<void> {
    this.priceHistory.clear();
    this.lastCrossover.clear();
    this.openQuantities.clear();
  }

  private checkCrossover(
    pair: string,
    fastMA: number,
    slowMA: number,
    currentPrice: number,
    context: StrategyContext,
  ): StrategySignal | null {
    const currentCrossover = fastMA > slowMA ? "bull" : "bear";
    const lastCrossover = this.lastCrossover.get(pair);

    if (currentCrossover !== lastCrossover) {
      this.lastCrossover.set(pair, currentCrossover);

      const portfolioValue = context.portfolio.totalValue;
      const positionSize =
        portfolioValue * getNumberParam(context.parameters.positionSize, 0.2);

      if (currentCrossover === "bull" && lastCrossover === "bear") {
        // Bullish crossover - buy signal
        const quantity = positionSize / currentPrice;
        this.openQuantities.set(pair, quantity);
        return {
          action: "buy",
          pair,
          quantity,
          orderType: "market",
          confidence: Math.abs(fastMA - slowMA) / slowMA,
          reason: `Bullish crossover: Fast MA (${fastMA.toFixed(2)}) > Slow MA (${slowMA.toFixed(2)})`,
          metadata: { fastMA, slowMA, crossover: "bull" },
        };
      } else if (currentCrossover === "bear" && lastCrossover === "bull") {
        // Bearish crossover - sell signal
        const quantity = this.openQuantities.get(pair);
        if (!(quantity && quantity > 0)) {
          return null;
        }
        this.openQuantities.delete(pair);
        return {
          action: "sell",
          pair,
          quantity,
          orderType: "market",
          confidence: Math.abs(fastMA - slowMA) / slowMA,
          reason: `Bearish crossover: Fast MA (${fastMA.toFixed(2)}) < Slow MA (${slowMA.toFixed(2)})`,
          metadata: { fastMA, slowMA, crossover: "bear" },
        };
      }
    }

    return null;
  }
}

export class MovingAverageCrossoverStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new MovingAverageCrossoverStrategy();
  }
}

// =============================================================================
// Example 3: Advanced Multi-Indicator Strategy
// =============================================================================

export class MultiIndicatorStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "multi_indicator_v1",
    name: "Multi-Indicator Confluence Strategy",
    description:
      "Combines RSI, MACD, and Bollinger Bands for confluence trading",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["BTC/USDC", "ETH/USDC", "SOL/USDC"],
    category: "custom",
    riskLevel: 6,
    minCapital: 5000,
    parametersSchema: {
      rsiPeriod: {
        type: "number",
        default: 14,
        min: 10,
        max: 30,
        description: "RSI period",
      },
      macdFast: {
        type: "number",
        default: 12,
        min: 8,
        max: 20,
        description: "MACD fast period",
      },
      macdSlow: {
        type: "number",
        default: 26,
        min: 20,
        max: 40,
        description: "MACD slow period",
      },
      macdSignal: {
        type: "number",
        default: 9,
        min: 5,
        max: 15,
        description: "MACD signal period",
      },
      bbPeriod: {
        type: "number",
        default: 20,
        min: 15,
        max: 30,
        description: "Bollinger Bands period",
      },
      bbStdDev: {
        type: "number",
        default: 2,
        min: 1.5,
        max: 3,
        description: "Bollinger Bands standard deviation",
      },
      confluenceThreshold: {
        type: "number",
        default: 2,
        min: 2,
        max: 3,
        description: "Minimum number of indicators for confluence",
      },
      trendStrengthThreshold: {
        type: "number",
        default: 0.03,
        min: 0.005,
        max: 0.2,
        description:
          "Skip mean-reversion entries against strong directional regimes",
      },
      maxSpreadRatio: {
        type: "number",
        default: 0.005,
        min: 0.0001,
        max: 0.05,
        description: "Maximum acceptable bid/ask spread ratio before skipping",
      },
      minLiquidityDepth: {
        type: "number",
        default: 3,
        min: 1,
        max: 20,
        description: "Minimum order-book depth count required on both sides",
      },
      maxVolatilityRatio: {
        type: "number",
        default: 0.04,
        min: 0.005,
        max: 0.25,
        description: "Maximum recent return volatility ratio before skipping",
      },
      warmupBuffer: {
        type: "number",
        default: 10,
        min: 5,
        max: 50,
        description:
          "Additional candles required beyond indicator minimum for stable warmup",
      },
    },
  };

  private marketState: Map<
    string,
    {
      prices: number[];
      rsiSignal: "buy" | "sell" | "neutral";
      macdSignal: "buy" | "sell" | "neutral";
      bbSignal: "buy" | "sell" | "neutral";
    }
  > = new Map();
  private openQuantities: Map<string, number> = new Map();

  async initialize(context: StrategyContext): Promise<void> {
    for (const pair of this.config.supportedPairs) {
      this.marketState.set(pair, {
        prices: [],
        rsiSignal: "neutral",
        macdSignal: "neutral",
        bbSignal: "neutral",
      });
    }

    context.utils.log.info("Multi-Indicator Strategy initialized");
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const signals: StrategySignal[] = [];

    // Iterate over all available market data, not just hardcoded supported pairs
    for (const [pair, marketData] of context.marketData.entries()) {
      if (!marketData) continue;

      // Initialize market state for this pair if it doesn't exist
      if (!this.marketState.has(pair)) {
        this.marketState.set(pair, {
          prices: [],
          rsiSignal: "neutral",
          macdSignal: "neutral",
          bbSignal: "neutral",
        });
      }

      const state = this.marketState.get(pair);
      if (!state) {
        continue;
      }
      const currentPrice = marketData[pair]?.close || 0;
      const rsiPeriod = getNumberParam(context.parameters.rsiPeriod, 14);
      const macdSlow = getNumberParam(context.parameters.macdSlow, 26);
      const bbPeriod = getNumberParam(context.parameters.bbPeriod, 20);
      const warmupBuffer = getNumberParam(context.parameters.warmupBuffer, 10);

      if (currentPrice > 0) {
        state.prices.push(currentPrice);
        if (state.prices.length > 200) {
          state.prices.shift();
        }
      }

      // Calculate indicators
      const minRequiredPrices = Math.max(rsiPeriod, macdSlow, bbPeriod);

      if (state.prices.length >= minRequiredPrices + warmupBuffer) {
        this.updateIndicatorSignals(state, context);

        const marketConditions = this.evaluateMarketConditions(
          state,
          marketData[pair],
          currentPrice,
          context,
        );
        if (!marketConditions.allowed) {
          continue;
        }

        // Check for confluence
        const signal = this.checkConfluence(
          pair,
          state,
          currentPrice,
          context,
          marketConditions,
        );
        if (signal) {
          signals.push(signal);
        }
      }
    }

    return {
      signals,
      shouldContinue: true,
      nextExecutionTime: Date.now() + 45000, // Execute every 45 seconds
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];

    const macdFast = getNumberParam(parameters.macdFast, 12);
    const macdSlow = getNumberParam(parameters.macdSlow, 26);
    if (!isNumber(parameters.macdFast) || !isNumber(parameters.macdSlow)) {
      errors.push("MACD fast/slow periods must be numbers");
    }
    if (macdFast >= macdSlow) {
      errors.push("MACD fast period must be less than slow period");
    }

    const confluenceThreshold = getNumberParam(
      parameters.confluenceThreshold,
      2,
    );
    if (!isNumber(parameters.confluenceThreshold)) {
      errors.push("Confluence threshold must be a number");
    }
    if (confluenceThreshold > 3) {
      errors.push(
        "Confluence threshold cannot exceed 3 (total number of indicators)",
      );
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    // Reset all signals when parameters change
    for (const [_pair, state] of this.marketState.entries()) {
      state.rsiSignal = "neutral";
      state.macdSignal = "neutral";
      state.bbSignal = "neutral";
    }
  }

  async cleanup(context: StrategyContext): Promise<void> {
    this.marketState.clear();
    this.openQuantities.clear();
  }

  async onMarketEvent(
    event: MarketEvent,
    context: StrategyContext,
  ): Promise<void> {
    if (event.type === "volume_spike") {
      context.utils.log.info(
        `Volume spike detected for ${event.pair}`,
        event.data,
      );
    }
  }

  async onRiskEvent(event: RiskEvent, context: StrategyContext): Promise<void> {
    if (event.severity === "critical") {
      context.utils.log.warn(
        "Critical risk event - strategy may reduce positions",
        event,
      );
    }
  }

  private updateIndicatorSignals(
    state: {
      prices: number[];
      rsiSignal: "buy" | "sell" | "neutral";
      macdSignal: "buy" | "sell" | "neutral";
      bbSignal: "buy" | "sell" | "neutral";
    },
    context: StrategyContext,
  ): void {
    const prices = state.prices;
    const rsiPeriod = getNumberParam(context.parameters.rsiPeriod, 14);
    const macdFast = getNumberParam(context.parameters.macdFast, 12);
    const macdSlow = getNumberParam(context.parameters.macdSlow, 26);
    const macdSignal = getNumberParam(context.parameters.macdSignal, 9);
    const bbPeriod = getNumberParam(context.parameters.bbPeriod, 20);
    const bbStdDev = getNumberParam(context.parameters.bbStdDev, 2);

    // RSI Signal
    const rsi = context.utils.indicators.rsi(prices, rsiPeriod);
    if (rsi < 30) {
      state.rsiSignal = "buy";
    } else if (rsi > 70) {
      state.rsiSignal = "sell";
    } else {
      state.rsiSignal = "neutral";
    }

    // MACD Signal
    const macd = context.utils.indicators.macd(
      prices,
      macdFast,
      macdSlow,
      macdSignal,
    );
    if (macd.macd > macd.signal && macd.histogram > 0) {
      state.macdSignal = "buy";
    } else if (macd.macd < macd.signal && macd.histogram < 0) {
      state.macdSignal = "sell";
    } else {
      state.macdSignal = "neutral";
    }

    // Bollinger Bands Signal
    const bb = context.utils.indicators.bollingerBands(
      prices,
      bbPeriod,
      bbStdDev,
    );
    const currentPrice = prices[prices.length - 1];
    if (currentPrice < bb.lower) {
      state.bbSignal = "buy";
    } else if (currentPrice > bb.upper) {
      state.bbSignal = "sell";
    } else {
      state.bbSignal = "neutral";
    }
  }

  private checkConfluence(
    pair: string,
    state: {
      rsiSignal: "buy" | "sell" | "neutral";
      macdSignal: "buy" | "sell" | "neutral";
      bbSignal: "buy" | "sell" | "neutral";
    },
    currentPrice: number,
    context: StrategyContext,
    marketConditions: MultiIndicatorMarketConditions,
  ): StrategySignal | null {
    const buySignals = [
      state.rsiSignal,
      state.macdSignal,
      state.bbSignal,
    ].filter((s) => s === "buy").length;
    const sellSignals = [
      state.rsiSignal,
      state.macdSignal,
      state.bbSignal,
    ].filter((s) => s === "sell").length;

    const threshold = getNumberParam(context.parameters.confluenceThreshold, 2);
    const trendStrengthThreshold = getNumberParam(
      context.parameters.trendStrengthThreshold,
      0.03,
    );

    if (buySignals >= threshold) {
      if (
        marketConditions.trendBias === "bear" &&
        marketConditions.trendStrength >= trendStrengthThreshold
      ) {
        return null;
      }
      const availableCapital = context.utils.trading.getAvailableCapital();
      const notional = Math.min(
        availableCapital,
        context.portfolio.totalValue * 0.15,
      );
      const quantity = notional / currentPrice;
      if (!(quantity > 0)) {
        return null;
      }
      this.openQuantities.set(pair, quantity);
      return {
        action: "buy",
        pair,
        quantity, // 15% of portfolio
        orderType: "market",
        confidence: buySignals / 3,
        reason: `Buy confluence: ${buySignals}/3 indicators bullish`,
        metadata: {
          rsiSignal: state.rsiSignal,
          macdSignal: state.macdSignal,
          bbSignal: state.bbSignal,
          confluence: buySignals,
        },
      };
    }

    if (sellSignals >= threshold) {
      if (
        marketConditions.trendBias === "bull" &&
        marketConditions.trendStrength >= trendStrengthThreshold
      ) {
        return null;
      }
      const quantity =
        context.utils.trading.fullCloseQuantity(pair) ||
        this.openQuantities.get(pair);
      if (!(quantity && quantity > 0)) {
        return null;
      }
      this.openQuantities.delete(pair);
      return {
        action: "sell",
        pair,
        quantity,
        orderType: "market",
        confidence: sellSignals / 3,
        reason: `Sell confluence: ${sellSignals}/3 indicators bearish`,
        metadata: {
          rsiSignal: state.rsiSignal,
          macdSignal: state.macdSignal,
          bbSignal: state.bbSignal,
          confluence: sellSignals,
        },
      };
    }

    return null;
  }

  private evaluateMarketConditions(
    state: {
      prices: number[];
      rsiSignal: "buy" | "sell" | "neutral";
      macdSignal: "buy" | "sell" | "neutral";
      bbSignal: "buy" | "sell" | "neutral";
    },
    marketTick:
      | {
          spread?: number;
          orderBookDepth?: { bids: number; asks: number };
        }
      | undefined,
    currentPrice: number,
    context: StrategyContext,
  ): MultiIndicatorMarketConditions {
    const maxSpreadRatio = getNumberParam(
      context.parameters.maxSpreadRatio,
      0.005,
    );
    const minLiquidityDepth = getNumberParam(
      context.parameters.minLiquidityDepth,
      3,
    );
    const maxVolatilityRatio = getNumberParam(
      context.parameters.maxVolatilityRatio,
      0.04,
    );

    if (currentPrice <= 0 || state.prices.length < 30) {
      return {
        allowed: false,
        trendBias: "neutral",
        trendStrength: 0,
      };
    }

    const recentPrices = state.prices.slice(-20);
    const returns = recentPrices.slice(1).map((price, index) => {
      const previous = recentPrices[index];
      return previous > 0 ? (price - previous) / previous : 0;
    });
    const volatility = returns.length > 0 ? context.utils.math.std(returns) : 0;
    const spreadRatio =
      marketTick?.spread && currentPrice > 0
        ? marketTick.spread / currentPrice
        : 0;
    const liquidityDepth = Math.min(
      marketTick?.orderBookDepth?.bids ?? 0,
      marketTick?.orderBookDepth?.asks ?? 0,
    );

    const fastTrend = context.utils.indicators.ema(state.prices, 10);
    const slowTrend = context.utils.indicators.ema(state.prices, 30);
    const trendStrength =
      slowTrend > 0 ? Math.abs(fastTrend - slowTrend) / slowTrend : 0;
    const trendBias =
      trendStrength === 0 ? "neutral" : fastTrend > slowTrend ? "bull" : "bear";

    return {
      allowed:
        returns.length >= 10 &&
        volatility > 0 &&
        spreadRatio <= maxSpreadRatio &&
        liquidityDepth >= minLiquidityDepth &&
        volatility <= maxVolatilityRatio,
      trendBias,
      trendStrength,
    };
  }
}

export class MultiIndicatorStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new MultiIndicatorStrategy();
  }
}

// =============================================================================
// Example 4: Pairs Trading Strategy
// =============================================================================

export class PairsTradingStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "pairs_trading_v1",
    name: "Statistical Arbitrage Pairs Trading",
    description:
      "Trades pairs of correlated assets based on price ratio mean reversion",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["BTC/USDC", "ETH/USDC"], // Trades the ratio between these pairs
    category: "arbitrage",
    riskLevel: 7,
    minCapital: 10000,
    parametersSchema: {
      lookbackPeriod: {
        type: "number",
        default: 50,
        min: 20,
        max: 200,
        description: "Lookback period for ratio calculation",
      },
      entryThreshold: {
        type: "number",
        default: 2.0,
        min: 1.0,
        max: 3.0,
        description: "Z-score threshold for entry",
      },
      exitThreshold: {
        type: "number",
        default: 0.5,
        min: 0.1,
        max: 1.0,
        description: "Z-score threshold for exit",
      },
      positionSize: {
        type: "number",
        default: 0.3,
        min: 0.1,
        max: 0.5,
        description: "Position size as fraction of portfolio",
      },
    },
  };

  private ratioHistory: number[] = [];
  private currentPosition:
    | "long_btc_short_eth"
    | "long_eth_short_btc"
    | "neutral" = "neutral";
  private legQuantities: Map<string, number> = new Map();

  async initialize(context: StrategyContext): Promise<void> {
    this.ratioHistory = [];
    this.currentPosition = "neutral";
    this.legQuantities.clear();
    context.utils.log.info("Pairs Trading Strategy initialized");
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const btcData = context.marketData.get("BTC/USDC");
    const ethData = context.marketData.get("ETH/USDC");

    if (!btcData || !ethData) {
      return {
        signals: [],
        shouldContinue: true,
        errors: ["Missing market data for BTC/USDC or ETH/USDC"],
      };
    }

    const btcPrice = btcData["BTC/USDC"]?.close || 0;
    const ethPrice = ethData["ETH/USDC"]?.close || 0;

    if (btcPrice === 0 || ethPrice === 0) {
      return {
        signals: [],
        shouldContinue: true,
        errors: ["Invalid price data"],
      };
    }

    // Calculate price ratio
    const ratio = btcPrice / ethPrice;
    this.ratioHistory.push(ratio);
    const lookbackPeriod = getNumberParam(
      context.parameters.lookbackPeriod,
      50,
    );

    // Keep only recent history
    if (this.ratioHistory.length > lookbackPeriod * 2) {
      this.ratioHistory.shift();
    }

    const signals: StrategySignal[] = [];

    // Calculate z-score if we have enough data
    if (this.ratioHistory.length >= lookbackPeriod) {
      const recentRatios = this.ratioHistory.slice(-lookbackPeriod);
      const mean = context.utils.math.mean(recentRatios);
      const std = context.utils.math.std(recentRatios);

      if (std > 0) {
        const zScore = (ratio - mean) / std;

        // Generate trading signals
        const pairSignals = this.generatePairSignals(
          zScore,
          btcPrice,
          ethPrice,
          context,
        );
        signals.push(...pairSignals);
      }
    }

    return {
      signals,
      shouldContinue: true,
      nextExecutionTime: Date.now() + 120000, // Execute every 2 minutes
      state: {
        currentRatio: ratio,
        ratioHistoryLength: this.ratioHistory.length,
        currentPosition: this.currentPosition,
      },
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];

    const entryThreshold = getNumberParam(parameters.entryThreshold, 2);
    const exitThreshold = getNumberParam(parameters.exitThreshold, 0.5);
    if (
      !isNumber(parameters.entryThreshold) ||
      !isNumber(parameters.exitThreshold)
    ) {
      errors.push("Entry/exit thresholds must be numbers");
    }
    if (entryThreshold <= exitThreshold) {
      errors.push("Entry threshold must be greater than exit threshold");
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    context.utils.log.info("Pairs trading parameters updated", parameters);
  }

  async cleanup(context: StrategyContext): Promise<void> {
    this.ratioHistory = [];
    this.currentPosition = "neutral";
    this.legQuantities.clear();
  }

  private generatePairSignals(
    zScore: number,
    btcPrice: number,
    ethPrice: number,
    context: StrategyContext,
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const portfolioValue = context.portfolio.totalValue;
    const positionValue =
      (portfolioValue * getNumberParam(context.parameters.positionSize, 0.3)) /
      2; // Split between two assets
    const entryThreshold = getNumberParam(context.parameters.entryThreshold, 2);
    const exitThreshold = getNumberParam(context.parameters.exitThreshold, 0.5);

    // Entry signals
    if (this.currentPosition === "neutral") {
      if (zScore > entryThreshold) {
        // Ratio too high: short BTC, long ETH
        const btcQuantity = positionValue / btcPrice;
        const ethQuantity = positionValue / ethPrice;
        signals.push({
          action: "sell",
          pair: "BTC/USDC",
          quantity: btcQuantity,
          orderType: "market",
          confidence: Math.min(1, Math.abs(zScore) / 3),
          reason: `Pairs entry: BTC/ETH ratio too high (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", leg: "short_btc" },
        });
        signals.push({
          action: "buy",
          pair: "ETH/USDC",
          quantity: ethQuantity,
          orderType: "market",
          confidence: Math.min(1, Math.abs(zScore) / 3),
          reason: `Pairs entry: ETH undervalued vs BTC (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", leg: "long_eth" },
        });

        this.legQuantities.set("BTC/USDC", btcQuantity);
        this.legQuantities.set("ETH/USDC", ethQuantity);
        this.currentPosition = "long_eth_short_btc";
      } else if (zScore < -entryThreshold) {
        // Ratio too low: long BTC, short ETH
        const btcQuantity = positionValue / btcPrice;
        const ethQuantity = positionValue / ethPrice;
        signals.push({
          action: "buy",
          pair: "BTC/USDC",
          quantity: btcQuantity,
          orderType: "market",
          confidence: Math.min(1, Math.abs(zScore) / 3),
          reason: `Pairs entry: BTC undervalued vs ETH (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", leg: "long_btc" },
        });

        signals.push({
          action: "sell",
          pair: "ETH/USDC",
          quantity: ethQuantity,
          orderType: "market",
          confidence: Math.min(1, Math.abs(zScore) / 3),
          reason: `Pairs entry: ETH/BTC ratio too low (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", leg: "short_eth" },
        });

        this.legQuantities.set("BTC/USDC", btcQuantity);
        this.legQuantities.set("ETH/USDC", ethQuantity);
        this.currentPosition = "long_btc_short_eth";
      }
    }

    // Exit signals
    else if (Math.abs(zScore) < exitThreshold) {
      const btcQuantity = this.legQuantities.get("BTC/USDC");
      const ethQuantity = this.legQuantities.get("ETH/USDC");
      if (this.currentPosition === "long_btc_short_eth") {
        if (
          !(btcQuantity && btcQuantity > 0 && ethQuantity && ethQuantity > 0)
        ) {
          return signals;
        }
        signals.push({
          action: "sell",
          pair: "BTC/USDC",
          quantity: btcQuantity,
          orderType: "market",
          confidence: 1,
          reason: `Pairs exit: Ratio normalized (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", action: "close_long_btc" },
        });

        signals.push({
          action: "buy",
          pair: "ETH/USDC",
          quantity: ethQuantity,
          orderType: "market",
          confidence: 1,
          reason: `Pairs exit: Close short ETH position`,
          metadata: { zScore, strategy: "pairs", action: "close_short_eth" },
        });
      } else if (this.currentPosition === "long_eth_short_btc") {
        if (
          !(btcQuantity && btcQuantity > 0 && ethQuantity && ethQuantity > 0)
        ) {
          return signals;
        }
        signals.push({
          action: "buy",
          pair: "BTC/USDC",
          quantity: btcQuantity,
          orderType: "market",
          confidence: 1,
          reason: `Pairs exit: Close short BTC position`,
          metadata: { zScore, strategy: "pairs", action: "close_short_btc" },
        });

        signals.push({
          action: "sell",
          pair: "ETH/USDC",
          quantity: ethQuantity,
          orderType: "market",
          confidence: 1,
          reason: `Pairs exit: Ratio normalized (z-score: ${zScore.toFixed(2)})`,
          metadata: { zScore, strategy: "pairs", action: "close_long_eth" },
        });
      }

      this.legQuantities.delete("BTC/USDC");
      this.legQuantities.delete("ETH/USDC");
      this.currentPosition = "neutral";
    }

    return signals;
  }
}

export class PairsTradingStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new PairsTradingStrategy();
  }
}

// =============================================================================
// Strategy Registration Helper
// =============================================================================

export const EXAMPLE_STRATEGIES = {
  rsi: {
    config: new RSIStrategy().config,
    factory: new RSIStrategyFactory(),
    metadata: {
      tags: ["technical-analysis", "mean-reversion", "oscillator"],
      documentation:
        "RSI-based mean reversion strategy suitable for range-bound markets",
      examples: [
        {
          name: "Conservative RSI",
          description: "Lower risk parameters for stable trading",
          parameters: {
            rsiPeriod: 21,
            oversoldThreshold: 25,
            overboughtThreshold: 75,
            positionSize: 0.05,
            stopLoss: 0.03,
          },
        },
        {
          name: "Aggressive RSI",
          description: "Higher risk parameters for volatile markets",
          parameters: {
            rsiPeriod: 10,
            oversoldThreshold: 35,
            overboughtThreshold: 65,
            positionSize: 0.15,
            stopLoss: 0.08,
          },
        },
      ],
    },
  },

  ma_crossover: {
    config: new MovingAverageCrossoverStrategy().config,
    factory: new MovingAverageCrossoverStrategyFactory(),
    metadata: {
      tags: ["trend-following", "moving-average", "momentum"],
      documentation:
        "Classic moving average crossover strategy for trending markets",
    },
  },

  multi_indicator: {
    config: new MultiIndicatorStrategy().config,
    factory: new MultiIndicatorStrategyFactory(),
    metadata: {
      tags: ["confluence", "multi-indicator", "advanced"],
      documentation:
        "Advanced strategy combining multiple technical indicators",
    },
  },

  pairs_trading: {
    config: new PairsTradingStrategy().config,
    factory: new PairsTradingStrategyFactory(),
    metadata: {
      tags: ["arbitrage", "pairs-trading", "market-neutral"],
      documentation:
        "Statistical arbitrage strategy trading correlated asset pairs",
    },
  },
};
