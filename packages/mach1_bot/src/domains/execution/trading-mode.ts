import {
  Address,
  CancellationResult,
  ExecutionEngine,
  ExecutionOrderRecord,
  ExecutionOrderStatusResult,
  ExecutionTrade,
  OrderRequest,
  OrderResult,
  Position,
  TradingPair,
} from "@/shared/types";

export interface TradingMode extends ExecutionEngine {}

export abstract class BaseTradingMode implements TradingMode {
  abstract placeOrder(order: OrderRequest): Promise<OrderResult>;
  abstract cancelOrder(orderId: string): Promise<CancellationResult>;
  abstract getOrderStatus(orderId: string): Promise<ExecutionOrderStatusResult>;
  abstract getPosition(pair: TradingPair): Promise<Position>;
  abstract getBalance(token: Address): Promise<bigint>;
  abstract getExecutedTrades(): ExecutionTrade[];
  abstract getOrderHistory(): Map<string, ExecutionOrderRecord>;

  protected validateOrder(order: OrderRequest): boolean {
    // Basic order parameter validation
    if (!order.baseToken || !order.quoteToken) {
      console.warn("Invalid order: Missing base or quote token address");
      return false;
    }

    if (
      !order.baseToken.startsWith("0x") ||
      !order.quoteToken.startsWith("0x")
    ) {
      console.warn(
        "Invalid order: Token addresses must be valid Ethereum addresses",
      );
      return false;
    }

    if (order.baseToken === order.quoteToken) {
      console.warn("Invalid order: Base and quote tokens cannot be the same");
      return false;
    }

    if (order.quantity <= 0n) {
      console.warn(
        `Invalid order: Quantity must be positive, got ${order.quantity}`,
      );
      return false;
    }

    if (order.price <= 0n) {
      console.warn(`Invalid order: Price must be positive, got ${order.price}`);
      return false;
    }

    // Check for reasonable order size bounds
    const MAX_QUANTITY = BigInt("999999999999999999"); // Prevent overflow
    const MAX_PRICE = BigInt("999999999999999999");

    if (order.quantity > MAX_QUANTITY) {
      console.warn(
        `Invalid order: Quantity ${order.quantity} exceeds maximum allowed`,
      );
      return false;
    }

    if (order.price > MAX_PRICE) {
      console.warn(
        `Invalid order: Price ${order.price} exceeds maximum allowed`,
      );
      return false;
    }

    return true;
  }

  protected logTrade(order: OrderRequest, result: OrderResult): void {
    const side = order.isBuy ? "BUY" : "SELL";
    const baseSymbol = order.baseToken.slice(0, 6) + "...";
    const quoteSymbol = order.quoteToken.slice(0, 6) + "...";
    const priceFormatted = (Number(order.price) / 100).toFixed(2);
    const quantityFormatted = (Number(order.quantity) / 100).toFixed(4);
    const filledQuantityFormatted = (
      Number(result.filledQuantity) / 100
    ).toFixed(4);

    switch (result.status) {
      case "filled":
        console.log(
          `Trade executed: ${side} ${quantityFormatted} ${baseSymbol}/${quoteSymbol} @ ${priceFormatted} | Order ID: ${result.orderId}`,
        );
        break;
      case "pending":
        console.log(
          `Order placed: ${side} ${quantityFormatted} ${baseSymbol}/${quoteSymbol} @ ${priceFormatted} | Order ID: ${result.orderId}`,
        );
        break;
      case "cancelled":
        console.warn(
          `Order cancelled: ${side} ${quantityFormatted} ${baseSymbol}/${quoteSymbol} @ ${priceFormatted} | Order ID: ${result.orderId}`,
        );
        break;
      case "rejected":
        console.error(
          `Order rejected: ${side} ${quantityFormatted} ${baseSymbol}/${quoteSymbol} @ ${priceFormatted} | Order ID: ${result.orderId}`,
        );
        break;
      default:
        // Handle partial fills or other statuses
        if (result.filledQuantity > 0n) {
          console.log(
            `Partial fill: ${side} ${filledQuantityFormatted}/${quantityFormatted} ${baseSymbol}/${quoteSymbol} @ ${priceFormatted} | Order ID: ${result.orderId}`,
          );
        } else {
          console.log(
            `Order status update: ${result.status} for ${side} ${quantityFormatted} ${baseSymbol}/${quoteSymbol} | Order ID: ${result.orderId}`,
          );
        }
    }
  }
}
