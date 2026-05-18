/**
 * Grid Trading Strategy
 *
 * Built-in strategy that places buy and sell orders at predefined price levels
 * to profit from market volatility within a trading range.
 */

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

export interface GridParameters extends StrategyParameters {
  pair: string;
  lowerBound: number;
  upperBound: number;
  gridCount: number;
  totalAmount: number;
  mode: "neutral" | "long" | "short";
  rebalanceThreshold?: number; // Percentage threshold for rebalancing
  takeProfit?: number; // Percentage profit target to close grid
  stopLoss?: number; // Percentage loss limit to stop grid
  maxActiveOrders?: number; // Maximum concurrent orders
}

export interface GridState {
  activeOrders: Array<{
    orderId: string;
    level: number;
    side: "buy" | "sell";
    price: number;
    quantity: number;
  }>;
  executedTrades: number;
  totalProfit: number;
  currentLevel: number;
  isActive: boolean;
  gridLevels: Array<{
    price: number;
    buyOrderId?: string;
    sellOrderId?: string;
    isActive: boolean;
  }>;
  totalInvested: number;
  totalTokensHeld: number;
  unrealizedPnL: number;
}

export class GridStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "builtin.grid",
    name: "Grid Trading",
    description:
      "Places buy and sell orders at predefined price levels to profit from market volatility",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["*"], // Supports all pairs
    category: "grid",
    riskLevel: 5,
    minCapital: 500,
    parametersSchema: {
      pair: {
        type: "string",
        default: "ETH/USDC",
        description: "Trading pair to run grid strategy on",
        validation: (value: unknown) =>
          typeof value === "string" && value.includes("/")
            ? true
            : "Must be in format BASE/QUOTE",
      },
      lowerBound: {
        type: "number",
        default: 2500,
        min: 0.01,
        description: "Lower price bound for the grid",
      },
      upperBound: {
        type: "number",
        default: 3500,
        min: 0.01,
        description: "Upper price bound for the grid",
      },
      gridCount: {
        type: "number",
        default: 10,
        min: 3,
        max: 100,
        description: "Number of grid levels between bounds",
      },
      totalAmount: {
        type: "number",
        default: 5000,
        min: 100,
        description: "Total USD amount to use for grid trading",
      },
      mode: {
        type: "select",
        default: "neutral",
        options: ["neutral", "long", "short"],
        description:
          "Grid trading mode: neutral (equal buy/sell), long (more buying), short (more selling)",
      },
      rebalanceThreshold: {
        type: "number",
        default: 5,
        min: 1,
        max: 50,
        description: "Percentage price movement to trigger grid rebalancing",
      },
      takeProfit: {
        type: "number",
        default: 20,
        min: 1,
        max: 100,
        description: "Profit percentage target to close grid and take profits",
      },
      stopLoss: {
        type: "number",
        default: -15,
        min: -50,
        max: -1,
        description: "Loss percentage limit to stop grid trading",
      },
      maxActiveOrders: {
        type: "number",
        default: 20,
        min: 2,
        max: 50,
        description: "Maximum number of concurrent active orders",
      },
    },
  };

  private parameters!: GridParameters;
  private state!: GridState;

  async initialize(context: StrategyContext): Promise<void> {
    this.parameters = context.parameters as GridParameters;

    // Validate grid bounds
    if (this.parameters.lowerBound >= this.parameters.upperBound) {
      throw new Error("Lower bound must be less than upper bound");
    }

    // Calculate grid levels
    const gridLevels = this.calculateGridLevels();

    // Initialize grid state
    this.state = {
      activeOrders: [],
      executedTrades: 0,
      totalProfit: 0,
      currentLevel: Math.floor(gridLevels.length / 2), // Start in middle
      isActive: true,
      gridLevels,
      totalInvested: 0,
      totalTokensHeld: 0,
      unrealizedPnL: 0,
    };

    // Store initial state
    context.state.set("gridState", this.state);

    context.utils.log.info(
      `Grid Strategy initialized: ${this.parameters.gridCount} levels between $${this.parameters.lowerBound} - $${this.parameters.upperBound}`,
    );
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    this.state = context.state.get("gridState") as GridState;

    if (!this.state || !this.state.isActive) {
      return {
        signals: [],
        shouldContinue: false,
        nextExecutionTime: undefined,
      };
    }

    // Get current market data
    const marketData = context.marketData.get(this.parameters.pair);
    if (!marketData) {
      context.utils.log.warn(
        `No market data available for ${this.parameters.pair}`,
      );
      return {
        signals: [],
        shouldContinue: true,
        nextExecutionTime: Date.now() + 60 * 1000, // Retry in 1 minute
      };
    }

    const currentPriceValue: number =
      (marketData as unknown as { close?: number }).close ?? 0;
    const signals: StrategySignal[] = [];

    // Check profit/loss limits
    const pnlCheck = this.checkProfitLoss(currentPriceValue, context);
    if (pnlCheck.shouldStop) {
      this.state.isActive = false;
      context.state.set("gridState", this.state);
      return {
        signals: [],
        shouldContinue: false,
        nextExecutionTime: undefined,
        warnings: [pnlCheck.reason ?? "P&L limit reached"],
      };
    }

    // Check if price is within grid bounds
    if (
      currentPriceValue < this.parameters.lowerBound ||
      currentPriceValue > this.parameters.upperBound
    ) {
      const rebalanceSignals = this.generateRebalanceSignals(
        currentPriceValue,
        context,
      );
      signals.push(...rebalanceSignals);
    } else {
      // Generate grid trading signals
      const gridSignals = this.generateGridSignals(currentPriceValue, context);
      signals.push(...gridSignals);
    }

    // Limit active orders
    const limitedSignals = this.limitActiveOrders(signals);

    context.state.set("gridState", this.state);

    return {
      signals: limitedSignals,
      shouldContinue: true,
      nextExecutionTime: Date.now() + 30 * 1000, // Check every 30 seconds
      state: { gridState: this.state },
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];
    const params = parameters as GridParameters;

    if (!params.pair || !params.pair.includes("/")) {
      errors.push("Invalid trading pair format. Use BASE/QUOTE format.");
    }

    if (params.lowerBound <= 0) {
      errors.push("Lower bound must be greater than 0");
    }

    if (params.upperBound <= params.lowerBound) {
      errors.push("Upper bound must be greater than lower bound");
    }

    if (params.gridCount < 3) {
      errors.push("Grid count must be at least 3");
    }

    if (params.totalAmount <= 0) {
      errors.push("Total amount must be greater than 0");
    }

    const _gridSpacing =
      (params.upperBound - params.lowerBound) / (params.gridCount - 1);
    const minOrderSize = params.totalAmount / (params.gridCount * 2);
    if (minOrderSize < 10) {
      errors.push(
        "Total amount too small for grid size. Increase amount or reduce grid count.",
      );
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    const newParams = { ...this.parameters, ...parameters } as GridParameters;

    // Validate new parameters
    const errors = await this.validateParameters(newParams);
    if (errors.length > 0) {
      throw new Error(`Parameter validation failed: ${errors.join(", ")}`);
    }

    // Check if grid bounds changed
    const boundsChanged =
      parameters.lowerBound !== undefined ||
      parameters.upperBound !== undefined ||
      parameters.gridCount !== undefined;

    if (boundsChanged) {
      // Recalculate grid levels
      this.parameters = newParams;
      this.state.gridLevels = this.calculateGridLevels();
      context.utils.log.info("Grid bounds updated - recalculating levels");
    } else {
      this.parameters = newParams;
    }

    context.state.set("gridState", this.state);
    context.utils.log.info("Grid Strategy parameters updated");
  }

  async onOrderEvent(
    event: OrderEvent,
    context: StrategyContext,
  ): Promise<void> {
    if (event.type === "filled") {
      this.state = context.state.get("gridState") as GridState;

      // Find and remove the filled order
      const orderIndex = this.state.activeOrders.findIndex(
        (o) => o.orderId === event.orderId,
      );
      if (orderIndex !== -1) {
        const filledOrder = this.state.activeOrders[orderIndex];
        this.state.activeOrders.splice(orderIndex, 1);

        // Update trade statistics
        this.state.executedTrades++;
        const orderValue = filledOrder.price * filledOrder.quantity;

        if (filledOrder.side === "buy") {
          this.state.totalInvested += orderValue;
          this.state.totalTokensHeld += filledOrder.quantity;
        } else {
          this.state.totalInvested -= orderValue;
          this.state.totalTokensHeld -= filledOrder.quantity;
          this.state.totalProfit +=
            orderValue - filledOrder.quantity * this.getAverageBuyPrice();
        }

        // Update grid level status
        const level = this.state.gridLevels[filledOrder.level];
        if (level) {
          if (filledOrder.side === "buy") {
            level.buyOrderId = undefined;
          } else {
            level.sellOrderId = undefined;
          }
        }

        context.state.set("gridState", this.state);
        context.utils.log.info(
          `Grid ${filledOrder.side} order filled at level ${filledOrder.level}: $${filledOrder.price}`,
        );
      }
    }
  }

  async cleanup(context: StrategyContext): Promise<void> {
    context.utils.log.info("Grid Strategy cleanup completed");
  }

  private calculateGridLevels(): Array<{
    price: number;
    buyOrderId?: string;
    sellOrderId?: string;
    isActive: boolean;
  }> {
    const levels: Array<{
      price: number;
      buyOrderId?: string;
      sellOrderId?: string;
      isActive: boolean;
    }> = [];
    const priceRange = this.parameters.upperBound - this.parameters.lowerBound;
    const gridSpacing = priceRange / (this.parameters.gridCount - 1);

    for (let i = 0; i < this.parameters.gridCount; i++) {
      const price = this.parameters.lowerBound + i * gridSpacing;
      levels.push({
        price: Math.round(price * 100) / 100, // Round to 2 decimals
        isActive: true,
      });
    }

    return levels;
  }

  private generateGridSignals(
    currentPrice: number,
    context: StrategyContext,
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const amountPerLevel =
      this.parameters.totalAmount / (this.parameters.gridCount * 2);

    // Find current price level
    const currentLevelIndex = this.findClosestLevel(currentPrice);

    // Generate buy orders below current price
    for (let i = 0; i < currentLevelIndex; i++) {
      const level = this.state.gridLevels[i];
      if (
        level.isActive &&
        !level.buyOrderId &&
        !this.hasActiveOrderAtLevel(i, "buy")
      ) {
        signals.push({
          action: "buy",
          pair: this.parameters.pair,
          quantity: amountPerLevel,
          price: level.price,
          orderType: "limit",
          confidence: 0.8,
          reason: `Grid buy order at level ${i}`,
          metadata: {
            gridLevel: i,
            strategy: "grid",
            side: "buy",
          },
        });
      }
    }

    // Generate sell orders above current price
    for (let i = currentLevelIndex + 1; i < this.state.gridLevels.length; i++) {
      const level = this.state.gridLevels[i];
      if (
        level.isActive &&
        !level.sellOrderId &&
        !this.hasActiveOrderAtLevel(i, "sell")
      ) {
        // Only place sell orders if we have tokens to sell
        if (this.state.totalTokensHeld > 0) {
          const sellQuantity = Math.min(
            amountPerLevel / level.price,
            this.state.totalTokensHeld / 2,
          );
          signals.push({
            action: "sell",
            pair: this.parameters.pair,
            quantity: sellQuantity * level.price, // Convert to USD value
            price: level.price,
            orderType: "limit",
            confidence: 0.8,
            reason: `Grid sell order at level ${i}`,
            metadata: {
              gridLevel: i,
              strategy: "grid",
              side: "sell",
            },
          });
        }
      }
    }

    return signals;
  }

  private generateRebalanceSignals(
    currentPrice: number,
    context: StrategyContext,
  ): StrategySignal[] {
    const signals: StrategySignal[] = [];

    if (currentPrice < this.parameters.lowerBound) {
      // Price below grid - consider expanding lower bound or adjusting strategy
      context.utils.log.warn(
        `Price ${currentPrice} below grid lower bound ${this.parameters.lowerBound}`,
      );

      if (this.parameters.rebalanceThreshold) {
        const deviation =
          ((this.parameters.lowerBound - currentPrice) /
            this.parameters.lowerBound) *
          100;
        if (deviation > this.parameters.rebalanceThreshold) {
          // Suggest rebalancing
          context.utils.log.info(
            `Grid rebalancing triggered: ${deviation.toFixed(1)}% below lower bound`,
          );
        }
      }
    } else if (currentPrice > this.parameters.upperBound) {
      // Price above grid - consider expanding upper bound or taking profits
      context.utils.log.warn(
        `Price ${currentPrice} above grid upper bound ${this.parameters.upperBound}`,
      );

      if (this.parameters.rebalanceThreshold) {
        const deviation =
          ((currentPrice - this.parameters.upperBound) /
            this.parameters.upperBound) *
          100;
        if (deviation > this.parameters.rebalanceThreshold) {
          context.utils.log.info(
            `Grid rebalancing triggered: ${deviation.toFixed(1)}% above upper bound`,
          );
        }
      }
    }

    return signals;
  }

  private checkProfitLoss(
    currentPrice: number,
    context: StrategyContext,
  ): { shouldStop: boolean; reason?: string } {
    // Calculate current P&L
    const currentValue = this.state.totalTokensHeld * currentPrice;
    const totalPnL =
      this.state.totalProfit + (currentValue - this.state.totalInvested);
    const pnlPercentage = (totalPnL / this.parameters.totalAmount) * 100;

    this.state.unrealizedPnL = totalPnL;

    // Check take profit
    if (
      this.parameters.takeProfit &&
      pnlPercentage >= this.parameters.takeProfit
    ) {
      return {
        shouldStop: true,
        reason: `Take profit triggered: ${pnlPercentage.toFixed(1)}% profit reached`,
      };
    }

    // Check stop loss
    if (this.parameters.stopLoss && pnlPercentage <= this.parameters.stopLoss) {
      return {
        shouldStop: true,
        reason: `Stop loss triggered: ${pnlPercentage.toFixed(1)}% loss limit reached`,
      };
    }

    return { shouldStop: false };
  }

  private findClosestLevel(price: number): number {
    let closestIndex = 0;
    let minDistance = Math.abs(this.state.gridLevels[0].price - price);

    for (let i = 1; i < this.state.gridLevels.length; i++) {
      const distance = Math.abs(this.state.gridLevels[i].price - price);
      if (distance < minDistance) {
        minDistance = distance;
        closestIndex = i;
      }
    }

    return closestIndex;
  }

  private hasActiveOrderAtLevel(level: number, side: "buy" | "sell"): boolean {
    return this.state.activeOrders.some(
      (order) => order.level === level && order.side === side,
    );
  }

  private limitActiveOrders(signals: StrategySignal[]): StrategySignal[] {
    const maxOrders = this.parameters.maxActiveOrders || 20;
    const currentActiveCount = this.state.activeOrders.length;
    const availableSlots = maxOrders - currentActiveCount;

    if (availableSlots <= 0) {
      return [];
    }

    return signals.slice(0, availableSlots);
  }

  private getAverageBuyPrice(): number {
    if (this.state.totalTokensHeld === 0) return 0;
    return this.state.totalInvested / this.state.totalTokensHeld;
  }
}

/**
 * Grid Strategy Factory
 */
export class GridStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new GridStrategy();
  }
}

// Export factory instance for registration
export const gridStrategyFactory = new GridStrategyFactory();
