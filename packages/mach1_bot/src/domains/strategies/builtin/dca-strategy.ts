/**
 * Dollar Cost Averaging (DCA) Strategy
 *
 * Built-in strategy that implements systematic purchasing at regular intervals
 * to reduce the impact of volatility on large purchases.
 */

import type { OrderResult } from "@/shared/types";
import type { BotOrder } from "@/shared/types/bot";
import type { OrderLifecycleRecord } from "@/shared/types";
import {
  IStrategy,
  IStrategyFactory,
  OrderEvent,
  StrategyConfig,
  StrategyContext,
  StrategyParameters,
  StrategyResult,
  StrategySignal,
} from "../core/i-strategy";

export interface DCAParameters extends StrategyParameters {
  pair: string;
  totalAmountUsd: number;
  intervalMinutes: number;
  orderCount: number;
  priceStrategy: "market" | "limit" | "twap";
  limitPriceOffset?: number; // Percentage offset for limit orders
  maxSlippage?: number; // Maximum allowed slippage
  stopOnMarketClose?: boolean;
}

export interface DCAState {
  executedOrders: number;
  remainingAmount: number;
  totalSpent: number;
  averagePrice: number;
  nextExecutionTime: number;
  lastExecutionTime?: number;
  isActive: boolean;
  totalTokensAcquired: number;
}

export class DCAStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "builtin.dca",
    name: "Dollar Cost Averaging",
    description:
      "Systematically purchase assets at regular intervals to reduce volatility impact",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["*"], // Supports all pairs
    category: "dca",
    riskLevel: 3,
    minCapital: 100,
    parametersSchema: {
      pair: {
        type: "string",
        default: "ETH/USDC",
        description: "Trading pair to execute DCA on",
        validation: (value: unknown) =>
          typeof value === "string" && value.includes("/")
            ? true
            : "Must be in format BASE/QUOTE",
      },
      totalAmountUsd: {
        type: "number",
        default: 1000,
        min: 10,
        description: "Total USD amount to invest over the DCA period",
      },
      intervalMinutes: {
        type: "number",
        default: 0.25,
        min: 0.1,
        max: 10080, // 1 week
        description: "Minutes between each DCA purchase",
      },
      orderCount: {
        type: "number",
        default: 10,
        min: 2,
        max: 1000,
        description: "Total number of orders to execute",
      },
      priceStrategy: {
        type: "select",
        default: "market",
        options: ["market", "limit", "twap"],
        description: "Order execution strategy",
      },
      limitPriceOffset: {
        type: "number",
        default: -0.1,
        min: -5,
        max: 5,
        description:
          "Price offset percentage for limit orders (negative for below market)",
      },
      maxSlippage: {
        type: "number",
        default: 0.5,
        min: 0.01,
        max: 10,
        description: "Maximum allowed slippage percentage",
      },
      stopOnMarketClose: {
        type: "boolean",
        default: false,
        description: "Pause DCA during market close hours",
      },
    },
  };

  private parameters!: DCAParameters;
  private state!: DCAState;

  async initialize(context: StrategyContext): Promise<void> {
    this.parameters = context.parameters as DCAParameters;

    // Initialize DCA state
    const amountPerOrder =
      this.parameters.totalAmountUsd / this.parameters.orderCount;
    const intervalMs = this.parameters.intervalMinutes * 60 * 1000;

    this.state = {
      executedOrders: 0,
      remainingAmount: this.parameters.totalAmountUsd,
      totalSpent: 0,
      averagePrice: 0,
      nextExecutionTime: Date.now() + intervalMs,
      isActive: true,
      totalTokensAcquired: 0,
    };

    // Store initial state
    context.state.set("dcaState", this.state);

    context.utils.log.info(
      `DCA Strategy initialized: ${this.parameters.orderCount} orders of $${amountPerOrder.toFixed(2)} every ${this.parameters.intervalMinutes} minutes`,
    );
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    const currentTime = Date.now();
    this.state = context.state.get("dcaState") as DCAState;

    if (!this.state || !this.state.isActive) {
      return {
        signals: [],
        shouldContinue: false,
        nextExecutionTime: undefined,
      };
    }

    // Check if it's time to execute next order
    if (currentTime < this.state.nextExecutionTime) {
      return {
        signals: [],
        shouldContinue: true,
        nextExecutionTime: this.state.nextExecutionTime,
      };
    }

    // Check if all orders have been executed
    if (this.state.executedOrders >= this.parameters.orderCount) {
      context.utils.log.info("DCA Strategy completed: All orders executed");
      this.state.isActive = false;
      context.state.set("dcaState", this.state);

      return {
        signals: [],
        shouldContinue: false,
        nextExecutionTime: undefined,
      };
    }

    // Check market hours if required
    if (this.parameters.stopOnMarketClose) {
      const marketHours = context.utils.time.getMarketHours();
      if (!marketHours.isOpen) {
        return {
          signals: [],
          shouldContinue: true,
          nextExecutionTime: marketHours.nextOpen,
        };
      }
    }

    // Calculate order amount
    const remainingOrders =
      this.parameters.orderCount - this.state.executedOrders;
    const orderAmount = this.state.remainingAmount / remainingOrders;

    // Get current market data
    const marketData = context.marketData.get(this.parameters.pair);
    if (!marketData) {
      context.utils.log.warn(
        `No market data available for ${this.parameters.pair}`,
      );
      return {
        signals: [],
        shouldContinue: true,
        nextExecutionTime: currentTime + 60 * 1000, // Retry in 1 minute
      };
    }

    // Generate buy signal
    const closePrice = (marketData as unknown as { close?: number }).close;
    const orderPrice =
      typeof closePrice === "number"
        ? this.getOrderPrice(closePrice)
        : undefined;
    const signal: StrategySignal = {
      action: "buy",
      pair: this.parameters.pair,
      quantity: orderAmount,
      orderType: this.getOrderType(),
      price: orderPrice,
      confidence: 1.0, // DCA has full confidence in systematic execution
      reason: `DCA order ${this.state.executedOrders + 1}/${this.parameters.orderCount}`,
      metadata: {
        dcaOrder: this.state.executedOrders + 1,
        totalOrders: this.parameters.orderCount,
        intervalMinutes: this.parameters.intervalMinutes,
        strategy: "dca",
      },
    };

    // Update state for next execution
    const intervalMs = this.parameters.intervalMinutes * 60 * 1000;
    this.state.nextExecutionTime = currentTime + intervalMs;
    this.state.lastExecutionTime = currentTime;

    context.state.set("dcaState", this.state);

    return {
      signals: [signal],
      shouldContinue: true,
      nextExecutionTime: this.state.nextExecutionTime,
      state: { dcaState: this.state },
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];
    const params = parameters as DCAParameters;

    if (!params.pair || !params.pair.includes("/")) {
      errors.push("Invalid trading pair format. Use BASE/QUOTE format.");
    }

    if (params.totalAmountUsd <= 0) {
      errors.push("Total amount must be greater than 0");
    }

    if (params.orderCount <= 1) {
      errors.push("Order count must be at least 2");
    }

    if (params.intervalMinutes <= 0) {
      errors.push("Interval must be greater than 0 minutes");
    }

    const amountPerOrder = params.totalAmountUsd / params.orderCount;
    if (amountPerOrder < 1) {
      errors.push(
        "Amount per order too small. Increase total amount or reduce order count.",
      );
    }

    if (
      params.priceStrategy === "limit" &&
      params.limitPriceOffset === undefined
    ) {
      errors.push(
        "Limit price offset is required when using limit order strategy",
      );
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    const newParams = { ...this.parameters, ...parameters } as DCAParameters;

    // Validate new parameters
    const errors = await this.validateParameters(newParams);
    if (errors.length > 0) {
      throw new Error(`Parameter validation failed: ${errors.join(", ")}`);
    }

    // Update parameters
    this.parameters = newParams;

    // Recalculate state if needed
    if (parameters.totalAmountUsd || parameters.orderCount) {
      const remainingOrders =
        this.parameters.orderCount - this.state.executedOrders;
      if (remainingOrders > 0) {
        this.state.remainingAmount =
          (this.parameters.totalAmountUsd * remainingOrders) /
          this.parameters.orderCount;
      }
    }

    context.state.set("dcaState", this.state);
    context.utils.log.info("DCA Strategy parameters updated");
  }

  async onOrderEvent(
    event: OrderEvent,
    context: StrategyContext,
  ): Promise<void> {
    if (event.type === "filled" || event.type === "partially_filled") {
      this.state = context.state.get("dcaState") as DCAState;

      // Update execution statistics
      this.state.executedOrders += event.type === "filled" ? 1 : 0;

      // Estimate filled value based on order size and price
      const getOrderNumber = (
        order: OrderLifecycleRecord | OrderResult | BotOrder | undefined,
        key: "price" | "size",
      ): number => {
        if (!order || typeof order !== "object") return 0;
        if ("averageFillPrice" in order && key === "price") {
          return order.averageFillPrice
            ? Number(order.averageFillPrice) / 100
            : 0;
        }
        if ("filledQuantity" in order && key === "size") {
          return Number(order.filledQuantity) / 100;
        }
        const o = order as unknown as Record<string, unknown>;
        const v = o[key];
        if (typeof v === "number") return v;
        if (typeof v === "bigint") return Number(v);
        if (typeof v === "string") {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        }
        return 0;
      };

      const size = getOrderNumber(event.order, "size");
      const price = getOrderNumber(event.order, "price");
      const estimatedValue = size * price;
      this.state.totalSpent += estimatedValue;
      this.state.remainingAmount = Math.max(
        0,
        this.state.remainingAmount - estimatedValue,
      );

      // Update average price and tokens acquired
      this.state.totalTokensAcquired += size;
      if (this.state.totalTokensAcquired > 0) {
        this.state.averagePrice =
          this.state.totalSpent / this.state.totalTokensAcquired;
      }

      context.state.set("dcaState", this.state);

      context.utils.log.info(
        `DCA order ${event.type}: ${this.state.executedOrders}/${this.parameters.orderCount} complete`,
      );
    }
  }

  async cleanup(context: StrategyContext): Promise<void> {
    context.utils.log.info("DCA Strategy cleanup completed");
  }

  private getOrderType(): "market" | "limit" | "stop" | "stop_limit" {
    switch (this.parameters.priceStrategy) {
      case "limit":
        return "limit";
      case "twap":
        return "limit"; // TWAP uses limit orders with small price improvements
      case "market":
      default:
        return "market";
    }
  }

  private getOrderPrice(currentPrice: number): number | undefined {
    if (this.parameters.priceStrategy === "market") {
      return undefined; // Market orders don't specify price
    }

    if (this.parameters.priceStrategy === "limit") {
      const offset = this.parameters.limitPriceOffset || 0;
      return currentPrice * (1 + offset / 100);
    }

    if (this.parameters.priceStrategy === "twap") {
      // TWAP uses small price improvement to ensure fills
      return currentPrice * 0.999; // 0.1% below market
    }

    return undefined;
  }
}

/**
 * DCA Strategy Factory
 */
export class DCAStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new DCAStrategy();
  }
}

// Export factory instance for registration
export const dcaStrategyFactory = new DCAStrategyFactory();
