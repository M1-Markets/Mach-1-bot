import assert from "node:assert/strict";
import test from "node:test";

import { TradingPairResolver } from "../dist/monaco/trading-pair-resolver.js";

test("TradingPairResolver normalizes nested Monaco API responses", async () => {
  let callCount = 0;
  let lastParams;

  let resolver = new TradingPairResolver();
  await resolver.initialize({
    market: {
      async getPaginatedTradingPairs(params) {
        callCount += 1;
        lastParams = params;

        return {
          data: {
            data: [
              {
                id: "pair-1",
                symbol: "WBTC/USDC",
                base_token: "WBTC",
                quote_token: "USDC",
                base_asset_id: "btc",
                quote_asset_id: "usdc",
                base_token_contract:
                  "0x1234567890123456789012345678901234567890",
                quote_token_contract:
                  "0x0987654321098765432109876543210987654321",
                base_decimals: 8,
                quote_decimals: 6,
                market_type: "SPOT",
                is_active: true,
                maker_fee_bps: 10,
                taker_fee_bps: 20,
                min_order_size: "0.0001",
                max_order_size: "1000",
                tick_size: "0.01",
              },
            ],
            total_pages: 1,
          },
        };
      },
    },
  });

  assert.equal(callCount, 1);
  assert.deepEqual(lastParams, { page: 1, page_size: 100, is_active: true });
  assert.equal(resolver.isReady(), true);
  assert.equal(resolver.resolveSymbolToId("BTC/USDC"), "pair-1");
  assert.equal(resolver.getAllPairs().length, 1);

  resolver.shutdown();
});
