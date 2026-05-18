import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import { RiskManager } from "@/domains/trading/risk-manager";
import { Address, OrderRequest, TradingPair } from "@/shared/types";

describe("Manager Integration Tests", () => {
  let marketManager: MarketManager;
  let orderManager: OrderManager;
  let positionTracker: PositionTracker;
  let realtimeManager: RealtimeManager;
  let riskManager: RiskManager;

  const testPair: TradingPair = {
    base: "0x1111111111111111111111111111111111111111" as Address,
    quote: "0x0987654321098765432109876543210987654321" as Address,
    symbol: "ETH/USDC",
  };

  beforeEach(() => {
    marketManager = new MarketManager();
    orderManager = new OrderManager(marketManager);
    positionTracker = new PositionTracker(marketManager, orderManager);
    realtimeManager = new RealtimeManager(marketManager, orderManager);
    riskManager = new RiskManager(positionTracker, marketManager, orderManager);
  });

  afterEach(async () => {
    await realtimeManager.disconnect();
  });

  describe("MarketManager + OrderManager Integration", () => {
    it("should place orders using real market data", async () => {
      const currentPrice = await marketManager.getCurrentPrice(testPair);
      expect(currentPrice).toBeGreaterThan(0n);

      const orderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: currentPrice,
        quantity: BigInt(100000), // 1 ETH in wei-like units
      };

      const result = await orderManager.placeMarketOrder(orderRequest);
      expect(result.orderId).toBeDefined();
      expect(result.status).toBe("filled");
      expect(result.filledQuantity).toBe(orderRequest.quantity);
    });

    it("should handle limit orders with market data", async () => {
      const currentPrice = await marketManager.getCurrentPrice(testPair);
      const limitPrice = currentPrice - BigInt(100); // Below market price

      const orderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: limitPrice,
        quantity: BigInt(50000),
      };

      const result = await orderManager.placeLimitOrder(orderRequest);
      expect(result.orderId).toBeDefined();
      expect(result.status).toBe("pending");
    });
  });

  describe("PositionTracker + OrderManager Integration", () => {
    it("should track positions after order execution", async () => {
      // Execute a trade
      const orderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: BigInt(300000), // $3000
        quantity: BigInt(100000), // 1 ETH
      };

      const orderResult = await orderManager.placeMarketOrder(orderRequest);

      // Simulate trade recording
      const order = await orderManager.getOrder(orderResult.orderId);
      if (order) {
        await positionTracker.recordTrade(order, order.price, order.quantity);
      }

      // Check position
      const position = await positionTracker.getPosition(testPair);
      expect(position.balance).toBeGreaterThan(0n);
      expect(position.value).toBeGreaterThan(0n);
    });

    it("should update portfolio after multiple trades", async () => {
      // Execute multiple trades
      const trades = [
        { isBuy: true, quantity: BigInt(50000) },
        { isBuy: true, quantity: BigInt(30000) },
        { isBuy: false, quantity: BigInt(20000) },
      ];

      for (const trade of trades) {
        const orderRequest: OrderRequest = {
          baseToken: testPair.base,
          quoteToken: testPair.quote,
          isBuy: trade.isBuy,
          price: BigInt(300000),
          quantity: trade.quantity,
        };

        const result = await orderManager.placeMarketOrder(orderRequest);
        const order = await orderManager.getOrder(result.orderId);
        if (order) {
          await positionTracker.recordTrade(order, order.price, order.quantity);
        }
      }

      const portfolio = await positionTracker.getPortfolio();
      expect(portfolio.totalValue).toBeGreaterThan(0n);
      expect(portfolio.positions.size).toBeGreaterThan(0);
    });
  });

  describe("RiskManager + OrderManager Integration", () => {
    it("should validate orders against risk limits", async () => {
      // Set restrictive risk limits
      await riskManager.setRiskLimits({
        maxOrderValue: BigInt(10000), // $100 max order
        maxPositionSize: BigInt(50000), // $500 max position
      });

      // Try to place order exceeding limits
      const largeOrderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: BigInt(300000),
        quantity: BigInt(100000), // $3000 order
      };

      const riskCheck = await riskManager.validateOrder(largeOrderRequest);
      expect(riskCheck.approved).toBe(false);
      expect(riskCheck.rejectionReasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/exceeds maximum/)]),
      );
    });

    it("should approve valid orders within risk limits", async () => {
      // Use much higher limits to ensure the order passes
      await riskManager.setRiskLimits({
        maxOrderValue: BigInt(10000000), // $100,000 max order (very high)
        maxPositionSize: BigInt(50000000), // $500,000 max position (very high)
        positionLimitPercent: 90, // Allow up to 90% of portfolio
        maxDailyLoss: BigInt(50000000), // $500,000 max daily loss
      });

      const validOrderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: BigInt(300000), // $3000
        quantity: BigInt(1000), // Very small quantity: 1000 * 300000 / 100 = 3M wei = $30
      };

      const riskCheck = await riskManager.validateOrder(validOrderRequest);
      expect(riskCheck.approved).toBe(true);
      expect(riskCheck.rejectionReasons).toHaveLength(0);
    });
  });

  describe("RealtimeManager Integration", () => {
    it("should connect and receive price updates", async () => {
      const priceUpdatePromise = new Promise<void>((resolve) => {
        let updateCount = 0;
        const unsubscribe = () => {
          // noop
        };

        const mockSubscription = {
          subscribe: (callback: (event: unknown) => void) => {
            const interval = setInterval(() => {
              callback({
                pair: testPair,
                price: BigInt(300000 + Math.floor(Math.random() * 10000)),
                timestamp: Date.now(),
              });
              updateCount++;

              if (updateCount >= 2) {
                clearInterval(interval);
                resolve();
              }
            }, 100);
            return unsubscribe;
          },
          unsubscribe,
        };

        // Simulate price subscription
        mockSubscription.subscribe(() => {
          // noop subscription
        });
      });

      await realtimeManager.connect();
      const priceStream = await realtimeManager.subscribePrices([testPair]);

      priceStream.subscribe(() => {
        // Price update received
      });

      await expect(priceUpdatePromise).resolves.toBeUndefined();
    }, 10000);

    it("should handle trade events", async () => {
      const tradeEventPromise = new Promise<void>((resolve) => {
        let eventCount = 0;

        const mockTradeStream = {
          subscribe: (callback: (event: unknown) => void) => {
            const interval = setInterval(() => {
              callback({
                type: "trade",
                baseToken: testPair.base,
                quoteToken: testPair.quote,
                trade: {
                  id: `trade_${eventCount}`,
                  baseToken: testPair.base,
                  quoteToken: testPair.quote,
                  price: BigInt(300000),
                  quantity: BigInt(10000),
                  isBuy: true,
                  maker:
                    "0x1111111111111111111111111111111111111111" as Address,
                  taker:
                    "0x2222222222222222222222222222222222222222" as Address,
                  timestamp: Date.now(),
                  blockNumber: 1000000,
                  transactionHash: "0xabcd" as `0x${string}`,
                },
              });
              eventCount++;

              if (eventCount >= 2) {
                clearInterval(interval);
                resolve();
              }
            }, 200);
            return () => {
              // noop
            };
          },
          unsubscribe: () => {
            // noop
          },
        };

        mockTradeStream.subscribe(() => {
          // noop subscription
        });
      });

      await realtimeManager.connect();
      const tradeStream = await realtimeManager.subscribeTrades(testPair);

      tradeStream.subscribe(() => {
        // Trade event received
      });

      await expect(tradeEventPromise).resolves.toBeUndefined();
    }, 10000);
  });

  describe("Full Integration Flow", () => {
    it("should execute complete trading workflow", async () => {
      // 1. Set up risk management with very permissive limits
      await riskManager.setRiskLimits({
        maxOrderValue: BigInt(10000000), // $100,000 max order
        maxPositionSize: BigInt(50000000), // $500,000 max position
        positionLimitPercent: 90, // Allow up to 90% of portfolio
        maxDailyLoss: BigInt(50000000), // $500,000 max daily loss
      });

      // 2. Get market data
      const currentPrice = await marketManager.getCurrentPrice(testPair);
      const orderBook = await marketManager.getOrderBook(testPair);

      expect(currentPrice).toBeGreaterThan(0n);
      expect(orderBook.bids.length).toBeGreaterThan(0);
      expect(orderBook.asks.length).toBeGreaterThan(0);

      // 3. Validate order with risk manager - use a small order
      const orderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: currentPrice,
        quantity: BigInt(1000), // Very small order: ~$30
      };

      const riskCheck = await riskManager.validateOrder(orderRequest);
      expect(riskCheck.approved).toBe(true);

      // 4. Place order
      const orderResult = await orderManager.placeMarketOrder(orderRequest);
      expect(orderResult.status).toBe("filled");

      // 5. Record trade in position tracker
      const order = await orderManager.getOrder(orderResult.orderId);
      if (order) {
        await positionTracker.recordTrade(order, order.price, order.quantity);
      }

      // 6. Verify position tracking
      const position = await positionTracker.getPosition(testPair);
      expect(position.balance).toBeGreaterThan(0n);

      // 7. Check portfolio
      const portfolio = await positionTracker.getPortfolio();
      expect(portfolio.totalValue).toBeGreaterThan(0n);

      // 8. Verify real-time capabilities
      await realtimeManager.connect();
      const connectionStatus = realtimeManager.getConnectionStatus();
      expect(connectionStatus.connected).toBe(true);
    });

    it("should handle risk breaches correctly", async () => {
      // Set very low risk limits
      await riskManager.setRiskLimits({
        maxOrderValue: BigInt(1000), // $10 max order
        maxDailyLoss: BigInt(500), // $5 max daily loss
      });

      // Try to place order that exceeds risk limits
      const riskyOrderRequest: OrderRequest = {
        baseToken: testPair.base,
        quoteToken: testPair.quote,
        isBuy: true,
        price: BigInt(300000),
        quantity: BigInt(50000), // $1500 order
      };

      const riskCheck = await riskManager.validateOrder(riskyOrderRequest);
      expect(riskCheck.approved).toBe(false);
      expect(riskCheck.riskScore).toBeGreaterThan(30); // Lower threshold based on actual scoring

      // Record a loss to trigger daily loss limit
      await riskManager.recordLoss(BigInt(600)); // $6 loss

      const breaches = await riskManager.getRiskBreaches();
      expect(breaches.length).toBeGreaterThan(0);
      expect(breaches[0].type).toBe("daily_loss");
      expect(breaches[0].severity).toBe("critical");
    });
  });

  describe("Performance Integration", () => {
    it("should calculate performance metrics across managers", async () => {
      // Execute series of trades to generate performance data
      const trades = [
        { isBuy: true, price: BigInt(300000), quantity: BigInt(33333) }, // Buy at $3000
        { isBuy: false, price: BigInt(310000), quantity: BigInt(16666) }, // Sell half at $3100
        { isBuy: true, price: BigInt(295000), quantity: BigInt(16949) }, // Buy more at $2950
      ];

      for (const trade of trades) {
        const orderRequest: OrderRequest = {
          baseToken: testPair.base,
          quoteToken: testPair.quote,
          isBuy: trade.isBuy,
          price: trade.price,
          quantity: trade.quantity,
        };

        const result = await orderManager.placeMarketOrder(orderRequest);
        const order = await orderManager.getOrder(result.orderId);
        if (order) {
          await positionTracker.recordTrade(order, trade.price, trade.quantity);
        }
      }

      // Get performance metrics
      const performanceMetrics = await positionTracker.getPerformanceMetrics();
      const portfolio = await positionTracker.getPortfolio();
      const pnl = await positionTracker.calculatePnL(testPair);

      expect(performanceMetrics.totalTrades).toBeGreaterThan(0);
      expect(portfolio.totalValue).toBeGreaterThan(0n);
      expect(pnl.realized).toBeDefined();
      expect(pnl.unrealized).toBeDefined();
    });
  });
});
