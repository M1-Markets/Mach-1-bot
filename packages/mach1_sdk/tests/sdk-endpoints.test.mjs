import assert from "node:assert/strict";
import test from "node:test";
import { createMach1SDK } from "../dist/sdk.js";

test("SDK honors explicit API endpoint overrides", () => {
  const apiUrl = "https://staging.apimonaco.xyz";
  const sdk = createMach1SDK({
    apiUrl,
    network: "sei-testnet",
    seiRpcUrl: "https://evm-rpc-testnet.sei-apis.com",
    wsUrl: "wss://staging.apimonaco.xyz/ws",
  });

  assert.equal(sdk.auth.apiUrl, apiUrl);
  assert.equal(sdk.profile.apiUrl, apiUrl);
  assert.equal(sdk.trading.apiUrl, apiUrl);
});
