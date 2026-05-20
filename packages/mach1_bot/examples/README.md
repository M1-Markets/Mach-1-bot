# mach1-bot examples

Runnable examples for the high-level bot package. Start with `quickstart.ts`.

## Running

From the repo root, after `npm install` and setting up `.env`:

```bash
npm run example:quickstart   # paper buy, ~2s
npm run example:strategy     # RSI strategy, runs 30s
npm run example:backtest     # backtest (needs CSVs in ./backtest-data/)
```

You can also run any file directly with `tsx` if you prefer:

```bash
npx tsx --tsconfig packages/mach1_bot/tsconfig.json packages/mach1_bot/examples/quickstart.ts
```

## Examples

| File | Demonstrates |
|------|--------------|
| quickstart.ts | Setup, single paper buy |
| with-strategy.ts | Strategy callback (RSI) |
| with-backtest.ts | Backtesting a strategy |

## What's supported today

| Feature | Status |
|---------|--------|
| Buy / sell (market + limit) | Working |
| Stop-loss / take-profit | Working |
| Simple strategy callback | Working |
| Basic backtest | Working |
| DCA, grid, trailing stop, OCO | Planned |
| AI / ML helpers | Planned |
| Monaco direct SDK | Planned |

## Drafts

Earlier example files have been moved to `./_drafts/`. They cover features that aren't fully implemented yet; treat them as design sketches, not working code.
