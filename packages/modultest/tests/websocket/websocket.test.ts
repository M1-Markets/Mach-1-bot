import { createMonacoSDK, createMonacoWebSocket } from "@0xmonaco/core";
import type {
  OHLCVEvent,
  OrderbookEvent,
  TradeEvent,
  TradingPair,
  WebSocketStatus,
} from "@0xmonaco/types";
import { assert } from "chai";
import {
  network,
  seiRpcUrl,
  serverUrl,
  waitFor,
  waitForOptional,
} from "./helpers";

describe("Monaco WebSocket", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Connection
  // ─────────────────────────────────────────────────────────────────────────
  describe("connection", () => {
    it("is disconnected before connect() is called", () => {
      const ws = createMonacoWebSocket(serverUrl, { autoReconnect: false });
      assert.isFalse(ws.isConnected());
      assert.strictEqual(ws.getStatus(), "disconnected");
    });

    it("connects successfully and reports connected status", async () => {
      const ws = createMonacoWebSocket(serverUrl, { autoReconnect: false });
      await ws.connect();
      assert.isTrue(ws.isConnected());
      assert.strictEqual(ws.getStatus(), "connected");
      ws.disconnect();
    });

    it("disconnects and reports disconnected status", async () => {
      const ws = createMonacoWebSocket(serverUrl, { autoReconnect: false });
      await ws.connect();
      ws.disconnect();
      // Allow the close event to propagate.
      await new Promise((r) => setTimeout(r, 50));
      assert.isFalse(ws.isConnected());
      assert.strictEqual(ws.getStatus(), "disconnected");
    });

    it("fires onStatusChange callbacks for connect and disconnect", async () => {
      const statuses: string[] = [];
      const ws = createMonacoWebSocket(serverUrl, {
        autoReconnect: false,
        onStatusChange: (s: WebSocketStatus) => statuses.push(s),
      });

      await ws.connect();
      ws.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      assert.include(statuses, "connected");
      assert.include(statuses, "disconnected");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Spot data subscriptions against the real server
  // ─────────────────────────────────────────────────────────────────────────
  describe("spot data subscriptions", () => {
    let activePairs: TradingPair[];
    let ws: ReturnType<typeof createMonacoWebSocket>;

    before(async () => {
      const sdk = createMonacoSDK({
        network,
        seiRpcUrl,
      });
      const res = await sdk.market.getPaginatedTradingPairs({
        is_active: true,
        limit: 100,
        page: 1,
      });
      // Disconnect the SDK's internal WS handle — only the HTTP market API
      // is needed here and we don't want it to keep the process alive.
      sdk.ws.disconnect();

      activePairs = res.data.data;
      assert.isAbove(
        activePairs.length,
        0,
        "at least one active trading pair must exist",
      );

      ws = createMonacoWebSocket(serverUrl, { autoReconnect: false });
      await ws.connect();
    });

    after(() => ws.disconnect());

    it("receives an orderbook snapshot for every active pair", async function () {
      this.timeout(15_000);

      await Promise.all(
        activePairs.map((pair) =>
          waitFor<OrderbookEvent>(
            (resolve) => ws.orderbook(pair.id, "SPOT", 1, "BASE", resolve),
            10_000,
          ).then((event) => {
            assert.isString(
              event.tradingPairId,
              `[${pair.symbol}] tradingPairId should be a string`,
            );
            assert.isNotEmpty(
              event.tradingPairId,
              `[${pair.symbol}] tradingPairId should not be empty`,
            );
            assert.strictEqual(
              event.tradingMode,
              "SPOT",
              `[${pair.symbol}] tradingMode should be SPOT`,
            );
            assert.isNumber(
              event.baseDecimals,
              `[${pair.symbol}] baseDecimals should be a number`,
            );
            assert.isNumber(
              event.quoteDecimals,
              `[${pair.symbol}] quoteDecimals should be a number`,
            );
          }),
        ),
      );
    });

    it("receives an ohlcv snapshot for every active pair", async function () {
      this.timeout(15_000);

      await Promise.all(
        activePairs.map((pair) =>
          waitFor<OHLCVEvent>(
            (resolve) => ws.ohlcv(pair.id, "SPOT", "1m", resolve),
            10_000,
          ).then((event) => {
            assert.isString(
              event.tradingPairId,
              `[${pair.symbol}] tradingPairId should be a string`,
            );
            assert.isNotEmpty(
              event.tradingPairId,
              `[${pair.symbol}] tradingPairId should not be empty`,
            );
            assert.strictEqual(
              event.tradingMode,
              "SPOT",
              `[${pair.symbol}] tradingMode should be SPOT`,
            );
            assert.strictEqual(
              event.interval,
              "1m",
              `[${pair.symbol}] interval should be 1m`,
            );
          }),
        ),
      );
    });

    it("reports which active pairs produce live trade events", async function () {
      this.timeout(15_000);

      const results = await Promise.all(
        activePairs.map(async (pair) => {
          const event = await waitForOptional<TradeEvent>(
            (resolve) => ws.trades(pair.id, resolve),
            8_000,
          );
          return { symbol: pair.symbol, received: event !== undefined };
        }),
      );

      const withData = results.filter((r) => r.received).map((r) => r.symbol);

      assert.isAbove(
        withData.length,
        0,
        `Expected at least one pair to produce a trade event within the window, but none did. ` +
          `Pairs checked: ${activePairs.map((p) => p.symbol).join(", ")}`,
      );

      assert.isTrue(
        ws.isConnected(),
        "WS should still be connected after subscriptions",
      );
    });
  });
});
