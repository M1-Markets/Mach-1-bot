import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import {
  PositionTracker,
  type PositionTrackerOptions,
} from "@/domains/trading/position-tracker";
import type { Address, OrderLifecycleEvent, TradingPair } from "@/shared/types";

const ETH = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x0987654321098765432109876543210987654321" as Address;

const pair: TradingPair = {
  base: ETH,
  quote: USDC,
  symbol: "ETH/USDC",
};

const tradingPairs = [
  {
    id: "ETH_USDC",
    base_token: "ETH",
    quote_token: "USDC",
    base_asset_id: "eth-asset",
    quote_asset_id: "usdc-asset",
    base_icon_url: "",
    quote_icon_url: "",
    base_token_contract: ETH,
    quote_token_contract: USDC,
    symbol: "ETH/USDC",
    base_decimals: 18,
    quote_decimals: 6,
    market_type: "SPOT",
    is_active: true,
    maker_fee_bps: 10,
    taker_fee_bps: 20,
    min_order_size: "0.001",
    max_order_size: "10000",
    tick_size: "0.01",
  },
];

const createTracker = ({
  currentPrice = 12_000n,
  options,
}: {
  currentPrice?: bigint;
  options?: PositionTrackerOptions;
} = {}) => {
  const marketManager = {
    getCurrentPrice: vi.fn().mockResolvedValue(currentPrice),
    getAllTradingPairs: vi.fn().mockResolvedValue(tradingPairs),
    getMode: vi.fn().mockReturnValue(options?.mode ?? "live"),
  } as never;

  return {
    tracker: new PositionTracker(marketManager, {} as never, options),
    marketManager,
  };
};

const makeFillEvent = ({
  localId,
  side,
  price,
  filledQuantity,
  fees = 0n,
  feeCurrency = USDC,
  timestamp = Date.now(),
}: {
  localId: string;
  side: "buy" | "sell";
  price: bigint;
  filledQuantity: bigint;
  fees?: bigint;
  feeCurrency?: Address;
  timestamp?: number;
}): OrderLifecycleEvent => ({
  type: "filled",
  previousStatus: "accepted",
  timestamp,
  order: {
    localId,
    strategyId: "strategy-1",
    pair,
    side,
    type: "market",
    requestedPrice: price,
    requestedQuantity: filledQuantity,
    filledQuantity,
    remainingQuantity: 0n,
    averageFillPrice: price,
    fees,
    feeCurrency,
    slippage: 0n,
    status: "filled",
    submittedAt: timestamp,
    updatedAt: timestamp,
  },
});

const makeRejectedEvent = ({
  localId,
  side,
  price,
  quantity,
  timestamp = Date.now(),
}: {
  localId: string;
  side: "buy" | "sell";
  price: bigint;
  quantity: bigint;
  timestamp?: number;
}): OrderLifecycleEvent => ({
  type: "rejected",
  previousStatus: "submitted",
  timestamp,
  order: {
    localId,
    strategyId: "strategy-1",
    pair,
    side,
    type: "market",
    requestedPrice: price,
    requestedQuantity: quantity,
    filledQuantity: 0n,
    remainingQuantity: quantity,
    averageFillPrice: undefined,
    fees: 0n,
    feeCurrency: USDC,
    slippage: 0n,
    status: "rejected",
    submittedAt: timestamp,
    updatedAt: timestamp,
  },
});

describe("PositionTracker Phase 14 accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buy fill creates base position and values with market price", async () => {
    const { tracker } = createTracker({ currentPrice: 12_000n });
    const emitter = new OrderEventEmitter();
    tracker.attachOrderEventEmitter(emitter);

    emitter.emit(
      makeFillEvent({
        localId: "buy-1",
        side: "buy",
        price: 10_000n,
        filledQuantity: 200n,
      }),
    );
    await vi.runAllTimersAsync();

    const position = await tracker.getPosition(pair);
    expect(position.balance).toBe(200n);
    expect(position.value).toBe(24_000n);
    expect(position.unrealizedPnL).toBe(4_000n);
  });

  it("rejected order event does not change positions or trade history", async () => {
    const { tracker } = createTracker({ currentPrice: 12_000n });
    const emitter = new OrderEventEmitter();
    tracker.attachOrderEventEmitter(emitter);

    emitter.emit(
      makeRejectedEvent({
        localId: "reject-1",
        side: "buy",
        price: 10_000n,
        quantity: 200n,
      }),
    );
    await vi.runAllTimersAsync();

    const position = await tracker.getPosition(pair);
    const tradeHistory = await tracker.getTradeHistory(pair);

    expect(position.balance).toBe(0n);
    expect(position.value).toBe(0n);
    expect(position.unrealizedPnL).toBe(0n);
    expect(tradeHistory).toEqual([]);
  });

  it("sell reduces base position and preserves remaining average entry price", async () => {
    const { tracker } = createTracker();

    await tracker.recordTrade(
      {
        id: "buy-1",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 300n,
        filledQuantity: 300n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now() - 10_000,
      } as never,
      10_000n,
      300n,
      { feeAmount: 0n },
    );

    await tracker.recordTrade(
      {
        id: "sell-1",
        baseToken: ETH,
        quoteToken: USDC,
        price: 11_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: false,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      11_000n,
      100n,
      { feeAmount: 0n },
    );

    const position = await tracker.getPosition(pair);
    expect(position.balance).toBe(200n);

    const tradeHistory = await tracker.getTradeHistory(pair);
    const buyTrade = tradeHistory.find((trade) => trade.orderId === "buy-1");
    const sellTrade = tradeHistory.find((trade) => trade.orderId === "sell-1");

    expect(buyTrade?.realizedPnL).toBe(0n);
    expect(sellTrade?.realizedPnL).toBe(1_000n);

    await tracker.recordTrade(
      {
        id: "sell-2",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: false,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      10_000n,
      100n,
      { feeAmount: 0n },
    );

    const partialPosition = await tracker.getPosition(pair);
    expect(partialPosition.balance).toBe(100n);

    const pnl = await tracker.calculatePnL(pair);
    expect(pnl.realized).toBe(1_000n);
    expect(pnl.unrealized).toBe(2_000n);
  });

  it("sell fill does not create quote-token position", async () => {
    const { tracker } = createTracker({
      options: {
        mode: "live",
        startingBalances: {
          [ETH]: 300n,
          [USDC]: 0n,
        },
      },
    });

    await tracker.recordTrade(
      {
        id: "buy-seed",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 300n,
        filledQuantity: 300n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now() - 10_000,
      } as never,
      10_000n,
      300n,
      { feeAmount: 0n },
    );

    await tracker.recordTrade(
      {
        id: "sell-only",
        baseToken: ETH,
        quoteToken: USDC,
        price: 11_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: false,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      11_000n,
      100n,
      { feeAmount: 0n },
    );

    const portfolio = await tracker.getPortfolio();
    expect(portfolio.positions.has(USDC)).toBe(false);

    const summary = await tracker.getPositionSummary();
    expect(summary.openPositions).toBe(1);
  });

  it("uses supplied fill fee exactly and stores fee currency", async () => {
    const { tracker } = createTracker();

    await tracker.recordTrade(
      {
        id: "fee-exact",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 200n,
        filledQuantity: 200n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      10_000n,
      200n,
      { feeAmount: 123n, feeCurrency: USDC },
    );

    const [trade] = await tracker.getTradeHistory(pair);
    expect(trade.fees).toBe(123n);
    expect(trade.feeCurrency).toBe(USDC);
  });

  it("uses configured taker fee bps fallback when fill fee absent", async () => {
    const { tracker } = createTracker();

    await tracker.recordTrade(
      {
        id: "fee-fallback",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 200n,
        filledQuantity: 200n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      10_000n,
      200n,
    );

    const [trade] = await tracker.getTradeHistory(pair);
    expect(trade.fees).toBe(40n);
    expect(trade.feeCurrency).toBe(USDC);
  });

  it("live tracker starts empty, simulation tracker loads defaults, custom balances override defaults", async () => {
    const { tracker: liveTracker } = createTracker({
      options: { mode: "live" },
    });
    const { tracker: simulationTracker } = createTracker({
      options: { mode: "simulation" },
    });
    const { tracker: customTracker } = createTracker({
      options: {
        mode: "simulation",
        startingBalances: {
          [USDC]: 555_000_000n,
        },
      },
    });

    expect(await liveTracker.getBalance(USDC)).toBe(0n);
    expect(await simulationTracker.getBalance(USDC)).toBe(1_000_000_000n);
    expect(await customTracker.getBalance(USDC)).toBe(555_000_000n);
    expect(await customTracker.getBalance(ETH)).toBe(0n);
  });

  it("cash balance contributes portfolio value but not open position count", async () => {
    const { tracker } = createTracker({
      options: {
        mode: "live",
        startingBalances: {
          [USDC]: 123_000_000n,
        },
      },
    });

    const portfolio = await tracker.getPortfolio();
    const summary = await tracker.getPositionSummary();

    expect(portfolio.totalValue).toBe(12_300n);
    expect(portfolio.positions.get(USDC)?.value).toBe(12_300n);
    expect(summary.openPositions).toBe(0);
  });

  it("daily pnl uses realized sell pnl, subtracts fees, and never turns buy-only day positive", async () => {
    const { tracker } = createTracker({ currentPrice: 10_000n });
    const now = Date.now();
    const yesterday = now - 25 * 60 * 60 * 1000;

    await tracker.recordTrade(
      {
        id: "buy-yesterday",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 200n,
        filledQuantity: 200n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: yesterday,
      } as never,
      10_000n,
      200n,
      { feeAmount: 0n, timestamp: yesterday },
    );

    await tracker.recordTrade(
      {
        id: "sell-profit",
        baseToken: ETH,
        quoteToken: USDC,
        price: 11_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: false,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: now,
      } as never,
      11_000n,
      100n,
      { feeAmount: 100n, timestamp: now },
    );

    const summary = await tracker.getPositionSummary();
    expect(summary.dailyPnL).toBe(900n);

    const { tracker: buyOnlyTracker } = createTracker({
      currentPrice: 10_000n,
    });
    await buyOnlyTracker.recordTrade(
      {
        id: "buy-today",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: now,
      } as never,
      10_000n,
      100n,
      { feeAmount: 25n, timestamp: now },
    );

    const buyOnlySummary = await buyOnlyTracker.getPositionSummary();
    expect(buyOnlySummary.dailyPnL).toBeLessThanOrEqual(0n);
  });

  it("losing sell subtracts realized loss", async () => {
    const { tracker } = createTracker({ currentPrice: 9_000n });

    await tracker.recordTrade(
      {
        id: "loss-buy",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now() - 10_000,
      } as never,
      10_000n,
      100n,
      { feeAmount: 0n },
    );

    await tracker.recordTrade(
      {
        id: "loss-sell",
        baseToken: ETH,
        quoteToken: USDC,
        price: 9_000n,
        quantity: 100n,
        filledQuantity: 100n,
        isBuy: false,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now(),
      } as never,
      9_000n,
      100n,
      { feeAmount: 0n },
    );

    const summary = await tracker.getPositionSummary();
    expect(summary.totalPnL).toBe(-1_000n);
  });

  it("performance metrics use realized sell pnl for win rate and profit factor", async () => {
    const { tracker } = createTracker();

    await tracker.recordTrade(
      {
        id: "perf-buy",
        baseToken: ETH,
        quoteToken: USDC,
        price: 10_000n,
        quantity: 300n,
        filledQuantity: 300n,
        isBuy: true,
        orderType: "MARKET",
        status: "FILLED",
        timestamp: Date.now() - 20_000,
      } as never,
      10_000n,
      300n,
      { feeAmount: 0n },
    );

    for (const [localId, price] of [
      ["perf-sell-win-1", 11_000n],
      ["perf-sell-loss", 9_000n],
      ["perf-sell-win-2", 12_000n],
    ] as const) {
      await tracker.recordTrade(
        {
          id: localId,
          baseToken: ETH,
          quoteToken: USDC,
          price,
          quantity: 100n,
          filledQuantity: 100n,
          isBuy: false,
          orderType: "MARKET",
          status: "FILLED",
          timestamp: Date.now(),
        } as never,
        price,
        100n,
        { feeAmount: 0n },
      );
    }

    const metrics = await tracker.getPerformanceMetrics();
    expect(metrics.totalTrades).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 3);
    expect(metrics.profitFactor).toBe(3);
  });
});
