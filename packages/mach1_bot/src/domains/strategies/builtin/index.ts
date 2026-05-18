export * from "./dca-strategy";
export * from "./grid-strategy";
export * from "./portfolio-strategy";
export * from "./stress-test-strategy";

import {
  IStrategyFactory,
  StrategyConfig,
} from "@/domains/strategies/core/i-strategy";
import { StrategyMetadata } from "@/domains/strategies/management/strategy-registry";
import { DCAStrategy, dcaStrategyFactory } from "./dca-strategy";
import { GridStrategy, gridStrategyFactory } from "./grid-strategy";
import {
  PortfolioStrategy,
  portfolioStrategyFactory,
} from "./portfolio-strategy";
import {
  StressTestStrategy,
  stressTestStrategyFactory,
} from "./stress-test-strategy";

const dcaStrategyConfig: StrategyConfig = new DCAStrategy().config;
const gridStrategyConfig: StrategyConfig = new GridStrategy().config;
const portfolioStrategyConfig: StrategyConfig = new PortfolioStrategy().config;
const stressTestStrategyConfig: StrategyConfig = new StressTestStrategy()
  .config;

type BuiltinStrategyDefinition = {
  config: StrategyConfig;
  factory: IStrategyFactory;
  metadata: StrategyMetadata;
};

// Built-in strategies array for auto-registration
export const BUILTIN_STRATEGIES: BuiltinStrategyDefinition[] = [
  {
    config: dcaStrategyConfig,
    factory: dcaStrategyFactory,
    metadata: {
      tags: ["dca", "systematic"],
      documentation: "Dollar Cost Averaging strategy",
    },
  },
  {
    config: gridStrategyConfig,
    factory: gridStrategyFactory,
    metadata: {
      tags: ["grid", "market-making"],
      documentation: "Grid trading strategy",
    },
  },
  {
    config: portfolioStrategyConfig,
    factory: portfolioStrategyFactory,
    metadata: {
      tags: ["portfolio", "rebalancing"],
      documentation: "Portfolio rebalancing strategy",
    },
  },
  {
    config: stressTestStrategyConfig,
    factory: stressTestStrategyFactory,
    metadata: {
      tags: ["stress", "load", "testing"],
      documentation: "Stress test strategy for order placement throughput",
    },
  },
];
