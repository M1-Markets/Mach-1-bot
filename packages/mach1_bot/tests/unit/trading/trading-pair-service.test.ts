import type { ResolvedTradingPair } from "mach1_sdk";
import { TradingPairService } from "@/domains/trading/trading-pair-service";
import type { Address } from "@/shared/types";

const resolvedPair: ResolvedTradingPair = {
  id: "pair-eth-usdc",
  symbol: "WETH-USDC",
  base_token: "WETH",
  quote_token: "USDC",
  base_token_contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  quote_token_contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  base_decimals: 18,
  quote_decimals: 6,
  market_type: "SPOT",
  is_active: true,
  maker_fee_bps: 1,
  taker_fee_bps: 2,
  min_order_size: "1",
  max_order_size: "1000",
  tick_size: "0.01",
};

describe("TradingPairService", () => {
  it("resolves live symbols through Monaco resolver", () => {
    const getPairBySymbol = vi.fn((symbol: string) =>
      symbol === "WETH-USDC" ? resolvedPair : undefined,
    );
    const service = new TradingPairService(() => ({
      normalizeSymbol: (symbol: string) =>
        symbol.replace("WETH", "ETH").replace("-", "/"),
      getAllSymbols: () => ["WETH-USDC"],
      getPairBySymbol,
      getPairByContracts: () => undefined,
    }));

    expect(service.resolveSymbol("eth/usdc")).toEqual({
      base: resolvedPair.base_token_contract as Address,
      quote: resolvedPair.quote_token_contract as Address,
      symbol: "ETH/USDC",
    });
    expect(getPairBySymbol).toHaveBeenCalledWith("WETH-USDC");
  });

  it("uses simulation fallback table when resolver missing", () => {
    const service = new TradingPairService();

    expect(service.resolveSymbol("BTC/USDC")).toEqual({
      base: "0x2222222222222222222222222222222222222222",
      quote: "0x4444444444444444444444444444444444444444",
      symbol: "BTC/USDC",
    });
    expect(service.getAllSymbols()).toEqual([
      "ETH/USDC",
      "BTC/USDC",
      "SOL/USDC",
    ]);
  });

  it("normalizes separator variants to canonical symbols", () => {
    const service = new TradingPairService();

    expect(service.normalizeSymbol(" eth - usdc ")).toBe("ETH/USDC");
    expect(service.resolveSymbol("ETH-USDC").symbol).toBe("ETH/USDC");
  });

  it("rejects unknown symbols", () => {
    const service = new TradingPairService();

    expect(() => service.resolveSymbol("DOGE/USDC")).toThrow(
      "Unsupported trading pair: DOGE/USDC",
    );
  });

  it("resolves pairs from known contracts", () => {
    const service = new TradingPairService();

    expect(
      service.resolvePairFromContracts(
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444",
      ),
    ).toEqual({
      base: "0x3333333333333333333333333333333333333333",
      quote: "0x4444444444444444444444444444444444444444",
      symbol: "SOL/USDC",
    });
  });
});
