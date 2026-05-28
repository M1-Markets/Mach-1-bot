import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiUrl, resolveWsUrl } from "../dist/networks/index.js";

test("network URL resolvers return expected Monaco endpoints", () => {
  assert.equal(resolveApiUrl("sei-mainnet"), "https://api.monaco.xyz");
  assert.equal(resolveApiUrl("sei-testnet"), "https://develop.apimonaco.xyz");
  assert.equal(resolveWsUrl("sei-mainnet"), "wss://api.monaco.xyz/ws");
  assert.equal(resolveWsUrl("sei-testnet"), "wss://develop.apimonaco.xyz/ws");
});
