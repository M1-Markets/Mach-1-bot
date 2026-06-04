import assert from "node:assert/strict";
import test from "node:test";
import { createMach1SDK } from "../dist/sdk.js";

function createSdk() {
  return createMach1SDK({
    network: "sei-testnet",
    seiRpcUrl: "https://evm-rpc-testnet.sei-apis.com",
    wsUrl: "wss://staging.apimonaco.xyz/ws",
  });
}

test("isolated margin account lookup delegates to Monaco margin accounts API", async () => {
  const sdk = createSdk();
  const listResponse = {
    accounts: [
      {
        account_state: "ACTIVE",
        equity: "1500",
        free_collateral: "1200",
        initial_margin_required: "100",
        maintenance_margin_required: "50",
        margin_account_id: "margin-1",
        realized_pnl: "10",
        total_position_notional: "900",
        unrealized_pnl: "25",
        updated_at: "2026-05-27T00:00:00.000Z",
        withdrawable_collateral: "1100",
      },
    ],
    page: 1,
    page_size: 20,
    total: 1,
  };
  const summaryResponse = listResponse.accounts[0];
  let capturedListParams;
  let capturedSummaryId;

  sdk.marginAccounts.listMarginAccounts = async (params) => {
    capturedListParams = params;
    return listResponse;
  };
  sdk.marginAccounts.getMarginAccountSummary = async (marginAccountId) => {
    capturedSummaryId = marginAccountId;
    return summaryResponse;
  };

  const listed = await sdk.perps.listMarginAccounts({ state: "ACTIVE" });
  const summary = await sdk.perps.getMarginAccountSummary("margin-1");

  assert.deepEqual(capturedListParams, { state: "ACTIVE" });
  assert.equal(capturedSummaryId, "margin-1");
  assert.deepEqual(listed, listResponse);
  assert.deepEqual(summary, summaryResponse);
});

test("isolated margin collateral lookup delegates to Monaco margin accounts API", async () => {
  const sdk = createSdk();
  const response = {
    asset: "USDC",
    margin_transferable: "900",
    wallet_available: "1000",
    wallet_locked: "25",
  };
  let capturedParams;

  sdk.marginAccounts.getAvailableCollateral = async (params) => {
    capturedParams = params;
    return response;
  };

  const collateral = await sdk.perps.getAvailableCollateral({ asset: "USDC" });

  assert.deepEqual(capturedParams, { asset: "USDC" });
  assert.deepEqual(collateral, response);
});

test("isolated margin open position lookup forces OPEN status", async () => {
  const sdk = createSdk();
  const response = {
    page: 1,
    page_size: 20,
    positions: [
      {
        entry_price: "3200",
        isolated_margin: "250",
        liquidation_price: "2900",
        maintenance_margin_required: "100",
        margin_account_id: "margin-1",
        mark_price: "3210",
        position_id: "position-1",
        realized_pnl: "0",
        side: "LONG",
        size: "1.25",
        status: "OPEN",
        trading_pair_id: "pair-1",
        unrealized_pnl: "12.5",
        updated_at: "2026-05-27T00:00:00.000Z",
      },
    ],
    total: 1,
  };
  let capturedParams;

  sdk.positions.listPositions = async (params) => {
    capturedParams = params;
    return response;
  };

  const positions = await sdk.perps.listOpenPositions({
    margin_account_id: "margin-1",
    page: 2,
  });

  assert.deepEqual(capturedParams, {
    margin_account_id: "margin-1",
    page: 2,
    status: "OPEN",
  });
  assert.deepEqual(positions, response);
});

test("perp order helpers normalize to Monaco trading and position contracts", async () => {
  const sdk = createSdk();
  const limitResponse = {
    message: "limit ok",
    order_id: "order-limit",
    status: "SUCCESS",
  };
  const marketResponse = {
    message: "market ok",
    order_id: "order-market",
    status: "SUCCESS",
  };
  const cancelResponse = {
    message: "cancel ok",
    order_id: "order-limit",
    status: "SUCCESS",
  };
  const closeResponse = {
    close_order_id: "close-1",
    message: "close ok",
    status: "SUCCESS",
    submitted_quantity: "0.4",
  };
  const reduceResponse = {
    margin_account_id: "margin-1",
    message: "reduce ok",
    new_isolated_margin: "150",
    position_id: "position-1",
    status: "SUCCESS",
  };
  const orderCalls = [];
  let capturedCancelOrderId;
  let capturedCloseArgs;
  let capturedReduceArgs;

  sdk.trading.placeLimitOrder = async (...args) => {
    orderCalls.push(["limit", args]);
    return limitResponse;
  };
  sdk.trading.placeMarketOrder = async (...args) => {
    orderCalls.push(["market", args]);
    return marketResponse;
  };
  sdk.trading.cancelOrder = async (orderId) => {
    capturedCancelOrderId = orderId;
    return cancelResponse;
  };
  sdk.positions.closePosition = async (...args) => {
    capturedCloseArgs = args;
    return closeResponse;
  };
  sdk.positions.reducePositionMargin = async (...args) => {
    capturedReduceArgs = args;
    return reduceResponse;
  };

  await sdk.perps.placeLimitOrder({
    leverage: "5",
    marginAccountId: "margin-1",
    positionSide: "LONG",
    price: "3200",
    quantity: "1.5",
    reduceOnly: true,
    side: "BUY",
    stopLoss: {
      orderType: "MARKET",
      slippageToleranceBps: 50,
      triggerPrice: "3000",
    },
    takeProfit: {
      limitPrice: "3400",
      orderType: "LIMIT",
      timeInForce: "GTC",
      triggerPrice: "3390",
    },
    timeInForce: "IOC",
    tradingPairId: "pair-1",
  });
  await sdk.perps.placeMarketOrder({
    leverage: "4",
    marginAccountId: "margin-1",
    positionSide: "SHORT",
    quantity: "0.7",
    reduceOnly: false,
    side: "SELL",
    slippageTolerance: 0.015,
    tradingPairId: "pair-2",
  });
  await sdk.perps.cancelOrder("order-limit");
  await sdk.perps.closePosition("position-1", {
    closeType: "IOC",
    quantity: "0.4",
    slippageToleranceBps: 25,
  });
  await sdk.perps.reducePositionMargin("position-1", { amount: "50" });

  assert.deepEqual(orderCalls, [
    [
      "limit",
      [
        "pair-1",
        "BUY",
        "1.5",
        "3200",
        {
          leverage: "5",
          marginAccountId: "margin-1",
          positionSide: "LONG",
          reduceOnly: true,
          stopLoss: {
            orderType: "MARKET",
            slippageToleranceBps: 50,
            triggerPrice: "3000",
          },
          takeProfit: {
            limitPrice: "3400",
            orderType: "LIMIT",
            timeInForce: "GTC",
            triggerPrice: "3390",
          },
          timeInForce: "IOC",
          tradingMode: "MARGIN",
        },
      ],
    ],
    [
      "market",
      [
        "pair-2",
        "SELL",
        "0.7",
        {
          leverage: "4",
          marginAccountId: "margin-1",
          positionSide: "SHORT",
          reduceOnly: false,
          slippageTolerance: 0.015,
          stopLoss: undefined,
          takeProfit: undefined,
          tradingMode: "MARGIN",
        },
      ],
    ],
  ]);
  assert.equal(capturedCancelOrderId, "order-limit");
  assert.deepEqual(capturedCloseArgs, [
    "position-1",
    {
      closeType: "IOC",
      quantity: "0.4",
      slippageToleranceBps: 25,
    },
  ]);
  assert.deepEqual(capturedReduceArgs, [
    "position-1",
    {
      amount: "50",
    },
  ]);
});

test("perp helpers reuse underlying authenticated APIs", () => {
  const sdk = createSdk();
  let capturedSession;

  sdk.ws.setSessionKeypair = (session) => {
    capturedSession = session;
  };

  sdk.setAuthState({
    expiresAt: Date.now() + 60_000,
    sessionPrivateKey: "1".repeat(64),
    sessionPublicKey: "2".repeat(64),
    user: { id: "user-1" },
  });

  assert.deepEqual(sdk.marginAccounts.sessionKeypair, {
    privateKey: new Uint8Array(32).fill(0x11),
    publicKey: new Uint8Array(32).fill(0x22),
  });
  assert.deepEqual(sdk.positions.sessionKeypair, {
    privateKey: new Uint8Array(32).fill(0x11),
    publicKey: new Uint8Array(32).fill(0x22),
  });
  assert.deepEqual(sdk.trading.sessionKeypair, {
    privateKey: new Uint8Array(32).fill(0x11),
    publicKey: new Uint8Array(32).fill(0x22),
  });
  assert.deepEqual(capturedSession, {
    privateKey: "1".repeat(64),
    publicKey: "2".repeat(64),
  });
});
