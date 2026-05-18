import { createMonacoSDK } from "@0xmonaco/core";
import type { TradingPair } from "@0xmonaco/types";
import { assert } from "chai";

/**
 * Integration tests for the Market API trading pairs endpoint.
 *
 * These tests call the Monaco development API directly to verify that:
 *  - the endpoint is reachable and returns well-formed data
 *  - pagination metadata is correct
 *  - each trading pair conforms to the TradingPair interface
 *  - symbol-based lookup works as expected
 *
 * Network: development (https://develop.apimonaco.xyz)
 */
const sdk = createMonacoSDK({
  network: "development",
  // seiRpcUrl is required by the SDK constructor but is only used for
  // on-chain calls – market API tests never hit the blockchain.
  seiRpcUrl: "https://evm-rpc-testnet.sei-apis.com",
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape assertion helper
// ─────────────────────────────────────────────────────────────────────────────
function assertTradingPairShape(pair: TradingPair): void {
  assert.isString(pair.id, "id should be a string");
  assert.match(
    pair.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "id should be a UUID",
  );
  assert.isString(pair.symbol, "symbol should be a string");
  assert.isNotEmpty(pair.symbol, "symbol should not be empty");
  assert.isString(pair.base_token, "base_token should be a string");
  assert.isNotEmpty(pair.base_token);
  assert.isString(pair.quote_token, "quote_token should be a string");
  assert.isNotEmpty(pair.quote_token);
  assert.isString(pair.base_asset_id, "base_asset_id should be a string");
  assert.isString(pair.quote_asset_id, "quote_asset_id should be a string");
  assert.isString(
    pair.base_token_contract,
    "base_token_contract should be a string",
  );
  assert.isString(
    pair.quote_token_contract,
    "quote_token_contract should be a string",
  );
  assert.isNumber(pair.base_decimals, "base_decimals should be a number");
  assert.isNumber(pair.quote_decimals, "quote_decimals should be a number");
  assert.isBoolean(pair.is_active, "is_active should be a boolean");
  assert.isNumber(pair.maker_fee_bps, "maker_fee_bps should be a number");
  assert.isNumber(pair.taker_fee_bps, "taker_fee_bps should be a number");
  assert.isString(pair.min_order_size, "min_order_size should be a string");
  assert.isString(pair.max_order_size, "max_order_size should be a string");
  assert.isString(pair.tick_size, "tick_size should be a string");
  assert.isString(pair.market_type, "market_type should be a string");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe("Market API – Trading Pairs", () => {
  describe("getPaginatedTradingPairs()", () => {
    it("returns a successful paginated response", async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        limit: 10,
        page: 1,
      });

      assert.isTrue(res.success, "response.success should be true");
      assert.isObject(res.data, "response.data should be an object");
      assert.isArray(res.data.data, "response.data.data should be an array");
      assert.isAbove(
        res.data.data.length,
        0,
        "at least one trading pair should exist",
      );
    });

    it("includes correct pagination metadata", async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        limit: 5,
        page: 1,
      });
      const { page, limit, total, total_pages } = res.data;

      assert.strictEqual(page, 1);
      assert.strictEqual(limit, 5);
      assert.isNumber(total);
      assert.isNumber(total_pages);
      assert.isAbove(total, 0);
      assert.isAbove(total_pages, 0);
    });

    it("respects the limit parameter", async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        limit: 2,
        page: 1,
      });
      assert.isAtMost(
        res.data.data.length,
        2,
        "number of returned pairs should not exceed the requested limit",
      );
    });

    it("each returned trading pair conforms to TradingPair shape", async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        limit: 5,
        page: 1,
      });
      for (const pair of res.data.data) {
        assertTradingPairShape(pair);
      }
    });

    it("can filter by active status", async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        is_active: true,
        limit: 10,
        page: 1,
      });
      for (const pair of res.data.data) {
        assert.isTrue(
          pair.is_active,
          "all returned pairs should be active when is_active=true",
        );
      }
    });
  });

  describe("getTradingPairBySymbol()", () => {
    let knownSymbol: string;

    // Fetch the first active pair to use as a known-good symbol.
    before(async () => {
      const res = await sdk.market.getPaginatedTradingPairs({
        is_active: true,
        limit: 1,
        page: 1,
      });
      const first = res.data.data[0];
      assert.isDefined(
        first,
        "at least one active pair must exist for symbol tests",
      );
      knownSymbol = first.symbol;
    });

    it("finds a pair by its exact symbol", async () => {
      const pair = await sdk.market.getTradingPairBySymbol(knownSymbol);

      assert.isDefined(
        pair,
        `expected to find a pair for symbol "${knownSymbol}"`,
      );
      if (pair) {
        assertTradingPairShape(pair);
        assert.strictEqual(pair.symbol, knownSymbol);
      }
    });

    it("returns undefined for an unknown symbol", async () => {
      const pair = await sdk.market.getTradingPairBySymbol("NONEXISTENT/PAIR");
      assert.isUndefined(pair, "unknown symbol should return undefined");
    });
  });
});
