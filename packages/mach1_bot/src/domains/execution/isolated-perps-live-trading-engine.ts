import {
  type Interval,
  type Mach1SDK,
  MonacoCoreSDK,
  type MonacoCoreSDKConfig,
  type TradingPairResolver,
} from "mach1_sdk";
import { OrderLifecycleStore } from "@/domains/execution/order-lifecycle-store";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import { BaseTradingMode } from "@/domains/execution/trading-mode";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import type { LiveTradingConfig } from "@/shared/types";
import {
  type Address,
  type CancellationResult,
  type ExecutionOrderRecord,
  type ExecutionOrderStatusResult,
  type ExecutionTrade,
  type OrderRequest,
  type OrderResult,
  type Position,
  type TradingPair,
} from "@/shared/types";
import {
  type Clock,
  createIdGenerator,
  type IdGenerator,
  type Rng,
  realClock,
  realRng,
} from "@/shared/utils/determinism";
import { retryWithBackoff } from "@/shared/utils/rate-limiter";

type MarginAccountSummaryLike = {
  equity?: string;
  free_collateral?: string;
  initial_margin_required?: string;
  maintenance_margin_required?: string;
  margin_account_id?: string;
  realized_pnl?: string;
  unrealized_pnl?: string;
  withdrawable_collateral?: string;
};

type OpenPositionLike = {
  entry_price?: string;
  isolated_margin?: string;
  liquidation_price?: string;
  maintenance_margin_required?: string;
  mark_price?: string;
  position_id?: string;
  realized_pnl?: string;
  side?: string;
  size?: string;
  trading_pair_id?: string;
  unrealized_pnl?: string;
  leverage?: string | number;
};

type FundingStateSnapshot = {
  rate: bigint;
  accruedFunding?: bigint;
  updatedAt?: number;
};

export interface IsolatedPerpsFundingState {
  status: "available" | "unsupported" | "missing" | "stale";
  rate?: bigint;
  accruedFunding?: bigint;
  updatedAt?: number;
  warning?: string;
}

type PerpsOrderResponseLike = {
  order_id?: string;
  close_order_id?: string;
};

type CachedPerpsPosition = {
  positionId: string;
  pairId: string;
  side: "long" | "short";
  size: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  collateral: bigint;
  maintenanceMargin: bigint;
  liquidationPrice: bigint;
  realizedPnL: bigint;
  unrealizedPnL: bigint;
  fees: bigint;
  leverage?: number;
  fundingRate?: bigint;
  accruedFunding?: bigint;
};

export interface IsolatedPerpsAccountState {
  marginAccountId: string;
  equity: bigint;
  freeCollateral: bigint;
  usedMargin: bigint;
  maintenanceMargin: bigint;
  withdrawableCollateral: bigint;
  realizedPnL: bigint;
  unrealizedPnL: bigint;
  positions: CachedPerpsPosition[];
  updatedAt: number;
}

type FundingStateProvider = (input: {
  marginAccountId: string;
  tradingPairId: string;
}) => Promise<FundingStateSnapshot | undefined>;

type PerpsOrderData = ExecutionOrderRecord & {
  engineOrderId?: string;
  exchangeOrderId?: string;
  order: OrderRequest;
  timestamp: number;
  filledQuantity: bigint;
  remainingQuantity: bigint;
};

const NON_RETRYABLE_ORDER_ERROR_PATTERNS = [
  "bad request",
  "validation failed",
  "invalid order",
  "insufficient collateral",
  "insufficient balance",
  "insufficient funds",
  "unauthorized",
  "forbidden",
] as const;

const RETRYABLE_ORDER_ERROR_PATTERNS = [
  "rate limit",
  "too many requests",
  "timeout",
  "temporarily unavailable",
  "connection reset",
  "network error",
  "service unavailable",
  "gateway timeout",
] as const;
const DEFAULT_FUNDING_STATE_MAX_AGE_MS = 300_000;
const UNSUPPORTED_FUNDING_WARNING =
  "Funding rate unavailable from Monaco; skipping funding adjustment.";

const isRetryableOrderPlacementError = (error: unknown): boolean => {
  if (typeof error === "object" && error !== null) {
    const retryable = (error as { retryable?: unknown }).retryable;
    if (typeof retryable === "boolean") {
      return retryable;
    }

    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      if (statusCode === 429 || statusCode >= 500) {
        return true;
      }
      if (statusCode >= 400) {
        return false;
      }
    }
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  if (
    NON_RETRYABLE_ORDER_ERROR_PATTERNS.some((pattern) =>
      message.includes(pattern),
    )
  ) {
    return false;
  }

  if (
    RETRYABLE_ORDER_ERROR_PATTERNS.some((pattern) => message.includes(pattern))
  ) {
    return true;
  }

  return true;
};

const parseScaledDecimal = (value: string | undefined): bigint => {
  if (!value) {
    return 0n;
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fractionalPart = ""] = unsigned.split(".");
  const paddedFraction = `${fractionalPart}00`.slice(0, 2);
  const scaled = BigInt(`${wholePart || "0"}${paddedFraction}`);
  return negative ? -scaled : scaled;
};

const formatScaledDecimal = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
};

const parseNumeric = (
  value: string | number | undefined,
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeEngineOrderId = (response: PerpsOrderResponseLike): string => {
  const orderId = response.close_order_id ?? response.order_id;

  if (!orderId) {
    throw new Error("Perps order response missing order id");
  }

  return orderId;
};

export class IsolatedPerpsLiveTradingEngine extends BaseTradingMode {
  private readonly config: LiveTradingConfig;
  private readonly marketManager: MarketManager;
  private realtimeManager: RealtimeManager;
  private readonly monacoSDK: MonacoCoreSDK;
  private readonly orderLifecycleStore: OrderLifecycleStore;
  private readonly rng: Rng;
  private readonly clock: Clock;
  private readonly orderIdGenerator: IdGenerator;
  private readonly orders = new Map<string, PerpsOrderData>();
  private readonly executedTrades: ExecutionTrade[] = [];
  private readonly ohlcvInterval: Interval;
  private readonly _realtimeManagerProvided: boolean;
  private strategyExecutionCoordinator?: StrategyExecutionCoordinator;
  private accountState?: IsolatedPerpsAccountState;
  private readonly fundingStateProvider?: FundingStateProvider;
  private readonly fundingStateMaxAgeMs: number;
  private readonly fundingStates = new Map<string, IsolatedPerpsFundingState>();

  constructor(
    config: LiveTradingConfig,
    marketManager?: MarketManager,
    realtimeManager?: RealtimeManager,
    orderLifecycleStore?: OrderLifecycleStore,
    options?: {
      rng?: Rng;
      clock?: Clock;
      fundingStateProvider?: FundingStateProvider;
      fundingStateMaxAgeMs?: number;
    },
  ) {
    super();
    this.config = {
      ...config,
      confirmations: config.confirmations || 1,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 5000,
      marketMode: config.marketMode ?? "isolated_perps",
    };
    this.ohlcvInterval = config.ohlcvInterval || "1d";
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
    this.orderLifecycleStore = orderLifecycleStore ?? new OrderLifecycleStore();
    this.orderIdGenerator = createIdGenerator("live_perps", {
      clock: this.clock,
      rng: this.rng,
    });
    this.fundingStateProvider = options?.fundingStateProvider;
    this.fundingStateMaxAgeMs =
      options?.fundingStateMaxAgeMs ?? DEFAULT_FUNDING_STATE_MAX_AGE_MS;

    const sdkConfig: MonacoCoreSDKConfig = {
      network: config.network === "sei-mainnet" ? "mainnet" : "testnet",
      privateKey: config.privateKey,
      mode: "live",
      environment: config.environment,
      rpcUrl: config.rpcUrl,
    };

    this.monacoSDK = new MonacoCoreSDK(sdkConfig);
    this.monacoSDK.onTradingPaused(() => {
      this.strategyExecutionCoordinator = undefined;
      this.config.onTradingPaused?.();
    });

    this.marketManager = marketManager || new MarketManager({ mode: "live" });
    this.marketManager.setMode("live");
    this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);

    this._realtimeManagerProvided = !!realtimeManager;
    this.realtimeManager =
      realtimeManager ||
      new RealtimeManager(
        this.marketManager,
        new OrderManager(this.marketManager),
        undefined,
        {
          mode: "live",
          rng: this.rng,
          clock: this.clock,
          orderEventEmitter: this.orderLifecycleStore.getEventEmitter(),
        },
      );
    this.realtimeManager.setMode("live");
  }

  async initialize(): Promise<void> {
    await this.monacoSDK.initialize();

    const sdk = this.monacoSDK.getSDK();
    this.marketManager.setSDK(sdk);
    this.marketManager.setMode("live");
    this.marketManager.setDefaultOHLCVInterval(this.ohlcvInterval);

    if (this._realtimeManagerProvided) {
      this.realtimeManager.setSDK(sdk);
      this.realtimeManager.setMode("live");
    } else {
      this.realtimeManager = new RealtimeManager(
        this.marketManager,
        new OrderManager(this.marketManager),
        sdk,
        {
          mode: "live",
          rng: this.rng,
          clock: this.clock,
          orderEventEmitter: this.orderLifecycleStore.getEventEmitter(),
        },
      );
    }

    await this.realtimeManager.connect();
    await this.syncAccountState();
  }

  async syncAccountState(): Promise<IsolatedPerpsAccountState> {
    const sdk = this.monacoSDK.getSDK();
    const marginAccountId = await this.resolveMarginAccountId(sdk);
    const [summary, positionsResponse] = await Promise.all([
      sdk.perps.getMarginAccountSummary(marginAccountId),
      sdk.perps.listOpenPositions({ margin_account_id: marginAccountId }),
    ]);
    const fundingStates = await this.resolveFundingStates(
      marginAccountId,
      positionsResponse as { positions?: OpenPositionLike[] },
    );

    const state = this.buildAccountState(
      marginAccountId,
      summary as MarginAccountSummaryLike,
      positionsResponse as { positions?: OpenPositionLike[] },
      fundingStates,
    );
    this.accountState = state;
    return state;
  }

  getAccountState(): IsolatedPerpsAccountState | undefined {
    return this.accountState;
  }

  getFundingState(pair: TradingPair): IsolatedPerpsFundingState | undefined {
    const pairMetadata = this.resolvePerpsPairMetadata(pair);
    return this.fundingStates.get(pairMetadata.tradingPairId);
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.monacoSDK.isInitialized()) {
      throw new Error(
        "IsolatedPerpsLiveTradingEngine not initialized. Call initialize() first.",
      );
    }

    if (this.monacoSDK.isPaused()) {
      throw new Error("Trading is paused. Cannot place orders.");
    }

    const localOrderId = this.orderIdGenerator.next();
    const pair = this.resolveTradingPair(order);
    this.orderLifecycleStore.createSubmittedOrder({
      localId: localOrderId,
      strategyId: order.strategyId,
      pair,
      order,
      timestamp: this.clock.now(),
    });

    if (!this.validateOrder(order)) {
      this.orders.set(localOrderId, {
        orderId: localOrderId,
        order,
        status: "rejected",
        timestamp: this.clock.now(),
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      });
      this.orderLifecycleStore.applyUpdate({
        localId: localOrderId,
        type: "rejected",
        reason: "validation_failed",
        timestamp: this.clock.now(),
      });
      return {
        orderId: localOrderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
    }

    this.orders.set(localOrderId, {
      orderId: localOrderId,
      order,
      status: "pending",
      timestamp: this.clock.now(),
      filledQuantity: 0n,
      remainingQuantity: order.quantity,
    });
    this.orderLifecycleStore.applyUpdate({
      localId: localOrderId,
      type: "accepted",
      status: "pending",
      timestamp: this.clock.now(),
    });

    try {
      const accountState = this.accountState ?? (await this.syncAccountState());
      const sdk = this.monacoSDK.getSDK();
      const pairMetadata = this.resolvePerpsPairMetadata(pair);
      const positionSide = this.resolvePositionSide(order);

      const response = (await retryWithBackoff(
        async () => {
          if (order.closeOnly) {
            const openPosition = this.findOpenPosition(
              pairMetadata.tradingPairId,
            );
            if (!openPosition) {
              throw new Error(
                `No open isolated perps position found for ${pair.symbol}`,
              );
            }

            return sdk.perps.closePosition(openPosition.positionId, {
              closeType: "IOC",
              quantity: formatScaledDecimal(order.quantity),
              slippageToleranceBps: Math.max(
                1,
                Math.round(this.config.maxSlippage * 10000),
              ),
            });
          }

          if (order.orderType === "limit") {
            return sdk.perps.placeLimitOrder({
              leverage: String(
                order.leverage ?? this.config.perps?.leverage ?? 1,
              ),
              marginAccountId: accountState.marginAccountId,
              positionSide,
              price: formatScaledDecimal(order.price),
              quantity: formatScaledDecimal(order.quantity),
              reduceOnly: order.reduceOnly,
              side: order.isBuy ? "BUY" : "SELL",
              timeInForce: "GTC",
              tradingPairId: pairMetadata.tradingPairId,
            });
          }

          return sdk.perps.placeMarketOrder({
            leverage: String(
              order.leverage ?? this.config.perps?.leverage ?? 1,
            ),
            marginAccountId: accountState.marginAccountId,
            positionSide,
            quantity: formatScaledDecimal(order.quantity),
            reduceOnly: order.reduceOnly,
            side: order.isBuy ? "BUY" : "SELL",
            slippageTolerance: this.config.maxSlippage,
            tradingPairId: pairMetadata.tradingPairId,
          });
        },
        {
          maxRetries: this.config.maxRetries,
          baseDelayMs: this.config.retryDelay,
          shouldRetry: isRetryableOrderPlacementError,
        },
      )) as PerpsOrderResponseLike;

      const engineOrderId = normalizeEngineOrderId(response);
      const orderData = this.orders.get(localOrderId);
      if (!orderData) {
        throw new Error(`Order data not found for ${localOrderId}`);
      }

      orderData.engineOrderId = engineOrderId;
      orderData.exchangeOrderId = engineOrderId;
      orderData.status = "pending";
      this.orderLifecycleStore.applyUpdate({
        localId: localOrderId,
        type: "accepted",
        status: "pending",
        engineOrderId,
        exchangeOrderId: engineOrderId,
        timestamp: this.clock.now(),
      });

      await this.syncAccountState();

      return {
        orderId: localOrderId,
        status: "pending",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
    } catch (error) {
      const orderData = this.orders.get(localOrderId);
      if (orderData) {
        orderData.status = "rejected";
      }

      this.orderLifecycleStore.applyUpdate({
        localId: localOrderId,
        type: "rejected",
        reason: error instanceof Error ? error.message : String(error),
        timestamp: this.clock.now(),
      });
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<CancellationResult> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const exchangeOrderId =
      orderData.exchangeOrderId ?? orderData.engineOrderId;
    if (!exchangeOrderId) {
      throw new Error(`Exchange order ID missing for ${orderId}`);
    }

    await this.monacoSDK.getSDK().perps.cancelOrder(exchangeOrderId);
    orderData.status = "cancelled";
    this.orderLifecycleStore.applyUpdate({
      localId: orderId,
      type: "cancelled",
      status: "cancelled",
      engineOrderId: exchangeOrderId,
      exchangeOrderId,
      reason: "cancelled_by_user",
      timestamp: this.clock.now(),
    });

    return {
      orderId,
      status: "cancelled",
      filledQuantity: orderData.filledQuantity,
      remainingQuantity: orderData.remainingQuantity,
      cancellationApplied: true,
      reason: "cancelled_by_user",
    };
  }

  async getOrderStatus(orderId: string): Promise<ExecutionOrderStatusResult> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error("Order not found");
    }

    return {
      orderId,
      status: orderData.status,
      filledQuantity: orderData.filledQuantity,
      remainingQuantity: orderData.remainingQuantity,
    };
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    const accountState = this.accountState ?? (await this.syncAccountState());
    const pairMetadata = this.resolvePerpsPairMetadata(pair);
    const position = accountState.positions.find(
      (entry) => entry.pairId === pairMetadata.tradingPairId,
    );

    if (!position) {
      return {
        token: pair.base,
        balance: 0n,
        value: 0n,
        unrealizedPnL: 0n,
      };
    }

    return {
      token: pair.base,
      balance: position.size,
      value: (position.size * position.markPrice) / 100n,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      unrealizedPnL: position.unrealizedPnL,
      realizedPnL: position.realizedPnL,
      fees: position.fees,
      collateral: position.collateral,
      leverage: position.leverage,
      maintenanceMargin: position.maintenanceMargin,
      liquidationPrice: position.liquidationPrice,
      side: position.side,
      fundingRate: position.fundingRate,
      accruedFunding: position.accruedFunding,
    };
  }

  async getBalance(_token: Address): Promise<bigint> {
    const accountState = this.accountState ?? (await this.syncAccountState());
    return accountState.freeCollateral;
  }

  getExecutedTrades(): ExecutionTrade[] {
    return [...this.executedTrades];
  }

  getOrderHistory(): Map<string, ExecutionOrderRecord> {
    return new Map(this.orders);
  }

  getRealtimeManager(): RealtimeManager {
    return this.realtimeManager;
  }

  getTradingPairResolver(): TradingPairResolver {
    return this.monacoSDK.getTradingPairResolver();
  }

  getOHLCVInterval(): Interval {
    return this.ohlcvInterval;
  }

  async getLivePrice(pair: TradingPair): Promise<bigint> {
    const position = await this.getPosition(pair);
    if (position.balance > 0n && position.value > 0n) {
      return (position.value * 100n) / position.balance;
    }

    return this.marketManager.getCurrentPrice(pair);
  }

  async stopLiveTrading(): Promise<void> {
    await this.strategyExecutionCoordinator?.stop();
    this.strategyExecutionCoordinator = undefined;
    await this.realtimeManager.disconnect();
  }

  private async resolveMarginAccountId(sdk: Mach1SDK): Promise<string> {
    const configuredMarginAccountId =
      this.config.perps?.marginAccountId?.trim();
    if (configuredMarginAccountId) {
      return configuredMarginAccountId;
    }

    const response = await sdk.perps.listMarginAccounts({ state: "ACTIVE" });
    const marginAccountId = response.accounts?.[0]?.margin_account_id;

    if (!marginAccountId) {
      throw new Error("No active isolated margin account available");
    }

    return marginAccountId;
  }

  private buildAccountState(
    marginAccountId: string,
    summary: MarginAccountSummaryLike,
    positionsResponse: { positions?: OpenPositionLike[] },
    fundingStates: Map<string, IsolatedPerpsFundingState>,
  ): IsolatedPerpsAccountState {
    return {
      marginAccountId,
      equity: parseScaledDecimal(summary.equity),
      freeCollateral: parseScaledDecimal(summary.free_collateral),
      usedMargin: parseScaledDecimal(summary.initial_margin_required),
      maintenanceMargin: parseScaledDecimal(
        summary.maintenance_margin_required,
      ),
      withdrawableCollateral: parseScaledDecimal(
        summary.withdrawable_collateral,
      ),
      realizedPnL: parseScaledDecimal(summary.realized_pnl),
      unrealizedPnL: parseScaledDecimal(summary.unrealized_pnl),
      positions: (positionsResponse.positions ?? []).flatMap((position) => {
        if (!position.position_id || !position.trading_pair_id) {
          return [];
        }

        const fundingState = fundingStates.get(position.trading_pair_id);
        const accruedFunding =
          fundingState?.status === "available"
            ? (fundingState.accruedFunding ?? 0n)
            : 0n;
        const fundingRate =
          fundingState?.status === "available" ? fundingState.rate : undefined;

        return [
          {
            positionId: position.position_id,
            pairId: position.trading_pair_id,
            side: position.side === "SHORT" ? "short" : "long",
            size: parseScaledDecimal(position.size),
            entryPrice: parseScaledDecimal(position.entry_price),
            markPrice: parseScaledDecimal(position.mark_price),
            collateral: parseScaledDecimal(position.isolated_margin),
            maintenanceMargin: parseScaledDecimal(
              position.maintenance_margin_required,
            ),
            liquidationPrice: parseScaledDecimal(position.liquidation_price),
            realizedPnL: parseScaledDecimal(position.realized_pnl),
            unrealizedPnL:
              parseScaledDecimal(position.unrealized_pnl) - accruedFunding,
            fees: 0n,
            leverage: parseNumeric(position.leverage),
            fundingRate,
            accruedFunding,
          },
        ];
      }),
      updatedAt: this.clock.now(),
    };
  }

  private async resolveFundingStates(
    marginAccountId: string,
    positionsResponse: { positions?: OpenPositionLike[] },
  ): Promise<Map<string, IsolatedPerpsFundingState>> {
    const states = new Map<string, IsolatedPerpsFundingState>();
    const positions = positionsResponse.positions ?? [];

    if (!this.fundingStateProvider) {
      for (const position of positions) {
        if (position.trading_pair_id) {
          states.set(position.trading_pair_id, {
            status: "unsupported",
            warning: UNSUPPORTED_FUNDING_WARNING,
          });
        }
      }
      this.fundingStates.clear();
      for (const [tradingPairId, state] of states) {
        this.fundingStates.set(tradingPairId, state);
      }
      return states;
    }

    await Promise.all(
      positions.map(async (position) => {
        if (!position.trading_pair_id) {
          return;
        }

        const tradingPairId = position.trading_pair_id;

        try {
          const snapshot = await this.fundingStateProvider?.({
            marginAccountId,
            tradingPairId,
          });
          if (!snapshot) {
            states.set(tradingPairId, {
              status: "missing",
              warning:
                "Funding data unavailable for isolated perps position; rejecting fail-closed when risk increases.",
            });
            return;
          }

          const updatedAt = snapshot.updatedAt ?? this.clock.now();
          if (this.clock.now() - updatedAt > this.fundingStateMaxAgeMs) {
            states.set(tradingPairId, {
              status: "stale",
              rate: snapshot.rate,
              accruedFunding: snapshot.accruedFunding,
              updatedAt,
              warning:
                "Funding data is stale for isolated perps position; rejecting fail-closed when risk increases.",
            });
            return;
          }

          states.set(tradingPairId, {
            status: "available",
            rate: snapshot.rate,
            accruedFunding: snapshot.accruedFunding ?? 0n,
            updatedAt,
          });
        } catch (error) {
          states.set(tradingPairId, {
            status: "missing",
            warning:
              error instanceof Error
                ? error.message
                : "Funding data unavailable for isolated perps position",
          });
        }
      }),
    );

    this.fundingStates.clear();
    for (const [tradingPairId, state] of states) {
      this.fundingStates.set(tradingPairId, state);
    }
    return states;
  }

  private resolveTradingPair(order: OrderRequest): TradingPair {
    const resolver = this.monacoSDK.getTradingPairResolver();
    const resolved = resolver.getPairByContracts(
      order.baseToken,
      order.quoteToken,
    );
    return {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: resolved?.symbol ?? `${order.baseToken}/${order.quoteToken}`,
    };
  }

  private resolvePerpsPairMetadata(pair: TradingPair): {
    symbol: string;
    tradingPairId: string;
  } {
    const resolver = this.monacoSDK.getTradingPairResolver();
    const normalizedSymbol = resolver.normalizeSymbol(pair.symbol);
    const metadata =
      resolver.getPairByContracts(pair.base, pair.quote) ??
      resolver.getPairBySymbol(normalizedSymbol) ??
      resolver.getPairBySymbol(pair.symbol);

    if (!metadata?.id) {
      throw new Error(
        `Perps trading pair metadata unavailable for ${pair.symbol}`,
      );
    }

    return {
      symbol: metadata.symbol ?? normalizedSymbol,
      tradingPairId: metadata.id,
    };
  }

  private resolvePositionSide(order: OrderRequest): "LONG" | "SHORT" {
    if (order.direction === "long") {
      return "LONG";
    }

    if (order.direction === "short") {
      return "SHORT";
    }

    return order.isBuy ? "LONG" : "SHORT";
  }

  private findOpenPosition(
    tradingPairId: string,
  ): CachedPerpsPosition | undefined {
    return this.accountState?.positions.find(
      (position) => position.pairId === tradingPairId,
    );
  }
}
