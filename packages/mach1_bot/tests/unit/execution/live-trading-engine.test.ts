import { APIError } from "mach1_sdk";
import { parseUnits } from "viem";
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it("reads profile balance via asset endpoint", async () => {
    const engine = makeEngine();
    const token = "0x1111111111111111111111111111111111111111";
    const getUserBalanceByAssetId = vi.fn().mockResolvedValue({
      available_balance: "1.5",
      locked_balance: "0",
      total_balance: "1.5",
      symbol: "ETH",
    });
    const getUserBalances = vi.fn();

    (
      engine as unknown as {
        monacoSDK: {
          getSDK: () => {
            profile: {
              getUserBalanceByAssetId: typeof getUserBalanceByAssetId;
              getUserBalances: typeof getUserBalances;
            };
          };
          getTradingPairResolver: () => {
            getAssetIdByTokenAddress: (address: string) => string | undefined;
            getAllPairs: () => Array<{
              base_token_contract: string;
              base_decimals: number;
            }>;
          };
        };
      }
    ).monacoSDK = {
      getSDK: () => ({
        profile: {
          getUserBalanceByAssetId,
          getUserBalances,
        },
      }),
      getTradingPairResolver: () => ({
        getAssetIdByTokenAddress: (address: string) =>
          address.toLowerCase() === token.toLowerCase()
            ? "eth-asset-id"
            : undefined,
        getAllPairs: () => [
          {
            base_token_contract: token,
            base_decimals: 18,
          },
        ],
      }),
    };

    await expect(engine.getBalance(token)).resolves.toBe(parseUnits("1.5", 18));
    expect(getUserBalanceByAssetId).toHaveBeenCalledWith("eth-asset-id");
    expect(getUserBalances).not.toHaveBeenCalled();
  });

  it("startLiveTrading cannot create two active loops", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const strategyCallback = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(
      engine as unknown as { enableLiveMarketData: () => Promise<void> },
      "enableLiveMarketData",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      engine as unknown as { constructLiveMarketData: () => Promise<unknown> },
      "constructLiveMarketData",
    ).mockResolvedValue({
      "ETH/USDC": {
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        rsi: 50,
        macdSignal: 0,
        timestamp: 1,
      },
    });

    engine.setStrategyCallback(strategyCallback, 50);

    await engine.startLiveTrading();
    await engine.startLiveTrading();

    expect(strategyCallback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(strategyCallback).toHaveBeenCalledTimes(3);
  });

  it("stopLiveTrading stops coordinator and market subscriptions", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const strategyCallback = vi.fn().mockResolvedValue(undefined);
    const disableLiveMarketData = vi
      .spyOn(
        engine as unknown as { disableLiveMarketData: () => Promise<void> },
        "disableLiveMarketData",
      )
      .mockResolvedValue(undefined);

    vi.spyOn(
      engine as unknown as { enableLiveMarketData: () => Promise<void> },
      "enableLiveMarketData",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      engine as unknown as { constructLiveMarketData: () => Promise<unknown> },
      "constructLiveMarketData",
    ).mockResolvedValue({
      "ETH/USDC": {
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        rsi: 50,
        macdSignal: 0,
        timestamp: 1,
      },
    });

    engine.setStrategyCallback(strategyCallback, 50);

    await engine.startLiveTrading();
    expect(strategyCallback).toHaveBeenCalledTimes(1);

    await engine.stopLiveTrading();
    await vi.advanceTimersByTimeAsync(500);

    expect(strategyCallback).toHaveBeenCalledTimes(1);
    expect(disableLiveMarketData).toHaveBeenCalledTimes(1);
    expect(engine.getStrategyExecutionStats().state).toBeUndefined();
  });
});
