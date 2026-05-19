import { APIError } from "mach1_sdk";
import type { OrderRequest } from "@/shared/types";

vi.mock("@/domains/trading/market-manager", () => ({
  MarketManager: class {
    setDefaultOHLCVInterval(): void {
      return;
    }
    setSDK(): void {
      return;
    }
    async getCurrentPrice(): Promise<bigint> {
      return 100n;
    }
  },
}));

vi.mock("@/domains/trading/order-manager", () => ({
  OrderManager: class {},
}));

vi.mock("@/domains/trading/realtime-manager", () => ({
  RealtimeManager: class {
    setSDK(): void {
      return;
    }
    async connect(): Promise<void> {
      return;
    }
    async getOrderbookSnapshot() {
      return { bids: [], asks: [] };
    }
  },
}));

describe("LiveTradingEngine order placement retries", () => {
  let LiveTradingEngine: typeof import("@/domains/execution/live-trading-engine").LiveTradingEngine;

  const order: OrderRequest = {
    baseToken: "0x1111111111111111111111111111111111111111",
    quoteToken: "0x2222222222222222222222222222222222222222",
    isBuy: true,
    orderType: "market",
    price: 100n,
    quantity: 469n,
  };

  beforeAll(async () => {
    ({ LiveTradingEngine } = await import(
      "@/domains/execution/live-trading-engine"
    ));
  });

  const makeEngine = () => {
    const engine = new LiveTradingEngine({
      privateKey: "0x" + "1".repeat(64),
      network: "testnet",
      maxSlippage: 1,
      maxRetries: 3,
      retryDelay: 0,
    });

    vi.spyOn(engine, "checkPreTradeConditions").mockResolvedValue({
      hasPermission: true,
      hasFunds: true,
      withinLimits: true,
      estimatedGas: 0n,
      estimatedSlippage: 0,
    });

    return engine;
  };

  it("does not retry non-retryable API liquidity errors", async () => {
    const engine = makeEngine();
    const placeOrder = vi
      .fn()
      .mockRejectedValue(
        new APIError(
          "Bad request: Cannot place market buy order: Insufficient liquidity: only 194.63144071 of 469 can be filled",
          { statusCode: 400 },
        ),
      );

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
          placeOrder: typeof placeOrder;
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
      placeOrder,
    };

    await expect(engine.placeOrder(order)).rejects.toThrow(
      "Insufficient liquidity",
    );
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("does not retry plain insufficient-liquidity errors", async () => {
    const engine = makeEngine();
    const placeOrder = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Bad request: Cannot place market buy order: Insufficient liquidity: only 57.51545944 of 469 can be filled",
        ),
      );

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
          placeOrder: typeof placeOrder;
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
      placeOrder,
    };

    await expect(engine.placeOrder(order)).rejects.toThrow(
      "Insufficient liquidity",
    );
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying transient API failures", async () => {
    const engine = makeEngine();
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new APIError("Rate limited", { statusCode: 429 }))
      .mockResolvedValueOnce({
        orderId: "ord_123",
        status: "filled",
        filledQuantity: order.quantity,
        remainingQuantity: 0n,
      });

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
          placeOrder: typeof placeOrder;
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
      placeOrder,
    };

    await expect(engine.placeOrder(order)).resolves.toMatchObject({
      orderId: "ord_123",
      status: "filled",
    });
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });
});
