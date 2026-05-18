import { MarketManager } from "@/domains/trading/market-manager";
import { OrderStatus, OrderType } from "@/shared/constants";
import { Address, OrderRequest, OrderResult } from "@/shared/types";
import type { InternalOrder } from "@/shared/types/internal-events";
import {
  type Rng,
  realRng,
  realScheduler,
  type Scheduler,
} from "@/shared/utils/determinism";

// Internal enum for legacy order types not supported by Monaco SDK
const InternalOrderType = {
  ...OrderType,
  POST_ONLY: "POST_ONLY" as const,
  IOC: "IOC" as const,
  FOK: "FOK" as const,
};

type SimulatedOrderType =
  | "LIMIT"
  | "MARKET"
  | "POST_ONLY"
  | "IOC"
  | "FOK"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "STOP_LIMIT"
  | "TRAILING_STOP";

type SimulatedOrderStatus =
  | "PENDING"
  | "SUBMITTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "SETTLED_ON_CHAIN"
  | "SETTLED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED";

export class OrderManager {
  private orders: Map<string, InternalOrder> = new Map();
  private orderCounter = 0;
  private marketManager: MarketManager;
  private readonly rng: Rng;
  private readonly scheduler: Scheduler;

  constructor(
    marketManager: MarketManager,
    options?: { rng?: Rng; scheduler?: Scheduler },
  ) {
    this.marketManager = marketManager;
    this.rng = options?.rng ?? realRng;
    this.scheduler = options?.scheduler ?? realScheduler;
  }

  private generateOrderId(): string {
    return `order_${++this.orderCounter}_${Date.now()}`;
  }

  private async simulateOrderExecution(
    order: InternalOrder,
    orderType: SimulatedOrderType,
  ): Promise<{ filledQuantity: bigint; status: SimulatedOrderStatus }> {
    const pair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    };

    try {
      const _currentPrice = await this.marketManager.getCurrentPrice(pair);
      const orderBook = await this.marketManager.getOrderBook(pair);

      let filledQuantity = 0n;
      let status: SimulatedOrderStatus = OrderStatus.PENDING;

      switch (orderType) {
        case OrderType.MARKET:
          filledQuantity = order.quantity;
          status = OrderStatus.FILLED;
          break;

        case OrderType.LIMIT: {
          const canFillImmediately = order.isBuy
            ? orderBook.asks.some((ask) => ask.price <= order.price)
            : orderBook.bids.some((bid) => bid.price >= order.price);

          if (canFillImmediately) {
            const fillProbability = this.rng.next();
            if (fillProbability > 0.3) {
              filledQuantity = order.quantity;
              status = OrderStatus.FILLED;
            } else if (fillProbability > 0.1) {
              filledQuantity = order.quantity / 2n;
              status = OrderStatus.PARTIALLY_FILLED;
            }
          }
          break;
        }

        // Note: IOC and FOK order types not supported by Monaco SDK
        // Commented out for now - use LIMIT or POST_ONLY instead

        case InternalOrderType.POST_ONLY: {
          const wouldCrossSpread = order.isBuy
            ? order.price >= (orderBook.asks[0]?.price || 0n)
            : order.price <= (orderBook.bids[0]?.price || 0n);

          if (wouldCrossSpread) {
            status = OrderStatus.CANCELLED;
          } else {
            const laterFillProbability = this.rng.next();
            if (laterFillProbability > 0.8) {
              filledQuantity = order.quantity;
              status = OrderStatus.FILLED;
            }
          }
          break;
        }
      }

      return { filledQuantity, status };
    } catch (_error) {
      return { filledQuantity: 0n, status: OrderStatus.REJECTED };
    }
  }

  async placeLimitOrder(params: OrderRequest): Promise<OrderResult> {
    const orderId = this.generateOrderId();
    const order: InternalOrder = {
      id: orderId,
      trader: "0x0000000000000000000000000000000000000000",
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
      price: params.price,
      quantity: params.quantity,
      filledQuantity: 0n,
      remainingQuantity: params.quantity,
      orderType: OrderType.LIMIT,
      status: OrderStatus.PENDING,
      isBuy: params.isBuy,
      timestamp: Date.now(),
    };

    this.orders.set(orderId, order);

    this.scheduler.setTimeout(
      async () => {
        const execution = await this.simulateOrderExecution(
          order,
          OrderType.LIMIT,
        );
        order.filledQuantity = execution.filledQuantity;
        order.remainingQuantity = order.quantity - execution.filledQuantity;
        order.status = execution.status;
      },
      Math.floor(this.rng.next() * 5000) + 1000,
    );

    return {
      orderId,
      status: "pending",
      filledQuantity: 0n,
      remainingQuantity: params.quantity,
    };
  }

  async placeMarketOrder(
    params: Omit<OrderRequest, "price">,
  ): Promise<OrderResult> {
    const orderId = this.generateOrderId();
    const pair = {
      base: params.baseToken,
      quote: params.quoteToken,
      symbol: `${params.baseToken}/${params.quoteToken}`,
    };

    const currentPrice = await this.marketManager.getCurrentPrice(pair);
    const order: InternalOrder = {
      id: orderId,
      trader: "0x0000000000000000000000000000000000000000",
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
      price: currentPrice,
      quantity: params.quantity,
      filledQuantity: params.quantity,
      remainingQuantity: 0n,
      orderType: OrderType.MARKET,
      status: OrderStatus.FILLED,
      isBuy: params.isBuy,
      timestamp: Date.now(),
    };

    this.orders.set(orderId, order);

    return {
      orderId,
      status: "filled",
      filledQuantity: params.quantity,
      remainingQuantity: 0n,
    };
  }

  // Note: IOC orders not supported by Monaco SDK - use LIMIT orders instead
  /*
  async placeIOCOrder(params: OrderRequest): Promise<OrderResult> {
    const orderId = this.generateOrderId();
    const order: InternalOrder = {
      id: orderId,
      trader: "0x0000000000000000000000000000000000000000",
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
      price: params.price,
      quantity: params.quantity,
      filledQuantity: 0n,
      remainingQuantity: params.quantity,
      orderType: OrderType.IOC,
      status: OrderStatus.PENDING,
      isBuy: params.isBuy,
      timestamp: Date.now(),
    };

    this.orders.set(orderId, order);

    const execution = await this.simulateOrderExecution(order, OrderType.IOC);
    order.filledQuantity = execution.filledQuantity;
    order.remainingQuantity = order.quantity - execution.filledQuantity;
    order.status = execution.status;

    return {
      orderId,
      status:
        execution.status === OrderStatus.FILLED
          ? "filled"
          : execution.status === OrderStatus.PARTIALLY_FILLED
            ? "pending"
            : "cancelled",
      filledQuantity: execution.filledQuantity,
      remainingQuantity: order.remainingQuantity,
    };
  }
  */

  // Note: FOK orders not supported by Monaco SDK - use LIMIT orders instead
  /*
  async placeFOKOrder(params: OrderRequest): Promise<OrderResult> {
    const orderId = this.generateOrderId();
    const order: InternalOrder = {
      id: orderId,
      trader: "0x0000000000000000000000000000000000000000",
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
      price: params.price,
      quantity: params.quantity,
      filledQuantity: 0n,
      remainingQuantity: params.quantity,
      orderType: OrderType.FOK,
      status: OrderStatus.PENDING,
      isBuy: params.isBuy,
      timestamp: Date.now(),
    };

    this.orders.set(orderId, order);

    const execution = await this.simulateOrderExecution(order, OrderType.FOK);
    order.filledQuantity = execution.filledQuantity;
    order.remainingQuantity = order.quantity - execution.filledQuantity;
    order.status = execution.status;

    return {
      orderId,
      status: execution.status === OrderStatus.FILLED ? "filled" : "cancelled",
      filledQuantity: execution.filledQuantity,
      remainingQuantity: order.remainingQuantity,
    };
  }
  */

  async placePostOnlyOrder(params: OrderRequest): Promise<OrderResult> {
    const orderId = this.generateOrderId();
    const order: InternalOrder = {
      id: orderId,
      trader: "0x0000000000000000000000000000000000000000",
      baseToken: params.baseToken,
      quoteToken: params.quoteToken,
      price: params.price,
      quantity: params.quantity,
      filledQuantity: 0n,
      remainingQuantity: params.quantity,
      orderType: InternalOrderType.POST_ONLY,
      status: OrderStatus.PENDING,
      isBuy: params.isBuy,
      timestamp: Date.now(),
    };

    this.orders.set(orderId, order);

    const execution = await this.simulateOrderExecution(
      order,
      InternalOrderType.POST_ONLY,
    );
    order.filledQuantity = execution.filledQuantity;
    order.remainingQuantity = order.quantity - execution.filledQuantity;
    order.status = execution.status;

    this.scheduler.setTimeout(
      async () => {
        if (order.status === OrderStatus.PENDING) {
          const laterExecution = await this.simulateOrderExecution(
            order,
            InternalOrderType.POST_ONLY,
          );
          order.filledQuantity = laterExecution.filledQuantity;
          order.remainingQuantity =
            order.quantity - laterExecution.filledQuantity;
          order.status = laterExecution.status;
        }
      },
      Math.floor(this.rng.next() * 10000) + 5000,
    );

    return {
      orderId,
      status:
        execution.status === OrderStatus.CANCELLED ? "cancelled" : "pending",
      filledQuantity: execution.filledQuantity,
      remainingQuantity: order.remainingQuantity,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (order && order.status === OrderStatus.PENDING) {
      order.status = OrderStatus.CANCELLED;
    }
  }

  async modifyOrder(
    orderId: string,
    newParams: Partial<OrderRequest>,
  ): Promise<OrderResult> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== OrderStatus.PENDING) {
      throw new Error(`Order ${orderId} not found or cannot be modified`);
    }

    if (newParams.price !== undefined) {
      order.price = newParams.price;
    }
    if (newParams.quantity !== undefined) {
      order.quantity = newParams.quantity;
      order.remainingQuantity = order.quantity - order.filledQuantity;
    }

    return {
      orderId,
      status: "pending",
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.remainingQuantity,
    };
  }

  async replaceOrder(
    oldOrderId: string,
    newParams: OrderRequest,
  ): Promise<OrderResult> {
    await this.cancelOrder(oldOrderId);
    return this.placeLimitOrder(newParams);
  }

  async batchPlaceLimitOrders(orders: OrderRequest[]): Promise<OrderResult[]> {
    const promises = orders.map((order) => this.placeLimitOrder(order));
    return Promise.all(promises);
  }

  // IOC orders not supported by Monaco SDK
  // async batchPlaceIOCOrders(orders: OrderRequest[]): Promise<OrderResult[]> {
  //   const promises = orders.map((order) => this.placeIOCOrder(order));
  //   return Promise.all(promises);
  // }

  async batchPlaceMarketOrders(
    orders: Omit<OrderRequest, "price">[],
  ): Promise<OrderResult[]> {
    const promises = orders.map((order) => this.placeMarketOrder(order));
    return Promise.all(promises);
  }

  async batchPlacePostOnlyOrders(
    orders: OrderRequest[],
  ): Promise<OrderResult[]> {
    const promises = orders.map((order) => this.placePostOnlyOrder(order));
    return Promise.all(promises);
  }

  async batchReplaceOrders(
    replacements: Array<{
      oldOrderId: string;
      newOrder: OrderRequest;
    }>,
  ): Promise<OrderResult[]> {
    const promises = replacements.map(({ oldOrderId, newOrder }) =>
      this.replaceOrder(oldOrderId, newOrder),
    );
    return Promise.all(promises);
  }

  async getOrder(orderId: string): Promise<InternalOrder | null> {
    return this.orders.get(orderId) || null;
  }

  async getOpenOrders(trader?: Address): Promise<InternalOrder[]> {
    return Array.from(this.orders.values()).filter(
      (order) =>
        order.status === OrderStatus.PENDING &&
        (trader ? order.trader === trader : true),
    );
  }

  async getOrderHistory(
    trader?: Address,
    limit = 100,
  ): Promise<InternalOrder[]> {
    return Array.from(this.orders.values())
      .filter((order) => (trader ? order.trader === trader : true))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async cancelAllOrders(trader?: Address): Promise<void> {
    const ordersToCancel = Array.from(this.orders.values()).filter(
      (order) =>
        order.status === OrderStatus.PENDING &&
        (trader ? order.trader === trader : true),
    );

    ordersToCancel.forEach((order) => {
      order.status = OrderStatus.CANCELLED;
    });
  }

  getOrderStats(): {
    totalOrders: number;
    openOrders: number;
    filledOrders: number;
    cancelledOrders: number;
  } {
    const orders = Array.from(this.orders.values());
    return {
      totalOrders: orders.length,
      openOrders: orders.filter((o) => o.status === OrderStatus.PENDING).length,
      filledOrders: orders.filter((o) => o.status === OrderStatus.FILLED)
        .length,
      cancelledOrders: orders.filter((o) => o.status === OrderStatus.CANCELLED)
        .length,
    };
  }
}
