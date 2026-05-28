import { OrderEventEmitter } from "@/domains/execution/order-event-emitter";
import type {
  OrderLifecycleEvent,
  OrderLifecycleEventType,
  OrderLifecycleRecord,
  OrderLifecycleStatus,
  OrderRequest,
  OrderResult,
  TradingPair,
} from "@/shared/types";

export interface CreateOrderRecordInput {
  localId: string;
  engineOrderId?: string;
  exchangeOrderId?: string;
  strategyId?: string;
  pair: TradingPair;
  order: OrderRequest;
  timestamp?: number;
}

export interface ApplyOrderUpdateInput {
  localId: string;
  type: OrderLifecycleEventType;
  engineOrderId?: string;
  exchangeOrderId?: string;
  status?: OrderLifecycleStatus;
  filledQuantity?: bigint;
  remainingQuantity?: bigint;
  averageFillPrice?: bigint;
  fees?: bigint;
  feeCurrency?: OrderLifecycleRecord["feeCurrency"];
  slippage?: bigint;
  reason?: string;
  timestamp?: number;
}

const mapResultStatusToEventType = (
  status: OrderResult["status"],
): OrderLifecycleEventType =>
  status === "filled"
    ? "filled"
    : status === "partially_filled"
      ? "partially_filled"
      : status === "cancelled"
        ? "cancelled"
        : status === "rejected"
          ? "rejected"
          : "accepted";

export class OrderLifecycleStore {
  private readonly orders = new Map<string, OrderLifecycleRecord>();

  constructor(private readonly emitter = new OrderEventEmitter()) {}

  getEventEmitter(): OrderEventEmitter {
    return this.emitter;
  }

  createSubmittedOrder(input: CreateOrderRecordInput): OrderLifecycleRecord {
    const timestamp = input.timestamp ?? Date.now();
    const record: OrderLifecycleRecord = {
      localId: input.localId,
      engineOrderId: input.engineOrderId,
      exchangeOrderId: input.exchangeOrderId,
      strategyId: input.strategyId ?? input.order.strategyId,
      pair: input.pair,
      side: input.order.isBuy ? "buy" : "sell",
      type: input.order.orderType ?? "market",
      requestedPrice: input.order.price,
      requestedQuantity: input.order.quantity,
      filledQuantity: 0n,
      remainingQuantity: input.order.quantity,
      averageFillPrice: undefined,
      fees: 0n,
      feeCurrency: undefined,
      slippage: 0n,
      status: "submitted",
      submittedAt: timestamp,
      updatedAt: timestamp,
    };

    this.orders.set(record.localId, record);
    this.emit("submitted", undefined, record);
    return record;
  }

  applyResult(
    localId: string,
    result: OrderResult,
    extras?: Omit<
      ApplyOrderUpdateInput,
      "localId" | "type" | "status" | "filledQuantity" | "remainingQuantity"
    >,
  ): OrderLifecycleRecord {
    return this.applyUpdate({
      localId,
      type: mapResultStatusToEventType(result.status),
      status: result.status,
      filledQuantity: result.filledQuantity,
      remainingQuantity: result.remainingQuantity,
      ...extras,
    });
  }

  applyUpdate(input: ApplyOrderUpdateInput): OrderLifecycleRecord {
    const current = this.orders.get(input.localId);
    if (!current) {
      throw new Error(`Order lifecycle record not found: ${input.localId}`);
    }

    const previousStatus = current.status;
    const timestamp = input.timestamp ?? Date.now();
    const nextFilledQuantity = input.filledQuantity ?? current.filledQuantity;
    const nextRemainingQuantity =
      input.remainingQuantity ?? current.remainingQuantity;
    const nextAverageFillPrice = this.mergeAverageFillPrice(
      current,
      nextFilledQuantity,
      input.averageFillPrice,
    );

    const next: OrderLifecycleRecord = {
      ...current,
      engineOrderId: input.engineOrderId ?? current.engineOrderId,
      exchangeOrderId: input.exchangeOrderId ?? current.exchangeOrderId,
      filledQuantity: nextFilledQuantity,
      remainingQuantity: nextRemainingQuantity,
      averageFillPrice: nextAverageFillPrice,
      fees: current.fees + (input.fees ?? 0n),
      feeCurrency: input.feeCurrency ?? current.feeCurrency,
      slippage: current.slippage + (input.slippage ?? 0n),
      status: input.status ?? input.type,
      updatedAt: timestamp,
      acceptedAt:
        input.type === "accepted" && current.acceptedAt === undefined
          ? timestamp
          : current.acceptedAt,
      filledAt: input.type === "filled" ? timestamp : current.filledAt,
      rejectedAt: input.type === "rejected" ? timestamp : current.rejectedAt,
      cancelledAt: input.type === "cancelled" ? timestamp : current.cancelledAt,
      rejectedReason:
        input.type === "rejected"
          ? (input.reason ?? current.rejectedReason)
          : current.rejectedReason,
      cancelledReason:
        input.type === "cancelled"
          ? (input.reason ?? current.cancelledReason)
          : current.cancelledReason,
    };

    this.orders.set(next.localId, next);
    this.emit(input.type, previousStatus, next);
    return next;
  }

  getOrder(localId: string): OrderLifecycleRecord | undefined {
    return this.orders.get(localId);
  }

  getAllOrders(): OrderLifecycleRecord[] {
    return [...this.orders.values()];
  }

  private mergeAverageFillPrice(
    current: OrderLifecycleRecord,
    nextFilledQuantity: bigint,
    fillPrice?: bigint,
  ): bigint | undefined {
    if (fillPrice === undefined) {
      return current.averageFillPrice;
    }
    if (nextFilledQuantity <= 0n) {
      return fillPrice;
    }

    const previousFilledQuantity = current.filledQuantity;
    if (
      previousFilledQuantity <= 0n ||
      current.averageFillPrice === undefined
    ) {
      return fillPrice;
    }

    const delta = nextFilledQuantity - previousFilledQuantity;
    if (delta <= 0n) {
      return current.averageFillPrice;
    }

    const previousNotional = current.averageFillPrice * previousFilledQuantity;
    const deltaNotional = fillPrice * delta;
    return (previousNotional + deltaNotional) / nextFilledQuantity;
  }

  private emit(
    type: OrderLifecycleEventType,
    previousStatus: OrderLifecycleStatus | undefined,
    order: OrderLifecycleRecord,
  ): void {
    const event: OrderLifecycleEvent = {
      type,
      previousStatus,
      order,
      timestamp: order.updatedAt,
    };
    this.emitter.emit(event);
  }
}
