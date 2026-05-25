import { MarketDataService } from "@/domains/trading/market-data-service";
import { createSeededRng } from "@/shared/utils/determinism";

const buildCandles = (
  count: number,
  start = 100,
): Array<{
  T: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}> =>
  Array.from({ length: count }, (_, index) => {
    const close = start + index * 2;
    return {
      T: 1_700_000_000_000 + index * 60_000,
      o: close - 1,
      h: close + 2,
      l: close - 3,
      c: close,
      v: 1000 + index * 10,
    };
  });

describe("MarketDataService", () => {
  it("builds live market data from OHLCV snapshots", () => {
    const service = new MarketDataService({
      clock: { now: () => 1_700_000_000_000 },
    });
    const candleHistory = buildCandles(50);

    const tick = service.buildLiveTick({
      symbol: "ETH/USDC",
      ohlcv: candleHistory[candleHistory.length - 1],
      candleHistory,
    });

    expect(tick).toBeDefined();
    expect(tick?.open).toBe(candleHistory[candleHistory.length - 1].o);
    expect(tick?.close).toBe(candleHistory[candleHistory.length - 1].c);
    expect(tick?.volume).toBe(candleHistory[candleHistory.length - 1].v);
    expect(tick?.rsi).toBeGreaterThan(50);
    expect(tick?.macdSignal).not.toBe(0);
    expect(tick?.warnings).toBeUndefined();
  });

  it("builds live market data from orderbook snapshots when OHLCV unavailable", () => {
    const service = new MarketDataService({
      clock: { now: () => 1_700_000_000_000 },
    });

    const tick = service.buildLiveTick({
      symbol: "ETH/USDC",
      orderbook: {
        bids: [{ price: "2499.5", quantity: "3.2" }],
        asks: [{ price: "2500.5", quantity: "2.1" }],
      },
    });

    expect(tick).toEqual({
      open: 2500,
      high: 2500,
      low: 2500,
      close: 2500,
      volume: 0,
      bestBid: 2499.5,
      bestAsk: 2500.5,
      spread: 1,
      orderBookDepth: {
        bids: 1,
        asks: 1,
      },
      rsi: 50,
      macdSignal: 0,
      timestamp: 1_700_000_000_000,
      warnings: [
        "Insufficient candle history for RSI/MACD; using neutral indicators.",
      ],
    });
  });

  it("builds backtest market data from historical candles", () => {
    const service = new MarketDataService();
    const candles = buildCandles(60).map((candle) => ({
      timestamp: candle.T,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volume: candle.v,
    }));

    const tick = service.buildBacktestTick({
      symbol: "BTC/USDC",
      timestamp: candles[candles.length - 1].timestamp,
      candles,
    });

    expect(tick).toBeDefined();
    expect(tick?.close).toBe(candles[candles.length - 1].close);
    expect(tick?.rsi).toBeGreaterThan(50);
    expect(tick?.macdSignal).not.toBe(0);
  });

  it("builds deterministic simulated market data with seeded RNG", () => {
    const clock = { now: () => 1_700_000_000_000 };
    const first = new MarketDataService({
      rng: createSeededRng(42),
      clock,
    });
    const second = new MarketDataService({
      rng: createSeededRng(42),
      clock,
    });

    expect(first.buildSimulationMarketData()).toEqual(
      second.buildSimulationMarketData(),
    );
  });
});
