import {
  InvalidAmountError,
  InvalidPriceError,
  InvalidSymbolError,
} from "../errors";
import { Address, TradingPair } from "../types/common";

// Symbol parsing utilities
export class SymbolUtils {
  static parseSymbol(symbol: string): TradingPair {
    const parts = symbol.split("/");
    if (parts.length !== 2) {
      throw new InvalidSymbolError(symbol);
    }

    const [base, quote] = parts;
    if (!base || !quote) {
      throw new InvalidSymbolError(symbol);
    }

    return {
      base: `0x${base.toLowerCase()}` as Address,
      quote: `0x${quote.toLowerCase()}` as Address,
      symbol: symbol.toUpperCase(),
    };
  }

  static formatSymbol(pair: TradingPair): string {
    return pair.symbol;
  }

  static isValidSymbol(symbol: string): boolean {
    try {
      SymbolUtils.parseSymbol(symbol);
      return true;
    } catch {
      return false;
    }
  }

  static normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/\s+/g, "");
  }
}

// Price and amount conversion utilities
export class PriceUtils {
  private static readonly PRICE_DECIMALS = 6;
  private static readonly TOKEN_DECIMALS = 18;

  static toBaseUnits(
    amount: number,
    decimals: number = PriceUtils.TOKEN_DECIMALS,
  ): bigint {
    if (amount <= 0) {
      throw new InvalidAmountError(amount, "Amount must be positive");
    }

    const _multiplier = BigInt(10 ** decimals);
    const scaled = Math.floor(amount * 10 ** decimals);
    return BigInt(scaled);
  }

  static fromBaseUnits(
    amount: bigint,
    decimals: number = PriceUtils.TOKEN_DECIMALS,
  ): number {
    if (amount < 0n) {
      throw new InvalidAmountError(amount, "Amount cannot be negative");
    }

    const divisor = 10 ** decimals;
    return Number(amount) / divisor;
  }

  static formatPrice(
    price: bigint,
    decimals: number = PriceUtils.PRICE_DECIMALS,
  ): string {
    const formatted = PriceUtils.fromBaseUnits(price, decimals);
    return formatted.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimals,
    });
  }

  static formatAmount(
    amount: bigint,
    decimals: number = PriceUtils.TOKEN_DECIMALS,
  ): string {
    const formatted = PriceUtils.fromBaseUnits(amount, decimals);
    return formatted.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
    });
  }

  static calculateSlippage(expectedPrice: bigint, actualPrice: bigint): number {
    if (expectedPrice === 0n) {
      throw new InvalidPriceError(
        expectedPrice,
        "Expected price cannot be zero",
      );
    }

    const diff =
      actualPrice > expectedPrice
        ? actualPrice - expectedPrice
        : expectedPrice - actualPrice;

    return Number((diff * 10000n) / expectedPrice) / 100;
  }

  static applySlippage(
    price: bigint,
    slippagePercent: number,
    isBuy: boolean,
  ): bigint {
    if (slippagePercent < 0 || slippagePercent > 100) {
      throw new Error("Slippage must be between 0 and 100 percent");
    }

    const slippageBasisPoints = BigInt(Math.floor(slippagePercent * 100));
    const adjustment = (price * slippageBasisPoints) / 10000n;

    return isBuy ? price + adjustment : price - adjustment;
  }
}

// Time parsing utilities
export class TimeUtils {
  static parseTimeString(timeStr: string): number {
    const timeMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };

    const match = timeStr.match(/^(\d+)([smhdw])$/i);
    if (!match) {
      throw new Error(
        `Invalid time format: ${timeStr}. Use format like: 1s, 5m, 1h, 1d, 1w`,
      );
    }

    const [, amount, unit] = match;
    const multiplier = timeMap[unit.toLowerCase()];
    return parseInt(amount) * multiplier;
  }

  static formatDuration(ms: number): string {
    const units = [
      { name: "w", value: 7 * 24 * 60 * 60 * 1000 },
      { name: "d", value: 24 * 60 * 60 * 1000 },
      { name: "h", value: 60 * 60 * 1000 },
      { name: "m", value: 60 * 1000 },
      { name: "s", value: 1000 },
    ];

    for (const unit of units) {
      if (ms >= unit.value) {
        const value = Math.floor(ms / unit.value);
        return `${value}${unit.name}`;
      }
    }
    return "0s";
  }

  static isValidTimeframe(timeframe: string): boolean {
    const validTimeframes = [
      "1s",
      "5s",
      "15s",
      "30s",
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "4h",
      "12h",
      "1d",
      "1w",
    ];
    return validTimeframes.includes(timeframe);
  }

  static toTimestamp(date: string | Date): number {
    if (typeof date === "string") {
      return new Date(date).getTime();
    }
    return date.getTime();
  }
}

// Validation utilities
export class ValidationUtils {
  static isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  static isValidPrivateKey(privateKey: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(privateKey);
  }

  static isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  static isPositiveNumber(value: number): boolean {
    return typeof value === "number" && value > 0 && !isNaN(value);
  }

  static isValidPercentage(value: number): boolean {
    return (
      typeof value === "number" && value >= 0 && value <= 100 && !isNaN(value)
    );
  }

  static sanitizeString(input: string): string {
    return input.trim().replace(/[^\w\s\-_.]/g, "");
  }
}
