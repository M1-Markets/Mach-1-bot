<p align="center">
  <img src="./assets/banner.png" alt="MACH1 SDK" />
</p>

# MACH1 SDK Monorepo

Monorepo for MACH1 Monaco trading tooling.

Repo currently contains:

- `packages/mach1_sdk` - a lightweight SDK for interacting with Monaco protocol
- `packages/mach1_bot` - higher-level bot package and CLI published as `mach1-bot`, with binary `mach-one-bot`
- `packages/autosiege` - stress-test CLI for bulk order creation
- `packages/modultest` - integration, websocket, trading, and Puppeteer smoke tests
- `packages/backtest_scripts` and `packages/standalone_scripts` - helper scripts and one-off utilities

If you need package-level API details, start with:

- `packages/mach1_sdk/README.md`
- `packages/mach1_bot/examples/README.md`

## Repository Layout

```text
packages/
  mach1_sdk/       M1 SDK package
  mach1_bot/       bot package + CLI
  autosiege/       stress-test tooling
  modultest/       integration and UI smoke tests
  backtest_scripts/
  standalone_scripts/
```

Root `package.json` currently defines npm workspaces for:

- `packages/mach1_bot`
- `packages/mach1_sdk`

## Getting Started

Install root dependencies:

```bash
npm install
```

Build SDK package:

```bash
npm --prefix packages/mach1_sdk run build
```

Build bot package and CLI bundle:

```bash
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
```

Run typechecks for main workspace packages:

```bash
npm --prefix packages/mach1_sdk run typecheck
npm --prefix packages/mach1_bot run typecheck
```

Run tests:

```bash
npm --prefix packages/mach1_sdk test
npm --prefix packages/mach1_bot test
```

## Main Packages

### `mach1_sdk`

Package path: `packages/mach1_sdk`

Purpose:

- create authenticated M1 SDK clients with `createMach1SDK(...)`
- expose API modules for applications, auth, fees, market, orderbook, profile, trades, trading, vault, and websocket access
- expose Monaco helpers, network resolvers, error types, and protocol types

Common commands:

```bash
npm --prefix packages/mach1_sdk run build
npm --prefix packages/mach1_sdk run typecheck
npm --prefix packages/mach1_sdk test
```

### `mach1-bot`

Package path: `packages/mach1_bot`

Purpose:

- high-level trading bot API via `createMach1Bot(...)` and `Mach1Bot`
- built-in strategy execution and bot orchestration
- CLI entrypoint `mach-one-bot`
- live Monaco account utilities and multi-config bot runs

Exports currently include:

- `mach1-bot/bot`
- `mach1-bot/trading`
- `mach1-bot/execution`
- `mach1-bot/strategies`
- `mach1-bot/analytics`
- `mach1-bot/config`
- `mach1-bot/types`
- `mach1-bot/errors`
- `mach1-bot/utils`

Common commands:

```bash
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
npm --prefix packages/mach1_bot run typecheck
npm --prefix packages/mach1_bot test
```

## CLI Quick Start

CLI launcher lives at `packages/mach1_bot/mach-one-bot`.

Show help:

```bash
./packages/mach1_bot/mach-one-bot --help
```

Generate config interactively:

```bash
./packages/mach1_bot/mach-one-bot init --file my-bot.toml
```

Validate config without running:

```bash
./packages/mach1_bot/mach-one-bot run --config my-bot.toml --dry-run
```

Run one config:

```bash
./packages/mach1_bot/mach-one-bot run --config my-bot.toml
```

Run multiple configs in supervisor mode:

```bash
./packages/mach1_bot/mach-one-bot run --config bots/alpha.toml --config bots/beta.toml
```

Live account utilities:

```bash
./packages/mach1_bot/mach-one-bot live balance --config my-bot.toml
./packages/mach1_bot/mach-one-bot live faucet --config my-bot.toml --env staging
./packages/mach1_bot/mach-one-bot live deposit --token USDC --amount 100 --config my-bot.toml
./packages/mach1_bot/mach-one-bot live withdraw --token USDC --amount 50 --config my-bot.toml
./packages/mach1_bot/mach-one-bot live swap --input USDC --output WSEI --amount 10 --config my-bot.toml
```

Strategy discovery:

```bash
./packages/mach1_bot/mach-one-bot list-strategies
./packages/mach1_bot/mach-one-bot list-strategies --detailed
./packages/mach1_bot/mach-one-bot strategy builtin.grid
```

Current top-level CLI commands:

- `init`
- `run`
- `live`
- `list-strategies`
- `strategy <strategyId>`

Current built-in strategy ids:

- `builtin.dca`
- `builtin.grid`
- `builtin.portfolio`
- `builtin.stress_test`

## Configuration

Example bot configs live under `packages/mach1_bot/example_configs/`.

Current CLI-generated config shape includes sections such as:

- `[general]`
- `[wallet]`
- `[trading]`
- `[strategy]`
- `[network]`
- `[strategy.parameters]`
- optional `[ai_helper]`

Minimal fields currently required by parser:

- `[wallet].private_key`
- `[network].rpc_url`

Do not commit real private keys, API keys, or other secrets.

## Auxiliary Packages

### `autosiege`

Stress-test tool for Monaco endpoints.

```bash
npm --prefix packages/autosiege run typecheck
npm --prefix packages/autosiege run cli
```

### `modultest`

Integration and UI smoke-test package.

```bash
npm --prefix packages/modultest run typecheck
npm --prefix packages/modultest test
npm --prefix packages/modultest run test:puppeteer
```

Puppeteer E2E suite is gated behind `RUN_PUPPETEER_E2E=1`. Included already in package test scripts that need it.

## Notes

- `mach1_bot` resolves Monaco integration primitives from `mach1_sdk` in monorepo development.
- `packages/mach1_bot/examples/` contains runnable usage samples.
- `packages/standalone_scripts/monaco-balances.ts` is wired to `npm --prefix packages/mach1_bot run monaco:balances`.

## Support

- Documentation: `https://docs.m1.markets`
- Issues: `https://github.com/mach1-trading/mach1-sdk/issues`
- Email: `support@m1.markets`

## License

MIT. See `LICENSE`.
