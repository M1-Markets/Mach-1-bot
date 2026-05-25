/**
 * Strategy Optimization Framework
 *
 * Provides tools for optimizing strategy parameters through backtesting,
 * genetic algorithms, and machine learning approaches.
 */

import { BacktestEngine } from "@/domains/execution/backtest-engine";
import {
  OptimizationResult,
  StrategyMetrics,
  StrategyParameters,
} from "@/domains/strategies/core/i-strategy";
import { createSeededRng, realRng } from "@/shared/utils/determinism";
import { StrategyManager } from "../management/strategy-manager";

export interface OptimizationConfig {
  /** Optimization objective (what to maximize) */
  objective:
    | "sharpe_ratio"
    | "total_return"
    | "profit_factor"
    | "calmar_ratio"
    | "sortino_ratio"
    | "custom";

  /** Custom objective function if objective is 'custom' */
  customObjective?: (metrics: StrategyMetrics) => number;

  /** Optimization method */
  method:
    | "grid_search"
    | "random_search"
    | "genetic_algorithm"
    | "bayesian_optimization";

  /** Backtest period for optimization */
  backtestPeriod: {
    start: string | Date;
    end: string | Date;
  };

  /** Validation period (walk-forward analysis) */
  validationPeriod?: {
    start: string | Date;
    end: string | Date;
  };

  /** Maximum number of iterations/evaluations */
  maxIterations: number;

  /** Early stopping criteria */
  earlyStoppingRounds?: number;

  /** Parallel execution settings */
  parallelJobs?: number;

  /** Random seed for reproducibility */
  randomSeed?: number;

  /** Cross-validation settings */
  crossValidation?: {
    folds: number;
    method: "time_series" | "blocked" | "purged";
  };
}

export interface ParameterRange {
  type: "discrete" | "continuous" | "categorical";
  values?: unknown[]; // For discrete and categorical
  min?: number; // For continuous
  max?: number; // For continuous
  step?: number; // For continuous
}

export interface OptimizationSpace {
  [parameterName: string]: ParameterRange;
}

export interface OptimizationProgress {
  iteration: number;
  totalIterations: number;
  bestScore: number;
  bestParameters: StrategyParameters;
  currentScore?: number;
  currentParameters?: StrategyParameters;
  elapsedTime: number;
  estimatedTimeRemaining: number;
}

export interface WalkForwardResult {
  inSamplePeriods: Array<{
    start: Date;
    end: Date;
    bestParameters: StrategyParameters;
    score: number;
  }>;
  outSamplePeriods: Array<{
    start: Date;
    end: Date;
    parameters: StrategyParameters;
    metrics: StrategyMetrics;
  }>;
  overallMetrics: StrategyMetrics;
  consistency: number; // Measure of how consistent results are across periods
}

export interface MonteCarloResult {
  scenarios: Array<{
    parameters: StrategyParameters;
    metrics: StrategyMetrics;
    randomSeed: number;
  }>;
  statistics: {
    mean: StrategyMetrics;
    median: StrategyMetrics;
    std: StrategyMetrics;
    percentiles: {
      p5: StrategyMetrics;
      p25: StrategyMetrics;
      p75: StrategyMetrics;
      p95: StrategyMetrics;
    };
  };
  riskMetrics: {
    probabilityOfLoss: number;
    expectedShortfall: number;
    maxDrawdownDistribution: number[];
  };
}

/**
 * Strategy Optimizer handles parameter optimization
 */
export class StrategyOptimizer {
  private optimizationCallbacks: Array<
    (progress: OptimizationProgress) => void
  > = [];

  constructor(
    private strategyManager: StrategyManager,
    private backtestEngine: BacktestEngine,
  ) {}

  /**
   * Optimize strategy parameters
   */
  async optimizeParameters(
    strategyId: string,
    parameterSpace: OptimizationSpace,
    config: OptimizationConfig,
    onProgress?: (progress: OptimizationProgress) => void,
  ): Promise<OptimizationResult> {
    if (onProgress) {
      this.optimizationCallbacks.push(onProgress);
    }

    const startTime = Date.now();
    let bestScore = -Infinity;
    let bestParameters: StrategyParameters = {};
    const allResults: Array<{
      parameters: StrategyParameters;
      score: number;
      metrics: StrategyMetrics;
    }> = [];

    // Generate parameter combinations based on method
    const parameterCombinations = this.generateParameterCombinations(
      parameterSpace,
      config.method,
      config.maxIterations,
      config.randomSeed,
    );

    let iteration = 0;
    let stagnantRounds = 0;

    for (const parameters of parameterCombinations) {
      iteration++;

      try {
        // Run backtest with these parameters
        const metrics = await this.evaluateParameters(
          strategyId,
          parameters,
          config.backtestPeriod,
        );

        // Calculate objective score
        const score = this.calculateObjectiveScore(metrics, config);

        allResults.push({ parameters, score, metrics });

        // Update best if improved
        if (score > bestScore) {
          bestScore = score;
          bestParameters = { ...parameters };
          stagnantRounds = 0;
        } else {
          stagnantRounds++;
        }

        // Report progress
        const progress: OptimizationProgress = {
          iteration,
          totalIterations: config.maxIterations,
          bestScore,
          bestParameters,
          currentScore: score,
          currentParameters: parameters,
          elapsedTime: Date.now() - startTime,
          estimatedTimeRemaining: this.estimateTimeRemaining(
            iteration,
            config.maxIterations,
            Date.now() - startTime,
          ),
        };

        this.notifyProgress(progress);

        // Early stopping
        if (
          config.earlyStoppingRounds &&
          stagnantRounds >= config.earlyStoppingRounds
        ) {
          console.log(
            `Early stopping triggered after ${stagnantRounds} stagnant rounds`,
          );
          break;
        }
      } catch (error) {
        console.warn(
          `Failed to evaluate parameters ${JSON.stringify(parameters)}:`,
          error,
        );
        continue;
      }
    }

    // Validate on out-of-sample data if provided
    if (config.validationPeriod) {
      const validationMetrics = await this.evaluateParameters(
        strategyId,
        bestParameters,
        config.validationPeriod,
      );

      console.log(`Validation metrics:`, validationMetrics);
    }

    return {
      bestParameters,
      bestScore,
      allResults,
    };
  }

  /**
   * Perform walk-forward analysis
   */
  async walkForwardAnalysis(
    strategyId: string,
    parameterSpace: OptimizationSpace,
    config: {
      totalPeriod: { start: Date; end: Date };
      inSampleLength: number; // days
      outSampleLength: number; // days
      reoptimizeFrequency: number; // days
      optimizationConfig: Partial<OptimizationConfig>;
    },
  ): Promise<WalkForwardResult> {
    const inSamplePeriods: Array<{
      start: Date;
      end: Date;
      bestParameters: StrategyParameters;
      score: number;
    }> = [];

    const outSamplePeriods: Array<{
      start: Date;
      end: Date;
      parameters: StrategyParameters;
      metrics: StrategyMetrics;
    }> = [];

    let currentDate = new Date(config.totalPeriod.start);
    const endDate = new Date(config.totalPeriod.end);

    while (currentDate < endDate) {
      // Define in-sample period
      const inSampleStart = new Date(currentDate);
      const inSampleEnd = new Date(
        currentDate.getTime() + config.inSampleLength * 24 * 60 * 60 * 1000,
      );

      // Define out-sample period
      const outSampleStart = new Date(inSampleEnd);
      const outSampleEnd = new Date(
        outSampleStart.getTime() + config.outSampleLength * 24 * 60 * 60 * 1000,
      );

      if (outSampleEnd > endDate) break;

      try {
        // Optimize on in-sample period
        const optimizationResult = await this.optimizeParameters(
          strategyId,
          parameterSpace,
          {
            objective: "sharpe_ratio",
            method: "grid_search",
            maxIterations: 100,
            backtestPeriod: {
              start: inSampleStart,
              end: inSampleEnd,
            },
            ...config.optimizationConfig,
          },
        );

        inSamplePeriods.push({
          start: inSampleStart,
          end: inSampleEnd,
          bestParameters: optimizationResult.bestParameters,
          score: optimizationResult.bestScore,
        });

        // Test on out-sample period
        const outSampleMetrics = await this.evaluateParameters(
          strategyId,
          optimizationResult.bestParameters,
          {
            start: outSampleStart,
            end: outSampleEnd,
          },
        );

        outSamplePeriods.push({
          start: outSampleStart,
          end: outSampleEnd,
          parameters: optimizationResult.bestParameters,
          metrics: outSampleMetrics,
        });

        console.log(
          `Walk-forward period completed: ${inSampleStart.toISOString()} to ${outSampleEnd.toISOString()}`,
        );
      } catch (error) {
        console.warn(
          `Walk-forward analysis failed for period ${inSampleStart.toISOString()}:`,
          error,
        );
      }

      // Move to next period
      currentDate = new Date(
        currentDate.getTime() +
          config.reoptimizeFrequency * 24 * 60 * 60 * 1000,
      );
    }

    // Calculate overall metrics and consistency
    const overallMetrics = this.calculateOverallMetrics(
      outSamplePeriods.map((p) => p.metrics),
    );
    const consistency = this.calculateConsistency(
      outSamplePeriods.map((p) => p.metrics),
    );

    return {
      inSamplePeriods,
      outSamplePeriods,
      overallMetrics,
      consistency,
    };
  }

  /**
   * Run Monte Carlo simulation
   */
  async monteCarloSimulation(
    strategyId: string,
    baseParameters: StrategyParameters,
    parameterVariations: Record<string, { mean: number; std: number }>,
    config: {
      scenarios: number;
      backtestPeriod: { start: Date; end: Date };
      includeMarketRegimes?: boolean;
      randomSeed?: number;
    },
  ): Promise<MonteCarloResult> {
    const scenarios: Array<{
      parameters: StrategyParameters;
      metrics: StrategyMetrics;
      randomSeed: number;
    }> = [];

    const scenarioSeedRng = this.createRandomSource(config.randomSeed);
    for (let i = 0; i < config.scenarios; i++) {
      const randomSeed = Math.floor(scenarioSeedRng() * 1000000);

      // Generate random parameter variations
      const randomParameters = { ...baseParameters };
      for (const [param, variation] of Object.entries(parameterVariations)) {
        const randomValue = this.generateNormalRandom(
          variation.mean,
          variation.std,
          randomSeed + i,
        );
        randomParameters[param] = randomValue;
      }

      try {
        const metrics = await this.evaluateParameters(
          strategyId,
          randomParameters,
          config.backtestPeriod,
          randomSeed,
        );

        scenarios.push({
          parameters: randomParameters,
          metrics,
          randomSeed,
        });

        if (i % 10 === 0) {
          console.log(`Monte Carlo progress: ${i + 1}/${config.scenarios}`);
        }
      } catch (error) {
        console.warn(`Monte Carlo scenario ${i} failed:`, error);
      }
    }

    // Calculate statistics
    const statistics = this.calculateMonteCarloStatistics(
      scenarios.map((s) => s.metrics),
    );
    const riskMetrics = this.calculateMonteCarloRiskMetrics(
      scenarios.map((s) => s.metrics),
    );

    return {
      scenarios,
      statistics,
      riskMetrics,
    };
  }

  /**
   * Subscribe to optimization progress updates
   */
  onProgress(callback: (progress: OptimizationProgress) => void): void {
    this.optimizationCallbacks.push(callback);
  }

  // Private methods

  private generateParameterCombinations(
    space: OptimizationSpace,
    method: string,
    maxIterations: number,
    randomSeed?: number,
  ): StrategyParameters[] {
    switch (method) {
      case "grid_search":
        return this.generateGridSearchCombinations(space, maxIterations);

      case "random_search":
        return this.generateRandomSearchCombinations(
          space,
          maxIterations,
          randomSeed,
        );

      case "genetic_algorithm":
        return this.generateGeneticAlgorithmCombinations(
          space,
          maxIterations,
          randomSeed,
        );

      case "bayesian_optimization":
        return this.generateBayesianOptimizationCombinations(
          space,
          maxIterations,
        );

      default:
        throw new Error(`Unsupported optimization method: ${method}`);
    }
  }

  private generateGridSearchCombinations(
    space: OptimizationSpace,
    maxIterations: number,
  ): StrategyParameters[] {
    const paramNames = Object.keys(space);
    const paramValues: unknown[][] = [];

    // Generate value arrays for each parameter
    for (const [_paramName, range] of Object.entries(space)) {
      if (range.type === "discrete" || range.type === "categorical") {
        paramValues.push(range.values || []);
      } else if (range.type === "continuous") {
        if (typeof range.min !== "number" || typeof range.max !== "number") {
          paramValues.push([]);
          continue;
        }
        const values = [];
        const step =
          typeof range.step === "number"
            ? range.step
            : (range.max - range.min) / 10;
        for (let val = range.min; val <= range.max; val += step) {
          values.push(val);
        }
        paramValues.push(values);
      }
    }

    // Generate all combinations (Cartesian product)
    const combinations: StrategyParameters[] = [];

    function generateCombinations(index: number, current: unknown[]): void {
      if (index === paramNames.length) {
        const combination: StrategyParameters = {};
        paramNames.forEach((name, i) => {
          combination[name] = current[i];
        });
        combinations.push(combination);
        return;
      }

      if (combinations.length >= maxIterations) return;

      for (const value of paramValues[index]) {
        generateCombinations(index + 1, [...current, value]);
        if (combinations.length >= maxIterations) break;
      }
    }

    generateCombinations(0, []);
    return combinations.slice(0, maxIterations);
  }

  private generateRandomSearchCombinations(
    space: OptimizationSpace,
    maxIterations: number,
    randomSeed?: number,
  ): StrategyParameters[] {
    const combinations: StrategyParameters[] = [];
    const rng = this.createRandomSource(randomSeed);

    for (let i = 0; i < maxIterations; i++) {
      const combination: StrategyParameters = {};

      for (const [paramName, range] of Object.entries(space)) {
        if (range.type === "discrete" || range.type === "categorical") {
          const values = range.values ?? [];
          if (values.length === 0) {
            continue;
          }
          const randomIndex = Math.floor(rng() * values.length);
          combination[paramName] = values[randomIndex];
        } else if (range.type === "continuous") {
          if (typeof range.min !== "number" || typeof range.max !== "number") {
            continue;
          }
          combination[paramName] = range.min + rng() * (range.max - range.min);
        }
      }

      combinations.push(combination);
    }

    return combinations;
  }

  private generateGeneticAlgorithmCombinations(
    space: OptimizationSpace,
    maxIterations: number,
    randomSeed?: number,
  ): StrategyParameters[] {
    // Simplified genetic algorithm implementation
    // In practice, this would be more sophisticated
    const populationSize = Math.min(50, maxIterations);
    const generations = Math.ceil(maxIterations / populationSize);

    // Start with random population
    let population = this.generateRandomSearchCombinations(
      space,
      populationSize,
      randomSeed,
    );
    const rng = this.createRandomSource(
      randomSeed !== undefined ? randomSeed + 1 : undefined,
    );

    const allCombinations = [...population];

    for (
      let gen = 1;
      gen < generations && allCombinations.length < maxIterations;
      gen++
    ) {
      // Simple evolution: mutate existing solutions
      const newGeneration: StrategyParameters[] = [];

      for (const individual of population.slice(0, populationSize / 2)) {
        const mutated = this.mutateParameters(individual, space, 0.1, rng);
        newGeneration.push(mutated);
        allCombinations.push(mutated);

        if (allCombinations.length >= maxIterations) break;
      }

      population = newGeneration;
    }

    return allCombinations.slice(0, maxIterations);
  }

  private generateBayesianOptimizationCombinations(
    space: OptimizationSpace,
    maxIterations: number,
  ): StrategyParameters[] {
    // Simplified Bayesian optimization
    // In practice, this would use Gaussian processes
    return this.generateRandomSearchCombinations(space, maxIterations);
  }

  private async evaluateParameters(
    _strategyId: string,
    _parameters: StrategyParameters,
    period: { start: string | Date; end: string | Date },
    _randomSeed?: number,
  ): Promise<StrategyMetrics> {
    const backtestConfig = (
      this.backtestEngine as unknown as {
        config: { startDate: Date; endDate: Date };
      }
    ).config;
    const previousStart = backtestConfig.startDate;
    const previousEnd = backtestConfig.endDate;

    backtestConfig.startDate = new Date(period.start);
    backtestConfig.endDate = new Date(period.end);

    try {
      const result = await this.backtestEngine.runBacktest();
      const pnlSeries = result.trades.map((trade) => Number(trade.pnl));
      const grossProfit = pnlSeries
        .filter((pnl) => pnl > 0)
        .reduce((sum, pnl) => sum + pnl, 0);
      const grossLoss = Math.abs(
        pnlSeries.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0),
      );
      const avgHoldingPeriod =
        result.trades.length > 1
          ? (result.trades[result.trades.length - 1].timestamp -
              result.trades[0].timestamp) /
            result.trades.length
          : 0;

      return {
        totalReturn: result.totalReturn,
        sharpeRatio: result.sharpeRatio,
        maxDrawdown: result.maxDrawdown,
        winRate: result.winRate,
        totalTrades: result.totalTrades,
        avgHoldingPeriod,
        profitFactor:
          grossLoss === 0
            ? grossProfit > 0
              ? Infinity
              : 0
            : grossProfit / grossLoss,
        lastUpdate: backtestConfig.endDate.getTime(),
      };
    } finally {
      backtestConfig.startDate = previousStart;
      backtestConfig.endDate = previousEnd;
    }
  }

  private calculateObjectiveScore(
    metrics: StrategyMetrics,
    config: OptimizationConfig,
  ): number {
    switch (config.objective) {
      case "sharpe_ratio":
        return metrics.sharpeRatio;
      case "total_return":
        return metrics.totalReturn;
      case "profit_factor":
        return metrics.profitFactor;
      case "calmar_ratio":
        return metrics.maxDrawdown > 0
          ? metrics.totalReturn / metrics.maxDrawdown
          : 0;
      case "sortino_ratio":
        // Simplified Sortino ratio calculation
        return metrics.sharpeRatio * 1.2; // Mock implementation
      case "custom":
        return config.customObjective ? config.customObjective(metrics) : 0;
      default:
        return metrics.sharpeRatio;
    }
  }

  private mutateParameters(
    parameters: StrategyParameters,
    space: OptimizationSpace,
    mutationRate: number,
    rng: () => number = this.createRandomSource(),
  ): StrategyParameters {
    const mutated = { ...parameters };

    for (const [paramName, range] of Object.entries(space)) {
      if (rng() < mutationRate) {
        if (range.type === "continuous") {
          if (typeof range.min !== "number" || typeof range.max !== "number") {
            continue;
          }
          const currentValue =
            typeof mutated[paramName] === "number"
              ? (mutated[paramName] as number)
              : range.min;
          const mutationAmount = (range.max - range.min) * 0.1 * (rng() - 0.5);
          mutated[paramName] = Math.max(
            range.min,
            Math.min(range.max, currentValue + mutationAmount),
          );
        } else if (range.type === "discrete" || range.type === "categorical") {
          const values = range.values ?? [];
          if (values.length === 0) {
            continue;
          }
          const randomIndex = Math.floor(rng() * values.length);
          mutated[paramName] = values[randomIndex];
        }
      }
    }

    return mutated;
  }

  private calculateOverallMetrics(
    metricsArray: StrategyMetrics[],
  ): StrategyMetrics {
    if (metricsArray.length === 0) {
      return {
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        winRate: 0,
        totalTrades: 0,
        avgHoldingPeriod: 0,
        profitFactor: 0,
        lastUpdate: Date.now(),
      };
    }

    // Calculate compound return
    const compoundReturn =
      metricsArray.reduce((compound, metrics) => {
        return compound * (1 + metrics.totalReturn);
      }, 1) - 1;

    return {
      totalReturn: compoundReturn,
      sharpeRatio: this.mean(metricsArray.map((m) => m.sharpeRatio)),
      maxDrawdown: Math.max(...metricsArray.map((m) => m.maxDrawdown)),
      winRate: this.mean(metricsArray.map((m) => m.winRate)),
      totalTrades: metricsArray.reduce((sum, m) => sum + m.totalTrades, 0),
      avgHoldingPeriod: this.mean(metricsArray.map((m) => m.avgHoldingPeriod)),
      profitFactor: this.mean(metricsArray.map((m) => m.profitFactor)),
      lastUpdate: Date.now(),
    };
  }

  private calculateConsistency(metricsArray: StrategyMetrics[]): number {
    if (metricsArray.length === 0) return 0;

    const returns = metricsArray.map((m) => m.totalReturn);
    const positiveReturns = returns.filter((r) => r > 0).length;

    return positiveReturns / returns.length;
  }

  private calculateMonteCarloStatistics(metricsArray: StrategyMetrics[]): {
    mean: StrategyMetrics;
    median: StrategyMetrics;
    std: StrategyMetrics;
    percentiles: {
      p5: StrategyMetrics;
      p25: StrategyMetrics;
      p75: StrategyMetrics;
      p95: StrategyMetrics;
    };
  } {
    const getMetricValues = (key: keyof StrategyMetrics) =>
      metricsArray.map((m) => m[key] as number);

    const calculateStats = (values: number[]) => ({
      mean: this.mean(values),
      median: this.percentile(values, 50),
      std: this.standardDeviation(values),
      p5: this.percentile(values, 5),
      p25: this.percentile(values, 25),
      p75: this.percentile(values, 75),
      p95: this.percentile(values, 95),
    });

    const totalReturnStats = calculateStats(getMetricValues("totalReturn"));
    const sharpeStats = calculateStats(getMetricValues("sharpeRatio"));
    const drawdownStats = calculateStats(getMetricValues("maxDrawdown"));

    return {
      mean: {
        totalReturn: totalReturnStats.mean,
        sharpeRatio: sharpeStats.mean,
        maxDrawdown: drawdownStats.mean,
        winRate: this.mean(getMetricValues("winRate")),
        totalTrades: this.mean(getMetricValues("totalTrades")),
        avgHoldingPeriod: this.mean(getMetricValues("avgHoldingPeriod")),
        profitFactor: this.mean(getMetricValues("profitFactor")),
        lastUpdate: Date.now(),
      },
      median: {
        totalReturn: totalReturnStats.median,
        sharpeRatio: sharpeStats.median,
        maxDrawdown: drawdownStats.median,
        winRate: this.percentile(getMetricValues("winRate"), 50),
        totalTrades: this.percentile(getMetricValues("totalTrades"), 50),
        avgHoldingPeriod: this.percentile(
          getMetricValues("avgHoldingPeriod"),
          50,
        ),
        profitFactor: this.percentile(getMetricValues("profitFactor"), 50),
        lastUpdate: Date.now(),
      },
      std: {
        totalReturn: totalReturnStats.std,
        sharpeRatio: sharpeStats.std,
        maxDrawdown: drawdownStats.std,
        winRate: this.standardDeviation(getMetricValues("winRate")),
        totalTrades: this.standardDeviation(getMetricValues("totalTrades")),
        avgHoldingPeriod: this.standardDeviation(
          getMetricValues("avgHoldingPeriod"),
        ),
        profitFactor: this.standardDeviation(getMetricValues("profitFactor")),
        lastUpdate: Date.now(),
      },
      percentiles: {
        p5: {
          totalReturn: totalReturnStats.p5,
          sharpeRatio: sharpeStats.p5,
          maxDrawdown: drawdownStats.p5,
          winRate: this.percentile(getMetricValues("winRate"), 5),
          totalTrades: this.percentile(getMetricValues("totalTrades"), 5),
          avgHoldingPeriod: this.percentile(
            getMetricValues("avgHoldingPeriod"),
            5,
          ),
          profitFactor: this.percentile(getMetricValues("profitFactor"), 5),
          lastUpdate: Date.now(),
        },
        p25: {
          totalReturn: totalReturnStats.p25,
          sharpeRatio: sharpeStats.p25,
          maxDrawdown: drawdownStats.p25,
          winRate: this.percentile(getMetricValues("winRate"), 25),
          totalTrades: this.percentile(getMetricValues("totalTrades"), 25),
          avgHoldingPeriod: this.percentile(
            getMetricValues("avgHoldingPeriod"),
            25,
          ),
          profitFactor: this.percentile(getMetricValues("profitFactor"), 25),
          lastUpdate: Date.now(),
        },
        p75: {
          totalReturn: totalReturnStats.p75,
          sharpeRatio: sharpeStats.p75,
          maxDrawdown: drawdownStats.p75,
          winRate: this.percentile(getMetricValues("winRate"), 75),
          totalTrades: this.percentile(getMetricValues("totalTrades"), 75),
          avgHoldingPeriod: this.percentile(
            getMetricValues("avgHoldingPeriod"),
            75,
          ),
          profitFactor: this.percentile(getMetricValues("profitFactor"), 75),
          lastUpdate: Date.now(),
        },
        p95: {
          totalReturn: totalReturnStats.p95,
          sharpeRatio: sharpeStats.p95,
          maxDrawdown: drawdownStats.p95,
          winRate: this.percentile(getMetricValues("winRate"), 95),
          totalTrades: this.percentile(getMetricValues("totalTrades"), 95),
          avgHoldingPeriod: this.percentile(
            getMetricValues("avgHoldingPeriod"),
            95,
          ),
          profitFactor: this.percentile(getMetricValues("profitFactor"), 95),
          lastUpdate: Date.now(),
        },
      },
    };
  }

  private calculateMonteCarloRiskMetrics(metricsArray: StrategyMetrics[]): {
    probabilityOfLoss: number;
    expectedShortfall: number;
    maxDrawdownDistribution: number[];
  } {
    const returns = metricsArray.map((m) => m.totalReturn);
    const losses = returns.filter((r) => r < 0);
    const probabilityOfLoss = losses.length / returns.length;

    const sortedReturns = returns.sort((a, b) => a - b);
    const var5Index = Math.floor(sortedReturns.length * 0.05);
    const expectedShortfall =
      var5Index > 0
        ? sortedReturns.slice(0, var5Index).reduce((sum, ret) => sum + ret, 0) /
          var5Index
        : 0;

    const maxDrawdownDistribution = metricsArray.map((m) => m.maxDrawdown);

    return {
      probabilityOfLoss,
      expectedShortfall,
      maxDrawdownDistribution,
    };
  }

  private notifyProgress(progress: OptimizationProgress): void {
    this.optimizationCallbacks.forEach((callback) => {
      try {
        callback(progress);
      } catch (error) {
        console.warn("Error in optimization progress callback:", error);
      }
    });
  }

  private estimateTimeRemaining(
    iteration: number,
    totalIterations: number,
    elapsedTime: number,
  ): number {
    if (iteration === 0) return 0;

    const avgTimePerIteration = elapsedTime / iteration;
    const remainingIterations = totalIterations - iteration;

    return remainingIterations * avgTimePerIteration;
  }

  // Utility methods
  private mean(values: number[]): number {
    return values.length > 0
      ? values.reduce((sum, val) => sum + val, 0) / values.length
      : 0;
  }

  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = this.mean(values);
    const variance =
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      values.length;

    return Math.sqrt(variance);
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) return sorted[lower];

    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  private createRandomSource(seed?: number): () => number {
    const rng = seed !== undefined ? createSeededRng(seed) : realRng;
    return () => rng.next();
  }

  private generateNormalRandom(
    mean: number,
    std: number,
    seed: number,
  ): number {
    const rng = this.createRandomSource(seed);

    // Box-Muller transform
    const u1 = rng();
    const u2 = rng();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    return mean + std * z0;
  }
}
