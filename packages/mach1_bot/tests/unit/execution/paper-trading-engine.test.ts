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
});
