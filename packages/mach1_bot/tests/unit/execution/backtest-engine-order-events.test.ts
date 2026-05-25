import { BacktestEngine } from "@/domains/execution/backtest-engine";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import {
  createSeededRng,
  createSteppingClock,
} from "@/shared/utils/determinism";

describe("BacktestEngine order events", () => {
  it("emits filled event on immediate fill", async () => {
    const store = new OrderLifecycleStore();
    const events: string[] = [];
    store.getEventEmitter().on((event) => {
      events.push(event.type);
    });
    const engine = new BacktestEngine(
      {
        startDate: new Date("2024-01-01T00:00:00Z"),
        endDate: new Date("2024-01-02T00:00:00Z"),
        initialCapital: 1_000_000n,
        commission: 0,
        slippage: 0,
      },
      { orderLifecycleStore: store },
    );

    const result = await engine.placeOrder({
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market",
      price: 10_000n,
      quantity: 100n,
    });

    expect(result.status).toBe("filled");
    expect(events).toEqual(["submitted", "accepted", "filled"]);
  });

  it("generates deterministic order ids with seeded rng", async () => {
    const buildEngine = () =>
      new BacktestEngine(
        {
          startDate: new Date("2024-01-01T00:00:00Z"),
          endDate: new Date("2024-01-02T00:00:00Z"),
          initialCapital: 1_000_000n,
          commission: 0,
          slippage: 0,
          seed: 12,
        },
        {
          rng: createSeededRng(12),
          clock: createSteppingClock(1_700_000_000_000, 1),
        },
      );

    const order = {
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market" as const,
      price: 10_000n,
      quantity: 100n,
    };

    const firstResult = await buildEngine().placeOrder(order);
    const secondResult = await buildEngine().placeOrder(order);

    expect(firstResult.orderId).toBe(secondResult.orderId);
  });

  it("returns filled no-op result when cancelling immediate-fill backtest order", async () => {
    const engine = new BacktestEngine({
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      initialCapital: 1_000_000n,
      commission: 0,
      slippage: 0,
    });

    const order = await engine.placeOrder({
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market",
      price: 10_000n,
      quantity: 100n,
    });

    const cancelResult = await engine.cancelOrder(order.orderId);

    expect(cancelResult).toMatchObject({
      orderId: order.orderId,
      status: "filled",
      cancellationApplied: false,
      reason: "already_filled",
    });
  });
});
