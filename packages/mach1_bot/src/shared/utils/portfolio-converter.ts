import type { SdkPortfolio } from "@/shared/types";
import type { Portfolio as BotPortfolio } from "@/shared/types/bot";
import type { Portfolio as CommonPortfolio } from "@/shared/types/common";

export function commonToSdkPortfolio(
  core: CommonPortfolio,
  summary: { dailyPnL: bigint },
  perfMetrics: { sharpeRatio: number },
): SdkPortfolio {
  const positions: SdkPortfolio["positions"] = {};
  for (const [token, pos] of core.positions.entries()) {
    positions[token] = {
      symbol: token,
      balance: Number(pos.balance),
      value: Number(pos.value) / 100,
      unrealizedPnl: Number(pos.unrealizedPnL) / 100,
    };
  }

  return {
    totalValue: Number(core.totalValue) / 100,
    dailyPnl: Number(summary.dailyPnL) / 100,
    dailyReturn:
      Number(summary.dailyPnL) / Number(core.totalValue || BigInt(1)),
    sharpeRatio: perfMetrics.sharpeRatio,
    positions,
  };
}

export function botToSdkPortfolio(bot: BotPortfolio): SdkPortfolio {
  const positions: SdkPortfolio["positions"] = {};
  for (const [symbol, p] of Object.entries(bot.positions || {})) {
    positions[symbol] = {
      symbol,
      balance: Number(p.balance),
      value: Number(p.value),
      unrealizedPnl: Number(p.unrealizedPnl),
    };
  }

  return {
    totalValue: Number(bot.totalValue),
    dailyPnl: Number(bot.dailyPnl),
    dailyReturn: Number(bot.dailyReturn),
    sharpeRatio: bot.sharpeRatio,
    positions,
  };
}

export default { commonToSdkPortfolio, botToSdkPortfolio };
