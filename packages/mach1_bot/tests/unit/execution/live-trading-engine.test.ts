import { APIError } from "mach1_sdk";
import { parseUnits } from "viem";
import type { OrderRequest } from "@/shared/types";
import { PriceUnavailableError } from "@/shared/errors";

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
    async getOHLCVSnapshot() {
      return undefined;
    }
    async disconnect(): Promise<void> {
      return;
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
    vi.spyOn(engine, "getLivePrice").mockResolvedValue(100n);

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
      orderId: expect.stringMatching(/^live_/),
      status: "filled",
    });
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  it("rejects live order before Monaco call when price unavailable", async () => {
    const engine = new LiveTradingEngine({
      privateKey: "0x" + "1".repeat(64),
      network: "testnet",
      maxSlippage: 1,
    });
    const placeOrder = vi.fn();

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
          placeOrder: typeof placeOrder;
          getTradingPairResolver: () => {
            normalizeSymbol: (symbol: string) => string;
            getPairByContracts: () => {
              symbol: string;
              base_decimals: number;
              quote_decimals: number;
            };
          };
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
      placeOrder,
      getTradingPairResolver: () => ({
        normalizeSymbol: (symbol: string) => symbol,
        getPairByContracts: () => ({
          symbol: "ETH/USDC",
          base_decimals: 18,
          quote_decimals: 6,
        }),
      }),
    };

    await expect(engine.placeOrder(order)).rejects.toBeInstanceOf(
      PriceUnavailableError,
    );
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("generates deterministic order ids with seeded rng", async () => {
    const { createSeededRng, createSteppingClock } = await import(
      "@/shared/utils/determinism"
    );
    const makeSeededEngine = () =>
      new LiveTradingEngine(
        {
          privateKey: "0x" + "1".repeat(64),
          network: "sei-testnet",
          maxSlippage: 1,
        },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          rng: createSeededRng(21),
          clock: createSteppingClock(1_700_000_000_000, 1),
        },
      );
    const buildMonaco = () => {
      const placeOrder = vi.fn().mockResolvedValue({
        orderId: "exchange-id",
        status: "filled",
        filledQuantity: order.quantity,
        remainingQuantity: 0n,
      });
      return {
        isInitialized: () => true,
        isPaused: () => false,
        placeOrder,
        getTradingPairResolver: () => ({
          normalizeSymbol: (symbol: string) => symbol,
          getPairByContracts: () => ({
            symbol: "ETH/USDC",
            base_decimals: 18,
            quote_decimals: 6,
          }),
        }),
      };
    };
    const first = makeSeededEngine();
    const second = makeSeededEngine();

    vi.spyOn(first, "checkPreTradeConditions").mockResolvedValue({
      hasPermission: true,
      hasFunds: true,
      withinLimits: true,
      estimatedGas: 0n,
      estimatedSlippage: 0,
    });
    vi.spyOn(second, "checkPreTradeConditions").mockResolvedValue({
      hasPermission: true,
      hasFunds: true,
      withinLimits: true,
      estimatedGas: 0n,
      estimatedSlippage: 0,
    });
    vi.spyOn(first, "getLivePrice").mockResolvedValue(100n);
    vi.spyOn(second, "getLivePrice").mockResolvedValue(100n);

    (
      first as unknown as {
        monacoSDK: ReturnType<typeof buildMonaco>;
      }
    ).monacoSDK = buildMonaco();
    (
      second as unknown as {
        monacoSDK: ReturnType<typeof buildMonaco>;
      }
    ).monacoSDK = buildMonaco();

    const firstResult = await first.placeOrder(order);
    const secondResult = await second.placeOrder(order);

    expect(firstResult.orderId).toBe(secondResult.orderId);
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
      engine as unknown as {
        buildLiveMarketDataSnapshot: () => Promise<{
          marketData: Record<string, unknown>;
          missingSymbols: string[];
        }>;
      },
      "buildLiveMarketDataSnapshot",
    ).mockResolvedValue({
      marketData: {
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
      },
      missingSymbols: [],
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
      engine as unknown as {
        buildLiveMarketDataSnapshot: () => Promise<{
          marketData: Record<string, unknown>;
          missingSymbols: string[];
        }>;
      },
      "buildLiveMarketDataSnapshot",
    ).mockResolvedValue({
      marketData: {
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
      },
      missingSymbols: [],
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

  it("skips live strategy tick when any pair lacks market data", async () => {
    vi.useFakeTimers();
    const engine = makeEngine();
    const strategyCallback = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.spyOn(
      engine as unknown as { enableLiveMarketData: () => Promise<void> },
      "enableLiveMarketData",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      engine as unknown as {
        buildLiveMarketDataSnapshot: () => Promise<{
          marketData: Record<string, unknown>;
          missingSymbols: string[];
        }>;
      },
      "buildLiveMarketDataSnapshot",
    ).mockResolvedValue({
      marketData: {
        "ETH/USDC": {
          close: 1,
        },
      },
      missingSymbols: ["BTC/USDC"],
    });

    engine.setStrategyCallback(strategyCallback, 50);
    await engine.startLiveTrading();

    expect(strategyCallback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("constructLiveMarketData computes RSI and MACD from candle history", async () => {
    const engine = makeEngine();

    (
      engine as unknown as {
        tradingPairs: string[];
        candles: Map<string, unknown>;
        orderbooks: Map<string, unknown>;
        monacoSDK: {
          getTradingPairResolver: () => {
            normalizeSymbol: (symbol: string) => string;
            getPairBySymbol: (symbol: string) =>
              | {
                  symbol: string;
                  base_token_contract: string;
                  quote_token_contract: string;
                }
              | undefined;
          };
        };
      }
    ).tradingPairs = ["ETH/USDC"];
    (
      engine as unknown as {
        candles: Map<string, unknown>;
      }
    ).candles.set("ETH/USDC", {
      T: 1_700_000_000_000,
      o: 180,
      h: 190,
      l: 175,
      c: 188,
      v: 999,
    });
    (
      engine as unknown as {
        orderbooks: Map<string, unknown>;
      }
    ).orderbooks.set("ETH/USDC", {
      bids: [{ price: "187.5", quantity: "1" }],
      asks: [{ price: "188.5", quantity: "1.5" }],
    });
    (
      engine as unknown as {
        monacoSDK: {
          getTradingPairResolver: () => {
            normalizeSymbol: (symbol: string) => string;
            getPairBySymbol: (symbol: string) =>
              | {
                  symbol: string;
                  base_token_contract: string;
                  quote_token_contract: string;
                }
              | undefined;
          };
        };
      }
    ).monacoSDK = {
      getTradingPairResolver: () => ({
        normalizeSymbol: (symbol: string) => symbol,
        getPairBySymbol: (symbol: string) =>
          symbol === "ETH/USDC"
            ? {
                symbol,
                base_token_contract:
                  "0x1111111111111111111111111111111111111111",
                quote_token_contract:
                  "0x2222222222222222222222222222222222222222",
              }
            : undefined,
      }),
    } as never;

    vi.spyOn(
      engine as unknown as {
        fetchCandleHistory: () => Promise<
          Array<{
            T: number;
            o: number;
            h: number;
            l: number;
            c: number;
            v: number;
          }>
        >;
      },
      "fetchCandleHistory",
    ).mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => ({
        T: 1_700_000_000_000 + index * 60_000,
        o: 100 + index,
        h: 102 + index,
        l: 99 + index,
        c: 101 + index,
        v: 1000 + index,
      })),
    );

    const marketData = await (
      engine as unknown as {
        constructLiveMarketData: () => Promise<Record<string, unknown>>;
      }
    ).constructLiveMarketData();
    const tick = marketData["ETH/USDC"] as {
      rsi: number;
      macdSignal: number;
      warnings?: string[];
    };

    expect(tick.rsi).toBeGreaterThan(50);
    expect(tick.macdSignal).not.toBe(0);
    expect(tick.warnings).toBeUndefined();
  });

  it("parses decimal live orderbook levels with resolver decimals", async () => {
    const engine = makeEngine();
    const pair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: "ETH/USDC",
    } as const;

    (
      engine as unknown as {
        monacoSDK: {
          getTradingPairResolver: () => {
            normalizeSymbol: (symbol: string) => string;
            getPairByContracts: () => {
              symbol: string;
              base_decimals: number;
              quote_decimals: number;
            };
          };
        };
      }
    ).monacoSDK = {
      getTradingPairResolver: () => ({
        normalizeSymbol: (symbol: string) => symbol,
        getPairByContracts: () => ({
          symbol: "ETH/USDC",
          base_decimals: 18,
          quote_decimals: 6,
        }),
      }),
    };
    (
      engine as unknown as {
        realtimeManager: {
          getOrderbookSnapshot: () => Promise<{
            bids: Array<{ price: string; quantity: string }>;
            asks: Array<{ price: string; quantity: string }>;
          }>;
        };
      }
    ).realtimeManager = {
      getOrderbookSnapshot: vi.fn().mockResolvedValue({
        bids: [{ price: "188.5", quantity: "1.25" }],
        asks: [{ price: "189.25", quantity: "2.5" }],
      }),
    };

    await expect(engine.getOrderBook(pair)).resolves.toEqual({
      bids: [
        {
          price: parseUnits("188.5", 6),
          quantity: parseUnits("1.25", 18),
        },
      ],
      asks: [
        {
          price: parseUnits("189.25", 6),
          quantity: parseUnits("2.5", 18),
        },
      ],
    });
  });

  it("parses integer live orderbook levels with resolver decimals", async () => {
    const engine = makeEngine();
    const pair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: "ETH/USDC",
    } as const;

    (
      engine as unknown as {
        monacoSDK: {
          getTradingPairResolver: () => {
            normalizeSymbol: (symbol: string) => string;
            getPairByContracts: () => {
              symbol: string;
              base_decimals: number;
              quote_decimals: number;
            };
          };
        };
      }
    ).monacoSDK = {
      getTradingPairResolver: () => ({
        normalizeSymbol: (symbol: string) => symbol,
        getPairByContracts: () => ({
          symbol: "ETH/USDC",
          base_decimals: 18,
          quote_decimals: 6,
        }),
      }),
    };
    (
      engine as unknown as {
        realtimeManager: {
          getOrderbookSnapshot: () => Promise<{
            bids: Array<{ price: string; quantity: string }>;
            asks: Array<{ price: string; quantity: string }>;
          }>;
        };
      }
    ).realtimeManager = {
      getOrderbookSnapshot: vi.fn().mockResolvedValue({
        bids: [{ price: "188", quantity: "2" }],
        asks: [{ price: "189", quantity: "3" }],
      }),
    };

    await expect(engine.getOrderBook(pair)).resolves.toEqual({
      bids: [
        {
          price: parseUnits("188", 6),
          quantity: parseUnits("2", 18),
        },
      ],
      asks: [
        {
          price: parseUnits("189", 6),
          quantity: parseUnits("3", 18),
        },
      ],
    });
  });

  it("cancels Monaco order with SDK returned id", async () => {
    const engine = makeEngine();
    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const placeOrder = vi.fn().mockResolvedValue({
      orderId: "sdk-order-123",
      status: "pending",
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    });

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
          placeOrder: typeof placeOrder;
          cancelOrder: typeof cancelOrder;
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
      placeOrder,
      cancelOrder,
    };

    const result = await engine.placeOrder(order);
    await engine.cancelOrder(result.orderId);

    expect(cancelOrder).toHaveBeenCalledWith("sdk-order-123");
  });

  it("emits rejected event on pre-trade failure", async () => {
    const { OrderLifecycleStore } = await import(
      "@/domains/execution/order-lifecycle-store"
    );
    const orderLifecycleStore = new OrderLifecycleStore();
    const events: string[] = [];
    orderLifecycleStore.getEventEmitter().on((event) => {
      events.push(event.type);
    });

    const engine = new LiveTradingEngine(
      {
        privateKey: "0x" + "1".repeat(64),
        network: "sei-testnet",
        maxSlippage: 1,
      },
      undefined,
      undefined,
      undefined,
      orderLifecycleStore,
    );

    (
      engine as unknown as {
        monacoSDK: {
          isInitialized: () => boolean;
          isPaused: () => boolean;
        };
      }
    ).monacoSDK = {
      isInitialized: () => true,
      isPaused: () => false,
    };
    vi.spyOn(engine, "checkPreTradeConditions").mockResolvedValue({
      hasPermission: true,
      hasFunds: false,
      withinLimits: true,
      estimatedGas: 0n,
      estimatedSlippage: 0,
    });

    await expect(engine.placeOrder(order)).resolves.toMatchObject({
      status: "rejected",
    });
    expect(events).toEqual(["submitted", "rejected"]);
  });
});
