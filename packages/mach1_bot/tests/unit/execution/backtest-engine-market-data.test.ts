import { BacktestEngine } from "@/domains/execution/backtest-engine";

describe("BacktestEngine market data indicators", () => {
  it("keeps neutral indicators until enough candle history exists", async () => {
    const engine = new BacktestEngine({
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      initialCapital: 100000n,
      commission: 0.001,
      slippage: 0.001,
    });

    (
      engine as unknown as {
        historicalData: Map<
          string,
          Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>
        >;
      }
    ).historicalData.set(
      "ETHUSDC_1m",
      Array.from({ length: 20 }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index * 60_000,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000 + index,
      })),
    );
    (
      engine as unknown as {
        tradeData: Array<{
          tradeId: number;
          price: number;
          quantity: number;
          volume: number;
          timestamp: number;
          isBuyerMaker: boolean;
          bestMatch: boolean;
          tradingPair: string;
        }>;
      }
    ).tradeData = [
      {
        tradeId: 1,
        price: 120,
        quantity: 1,
        volume: 1,
        timestamp: 1_700_000_000_000 + 19 * 60_000,
        isBuyerMaker: false,
        bestMatch: true,
        tradingPair: "ETHUSDC",
      },
    ];

    const marketData = (
      engine as unknown as {
        constructMarketData: (timestamp: number) => Record<
          string,
          {
            rsi: number;
            macdSignal: number;
            warnings?: string[];
          }
        >;
      }
    ).constructMarketData(1_700_000_000_000 + 19 * 60_000);

    expect(marketData["ETH/USDC"]).toMatchObject({
      rsi: 50,
      macdSignal: 0,
      warnings: [
        "Insufficient historical candle window for RSI/MACD; using neutral indicators.",
      ],
    });
  });

  it("constructMarketData computes non-neutral RSI and MACD from historical candles", async () => {
    const engine = new BacktestEngine({
      startDate: new Date("2024-01-01T00:00:00Z"),
      endDate: new Date("2024-01-02T00:00:00Z"),
      initialCapital: 100000n,
      commission: 0.001,
      slippage: 0.001,
    });

    (
      engine as unknown as {
        historicalData: Map<
          string,
          Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
          }>
        >;
        tradeData: Array<{
          tradeId: number;
          price: number;
          quantity: number;
          volume: number;
          timestamp: number;
          isBuyerMaker: boolean;
          bestMatch: boolean;
          tradingPair: string;
        }>;
      }
    ).historicalData.set(
      "ETHUSDC_1m",
      Array.from({ length: 60 }, (_, index) => ({
        timestamp: 1_700_000_000_000 + index * 60_000,
        open: 100 + index,
        high: 101 + index,
        low: 99 + index,
        close: 100.5 + index,
        volume: 1000 + index,
      })),
    );
    (
      engine as unknown as {
        tradeData: Array<{
          tradeId: number;
          price: number;
          quantity: number;
          volume: number;
          timestamp: number;
          isBuyerMaker: boolean;
          bestMatch: boolean;
          tradingPair: string;
        }>;
      }
    ).tradeData = Array.from({ length: 10 }, (_, index) => ({
      tradeId: index,
      price: 150 + index,
      quantity: 1,
      volume: 1,
      timestamp: 1_700_000_000_000 + index * 60_000,
      isBuyerMaker: false,
      bestMatch: true,
      tradingPair: "ETHUSDC",
    }));

    const marketData = (
      engine as unknown as {
        constructMarketData: (timestamp: number) => Record<
          string,
          {
            rsi: number;
            macdSignal: number;
            warnings?: string[];
          }
        >;
      }
    ).constructMarketData(1_700_000_000_000 + 59 * 60_000);
    const tick = marketData["ETH/USDC"];

    expect(tick).toBeDefined();
    expect(tick.rsi).toBeGreaterThan(50);
    expect(tick.macdSignal).not.toBe(0);
    expect(tick.warnings).toBeUndefined();
  });
});
