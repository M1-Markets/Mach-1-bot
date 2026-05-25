describe("PaperTradingEngine strategy execution", () => {
  let PaperTradingEngine: typeof import("@/domains/execution/paper-trading-engine").PaperTradingEngine;

  beforeAll(async () => {
    ({ PaperTradingEngine } = await import(
      "@/domains/execution/paper-trading-engine"
    ));
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses configured interval instead of hardcoded 1000ms", async () => {
    const engine = new PaperTradingEngine(
      {
        initialCapital: 100_000n,
        commission: 0.001,
        slippage: 0.001,
        latencyMs: 0,
      },
      {} as never,
      {} as never,
    );
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

    engine.setStrategyCallback(strategyCallback, 5_000);
    await engine.startPaperTrading();

    expect(strategyCallback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(strategyCallback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_001);
    expect(strategyCallback).toHaveBeenCalledTimes(2);
  });

  it("constructs market data with canonical pair addresses", async () => {
    const engine = new PaperTradingEngine(
      {
        initialCapital: 100_000n,
        commission: 0.001,
        slippage: 0.001,
        latencyMs: 0,
      },
      {} as never,
      {} as never,
    );
    const seenPairs: Array<{ base: string; quote: string; symbol: string }> =
      [];

    vi.spyOn(
      engine as unknown as {
        getCurrentPrice: (pair: {
          base: string;
          quote: string;
          symbol: string;
        }) => Promise<bigint>;
      },
      "getCurrentPrice",
    ).mockImplementation(async (pair) => {
      seenPairs.push(pair);
      return 12345n;
    });

    await (
      engine as unknown as {
        constructLiveMarketData: () => Promise<unknown>;
      }
    ).constructLiveMarketData();

    expect(seenPairs).toContainEqual({
      base: "0x1111111111111111111111111111111111111111",
      quote: "0x4444444444444444444444444444444444444444",
      symbol: "ETH/USDC",
    });
    expect(seenPairs).toContainEqual({
      base: "0x2222222222222222222222222222222222222222",
      quote: "0x4444444444444444444444444444444444444444",
      symbol: "BTC/USDC",
    });
  });

  it("uses market manager trading pairs when generating market data", async () => {
    const engine = new PaperTradingEngine(
      {
        initialCapital: 100_000n,
        commission: 0.001,
        slippage: 0.001,
        latencyMs: 0,
      },
      {
        getAllTradingPairs: vi.fn().mockResolvedValue([
          {
            symbol: "DOGE/USDC",
            base_token_contract: "0x5555555555555555555555555555555555555555",
            quote_token_contract: "0x4444444444444444444444444444444444444444",
          },
        ]),
      } as never,
      {} as never,
    );

    vi.spyOn(
      engine as unknown as {
        getCurrentPrice: (pair: {
          base: string;
          quote: string;
          symbol: string;
        }) => Promise<bigint>;
      },
      "getCurrentPrice",
    ).mockResolvedValue(12345n);

    const marketData = await (
      engine as unknown as {
        constructLiveMarketData: () => Promise<Record<string, unknown>>;
      }
    ).constructLiveMarketData();

    expect(Object.keys(marketData)).toEqual(["DOGE/USDC"]);
  });

  it("emits fill event after scheduled fill", async () => {
    const { OrderLifecycleStore } = await import(
      "@/domains/execution/order-lifecycle-store"
    );
    const orderLifecycleStore = new OrderLifecycleStore();
    const events: string[] = [];
    orderLifecycleStore.getEventEmitter().on((event) => {
      events.push(event.type);
    });

    const engine = new PaperTradingEngine(
      {
        initialCapital: 1_000_000n,
        commission: 0,
        slippage: 0,
        latencyMs: 10,
      },
      {
        getCurrentPrice: vi.fn().mockResolvedValue(10_000n),
      } as never,
      {} as never,
      { orderLifecycleStore },
    );

    await engine.placeOrder({
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market",
      price: 10_000n,
      quantity: 100n,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(events).toEqual(["submitted", "accepted", "filled"]);
  });

  it("rejects paper order when market price unavailable", async () => {
    const { OrderLifecycleStore } = await import(
      "@/domains/execution/order-lifecycle-store"
    );
    const orderLifecycleStore = new OrderLifecycleStore();
    const events: string[] = [];
    orderLifecycleStore.getEventEmitter().on((event) => {
      events.push(`${event.type}:${event.order.rejectedReason ?? ""}`);
    });

    const engine = new PaperTradingEngine(
      {
        initialCapital: 1_000_000n,
        commission: 0,
        slippage: 0,
        latencyMs: 0,
      },
      {
        getCurrentPrice: vi.fn().mockRejectedValue(new Error("missing price")),
      } as never,
      {} as never,
      { orderLifecycleStore },
    );

    const result = await engine.placeOrder({
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market",
      price: 10_000n,
      quantity: 100n,
    });

    await vi.advanceTimersByTimeAsync(0);
    const status = await engine.getOrderStatus(result.orderId);

    expect(status.status).toBe("rejected");
    expect(events).toContain("rejected:price_unavailable");
  });

  it("applies 2x slippage above 100000 dollars and 1.5x above 10000 dollars", async () => {
    const engine = new PaperTradingEngine(
      {
        initialCapital: 1_000_000n,
        commission: 0,
        slippage: 0.01,
        latencyMs: 0,
      },
      {} as never,
      {} as never,
    );

    const calculateSlippage = (
      engine as unknown as {
        calculateSlippage: (
          order: {
            baseToken: string;
            quoteToken: string;
            isBuy: boolean;
            orderType: "market";
            price: bigint;
            quantity: bigint;
          },
          currentPrice: bigint,
        ) => bigint;
      }
    ).calculateSlippage.bind(engine);

    const baseOrder = {
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x0000000000000000000000000000000000000000",
      isBuy: true,
      orderType: "market" as const,
      price: 100n,
    };

    expect(
      calculateSlippage({ ...baseOrder, quantity: 50_000n }, 10_000n),
    ).toBe(150n);
    expect(
      calculateSlippage({ ...baseOrder, quantity: 150_000n }, 10_000n),
    ).toBe(200n);
  });

  it("generates deterministic order ids with seeded rng", async () => {
    const { createSeededRng, createSteppingClock } = await import(
      "@/shared/utils/determinism"
    );
    const buildEngine = () =>
      new PaperTradingEngine(
        {
          initialCapital: 1_000_000n,
          commission: 0,
          slippage: 0,
          latencyMs: 0,
        },
        {
          getCurrentPrice: vi.fn().mockResolvedValue(10_000n),
        } as never,
        {} as never,
        {
          rng: createSeededRng(9),
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
    const first = buildEngine();
    const second = buildEngine();

    const firstResult = await first.placeOrder(order);
    const secondResult = await second.placeOrder(order);

    expect(firstResult.orderId).toBe(secondResult.orderId);
  });
});
