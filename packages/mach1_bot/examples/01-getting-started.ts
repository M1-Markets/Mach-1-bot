/// <reference types="node" />
/**
 * Getting Started with Mach-One SDK
 *
 * This example shows the absolute basics of setting up and using the SDK.
 * Perfect for beginners who want to get started quickly.
 */
import { Mach1Bot, MarketData } from "../src/bot";

// 🚀 Quick Start - Minimal Setup
async function quickStart() {
  // Option 1: Use network preset (easiest)
  const bot = Mach1Bot.forNetwork(
    "sei-testnet", // Network
    "0x1234567890123456789012345678901234567890123456789012345678901234", // Private key
    { mode: "simulation" }, // Safe simulation mode
  );

  // Your first trade!
  const trade = await bot.buy("ETH/USDC", { amountUsd: 100 });
  console.log("✅ First trade placed:", trade);

  return bot;
}

// 📝 Manual Configuration Setup
async function manualSetup() {
  const bot = new Mach1Bot({
    // Required fields
    privateKey:
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    rpcUrl: "https://evm-rpc-testnet.sei.io",

    // Optional fields with defaults
    mode: "simulation", // 'simulation' | 'paper' | 'live'
    maxPositionSize: 1000, // Max $1000 per position
    maxDailyLoss: 500, // Max $500 daily loss
    logLevel: "info", // 'debug' | 'info' | 'warn' | 'error'
  });

  return bot;
}

// 🔧 Builder Pattern Setup (Fluent API)
async function builderSetup() {
  const bot = Mach1Bot.builder()
    .withPrivateKey(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    )
    .withNetwork("sei-testnet")
    .withMode("simulation")
    .withRiskLimits(2000, 800) // maxPosition, maxDailyLoss
    .build();

  return bot;
}

// 🌐 Multi-Network Setup
async function multiNetworkSetup() {
  // Testnet bot for development
  const testBot = Mach1Bot.forNetwork(
    "sei-testnet",
    process.env.TEST_PRIVATE_KEY!,
  );
  // Mainnet bot for production
  const mainBot = Mach1Bot.forNetwork(
    "sei-mainnet",
    process.env.MAIN_PRIVATE_KEY!,
    {
      mode: "live",
      maxPositionSize: 10000,
    },
  );
  return { testBot, mainBot };
}

// 📊 Basic Portfolio Check
async function basicPortfolioCheck() {
  const bot = await quickStart();

  // Get current portfolio
  const portfolio = await bot.getPortfolio();

  console.log(`
    💰 Portfolio Summary:
    Total Value: $${portfolio.totalValue.toLocaleString()}
    Daily P&L: $${portfolio.dailyPnl.toLocaleString()}
    Daily Return: ${(portfolio.dailyReturn * 100).toFixed(2)}%
    Open Positions: ${Object.keys(portfolio.positions).length}
  `);

  return portfolio;
}

// 🎯 Simple Strategy Example
async function simpleStrategy() {
  const bot = await quickStart();

  // Simple RSI-based strategy
  bot.strategy(async (marketData: MarketData) => {
    const ethData = marketData["ETH/USDC"];
    // Buy when oversold (RSI < 30)
    if (ethData.rsi < 30) {
      await bot.buy("ETH/USDC", { amountUsd: 100 });
      console.log("📈 Bought ETH - RSI oversold");
    }
    // Sell when overbought (RSI > 70)
    if (ethData.rsi > 70) {
      await bot.sell("ETH/USDC", { amountUsd: 100 });
      console.log("📉 Sold ETH - RSI overbought");
    }
  });

  return bot;
}

// 🔔 Event Handling Basics
async function basicEventHandling() {
  const bot = await quickStart();

  // Listen for trade completions
  bot.onTradeComplete((trade: any) => {
    console.log(
      `✅ Trade completed: ${trade.symbol} ${trade.side} $${trade.value}`,
    );
  });
  // Listen for risk breaches
  bot.onRiskBreach((breach: any) => {
    console.log(`⚠️ Risk breach: ${breach.type} - ${breach.message}`);
    if (breach.severity === "critical") {
      console.log("🛑 Critical breach - stopping all trading");
      bot.emergencyStop();
    }
  });
  // Listen for market data updates
  bot.onTrade("ETH/USDC", (tradeData: any) => {
    console.log(
      `📊 ETH/USDC: $${tradeData.price} (${tradeData.volume} volume)`,
    );
  });

  return bot;
}

// 📈 First Backtest
async function firstBacktest() {
  const bot = await quickStart();

  // Add a simple strategy
  bot.strategy(async (data: MarketData) => {
    if (data["BTC/USDC"].rsi < 35) {
      await bot.buy("BTC/USDC", { amountUsd: 500 });
    } else if (data["BTC/USDC"].rsi > 65) {
      await bot.sell("BTC/USDC", { amountUsd: 500 });
    }
  });

  // Run backtest
  const results = await bot.backtest({
    start: "2024-01-01",
    end: "2024-03-01",
    initialCapital: 10000,
  });

  console.log(`
    📊 Backtest Results (2 months):
    Total Return: ${(results.totalReturn * 100).toFixed(1)}%
    Sharpe Ratio: ${results.sharpeRatio.toFixed(2)}
    Max Drawdown: ${(results.maxDrawdown * 100).toFixed(1)}%
    Total Trades: ${results.totalTrades}
    Win Rate: ${(results.winRate * 100).toFixed(1)}%
  `);

  // Generate visual reports
  await results.plotEquityCurve();
  await results.plotDrawdown();
  await results.exportTrades("backtest-trades.csv");
  console.log("📊 Charts and data exported!");

  return results;
}

// 🎮 Three-Mode Testing Pipeline
async function threeModeTestPipeline() {
  const bot = await quickStart();

  // Add strategy
  bot.strategy(async (data: MarketData) => {
    const ethData = data["ETH/USDC"];
    if (ethData.rsi < 30) await bot.buy("ETH/USDC", { amountUsd: 200 });
    if (ethData.rsi > 70) await bot.sell("ETH/USDC", { amountUsd: 200 });
  });

  console.log("🔄 Starting 3-mode testing pipeline...\n");

  // Phase 1: Backtest
  console.log("📈 Phase 1: Backtesting...");
  const backtestResults = await bot.backtest({
    start: "2024-01-01",
    end: "2024-06-01",
  });

  console.log(
    `Backtest: ${(backtestResults.totalReturn * 100).toFixed(1)}% return`,
  );

  // Phase 2: Paper Trading (if backtest looks good)
  if (backtestResults.sharpeRatio > 1.0) {
    console.log("✅ Backtest passed! Starting paper trading...");

    await bot.simulate({
      duration: "1W", // 1 week simulation
    });

    console.log("📄 Paper trading complete!");

    // Phase 3: Live Trading (manual decision)
    console.log("🤔 Ready for live trading? (Manual decision required)");
    // await bot.goLive(); // Uncomment when ready!
  } else {
    console.log("❌ Backtest failed. Sharpe ratio too low.");
  }
}

// 🎯 Main Demo Function
async function main() {
  console.log("🚀 Mach-One SDK - Getting Started Examples\n");

  try {
    // Run through all examples
    console.log("1️⃣ Quick start...");
    await quickStart();

    console.log("2️⃣ Portfolio check...");
    await basicPortfolioCheck();

    console.log("3️⃣ Event handling...");
    await basicEventHandling();

    console.log("4️⃣ First backtest...");
    await firstBacktest();

    console.log("5️⃣ Three-mode pipeline...");
    await threeModeTestPipeline();

    console.log("\n✅ All examples completed successfully!");
  } catch (error) {
    console.error("❌ Error running examples:", error);
  }
}

// Export for use in other files
export {
  basicEventHandling,
  basicPortfolioCheck,
  builderSetup,
  firstBacktest,
  main,
  manualSetup,
  multiNetworkSetup,
  quickStart,
  simpleStrategy,
  threeModeTestPipeline,
};

// Run if called directly
// Node.js entrypoint compatibility
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch(console.error);
}
