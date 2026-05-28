import type {
  Candlestick,
  OrderbookEvent as MonacoOrderbookEvent,
} from "mach1_sdk";
import type { MarketData, OHLCV } from "@/shared/types";
import type { Clock, Rng } from "@/shared/utils/determinism";
import { realClock, realRng } from "@/shared/utils/determinism";

type OrderBookLevelLike = {
  price: string | number | bigint;
  quantity: string | number | bigint;
};

type OrderBookLike = {
  bids?: OrderBookLevelLike[];
  asks?: OrderBookLevelLike[];
};

type TradeLike = {
  price: number;
  volume?: number;
  quantity?: number;
  timestamp: number;
};

type IndicatorSnapshot = {
  rsi: number;
  macdSignal: number;
  insufficientHistory: boolean;
};

type OrderBookSnapshot = {
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  orderBookDepth?: {
    bids: number;
    asks: number;
  };
};

const DEFAULT_SIMULATION_BASE_PRICES: Record<string, number> = {
  "ETH/USDC": 2500,
  "BTC/USDC": 50000,
  "SOL/USDC": 150,
};

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  return undefined;
}

function isCandlestickLike(candle: Candlestick | OHLCV): candle is Candlestick {
  return "o" in candle;
}

function normalizeCandle(candle: Candlestick | OHLCV): OHLCV | undefined {
  if (isCandlestickLike(candle)) {
    const open = toFiniteNumber(candle.o);
    const high = toFiniteNumber(candle.h);
    const low = toFiniteNumber(candle.l);
    const close = toFiniteNumber(candle.c);
    const volume = toFiniteNumber(candle.v);

    if (
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined ||
      volume === undefined
    ) {
      return undefined;
    }

    return {
      timestamp: candle.T,
      open,
      high,
      low,
      close,
      volume,
    };
  }

  return candle;
}

function buildCandleFromTrades(
  timestamp: number,
  trades: TradeLike[],
): OHLCV | undefined {
  if (trades.length === 0) {
    return undefined;
  }

  const prices = trades
    .map((trade) => trade.price)
    .filter((price) => Number.isFinite(price));

  if (prices.length === 0) {
    return undefined;
  }

  return {
    timestamp,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    volume: trades.reduce(
      (sum, trade) => sum + (trade.volume ?? trade.quantity ?? 0),
      0,
    ),
  };
}

export class MarketDataService {
  private readonly rng: Rng;
  private readonly clock: Clock;

  constructor(options?: { rng?: Rng; clock?: Clock }) {
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
  }

  buildLiveTick(params: {
    symbol: string;
    ohlcv?: Candlestick;
    orderbook?: MonacoOrderbookEvent | OrderBookLike;
    candleHistory?: Array<Candlestick | OHLCV>;
  }): MarketData[string] | undefined {
    const candle = params.ohlcv ? normalizeCandle(params.ohlcv) : undefined;
    const orderBookMetrics = this.calculateOrderBookMetrics(params.orderbook);
    const indicatorSnapshot = this.calculateIndicators(params.candleHistory);

    if (
      !candle &&
      orderBookMetrics.bestBid === undefined &&
      orderBookMetrics.bestAsk === undefined
    ) {
      return undefined;
    }

    const derivedPrice =
      candle?.close ??
      this.deriveMidPrice(orderBookMetrics.bestBid, orderBookMetrics.bestAsk);

    if (derivedPrice === undefined) {
      return undefined;
    }

    const warnings = indicatorSnapshot.insufficientHistory
      ? ["Insufficient candle history for RSI/MACD; using neutral indicators."]
      : undefined;

    return {
      open: candle?.open ?? derivedPrice,
      high: candle?.high ?? derivedPrice,
      low: candle?.low ?? derivedPrice,
      close: candle?.close ?? derivedPrice,
      volume: candle?.volume ?? 0,
      ...orderBookMetrics,
      rsi: indicatorSnapshot.rsi,
      macdSignal: indicatorSnapshot.macdSignal,
      timestamp: candle?.timestamp ?? this.clock.now(),
      ...(warnings ? { warnings } : {}),
    };
  }

  buildBacktestTick(params: {
    symbol: string;
    timestamp: number;
    candles?: Array<Candlestick | OHLCV>;
    trades?: TradeLike[];
    orderbook?: OrderBookLike;
  }): MarketData[string] | undefined {
    const normalizedCandles = (params.candles ?? [])
      .map((candle) => normalizeCandle(candle))
      .filter((candle): candle is OHLCV => candle !== undefined);
    const latestCandle =
      normalizedCandles.length > 0
        ? normalizedCandles[normalizedCandles.length - 1]
        : undefined;
    const tradeCandle =
      !latestCandle && params.trades
        ? buildCandleFromTrades(params.timestamp, params.trades)
        : undefined;
    const candle = latestCandle ?? tradeCandle;

    if (!candle) {
      return undefined;
    }

    const indicators = this.calculateIndicators(normalizedCandles);
    const warnings = indicators.insufficientHistory
      ? [
          "Insufficient historical candle window for RSI/MACD; using neutral indicators.",
        ]
      : undefined;

    return {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      ...this.calculateOrderBookMetrics(params.orderbook),
      rsi: indicators.rsi,
      macdSignal: indicators.macdSignal,
      timestamp: candle.timestamp,
      ...(warnings ? { warnings } : {}),
    };
  }

  buildSimulationMarketData(symbols: readonly string[]): MarketData {
    const marketData: MarketData = {};
    const timestamp = this.clock.now();

    for (const symbol of symbols) {
      const basePrice = DEFAULT_SIMULATION_BASE_PRICES[symbol] ?? 100;
      marketData[symbol] = this.buildSimulationTick(
        symbol,
        basePrice,
        timestamp,
      );
    }

    return marketData;
  }

  buildSimulationTick(
    _symbol: string,
    basePrice: number,
    timestamp = this.clock.now(),
  ): MarketData[string] {
    const drift = (this.rng.next() - 0.5) * 0.04;
    const spreadBps = 0.0005 + this.rng.next() * 0.002;
    const open = basePrice * (1 + drift * 0.5);
    const close = basePrice * (1 + drift);
    const high = Math.max(open, close) * (1 + this.rng.next() * 0.01);
    const low = Math.min(open, close) * (1 - this.rng.next() * 0.01);
    const bestBid = close * (1 - spreadBps / 2);
    const bestAsk = close * (1 + spreadBps / 2);

    return {
      open,
      high,
      low,
      close,
      volume: 50_000 + this.rng.next() * 950_000,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      orderBookDepth: {
        bids: 3 + Math.floor(this.rng.next() * 8),
        asks: 3 + Math.floor(this.rng.next() * 8),
      },
      rsi: 30 + this.rng.next() * 40,
      macdSignal: (this.rng.next() - 0.5) * 2,
      timestamp,
    };
  }

  calculateOrderBookMetrics(
    orderbook?: MonacoOrderbookEvent | OrderBookLike,
  ): OrderBookSnapshot {
    if (!orderbook) {
      return {};
    }

    const bestBid = toFiniteNumber(orderbook.bids?.[0]?.price);
    const bestAsk = toFiniteNumber(orderbook.asks?.[0]?.price);

    return {
      ...(bestBid !== undefined ? { bestBid } : {}),
      ...(bestAsk !== undefined ? { bestAsk } : {}),
      ...(bestBid !== undefined && bestAsk !== undefined
        ? { spread: bestAsk - bestBid }
        : {}),
      orderBookDepth: {
        bids: orderbook.bids?.length ?? 0,
        asks: orderbook.asks?.length ?? 0,
      },
    };
  }

  calculateIndicators(candles?: Array<Candlestick | OHLCV>): IndicatorSnapshot {
    const normalizedCandles = (candles ?? [])
      .map((candle) => normalizeCandle(candle))
      .filter((candle): candle is OHLCV => candle !== undefined);

    if (normalizedCandles.length < 35) {
      return {
        rsi: 50,
        macdSignal: 0,
        insufficientHistory: true,
      };
    }

    return {
      rsi: this.calculateRSI(normalizedCandles),
      macdSignal: this.calculateMacdSignal(normalizedCandles),
      insufficientHistory: false,
    };
  }

  private calculateRSI(candles: OHLCV[], period = 14): number {
    if (candles.length < period + 1) {
      return 50;
    }

    const closes = candles.slice(-period - 1).map((candle) => candle.close);
    let gains = 0;
    let losses = 0;

    for (let index = 1; index < closes.length; index++) {
      const change = closes[index] - closes[index - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses -= change;
      }
    }

    if (losses === 0) {
      return 100;
    }

    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  private calculateMacdSignal(candles: OHLCV[]): number {
    const closes = candles.map((candle) => candle.close);
    const macdSeries: number[] = [];

    for (let index = 0; index < closes.length; index++) {
      const slice = closes.slice(0, index + 1);
      if (slice.length < 26) {
        continue;
      }
      macdSeries.push(
        this.calculateEma(slice, 12) - this.calculateEma(slice, 26),
      );
    }

    if (macdSeries.length < 9) {
      return 0;
    }

    return this.calculateEma(macdSeries, 9);
  }

  private calculateEma(values: number[], period: number): number {
    if (values.length === 0) {
      return 0;
    }

    if (values.length < period) {
      return values[values.length - 1];
    }

    const multiplier = 2 / (period + 1);
    let ema =
      values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

    for (let index = period; index < values.length; index++) {
      ema = values[index] * multiplier + ema * (1 - multiplier);
    }

    return ema;
  }

  private deriveMidPrice(
    bestBid?: number,
    bestAsk?: number,
  ): number | undefined {
    if (bestBid !== undefined && bestAsk !== undefined) {
      return (bestBid + bestAsk) / 2;
    }

    return bestBid ?? bestAsk;
  }
}
