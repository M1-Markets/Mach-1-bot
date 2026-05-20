/// <reference types="node" />
/**
 * Minimal mach1-bot example: construct a bot in simulation mode and place a single buy.
 * Run from the repo root: npx tsx packages/mach1_bot/examples/quickstart.ts
 */
import "dotenv/config";
import { Mach1Bot } from "../src/bot";

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

  const trade = await bot.buy("ETH/USDC", { amountUsd: 100 });
  console.log("Sim buy result:", trade);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
