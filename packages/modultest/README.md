# modultest

Small test package for Monaco/MACH1 integration and UI smoke checks.

## What this package tests

- SDK/integration tests (market, trading, websocket)
- Puppeteer E2E smoke tests for `https://app.m1.markets`

The Puppeteer test file is:

- `tests/puppeteer/app.m1.markets.test.ts`

## Puppeteer tests (what they check)

The Puppeteer suite currently validates:

- App loads and redirects to localized route (`/en`)
- Trading pair header is visible (`BTC/USDC`)
- Header stats have values (`24H Volume`, `Price`, `24H Change`, `Contract`)
- Ticker row above the trading pair header has parseable data and includes the base token (for `BTC/USDC`, base token is `BTC`)
- Financial chart iframe loads and shows chart data (symbol, venue, OHLC markers, chart canvas)
- Orderbook tab is visible and has at least one ask and one bid
- Orders tab can be opened and shows at least one entry (when available)

## How to run

Install dependencies:

```bash
npm install
```

Run only the Puppeteer test:

```bash
npm run test:puppeteer
```

Run all tests (including Puppeteer):

```bash
npm run test:all
```

Run typecheck:

```bash
npm run typecheck
```

## Important: Puppeteer tests are gated

The Puppeteer suite only runs when this environment variable is set:

- `RUN_PUPPETEER_E2E=1`

This is already included in:

- `npm run test:puppeteer`
- `npm run test:all`

If you run `mocha` directly without that env var, the Puppeteer suite will skip.

## Screenshots

Each Puppeteer test saves a screenshot automatically after the test finishes.

Screenshot folder:

- `tests/puppeteer-artifacts/`

Filename format includes:

- test name
- test state (`passed` / `failed`)
- timestamp

This helps debug flaky UI timing issues.

## How the Puppeteer test flow works (simple)

For each UI test, the suite generally does this:

1. Open `https://app.m1.markets`
2. Wait for localized route (`/en`)
3. Detect and skip if Cloudflare/bot challenge page appears
4. Dismiss the `Work in Progress` modal if it shows
5. Wait for the target component data to load (header/ticker/chart/orderbook/orders)
6. Run assertions
7. Save screenshot

## Common reasons a UI test fails

- Page data is still loading when assertion runs
- App re-navigates/re-hydrates and Puppeteer context resets
- `Orders` tab takes longer to activate
- Network/environment instability on staging
- Cloudflare challenge page appears (suite skips in this case)

## Tips when debugging

- Check the latest screenshot in `tests/puppeteer-artifacts/`
- Re-run only Puppeteer tests: `npm run test:puppeteer`
- If a failure is timing-related, rerun once before changing assertions

