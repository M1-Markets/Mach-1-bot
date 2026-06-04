<p align="center">
  <img src="./assets/banner.png" alt="MACH1 SDK" />
</p>

# MACH1 SDK

Build and run algorithmic trading bots on the Monaco perpetuals CLOB (Sei). Place orders, run strategies, and backtest with ~10 lines of code.

## Quickstart (60 seconds, no risk)

```bash
git clone https://github.com/M1-Markets/Mach-1-bot.git && cd Mach-1-bot
npm install                     # installs deps and builds workspaces (via postinstall)
cp .env.example .env            # then fill in PRIVATE_KEY + SEI_RPC_URL
npx mach1 demo                  # places a $100 ETH/USDC paper trade
```

The demo runs in **paper trading mode** by default. Your wallet isn't touched, no transaction is sent, no funds at risk. You're free to break things.

You should see something like:

```
🚀 Running mach1 demo (mode=paper, env=staging, chain=sei-testnet)...

✅ Demo trade submitted successfully
   Order:
     id=order_1_... symbol=ETH/USDC side=buy type=market size=3 price=2998.45 status=filled

   This order was simulated locally — no on-chain transaction occurred.

💡 Next steps: explore packages/mach1_bot/examples/ for strategy and backtest demos.
```

If you saw that, you're set. Skip to the journey below.

If `npx mach1 demo` errors with "Cannot find module @rollup/...", run `rm -rf node_modules package-lock.json && npm install` once — known npm bug with platform-specific optional deps.

## Your first 30 minutes

A path from "demo worked" to "I can trade for real, with my own strategy."

### 1. Run the example scripts

Same trade as the demo, but as TypeScript files you can edit:

```bash
npm run example:quickstart   # one paper buy, 2 seconds
npm run example:strategy     # adds an RSI strategy, runs for 30s
npm run example:backtest     # runs the backtest engine
```

Open `packages/mach1_bot/examples/quickstart.ts` to see the minimum viable bot — about 30 lines.

### 2. Edit a strategy

Open `packages/mach1_bot/examples/with-strategy.ts`. You'll see:

```ts
if (eth.rsi < 30) {
  await bot.buy("ETH/USDC", { amountUsd: 100 });
} else if (eth.rsi > 70) {
  await bot.sell("ETH/USDC", { amountUsd: 100 });
}
```

Change the thresholds (e.g., `35`/`65` for more frequent signals) and re-run `npm run example:strategy`. The bot stays alive for 30 seconds watching market ticks — the strategy fires when RSI crosses your levels.

### 3. Run a backtest with real data

`npm run example:backtest` runs the backtest engine, but it'll report 0 trades until you provide data. Drop OHLCV CSVs into a `backtest-data/` directory at the repo root (one CSV per trading pair), then re-run. The CLI's `mach1 strategy <id>` command can help you discover and parameterize strategies; see [packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md](packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md) for a walkthrough.

### 4. Try live trading on testnet

When you're ready to place a real on-chain order (on testnet, with testnet funds), change one line in `.env`:

```bash
MODE=live           # was: MODE=paper
```

**Two things to do first — Monaco won't accept orders without them.**

Easy path (recommended, via web UI):

1. Go to **[https://app.m1.markets](https://app.m1.markets)**
2. Connect the wallet whose private key is in your `.env`
3. Request testnet tokens from the in-app faucet
4. Deposit USDC into the Monaco vault

Advanced path (CLI only, if you already have a TOML config):

```bash
npx mach1 live faucet  --config packages/mach1_bot/example_configs/grid-trading-bot.toml --env staging
npx mach1 live deposit --token USDC --amount 100 --config packages/mach1_bot/example_configs/grid-trading-bot.toml --env staging
```

Then run `npx mach1 demo`. You'll see a red warning and a 5-second countdown — Ctrl+C aborts. Otherwise the $100 ETH/USDC buy hits the Monaco protocol on sei-testnet using `PRIVATE_KEY`.

If you skip the faucet + deposit step, the demo will reach Monaco but the order will be **rejected at pre-trade checks** with `hasFunds: false`. No on-chain transaction occurs — your wallet is untouched — but you'll see a yellow rejection message pointing you back to the faucet flow.

If the demo errors with `Network request failed for /api/v1/...`, that's a Monaco-side API issue, not your wallet. Check protocol status at [https://app.m1.markets](https://app.m1.markets) and retry.

**Monaco environment.** The demo defaults to `MONACO_ENV=staging` because that's what [app.m1.markets](https://app.m1.markets) currently runs against (`https://staging.apimonaco.xyz`). `mainnet` is reserved for future production; `development` and `local` exist for protocol contributors. Each environment has its own balance ledger — your deposit on app.m1.markets only shows up when `MONACO_ENV` matches the same host.

**Heads up on transport.** app.m1.markets talks to Monaco over gRPC + websockets. This bot's SDK currently uses the REST surface (`/api/v1/...`) on the same host. The REST endpoints can be flaky (or partially deprecated) — if you see `Network request failed for /api/v1/auth/challenge`, that's a Monaco-side REST issue, not your wallet. The bot will need to migrate to gRPC eventually; until then, retry or check protocol status.

When you're done, set `MODE=paper` back. The demo and example scripts read this value on every run.

### 5. Go beyond the demo

For real bots you'll want the TOML + CLI flow rather than the JS examples:

```bash
npx mach1 init --file my-bot.toml         # interactive scaffold
npx mach1 run --config my-bot.toml         # one bot
npx mach1 run --config bots/alpha.toml --config bots/beta.toml   # supervisor mode
npx mach1 list-strategies                 # browse what's available
```

Sample configs live in `packages/mach1_bot/example_configs/`. The CLI handles wallet setup, market resolution, risk limits, and graceful shutdown — things the example scripts skip for brevity.

### Live isolated perps

Use `trading.market_mode = "isolated_perps"` plus a `[perps]` block when you want Monaco isolated-margin perpetuals instead of spot. A ready-to-edit example lives at `packages/mach1_bot/example_configs/live-isolated-perps-bot.toml`.

Required fields for this path:
- `trading.mode = "live"`
- `trading.market_mode = "isolated_perps"`
- `perps.margin_mode = "isolated"`
- `perps.leverage`
- `perps.liquidation_threshold_percent`

Supported order behavior in this phase:
- Strategy and manual orders can submit long or short entries.
- Reduce-only and close-only paths are supported when the signal/order includes explicit perps direction.
- Advanced strategy actions such as `close_position`, `reduce_position`, `stop`, and `stop_limit` remain rejected until broader engine support lands.

Scope and fail-closed rules:
- Only isolated margin is supported. Cross-margin config is rejected.
- `perps.margin_account_id` is optional. When omitted, bot uses first active isolated margin account returned by Monaco.
- New perps orders fail closed when isolated margin account state is missing.
- New risk-increasing perps orders fail closed when mark price or maintenance-margin data is stale.
- Funding data stays fail-closed for risk-increasing paths when Monaco cannot provide fresh funding state.
- Use `npx mach1 live perps --config <file> --env staging` to inspect isolated margin balances and open perps positions, including leverage, collateral, unrealized PnL, funding, and liquidation price when Monaco returns those fields.

## Trading modes

Set `MODE` in your `.env` to control execution path.

| Mode | What happens | Real funds at risk? | When to use |
|------|--------------|---------------------|-------------|
| `paper` *(default)* | Order routed through the simulated execution path. No network call to Monaco, no on-chain tx. | No | First runs, smoke tests, learning the API. The default for the demo and example scripts. |
| `simulation` | Identical to `paper` today. The two names exist for future divergence (paper = real market data, fake fills; simulation = fully fake). Use either. | No | Same use cases as paper. |
| `live` | Order routed through the on-chain Monaco engine using `PRIVATE_KEY`. Submits a real transaction. | **Yes** | Real trading. Requires a funded wallet (testnet for safety, mainnet when ready). |

To switch, edit `.env`:

```bash
MODE=live          # or MODE=paper
```

The demo, example scripts, and any bot you build off the same env vars will all respect the change on next run.

Safety notes for `live`:
- `mach1 demo` prints a red warning and a 5-second countdown when `MODE=live`. Your own scripts won't — wire your own confirmation in production.
- The demo currently hardcodes `amountUsd: 100`. On testnet that needs ~$100 worth of testnet USDC in your vault. On mainnet that's real money.
- `NETWORK` in `.env` is read by your own code, but `mach1 demo` is hardcoded to `sei-testnet`. To run on mainnet you'd write your own script that passes `network: "sei-mainnet"`.

## Which package do I need?

Most users want the bot. Reach for the SDK only when you need direct Monaco protocol access.

| Package | What it gives you |
|---------|-------------------|
| `mach1-bot` | High-level bot. Configure with TOML or the builder API, run from the CLI. Most users want this. |
| `mach1_sdk` | Low-level Monaco access: order placement, orderbook, profile, vault, trades. |

## What works today

| Feature | Status |
|---------|--------|
| Buy / sell (market + limit) | Working |
| Stop-loss / take-profit | Working |
| Simple strategy callback | Working |
| Basic backtest | Working |
| TOML config + CLI | Working |
| Multi-config supervisor | Working |
| DCA, grid, trailing stop, OCO | Planned |
| AI / ML helpers | Planned |
| Monaco direct SDK | Planned |
| Advanced analytics, dashboards | Planned |

## Network names

Both packages use `sei-testnet` and `sei-mainnet`.

## Repository layout

```text
packages/
  mach1_sdk/       M1 SDK package
  mach1_bot/       bot package + CLI
  autosiege/       stress-test tooling
  modultest/       integration and UI smoke tests
  backtest_scripts/
  standalone_scripts/
```

Root `package.json` defines npm workspaces for `packages/mach1_bot` and `packages/mach1_sdk`.

## Going deeper

- [`packages/mach1_sdk/README.md`](packages/mach1_sdk/README.md) — SDK API reference
- [`packages/mach1_bot/examples/README.md`](packages/mach1_bot/examples/README.md) — runnable examples
- [`packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md`](packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md) — end-to-end RSI strategy walkthrough

## Support

- Documentation: `https://docs.m1.markets`
- Issues: `https://github.com/M1-Markets/Mach-1-bot/issues`
- Email: `support@m1.markets`

## License

MIT. See `LICENSE`.
