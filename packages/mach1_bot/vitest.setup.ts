// Global test setup for Vitest
import { vi } from "vitest";

expect.extend({
  toBeValidPrice(received) {
    const pass =
      typeof received === "bigint"
        ? received > 0n
        : typeof received === "number" && received > 0;
    return {
      pass,
      message: () => `expected ${received} to be a valid price (> 0)`,
    };
  },
  toBeValidQuantity(received) {
    const pass = typeof received === "bigint" ? received > 0n : received > 0;
    return {
      pass,
      message: () => `expected ${received} to be a valid quantity (> 0)`,
    };
  },
  toBeValidEthereumAddress(received) {
    const pass = /^0x[a-fA-F0-9]{40}$/.test(received);
    return {
      pass,
      message: () => `expected ${received} to be a valid Ethereum address`,
    };
  },
  toBeValidAddress(received) {
    const pass = /^0x[a-fA-F0-9]{40}$/.test(received);
    return {
      pass,
      message: () => `expected ${received} to be a valid address`,
    };
  },
  toBeWithinRange(received, min, max) {
    const pass = received >= min && received <= max;
    return {
      pass,
      message: () => `expected ${received} to be within range ${min}-${max}`,
    };
  },
});

// Mock console methods to reduce noise in tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// Mock environment variables for testing (only for compatibility)
process.env.NODE_ENV = "test";

// Mock global WebSocket and fetch if needed
(global as any).WebSocket = vi.fn(() => ({
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
(global as any).fetch = vi.fn();

// Example: mock a module
vi.mock("mach1_sdk", async () => {
  const actual = await vi.importActual<typeof import("mach1_sdk")>("mach1_sdk");
  return {
    ...actual,
    OrderStatus: {
      PENDING: "PENDING",
      SUBMITTED: "SUBMITTED",
      PARTIALLY_FILLED: "PARTIALLY_FILLED",
      FILLED: "FILLED",
      SETTLED_ON_CHAIN: "SETTLED_ON_CHAIN",
      SETTLED: "SETTLED",
      CANCELLED: "CANCELLED",
      REJECTED: "REJECTED",
      EXPIRED: "EXPIRED",
    },
    OrderType: {
      LIMIT: "LIMIT",
      MARKET: "MARKET",
      STOP_LOSS: "STOP_LOSS",
      TAKE_PROFIT: "TAKE_PROFIT",
      STOP_LIMIT: "STOP_LIMIT",
      TRAILING_STOP: "TRAILING_STOP",
    },
    OrderSide: {
      BUY: "BUY",
      SELL: "SELL",
    },
    createMach1SDK: vi.fn(() => ({
      login: vi.fn().mockResolvedValue({}),
      logout: vi.fn().mockResolvedValue(undefined),
      refreshToken: vi.fn().mockResolvedValue({}),
      trading: {
        createOrder: vi
          .fn()
          .mockResolvedValue({ orderId: "test-order-id", status: "pending" }),
        cancelOrder: vi.fn().mockResolvedValue({ success: true }),
        getTradingPairs: vi.fn().mockResolvedValue([]),
        getPaginatedTradingPairs: vi.fn().mockResolvedValue({
          data: [],
          pagination: { page: 1, pageSize: 100, total: 0 },
        }),
        subscribeToOHLCV: vi.fn(),
        unsubscribe: vi.fn(),
        subscribeToOrderbookEvents: vi.fn(),
        subscribeToOrderEvents: vi.fn(),
      },
    })),
  };
});

// Clear mocks after each test
import { afterEach } from "vitest";

afterEach(() => {
  vi.clearAllMocks();
  vi.clearAllTimers();
});
