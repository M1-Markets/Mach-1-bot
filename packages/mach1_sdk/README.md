# mach1_sdk

Mach1 SDK for interacting with Monaco Protocol. Single-package entrypoint exposing the SDK class, APIs, network helpers, errors, types, and small utilities.

**Install**

From inside this monorepo, the package is resolved via npm workspaces — no separate install needed. After cloning, `npm install` at the repo root builds it automatically. When the package is published, install it from the registry with `npm install mach1_sdk`.

**Quick Start**

```ts
import { createMach1SDK } from "mach1_sdk";

const sdk = createMach1SDK({
	network: "sei-testnet",
	seiRpcUrl: "https://sei-block-external.rpc.example",
});

await sdk.login({ connectWebSocket: true });

// use APIs
const profile = await sdk.profile.getProfile();
const books = await sdk.orderbook.getOrderbook("MARKET_ID");

// wait for tx
await sdk.waitForTransaction("0xabc123", 1, 30_000);
```

**What this package exports**

- `createMach1SDK(config)` — create SDK instance (preferred functional constructor).
- `Mach1SDK` / `Mach1SDKImpl` / `Mach1SDKInstance` — SDK class and types.

- `LoginOptions` — type for `sdk.login()` options.

- APIs available on the SDK instance (`sdk.<name>`):
	- `applications` — applications API client
	- `auth` — authentication API client (authenticate(), refreshSession(), revokeSession())
	- `fees` — fees API client
	- `vault` — vault API client (on-chain helpers, needs `walletClient` for signing)
	- `trading` — trading API client
	- `market` — market API client
	- `profile` — user profile API client
	- `orderbook` — orderbook API client
	- `trades` — trades API client
	- `ws` — Monaco WebSocket client (see websocket methods below)

**API client usage examples**

Below are short, copy-pasteable TypeScript examples showing common calls for each SDK API client. Replace placeholders (`MARKET_ID`, `ORDER_ID`, `...`) with real values from your app.

- Applications (list/create)

```ts
// list applications
const apps = await sdk.applications.listApplications();
console.log(apps);

// create application (example payload depends on API schema)
const newApp = await sdk.applications.createApplication({ name: "My App", redirectUri: "https://app.example/callback" });
console.log(newApp);
```

- Auth (login/refresh/logout)

```ts
// login (opens configured auth flow)
const authState = await sdk.login({ connectWebSocket: true });
console.log(authState);

// refresh current session expiry
await sdk.auth.refreshSession();

// revoke / logout
await sdk.auth.revokeSession();
```

- Vault (balances, sign & send)

```ts
// requires wallet client attached via sdk.setWalletClient(walletClient)
const balances = await sdk.vault.getBalances();
console.log(balances);

// sign & broadcast simple transfer (example shape varies by chain helper)
const tx = await sdk.vault.signAndBroadcast({ to: "sei1...", amount: "1000000" });
console.log(tx.transactionHash);
```

- Trading (place/cancel orders, positions)

```ts
// place order
const placed = await sdk.trading.placeOrder({ marketId: "MARKET_ID", side: "buy", price: "1.23", size: "10" });
console.log(placed);

// cancel order
await sdk.trading.cancelOrder("ORDER_ID");

// get positions
const positions = await sdk.trading.getPositions();
console.log(positions);
```

- Orderbook (fetch book, snapshot)

```ts
const book = await sdk.orderbook.getOrderbook("MARKET_ID");
console.log(book.bids[0], book.asks[0]);

// get snapshot / depth
const depth = await sdk.orderbook.getDepth("MARKET_ID", { depth: 20 });
console.log(depth);
```

- Market & Fees (list markets, fee estimates)

```ts
const markets = await sdk.market.getMarkets();
console.log(markets);

const feeEstimate = await sdk.fees.getFeeEstimate({ txType: "swap", params: {} });
console.log(feeEstimate);
```

- Trades (query historical trades)

```ts
const trades = await sdk.trades.listTrades({ marketId: "MARKET_ID", limit: 50 });
console.log(trades[0]);
```

- Profile (current user)

```ts
const profile = await sdk.profile.getProfile();
console.log(profile);
```

- WebSocket utilities (root exports):
	- `createMonacoWebSocket()` — factory for websocket client
	- `MonacoWebSocket` (type) — websocket client type
	- `MonacoWebSocketOptions` (type)

 - Errors:
 	- `APIError`, `ContractError`, `InvalidConfigError`, `InvalidStateError`, `MonacoCoreError`

- Network helpers:
	- `resolveApiUrl(network)` — returns base API URL for a named network
	- `resolveWsUrl(network)` — returns websocket URL for a named network

 - Types:
 	- Full Monaco protocol types available from `mach1_sdk/types`

- Utilities:
	- `ALL_MAGNITUDES`, `calculateValidMagnitudes()`, `MAX_BUCKETS_ALLOWED`, `MIN_BUCKETS_ALLOWED`

**WebSocket client (common methods)**

The SDK uses a Monaco-compatible websocket client. Commonly available methods (also used internally):

- `ws.connect()` — connect socket (returns Promise).
- `ws.disconnect()` — disconnect gracefully.
- `ws.isConnected()` — boolean.
- `ws.setSessionKeypair(credentials)` — set session keypair for auth'd subscriptions.

Note: websocket API is provided by `@0xmonaco/core`; use `createMonacoWebSocket()` and `MonacoWebSocket` types for advanced usage.

**Integration (add SDK to your project)**

1) Install package

From inside this monorepo, the package is resolved via npm workspaces — no separate install needed. After cloning, `npm install` at the repo root builds it automatically. When the package is published, install it from the registry with `npm install mach1_sdk`.

2) Basic TypeScript setup (if using TS)

Ensure `tsconfig.json` has `esModuleInterop` and `moduleResolution` set appropriately for your toolchain. Example minimal additions:

```json
{
	"compilerOptions": {
		"moduleResolution": "node",
		"esModuleInterop": true,
		"allowSyntheticDefaultImports": true
	}
}
```

3) Example integration (app code)

```ts
import { createMach1SDK } from "mach1_sdk";

async function main() {
	const sdk = createMach1SDK({
		network: "sei-testnet",
		seiRpcUrl: "https://sei-block-external.rpc.example",
	});

	// optional: attach wallet client if you use on-chain features
	// sdk.setWalletClient(yourViemWalletClient);

	// login and enable websocket subscriptions
	await sdk.login({ connectWebSocket: true });

	// use APIs
	const profile = await sdk.profile.getProfile();
	console.log("profile", profile);

	// wait for tx example
	// await sdk.waitForTransaction("0x...", 1, 30000);
}

main().catch(console.error);
```

**Auth & session management**

 - `sdk.login(options?)` — performs authentication using SDK's built-in auth flow; returns auth state `{ sessionPublicKey, sessionPrivateKey, expiresAt, user }`.
- `sdk.refreshAuth()` — refresh current session expiry using stored session keypair.
- `sdk.logout()` — revoke refresh token (if available) and clear local auth state.
- `sdk.getAuthState()`, `sdk.isAuthenticated()` — inspect auth state.

**Wallet / on-chain helpers**

- Many on-chain helpers (vault, signing, waitForTransaction) rely on a `viem` `WalletClient` instance. Use `sdk.setWalletClient(walletClient)` to attach a wallet provider. SDK will validate chain id of wallet client against selected network.

**Errors and troubleshooting**

- Errors thrown by APIs use structured error classes: `APIError`, `InvalidConfigError`, `InvalidStateError`. Inspect `error.toJSON()` for sanitized diagnostics. Sensitive fields are redacted automatically.

**Build**

```bash
npm run build
```

**Notes and guidance**

- Types are available; import protocol types from `mach1_sdk/types` for compile-time safety.
- If you need low-level network URLs, use `resolveApiUrl(network)` and `resolveWsUrl(network)`.
