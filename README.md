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
npx mach1 demo                  # runs a sim trade end-to-end
```

If `npx mach1 demo` isn't available yet on your checkout, fall back to:

```bash
npm run example:quickstart
```

Also available: `npm run example:strategy` (RSI strategy callback) and `npm run example:backtest` (historical backtest).

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
