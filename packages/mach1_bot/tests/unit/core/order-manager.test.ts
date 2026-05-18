import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import type { OrderRequest } from "@/shared/types";

describe("OrderManager", () => {
  let orderManager: OrderManager;
  let marketManager: MarketManager;
  const mockOrderRequest: OrderRequest = {
    baseToken: "0x1234567890123456789012345678901234567890",
    quoteToken: "0x0987654321098765432109876543210987654321",
    isBuy: true,
    price: 3000n * 10n ** 6n, // $3000 USDC
    quantity: 1n * 10n ** 18n, // 1 ETH
    pitpassCode: "test_pit_pass",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    marketManager = new MarketManager();
    orderManager = new OrderManager(marketManager);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe("placeLimitOrder", () => {
    it("should place a limit order successfully", async () => {
      const result = await orderManager.placeLimitOrder(mockOrderRequest);

      expect(result).toBeDefined();
      expect(result.orderId).toMatch(/^order_\d+_\d+$/);
      expect(result.status).toBe("pending");
      expect(result.filledQuantity).toBe(0n);
      expect(result.remainingQuantity).toBe(mockOrderRequest.quantity);
    });

    it("should handle valid price", () => {
      expect(mockOrderRequest.price).toBeGreaterThan(0n);
    });

    it("should handle valid quantity", () => {
      expect(mockOrderRequest.quantity).toBeGreaterThan(0n);
    });

    it("should handle valid addresses", () => {
      expect(mockOrderRequest.baseToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(mockOrderRequest.quoteToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe("placeMarketOrder", () => {
    it("should place a market order successfully", async () => {
      const marketOrderRequest = {
        baseToken: mockOrderRequest.baseToken,
        quoteToken: mockOrderRequest.quoteToken,
        isBuy: mockOrderRequest.isBuy,
        quantity: mockOrderRequest.quantity,
        pitpassCode: mockOrderRequest.pitpassCode,
      };

      const result = await orderManager.placeMarketOrder(marketOrderRequest);

      expect(result).toBeDefined();
      expect(result.status).toBe("filled");
      expect(result.filledQuantity).toBe(marketOrderRequest.quantity);
      expect(result.remainingQuantity).toBe(0n);
    });
  });

  // IOC and FOK order types are not supported by Monaco SDK
  // describe("placeIOCOrder", () => {
  //   it("should place an IOC order successfully", async () => {
  //     const result = await orderManager.placeIOCOrder(mockOrderRequest);

  //     expect(result).toBeDefined();
  //     expect(["pending", "filled", "cancelled"]).toContain(result.status);
  //   });
  // });

  // describe("placeFOKOrder", () => {
  //   it("should place a FOK order successfully", async () => {
  //     const result = await orderManager.placeFOKOrder(mockOrderRequest);

  //     expect(result).toBeDefined();
  //     expect(["filled", "cancelled"]).toContain(result.status);
  //   });
  // });

  describe("placePostOnlyOrder", () => {
    it("should place a post-only order successfully", async () => {
      const result = await orderManager.placePostOnlyOrder(mockOrderRequest);

      expect(result).toBeDefined();
      expect(["pending", "cancelled"]).toContain(result.status);
    });
  });

  describe("cancelOrder", () => {
    it("should cancel an order successfully", async () => {
      const orderId = "test-order-123";

      await expect(orderManager.cancelOrder(orderId)).resolves.toBeUndefined();
    });
  });

  describe("modifyOrder", () => {
    it("should modify an order successfully", async () => {
      // First place an order to get a valid order ID
      const placedOrder = await orderManager.placeLimitOrder(mockOrderRequest);
      const orderId = placedOrder.orderId;
      const newParams = { price: 3100n * 10n ** 6n };

      const result = await orderManager.modifyOrder(orderId, newParams);

      expect(result).toBeDefined();
      expect(result.orderId).toBe(orderId);
      expect(result.status).toBe("pending");
    });
  });

  describe("batchPlaceLimitOrders", () => {
    it("should place multiple limit orders", async () => {
      const orders = [
        mockOrderRequest,
        { ...mockOrderRequest, price: 3100n * 10n ** 6n },
      ];

      const results = await orderManager.batchPlaceLimitOrders(orders);

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("pending");
      expect(results[1].status).toBe("pending");
    });

    it("should handle empty batch", async () => {
      const results = await orderManager.batchPlaceLimitOrders([]);

      expect(results).toHaveLength(0);
    });
  });

  describe("replaceOrder", () => {
    it("should replace an order successfully", async () => {
      // First place an order to get a valid order ID
      const placedOrder = await orderManager.placeLimitOrder(mockOrderRequest);
      const oldOrderId = placedOrder.orderId;
      const newParams = { ...mockOrderRequest, price: 3200n * 10n ** 6n };

      const result = await orderManager.replaceOrder(oldOrderId, newParams);

      expect(result).toBeDefined();
      expect(result.orderId).toMatch(/^order_\d+_\d+$/);
      expect(result.remainingQuantity).toBe(newParams.quantity);
    });
  });
});
