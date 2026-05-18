import { vi } from "vitest";
import {
  displayStrategiesTable,
  displayStrategyDetails,
  type StrategyDisplayInfo,
  validateStrategyConfig,
} from "@/cli/utils/strategy-utils";

vi.mock("picocolors", () => ({
  default: {
    cyan: (text: string) => text,
    blue: (text: string) => text,
    green: (text: string) => text,
    yellow: (text: string) => text,
    red: (text: string) => text,
    gray: (text: string) => text,
    magenta: (text: string) => text,
    bold: (text: string) => text,
  },
}));

const mockConsole = {
  log: vi.fn(),
};

const mockStrategies: StrategyDisplayInfo[] = [
  {
    id: "dca-strategy-v1",
    name: "DCA Strategy",
    version: "1.0.0",
    author: "Mach-One SDK",
    category: "accumulation",
    description: "Dollar-cost averaging strategy",
    riskLevel: 2,
    minCapital: 1000,
    supportedPairs: ["BTC/USDC", "ETH/USDC", "SOL/USDC"],
    tags: ["dca", "systematic"],
    examples: [
      {
        name: "Conservative DCA",
        description: "Weekly recurring buy setup",
        parameters: {
          pair: "ETH/USDC",
          totalAmountUsd: 1000,
          intervalMinutes: 10080,
          orderCount: 12,
        },
        expectedReturn: 8,
        riskLevel: 2,
      },
    ],
  },
  {
    id: "grid-strategy-v1",
    name: "Grid Trading",
    version: "1.0.0",
    author: "Mach-One SDK",
    category: "volatility",
    description: "Grid trading strategy for profiting from market volatility",
    riskLevel: 5,
    minCapital: 5000,
    supportedPairs: ["BTC/USDC", "ETH/USDC", "SOL/USDC"],
    tags: ["grid", "volatility", "market-making"],
    examples: [
      {
        name: "ETH Grid Trading",
        description: "Moderate grid for ETH price range",
        parameters: {
          pair: "ETH/USDC",
          lowerBound: 2500,
          upperBound: 3500,
          gridCount: 15,
          totalAmount: 10000,
        },
        expectedReturn: 12,
        riskLevel: 5,
      },
    ],
  },
];

describe("CLI strategy utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(console, mockConsole);
  });

  describe("displayStrategiesTable", () => {
    it("shows table header and strategy rows", () => {
      displayStrategiesTable(mockStrategies);

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("Available Strategies"),
      );
      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("DCA Strategy"),
      );
      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("Grid Trading"),
      );
    });

    it("shows empty-state message", () => {
      displayStrategiesTable([]);

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining("No strategies found"),
      );
    });
  });

  describe("displayStrategyDetails", () => {
    it("shows full strategy details", () => {
      displayStrategyDetails(mockStrategies[1]);

      const output = vi.mocked(mockConsole.log).mock.calls.flat().join(" ");

      expect(output).toContain("Strategy Details");
      expect(output).toContain("Grid Trading");
      expect(output).toContain("1.0.0");
      expect(output).toContain("Mach-One SDK");
      expect(output).toContain("volatility");
      expect(output).toContain("5/10");
      expect(output).toContain("$5000");
    });

    it("shows example section when examples exist", () => {
      displayStrategyDetails(mockStrategies[0]);

      const output = vi.mocked(mockConsole.log).mock.calls.flat().join(" ");

      expect(output).toContain("Example Configurations");
      expect(output).toContain("Conservative DCA");
    });
  });

  describe("validateStrategyConfig", () => {
    it("accepts valid config", () => {
      const result = validateStrategyConfig("dca-strategy", {
        pair: "ETH/USDC",
        totalAmountUsd: 1000,
        riskLevel: 5,
      });

      expect(result).toEqual({
        isValid: true,
        errors: [],
      });
    });

    it("rejects non-positive total amount", () => {
      const result = validateStrategyConfig("dca-strategy", {
        pair: "ETH/USDC",
        totalAmountUsd: -1000,
        riskLevel: 5,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Total amount must be positive");
    });

    it("rejects invalid risk level", () => {
      const result = validateStrategyConfig("dca-strategy", {
        pair: "ETH/USDC",
        totalAmountUsd: 1000,
        riskLevel: 15,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Risk level must be between 1 and 10");
    });

    it("accepts portfolio config without pair", () => {
      const result = validateStrategyConfig("portfolio-strategy", {
        allocationTargets: [
          { token: "BTC/USDC", targetPercent: 50 },
          { token: "ETH/USDC", targetPercent: 50 },
        ],
        riskLevel: 5,
      });

      expect(result).toEqual({
        isValid: true,
        errors: [],
      });
    });
  });
});
