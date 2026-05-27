import type {
  ConfigModeInput,
  LiveTradingMarketMode,
  PerpsMarginMode,
  RuntimeMode,
} from "@/shared/types/config";

const runtimeModes = ["backtest", "simulation", "live"] as const;
const configModeInputs = [...runtimeModes, "paper"] as const;
const liveTradingMarketModes = ["spot", "isolated_perps"] as const;
const perpsMarginModes = ["isolated", "cross"] as const;

export function isConfigModeInput(value: string): value is ConfigModeInput {
  return configModeInputs.includes(value as ConfigModeInput);
}

export function normalizeConfigMode(
  mode: string | undefined | null,
): RuntimeMode {
  if (mode === "paper") {
    return "simulation";
  }

  if (mode && runtimeModes.includes(mode as RuntimeMode)) {
    return mode as RuntimeMode;
  }

  return "simulation";
}

export function isLiveMode(mode: string | undefined | null): boolean {
  return normalizeConfigMode(mode) === "live";
}

export function isLiveTradingMarketMode(
  value: string,
): value is LiveTradingMarketMode {
  return liveTradingMarketModes.includes(value as LiveTradingMarketMode);
}

export function normalizeLiveTradingMarketMode(
  marketMode: string | undefined | null,
): LiveTradingMarketMode {
  if (marketMode && isLiveTradingMarketMode(marketMode)) {
    return marketMode;
  }

  return "spot";
}

export function isPerpsMarginMode(value: string): value is PerpsMarginMode {
  return perpsMarginModes.includes(value as PerpsMarginMode);
}

export function normalizePerpsMarginMode(
  marginMode: string | undefined | null,
): PerpsMarginMode {
  if (marginMode && isPerpsMarginMode(marginMode)) {
    return marginMode;
  }

  return "isolated";
}
