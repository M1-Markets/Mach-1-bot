import type { Mach1SDK } from "mach1_sdk";
import { vi } from "vitest";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import type { OrderRequest, TradingPair } from "@/shared/types";
import {
  createSeededRng,
  createSteppingClock,
} from "@/shared/utils/determinism";

const pair: TradingPair = {
  base: "0x1111111111111111111111111111111111111111",
  quote: "0x0987654321098765432109876543210987654321",
  symbol: "ETH/USDC",
};

const order: OrderRequest = {
  baseToken: pair.base,
  quoteToken: pair.quote,
  isBuy: true,
  orderType: "limit",
  price: 300000n,
  quantity: 200n,
  strategyId: "strategy-1",
};

type RealtimeManagerTestSdk = Pick<Mach1SDK, "ws">;
type RealtimeManagerTestState = {
  startMarketDataSimulation(): void;
  emitMockTrade(pair: TradingPair): Promise<void>;
};

const asRealtimeManagerTestState = (
  realtimeManager: RealtimeManager,
): RealtimeManagerTestState =>
  realtimeManager as unknown as RealtimeManagerTestState;

describe("RealtimeManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects live connect when sdk.ws missing", async () => {
    const marketManager = new MarketManager({ mode: "live" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      { mode: "live" },
    );

    await expect(realtimeManager.connect()).rejects.toMatchObject({
      name: "ConnectionError",
      message: expect.stringContaining("Monaco SDK WebSocket client"),
    });
  });

  it("rejects live connect on websocket timeout and exposes last error", async () => {
    const marketManager = new MarketManager({ mode: "live" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      {
        ws: {
          isConnected: () => false,
          connect: () => new Promise<void>(() => undefined),
        },
      } as unknown as RealtimeManagerTestSdk,
      { mode: "live" },
    );

    await expect(realtimeManager.connect()).rejects.toMatchObject({
      name: "ConnectionError",
      message: expect.stringContaining("connect timeout"),
    });
    expect(realtimeManager.getConnectionStatus().lastConnectionError).toContain(
      "connect timeout",
    );
  });

  it("exposes live websocket status after sdk connect", async () => {
    const marketManager = new MarketManager({ mode: "live" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      {
        ws: {
          isConnected: () => false,
          connect: vi.fn().mockResolvedValue(undefined),
        },
      } as unknown as RealtimeManagerTestSdk,
      { mode: "live" },
    );

    await realtimeManager.connect();

    expect(realtimeManager.getConnectionStatus()).toMatchObject({
      connected: true,
      mode: "live",
      usingLiveWebSocket: true,
      lastConnectionError: undefined,
      activeSubscriptionKeys: [],
    });
  });

  it("starts simulated stream in simulation mode and reports simulation status", async () => {
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      { mode: "simulation" },
    );
    const startSimulationSpy = vi.spyOn(
      asRealtimeManagerTestState(realtimeManager),
      "startMarketDataSimulation",
    );

    await realtimeManager.connect();

    expect(startSimulationSpy).toHaveBeenCalledTimes(1);
    expect(realtimeManager.getConnectionStatus()).toMatchObject({
      connected: true,
      mode: "simulation",
      usingLiveWebSocket: false,
      activeSubscriptionKeys: ["price_simulation"],
    });
    await realtimeManager.disconnect();
  });

  it("calls startMarketDataSimulation once across repeated simulation connects", async () => {
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      { mode: "simulation" },
    );
    const startSimulationSpy = vi.spyOn(
      asRealtimeManagerTestState(realtimeManager),
      "startMarketDataSimulation",
    );

    await realtimeManager.connect();
    await realtimeManager.connect();

    expect(startSimulationSpy).toHaveBeenCalledTimes(1);
    await realtimeManager.disconnect();
  });

  it("emits same mock trade sequence for same rng seed and clock", async () => {
    const build = () => {
      const rng = createSeededRng(17);
      const clock = createSteppingClock(1_700_000_000_000, 50);
      const marketManager = new MarketManager({
        mode: "simulation",
        rng: createSeededRng(17),
        clock: createSteppingClock(1_700_000_000_000, 50),
      });
      const orderManager = new OrderManager(marketManager, {
        rng: createSeededRng(17),
      });
      return new RealtimeManager(marketManager, orderManager, undefined, {
        mode: "simulation",
        rng,
        clock,
      });
    };

    const manager1 = build();
    const manager2 = build();
    const trades1: Array<Record<string, unknown>> = [];
    const trades2: Array<Record<string, unknown>> = [];

    const stream1 = await manager1.subscribeTrades(pair);
    stream1.subscribe((event) => {
      trades1.push({
        id: event.trade.id,
        quantity: event.trade.quantity,
        isBuy: event.trade.isBuy,
        timestamp: event.trade.timestamp,
        blockNumber: event.trade.blockNumber,
        transactionHash: event.trade.transactionHash,
      });
    });

    const stream2 = await manager2.subscribeTrades(pair);
    stream2.subscribe((event) => {
      trades2.push({
        id: event.trade.id,
        quantity: event.trade.quantity,
        isBuy: event.trade.isBuy,
        timestamp: event.trade.timestamp,
        blockNumber: event.trade.blockNumber,
        transactionHash: event.trade.transactionHash,
      });
    });

    for (let index = 0; index < 6; index++) {
      await asRealtimeManagerTestState(manager1).emitMockTrade(pair);
      await asRealtimeManagerTestState(manager2).emitMockTrade(pair);
    }

    expect(trades1).toEqual(trades2);
    expect(trades1.length).toBeGreaterThan(0);

    await manager1.disconnect();
    await manager2.disconnect();
  });

  it("does not emit random user-order updates without order changes", async () => {
    vi.useFakeTimers();

    const store = new OrderLifecycleStore();
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      {
        mode: "simulation",
        orderEventEmitter: store.getEventEmitter(),
      },
    );

    const handler = vi.fn();
    const stream = await realtimeManager.subscribeUserOrders();
    stream.subscribe(handler);

    await vi.advanceTimersByTimeAsync(6000);

    expect(handler).not.toHaveBeenCalled();
    await realtimeManager.disconnect();
  });

  it("emits fill events on user-order stream from lifecycle changes", async () => {
    const store = new OrderLifecycleStore();
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      {
        mode: "simulation",
        orderEventEmitter: store.getEventEmitter(),
      },
    );

    const events: Array<{ previousStatus?: string; newStatus?: string }> = [];
    const stream = await realtimeManager.subscribeUserOrders();
    stream.subscribe((event) => {
      events.push({
        previousStatus: event.previousStatus,
        newStatus: event.newStatus,
      });
    });

    store.createSubmittedOrder({
      localId: "fill-1",
      pair,
      order,
      timestamp: 1000,
    });
    store.applyUpdate({
      localId: "fill-1",
      type: "accepted",
      status: "pending",
      timestamp: 1001,
    });
    store.applyUpdate({
      localId: "fill-1",
      type: "filled",
      status: "filled",
      filledQuantity: 200n,
      remainingQuantity: 0n,
      averageFillPrice: 301000n,
      timestamp: 1002,
    });

    expect(events).toContainEqual({
      previousStatus: "PENDING",
      newStatus: "FILLED",
    });
    await realtimeManager.disconnect();
  });

  it("emits cancel events on user-order stream from lifecycle changes", async () => {
    const store = new OrderLifecycleStore();
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      {
        mode: "simulation",
        orderEventEmitter: store.getEventEmitter(),
      },
    );

    const handler = vi.fn();
    const stream = await realtimeManager.subscribeUserOrders();
    stream.subscribe(handler);

    store.createSubmittedOrder({
      localId: "cancel-1",
      pair,
      order,
      timestamp: 1000,
    });
    store.applyUpdate({
      localId: "cancel-1",
      type: "accepted",
      status: "pending",
      timestamp: 1001,
    });
    store.applyUpdate({
      localId: "cancel-1",
      type: "cancelled",
      status: "cancelled",
      reason: "cancelled_by_user",
      timestamp: 1002,
    });

    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousStatus: "PENDING",
        newStatus: "CANCELLED",
      }),
    );
    await realtimeManager.disconnect();
  });

  it("disconnect clears status and active subscriptions", async () => {
    const marketManager = new MarketManager({ mode: "simulation" });
    const orderManager = new OrderManager(marketManager);
    const realtimeManager = new RealtimeManager(
      marketManager,
      orderManager,
      undefined,
      { mode: "simulation" },
    );

    const priceStream = await realtimeManager.subscribePrices([pair]);
    const priceUnsub = priceStream.subscribe(() => undefined);
    const tradeStream = await realtimeManager.subscribeTrades(pair);
    const tradeUnsub = tradeStream.subscribe(() => undefined);

    expect(
      realtimeManager.getConnectionStatus().activeSubscriptionKeys,
    ).toEqual(
      expect.arrayContaining([
        "price_simulation",
        `price:${pair.base}-${pair.quote}`,
        `trades:${pair.base}-${pair.quote}`,
      ]),
    );

    priceUnsub();
    tradeUnsub();
    await realtimeManager.disconnect();

    expect(realtimeManager.getConnectionStatus()).toMatchObject({
      connected: false,
      activeSubscriptions: 0,
      totalEventListeners: 0,
      activeSubscriptionKeys: [],
      lastConnectionError: undefined,
    });
  });
});
