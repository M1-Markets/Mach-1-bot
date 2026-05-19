<p align="center">
  <img src="./assets/banner.png" alt="MACH1 SDK" />
</p>

# MACH1 SDK Monorepo

Monorepo for MACH1 Monaco trading tooling and bot runtime.

**MACH1 SDK** is a lightweight TypeScript SDK for Monaco protocol, paired with a high-level trading bot package and CLI.

- `packages/mach1_sdk` — Monaco SDK client, API modules, and protocol types.
- `packages/mach1_bot` — bot framework, strategy runner, and `mach-one-bot` CLI.
- `packages/autosiege` — stress test CLI for bulk orders.
- `packages/modultest` — integration and smoke-test harness.
- `packages/backtest_scripts` / `packages/standalone_scripts` — utility scripts and examples.

## Get started in 5 minutes

```bash
npm install
npm --prefix packages/mach1_sdk run build
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
./packages/mach1_bot/mach-one-bot run --config my-bot.toml
```

## Install

Install workspace dependencies:

```bash
npm install
```

Install the SDK package locally for your app:

```bash
npm install /path/to/mach-one-sdk/packages/mach1_sdk
```

> When published, this package will be available as `mach1_sdk`.

## Quick Start

Build the packages:

```bash
npm --prefix packages/mach1_sdk run build
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
```

Show the bot CLI help:

```bash
./packages/mach1_bot/mach-one-bot --help
```

Run a bot configuration:

```bash
./packages/mach1_bot/mach-one-bot run --config my-bot.toml
```

## Why MACH1 SDK?

- Type-safe Monaco protocol SDK for REST and on-chain helpers.
- Reusable client APIs for auth, fees, market data, orderbook, trades, profile, vault, and websockets.
- High-level bot runtime with config-driven execution.
- Local CLI supports live balance, faucet, deposit, withdraw, and swap operations.
- Monorepo layout built for quick development and packaged reuse.

## Integrating `mach1_sdk` into your project

Add the package locally or from the registry once published:

```bash
npm install /path/to/mach-one-sdk/packages/mach1_sdk
```

Then import the SDK and initialize it in your application.

### TypeScript example

```ts
import { createMach1SDK } from "mach1_sdk";

async function main() {
  const sdk = createMach1SDK({
    network: "development",
    seiRpcUrl: "https://sei-block-external.rpc.example",
    monacoRpcUrl: "https://monaco-rpc.example",
  });

  await sdk.login({ connectWebSocket: true });

  // Fetch basic profile and account data
  const profile = await sdk.profile.getProfile();
  console.log("Profile:", profile);

  const orderbook = await sdk.orderbook.getOrderbook("MARKET_ID");
  console.log("Orderbook:", orderbook);

  const fees = await sdk.fees.getFeeSchedule();
  console.log("Fee schedule:", fees);

  // Place a sample limit order if the account is authenticated
  const order = await sdk.trading.placeOrder({
    marketId: "MARKET_ID",
    side: "buy",
    price: "1.23",
    quantity: "10",
    orderType: "limit",
  });

  console.log("Order created:", order);

  await sdk.waitForTransaction(order.transactionHash, 1, 30_000);
  console.log("Order transaction confirmed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### JavaScript example

```js
import { createMach1SDK } from "mach1_sdk";

async function run() {
  const sdk = createMach1SDK({
    network: "development",
    seiRpcUrl: "https://sei-block-external.rpc.example",
    monacoRpcUrl: "https://monaco-rpc.example",
  });

  await sdk.login({ connectWebSocket: true });

  const books = await sdk.orderbook.getOrderbook("MARKET_ID");
  console.log("Orderbook size:", books.bids.length + books.asks.length);

  const profile = await sdk.profile.getProfile();
  console.log("Logged in as:", profile.username);

  // query trades and account balances
  const trades = await sdk.trades.getTrades({ marketId: "MARKET_ID", limit: 20 });
  console.log("Recent trades:", trades.length);

  const balances = await sdk.auth.getBalances();
  console.log("Balances:", balances);
}

run().catch(console.error);
```

### Integration tips

- Use `sdk.login()` with `connectWebSocket: true` to keep live market updates flowing.
- Prefer `sdk.orderbook.getOrderbook(...)` and `sdk.market.getMarket(...)` for market discovery.
- Use `sdk.trading` to build, sign, and submit orders, then `sdk.waitForTransaction(...)` for confirmation.
- Import types from `mach1_sdk/types` when writing TypeScript apps.
- Keep secrets out of source control by using environment variables and local config files.

## Packages

### `mach1_sdk`

Path: `packages/mach1_sdk`

Core responsibilities:

- SDK entrypoint for client applications and integrations.
- Network configuration and Monaco chain helpers.
- Authentication utilities for login and token management.
- Client APIs for market data, orderbook, trades, profiles, vaults, and websockets.
- Shared protocol types and error classes.

Key files and folders:

- `src/index.ts` — package entrypoint.
- `src/sdk.ts` — factory and SDK runtime.
- `src/api/` — individual Monaco API clients.
- `src/networks/` — predefined network resolvers.
- `src/utils/` — small helpers and magnitude math.
- `README.md` — package-specific docs and examples.

Common package commands:

```bash
npm --prefix packages/mach1_sdk run build
npm --prefix packages/mach1_sdk run typecheck
npm --prefix packages/mach1_sdk test
```

### `mach1-bot`

Path: `packages/mach1_bot`

Core responsibilities:

- High-level trading bot framework for Monaco.
- Config-based strategy orchestration and execution.
- Command-line interface for bot lifecycle management.
- Live account utilities for balance, faucet, deposit, withdraw, and swap.
- Example bot configs, strategy references, and CLI utilities.

Key files and folders:

- `src/cli/` — CLI command definitions and helpers.
- `src/domains/strategies/` — built-in strategy implementations.
- `packages/mach1_bot/mach-one-bot` — bundled CLI launcher.
- `example_configs/` — bot config examples and strategy guides.
- `examples/` — TypeScript strategy and bot usage samples.

Subcomponents:

- `bot` — runtime orchestration and state management.
- `trading` — order construction and execution.
- `execution` — lifecycle, scheduling, and safety checks.
- `strategies` — strategy registration, validation, and execution.
- `analytics` — reporting and telemetry helpers.
- `config` — TOML parsing and CLI configuration shape.

Common package commands:

```bash
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
npm --prefix packages/mach1_bot run typecheck
npm --prefix packages/mach1_bot test
```

### `autosiege`

Path: `packages/autosiege`

Core responsibilities:

- Bulk order creation and stress testing for Monaco endpoints.
- CLI tooling for high-volume scenario simulations.
- Validation of marketplace throughput and order processing.

Key files and folders:

- `src/main.ts` — CLI entrypoint.
- `example_configs/` — stress test parameter templates.

Common package commands:

```bash
npm --prefix packages/autosiege run typecheck
npm --prefix packages/autosiege run cli
```

### `modultest`

Path: `packages/modultest`

Core responsibilities:

- Integration tests for market, trading, websocket, and UI flows.
- Puppeteer smoke tests for user-facing interactions.
- Local test harness and environment utilities.

Key files and folders:

- `tests/` — integration and browser-based test suites.
- `tsconfig.json` — typecheck config for test runner.

Common package commands:

```bash
npm --prefix packages/modultest run typecheck
npm --prefix packages/modultest run test
```

### `backtest_scripts` / `standalone_scripts`

Paths: `packages/backtest_scripts`, `packages/standalone_scripts`

Core responsibilities:

- One-off scripts for data loading, backtest orchestration, and CLI utilities.
- Helpers for loading market history, preparing test data, and debugging bot behavior.

Key examples:

- `packages/backtest_scripts/download-backtest-data.sh`
- `packages/standalone_scripts/monaco-balances.ts`

## Development

Install dependencies:

```bash
npm install
```

Build packages:

```bash
npm --prefix packages/mach1_sdk run build
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
```

Typecheck:

```bash
npm --prefix packages/mach1_sdk run typecheck
npm --prefix packages/mach1_bot run typecheck
```

Run tests:

```bash
npm --prefix packages/mach1_sdk test
npm --prefix packages/mach1_bot test
```

## Repo Layout

```text
packages/
  mach1_sdk/       M1 SDK package
  mach1_bot/       bot package + CLI
  autosiege/       stress-test tooling
  modultest/       integration and UI smoke tests
  backtest_scripts/
  standalone_scripts/
```

Root `package.json` defines npm workspaces for:

- `packages/mach1_bot`
- `packages/mach1_sdk`

## Create Your Own Strategy

### 1. Start from an example config

Copy one of the built-in example configs and edit it to your needs:

```bash
cp packages/mach1_bot/example_configs/rsi-strategy-bot.toml my-strategy-bot.toml
```

Update the strategy section with your own values:

```toml
[strategy]
type = "rsi"
id = "my_custom_rsi"
trading_pairs = ["ETH/USDC"]

[strategy.parameters]
rsiPeriod = 14
oversoldThreshold = 30
overboughtThreshold = 70
positionSize = 0.1
stopLoss = 0.05
```

### 2. Use CLI discovery commands

Check the available strategies and details before running:

```bash
./packages/mach1_bot/mach-one-bot list-strategies
./packages/mach1_bot/mach-one-bot strategy rsi_strategy_v1
```

If you want a custom strategy implementation, start from the example strategy patterns in `packages/mach1_bot/examples/`.

### 3. Implement a custom strategy module

For advanced users, add a new strategy implementation in `packages/mach1_bot/src/domains/strategies/` or follow the patterns in `packages/mach1_bot/examples/03-strategy-examples.ts`.

- Create a new strategy class or function.
- Export it through the strategy registry.
- Add its `id` and parameter schema to your config.
- Rebuild the bot package:

```bash
npm --prefix packages/mach1_bot run build
npm --prefix packages/mach1_bot run build:cli
```

### 4. Run your strategy

```bash
./packages/mach1_bot/mach-one-bot run --config my-strategy-bot.toml
```

### 5. Keep iteration fast

- Use `--dry-run` to validate your config before trading.
- Start with small `positionSize` and conservative thresholds.
- Use `packages/mach1_bot/examples/` as a reference for real strategy implementations.

## Docs & Examples

- `packages/mach1_sdk/README.md`
- `packages/mach1_bot/examples/README.md`

## Get Involved

- Issues: https://github.com/mach1-trading/mach1-sdk/issues
- Contributions and PRs welcome
