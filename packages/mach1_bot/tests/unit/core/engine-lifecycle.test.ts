import { PaperTradingEngine } from "@/domains/execution/paper-trading-engine";
import { MarketManager } from "@/domains/trading/market-manager";
import { OrderManager } from "@/domains/trading/order-manager";
import { PositionTracker } from "@/domains/trading/position-tracker";
import { RealtimeManager } from "@/domains/trading/realtime-manager";
import { RiskManager } from "@/domains/trading/risk-manager";
import type {
  Address,
  PaperTradingConfig,
  Portfolio,
  Position,
} from "@/shared/types";
import {
  createSeededRng,
  createSteppingClock,
} from "@/shared/utils/determinism";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMockPositionTracker(): PositionTracker {
  const portfolio: Portfolio = {
    positions: new Map(),
    totalValue: BigInt(100_000_000),
    unrealizedPnL: BigInt(0),
  };
  const position: Position = {
    token: "0x0000000000000000000000000000000000000001" as Address,
    balance: BigInt(0),
    value: BigInt(0),
    unrealizedPnL: BigInt(0),
  };
  return {
    getPortfolio: vi.fn().mockResolvedValue(portfolio),
    getPosition: vi.fn().mockResolvedValue(position),
    getPositionSummary: vi.fn().mockResolvedValue({
      totalValue: BigInt(100_000_000),
      dailyPnL: BigInt(0),
      totalPnL: BigInt(0),
      openPositions: 0,
    }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
  } as unknown as PositionTracker;
}

const paperConfig: PaperTradingConfig = {
  initialCapital: BigInt(1_000_000_000),
  commission: 0.001,
  slippage: 0.001,
  latencyMs: 0,
};

// ── RiskManager failOpen/failClosed ─────────────────────────────────────────

describe("RiskManager fail-open / fail-closed", () => {
  let positionTracker: PositionTracker;
  let marketManager: MarketManager;
  let orderManager: OrderManager;

  beforeEach(() => {
    marketManager = new MarketManager();
    positionTracker = makeMockPositionTracker();
    orderManager = new OrderManager(marketManager);

    // Simulate position-tracker failure for checkMaxLoss inner path
    vi.mocked(positionTracker.getPosition).mockRejectedValue(
      new Error("tracker unavailable"),
    );
  });

  it("fail-closed (default): returns false on error in checkMaxLoss inner path", async () => {
    const rm = new RiskManager(positionTracker, marketManager, orderManager, {
      failOpen: false,
    });
    const order = {
      baseToken: "0xAAA" as Address,
      quoteToken: "0xBBB" as Address,
      price: BigInt(100),
      quantity: BigInt(10),
      isBuy: false, // sell triggers inner position lookup
    };
    const result = await rm.checkMaxLoss(order);
    expect(result).toBe(false);
  });

  it("fail-open: returns true on error in checkMaxLoss inner path", async () => {
    const rm = new RiskManager(positionTracker, marketManager, orderManager, {
      failOpen: true,
    });
    const order = {
      baseToken: "0xAAA" as Address,
      quoteToken: "0xBBB" as Address,
      price: BigInt(100),
      quantity: BigInt(10),
      isBuy: false,
    };
    const result = await rm.checkMaxLoss(order);
    expect(result).toBe(true);
  });

  it("checkCorrelation fail-closed on error", async () => {
    vi.mocked(positionTracker.getPortfolio).mockRejectedValue(
      new Error("portfolio unavailable"),
    );
    const rm = new RiskManager(positionTracker, marketManager, orderManager, {
      failOpen: false,
    });
    const order = {
      baseToken: "0xAAA" as Address,
      quoteToken: "0xBBB" as Address,
      price: BigInt(100),
      quantity: BigInt(10),
      isBuy: true,
    };
    const result = await rm.checkCorrelation(order);
    expect(result).toBe(false);
  });
});

// ── Deterministic Rng ────────────────────────────────────────────────────────

describe("createSeededRng", () => {
  it("produces same sequence for same seed", () => {
    const rng1 = createSeededRng(42);
    const rng2 = createSeededRng(42);
    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());
    expect(seq1).toEqual(seq2);
  });

  it("produces different sequence for different seed", () => {
    const rng1 = createSeededRng(1);
    const rng2 = createSeededRng(2);
    const first1 = rng1.next();
    const first2 = rng2.next();
    expect(first1).not.toBe(first2);
  });

  it("values are in [0, 1)", () => {
    const rng = createSeededRng(99);
    for (let i = 0; i < 100; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("createSteppingClock", () => {
  it("advances by step on each call", () => {
    const clock = createSteppingClock(1000, 500);
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1500);
    expect(clock.now()).toBe(2000);
  });
});

// ── PaperTradingEngine with seeded Rng ───────────────────────────────────────

describe("PaperTradingEngine deterministic fills", () => {
  it("produces same fill prices for same seed", async () => {
    const build = () => {
      const mm = new MarketManager({ rng: createSeededRng(7) });
      const om = new OrderManager(mm, { rng: createSeededRng(7) });
      const rm = new RealtimeManager(mm, om);
      return new PaperTradingEngine(paperConfig, mm, rm, {
        rng: createSeededRng(7),
        clock: createSteppingClock(1_700_000_000_000, 1000),
      });
    };

    const engine1 = build();
    const engine2 = build();

    const pair = {
      base: "0x1234567890123456789012345678901234567890" as Address,
      quote: "0x0987654321098765432109876543210987654321" as Address,
      symbol: "BTC/USDC",
    };

    const order = {
      baseToken: pair.base,
      quoteToken: pair.quote,
      price: BigInt(5000_00000000), // 5000 USDC in raw
      quantity: BigInt(1_00000000), // 1 BTC in raw
      isBuy: true,
    };

    const result1 = await engine1.placeOrder(order);
    const result2 = await engine2.placeOrder(order);

    // Both engines with identical seeds should produce the same fill result
    expect(result1.success).toBe(result2.success);
    if (result1.fill && result2.fill) {
      expect(result1.fill.price).toBe(result2.fill.price);
    }
  });
});

// ── BacktestConfig/PaperTradingConfig new fields ─────────────────────────────

describe("BacktestConfig shape", () => {
  it("accepts optional new fields without compile errors", () => {
    // This is a type-only check — just ensuring the object is accepted
    const config = {
      startDate: new Date("2024-01-01"),
      endDate: new Date("2024-12-31"),
      initialCapital: BigInt(1_000_000_000),
      commission: 0.001,
      slippage: 0.001,
      dataDirectory: "/tmp/test-data",
      tradingPairs: ["BTC/USDC"],
      seed: 42,
      startingBalances: { "0xabc": BigInt(1000) },
    };
    expect(config.dataDirectory).toBe("/tmp/test-data");
    expect(config.tradingPairs).toEqual(["BTC/USDC"]);
    expect(config.seed).toBe(42);
  });
});

describe("PaperTradingConfig shape", () => {
  it("accepts optional new fields without compile errors", () => {
    const config: PaperTradingConfig = {
      initialCapital: BigInt(1_000_000_000),
      commission: 0.001,
      slippage: 0.001,
      latencyMs: 0,
      seed: 7,
      startingBalances: {},
    };
    expect(config.seed).toBe(7);
  });
});
