/**
 * Determinism primitives — Clock, Rng, Scheduler
 *
 * Default implementations delegate to real browser/Node globals.
 * Pass seedable alternatives in paper/backtest/test contexts for reproducibility.
 */

export interface Clock {
  now(): number;
}

export interface Rng {
  /** Returns a pseudo-random number in [0, 1). */
  next(): number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

// ---------------------------------------------------------------------------
// Real (production) implementations
// ---------------------------------------------------------------------------

export const realClock: Clock = {
  now: () => Date.now(),
};

export const realRng: Rng = {
  next: () => Math.random(),
};

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Seedable deterministic RNG (mulberry32)
// ---------------------------------------------------------------------------

/**
 * Create a seeded, deterministic RNG suitable for paper-trading and backtest runs.
 * Same seed → same sequence of `next()` values every run.
 */
export function createSeededRng(seed: number): Rng {
  let s = seed >>> 0;
  return {
    next(): number {
      s += 0x6d2b79f5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/**
 * Create a deterministic clock that starts at `startMs` and advances by
 * `stepMs` on each `now()` call. Useful for backtest time-stepping.
 */
export function createSteppingClock(startMs: number, stepMs = 0): Clock {
  let current = startMs;
  return {
    now(): number {
      const t = current;
      current += stepMs;
      return t;
    },
  };
}
