/// <reference types="node" />
/**
 * mach1-bot example: register a simple RSI strategy callback and log completed trades.
 * Run from the repo root: npx tsx packages/mach1_bot/examples/with-strategy.ts
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

  // Simple RSI strategy: buy oversold, sell overbought.
  bot.strategy(async (marketData: MarketData) => {
    const eth = marketData["ETH/USDC"];
    if (!eth) return;

    if (eth.rsi < 30) {
      await bot.buy("ETH/USDC", { amountUsd: 100 });
    } else if (eth.rsi > 70) {
      await bot.sell("ETH/USDC", { amountUsd: 100 });
    }
  });

  bot.onTradeComplete((trade: any) => {
    console.log(
      `Trade complete: ${trade.symbol} ${trade.side} $${trade.value}`,
    );
  });

  // Kick off with a single sim buy so you can see the wiring without waiting
  // for market data ticks.
  const trade = await bot.buy("ETH/USDC", { amountUsd: 100 });
  console.log("Initial sim buy:", trade);

  // Strategy callbacks fire on market-data ticks. Without an active wait,
  // this script exits before any ticks arrive. Hold the process open for
  // a window so the strategy has a chance to run.
  const WATCH_SECONDS = 30;
  console.log(
    `Watching market for ${WATCH_SECONDS}s. RSI strategy will fire on incoming ticks. Ctrl+C to stop early.`,
  );
  await new Promise((resolve) => setTimeout(resolve, WATCH_SECONDS * 1000));
  console.log("Watch window ended. In production code, run an event loop or SIGINT handler.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
