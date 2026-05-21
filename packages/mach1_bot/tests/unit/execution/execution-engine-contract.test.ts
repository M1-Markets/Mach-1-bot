import type { BacktestEngine } from "@/domains/execution/backtest-engine";
import type { LiveTradingEngine } from "@/domains/execution/live-trading-engine";
import type { PaperTradingEngine } from "@/domains/execution/paper-trading-engine";
import type { ExecutionEngine } from "@/shared/types";

type LiveEngineAssignable = LiveTradingEngine extends ExecutionEngine
  ? true
  : false;
type PaperEngineAssignable = PaperTradingEngine extends ExecutionEngine
  ? true
  : false;
type BacktestEngineAssignable = BacktestEngine extends ExecutionEngine
  ? true
  : false;

describe("ExecutionEngine contract", () => {
  it("keeps live, paper, backtest engines type-compatible", () => {
    const liveAssignable: LiveEngineAssignable = true;
    const paperAssignable: PaperEngineAssignable = true;
    const backtestAssignable: BacktestEngineAssignable = true;

    expect(liveAssignable).toBe(true);
    expect(paperAssignable).toBe(true);
    expect(backtestAssignable).toBe(true);
  });
});
