/// <reference types="node" />
/**
 * mach1-bot example: run a basic backtest over a 2-month window and print summary stats.
 * Run from the repo root: npx tsx packages/mach1_bot/examples/with-backtest.ts
 */
import "dotenv/config";
import { Mach1Bot, MarketData } from "../src/bot";

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.SEI_RPC_URL;

  if (!privateKey) {
    throw new Error("PRIVATE_KEY is not set in .env");
  }
  if (!rpcUrl) {
    throw new Error("SEI_RPC_URL is not set in .env");
  }

  const bot = Mach1Bot.forNetwork("sei-testnet", privateKey, {
    rpcUrl,
    mode: "simulation",
  });

  // The backtest engine drives the strategy callback on each bar.
  bot.strategy(async (marketData: MarketData) => {
    const eth = marketData["ETH/USDC"];
    if (!eth) return;

    if (eth.rsi < 30) {
      await bot.buy("ETH/USDC", { amountUsd: 200 });
    } else if (eth.rsi > 70) {
      await bot.sell("ETH/USDC", { amountUsd: 200 });
    }
  });

  const results = await bot.backtest({
    start: "2024-01-01",
    end: "2024-03-01",
    initialCapital: 10000,
  });

  console.log("Backtest results:");
  console.log(`  totalReturn:  ${(results.totalReturn * 100).toFixed(2)}%`);
  console.log(`  sharpeRatio:  ${results.sharpeRatio.toFixed(2)}`);
  console.log(`  maxDrawdown:  ${(results.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  winRate:      ${(results.winRate * 100).toFixed(2)}%`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
