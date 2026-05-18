import { InvalidAmountError, InvalidSymbolError } from "@/errors";
import {
  PriceUtils,
  SymbolUtils,
  TimeUtils,
  ValidationUtils,
} from "@/shared/utils";

describe("SymbolUtils", () => {
  describe("parseSymbol", () => {
    it("should parse valid symbol correctly", () => {
      const result = SymbolUtils.parseSymbol("ETH/USDC");

      expect(result.base).toBe("0xeth");
      expect(result.quote).toBe("0xusdc");
      expect(result.symbol).toBe("ETH/USDC");
    });

    it("should throw error for invalid symbol format", () => {
      expect(() => SymbolUtils.parseSymbol("ETHUSDC")).toThrow(
        InvalidSymbolError,
      );
      expect(() => SymbolUtils.parseSymbol("ETH")).toThrow(InvalidSymbolError);
      expect(() => SymbolUtils.parseSymbol("ETH/USDC/BTC")).toThrow(
        InvalidSymbolError,
      );
    });

    it("should throw error for empty parts", () => {
      expect(() => SymbolUtils.parseSymbol("/USDC")).toThrow(
        InvalidSymbolError,
      );
      expect(() => SymbolUtils.parseSymbol("ETH/")).toThrow(InvalidSymbolError);
    });
  });

  describe("isValidSymbol", () => {
    it("should return true for valid symbols", () => {
      expect(SymbolUtils.isValidSymbol("ETH/USDC")).toBe(true);
      expect(SymbolUtils.isValidSymbol("BTC/USDT")).toBe(true);
    });

    it("should return false for invalid symbols", () => {
      expect(SymbolUtils.isValidSymbol("ETHUSDC")).toBe(false);
      expect(SymbolUtils.isValidSymbol("ETH")).toBe(false);
    });
  });

  describe("normalizeSymbol", () => {
    it("should normalize symbol correctly", () => {
      expect(SymbolUtils.normalizeSymbol("eth/usdc")).toBe("ETH/USDC");
      expect(SymbolUtils.normalizeSymbol(" BTC / USDT ")).toBe("BTC/USDT");
    });
  });
});

describe("PriceUtils", () => {
  describe("toBaseUnits", () => {
    it("should convert to base units correctly", () => {
      const result = PriceUtils.toBaseUnits(3000, 6); // $3000 USDC
      expect(result).toBe(3000000000n);
    });

    it("should throw error for non-positive amounts", () => {
      expect(() => PriceUtils.toBaseUnits(0)).toThrow(InvalidAmountError);
      expect(() => PriceUtils.toBaseUnits(-100)).toThrow(InvalidAmountError);
    });
  });

  describe("fromBaseUnits", () => {
    it("should convert from base units correctly", () => {
      const result = PriceUtils.fromBaseUnits(3000000000n, 6);
      expect(result).toBe(3000);
    });

    it("should throw error for negative amounts", () => {
      expect(() => PriceUtils.fromBaseUnits(-100n)).toThrow(InvalidAmountError);
    });
  });

  describe("calculateSlippage", () => {
    it("should calculate slippage correctly", () => {
      const expected = 3000n * 10n ** 6n;
      const actual = 3030n * 10n ** 6n;

      const slippage = PriceUtils.calculateSlippage(expected, actual);
      expect(slippage).toBeCloseTo(1.0, 1); // 1% slippage
    });

    it("should handle zero expected price", () => {
      expect(() => PriceUtils.calculateSlippage(0n, 3000n)).toThrow();
    });
  });

  describe("applySlippage", () => {
    it("should apply slippage for buy orders", () => {
      const price = 3000n * 10n ** 6n;
      const result = PriceUtils.applySlippage(price, 1, true);

      expect(result).toBe(price + price / 100n);
    });

    it("should apply slippage for sell orders", () => {
      const price = 3000n * 10n ** 6n;
      const result = PriceUtils.applySlippage(price, 1, false);

      expect(result).toBe(price - price / 100n);
    });
  });
});

describe("TimeUtils", () => {
  describe("parseTimeString", () => {
    it("should parse time strings correctly", () => {
      expect(TimeUtils.parseTimeString("30s")).toBe(30000);
      expect(TimeUtils.parseTimeString("5m")).toBe(300000);
      expect(TimeUtils.parseTimeString("1h")).toBe(3600000);
      expect(TimeUtils.parseTimeString("1d")).toBe(86400000);
    });

    it("should throw error for invalid format", () => {
      expect(() => TimeUtils.parseTimeString("invalid")).toThrow();
      expect(() => TimeUtils.parseTimeString("30")).toThrow();
    });
  });

  describe("formatDuration", () => {
    it("should format duration correctly", () => {
      expect(TimeUtils.formatDuration(30000)).toBe("30s");
      expect(TimeUtils.formatDuration(300000)).toBe("5m");
      expect(TimeUtils.formatDuration(3600000)).toBe("1h");
    });
  });

  describe("isValidTimeframe", () => {
    it("should validate timeframes correctly", () => {
      expect(TimeUtils.isValidTimeframe("1m")).toBe(true);
      expect(TimeUtils.isValidTimeframe("5m")).toBe(true);
      expect(TimeUtils.isValidTimeframe("1h")).toBe(true);
      expect(TimeUtils.isValidTimeframe("2h")).toBe(false);
    });
  });
});

describe("ValidationUtils", () => {
  describe("isValidAddress", () => {
    it("should validate Ethereum addresses correctly", () => {
      expect(
        ValidationUtils.isValidAddress(
          "0x1234567890123456789012345678901234567890",
        ),
      ).toBe(true);
      expect(ValidationUtils.isValidAddress("0xinvalid")).toBe(false);
      expect(ValidationUtils.isValidAddress("invalid")).toBe(false);
    });
  });

  describe("isValidPrivateKey", () => {
    it("should validate private keys correctly", () => {
      expect(ValidationUtils.isValidPrivateKey("0x" + "1".repeat(64))).toBe(
        true,
      );
      expect(ValidationUtils.isValidPrivateKey("0x" + "1".repeat(63))).toBe(
        false,
      );
      expect(ValidationUtils.isValidPrivateKey("invalid")).toBe(false);
    });
  });

  describe("isPositiveNumber", () => {
    it("should validate positive numbers correctly", () => {
      expect(ValidationUtils.isPositiveNumber(100)).toBe(true);
      expect(ValidationUtils.isPositiveNumber(0.1)).toBe(true);
      expect(ValidationUtils.isPositiveNumber(0)).toBe(false);
      expect(ValidationUtils.isPositiveNumber(-1)).toBe(false);
      expect(ValidationUtils.isPositiveNumber(NaN)).toBe(false);
    });
  });

  describe("isValidPercentage", () => {
    it("should validate percentages correctly", () => {
      expect(ValidationUtils.isValidPercentage(50)).toBe(true);
      expect(ValidationUtils.isValidPercentage(0)).toBe(true);
      expect(ValidationUtils.isValidPercentage(100)).toBe(true);
      expect(ValidationUtils.isValidPercentage(-1)).toBe(false);
      expect(ValidationUtils.isValidPercentage(101)).toBe(false);
    });
  });
});
