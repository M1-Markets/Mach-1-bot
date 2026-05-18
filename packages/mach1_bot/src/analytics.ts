/**
 * @mach-one-sdk/analytics
 * Performance analytics and visualization
 */

import { PerformanceAnalyzer } from "./domains/analytics/performance-analyzer";
import { Visualizer } from "./domains/analytics/visualizer";

// Factory functions with descriptive names
export function createPerformanceAnalyzer(): PerformanceAnalyzer {
  return new PerformanceAnalyzer();
}

export function createVisualizer(): Visualizer {
  return new Visualizer();
}

// Re-export types
export type {
  CompletedTrade,
  DrawdownPeriod,
  PerformanceMetrics,
  TradeAnalysis,
} from "./shared/types";
// Re-export classes for advanced usage
export { PerformanceAnalyzer, Visualizer };
