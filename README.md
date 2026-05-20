<p align="center">
  <img src="./assets/banner.png" alt="MACH1 SDK" />
</p>

# MACH1 SDK

Mach1 SDK lets you build and run algorithmic trading bots on the Monaco perpetuals CLOB (Sei). Place orders, run strategies, and backtest with ~10 lines of code.

## Quickstart

```bash
git clone https://github.com/M1-Markets/Mach-1-bot.git && cd Mach-1-bot
npm install                     # installs deps and builds workspaces (via postinstall)
cp .env.example .env            # then fill in PRIVATE_KEY + SEI_RPC_URL
npx mach1 demo                  # places a $100 ETH/USDC sim buy (no real funds moved)
```

By default the demo is a **simulated** trade — no on-chain transaction, no real funds. To run against the real Monaco protocol, change `MODE=simulation` to `MODE=live` in your `.env`. The demo prints a warning and waits 5 seconds before submitting a live order so you can Ctrl+C to abort.

If `npx mach1 demo` isn't available yet on your checkout, fall back to:

```bash
npm run example:quickstart
```

Also available: `npm run example:strategy` (RSI strategy callback) and `npm run example:backtest` (historical backtest).

## Trading modes

Set `MODE` in your `.env` to control whether `mach1 demo` (and bots you build) execute against the real protocol or stay local.

| Mode | What happens | Real funds at risk? | When to use |
|------|--------------|---------------------|-------------|
| `simulation` *(default)* | Order routed through the simulated execution path. No network call to Monaco, no on-chain tx. | No | Smoke tests, building/debugging strategies, demos |
| `paper` | Identical to `simulation` in the current build. Reserved for a future "real market data, fake fills" path. | No | Treat as a synonym for simulation today |
| `live` | Order routed through the on-chain Monaco engine using `PRIVATE_KEY`. Submits a real transaction. | **Yes** | Real trading. Requires a funded wallet (use the testnet faucet first). |

To switch:

```bash
# Edit .env
MODE=live          # or MODE=simulation
```

Then re-run `npx mach1 demo` (or your own script). When you build your own bot, the same value flows into `new Mach1Bot({ mode: process.env.MODE, ... })`.

Safety notes for `live`:
- The demo currently hardcodes a $100 ETH/USDC buy. If your wallet has less than that on testnet, the order will fail; if you point at mainnet, you're spending real money.
- `mach1 demo` prints a red warning and a 5-second countdown when `MODE=live`. Other example scripts and your own code won't — handle the safety check yourself in production code.
- The faucet for sei-testnet is available via `mach1 live faucet --config <your-bot.toml>` once you have a config; see `packages/mach1_bot/example_configs/` for samples.

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
- [`packages/mach1_bot/examples/README.md`](packages/mach1_bot/examples/README.md) — runnable examples (`quickstart.ts`, `with-strategy.ts`, `with-backtest.ts`)
- [`packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md`](packages/mach1_bot/example_configs/RSI_STRATEGY_GUIDE.md) — RSI strategy walkthrough

## Support

- Documentation: `https://docs.m1.markets`
- Issues: `https://github.com/M1-Markets/Mach-1-bot/issues`
- Email: `support@m1.markets`

## License

MIT. See `LICENSE`.
