import assert from "node:assert/strict";
import test from "node:test";
import { createMach1SDK, EMBEDDED_KEY_MATERIAL } from "../dist/index.js";

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

const authState = {
  expiresAt: Date.now() + 60_000,
  sessionPrivateKey: "1".repeat(64),
  sessionPublicKey: "2".repeat(64),
  user: {},
};

test("SDK automatically authenticates with the Mach-1 application id", async () => {
  const sdk = createMach1SDK({
    network: "sei-testnet",
    seiRpcUrl: "https://evm-rpc-testnet.sei-apis.com",
  });
  sdk.propagateSession = () => undefined;
  let authenticatedClientId;
  sdk.auth.authenticate = async (clientId) => {
    authenticatedClientId = clientId;
    return authState;
  };

  await sdk.login();

  assert.equal(authenticatedClientId, EMBEDDED_KEY_MATERIAL);
});

test("SDK propagates an explicit application id override", async () => {
  const sdk = createMach1SDK({
    network: "sei-testnet",
    seiRpcUrl: "https://evm-rpc-testnet.sei-apis.com",
    clientId: "operator-client-id",
  });
  sdk.propagateSession = () => undefined;
  let authenticatedClientId;
  sdk.auth.authenticate = async (clientId) => {
    authenticatedClientId = clientId;
    return authState;
  };

  await sdk.login();

  assert.equal(authenticatedClientId, "operator-client-id");
});
