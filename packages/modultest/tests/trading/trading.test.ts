import { createMonacoSDK } from "@0xmonaco/core";
import type {
  AccountBalance,
  CreateOrderResponse,
  Order,
  OrderStatus,
  TradingPair,
} from "@0xmonaco/types";
import { assert } from "chai";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sei, seiTestnet } from "viem/chains";
import {
  logoutIgnoringKnownRevokeMismatch,
  network,
  seiRpcUrl,
} from "../websocket/helpers";

const clientId = "9b3f34cfe8e0439f80569318fb205794";
const privateKeyRaw = process.env.WALLET_PRIVATE_KEY;

const hasCredentials =
  clientId !== undefined &&
  clientId.length > 0 &&
  privateKeyRaw !== undefined &&
  privateKeyRaw.length > 0;

const describeFn = hasCredentials ? describe : describe.skip;

const QUOTE_ORDER_SIZE = 10;
const MARKET_ORDER_BURST_COUNT = 20;
const CONCURRENT_MARKET_ORDER_BURST_COUNT = 40;
const PAGINATION_REGRESSION_ORDER_COUNT = 14;

describeFn("Trading & Balances", () => {
  let sdk: ReturnType<typeof createMonacoSDK>;
  let activePair: TradingPair;
  let lastPrice: number | undefined;

  before(async function () {
    this.timeout(30_000);

    // biome-ignore lint/style/noNonNullAssertion: guarded by hasCredentials
    const privateKey = privateKeyRaw!.startsWith("0x")
      ? // biome-ignore lint/style/noNonNullAssertion: guarded by hasCredentials
        (privateKeyRaw! as `0x${string}`)
      : (`0x${privateKeyRaw}` as `0x${string}`);

    const chain = network === "mainnet" ? sei : seiTestnet;
    const walletClient = createWalletClient({
      account: privateKeyToAccount(privateKey),
      chain,
      transport: http(seiRpcUrl),
    });

    sdk = createMonacoSDK({ network, walletClient, seiRpcUrl });

    // biome-ignore lint/style/noNonNullAssertion: guarded by hasCredentials
    await sdk.login(clientId!);

    const btcPair =
      (await sdk.market.getTradingPairBySymbol("BTC/USDC")) ??
      (await sdk.market.getTradingPairBySymbol("BTC-USDC"));

    assert.exists(btcPair, "Expected BTC/USDC trading pair to exist");
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    activePair = btcPair!;
    assert.isTrue(activePair.is_active, "BTC/USDC pair should be active");

    const meta = await sdk.market.getMarketMetadata(activePair.id);
    if (meta.last_price !== null) {
      const parsed = Number.parseFloat(meta.last_price);
      lastPrice = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
  });

  after(async () => {
    await logoutIgnoringKnownRevokeMismatch(sdk);
  });

  // ---------------------------------------------------------------------------
  // Balance / Assets
  // ---------------------------------------------------------------------------

  describe("balances", () => {
    it("fetches all user asset balances", async () => {
      const res = await sdk.profile.getUserBalances();

      assert.isNumber(res.total_count, "total_count should be a number");
      assert.isArray(res.balances, "balances should be an array");
      assert.isNumber(res.limit, "limit should be a number");
      assert.isNumber(res.offset, "offset should be a number");

      for (const balance of res.balances) {
        assertAccountBalance(balance);
      }
    });

    it("fetches balance for a specific asset", async () => {
      const { balances } = await sdk.profile.getUserBalances({ limit: 1 });
      const firstBalance = balances[0];
      if (!firstBalance) {
        console.info("  [skip] no balances found for this account");
        return;
      }

      const assetId = firstBalance.asset_id;
      const balance = await sdk.profile.getUserBalanceByAssetId(assetId);

      assertAccountBalance(balance);
      assert.strictEqual(
        balance.asset_id,
        assetId,
        "Returned asset_id should match the requested one",
      );
    });

    it("fetches the simplified user profile payload", async () => {
      const profile = await sdk.profile.getProfile();

      assert.isString(profile.id, "id should be a string");
      assert.isString(profile.address, "address should be a string");
      if ("username" in profile) {
        assert.isTrue(
          profile.username === null || typeof profile.username === "string",
          "username should be a string or null when present",
        );
      }
      assert.isString(profile.account_type, "account_type should be a string");
      assert.isBoolean(
        profile.can_withdraw,
        "can_withdraw should be a boolean",
      );
      assert.isString(profile.created_at, "created_at should be a string");
    });

    it("fetches paginated user movements without duplicate transaction hashes", async () => {
      const res = await sdk.profile.getPaginatedUserMovements({
        page: 1,
        limit: 50,
      });

      assert.isArray(res.movements, "movements should be an array");
      assert.isNumber(res.page, "page should be a number");
      assert.isNumber(res.limit, "limit should be a number");
      assert.isNumber(res.total_count, "total_count should be a number");
      assert.isNumber(res.total_pages, "total_pages should be a number");

      const latestMovements = res.latest_movements ?? [];
      assert.isArray(
        latestMovements,
        "latest_movements should be an array when present",
      );

      const movementDuplicates = findDuplicateMovementTxHashes(res.movements);
      const latestDuplicates = findDuplicateMovementTxHashes(latestMovements);

      assert.deepEqual(
        movementDuplicates,
        [],
        `duplicate tx_hash values found in movements: ${movementDuplicates.join(", ")}`,
      );
      assert.deepEqual(
        latestDuplicates,
        [],
        `duplicate tx_hash values found in latest_movements: ${latestDuplicates.join(", ")}`,
      );
    });

    it("supports user movement filters added in v0.5.7", async () => {
      const res = await sdk.profile.getPaginatedUserMovements({
        page: 1,
        limit: 20,
        transaction_type: "TRADE",
      });

      assert.isArray(res.movements, "movements should be an array");
      assert.isAtMost(res.movements.length, 20, "limit should be respected");

      for (const movement of res.movements) {
        assert.strictEqual(
          movement.transaction_type,
          "TRADE",
          "transaction_type filter should be applied server-side",
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Limit order
  // ---------------------------------------------------------------------------

  describe("limit order", () => {
    let orderId: string;

    it("places a BUY limit order at a below-market price", async function () {
      if (!lastPrice) {
        this.skip();
      }
      assert.isAtLeast(
        QUOTE_ORDER_SIZE,
        10,
        "Quote order size should be at least 10 USDC",
      );
      assert.isAtMost(
        QUOTE_ORDER_SIZE,
        15,
        "Quote order size should be at most 15 USDC",
      );

      // 90% below last trade should sit on the book so we can cancel cleanly.
      const price = formatPriceToTick(
        lastPrice * 0.1,
        activePair.tick_size,
        "down",
      );
      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        Number.parseFloat(price),
        activePair.base_decimals,
      );
      const res = await sdk.trading.placeLimitOrder(
        activePair.id,
        "BUY",
        quantity,
        price,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(res);
      orderId = res.order_id;
    });

    it("cancels the placed BUY limit order", async function () {
      if (!orderId) {
        this.skip();
      }

      const res = await sdk.trading.cancelOrder(orderId);

      assert.isString(res.order_id, "order_id should be a string");
      assert.strictEqual(
        res.status,
        "SUCCESS",
        "cancel status should be SUCCESS",
      );
    });

    it("supports multiple TIF values for BUY limit orders", async function () {
      if (!lastPrice) {
        this.skip();
      }
      assert.isAtLeast(
        QUOTE_ORDER_SIZE,
        10,
        "Quote order size should be at least 10 USDC",
      );
      assert.isAtMost(
        QUOTE_ORDER_SIZE,
        15,
        "Quote order size should be at most 15 USDC",
      );

      const tifs = ["GTC", "IOC", "FOK"] as const;

      for (const timeInForce of tifs) {
        // Deep below market so the order is unlikely to fill during the test.
        const price = formatPriceToTick(
          lastPrice * 0.1,
          activePair.tick_size,
          "down",
        );
        const quantity = toBaseQuantity(
          QUOTE_ORDER_SIZE,
          Number.parseFloat(price),
          activePair.base_decimals,
        );

        const res = await sdk.trading.placeLimitOrder(
          activePair.id,
          "BUY",
          quantity,
          price,
          {
            tradingMode: "SPOT",
            timeInForce,
          },
        );

        assertOrderResponse(res);

        // Only GTC is expected to rest on the book; cancel if it was accepted.
        if (timeInForce === "GTC" && res.status === "SUCCESS") {
          const cancelRes = await sdk.trading.cancelOrder(res.order_id);
          assert.strictEqual(
            cancelRes.status,
            "SUCCESS",
            `GTC ${timeInForce} order should be cancellable`,
          );
        }
      }
    });

    it("places a deep BUY limit order, cancels it, and validates balance restore behavior", async function () {
      if (!lastPrice) {
        this.skip();
      }

      const initialQuoteBalance = await getNumericAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      const initialAvailableQuote = initialQuoteBalance.available;

      const requiredQuoteWithBuffer = QUOTE_ORDER_SIZE * 1.1;
      if (initialAvailableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance to validate BUY cancel restore (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${initialAvailableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice * 0.1,
        activePair.base_decimals,
      );

      const price = formatPriceToTick(
        lastPrice * 0.1,
        activePair.tick_size,
        "down",
      );

      const createRes = await sdk.trading.placeLimitOrder(
        activePair.id,
        "BUY",
        quantity,
        price,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(createRes);
      assert.strictEqual(
        createRes.status,
        "SUCCESS",
        "deep BUY limit order should be accepted",
      );

      const res = await sdk.trading.cancelOrder(createRes.order_id);
      assert.strictEqual(
        res.status,
        "SUCCESS",
        "cancel status should be SUCCESS",
      );

      const cancelReturnedQuoteBalance = getCancelReturnedQuoteBalance(
        res,
        activePair.quote_asset_id,
      );
      if (typeof cancelReturnedQuoteBalance === "number") {
        assert.approximately(
          cancelReturnedQuoteBalance,
          initialAvailableQuote,
          1e-6,
          "cancel returned quote balance should match pre-order available balance",
        );
      }

      const finalQuoteBalance = await waitForAssetBalanceToRecover(
        sdk,
        activePair.quote_asset_id,
        initialQuoteBalance,
        60_000,
        500,
      );

      assert.approximately(
        finalQuoteBalance.available,
        initialQuoteBalance.available,
        1e-6,
        "available quote balance should recover after cancel",
      );
      assert.approximately(
        finalQuoteBalance.locked,
        initialQuoteBalance.locked,
        1e-6,
        "locked quote balance should recover after cancel",
      );
      assert.approximately(
        finalQuoteBalance.total,
        initialQuoteBalance.total,
        1e-6,
        "total quote balance should remain unchanged after cancel",
      );
    });

    it("places a SELL limit order at an above-market price", async function () {
      if (!lastPrice) {
        this.skip();
      }
      assert.isAtLeast(
        QUOTE_ORDER_SIZE,
        10,
        "Quote order size should be at least 10 USDC",
      );
      assert.isAtMost(
        QUOTE_ORDER_SIZE,
        15,
        "Quote order size should be at most 15 USDC",
      );

      const price = formatPriceToTick(
        lastPrice * 1.1,
        activePair.tick_size,
        "up",
      );
      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        Number.parseFloat(price),
        activePair.base_decimals,
      );

      const availableBase = await getAvailableBaseBalance(
        sdk,
        activePair.base_asset_id,
      );

      if (availableBase < Number.parseFloat(quantity)) {
        console.info("  [skip] insufficient base balance to sell");
        return;
      }

      const res = await sdk.trading.placeLimitOrder(
        activePair.id,
        "SELL",
        quantity,
        price,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(res);
      orderId = res.order_id;
    });

    it("cancels the placed SELL limit order", async () => {
      if (!orderId) {
        return;
      }

      const res = await sdk.trading.cancelOrder(orderId);

      assert.isString(res.order_id, "order_id should be a string");
      assert.strictEqual(
        res.status,
        "SUCCESS",
        "cancel status should be SUCCESS",
      );
    });

    it("replaces a deep BUY limit order with an aggressive price and reaches FILLED/SETTLED", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(3 * 60_000);

      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      const requiredQuoteWithBuffer = QUOTE_ORDER_SIZE * 1.1;
      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance to replace BUY limit order (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const restingPrice = formatPriceToTick(
        lastPrice * 0.1,
        activePair.tick_size,
        "down",
      );
      const aggressivePrice = formatPriceToTick(
        lastPrice * 1.01,
        activePair.tick_size,
        "up",
      );

      // Size off the aggressive price so replacement cost remains near QUOTE_ORDER_SIZE.
      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        Number.parseFloat(aggressivePrice),
        activePair.base_decimals,
      );

      let restingOrderId: string | undefined;
      let replacedOrderId: string | undefined;

      try {
        const createRes = await sdk.trading.placeLimitOrder(
          activePair.id,
          "BUY",
          quantity,
          restingPrice,
          { tradingMode: "SPOT" },
        );

        assertOrderResponse(createRes);
        assert.strictEqual(
          createRes.status,
          "SUCCESS",
          "resting BUY limit order should be accepted",
        );
        restingOrderId = createRes.order_id;

        const replaceRes = await sdk.trading.replaceOrder(restingOrderId, {
          price: aggressivePrice,
          quantity,
        });

        assert.isString(replaceRes.order_id, "replaced order_id should exist");
        assert.isNotEmpty(
          replaceRes.order_id,
          "replaced order_id should not be empty",
        );
        assert.strictEqual(
          replaceRes.status,
          "SUCCESS",
          "replaceOrder should succeed",
        );
        assert.isString(
          replaceRes.message,
          "replaceOrder message should be a string",
        );
        replacedOrderId = replaceRes.order_id;

        const [finalStatus] = await waitForOrdersToReachTerminalStatus(
          sdk,
          [replacedOrderId],
          activePair.id,
          120_000,
          2_000,
        );

        assert.include(
          ["FILLED", "SETTLED", "SETTLED_ON_CHAIN"],
          finalStatus,
          `replaced BUY limit order should end FILLED, SETTLED, or SETTLED_ON_CHAIN (got ${finalStatus})`,
        );
      } finally {
        for (const id of [replacedOrderId, restingOrderId]) {
          if (!id) {
            continue;
          }
          await sdk.trading.cancelOrder(id).catch(() => undefined);
        }
      }
    });

    it("creates and replaces deep BUY limit orders in batch", async function () {
      if (!lastPrice) {
        this.skip();
      }

      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      const requiredQuoteWithBuffer = QUOTE_ORDER_SIZE * 2.2;
      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance for batch limit order tests (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const restingPriceOne = formatPriceToTick(
        lastPrice * 0.1,
        activePair.tick_size,
        "down",
      );
      const restingPriceTwo = formatPriceToTick(
        lastPrice * 0.11,
        activePair.tick_size,
        "down",
      );
      const replacementPriceOne = formatPriceToTick(
        lastPrice * 0.12,
        activePair.tick_size,
        "down",
      );
      const replacementPriceTwo = formatPriceToTick(
        lastPrice * 0.13,
        activePair.tick_size,
        "down",
      );

      const quantityOne = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        Number.parseFloat(restingPriceOne),
        activePair.base_decimals,
      );
      const quantityTwo = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        Number.parseFloat(restingPriceTwo),
        activePair.base_decimals,
      );

      const createdOrderIds: string[] = [];
      const replacementOrderIds: string[] = [];

      try {
        const createRes = await sdk.trading.batchCreate([
          {
            tradingPairId: activePair.id,
            orderType: "LIMIT",
            side: "BUY",
            quantity: quantityOne,
            price: restingPriceOne,
            tradingMode: "SPOT",
            timeInForce: "GTC",
          },
          {
            tradingPairId: activePair.id,
            orderType: "LIMIT",
            side: "BUY",
            quantity: quantityTwo,
            price: restingPriceTwo,
            tradingMode: "SPOT",
            timeInForce: "GTC",
          },
        ]);

        assert.isTrue(createRes.success, "batchCreate should succeed");
        assert.strictEqual(
          createRes.total_requested,
          2,
          "batchCreate should request two orders",
        );
        assert.strictEqual(
          createRes.total_succeeded,
          2,
          "batchCreate should create two orders",
        );

        for (const result of createRes.results) {
          assert.isTrue(
            result.success,
            "each batchCreate result should succeed",
          );
          assert.isString(
            result.order_id,
            "created order_id should be a string",
          );
          assert.isNotEmpty(
            result.order_id,
            "created order_id should not be empty",
          );
          createdOrderIds.push(result.order_id);
        }

        const replaceRes = await sdk.trading.batchReplace([
          {
            orderId: createdOrderIds[0]!,
            price: replacementPriceOne,
          },
          {
            orderId: createdOrderIds[1]!,
            price: replacementPriceTwo,
          },
        ]);

        assert.isTrue(replaceRes.success, "batchReplace should succeed");
        assert.strictEqual(
          replaceRes.total_requested,
          2,
          "batchReplace should request two orders",
        );
        assert.strictEqual(
          replaceRes.total_succeeded,
          2,
          "batchReplace should replace two orders",
        );

        for (const result of replaceRes.results) {
          assert.isTrue(
            result.success,
            "each batchReplace result should succeed",
          );
          assert.isString(
            result.original_order_id,
            "original_order_id should be a string",
          );
          assert.isString(
            result.new_order_id,
            "new_order_id should be a string",
          );
          assert.isNotEmpty(
            result.new_order_id,
            "new_order_id should not be empty",
          );
          replacementOrderIds.push(result.new_order_id!);
        }
      } finally {
        for (const orderId of [...replacementOrderIds, ...createdOrderIds]) {
          await sdk.trading.cancelOrder(orderId).catch(() => undefined);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Market order
  // ---------------------------------------------------------------------------

  describe("orders", () => {
    it("fetches paginated user orders with page_size 5 and verifies unique pages", async function () {
      const pageOne = await sdk.trading.getPaginatedOrders({
        page: 1,
        page_size: 5,
      });

      const pageOneOrderIds = getPaginatedOrderIds(pageOne);
      assert.isAtLeast(
        pageOneOrderIds.length,
        1,
        "page 1 should return at least one order",
      );
      assert.isAtMost(
        pageOne.orders.length,
        5,
        "page 1 orders should respect page_size",
      );

      if (pageOne.total_pages < 2) {
        this.skip();
      }

      const pageTwo = await sdk.trading.getPaginatedOrders({
        page: 2,
        page_size: 5,
      });

      const pageTwoOrderIds = getPaginatedOrderIds(pageTwo);
      assert.isAtMost(
        pageTwo.orders.length,
        5,
        "page 2 orders should respect page_size",
      );
      const pageOneSet = new Set(pageOneOrderIds);
      const overlap = pageTwoOrderIds.filter((id) => pageOneSet.has(id));

      assert.deepEqual(
        overlap,
        [],
        "page 1 and page 2 should not contain duplicate order ids",
      );
      assert.notDeepEqual(
        [...pageOneOrderIds].sort(),
        [...pageTwoOrderIds].sort(),
        "page 1 and page 2 should not return identical order sets",
      );
    });

    it("checks all paginated LIMIT user orders for missing time in force", async function () {
      const rows: Array<{
        id: string;
        tif: unknown;
        orderType: unknown;
        createdAt: unknown;
      }> = [];
      let page = 1;
      let totalPages = 1;
      let hasAnyRows = false;

      while (page <= totalPages) {
        const response = await sdk.trading.getPaginatedOrders({
          page,
          page_size: 100,
        });

        const { rows: pageRows, totalPages: nextTotalPages } =
          extractOrdersWithTimeInForce(response, page);
        totalPages = nextTotalPages;

        if (pageRows.length > 0) {
          hasAnyRows = true;
        }
        rows.push(...pageRows);

        page += 1;
      }

      if (!hasAnyRows) {
        console.info("  [skip] no user orders found");
        return;
      }

      const limitRows = rows.filter((row) => row.orderType === "LIMIT");
      const missingTif = limitRows.filter(
        (row) => typeof row.tif !== "string" || row.tif.trim().length === 0,
      );

      assert.deepEqual(
        missingTif,
        [],
        `found LIMIT orders without time in force: ${missingTif
          .map((row) =>
            typeof row.createdAt === "string" && row.createdAt.trim().length > 0
              ? `${row.id} (${row.createdAt})`
              : row.id,
          )
          .join(", ")}`,
      );
    });

    it("fetches submitted orders and attempts to cancel", async function () {
      const response = await sdk.trading.getPaginatedOrders({
        status: "SUBMITTED",
        trading_pair: activePair.id,
        page: 1,
        page_size: 20,
      });

      const allOrders: Order[] = [
        ...(response.latest_orders ?? []),
        ...response.orders,
      ];
      const submitted = allOrders.find((order) => order.status === "SUBMITTED");

      if (!submitted) {
        this.skip();
      }
      const order = submitted;

      assert.isString(order.id, "order id should be a string");
      assert.strictEqual(
        order.status,
        "SUBMITTED",
        "order status should be SUBMITTED",
      );

      const res = await sdk.trading.cancelOrder(order.id);
      assert.strictEqual(
        res.status,
        "SUCCESS",
        "cancel status should be SUCCESS",
      );
    });
  });

  describe("market order", () => {
    it("places a BUY market order then waits FILLED then final settlement under 10 seconds", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(180_000);

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );

      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      if (availableQuote < QUOTE_ORDER_SIZE) {
        console.info(
          `  [skip] insufficient quote balance to place market BUY order (~${QUOTE_ORDER_SIZE} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const placeRes = await sdk.trading.placeMarketOrder(
        activePair.id,
        "BUY",
        quantity,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(placeRes);
      assert.strictEqual(
        placeRes.status,
        "SUCCESS",
        "market order should be accepted",
      );

      const orderId = placeRes.order_id;

      const filledAt = await waitForSingleOrderStatus(
        sdk,
        orderId,
        activePair.id,
        "FILLED",
        120_000,
        500,
      );

      const settledAt = await waitForSingleOrderStatus(
        sdk,
        orderId,
        activePair.id,
        ["SETTLED", "SETTLED_ON_CHAIN"],
        120_000,
        500,
      );

      const settlementMs = settledAt - filledAt;
      assert.isBelow(
        settlementMs,
        10_000,
        `settlement should occur within 10s after FILLED (actual: ${settlementMs}ms)`,
      );
    });

    it("places 6 BUY market orders and waits for each to reach final settlement within 10s of FILLED", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(240_000);

      const orderCount = 6;
      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );

      const requiredQuoteWithBuffer = QUOTE_ORDER_SIZE * orderCount * 1.05;
      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance for ${orderCount} market BUY orders (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const placeResults = await Promise.all(
        Array.from({ length: orderCount }, () =>
          sdk.trading.placeMarketOrder(activePair.id, "BUY", quantity, {
            tradingMode: "SPOT",
          }),
        ),
      );

      const orderIds: string[] = [];
      placeResults.forEach((res, index) => {
        assertOrderResponse(res);
        assert.strictEqual(
          res.status,
          "SUCCESS",
          `market order ${index + 1}/${orderCount} should be accepted`,
        );
        orderIds.push(res.order_id);
      });

      const settleDurations = await Promise.all(
        orderIds.map(async (orderId, index) => {
          const filledAt = await waitForSingleOrderStatus(
            sdk,
            orderId,
            activePair.id,
            "FILLED",
            120_000,
            500,
          );

          const settledAt = await waitForSingleOrderStatus(
            sdk,
            orderId,
            activePair.id,
            ["SETTLED", "SETTLED_ON_CHAIN"],
            120_000,
            500,
          );

          const settlementMs = settledAt - filledAt;
          assert.isBelow(
            settlementMs,
            10_000,
            `market order ${index + 1}/${orderCount} should settle within 10s after FILLED (actual: ${settlementMs}ms)`,
          );
          return settlementMs;
        }),
      );

      const maxSettlementMs = Math.max(...settleDurations);
      assert.isBelow(
        maxSettlementMs,
        10_000,
        `all 6 orders should settle within 10s after FILLED (slowest: ${maxSettlementMs}ms)`,
      );
    });

    it("places a BUY market order", async function () {
      if (!lastPrice) {
        this.skip();
      }
      assert.isAtLeast(
        QUOTE_ORDER_SIZE,
        10,
        "Quote order size should be at least 10 USDC",
      );
      assert.isAtMost(
        QUOTE_ORDER_SIZE,
        15,
        "Quote order size should be at most 15 USDC",
      );

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );
      const res = await sdk.trading.placeMarketOrder(
        activePair.id,
        "BUY",
        quantity,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(res);

      if (res.match_result) {
        const mr = res.match_result;
        assert.isNumber(mr.trades_count, "trades_count should be a number");
        assert.isString(mr.total_filled, "total_filled should be a string");
        assert.isString(
          mr.remaining_quantity,
          "remaining_quantity should be a string",
        );
      }
    });

    it("places a SELL market order", async function () {
      if (!lastPrice) {
        this.skip();
      }
      assert.isAtLeast(
        QUOTE_ORDER_SIZE,
        10,
        "Quote order size should be at least 10 USDC",
      );
      assert.isAtMost(
        QUOTE_ORDER_SIZE,
        15,
        "Quote order size should be at most 15 USDC",
      );

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );
      const availableBase = await getAvailableBaseBalance(
        sdk,
        activePair.base_asset_id,
      );

      if (availableBase < Number.parseFloat(quantity)) {
        console.info("  [skip] insufficient base balance to sell");
        return;
      }

      const res = await sdk.trading.placeMarketOrder(
        activePair.id,
        "SELL",
        quantity,
        { tradingMode: "SPOT" },
      );

      assertOrderResponse(res);
    });

    it("settles 20 BUY market orders", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(6 * 60_000);

      const estimatedQuoteSpend = QUOTE_ORDER_SIZE * MARKET_ORDER_BURST_COUNT;
      const requiredQuoteWithBuffer = estimatedQuoteSpend * 1.1;
      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );

      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance for ${MARKET_ORDER_BURST_COUNT} market BUY orders (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const orderIds: string[] = [];

      for (let i = 0; i < MARKET_ORDER_BURST_COUNT; i += 1) {
        const quantity = toBaseQuantity(
          QUOTE_ORDER_SIZE,
          lastPrice,
          activePair.base_decimals,
        );

        const res = await sdk.trading.placeMarketOrder(
          activePair.id,
          "BUY",
          quantity,
          { tradingMode: "SPOT" },
        );

        assertOrderResponse(res);
        assert.strictEqual(
          res.status,
          "SUCCESS",
          `market order ${i + 1}/${MARKET_ORDER_BURST_COUNT} should be accepted`,
        );

        orderIds.push(res.order_id);
      }

      const statuses = await waitForOrdersToReachTerminalStatus(
        sdk,
        orderIds,
        activePair.id,
        180_000,
        2_000,
      );

      for (const [index, status] of statuses.entries()) {
        assert.include(
          ["FILLED", "SETTLED", "SETTLED_ON_CHAIN"],
          status,
          `market order ${index + 1}/${MARKET_ORDER_BURST_COUNT} should end FILLED, SETTLED, or SETTLED_ON_CHAIN (got ${status})`,
        );
      }
    });

    it("settles 40 concurrent BUY market orders", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(8 * 60_000);

      const estimatedQuoteSpend =
        QUOTE_ORDER_SIZE * CONCURRENT_MARKET_ORDER_BURST_COUNT;
      const requiredQuoteWithBuffer = estimatedQuoteSpend * 1.1;
      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );

      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance for ${CONCURRENT_MARKET_ORDER_BURST_COUNT} concurrent market BUY orders (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );

      const orderResults = await Promise.all(
        Array.from({ length: CONCURRENT_MARKET_ORDER_BURST_COUNT }, (_, i) =>
          sdk.trading
            .placeMarketOrder(activePair.id, "BUY", quantity, {
              tradingMode: "SPOT",
            })
            .then((res) => ({ index: i, res })),
        ),
      );

      const orderIds: string[] = [];
      for (const { index, res } of orderResults) {
        assertOrderResponse(res);
        assert.strictEqual(
          res.status,
          "SUCCESS",
          `concurrent market order ${index + 1}/${CONCURRENT_MARKET_ORDER_BURST_COUNT} should be accepted`,
        );
        orderIds.push(res.order_id);
      }

      const statuses = await waitForOrdersToReachTerminalStatus(
        sdk,
        orderIds,
        activePair.id,
        240_000,
        2_000,
      );

      for (const [index, status] of statuses.entries()) {
        assert.include(
          ["FILLED", "SETTLED", "SETTLED_ON_CHAIN"],
          status,
          `concurrent market order ${index + 1}/${CONCURRENT_MARKET_ORDER_BURST_COUNT} should end FILLED, SETTLED, or SETTLED_ON_CHAIN (got ${status})`,
        );
      }
    });

    it("settles 2 concurrent BUY and 2 concurrent SELL market orders", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(6 * 60_000);

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );
      const quantityAsNumber = Number.parseFloat(quantity);

      const requiredQuoteWithBuffer = QUOTE_ORDER_SIZE * 2 * 1.1;
      const availableQuote = await getAvailableAssetBalance(
        sdk,
        activePair.quote_asset_id,
      );
      if (availableQuote < requiredQuoteWithBuffer) {
        console.info(
          `  [skip] insufficient quote balance for 2 concurrent market BUY orders (~${requiredQuoteWithBuffer.toFixed(2)} ${activePair.quote_token} needed, ${availableQuote.toFixed(2)} available)`,
        );
        this.skip();
      }

      const availableBase = await getAvailableBaseBalance(
        sdk,
        activePair.base_asset_id,
      );
      const requiredBaseWithBuffer = quantityAsNumber * 2 * 1.02;
      if (availableBase < requiredBaseWithBuffer) {
        console.info(
          `  [skip] insufficient base balance for 2 concurrent market SELL orders (~${requiredBaseWithBuffer.toFixed(8)} ${activePair.base_token} needed, ${availableBase.toFixed(8)} available)`,
        );
        this.skip();
      }

      const requests = [
        { side: "BUY" as const, label: "buy-1" },
        { side: "BUY" as const, label: "buy-2" },
        { side: "SELL" as const, label: "sell-1" },
        { side: "SELL" as const, label: "sell-2" },
      ];

      const orderResults = await Promise.all(
        requests.map(async (request, index) => {
          const res = await sdk.trading.placeMarketOrder(
            activePair.id,
            request.side,
            quantity,
            { tradingMode: "SPOT" },
          );
          return { index, ...request, res };
        }),
      );

      const orderIds: string[] = [];
      for (const { index, side, label, res } of orderResults) {
        assertOrderResponse(res);
        assert.strictEqual(
          res.status,
          "SUCCESS",
          `${label} (${side}) market order ${index + 1}/4 should be accepted`,
        );
        orderIds.push(res.order_id);
      }

      const statuses = await waitForOrdersToReachTerminalStatus(
        sdk,
        orderIds,
        activePair.id,
        180_000,
        2_000,
      );

      for (const [index, status] of statuses.entries()) {
        const request = requests[index];
        assert.exists(
          request,
          `Missing request metadata for terminal status index ${index}`,
        );
        assert.include(
          ["FILLED", "SETTLED", "SETTLED_ON_CHAIN"],
          status,
          `${request.label} (${request.side}) should end FILLED, SETTLED, or SETTLED_ON_CHAIN (got ${status})`,
        );
      }
    });

    it("returns every created order when paginating orders with page_size=5", async function () {
      if (!lastPrice) {
        this.skip();
      }
      this.timeout(8 * 60_000);

      const quantity = toBaseQuantity(
        QUOTE_ORDER_SIZE,
        lastPrice,
        activePair.base_decimals,
      );
      const quantityAsNumber = Number.parseFloat(quantity);
      const availableBase = await getAvailableBaseBalance(
        sdk,
        activePair.base_asset_id,
      );
      const requiredBaseWithBuffer =
        quantityAsNumber * PAGINATION_REGRESSION_ORDER_COUNT * 1.02;

      if (availableBase < requiredBaseWithBuffer) {
        console.info(
          `  [skip] insufficient base balance for ${PAGINATION_REGRESSION_ORDER_COUNT} market SELL orders (~${requiredBaseWithBuffer.toFixed(8)} ${activePair.base_token} needed, ${availableBase.toFixed(8)} available)`,
        );
        this.skip();
      }

      const orderIds: string[] = [];

      for (let i = 0; i < PAGINATION_REGRESSION_ORDER_COUNT; i += 1) {
        const res = await sdk.trading.placeMarketOrder(
          activePair.id,
          "SELL",
          quantity,
          { tradingMode: "SPOT" },
        );

        assertOrderResponse(res);
        assert.strictEqual(
          res.status,
          "SUCCESS",
          `pagination regression SELL order ${i + 1}/${PAGINATION_REGRESSION_ORDER_COUNT} should be accepted`,
        );

        orderIds.push(res.order_id);
      }

      await waitForOrdersToAppearInPaginatedOrders(
        sdk,
        orderIds,
        activePair.id,
        5,
        60_000,
        2_000,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertAccountBalance(balance: AccountBalance): void {
  assert.isString(balance.asset_id, "asset_id should be a string");
  assert.isString(balance.token, "token should be a string");
  assert.isNumber(balance.decimals, "decimals should be a number");
  assert.isString(
    balance.available_balance,
    "available_balance should be a string",
  );
  assert.isString(balance.locked_balance, "locked_balance should be a string");
  assert.isString(balance.total_balance, "total_balance should be a string");
}

function assertOrderResponse(res: CreateOrderResponse): void {
  assert.isString(res.order_id, "order_id should be a string");
  assert.isNotEmpty(res.order_id, "order_id should not be empty");
  assert.include(
    ["SUCCESS", "FAILED"],
    res.status,
    "status should be SUCCESS or FAILED",
  );
  assert.isString(res.message, "message should be a string");
}

function findDuplicateMovementTxHashes(
  movements: ReadonlyArray<{
    id: string;
    tx_hash?: string | null;
    hash?: string | null;
  }>,
): string[] {
  const movementIdsByHash = new Map<string, string[]>();

  for (const movement of movements) {
    const txHash = movement.tx_hash ?? movement.hash ?? null;
    if (txHash === null || txHash.length === 0) {
      continue;
    }

    const normalizedHash = txHash.toLowerCase();
    const ids = movementIdsByHash.get(normalizedHash) ?? [];
    ids.push(movement.id);
    movementIdsByHash.set(normalizedHash, ids);
  }

  return Array.from(movementIdsByHash.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([hash, ids]) => `${hash} [${ids.join(", ")}]`);
}

async function getAvailableBaseBalance(
  sdk: ReturnType<typeof createMonacoSDK>,
  assetId: string,
): Promise<number> {
  return getAvailableAssetBalance(sdk, assetId);
}

async function getAvailableAssetBalance(
  sdk: ReturnType<typeof createMonacoSDK>,
  assetId: string,
): Promise<number> {
  const balance = await sdk.profile.getUserBalanceByAssetId(assetId);
  return Number.parseFloat(balance.available_balance);
}

type NumericAssetBalance = {
  available: number;
  locked: number;
  total: number;
};

async function getNumericAssetBalance(
  sdk: ReturnType<typeof createMonacoSDK>,
  assetId: string,
): Promise<NumericAssetBalance> {
  const balance = await sdk.profile.getUserBalanceByAssetId(assetId);
  return {
    available: Number.parseFloat(balance.available_balance),
    locked: Number.parseFloat(balance.locked_balance),
    total: Number.parseFloat(balance.total_balance),
  };
}

async function waitForAssetBalanceToRecover(
  sdk: ReturnType<typeof createMonacoSDK>,
  assetId: string,
  expectedBalance: NumericAssetBalance,
  timeoutMs: number,
  pollMs: number,
): Promise<NumericAssetBalance> {
  const deadline = Date.now() + timeoutMs;
  let balance = await getNumericAssetBalance(sdk, assetId);

  while (Date.now() < deadline) {
    const availableRecovered =
      Math.abs(balance.available - expectedBalance.available) <= 1e-6;
    const lockedRecovered =
      Math.abs(balance.locked - expectedBalance.locked) <= 1e-6;
    const totalRecovered =
      Math.abs(balance.total - expectedBalance.total) <= 1e-6;

    if (availableRecovered && lockedRecovered && totalRecovered) {
      return balance;
    }

    await sleep(pollMs);
    balance = await getNumericAssetBalance(sdk, assetId);
  }

  throw new Error(
    `Timed out waiting for balance recovery for ${assetId}. expected=${JSON.stringify(expectedBalance)}, got=${JSON.stringify(balance)}`,
  );
}

function getCancelReturnedQuoteBalance(
  value: unknown,
  quoteAssetId: string,
): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const direct = toNumeric(value.available_balance);
  if (direct !== undefined) {
    return direct;
  }

  const balances = value.balances;
  if (Array.isArray(balances)) {
    for (const entry of balances) {
      if (!isRecord(entry)) {
        continue;
      }
      if (entry.asset_id !== quoteAssetId) {
        continue;
      }
      const parsed = toNumeric(entry.available_balance);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  } else if (isRecord(balances)) {
    const nested = balances[quoteAssetId];
    const nestedNumber = toNumeric(
      isRecord(nested) ? nested.available_balance : nested,
    );
    if (nestedNumber !== undefined) {
      return nestedNumber;
    }
  }

  if (isRecord(value.data) && value.data.quote_asset_id === quoteAssetId) {
    const nestedNumber = toNumeric(value.data.available_balance);
    if (nestedNumber !== undefined) {
      return nestedNumber;
    }
  }

  return undefined;
}

function toBaseQuantity(
  quoteAmount: number,
  price: number,
  decimals: number,
): string {
  const precision = Math.min(decimals, 6);
  const rawQuantity = quoteAmount / price;
  const factor = 10 ** precision;
  const truncated = Math.floor(rawQuantity * factor) / factor;
  return truncated.toFixed(precision);
}

function formatDecimal(value: number, decimals = 6): string {
  return value.toFixed(decimals);
}

function formatPriceToTick(
  price: number,
  tickSize: string,
  direction: "down" | "up",
): string {
  const tick = Number.parseFloat(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) {
    return formatDecimal(price);
  }

  const decimalPart = tickSize.includes(".")
    ? tickSize.split(".")[1]
    : undefined;
  const decimals = decimalPart?.length ?? 0;
  const steps = price / tick;
  const adjustedSteps =
    direction === "up" ? Math.ceil(steps) : Math.floor(steps);
  const adjustedPrice = adjustedSteps * tick;
  return adjustedPrice.toFixed(decimals);
}

function getPaginatedOrderIds(value: {
  orders: Array<{ id: string }>;
  latest_orders?: Array<{ id: string }>;
}): string[] {
  const rows = [...(value.latest_orders ?? []), ...value.orders];
  const ids = rows
    .map((order) => order.id)
    .filter((id): id is string => id.length > 0);
  return Array.from(new Set(ids));
}

async function waitForSingleOrderStatus(
  sdk: ReturnType<typeof createMonacoSDK>,
  orderId: string,
  tradingPairId: string,
  targetStatus: OrderStatus | readonly OrderStatus[],
  timeoutMs: number,
  pollMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const targetStatuses = Array.isArray(targetStatus)
    ? new Set(targetStatus)
    : new Set([targetStatus]);

  while (Date.now() < deadline) {
    const status = await getOrderStatus(sdk, orderId, tradingPairId);

    if (status !== undefined && targetStatuses.has(status)) {
      return Date.now();
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Timed out waiting for order ${orderId} to reach ${Array.from(targetStatuses).join(" or ")}`,
  );
}

async function getOrderStatus(
  sdk: ReturnType<typeof createMonacoSDK>,
  orderId: string,
  tradingPairId: string,
): Promise<OrderStatus | undefined> {
  const targetOrderIds = new Set([orderId]);
  const statuses = await fetchOrderStatusesFromPaginatedOrders(
    sdk,
    targetOrderIds,
    tradingPairId,
  );
  return statuses.get(orderId);
}

async function waitForOrdersToReachTerminalStatus(
  sdk: ReturnType<typeof createMonacoSDK>,
  orderIds: readonly string[],
  tradingPairId: string,
  timeoutMs: number,
  pollMs: number,
): Promise<OrderStatus[]> {
  const statusesById = new Map<string, OrderStatus>();
  const pendingOrderIds = new Set(orderIds);
  const deadline = Date.now() + timeoutMs;

  while (pendingOrderIds.size > 0 && Date.now() < deadline) {
    const snapshotStatuses = await fetchOrderStatusesFromPaginatedOrders(
      sdk,
      pendingOrderIds,
      tradingPairId,
    );

    for (const [orderId, status] of snapshotStatuses) {
      if (isTerminalOrderStatus(status)) {
        statusesById.set(orderId, status);
        pendingOrderIds.delete(orderId);
      }
    }

    if (pendingOrderIds.size > 0) {
      await sleep(pollMs);
    }
  }

  if (pendingOrderIds.size > 0) {
    const unresolved = Array.from(pendingOrderIds).join(", ");
    throw new Error(
      `Timed out waiting for terminal order status for: ${unresolved}`,
    );
  }

  return orderIds.map((orderId) => {
    const status = statusesById.get(orderId);
    assert.isDefined(status, `missing final status for order ${orderId}`);
    return status as OrderStatus;
  });
}

function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (
    status === "FILLED" ||
    status === "SETTLED_ON_CHAIN" ||
    status === "SETTLED" ||
    status === "CANCELLED" ||
    status === "REJECTED" ||
    status === "EXPIRED"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    value === "SUBMITTED" ||
    value === "PARTIALLY_FILLED" ||
    value === "FILLED" ||
    value === "SETTLED_ON_CHAIN" ||
    value === "SETTLED" ||
    value === "CANCELLED" ||
    value === "REJECTED" ||
    value === "EXPIRED"
  );
}

async function fetchOrderStatusesFromPaginatedOrders(
  sdk: ReturnType<typeof createMonacoSDK>,
  targetOrderIds: ReadonlySet<string>,
  tradingPairId: string,
): Promise<Map<string, OrderStatus>> {
  const foundStatuses = new Map<string, OrderStatus>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && foundStatuses.size < targetOrderIds.size) {
    const res = await sdk.trading.getPaginatedOrders({
      trading_pair: tradingPairId,
      page,
      page_size: 100,
    });
    const { latestOrders, orders, nextTotalPages } =
      extractOrdersFromPaginatedOrdersResult(res, page);

    totalPages = nextTotalPages;

    for (const order of [...latestOrders, ...orders]) {
      if (!targetOrderIds.has(order.id)) {
        continue;
      }
      if (!isOrderStatus(order.status)) {
        continue;
      }
      foundStatuses.set(order.id, order.status);
    }

    page += 1;
  }

  return foundStatuses;
}

async function fetchOrderIdsFromPaginatedOrders(
  sdk: ReturnType<typeof createMonacoSDK>,
  tradingPairId: string,
  pageSize: number,
): Promise<Set<string>> {
  const foundOrderIds = new Set<string>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const res = await sdk.trading.getPaginatedOrders({
      trading_pair: tradingPairId,
      page,
      page_size: pageSize,
    });
    const { latestOrders, orders, nextTotalPages } =
      extractOrdersFromPaginatedOrdersResult(res, page);

    totalPages = nextTotalPages;

    for (const order of [...latestOrders, ...orders]) {
      foundOrderIds.add(order.id);
    }

    page += 1;
  }

  return foundOrderIds;
}

async function waitForOrdersToAppearInPaginatedOrders(
  sdk: ReturnType<typeof createMonacoSDK>,
  orderIds: readonly string[],
  tradingPairId: string,
  pageSize: number,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const pendingOrderIds = new Set(orderIds);
  const deadline = Date.now() + timeoutMs;

  while (pendingOrderIds.size > 0 && Date.now() < deadline) {
    const paginatedOrderIds = await fetchOrderIdsFromPaginatedOrders(
      sdk,
      tradingPairId,
      pageSize,
    );

    for (const orderId of pendingOrderIds) {
      if (paginatedOrderIds.has(orderId)) {
        pendingOrderIds.delete(orderId);
      }
    }

    if (pendingOrderIds.size > 0) {
      await sleep(pollMs);
    }
  }

  if (pendingOrderIds.size > 0) {
    const missing = Array.from(pendingOrderIds).join(", ");
    throw new Error(
      `Timed out waiting for orders to appear in paginated orders: ${missing}`,
    );
  }
}

function extractOrdersFromPaginatedOrdersResult(
  value: unknown,
  page: number,
): {
  latestOrders: Array<{ id: string; status: unknown }>;
  orders: Array<{ id: string; status: unknown }>;
  nextTotalPages: number;
} {
  if (!isRecord(value)) {
    throw new Error(
      `getPaginatedOrders(page=${page}) returned a non-object response`,
    );
  }

  const directOrders = toOrderStatusRows(value.orders);
  const directLatestOrders = toOrderStatusRows(value.latest_orders);
  const directTotalPages = toPositiveInteger(value.total_pages);
  if (directOrders !== undefined && directTotalPages !== undefined) {
    return {
      latestOrders: directLatestOrders ?? [],
      orders: directOrders,
      nextTotalPages: directTotalPages,
    };
  }

  const data = value.data;
  if (isRecord(data)) {
    const nestedOrders = toOrderStatusRows(data.orders);
    const nestedLatestOrders = toOrderStatusRows(data.latest_orders);
    const nestedTotalPages = toPositiveInteger(data.total_pages);
    if (nestedOrders !== undefined && nestedTotalPages !== undefined) {
      return {
        latestOrders: nestedLatestOrders ?? [],
        orders: nestedOrders,
        nextTotalPages: nestedTotalPages,
      };
    }
  }

  throw new Error(
    `getPaginatedOrders(page=${page}) returned an unexpected response shape`,
  );
}

function toOrderStatusRows(
  value: unknown,
): Array<{ id: string; status: unknown }> | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const rows: Array<{ id: string; status: unknown }> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    rows.push({ id, status: item.status });
  }
  return rows;
}

function extractOrdersWithTimeInForce(
  value: unknown,
  page: number,
): {
  rows: Array<{
    id: string;
    tif: unknown;
    orderType: unknown;
    createdAt: unknown;
  }>;
  totalPages: number;
} {
  if (!isRecord(value)) {
    throw new Error(
      `getPaginatedOrders(page=${page}) returned a non-object response`,
    );
  }

  const directRows = toOrderTifRows(value.orders);
  const directLatestRows = toOrderTifRows(value.latest_orders);
  const directTotalPages = toPositiveInteger(value.total_pages);

  if (directRows !== undefined && directTotalPages !== undefined) {
    return {
      rows: [...(directLatestRows ?? []), ...directRows],
      totalPages: directTotalPages,
    };
  }

  const data = value.data;
  if (isRecord(data)) {
    const nestedRows = toOrderTifRows(data.orders);
    const nestedLatestRows = toOrderTifRows(data.latest_orders);
    const nestedTotalPages = toPositiveInteger(data.total_pages);
    if (nestedRows !== undefined && nestedTotalPages !== undefined) {
      return {
        rows: [...(nestedLatestRows ?? []), ...nestedRows],
        totalPages: nestedTotalPages,
      };
    }
  }

  throw new Error(
    `getPaginatedOrders(page=${page}) returned an unexpected response shape`,
  );
}

function toOrderTifRows(
  value: unknown,
): Array<{
  id: string;
  tif: unknown;
  orderType: unknown;
  createdAt: unknown;
}> | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const rows: Array<{
    id: string;
    tif: unknown;
    orderType: unknown;
    createdAt: unknown;
  }> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item.id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    rows.push({
      id,
      tif: isRecord(item) ? item.time_in_force : undefined,
      orderType: item.order_type,
      createdAt: item.created_at,
    });
  }
  return rows;
}

function toNumeric(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}
