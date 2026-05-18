/**
 * Portfolio Management Strategy
 *
 * Built-in strategy that manages portfolio allocation and rebalancing
 * based on target percentages and risk parameters.
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

export interface AllocationTarget {
  token: string; // Trading pair or token symbol
  targetPercent: number;
  minPercent?: number;
  maxPercent?: number;
}

export interface PortfolioParameters extends StrategyParameters {
  allocationTargets: AllocationTarget[];
  rebalanceThreshold: number; // Percentage deviation to trigger rebalance
  rebalanceInterval: number; // Hours between rebalance checks
  maxSlippage: number; // Maximum slippage allowed for rebalance trades
  minTradeSize: number; // Minimum USD value for rebalance trades
  riskTolerance: number; // 1-10 scale for risk management
  enableAutoRebalance: boolean;
  correlationThreshold?: number; // Max correlation between holdings
  concentrationLimit?: number; // Max percentage in single asset
}

export interface PortfolioState {
  currentAllocation: Map<string, number>;
  lastRebalanceTime: number;
  totalValue: number;
  unrealizedPnL: number;
  rebalanceCount: number;
  isRebalancing: boolean;
  allocationHistory: Array<{
    timestamp: number;
    allocation: Map<string, number>;
    totalValue: number;
  }>;
  performance: {
    totalReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    volatility: number;
  };
}

export class PortfolioStrategy implements IStrategy {
  readonly config: StrategyConfig = {
    id: "builtin.portfolio",
    name: "Portfolio Management",
    description:
      "Manages portfolio allocation and automatic rebalancing based on target percentages",
    version: "1.0.0",
    author: "Mach-One SDK",
    supportedPairs: ["*"], // Supports all pairs
    category: "custom",
    riskLevel: 4,
    minCapital: 1000,
    parametersSchema: {
      allocationTargets: {
        type: "string", // JSON string for complex object
        default: JSON.stringify([
          {
            token: "ETH/USDC",
            targetPercent: 40,
            minPercent: 30,
            maxPercent: 50,
          },
          {
            token: "BTC/USDC",
            targetPercent: 30,
            minPercent: 20,
            maxPercent: 40,
          },
          { token: "USDC", targetPercent: 30, minPercent: 20, maxPercent: 40 },
        ]),
        description:
          "JSON array of allocation targets with token and percentage",
      },
      rebalanceThreshold: {
        type: "number",
        default: 5,
        min: 1,
        max: 20,
        description: "Percentage deviation from target to trigger rebalancing",
      },
      rebalanceInterval: {
        type: "number",
        default: 24,
        min: 1,
        max: 168, // 1 week
        description: "Hours between rebalance checks",
      },
      maxSlippage: {
        type: "number",
        default: 1.0,
        min: 0.1,
        max: 5.0,
        description: "Maximum slippage percentage allowed for rebalance trades",
      },
      minTradeSize: {
        type: "number",
        default: 50,
        min: 10,
        description: "Minimum USD value for rebalance trades",
      },
      riskTolerance: {
        type: "number",
        default: 5,
        min: 1,
        max: 10,
        description: "Risk tolerance level (1=conservative, 10=aggressive)",
      },
      enableAutoRebalance: {
        type: "boolean",
        default: true,
        description:
          "Enable automatic rebalancing when thresholds are exceeded",
      },
      correlationThreshold: {
        type: "number",
        default: 0.8,
        min: 0.1,
        max: 1.0,
        description: "Maximum correlation allowed between holdings",
      },
      concentrationLimit: {
        type: "number",
        default: 50,
        min: 10,
        max: 80,
        description: "Maximum percentage allowed in single asset",
      },
    },
  };

  private parameters!: PortfolioParameters;
  private state!: PortfolioState;

  async initialize(context: StrategyContext): Promise<void> {
    this.parameters = context.parameters as PortfolioParameters;

    // Parse allocation targets if string
    if (typeof this.parameters.allocationTargets === "string") {
      this.parameters.allocationTargets = JSON.parse(
        this.parameters.allocationTargets,
      );
    }

    // Validate allocation targets sum to 100%
    const totalPercent = this.parameters.allocationTargets.reduce(
      (sum, target) => sum + target.targetPercent,
      0,
    );
    if (Math.abs(totalPercent - 100) > 0.01) {
      throw new Error(
        `Allocation targets must sum to 100%, currently: ${totalPercent}%`,
      );
    }

    // Initialize portfolio state
    this.state = {
      currentAllocation: new Map(),
      lastRebalanceTime: 0,
      totalValue: 0,
      unrealizedPnL: 0,
      rebalanceCount: 0,
      isRebalancing: false,
      allocationHistory: [],
      performance: {
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        volatility: 0,
      },
    };

    // Calculate initial allocation from current portfolio
    await this.updateCurrentAllocation(context);

    // Store initial state
    context.state.set("portfolioState", this.state);

    context.utils.log.info(
      `Portfolio Strategy initialized with ${this.parameters.allocationTargets.length} allocation targets`,
    );
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    this.state = context.state.get("portfolioState") as PortfolioState;

    if (!this.state) {
      return {
        signals: [],
        shouldContinue: false,
        nextExecutionTime: undefined,
      };
    }

    const currentTime = Date.now();
    const signals: StrategySignal[] = [];

    // Update current allocation and portfolio value
    await this.updateCurrentAllocation(context);

    // Check if it's time for scheduled rebalance
    const timeSinceLastRebalance = currentTime - this.state.lastRebalanceTime;
    const rebalanceIntervalMs =
      this.parameters.rebalanceInterval * 60 * 60 * 1000;
    const scheduledRebalanceNeeded =
      timeSinceLastRebalance >= rebalanceIntervalMs;

    // Check if allocation deviation exceeds threshold
    const deviationRebalanceNeeded = this.checkRebalanceThreshold();

    // Check risk limits
    const riskCheckResult = this.checkRiskLimits();
    if (riskCheckResult.violations.length > 0) {
      context.utils.log.warn(
        `Portfolio risk violations: ${riskCheckResult.violations.join(", ")}`,
      );
    }

    // Generate rebalance signals if needed and enabled
    if (
      (scheduledRebalanceNeeded ||
        deviationRebalanceNeeded ||
        riskCheckResult.forceRebalance) &&
      this.parameters.enableAutoRebalance &&
      !this.state.isRebalancing
    ) {
      const rebalanceSignals = this.generateRebalanceSignals(context);
      signals.push(...rebalanceSignals);

      if (rebalanceSignals.length > 0) {
        this.state.isRebalancing = true;
        this.state.lastRebalanceTime = currentTime;
        this.state.rebalanceCount++;

        const reason = scheduledRebalanceNeeded
          ? "Scheduled rebalance"
          : deviationRebalanceNeeded
            ? "Deviation threshold exceeded"
            : "Risk limit violation";
        context.utils.log.info(`Portfolio rebalancing triggered: ${reason}`);
      }
    }

    // Update performance metrics
    this.updatePerformanceMetrics(context);

    // Save allocation snapshot
    this.state.allocationHistory.push({
      timestamp: currentTime,
      allocation: new Map(this.state.currentAllocation),
      totalValue: this.state.totalValue,
    });

    // Keep only last 30 days of history
    const thirtyDaysAgo = currentTime - 30 * 24 * 60 * 60 * 1000;
    this.state.allocationHistory = this.state.allocationHistory.filter(
      (h) => h.timestamp > thirtyDaysAgo,
    );

    context.state.set("portfolioState", this.state);

    // Next execution time
    const nextCheckTime =
      currentTime +
      Math.min(
        this.parameters.rebalanceInterval * 60 * 60 * 1000,
        4 * 60 * 60 * 1000,
      ); // Max 4 hours

    return {
      signals,
      shouldContinue: true,
      nextExecutionTime: nextCheckTime,
      warnings:
        riskCheckResult.violations.length > 0
          ? riskCheckResult.violations
          : undefined,
      state: { portfolioState: this.state },
    };
  }

  async validateParameters(parameters: StrategyParameters): Promise<string[]> {
    const errors: string[] = [];
    const params = parameters as PortfolioParameters;

    // Parse allocation targets if string
    let allocationTargets = params.allocationTargets;
    if (typeof allocationTargets === "string") {
      try {
        allocationTargets = JSON.parse(allocationTargets);
      } catch (_e) {
        errors.push("Invalid JSON format for allocation targets");
        return errors;
      }
    }

    if (!Array.isArray(allocationTargets) || allocationTargets.length === 0) {
      errors.push("At least one allocation target is required");
      return errors;
    }

    // Validate allocation targets
    const totalPercent = allocationTargets.reduce((sum: number, target) => {
      if (typeof target !== "object" || target === null) {
        errors.push("Each allocation target must have token and targetPercent");
        return sum;
      }
      const typedTarget = target as AllocationTarget;
      if (!typedTarget.token || typeof typedTarget.targetPercent !== "number") {
        errors.push("Each allocation target must have token and targetPercent");
        return sum;
      }
      if (typedTarget.targetPercent <= 0 || typedTarget.targetPercent > 100) {
        errors.push("Target percentages must be between 0 and 100");
      }
      return sum + typedTarget.targetPercent;
    }, 0);

    if (Math.abs(totalPercent - 100) > 0.01) {
      errors.push(
        `Allocation targets must sum to 100%, currently: ${totalPercent}%`,
      );
    }

    if (params.rebalanceThreshold <= 0 || params.rebalanceThreshold > 50) {
      errors.push("Rebalance threshold must be between 0 and 50%");
    }

    if (params.riskTolerance < 1 || params.riskTolerance > 10) {
      errors.push("Risk tolerance must be between 1 and 10");
    }

    return errors;
  }

  async updateParameters(
    parameters: Partial<StrategyParameters>,
    context: StrategyContext,
  ): Promise<void> {
    const newParams = {
      ...this.parameters,
      ...parameters,
    } as PortfolioParameters;

    // Validate new parameters
    const errors = await this.validateParameters(newParams);
    if (errors.length > 0) {
      throw new Error(`Parameter validation failed: ${errors.join(", ")}`);
    }

    this.parameters = newParams;

    // Parse allocation targets if updated
    if (
      parameters.allocationTargets &&
      typeof this.parameters.allocationTargets === "string"
    ) {
      this.parameters.allocationTargets = JSON.parse(
        this.parameters.allocationTargets,
      );
    }

    context.state.set("portfolioState", this.state);
    context.utils.log.info("Portfolio Strategy parameters updated");
  }

  async onOrderEvent(
    event: OrderEvent,
    context: StrategyContext,
  ): Promise<void> {
    if (event.type === "filled") {
      this.state = context.state.get("portfolioState") as PortfolioState;

      // Check if this was a rebalance order
      if (this.state.isRebalancing) {
        // Update allocation after trade
        await this.updateCurrentAllocation(context);

        // Check if rebalancing is complete
        const deviationExists = this.checkRebalanceThreshold();
        if (!deviationExists) {
          this.state.isRebalancing = false;
          context.utils.log.info("Portfolio rebalancing completed");
        }
      }

      context.state.set("portfolioState", this.state);
    }
  }

  async cleanup(context: StrategyContext): Promise<void> {
    context.utils.log.info("Portfolio Strategy cleanup completed");
  }

  private async updateCurrentAllocation(
    context: StrategyContext,
  ): Promise<void> {
    // Get current portfolio from context
    const portfolio = context.portfolio;
    this.state.totalValue = portfolio.totalValue || 0;
    this.state.unrealizedPnL = 0; // Calculate from positions

    // Calculate current allocation percentages
    this.state.currentAllocation.clear();

    if (this.state.totalValue > 0 && portfolio.positions) {
      // Convert positions object to iterable
      const positionsEntries = Object.entries(portfolio.positions);

      for (const [symbol, position] of positionsEntries) {
        const positionValue = position.value || 0;
        const percentage = (positionValue / this.state.totalValue) * 100;
        this.state.currentAllocation.set(symbol, percentage);

        // Add to unrealized PnL
        this.state.unrealizedPnL += position.unrealizedPnl || 0;
      }
    }

    // Ensure all target tokens are represented
    for (const target of this.parameters.allocationTargets) {
      if (!this.state.currentAllocation.has(target.token)) {
        this.state.currentAllocation.set(target.token, 0);
      }
    }
  }

  private checkRebalanceThreshold(): boolean {
    for (const target of this.parameters.allocationTargets) {
      const currentPercent =
        this.state.currentAllocation.get(target.token) || 0;
      const deviation = Math.abs(currentPercent - target.targetPercent);

      if (deviation > this.parameters.rebalanceThreshold) {
        return true;
      }
    }
    return false;
  }

  private checkRiskLimits(): { violations: string[]; forceRebalance: boolean } {
    const violations: string[] = [];
    let forceRebalance = false;

    // Check concentration limits
    if (this.parameters.concentrationLimit) {
      for (const [token, percent] of this.state.currentAllocation) {
        if (percent > this.parameters.concentrationLimit) {
          violations.push(
            `${token} exceeds concentration limit: ${percent.toFixed(1)}% > ${this.parameters.concentrationLimit}%`,
          );
          forceRebalance = true;
        }
      }
    }

    // Check allocation bounds
    for (const target of this.parameters.allocationTargets) {
      const currentPercent =
        this.state.currentAllocation.get(target.token) || 0;

      if (target.minPercent && currentPercent < target.minPercent) {
        violations.push(
          `${target.token} below minimum: ${currentPercent.toFixed(1)}% < ${target.minPercent}%`,
        );
        forceRebalance = true;
      }

      if (target.maxPercent && currentPercent > target.maxPercent) {
        violations.push(
          `${target.token} above maximum: ${currentPercent.toFixed(1)}% > ${target.maxPercent}%`,
        );
        forceRebalance = true;
      }
    }

    return { violations, forceRebalance };
  }

  private generateRebalanceSignals(context: StrategyContext): StrategySignal[] {
    const signals: StrategySignal[] = [];

    for (const target of this.parameters.allocationTargets) {
      const currentPercent =
        this.state.currentAllocation.get(target.token) || 0;
      const targetPercent = target.targetPercent;
      const deviation = currentPercent - targetPercent;

      // Only rebalance if deviation exceeds threshold
      if (Math.abs(deviation) > this.parameters.rebalanceThreshold) {
        const targetValue = (this.state.totalValue * targetPercent) / 100;
        const currentValue = (this.state.totalValue * currentPercent) / 100;
        const tradeValue = Math.abs(targetValue - currentValue);

        // Only execute if trade size meets minimum
        if (tradeValue >= this.parameters.minTradeSize) {
          const action = deviation > 0 ? "sell" : "buy";

          signals.push({
            action,
            pair: target.token,
            quantity: tradeValue,
            orderType: "market",
            confidence: 0.9,
            reason: `Portfolio rebalance: ${action} ${target.token} to reach ${targetPercent}% target`,
            metadata: {
              strategy: "portfolio",
              rebalanceTarget: targetPercent,
              currentAllocation: currentPercent,
              deviation: deviation.toFixed(2),
              tradeValue,
            },
          });
        }
      }
    }

    return signals;
  }

  private updatePerformanceMetrics(context: StrategyContext): void {
    if (this.state.allocationHistory.length < 2) return;

    const history = this.state.allocationHistory;
    const returns: number[] = [];

    // Calculate returns from history
    for (let i = 1; i < history.length; i++) {
      const prevValue = history[i - 1].totalValue;
      const currentValue = history[i].totalValue;
      if (prevValue > 0) {
        const returnPct = (currentValue - prevValue) / prevValue;
        returns.push(returnPct);
      }
    }

    if (returns.length === 0) return;

    // Calculate performance metrics
    const totalReturn = returns.reduce((sum, r) => sum + r, 0);
    const avgReturn = totalReturn / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
      returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252); // Annualized

    // Calculate Sharpe ratio (assuming 3% risk-free rate)
    const riskFreeRate = 0.03;
    const sharpeRatio =
      volatility > 0 ? (avgReturn * 252 - riskFreeRate) / volatility : 0;

    // Calculate max drawdown
    let maxDrawdown = 0;
    let peak = history[0].totalValue;
    for (const point of history) {
      if (point.totalValue > peak) {
        peak = point.totalValue;
      } else {
        const drawdown = (peak - point.totalValue) / peak;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    this.state.performance = {
      totalReturn: totalReturn * 100,
      sharpeRatio,
      maxDrawdown: maxDrawdown * 100,
      volatility: volatility * 100,
    };
  }
}

/**
 * Portfolio Strategy Factory
 */
export class PortfolioStrategyFactory implements IStrategyFactory {
  createStrategy(
    config: StrategyConfig,
    parameters: StrategyParameters,
  ): IStrategy {
    return new PortfolioStrategy();
  }
}

// Export factory instance for registration
export const portfolioStrategyFactory = new PortfolioStrategyFactory();
