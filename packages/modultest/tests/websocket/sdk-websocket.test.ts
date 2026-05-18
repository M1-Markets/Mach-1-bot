import { createMonacoSDK, createMonacoWebSocket } from "@0xmonaco/core";
import type {
  OHLCVEvent,
  OrderbookEvent,
  OrderEvent,
  TradeEvent,
  TradingPair,
  UserBalanceEvent,
} from "@0xmonaco/types";
import { assert } from "chai";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sei, seiTestnet } from "viem/chains";
import {
  logoutIgnoringKnownRevokeMismatch,
  network,
  seiRpcUrl,
  waitFor,
  waitForOptional,
  serverUrl as wsUrl,
} from "./helpers";

const clientId = "9b3f34cfe8e0439f80569318fb205794";
const privateKeyRaw = process.env.WALLET_PRIVATE_KEY;

// Skip the entire suite if credentials are missing.
const hasCredentials =
  clientId !== undefined &&
  clientId.length > 0 &&
  privateKeyRaw !== undefined &&
  privateKeyRaw.length > 0;
const describeFn = hasCredentials ? describe : describe.skip;

describeFn("Monaco SDK WebSocket (authenticated)", () => {
  let sdk: ReturnType<typeof createMonacoSDK>;
  let activePair: TradingPair;

  before(async () => {
    // biome-ignore lint/style/noNonNullAssertion: guarded by describeFn/hasCredentials
    const privateKey = privateKeyRaw!.startsWith("0x")
      ? // biome-ignore lint/style/noNonNullAssertion: guarded by describeFn/hasCredentials
        (privateKeyRaw! as `0x${string}`)
      : (`0x${privateKeyRaw}` as `0x${string}`);

    const chain = network === "mainnet" ? sei : seiTestnet;
    const walletClient = createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain,
      transport: http(seiRpcUrl),
    });

    sdk = createMonacoSDK({ network, seiRpcUrl, walletClient });
    // MonacoSDK constructor auto-connects a retrying WS client. Replace it with
    // a non-retrying client for tests to avoid background reconnect noise.
    sdk.ws.disconnect();
    sdk.ws = createMonacoWebSocket(wsUrl, { autoReconnect: false });

    // Fetch active pairs for subscription targets.
    const res = await sdk.market.getPaginatedTradingPairs({
      is_active: true,
      limit: 1,
      page: 1,
    });

    const first = res.data.data[0];
    assert.isDefined(first, "at least one active trading pair must exist");
    activePair = first;

    // Login for authenticated channel tests. WebSocket connection is managed
    // per-test so failures don't leave reconnect loops running in the background.
    // biome-ignore lint/style/noNonNullAssertion: guarded by hasCredentials
    await sdk.login(clientId!);
  });

  beforeEach(async () => {
    try {
      await sdk.ws.connect();
    } catch (error) {
      // Prevent SDK auto-reconnect noise after a failed connect attempt in tests.
      sdk.ws.disconnect();
      throw error;
    }
  });

  afterEach(() => {
    sdk.ws.disconnect();
  });

  after(async () => {
    sdk.ws.disconnect();
    await logoutIgnoringKnownRevokeMismatch(sdk);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Public channels via sdk.ws
  // ─────────────────────────────────────────────────────────────────────────
  describe("public channels", () => {
    it("receives an orderbook snapshot via sdk.ws", async function () {
      this.timeout(12_000);

      const event = await waitFor<OrderbookEvent>(
        (resolve) =>
          sdk.ws.orderbook(activePair.id, "SPOT", 1, "BASE", resolve),
        10_000,
      );

      assert.isString(event.tradingPairId, "tradingPairId should be a string");
      assert.isNotEmpty(event.tradingPairId);
      assert.strictEqual(event.tradingMode, "SPOT");
      assert.isNumber(event.baseDecimals);
      assert.isNumber(event.quoteDecimals);
    });

    it("receives an ohlcv snapshot via sdk.ws", async function () {
      this.timeout(12_000);

      const event = await waitFor<OHLCVEvent>(
        (resolve) => sdk.ws.ohlcv(activePair.id, "SPOT", "1m", resolve),
        10_000,
      );

      assert.isString(event.tradingPairId);
      assert.isNotEmpty(event.tradingPairId);
      assert.strictEqual(event.tradingMode, "SPOT");
      assert.strictEqual(event.interval, "1m");
    });

    it("trade subscription can be established via sdk.ws", async function () {
      this.timeout(12_000);

      const event = await waitForOptional<TradeEvent>(
        (resolve) => sdk.ws.trades(activePair.id, resolve),
        8_000,
      );

      if (event !== undefined) {
        assert.isString(event.tradingPairId);
        assert.isNotEmpty(event.tradingPairId);
      }

      assert.isTrue(
        sdk.ws.isConnected(),
        "WS should remain connected after trade subscription",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authenticated channels via sdk.ws
  // ─────────────────────────────────────────────────────────────────────────
  describe("authenticated channels", () => {
    it("pair orders subscription can be established without error", async function () {
      this.timeout(12_000);

      const event = await waitForOptional<OrderEvent>(
        (resolve) => sdk.ws.orders(activePair.id, "SPOT", resolve),
        5_000,
      );

      if (event !== undefined) {
        assert.isString(event.orderId, "orderId should be a string");
        assert.isNotEmpty(event.orderId);
        assert.isString(event.eventType, "eventType should be a string");
        assert.isString(event.timestamp, "timestamp should be a string");
      }

      assert.isTrue(
        sdk.ws.isConnected(),
        "WS should remain connected after orders subscription",
      );
    });

    it("userOrders subscription can be established without error", async function () {
      this.timeout(12_000);

      const event = await waitForOptional<OrderEvent>(
        (resolve) => sdk.ws.userOrders(resolve),
        5_000,
      );

      if (event !== undefined) {
        assert.isString(event.orderId);
        assert.isString(event.eventType);
        assert.isString(event.timestamp);
      }

      assert.isTrue(
        sdk.ws.isConnected(),
        "WS should remain connected after userOrders subscription",
      );
    });

    it("balances subscription can be established without error", async function () {
      this.timeout(12_000);

      const event = await waitForOptional<UserBalanceEvent>(
        (resolve) => sdk.ws.balances(resolve),
        5_000,
      );

      if (event !== undefined) {
        assert.isString(event.userId, "userId should be a string");
        assert.isNotEmpty(event.userId);
      }

      assert.isTrue(
        sdk.ws.isConnected(),
        "WS should remain connected after balances subscription",
      );
    });
  });
});
