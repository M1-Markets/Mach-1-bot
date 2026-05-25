import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import type { OrderRequest, TradingPair } from "@/shared/types";

const pair: TradingPair = {
  base: "0x1111111111111111111111111111111111111111",
  quote: "0x2222222222222222222222222222222222222222",
  symbol: "ETH/USDC",
};

const order: OrderRequest = {
  baseToken: pair.base,
  quoteToken: pair.quote,
  isBuy: true,
  orderType: "market",
  price: 10000n,
  quantity: 200n,
  strategyId: "strategy-1",
};

describe("OrderLifecycleStore", () => {
  it("tracks submitted to filled transition", () => {
    const store = new OrderLifecycleStore();
    const events: string[] = [];
    store.getEventEmitter().on((event) => {
      events.push(event.type);
    });

    store.createSubmittedOrder({
      localId: "local-1",
      pair,
      order,
      timestamp: 1000,
    });
    store.applyUpdate({
      localId: "local-1",
      type: "accepted",
      status: "pending",
      timestamp: 1001,
    });
    store.applyUpdate({
      localId: "local-1",
      type: "filled",
      status: "filled",
      filledQuantity: 200n,
      remainingQuantity: 0n,
      averageFillPrice: 10100n,
      fees: 5n,
      slippage: 2n,
      timestamp: 1002,
    });

    expect(events).toEqual(["submitted", "accepted", "filled"]);
    expect(store.getOrder("local-1")).toMatchObject({
      status: "filled",
      filledQuantity: 200n,
      remainingQuantity: 0n,
      averageFillPrice: 10100n,
      fees: 5n,
      slippage: 2n,
      strategyId: "strategy-1",
    });
  });

  it("tracks submitted to rejected transition", () => {
    const store = new OrderLifecycleStore();
    store.createSubmittedOrder({
      localId: "local-2",
      pair,
      order,
    });

    store.applyUpdate({
      localId: "local-2",
      type: "rejected",
      reason: "risk_rejected",
    });

    expect(store.getOrder("local-2")).toMatchObject({
      status: "rejected",
      rejectedReason: "risk_rejected",
    });
  });

  it("tracks partial fill transition", () => {
    const store = new OrderLifecycleStore();
    store.createSubmittedOrder({
      localId: "local-3",
      pair,
      order,
    });

    store.applyUpdate({
      localId: "local-3",
      type: "accepted",
      status: "pending",
    });
    store.applyUpdate({
      localId: "local-3",
      type: "partially_filled",
      status: "partially_filled",
      filledQuantity: 50n,
      remainingQuantity: 150n,
      averageFillPrice: 10000n,
    });

    expect(store.getOrder("local-3")).toMatchObject({
      status: "partially_filled",
      filledQuantity: 50n,
      remainingQuantity: 150n,
    });
  });

  it("tracks cancel transition", () => {
    const store = new OrderLifecycleStore();
    store.createSubmittedOrder({
      localId: "local-4",
      pair,
      order,
    });

    store.applyUpdate({
      localId: "local-4",
      type: "accepted",
      status: "pending",
    });
    store.applyUpdate({
      localId: "local-4",
      type: "cancelled",
      status: "cancelled",
      reason: "cancelled_by_user",
    });

    expect(store.getOrder("local-4")).toMatchObject({
      status: "cancelled",
      cancelledReason: "cancelled_by_user",
    });
  });
});
