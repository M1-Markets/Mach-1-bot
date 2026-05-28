import type {
  IsolatedPerpsConfig,
  LiveTradingMarketMode,
} from "@/shared/types/config";
import {
  isLiveMode,
  isLiveTradingMarketMode,
  isPerpsMarginMode,
  normalizeLiveTradingMarketMode,
  normalizePerpsMarginMode,
} from "@/shared/utils/config-mode";

type RawPerpsConfig = {
  marginMode?: string | null;
  leverage?: number | null;
  liquidationThresholdPercent?: number | null;
} | null;

export interface LiveMarketConfigValidationInput {
  mode: string | undefined | null;
  marketMode: string | undefined | null;
  perps?: RawPerpsConfig;
}

export interface NormalizedLiveMarketConfig {
  marketMode: LiveTradingMarketMode;
  perps?: IsolatedPerpsConfig;
}

function hasPerpsSettings(perps?: RawPerpsConfig): boolean {
  return Boolean(
    perps &&
      (perps.marginMode !== undefined ||
        perps.leverage !== undefined ||
        perps.liquidationThresholdPercent !== undefined),
  );
}

export function validateLiveMarketConfig(
  input: LiveMarketConfigValidationInput,
): string[] {
  const errors: string[] = [];
  const { mode, marketMode, perps } = input;

  if (marketMode && !isLiveTradingMarketMode(marketMode)) {
    errors.push("trading.market_mode must be one of: spot, isolated_perps");
    return errors;
  }

  const normalizedMarketMode = normalizeLiveTradingMarketMode(marketMode);
  const hasPerps = hasPerpsSettings(perps);

  if (normalizedMarketMode !== "isolated_perps" && hasPerps) {
    errors.push(
      'perps settings are only supported when trading.market_mode is "isolated_perps"',
    );
  }

  if (normalizedMarketMode === "isolated_perps" && !isLiveMode(mode)) {
    errors.push(
      'trading.market_mode = "isolated_perps" is only supported in live mode',
    );
  }

  if (normalizedMarketMode !== "isolated_perps") {
    return errors;
  }

  if (perps?.marginMode && !isPerpsMarginMode(perps.marginMode)) {
    errors.push("perps.margin_mode must be one of: isolated, cross");
  }

  if (perps?.marginMode === "cross") {
    errors.push(
      'Cross-margin perps mode is not supported in this phase; use perps.margin_mode = "isolated"',
    );
  }

  const leverage = perps?.leverage;
  if (
    typeof leverage !== "number" ||
    !Number.isFinite(leverage) ||
    leverage <= 0
  ) {
    errors.push("perps.leverage must be a positive number");
  }

  const liquidationThresholdPercent = perps?.liquidationThresholdPercent;
  if (
    liquidationThresholdPercent !== undefined &&
    liquidationThresholdPercent !== null &&
    (typeof liquidationThresholdPercent !== "number" ||
      !Number.isFinite(liquidationThresholdPercent) ||
      liquidationThresholdPercent <= 0 ||
      liquidationThresholdPercent >= 100)
  ) {
    errors.push(
      "perps.liquidation_threshold_percent must be greater than 0 and less than 100",
    );
  }

  return errors;
}

export function normalizeLiveMarketConfig(
  input: LiveMarketConfigValidationInput,
): NormalizedLiveMarketConfig {
  const marketMode = normalizeLiveTradingMarketMode(input.marketMode);

  if (marketMode !== "isolated_perps") {
    return { marketMode };
  }

  return {
    marketMode,
    perps: {
      marginMode: normalizePerpsMarginMode(input.perps?.marginMode),
      leverage: input.perps?.leverage ?? undefined,
      liquidationThresholdPercent:
        input.perps?.liquidationThresholdPercent ?? undefined,
    },
  };
}
