/**
 * Stress Test Strategy
 *
 * Built-in strategy that generates large bursts of random buy/sell orders
 * to stress test order placement throughput.
 */

import {
  IStrategy,
  IStrategyFactory,
  StrategyConfig,
  StrategyContext,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
} from "../core/i-strategy";

export interface StressTestParameters extends StrategyParameters {
  pair: string;
  maxOrders: number;
  ordersPerBatch: number;
  intervalMs: number;
  minOrderUsd: number;
  maxOrderUsd: number;
  seed?: number;
}

export interface StressTestState {
  ordersSent: number;
  nextExecutionTime: number;
  isActive: boolean;
  rngState: number;
}

const parsePair = (pair: string): { base: string; quote: string } => {
  const [base, quote] = pair.split("/");
  return { base, quote };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export class StressTestStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "builtin.stress_test",
    name: "Stress Test Orders",
    description:
      "Spams random buy/sell orders to stress test order placement throughput",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["*"],
    category: "stress_test",
    riskLevel: 10,
    minCapital: 0,
    parametersSchema: {
      pair: {
        type: "string",
        default: "BTC/USDC",
        description: "Trading pair to stress test",
        validation: (value: unknown) =>
          typeof value === "string" && value.includes("/")
            ? true
            : "Must be in format BASE/QUOTE",
      },
      maxOrders: {
        type: "number",
        default: 1000,
        min: 1,
        max: 100000,
        description: "Total orders to attempt before stopping",
      },
      ordersPerBatch: {
        type: "number",
        default: 50,
        min: 1,
        max: 5000,
        description: "Orders to emit per execution tick",
      },
      intervalMs: {
        type: "number",
        default: 500,
        min: 50,
        max: 60000,
        description: "Delay between order batches (milliseconds)",
      },
      minOrderUsd: {
        type: "number",
        default: 1,
        min: 0.01,
        max: 100000,
        description: "Minimum order notional (USD)",
      },
      maxOrderUsd: {
        type: "number",
        default: 50,
        min: 0.01,
        max: 1000000,
        description: "Maximum order notional (USD)",
      },
      seed: {
        type: "number",
        default: 0,
        min: 0,
        max: 4294967295,
        description: "Optional deterministic seed for repeatable stress runs",
      },
    },
  };

  private parameters!: StressTestParameters;
  private state!: StressTestState;

  async initialize(context: StrategyContext): Promise<void> {
    this.parameters = context.parameters as StressTestParameters;
    const seed =
      typeof this.parameters.seed === "number"
        ? this.parameters.seed >>> 0
        : Date.now() >>> 0;
    this.state = {
      ordersSent: 0,
      nextExecutionTime: Date.now(),
      isActive: true,
      rngState: seed,
    };
    context.state.set("stressState", this.state);
    context.utils.log.warn(
      `Stress Test Strategy initialized: up to ${this.parameters.maxOrders} orders in batches of ${this.parameters.ordersPerBatch}`,
    );
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const now = Date.now();
    this.state = (context.state.get("stressState") as StressTestState) ?? {
      ordersSent: 0,
      nextExecutionTime: now,
      isActive: true,
      rngState:
        typeof this.parameters.seed === "number"
          ? this.parameters.seed >>> 0
          : now >>> 0,
    };

    if (!this.state.isActive) {
      return { signals: [], shouldContinue: false };
    }

    if (now < this.state.nextExecutionTime) {
      return {
        signals: [],
        shouldContinue: true,
        nextExecutionTime: this.state.nextExecutionTime,
      };
    }

    if (this.state.ordersSent >= this.parameters.maxOrders) {
      this.state.isActive = false;
      context.state.set("stressState", this.state);
      context.utils.log.info("Stress Test Strategy completed: max orders hit");
      return { signals: [], shouldContinue: false };
    }

    const { base, quote } = parsePair(this.parameters.pair);
    const marketData = context.marketData.get(this.parameters.pair);
    const price =
      (marketData as unknown as { close?: number })?.close ??
      (marketData as unknown as { price?: number })?.price;

    if (!price || Number.isNaN(price)) {
      context.utils.log.warn(
        `Stress test skipped: no price data for ${this.parameters.pair}`,
      );
      this.state.nextExecutionTime = now + this.parameters.intervalMs;
      context.state.set("stressState", this.state);
      return {
        signals: [],
        shouldContinue: true,
        nextExecutionTime: this.state.nextExecutionTime,
      };
    }

    const quoteBalance = context.portfolio.positions?.[quote]?.balance ?? 0;
    const baseBalance = context.portfolio.positions?.[base]?.balance ?? 0;
    let availableQuoteUsd = Math.max(0, quoteBalance);
    let availableBase = Math.max(0, baseBalance);

    const remainingOrders = this.parameters.maxOrders - this.state.ordersSent;
    const batchCount = Math.min(
      this.parameters.ordersPerBatch,
      remainingOrders,
    );

    const signals: StrategySignal[] = [];
    const minOrder = Math.max(0.01, this.parameters.minOrderUsd);
    const maxOrder = Math.max(minOrder, this.parameters.maxOrderUsd);

    for (let i = 0; i < batchCount; i++) {
      const randomUsd = minOrder + this.nextRandom() * (maxOrder - minOrder);
      const side = this.nextRandom() >= 0.5 ? "buy" : "sell";

      if (side === "buy") {
        if (availableQuoteUsd < minOrder) {
          continue;
        }
        const orderUsd = clamp(randomUsd, minOrder, availableQuoteUsd);
        availableQuoteUsd -= orderUsd;
        signals.push({
          action: "buy",
          pair: this.parameters.pair,
          quantity: orderUsd,
          orderType: "market",
          confidence: 1.0,
          reason: "Stress test buy",
          metadata: {
            strategy: "stress_test",
            side: "buy",
          },
        });
      } else {
        const availableSellUsd = availableBase * price;
        if (availableSellUsd < minOrder) {
          continue;
        }
        const orderUsd = clamp(randomUsd, minOrder, availableSellUsd);
        const baseSold = orderUsd / price;
        availableBase = Math.max(0, availableBase - baseSold);
        signals.push({
          action: "sell",
          pair: this.parameters.pair,
          quantity: orderUsd,
          price,
          orderType: "market",
          confidence: 1.0,
          reason: "Stress test sell",
          metadata: {
            strategy: "stress_test",
            side: "sell",
          },
        });
      }
    }

    this.state.ordersSent += signals.length;
    this.state.nextExecutionTime = now + this.parameters.intervalMs;
    context.state.set("stressState", this.state);

    if (signals.length === 0) {
      context.utils.log.warn(
        "Stress test skipped: insufficient balances for new orders",
      );
    }

    return {
      signals,
      shouldContinue: true,
      nextExecutionTime: this.state.nextExecutionTime,
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];
    const typed = parameters as Partial<StressTestParameters>;
    if (!typed.pair || typeof typed.pair !== "string") {
      errors.push("pair must be a string in format BASE/QUOTE");
    }
    if (typed.maxOrders !== undefined && typed.maxOrders <= 0) {
      errors.push("maxOrders must be > 0");
    }
    if (typed.ordersPerBatch !== undefined && typed.ordersPerBatch <= 0) {
      errors.push("ordersPerBatch must be > 0");
    }
    if (typed.minOrderUsd !== undefined && typed.minOrderUsd <= 0) {
      errors.push("minOrderUsd must be > 0");
    }
    if (
      typed.maxOrderUsd !== undefined &&
      typed.minOrderUsd !== undefined &&
      typed.maxOrderUsd < typed.minOrderUsd
    ) {
      errors.push("maxOrderUsd must be >= minOrderUsd");
    }
    return errors;
  }

  private nextRandom(): number {
    this.state.rngState += 0x6d2b79f5;
    let value = Math.imul(
      this.state.rngState ^ (this.state.rngState >>> 15),
      1 | this.state.rngState,
    );
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) >>> 0;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    this.parameters = {
      ...(this.parameters as StressTestParameters),
      ...(parameters as Partial<StressTestParameters>),
    };
    context.state.set("stressState", this.state);
  }

  async cleanup(context: StrategyContext): Promise<void> {
    context.utils.log.info("Stress Test Strategy cleanup completed");
  }
}

/**
 * Stress Test Strategy Factory
 */
export class StressTestStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new StressTestStrategy();
  }
}

export const stressTestStrategyFactory = new StressTestStrategyFactory();
