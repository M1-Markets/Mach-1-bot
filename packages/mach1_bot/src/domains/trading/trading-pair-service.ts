import type { ResolvedTradingPair, TradingPairResolver } from "mach1_sdk";
import type { Address, TradingPair } from "@/shared/types";

type TradingPairResolverLike = Pick<
  TradingPairResolver,
  "getAllSymbols" | "getPairByContracts" | "getPairBySymbol" | "normalizeSymbol"
>;

const SIMULATION_TRADING_PAIRS = [
  {
    base: "0x1111111111111111111111111111111111111111" as Address,
    quote: "0x4444444444444444444444444444444444444444" as Address,
    symbol: "ETH/USDC",
  },
  {
    base: "0x2222222222222222222222222222222222222222" as Address,
    quote: "0x4444444444444444444444444444444444444444" as Address,
    symbol: "BTC/USDC",
  },
  {
    base: "0x3333333333333333333333333333333333333333" as Address,
    quote: "0x4444444444444444444444444444444444444444" as Address,
    symbol: "SOL/USDC",
  },
] as const satisfies readonly TradingPair[];

function toAddress(value: string, field: string, symbol: string): Address {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(
      `Resolver returned invalid ${field} address for trading pair: ${symbol}`,
    );
  }

  return value as Address;
}

function toTradingPair(pair: ResolvedTradingPair, symbol: string): TradingPair {
  return {
    base: toAddress(pair.base_token_contract, "base", symbol),
    quote: toAddress(pair.quote_token_contract, "quote", symbol),
    symbol,
  };
}

export class TradingPairService {
  constructor(
    private readonly resolverProvider?: () =>
      | TradingPairResolverLike
      | undefined,
  ) {}

  normalizeSymbol(symbol: string): string {
    return symbol
      .trim()
      .toUpperCase()
      .replace(/\s*[-/]\s*/g, "/")
      .replace(/\s+/g, "");
  }

  resolveSymbol(symbol: string): TradingPair {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const resolver = this.resolverProvider?.();

    if (resolver) {
      const resolved = this.resolveWithResolver(resolver, normalizedSymbol);
      if (resolved) {
        return resolved;
      }

      const availableSymbols = this.getAllSymbols();
      const preview = availableSymbols.slice(0, 5).join(", ");
      throw new Error(
        `Unsupported trading pair: ${symbol}. Available symbols include: ${preview}${availableSymbols.length > 5 ? ", ..." : ""}`,
      );
    }

    const pair = SIMULATION_TRADING_PAIRS.find(
      (entry) => entry.symbol === normalizedSymbol,
    );
    if (!pair) {
      throw new Error(`Unsupported trading pair: ${symbol}`);
    }

    return { ...pair };
  }

  getAllSymbols(): string[] {
    const resolver = this.resolverProvider?.();
    if (!resolver) {
      return SIMULATION_TRADING_PAIRS.map((pair) => pair.symbol);
    }

    const normalizedSymbols = resolver
      .getAllSymbols()
      .map((symbol) => this.normalizeSymbol(resolver.normalizeSymbol(symbol)));

    return Array.from(new Set(normalizedSymbols));
  }

  resolvePairFromContracts(base: Address, quote: Address): TradingPair | null {
    const resolver = this.resolverProvider?.();
    if (resolver) {
      const pair = resolver.getPairByContracts(base, quote);
      if (!pair) {
        return null;
      }

      const normalizedSymbol = this.normalizeSymbol(
        resolver.normalizeSymbol(pair.symbol),
      );
      return toTradingPair(pair, normalizedSymbol);
    }

    const baseLower = base.toLowerCase();
    const quoteLower = quote.toLowerCase();
    const match = SIMULATION_TRADING_PAIRS.find(
      (pair) =>
        pair.base.toLowerCase() === baseLower &&
        pair.quote.toLowerCase() === quoteLower,
    );

    return match ? { ...match } : null;
  }

  private resolveWithResolver(
    resolver: TradingPairResolverLike,
    normalizedSymbol: string,
  ): TradingPair | null {
    const matchedSymbol = resolver
      .getAllSymbols()
      .find(
        (symbol) =>
          this.normalizeSymbol(resolver.normalizeSymbol(symbol)) ===
          normalizedSymbol,
      );
    const pair =
      (matchedSymbol ? resolver.getPairBySymbol(matchedSymbol) : undefined) ??
      resolver.getPairBySymbol(normalizedSymbol) ??
      resolver.getPairBySymbol(normalizedSymbol.replace("/", "-"));

    if (!pair) {
      return null;
    }

    const canonicalSymbol = this.normalizeSymbol(
      resolver.normalizeSymbol(pair.symbol),
    );
    return toTradingPair(pair, canonicalSymbol);
  }
}

export function getSimulationTradingPairs(): TradingPair[] {
  return SIMULATION_TRADING_PAIRS.map((pair) => ({ ...pair }));
}
