import type { OrderRequest } from "@/shared/types";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";

const mockListMarginAccounts = vi.fn();
const mockGetMarginAccountSummary = vi.fn();
const mockListOpenPositions = vi.fn();
const mockPlaceMarketOrder = vi.fn();
const mockPlaceLimitOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockClosePosition = vi.fn();

vi.mock("mach1_sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mach1_sdk")>();

  class MonacoCoreSDK {
    private readonly resolver = {
      normalizeSymbol: (symbol: string) => symbol,
      getPairByContracts: () => ({
        id: "pair-1",
        symbol: "ETH/USDC",
      }),
      getPairBySymbol: () => ({
        id: "pair-1",
        symbol: "ETH/USDC",
      }),
    };

    initialize = vi.fn().mockResolvedValue(undefined);
    isInitialized = vi.fn().mockReturnValue(true);
    isPaused = vi.fn().mockReturnValue(false);
    onTradingPaused = vi.fn();
    getTradingPairResolver() {
      return this.resolver;
    }
    getSDK() {
      return {
        perps: {
          listMarginAccounts: mockListMarginAccounts,
          getMarginAccountSummary: mockGetMarginAccountSummary,
          listOpenPositions: mockListOpenPositions,
          placeMarketOrder: mockPlaceMarketOrder,
          placeLimitOrder: mockPlaceLimitOrder,
          cancelOrder: mockCancelOrder,
          closePosition: mockClosePosition,
        },
      };
    }
  }

  return {
    ...actual,
    MonacoCoreSDK,
  };
});

vi.mock("@/domains/trading/market-manager", () => ({
  MarketManager: class {
    setMode(): void {
      return;
    }
    setDefaultOHLCVInterval(): void {
      return;
    }
    setSDK(): void {
      return;
    }
    async getCurrentPrice(): Promise<bigint> {
      return 321000n;
    }
  },
}));

vi.mock("@/domains/trading/order-manager", () => ({
  OrderManager: class { },
}));

vi.mock("@/domains/trading/realtime-manager", () => ({
  RealtimeManager: class {
    setMode(): void {
      return;
    }
    setSDK(): void {
      return;
    }
    async connect(): Promise<void> {
      return;
    }
    async disconnect(): Promise<void> {
      return;
    }
  },
}));

describe("IsolatedPerpsLiveTradingEngine", () => {
  let IsolatedPerpsLiveTradingEngine: typeof import("@/domains/execution/isolated-perps-live-trading-engine").IsolatedPerpsLiveTradingEngine;

  const baseSummary = {
    equity: "1500",
    free_collateral: "1200",
    initial_margin_required: "100",
    maintenance_margin_required: "50",
    margin_account_id: "margin-1",
    realized_pnl: "10",
    unrealized_pnl: "25",
    withdrawable_collateral: "1100",
  };

  const basePositions = {
    positions: [
      {
        entry_price: "3200",
        isolated_margin: "250",
        liquidation_price: "2900",
        maintenance_margin_required: "100",
        mark_price: "3210",
        position_id: "position-1",
        realized_pnl: "0",
        side: "LONG",
        size: "1.25",
        trading_pair_id: "pair-1",
        unrealized_pnl: "12.5",
      },
    ],
  };

  const baseOrder: OrderRequest = {
    baseToken: "0x1111111111111111111111111111111111111111",
    quoteToken: "0x2222222222222222222222222222222222222222",
    isBuy: true,
    orderType: "market",
    price: 320000n,
    quantity: 125n,
    leverage: 5,
  };

  beforeAll(async () => {
    ({ IsolatedPerpsLiveTradingEngine } = await import(
      "@/domains/execution/isolated-perps-live-trading-engine"
    ));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListMarginAccounts.mockResolvedValue({
      accounts: [{ margin_account_id: "margin-1" }],
    });
    mockGetMarginAccountSummary.mockResolvedValue(baseSummary);
    mockListOpenPositions.mockResolvedValue(basePositions);
    mockPlaceMarketOrder.mockResolvedValue({
      order_id: "perp-order-1",
      status: "SUCCESS",
    });
    mockPlaceLimitOrder.mockResolvedValue({
      order_id: "perp-limit-1",
      status: "SUCCESS",
    });
    mockCancelOrder.mockResolvedValue({ status: "SUCCESS" });
    mockClosePosition.mockResolvedValue({
      close_order_id: "perp-close-1",
      status: "SUCCESS",
      submitted_quantity: "1.25",
    });
  });

  const makeEngine = () =>
    new IsolatedPerpsLiveTradingEngine({
      privateKey: "0x" + "1".repeat(64),
      network: "sei-testnet",
      marketMode: "isolated_perps",
      perps: { marginMode: "isolated", leverage: 5 },
      maxSlippage: 0.01,
      maxRetries: 2,
      retryDelay: 0,
    });

  const makeEngineWithFunding = (
    provider: Parameters<
      ConstructorParameters<typeof IsolatedPerpsLiveTradingEngine>[4]["fundingStateProvider"]
    >[0] extends never
      ? never
      : ConstructorParameters<typeof IsolatedPerpsLiveTradingEngine>[4]["fundingStateProvider"],
  ) =>
    new IsolatedPerpsLiveTradingEngine(
      {
        privateKey: "0x" + "1".repeat(64),
        network: "sei-testnet",
        marketMode: "isolated_perps",
        perps: { marginMode: "isolated", leverage: 5 },
        maxSlippage: 0.01,
        maxRetries: 2,
        retryDelay: 0,
      },
      undefined,
      undefined,
      undefined,
      {
        fundingStateProvider: provider,
      },
    );

  it("rejects initialize when isolated margin account lookup fails", async () => {
    const engine = makeEngine();
    mockListMarginAccounts.mockRejectedValueOnce(
      new Error("margin account unavailable"),
    );

    await expect(engine.initialize()).rejects.toThrow(
      "margin account unavailable",
    );
  });

  it("syncs cached isolated margin state on initialize and later refresh", async () => {
    const engine = makeEngine();

    await engine.initialize();
    const initialState = engine.getAccountState();

    expect(initialState).toMatchObject({
      marginAccountId: "margin-1",
      freeCollateral: 120000n,
      usedMargin: 10000n,
      maintenanceMargin: 5000n,
    });
    expect(initialState?.positions[0]).toMatchObject({
      positionId: "position-1",
      side: "long",
      size: 125n,
      unrealizedPnL: 1250n,
    });

    mockGetMarginAccountSummary.mockResolvedValueOnce({
      ...baseSummary,
      free_collateral: "900",
      initial_margin_required: "400",
    });
    mockListOpenPositions.mockResolvedValueOnce({ positions: [] });

    const refreshed = await engine.syncAccountState();

    expect(refreshed).toMatchObject({
      freeCollateral: 90000n,
      usedMargin: 40000n,
    });
    expect(refreshed.positions).toHaveLength(0);
  });

  it("submits long and short perps entries through Monaco perps route", async () => {
    const engine = makeEngine();
    await engine.initialize();

    const longResult = await engine.placeOrder({
      ...baseOrder,
      isBuy: true,
      direction: "long",
    });
    const shortResult = await engine.placeOrder({
      ...baseOrder,
      isBuy: false,
      direction: "short",
      quantity: 75n,
    });

    expect(longResult.status).toBe("pending");
    expect(shortResult.status).toBe("pending");
    expect(mockPlaceMarketOrder).toHaveBeenNthCalledWith(1, {
      leverage: "5",
      marginAccountId: "margin-1",
      positionSide: "LONG",
      quantity: "1.25",
      reduceOnly: undefined,
      side: "BUY",
      slippageTolerance: 0.01,
      tradingPairId: "pair-1",
    });
    expect(mockPlaceMarketOrder).toHaveBeenNthCalledWith(2, {
      leverage: "5",
      marginAccountId: "margin-1",
      positionSide: "SHORT",
      quantity: "0.75",
      reduceOnly: undefined,
      side: "SELL",
      slippageTolerance: 0.01,
      tradingPairId: "pair-1",
    });
  });

  it("uses close-position route for close-only requests", async () => {
    const engine = makeEngine();
    await engine.initialize();

    const result = await engine.placeOrder({
      ...baseOrder,
      closeOnly: true,
      reduceOnly: true,
      quantity: 50n,
    });

    expect(result.status).toBe("pending");
    expect(mockClosePosition).toHaveBeenCalledWith("position-1", {
      closeType: "IOC",
      quantity: "0.50",
      slippageToleranceBps: 100,
    });
    expect(mockPlaceMarketOrder).not.toHaveBeenCalled();
  });

  it("tracks long entry then reduce-only close lifecycle and realized pnl after sync", async () => {
    const orderLifecycleStore = new OrderLifecycleStore();
    const lifecycleEvents: string[] = [];
    orderLifecycleStore.getEventEmitter().on((event) => {
      lifecycleEvents.push(event.type);
    });
    const engine = new IsolatedPerpsLiveTradingEngine(
      {
        privateKey: "0x" + "1".repeat(64),
        network: "sei-testnet",
        marketMode: "isolated_perps",
        perps: { marginMode: "isolated", leverage: 5 },
        maxSlippage: 0.01,
        maxRetries: 2,
        retryDelay: 0,
      },
      undefined,
      undefined,
      orderLifecycleStore,
    );

    await engine.initialize();
    await engine.placeOrder({
      ...baseOrder,
      isBuy: true,
      direction: "long",
    });
    await engine.placeOrder({
      ...baseOrder,
      closeOnly: true,
      reduceOnly: true,
      direction: "long",
      quantity: 125n,
    });

    mockGetMarginAccountSummary.mockResolvedValueOnce({
      ...baseSummary,
      realized_pnl: "45",
      unrealized_pnl: "0",
    });
    mockListOpenPositions.mockResolvedValueOnce({ positions: [] });

    const refreshed = await engine.syncAccountState();

    expect(lifecycleEvents).toEqual([
      "submitted",
      "accepted",
      "accepted",
      "submitted",
      "accepted",
      "accepted",
    ]);
    expect(refreshed.positions).toHaveLength(0);
    expect(refreshed.realizedPnL).toBe(4500n);
  });

  it("tracks short entry then close lifecycle and realized pnl after sync", async () => {
    const orderLifecycleStore = new OrderLifecycleStore();
    const lifecycleEvents: string[] = [];
    orderLifecycleStore.getEventEmitter().on((event) => {
      lifecycleEvents.push(event.type);
    });
    const engine = new IsolatedPerpsLiveTradingEngine(
      {
        privateKey: "0x" + "1".repeat(64),
        network: "sei-testnet",
        marketMode: "isolated_perps",
        perps: { marginMode: "isolated", leverage: 5 },
        maxSlippage: 0.01,
        maxRetries: 2,
        retryDelay: 0,
      },
      undefined,
      undefined,
      orderLifecycleStore,
    );

    mockListOpenPositions.mockResolvedValueOnce({
      positions: [
        {
          ...basePositions.positions[0],
          side: "SHORT",
          realized_pnl: "0",
          unrealized_pnl: "-8.5",
        },
      ],
    });

    await engine.initialize();
    await engine.placeOrder({
      ...baseOrder,
      isBuy: false,
      direction: "short",
      quantity: 75n,
    });
    await engine.placeOrder({
      ...baseOrder,
      isBuy: true,
      closeOnly: true,
      reduceOnly: true,
      direction: "short",
      quantity: 75n,
    });

    mockGetMarginAccountSummary.mockResolvedValueOnce({
      ...baseSummary,
      realized_pnl: "32.5",
      unrealized_pnl: "0",
    });
    mockListOpenPositions.mockResolvedValueOnce({ positions: [] });

    const refreshed = await engine.syncAccountState();

    expect(lifecycleEvents).toEqual([
      "submitted",
      "accepted",
      "accepted",
      "submitted",
      "accepted",
      "accepted",
    ]);
    expect(refreshed.positions).toHaveLength(0);
    expect(refreshed.realizedPnL).toBe(3250n);
  });

  it("exposes tracked long and short position state from synced mark data", async () => {
    const engine = makeEngine();
    mockListOpenPositions.mockResolvedValueOnce({
      positions: [
        {
          entry_price: "3200",
          isolated_margin: "250",
          liquidation_price: "2900",
          maintenance_margin_required: "100",
          mark_price: "3210",
          position_id: "position-1",
          realized_pnl: "15",
          side: "SHORT",
          size: "1.25",
          trading_pair_id: "pair-1",
          unrealized_pnl: "22.5",
          leverage: "5",
        },
      ],
    });

    await engine.initialize();
    const position = await engine.getPosition({
      base: baseOrder.baseToken,
      quote: baseOrder.quoteToken,
      symbol: "ETH/USDC",
    });

    expect(position).toMatchObject({
      balance: 125n,
      value: 401250n,
      entryPrice: 320000n,
      markPrice: 321000n,
      realizedPnL: 1500n,
      unrealizedPnL: 2250n,
      collateral: 25000n,
      leverage: 5,
      maintenanceMargin: 10000n,
      liquidationPrice: 290000n,
      side: "short",
    });
  });

  it("preserves remaining average entry price after partial close state sync", async () => {
    const engine = makeEngine();
    await engine.initialize();

    mockGetMarginAccountSummary.mockResolvedValueOnce(baseSummary);
    mockListOpenPositions.mockResolvedValueOnce({
      positions: [
        {
          entry_price: "3200",
          isolated_margin: "180",
          liquidation_price: "2925",
          maintenance_margin_required: "80",
          mark_price: "3250",
          position_id: "position-1",
          realized_pnl: "25",
          side: "LONG",
          size: "0.75",
          trading_pair_id: "pair-1",
          unrealized_pnl: "37.5",
          leverage: "5",
        },
      ],
    });

    await engine.syncAccountState();
    const position = await engine.getPosition({
      base: baseOrder.baseToken,
      quote: baseOrder.quoteToken,
      symbol: "ETH/USDC",
    });

    expect(position).toMatchObject({
      balance: 75n,
      entryPrice: 320000n,
      markPrice: 325000n,
      realizedPnL: 2500n,
      unrealizedPnL: 3750n,
      collateral: 18000n,
      side: "long",
    });
  });

  it("tracks funding updates on open positions and reflects accrued funding in unrealized pnl", async () => {
    const fundingProvider = vi
      .fn()
      .mockResolvedValue({ rate: 25n, accruedFunding: 150n, updatedAt: Date.now() });
    const engine = makeEngineWithFunding(fundingProvider);

    await engine.initialize();
    const position = await engine.getPosition({
      base: baseOrder.baseToken,
      quote: baseOrder.quoteToken,
      symbol: "ETH/USDC",
    });

    expect(position).toMatchObject({
      fundingRate: 25n,
      accruedFunding: 150n,
      unrealizedPnL: 1100n,
    });
    expect(
      engine.getFundingState({
        base: baseOrder.baseToken,
        quote: baseOrder.quoteToken,
        symbol: "ETH/USDC",
      }),
    ).toMatchObject({
      status: "available",
      rate: 25n,
      accruedFunding: 150n,
    });
  });

  it("marks funding as unsupported when Monaco funding surface is unavailable", async () => {
    const engine = makeEngine();

    await engine.initialize();

    expect(
      engine.getFundingState({
        base: baseOrder.baseToken,
        quote: baseOrder.quoteToken,
        symbol: "ETH/USDC",
      }),
    ).toMatchObject({
      status: "unsupported",
      warning: "Funding rate unavailable from Monaco; skipping funding adjustment.",
    });
  });
});
