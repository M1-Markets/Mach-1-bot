import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import { PositionTracker } from "@/domains/trading/position-tracker";
import type { OrderLifecycleEvent, TradingPair } from "@/shared/types";

const pair: TradingPair = {
  base: "0x1111111111111111111111111111111111111111",
  quote: "0x2222222222222222222222222222222222222222",
  symbol: "ETH/USDC",
};

const makeFillEvent = (
  price: bigint,
  filledQuantity: bigint,
): OrderLifecycleEvent => ({
  type: "filled",
  previousStatus: "accepted",
  timestamp: Date.now(),
  order: {
    localId: "order-1",
    strategyId: "strategy-1",
    pair,
    side: "buy",
    type: "market",
    requestedQuantity: filledQuantity,
    filledQuantity,
    remainingQuantity: 0n,
    averageFillPrice: price,
    fees: 0n,
    slippage: 0n,
    status: "filled",
    submittedAt: Date.now(),
    updatedAt: Date.now(),
  },
});

describe("PositionTracker order lifecycle accounting", () => {
  it("buy fill creates entry price and positive unrealized pnl above entry", async () => {
    const marketManager = {
      getCurrentPrice: vi.fn().mockResolvedValue(11000n),
      getAllTradingPairs: vi.fn().mockResolvedValue([]),
    } as never;
    const tracker = new PositionTracker(marketManager, {} as never);
    const emitter = new OrderEventEmitter();
    tracker.attachOrderEventEmitter(emitter);

    emitter.emit(makeFillEvent(10000n, 200n));
    await Promise.resolve();

    const position = await tracker.getPosition(pair);
    expect(position.balance).toBe(200n);
    expect(position.unrealizedPnL).toBeGreaterThan(0n);
  });
});
