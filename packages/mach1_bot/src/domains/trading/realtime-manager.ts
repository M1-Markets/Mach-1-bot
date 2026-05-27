import type {
  Candlestick,
  Interval,
  Mach1SDK,
  OHLCVEvent as MonacoOHLCVEvent,
  OrderbookEvent as MonacoOrderbookEvent,
  OrderbookQuotationMode,
} from "mach1_sdk";
import { tradingPairResolver } from "mach1_sdk";
import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { OrderStatus } from "@/shared/constants";
import { WEBSOCKET_CONFIG } from "@/shared/constants/monaco";
import { ConnectionError } from "@/shared/errors";
import {
  Address,
  EventCallback,
  type MarketDataMode,
  TradingPair,
  UnsubscribeFunction,
} from "@/shared/types/common";
import type {
  OrderLifecycleEvent,
  OrderLifecycleRecord,
} from "@/shared/types/execution";
import type {
  InternalOrder,
  InternalOrderEvent,
  InternalOrderStatus,
  InternalTrade,
  OrderBookEvent,
  TradeEvent,
} from "@/shared/types/internal-events";
import {
  type Clock,
  type Rng,
  realClock,
  realRng,
} from "@/shared/utils/determinism";
import { createLogger } from "@/shared/utils/logger";
import { exponentialBackoff } from "@/shared/utils/rate-limiter";
import { isRecord } from "@/shared/utils/record-utils";

const logger = createLogger("RealtimeManager");

const isOrderBookEvent = (value: unknown): value is OrderBookEvent =>
  isRecord(value) &&
  value.type === "order_book_update" &&
  isRecord(value.orderBook);

const isTradeEvent = (value: unknown): value is TradeEvent =>
  isRecord(value) && value.type === "trade" && isRecord(value.trade);

const isInternalOrderEvent = (value: unknown): value is InternalOrderEvent =>
  isRecord(value) && value.type === "order_update" && isRecord(value.order);

const isPriceEvent = (
  value: unknown,
): value is { pair: TradingPair; price: bigint; timestamp: number } =>
  isRecord(value) &&
  isRecord(value.pair) &&
  typeof value.pair.symbol === "string" &&
  typeof value.price === "bigint" &&
  typeof value.timestamp === "number";

export interface OrderBookStream {
  subscribe(callback: EventCallback<OrderBookEvent>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface TradeStream {
  subscribe(callback: EventCallback<TradeEvent>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface PriceStream {
  subscribe(
    callback: (data: {
      pair: TradingPair;
      price: bigint;
      timestamp: number;
    }) => void,
  ): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface UserOrderStream {
  subscribe(callback: EventCallback<InternalOrderEvent>): UnsubscribeFunction;
  unsubscribe(): void;
}

export interface UserTradeStream {
  subscribe(callback: EventCallback<TradeEvent>): UnsubscribeFunction;
  unsubscribe(): void;
}

export class RealtimeManager {
  private marketManager: MarketManager;
  private orderManager: OrderManager;
  private sdk?: Mach1SDK;
  private isConnected = false;
  private subscriptions = new Map<string, NodeJS.Timeout>();
  private eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  private orderbookCache = new Map<string, MonacoOrderbookEvent>();
  private ohlcvCache = new Map<string, Candlestick>();
  private activeOrderbookUnsubs = new Map<string, UnsubscribeFunction>();
  private activeOHLCVUnsubs = new Map<string, UnsubscribeFunction>();
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private mode: MarketDataMode;
  private simulationStarted = false;
  private readonly rng: Rng;
  private readonly clock: Clock;
  private detachOrderEventEmitter?: () => void;
  private lastConnectionError?: Error;

  constructor(
    marketManager: MarketManager,
    orderManager: OrderManager,
    sdk?: Mach1SDK,
    options?: {
      mode?: MarketDataMode;
      rng?: Rng;
      clock?: Clock;
      orderEventEmitter?: OrderEventEmitter;
    },
  ) {
    this.marketManager = marketManager;
    this.orderManager = orderManager;
    this.sdk = sdk;
    this.mode = options?.mode ?? (sdk ? "live" : "simulation");
    this.rng = options?.rng ?? realRng;
    this.clock = options?.clock ?? realClock;
    if (options?.orderEventEmitter) {
      this.attachOrderEventEmitter(options.orderEventEmitter);
    }

    logger.debug("RealtimeManager created", {
      hasSDK: !!sdk,
      mode: this.mode,
    });
  }

  /**
   * Attach a live Monaco SDK after construction.
   * Calling this switches the manager from simulation → live mode without
   * discarding subscriptions already established by the caller.
   */
  setSDK(sdk: Mach1SDK): void {
    this.sdk = sdk;
    logger.debug("SDK attached to RealtimeManager");
  }

  setMode(mode: MarketDataMode): void {
    this.mode = mode;
  }

  attachOrderEventEmitter(orderEventEmitter: OrderEventEmitter): () => void {
    this.detachOrderEventEmitter?.();
    this.detachOrderEventEmitter = orderEventEmitter.on((event) => {
      this.emitUserOrderUpdate(event);
    });
    return () => {
      this.detachOrderEventEmitter?.();
      this.detachOrderEventEmitter = undefined;
    };
  }

  getMode(): MarketDataMode {
    return this.mode;
  }

  private isSimulationMode(): boolean {
    return this.mode !== "live";
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      logger.debug("Already connected");
      return;
    }

    if (this.isSimulationMode()) {
      logger.info("Connecting in simulation mode");
      this.isConnected = true;
      this.lastConnectionError = undefined;
      this.startMarketDataSimulation();
      return;
    }

    const wsClient = this.sdk?.ws;

    if (!wsClient) {
      throw new ConnectionError("Monaco SDK WebSocket client");
    }

    try {
      logger.debug("Connecting to Monaco WebSocket channels");
      await this.tryConnectWebsocket(wsClient, "ws");
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.lastConnectionError = undefined;
      logger.debug("WebSocket connection established");
    } catch (error) {
      this.lastConnectionError = error as Error;
      throw new ConnectionError(
        "Monaco SDK WebSocket client",
        error as Error,
      );
    }
  }

  private async tryConnectWebsocket(
    client: { connect: () => Promise<void>; isConnected?: () => boolean },
    channel: string,
  ): Promise<void> {
    const timeoutMs = process.env.NODE_ENV === "test" ? 2000 : 5000;

    if (client.isConnected?.()) {
      return;
    }

    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`WebSocket ${channel} connect timeout`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  private startMarketDataSimulation(): void {
    if (this.simulationStarted) return;
    this.simulationStarted = true;

    // Use faster intervals in test environment
    const intervalMs = process.env.NODE_ENV === "test" ? 100 : 1000;

    const priceUpdateInterval = setInterval(() => {
      this.marketManager.simulatePriceMovement();
      this.emitPriceUpdates();
    }, intervalMs);

    this.subscriptions.set("price_simulation", priceUpdateInterval);
  }

  private async emitPriceUpdates(): Promise<void> {
    const pairs = await this.marketManager.getAllTradingPairs();

    for (const monacoTradingPair of pairs) {
      const pair: TradingPair = {
        base: monacoTradingPair.base_token_contract as Address,
        quote: monacoTradingPair.quote_token_contract as Address,
        symbol: monacoTradingPair.symbol,
      };

      try {
        const price = await this.marketManager.getCurrentPrice(pair);
        const pairKey = this.getPairKey(pair);
        const listeners = this.eventListeners.get(`price:${pairKey}`) || [];

        listeners.forEach((callback) => {
          if (typeof callback === "function") {
            callback({ pair, price, timestamp: this.clock.now() });
          }
        });

        const orderBookListeners =
          this.eventListeners.get(`orderbook:${pairKey}`) || [];
        if (orderBookListeners.length > 0) {
          const orderBook = await this.marketManager.getOrderBook(pair);
          const event: OrderBookEvent = {
            type: "order_book_update",
            baseToken: pair.base,
            quoteToken: pair.quote,
            orderBook: {
              baseToken: pair.base,
              quoteToken: pair.quote,
              bids: orderBook.bids,
              asks: orderBook.asks,
              lastUpdate: this.clock.now(),
            },
          };

          orderBookListeners.forEach((callback) => {
            if (typeof callback === "function") {
              callback(event);
            }
          });
        }

        if (this.rng.next() > 0.7) {
          this.emitMockTrade(pair);
        }
      } catch (error) {
        console.warn(`Failed to emit price update for ${pair.symbol}:`, error);
      }
    }
  }

  private async emitMockTrade(pair: TradingPair): Promise<void> {
    const pairKey = this.getPairKey(pair);
    const tradeListeners = this.eventListeners.get(`trades:${pairKey}`) || [];

    if (tradeListeners.length === 0) return;

    try {
      const price = await this.marketManager.getCurrentPrice(pair);
      const timestamp = this.clock.now();
      const quantity = BigInt(Math.floor(this.rng.next() * 100000) + 10000);
      const isBuy = this.rng.next() > 0.5;
      const entropy = Math.floor(this.rng.next() * 0xffffffff)
        .toString(36)
        .padStart(7, "0");
      const transactionHash = Array.from({ length: 64 }, () =>
        Math.floor(this.rng.next() * 16).toString(16),
      ).join("");

      const trade: InternalTrade = {
        id: `trade_${timestamp}_${entropy}`,
        baseToken: pair.base,
        quoteToken: pair.quote,
        price,
        quantity,
        isBuy,
        maker: "0x1234567890123456789012345678901234567890" as Address,
        taker: "0x0987654321098765432109876543210987654321" as Address,
        timestamp,
        blockNumber: Math.floor(this.rng.next() * 1000000),
        transactionHash: `0x${transactionHash}` as `0x${string}`,
      };

      const event: TradeEvent = {
        type: "trade",
        baseToken: pair.base,
        quoteToken: pair.quote,
        trade,
      };

      tradeListeners.forEach((callback) => {
        if (typeof callback === "function") {
          callback(event);
        }
      });
    } catch (error) {
      console.warn(`Failed to emit mock trade for ${pair.symbol}:`, error);
    }
  }

  private getPairKey(pair: TradingPair): string {
    return `${pair.base}-${pair.quote}`;
  }

  private addEventListener(
    eventKey: string,
    callback: (payload: unknown) => void,
  ): UnsubscribeFunction {
    if (!this.eventListeners.has(eventKey)) {
      this.eventListeners.set(eventKey, []);
    }

    const listeners = this.eventListeners.get(eventKey);
    if (listeners) {
      listeners.push(callback);
    }

    return () => {
      const listeners = this.eventListeners.get(eventKey);
      if (listeners) {
        const index = listeners.indexOf(callback);
        if (index > -1) {
          listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
          this.eventListeners.delete(eventKey);
        }
      }
    };
  }

  async subscribeOrderBook(pair: TradingPair): Promise<OrderBookStream> {
    if (!this.isConnected) {
      await this.connect();
    }

    const pairKey = this.getPairKey(pair);
    const eventKey = `orderbook:${pairKey}`;

    return {
      subscribe: (
        callback: EventCallback<OrderBookEvent>,
      ): UnsubscribeFunction => {
        return this.addEventListener(eventKey, (payload) => {
          if (isOrderBookEvent(payload)) {
            callback(payload);
          }
        });
      },
      unsubscribe: () => {
        this.eventListeners.delete(eventKey);
      },
    };
  }

  async subscribeTrades(pair: TradingPair): Promise<TradeStream> {
    if (!this.isConnected) {
      await this.connect();
    }

    const pairKey = this.getPairKey(pair);
    const eventKey = `trades:${pairKey}`;

    return {
      subscribe: (callback: EventCallback<TradeEvent>): UnsubscribeFunction => {
        return this.addEventListener(eventKey, (payload) => {
          if (isTradeEvent(payload)) {
            callback(payload);
          }
        });
      },
      unsubscribe: () => {
        this.eventListeners.delete(eventKey);
      },
    };
  }

  async subscribePrices(pairs: TradingPair[]): Promise<PriceStream> {
    if (!this.isConnected) {
      await this.connect();
    }

    const unsubscribers: UnsubscribeFunction[] = [];

    return {
      subscribe: (
        callback: (data: {
          pair: TradingPair;
          price: bigint;
          timestamp: number;
        }) => void,
      ): UnsubscribeFunction => {
        pairs.forEach((pair) => {
          const pairKey = this.getPairKey(pair);
          const eventKey = `price:${pairKey}`;
          const unsubscriber = this.addEventListener(eventKey, (payload) => {
            if (isPriceEvent(payload)) {
              callback(payload);
            }
          });
          unsubscribers.push(unsubscriber);
        });

        return () => {
          unsubscribers.forEach((unsub) => unsub());
        };
      },
      unsubscribe: () => {
        pairs.forEach((pair) => {
          const pairKey = this.getPairKey(pair);
          const eventKey = `price:${pairKey}`;
          this.eventListeners.delete(eventKey);
        });
      },
    };
  }

  async subscribeUserOrders(trader?: Address): Promise<UserOrderStream> {
    if (!this.isConnected) {
      await this.connect();
    }

    const eventKey = `user_orders:${trader || "all"}`;

    return {
      subscribe: (
        callback: EventCallback<InternalOrderEvent>,
      ): UnsubscribeFunction => {
        return this.addEventListener(eventKey, (payload) => {
          if (isInternalOrderEvent(payload)) {
            callback(payload);
          }
        });
      },
      unsubscribe: () => {
        this.eventListeners.delete(eventKey);
      },
    };
  }

  async subscribeUserTrades(trader?: Address): Promise<UserTradeStream> {
    if (!this.isConnected) {
      await this.connect();
    }

    const eventKey = `user_trades:${trader || "all"}`;

    return {
      subscribe: (callback: EventCallback<TradeEvent>): UnsubscribeFunction => {
        return this.addEventListener(eventKey, (payload) => {
          if (isTradeEvent(payload)) {
            callback(payload);
          }
        });
      },
      unsubscribe: () => {
        this.eventListeners.delete(eventKey);
      },
    };
  }

  async ping(): Promise<number> {
    if (!this.isConnected) {
      throw new Error("Not connected to realtime streams");
    }

    const start = this.clock.now();
    // Skip delays in test environment
    const delay =
      process.env.NODE_ENV === "test" ? 0 : this.rng.next() * 10 + 5;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return this.clock.now() - start;
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    logger.info("Disconnecting from realtime streams");

    // Clear reconnect timer if exists
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    // Clear all subscriptions
    this.subscriptions.forEach((interval, key) => {
      clearInterval(interval);
    });

    // Unsubscribe websocket feeds
    this.activeOrderbookUnsubs.forEach((unsub) => unsub());
    this.activeOHLCVUnsubs.forEach((unsub) => unsub());
    this.activeOrderbookUnsubs.clear();
    this.activeOHLCVUnsubs.clear();

    this.subscriptions.clear();
    this.eventListeners.clear();
    this.orderbookCache.clear();
    this.ohlcvCache.clear();
    this.isConnected = false;
    this.simulationStarted = false;
    this.lastConnectionError = undefined;

    logger.info("Disconnected from realtime streams");
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    const delay = exponentialBackoff(
      this.reconnectAttempts,
      WEBSOCKET_CONFIG.reconnectDelay,
      WEBSOCKET_CONFIG.maxReconnectDelay,
    );

    this.reconnectAttempts++;

    logger.debug("Scheduling WebSocket reconnection", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;

      try {
        logger.info("Attempting to reconnect WebSocket", {
          attempt: this.reconnectAttempts,
        });

        await this.connect();

        logger.info("WebSocket reconnected successfully");
      } catch (_error) {
        logger.warn("Reconnection attempt failed", {
          attempt: this.reconnectAttempts,
        });

        // Schedule another reconnect (continuous attempts)
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Subscribe to OHLCV (candlestick) data for a trading pair
   */
  async subscribeOHLCV(
    symbol: string,
    interval: Interval,
    callback: (candlestick: Candlestick) => void,
  ): Promise<UnsubscribeFunction> {
    if (!this.isConnected) {
      await this.connect();
    }

    if (this.isSimulationMode() || !this.sdk) {
      // Simulation mode - return no-op
      logger.debug("OHLCV subscription in simulation mode (no-op)", {
        symbol,
        interval,
      });
      return () => {
        // noop
      };
    }

    try {
      const normalizedSymbol = tradingPairResolver.normalizeSymbol(symbol);
      const subscriptionKey = `${normalizedSymbol}:${interval}`;
      let tradingPairId = normalizedSymbol;

      try {
        tradingPairId = tradingPairResolver.resolveSymbolToId(normalizedSymbol);
      } catch (error) {
        logger.warn("Unable to resolve trading pair ID for OHLCV", {
          symbol,
          normalizedSymbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.debug("Subscribing to OHLCV", {
        symbol,
        normalizedSymbol,
        tradingPairId,
        interval,
      });

      await this.sdk.ws.connect();

      const unsubscribeFn = this.sdk.ws.ohlcv(
        tradingPairId,
        "SPOT",
        interval,
        (event: MonacoOHLCVEvent) => {
          logger.debug("Received OHLCV event", {
            symbol,
            interval: event.interval,
          });

          const candlestick = event.candlestick;
          if (candlestick) {
            this.ohlcvCache.set(subscriptionKey, candlestick);
            this.marketManager.cacheCandlestick(symbol, interval, candlestick);
          }
          callback(candlestick);
        },
      );

      this.activeOHLCVUnsubs.set(subscriptionKey, unsubscribeFn);

      // Return unsubscribe function
      return () => {
        this.activeOHLCVUnsubs.delete(subscriptionKey);
        unsubscribeFn();
      };
    } catch (error) {
      logger.error(
        "Failed to subscribe to OHLCV",
        { symbol, interval },
        error as Error,
      );
      throw error;
    }
  }

  /**
   * Subscribe to orderbook updates for a trading pair
   */
  async subscribeOrderbookUpdates(
    symbol: string,
    callback: (orderbook: MonacoOrderbookEvent) => void,
  ): Promise<UnsubscribeFunction> {
    if (!this.isConnected) {
      await this.connect();
    }

    if (this.isSimulationMode() || !this.sdk) {
      // Use existing simulation-based orderbook subscription
      logger.debug("Orderbook subscription in simulation mode");
      const pair: TradingPair = {
        base: `0x${symbol.split("/")[0]}` as Address,
        quote: `0x${symbol.split("/")[1]}` as Address,
        symbol,
      };
      const stream = await this.subscribeOrderBook(pair);
      return stream.subscribe((event: OrderBookEvent) => {
        // Transform to Monaco format if needed
        // For now, just skip since simulation doesn't match Monaco format exactly
      });
    }

    try {
      const normalizedSymbol = tradingPairResolver.normalizeSymbol(symbol);
      let tradingPairId = normalizedSymbol;

      try {
        tradingPairId = tradingPairResolver.resolveSymbolToId(normalizedSymbol);
      } catch (error) {
        logger.warn("Unable to resolve trading pair ID for orderbook", {
          symbol,
          normalizedSymbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      logger.debug("Subscribing to orderbook", {
        symbol,
        normalizedSymbol,
        tradingPairId,
      });

      await this.sdk.ws.connect();

      const quotationMode: OrderbookQuotationMode = "BASE";
      const magnitude = 1;

      const unsubscribeFn = this.sdk.ws.orderbook(
        tradingPairId,
        "SPOT",
        magnitude,
        quotationMode,
        (event: MonacoOrderbookEvent) => {
          logger.debug("Received orderbook event", {
            symbol,
            tradingPairId,
            bidsCount: event.bids.length,
            asksCount: event.asks.length,
          });

          this.orderbookCache.set(symbol, event);
          this.marketManager.cacheOrderbook(symbol, event);
          callback(event);
        },
      );

      this.activeOrderbookUnsubs.set(symbol, unsubscribeFn);

      // Return unsubscribe function
      return () => {
        this.activeOrderbookUnsubs.delete(symbol);
        unsubscribeFn();
      };
    } catch (error) {
      logger.error(
        "Failed to subscribe to orderbook",
        { symbol },
        error as Error,
      );
      throw error;
    }
  }

  getConnectionStatus(): {
    connected: boolean;
    activeSubscriptions: number;
    totalEventListeners: number;
    mode: MarketDataMode;
    usingLiveWebSocket: boolean;
    lastConnectionError?: string;
    activeSubscriptionKeys: string[];
  } {
    const totalListeners = Array.from(this.eventListeners.values()).reduce(
      (sum, listeners) => sum + listeners.length,
      0,
    );
    const activeSubscriptionKeys = [
      ...new Set([
        ...this.subscriptions.keys(),
        ...this.eventListeners.keys(),
        ...Array.from(this.activeOrderbookUnsubs.keys(), (key) => `orderbook_ws:${key}`),
        ...Array.from(this.activeOHLCVUnsubs.keys(), (key) => `ohlcv_ws:${key}`),
      ]),
    ].sort();

    return {
      connected: this.isConnected,
      activeSubscriptions: activeSubscriptionKeys.length,
      totalEventListeners: totalListeners,
      mode: this.mode,
      usingLiveWebSocket: this.isConnected && !this.isSimulationMode(),
      lastConnectionError: this.lastConnectionError?.message,
      activeSubscriptionKeys,
    };
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  getHealthStatus(): {
    status: "healthy" | "degraded" | "disconnected";
    lastPing?: number;
    connectionTime?: number;
  } {
    if (!this.isConnected) {
      return { status: "disconnected" };
    }

    return {
      status: "healthy",
      lastPing: 5,
      connectionTime: this.clock.now(),
    };
  }

  /**
   * Retrieve the most recent orderbook event for a symbol (if any).
   */
  getCachedOrderbook(symbol: string): MonacoOrderbookEvent | undefined {
    return this.orderbookCache.get(symbol);
  }

  /**
   * Wait for a fresh orderbook snapshot via WebSocket and return it.
   * Uses a short timeout to avoid hanging when data is unavailable.
   */
  async getOrderbookSnapshot(
    symbol: string,
    timeoutMs = 2000,
  ): Promise<MonacoOrderbookEvent | undefined> {
    const cached = this.getCachedOrderbook(symbol);
    if (cached) return cached;

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: UnsubscribeFunction | undefined;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (unsubscribe) unsubscribe();
          resolve(this.getCachedOrderbook(symbol));
        }
      }, timeoutMs);

      if (this.activeOrderbookUnsubs.has(symbol)) {
        const poll = setInterval(() => {
          const latest = this.getCachedOrderbook(symbol);
          if (latest && !settled) {
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            resolve(latest);
          }
        }, 100);

        setTimeout(() => clearInterval(poll), timeoutMs);
      } else {
        const subscribe = async () => {
          unsubscribe = await this.subscribeOrderbookUpdates(
            symbol,
            (event) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(event);
            },
          );
        };
        void subscribe();
      }
    });
  }

  /**
   * Retrieve the most recent OHLCV candlestick for a symbol/interval (if any).
   */
  getCachedOHLCV(symbol: string, interval: Interval): Candlestick | undefined {
    return this.ohlcvCache.get(`${symbol}:${interval}`);
  }

  /**
   * Wait for a fresh OHLCV candlestick via WebSocket and return it.
   */
  async getOHLCVSnapshot(
    symbol: string,
    interval: Interval,
    timeoutMs = 2000,
  ): Promise<Candlestick | undefined> {
    const cached = this.getCachedOHLCV(symbol, interval);
    if (cached) return cached;

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: UnsubscribeFunction | undefined;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (unsubscribe) unsubscribe();
          resolve(this.getCachedOHLCV(symbol, interval));
        }
      }, timeoutMs);

      if (this.activeOHLCVUnsubs.has(`${symbol}:${interval}`)) {
        const poll = setInterval(() => {
          const latest = this.getCachedOHLCV(symbol, interval);
          if (latest && !settled) {
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            resolve(latest);
          }
        }, 100);

        setTimeout(() => clearInterval(poll), timeoutMs);
      } else {
        const subscribe = async () => {
          unsubscribe = await this.subscribeOHLCV(
            symbol,
            interval,
            (candle) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(candle);
            },
          );
        };
        void subscribe();
      }
    });
  }

  private emitUserOrderUpdate(event: OrderLifecycleEvent): void {
    const payload: InternalOrderEvent = {
      type: "order_update",
      order: this.toInternalOrder(event.order),
      previousStatus: this.toInternalOrderStatus(event.previousStatus),
      newStatus: this.toInternalOrderStatus(event.order.status),
    };

    for (const [eventKey, listeners] of this.eventListeners.entries()) {
      if (!eventKey.startsWith("user_orders:")) {
        continue;
      }

      listeners.forEach((callback) => {
        if (typeof callback === "function") {
          callback(payload);
        }
      });
    }
  }

  private toInternalOrder(order: OrderLifecycleRecord): InternalOrder {
    return {
      id: order.exchangeOrderId ?? order.engineOrderId ?? order.localId,
      trader: "0x0000000000000000000000000000000000000000" as Address,
      baseToken: order.pair.base,
      quoteToken: order.pair.quote,
      price: order.averageFillPrice ?? order.requestedPrice,
      quantity: order.requestedQuantity,
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
      orderType: order.type === "limit" ? "LIMIT" : "MARKET",
      status: this.toInternalOrderStatus(order.status) ?? OrderStatus.PENDING,
      isBuy: order.side === "buy",
      timestamp: order.updatedAt,
    };
  }

  private toInternalOrderStatus(
    status?: OrderLifecycleRecord["status"],
  ): InternalOrderStatus | undefined {
    if (status === undefined) {
      return undefined;
    }

    switch (status) {
      case "submitted":
      case "accepted":
      case "pending":
        return OrderStatus.PENDING;
      case "partially_filled":
        return OrderStatus.PARTIALLY_FILLED;
      case "filled":
        return OrderStatus.FILLED;
      case "cancelled":
        return OrderStatus.CANCELLED;
      case "rejected":
        return OrderStatus.REJECTED;
    }
  }
}
