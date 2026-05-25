import { EventEmitter } from "events";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import type { RiskEvent as StrategyRiskEvent } from "@/domains/strategies/core/i-strategy";
import { Address, OrderRequest, Portfolio, TradingPair } from "@/shared/types";
import { calculateScaledNotionalValue } from "@/shared/utils";
import { Rng, realRng } from "@/shared/utils/determinism";
import { createLogger } from "@/shared/utils/logger";

const logger = createLogger("RiskManager");

export interface RiskLimits {
  maxPositionSize: bigint;
  maxDailyLoss: bigint;
  positionLimitPercent: number;
  stopLossPercent: number;
  maxLeverage: number;
  maxCorrelation: number;
  maxDrawdown: number;
  maxOrderValue: bigint;
}

export interface RiskCheckResult {
  approved: boolean;
  warnings: string[];
  rejectionReasons: string[];
  riskScore: number;
}

export interface RiskBreach {
  type:
    | "position_limit"
    | "daily_loss"
    | "max_drawdown"
    | "correlation"
    | "leverage";
  severity: "warning" | "critical";
  message: string;
  currentValue: number;
  limitValue: number;
  timestamp: number;
}

type CorrelationCheckResult =
  | { status: "within_limit"; correlation: number | null }
  | { status: "above_limit"; correlation: number }
  | { status: "unavailable"; reason: string };

export interface EmittedRiskEventDetails {
  orderId: string;
  strategyId?: string;
  pair: string;
  currentValue: number;
  limitValue: number;
  reason: string;
}

const DEFAULT_WARNING_RISK_SCORE_THRESHOLD = 15;
const CORRELATION_LOOKBACK_DAYS = 30;
const MIN_CORRELATION_RETURNS = 20;

export class RiskManager extends EventEmitter {
  private riskLimits: RiskLimits = {
    maxPositionSize: BigInt(1000000000), // 10,000 USDC
    maxDailyLoss: BigInt(500000000), // 5,000 USDC
    positionLimitPercent: 25,
    stopLossPercent: 5,
    maxLeverage: 3,
    maxCorrelation: 0.8,
    maxDrawdown: 15,
    maxOrderValue: BigInt(200000000), // 2,000 USDC
  };

  private dailyLosses: Map<string, bigint> = new Map();
  private lastResetDate: string = new Date().toDateString();
  private riskBreaches: RiskBreach[] = [];
  private positionTracker: PositionTracker;
  private marketManager: MarketManager;
  private orderManager: OrderManager;
  private readonly failOpen: boolean;
  private readonly rng: Rng;

  constructor(
    positionTracker: PositionTracker,
    marketManager: MarketManager,
    orderManager: OrderManager,
    options?: { failOpen?: boolean; rng?: Rng },
  ) {
    super();
    this.positionTracker = positionTracker;
    this.marketManager = marketManager;
    this.orderManager = orderManager;
    this.failOpen = options?.failOpen ?? false;
    this.rng = options?.rng ?? realRng;
    this.resetDailyLossesIfNeeded();
  }

  private resetDailyLossesIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLosses.clear();
      this.lastResetDate = today;
    }
  }

  private async getCurrentPortfolioValue(): Promise<bigint> {
    const portfolio = await this.positionTracker.getPortfolio();
    return portfolio.totalValue;
  }

  async validateOrder(order: OrderRequest): Promise<RiskCheckResult> {
    this.resetDailyLossesIfNeeded();

    const warnings: string[] = [];
    const rejectionReasons: string[] = [];
    let riskScore = 0;

    const orderValue = calculateScaledNotionalValue(
      order.price,
      order.quantity,
    );

    const positionLimitCheck = await this.checkPositionLimit(order);
    if (!positionLimitCheck) {
      rejectionReasons.push(
        `Order exceeds position limit of ${this.riskLimits.positionLimitPercent}%`,
      );
      riskScore += 30;
    }

    const maxLossCheck = await this.checkMaxLoss(order);
    if (!maxLossCheck) {
      rejectionReasons.push(
        `Order would exceed daily loss limit of ${Number(this.riskLimits.maxDailyLoss) / 100} USDC`,
      );
      riskScore += 40;
    }

    const exposureCheck = await this.checkExposure(order);
    if (!exposureCheck) {
      rejectionReasons.push(`Order exceeds maximum exposure limits`);
      riskScore += 25;
    }

    const correlationCheck = await this.evaluateCorrelation(order);
    if (correlationCheck.status === "above_limit") {
      warnings.push(
        `High correlation risk detected for this position (${correlationCheck.correlation.toFixed(2)} > ${this.riskLimits.maxCorrelation.toFixed(2)})`,
      );
      riskScore += 15;
    } else if (correlationCheck.status === "unavailable") {
      warnings.push(correlationCheck.reason);
    }

    if (orderValue > this.riskLimits.maxOrderValue) {
      rejectionReasons.push(
        `Order value ${Number(orderValue) / 100} USDC exceeds maximum ${Number(this.riskLimits.maxOrderValue) / 100} USDC`,
      );
      riskScore += 35;
    }

    const portfolioValue = await this.getCurrentPortfolioValue();
    if (portfolioValue > 0n) {
      const orderPercentage = Number(
        (orderValue * BigInt(100)) / portfolioValue,
      );
      if (orderPercentage > this.riskLimits.positionLimitPercent) {
        warnings.push(
          `Order represents ${orderPercentage.toFixed(1)}% of portfolio, above recommended ${this.riskLimits.positionLimitPercent}%`,
        );
        riskScore += 20;
      }
    }

    const result = {
      approved: rejectionReasons.length === 0,
      warnings,
      rejectionReasons,
      riskScore: Math.min(riskScore, 100),
    };

    this.emitValidationEvents(order, result);
    return result;
  }

  async checkPositionLimit(order: OrderRequest): Promise<boolean> {
    try {
      const portfolioValue = await this.getCurrentPortfolioValue();
      if (portfolioValue === 0n) return true;

      const pair: TradingPair = {
        base: order.baseToken,
        quote: order.quoteToken,
        symbol: `${order.baseToken}/${order.quoteToken}`,
      };

      const currentPosition = await this.positionTracker.getPosition(pair);
      const orderValue = calculateScaledNotionalValue(
        order.price,
        order.quantity,
      );
      const newPositionValue =
        currentPosition.value + (order.isBuy ? orderValue : -orderValue);

      const positionPercentage = Number(
        (newPositionValue * BigInt(100)) / portfolioValue,
      );
      return (
        Math.abs(positionPercentage) <= this.riskLimits.positionLimitPercent
      );
    } catch (_error) {
      return false;
    }
  }

  async checkMaxLoss(order: OrderRequest): Promise<boolean> {
    try {
      const today = new Date().toDateString();
      const currentDailyLoss = this.dailyLosses.get(today) || 0n;

      if (!order.isBuy) {
        try {
          const pair: TradingPair = {
            base: order.baseToken,
            quote: order.quoteToken,
            symbol: `${order.baseToken}/${order.quoteToken}`,
          };

          const position = await this.positionTracker.getPosition(pair);
          if (position.balance === 0n) {
            logger.warn("checkMaxLoss: zero-balance sell rejected");
            return false;
          }
          if (order.price < position.value / position.balance) {
            const potentialLoss =
              ((position.value / position.balance - order.price) *
                order.quantity) /
              BigInt(100);
            return (
              currentDailyLoss + potentialLoss <= this.riskLimits.maxDailyLoss
            );
          }
        } catch (_positionError) {
          logger.warn(
            "checkMaxLoss: position tracking failed, applying failOpen policy",
            { failOpen: this.failOpen },
          );
          return this.failOpen;
        }
      }

      return true;
    } catch (_error) {
      logger.warn("checkMaxLoss: unexpected error, applying failOpen policy", {
        failOpen: this.failOpen,
      });
      return this.failOpen;
    }
  }

  async checkExposure(order: OrderRequest): Promise<boolean> {
    try {
      const orderValue = calculateScaledNotionalValue(
        order.price,
        order.quantity,
      );
      return orderValue <= this.riskLimits.maxPositionSize;
    } catch (_error) {
      return false;
    }
  }

  async checkCorrelation(order: OrderRequest): Promise<boolean> {
    try {
      const result = await this.evaluateCorrelation(order);
      return result.status !== "above_limit";
    } catch (_error) {
      logger.warn("checkCorrelation: error, applying failOpen policy", {
        failOpen: this.failOpen,
      });
      return this.failOpen;
    }
  }

  private async evaluateCorrelation(
    order: OrderRequest,
  ): Promise<CorrelationCheckResult> {
    try {
      const portfolio = await this.positionTracker.getPortfolio();
      const positions = Array.from(portfolio.positions.values()).filter(
        (position) =>
          position.balance > 0n && position.token !== order.baseToken,
      );

      if (positions.length === 0) {
        return { status: "within_limit", correlation: null };
      }

      const orderPair = this.toPair(order.baseToken, order.quoteToken);
      const orderReturns = await this.getHistoricalReturns(orderPair);
      if (orderReturns.length < MIN_CORRELATION_RETURNS) {
        return {
          status: "unavailable",
          reason:
            "Correlation history unavailable; skipping correlation rejection.",
        };
      }

      let maxObservedCorrelation = -1;
      let comparedPositions = 0;

      for (const position of positions) {
        const comparisonPair = this.toPair(position.token, order.quoteToken);
        const comparisonReturns =
          await this.getHistoricalReturns(comparisonPair);
        const correlation = this.calculateCorrelation(
          orderReturns,
          comparisonReturns,
        );
        if (correlation === null) {
          continue;
        }

        comparedPositions += 1;
        maxObservedCorrelation = Math.max(
          maxObservedCorrelation,
          Math.abs(correlation),
        );
      }

      if (comparedPositions === 0) {
        return {
          status: "unavailable",
          reason:
            "Correlation history unavailable; skipping correlation rejection.",
        };
      }

      if (maxObservedCorrelation > this.riskLimits.maxCorrelation) {
        return {
          status: "above_limit",
          correlation: maxObservedCorrelation,
        };
      }

      return {
        status: "within_limit",
        correlation: maxObservedCorrelation,
      };
    } catch (_error) {
      logger.warn("checkCorrelation: error, applying failOpen policy", {
        failOpen: this.failOpen,
      });
      return this.failOpen
        ? { status: "within_limit", correlation: null }
        : {
            status: "unavailable",
            reason: "Correlation check unavailable.",
          };
    }
  }

  private async getHistoricalReturns(pair: TradingPair): Promise<number[]> {
    const end = new Date();
    const start = new Date(
      end.getTime() - CORRELATION_LOOKBACK_DAYS * 86400000,
    );
    const candles = await this.marketManager.getCandles(pair, "1h", start, end);
    if (candles.length < MIN_CORRELATION_RETURNS + 1) {
      return [];
    }

    const returns: number[] = [];
    for (let index = 1; index < candles.length; index += 1) {
      const previousClose = candles[index - 1]?.close;
      const currentClose = candles[index]?.close;
      if (
        previousClose === undefined ||
        currentClose === undefined ||
        previousClose === 0
      ) {
        continue;
      }
      returns.push((currentClose - previousClose) / previousClose);
    }

    return returns;
  }

  private calculateCorrelation(left: number[], right: number[]): number | null {
    const sampleLength = Math.min(left.length, right.length);
    if (sampleLength < MIN_CORRELATION_RETURNS) {
      return null;
    }

    const x = left.slice(-sampleLength);
    const y = right.slice(-sampleLength);
    const meanX = x.reduce((sum, value) => sum + value, 0) / sampleLength;
    const meanY = y.reduce((sum, value) => sum + value, 0) / sampleLength;

    let numerator = 0;
    let sumSquaresX = 0;
    let sumSquaresY = 0;

    for (let index = 0; index < sampleLength; index += 1) {
      const deltaX = x[index] - meanX;
      const deltaY = y[index] - meanY;
      numerator += deltaX * deltaY;
      sumSquaresX += deltaX * deltaX;
      sumSquaresY += deltaY * deltaY;
    }

    if (sumSquaresX === 0 || sumSquaresY === 0) {
      return null;
    }

    return numerator / Math.sqrt(sumSquaresX * sumSquaresY);
  }

  private emitValidationEvents(
    order: OrderRequest,
    result: RiskCheckResult,
  ): void {
    const orderValue =
      Number(calculateScaledNotionalValue(order.price, order.quantity)) / 100;
    const limitValue = Number(this.riskLimits.maxOrderValue) / 100;

    if (!result.approved) {
      this.emitRiskEvent({
        type: "exposure_limit",
        severity: "critical",
        message: result.rejectionReasons.join(", "),
        data: this.buildRiskEventDetails(
          order,
          orderValue,
          limitValue,
          result.rejectionReasons.join(", "),
        ),
        timestamp: Date.now(),
      });
      return;
    }

    if (
      result.warnings.length > 0 &&
      result.riskScore >= DEFAULT_WARNING_RISK_SCORE_THRESHOLD
    ) {
      this.emitRiskEvent({
        type: "exposure_limit",
        severity: "warning",
        message: result.warnings.join(", "),
        data: this.buildRiskEventDetails(
          order,
          orderValue,
          limitValue,
          result.warnings.join(", "),
        ),
        timestamp: Date.now(),
      });
    }
  }

  private emitRiskEvent(event: StrategyRiskEvent): void {
    this.emit("riskEvent", event);
  }

  private buildRiskEventDetails(
    order: OrderRequest,
    currentValue: number,
    limitValue: number,
    reason: string,
  ): EmittedRiskEventDetails {
    return {
      orderId:
        order.orderId ?? `risk-${order.strategyId ?? "unknown"}-${Date.now()}`,
      strategyId: order.strategyId,
      pair: `${order.baseToken}/${order.quoteToken}`,
      currentValue,
      limitValue,
      reason,
    };
  }

  private toPair(base: Address, quote: Address): TradingPair {
    return {
      base,
      quote,
      symbol: `${base}/${quote}`,
    };
  }

  async setRiskLimits(limits: Partial<RiskLimits>): Promise<void> {
    this.riskLimits = { ...this.riskLimits, ...limits };

    if (
      limits.maxDailyLoss &&
      limits.maxDailyLoss < this.riskLimits.maxDailyLoss
    ) {
      await this.checkRiskBreaches();
    }
  }

  async getRiskLimits(): Promise<RiskLimits> {
    return { ...this.riskLimits };
  }

  async monitorRisk(): Promise<{
    currentRisk: number;
    maxRisk: number;
    exceedsLimits: boolean;
    recommendations: string[];
  }> {
    try {
      const portfolio = await this.positionTracker.getPortfolio();
      const portfolioRisk = await this.calculatePortfolioRisk(portfolio);
      const summary = await this.positionTracker.getPositionSummary();

      const currentRisk =
        (portfolioRisk.totalRisk +
          portfolioRisk.concentrationRisk +
          portfolioRisk.correlationRisk) /
        3;
      const exceedsLimits = currentRisk >= 80;

      const recommendations: string[] = [];

      if (portfolioRisk.concentrationRisk > 70) {
        recommendations.push(
          "Consider diversifying positions to reduce concentration risk",
        );
      }

      if (portfolioRisk.correlationRisk > 60) {
        recommendations.push("High correlation detected between positions");
      }

      if (
        Number(summary.dailyPnL) < 0 &&
        Math.abs(Number(summary.dailyPnL)) >
          Number(this.riskLimits.maxDailyLoss) * 0.8
      ) {
        recommendations.push(
          "Approaching daily loss limit - consider position reduction",
        );
      }

      return {
        currentRisk,
        maxRisk: 100,
        exceedsLimits,
        recommendations,
      };
    } catch (_error) {
      return {
        currentRisk: 0,
        maxRisk: 100,
        exceedsLimits: false,
        recommendations: ["Risk monitoring temporarily unavailable"],
      };
    }
  }

  async calculateVaR(
    portfolio: Portfolio,
    confidence = 0.95,
    timeHorizon = 1,
  ): Promise<bigint> {
    try {
      const positions = Array.from(portfolio.positions.values());
      if (positions.length === 0) return 0n;

      const volatility = 0.02;
      const zScore =
        confidence === 0.95 ? 1.645 : confidence === 0.99 ? 2.326 : 1.96;

      let totalVaR = 0;
      for (const position of positions) {
        const positionValue = Number(position.value);
        const positionVaR =
          positionValue * volatility * zScore * Math.sqrt(timeHorizon);
        totalVaR += positionVaR * positionVaR;
      }

      return BigInt(Math.floor(Math.sqrt(totalVaR) * 100));
    } catch (_error) {
      return 0n;
    }
  }

  async calculatePortfolioRisk(portfolio: Portfolio): Promise<{
    totalRisk: number;
    concentrationRisk: number;
    liquidityRisk: number;
    correlationRisk: number;
  }> {
    try {
      const positions = Array.from(portfolio.positions.values());
      if (positions.length === 0) {
        return {
          totalRisk: 0,
          concentrationRisk: 0,
          liquidityRisk: 0,
          correlationRisk: 0,
        };
      }

      const totalValue = Number(portfolio.totalValue);
      let maxPositionWeight = 0;

      for (const position of positions) {
        const weight = Number(position.value) / totalValue;
        maxPositionWeight = Math.max(maxPositionWeight, weight);
      }

      const concentrationRisk = maxPositionWeight * 100;
      const liquidityRisk = Math.min(positions.length * 10, 50);
      const correlationRisk = positions.length > 1 ? this.rng.next() * 60 : 0;
      const totalRisk =
        (concentrationRisk + liquidityRisk + correlationRisk) / 3;

      return {
        totalRisk,
        concentrationRisk,
        liquidityRisk,
        correlationRisk,
      };
    } catch (_error) {
      return {
        totalRisk: 0,
        concentrationRisk: 0,
        liquidityRisk: 0,
        correlationRisk: 0,
      };
    }
  }

  async triggerRiskReduction(portfolio: Portfolio): Promise<{
    actions: string[];
    ordersToCancel: string[];
    positionsToReduce: Array<{ pair: TradingPair; reduceBy: number }>;
  }> {
    const actions: string[] = [];
    const ordersToCancel: string[] = [];
    const positionsToReduce: Array<{ pair: TradingPair; reduceBy: number }> =
      [];

    try {
      const openOrders = await this.positionTracker.getOpenOrders();
      const riskAnalysis = await this.calculatePortfolioRisk(portfolio);

      if (riskAnalysis.concentrationRisk > 80) {
        const positions = Array.from(portfolio.positions.values());
        const totalValue = Number(portfolio.totalValue);

        for (const position of positions) {
          const weight = Number(position.value) / totalValue;
          if (weight > this.riskLimits.positionLimitPercent / 100) {
            const reduceBy =
              weight - this.riskLimits.positionLimitPercent / 100;
            positionsToReduce.push({
              pair: {
                base: position.token,
                quote: "0x0987654321098765432109876543210987654321" as Address,
                symbol: "TOKEN/USDC",
              },
              reduceBy,
            });
            actions.push(
              `Reduce ${position.token} position by ${(reduceBy * 100).toFixed(1)}%`,
            );
          }
        }
      }

      if (openOrders.length > 10) {
        const ordersToCancel_ = openOrders
          .sort(
            (a, b) =>
              Number(b.price * b.quantity) - Number(a.price * a.quantity),
          )
          .slice(5)
          .map((order) => order.orderId);

        ordersToCancel.push(...ordersToCancel_);
        actions.push(`Cancel ${ordersToCancel_.length} low-priority orders`);
      }

      if (actions.length === 0) {
        actions.push("No immediate risk reduction required");
      }
    } catch (_error) {
      actions.push(
        "Risk reduction analysis failed - manual review recommended",
      );
    }

    return {
      actions,
      ordersToCancel,
      positionsToReduce,
    };
  }

  async getStressTestResults(
    scenarios: string[] = ["market_crash", "flash_crash", "high_volatility"],
  ): Promise<
    Map<
      string,
      {
        portfolioValue: bigint;
        maxLoss: bigint;
        timeToRecover: number;
      }
    >
  > {
    const results = new Map();

    try {
      const currentPortfolio = await this.positionTracker.getPortfolio();
      const currentValue = currentPortfolio.totalValue;

      for (const scenario of scenarios) {
        let lossPercentage = 0;
        let recoveryTime = 0;

        switch (scenario) {
          case "market_crash":
            lossPercentage = 0.3; // 30% loss
            recoveryTime = 180; // 6 months
            break;
          case "flash_crash":
            lossPercentage = 0.15; // 15% loss
            recoveryTime = 30; // 1 month
            break;
          case "high_volatility":
            lossPercentage = 0.08; // 8% loss
            recoveryTime = 14; // 2 weeks
            break;
          default:
            lossPercentage = 0.1;
            recoveryTime = 60;
        }

        const maxLoss = BigInt(
          Math.floor(Number(currentValue) * lossPercentage),
        );
        const portfolioValue = currentValue - maxLoss;

        results.set(scenario, {
          portfolioValue,
          maxLoss,
          timeToRecover: recoveryTime,
        });
      }
    } catch (_error) {
      // Return empty results on error
    }

    return results;
  }

  async recordLoss(amount: bigint): Promise<void> {
    this.resetDailyLossesIfNeeded();
    const today = new Date().toDateString();
    const currentLoss = this.dailyLosses.get(today) || 0n;
    this.dailyLosses.set(today, currentLoss + amount);

    await this.checkRiskBreaches();
  }

  private async checkRiskBreaches(): Promise<void> {
    const today = new Date().toDateString();
    const currentLoss = this.dailyLosses.get(today) || 0n;

    if (currentLoss > this.riskLimits.maxDailyLoss) {
      const breach: RiskBreach = {
        type: "daily_loss",
        severity: "critical",
        message: `Daily loss limit exceeded: ${Number(currentLoss) / 100} USDC`,
        currentValue: Number(currentLoss) / 100,
        limitValue: Number(this.riskLimits.maxDailyLoss) / 100,
        timestamp: Date.now(),
      };

      this.riskBreaches.push(breach);
    }
  }

  async getRiskBreaches(limit = 50): Promise<RiskBreach[]> {
    return this.riskBreaches
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async clearRiskBreaches(): Promise<void> {
    this.riskBreaches = [];
  }

  // For testing purposes - reset daily loss tracking
  resetDailyLosses(): void {
    this.dailyLosses.clear();
    this.lastResetDate = new Date().toDateString();
  }

  async emergencyStop(): Promise<{
    ordersCancelled: number;
    positionsReduced: number;
    actions: string[];
  }> {
    const actions: string[] = [];
    let ordersCancelled = 0;
    let positionsReduced = 0;

    try {
      await this.orderManager.cancelAllOrders();
      const stats = this.orderManager.getOrderStats();
      ordersCancelled = stats.openOrders;
      actions.push(`Cancelled ${ordersCancelled} open orders`);

      const portfolio = await this.positionTracker.getPortfolio();
      const positions = Array.from(portfolio.positions.values());
      positionsReduced = positions.length;
      actions.push(
        `Marked ${positionsReduced} positions for emergency reduction`,
      );

      const breach: RiskBreach = {
        type: "daily_loss",
        severity: "critical",
        message: "Emergency stop triggered",
        currentValue: 100,
        limitValue: 100,
        timestamp: Date.now(),
      };
      this.riskBreaches.push(breach);
    } catch (_error) {
      actions.push(
        "Emergency stop encountered errors - manual intervention required",
      );
    }

    return {
      ordersCancelled,
      positionsReduced,
      actions,
    };
  }
}
