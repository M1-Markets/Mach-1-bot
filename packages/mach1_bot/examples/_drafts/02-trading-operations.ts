/**
 * Trading Operations Examples
 *
 * Complete guide to all trading operations available in the Mach-One SDK.
 * Covers basic trades, advanced orders, order management, and more.
 */
import { Mach1Bot } from "../src/bot";

// Initialize bot for examples
const bot = Mach1Bot.forNetwork(
  "sei-testnet",
  "0x1234567890123456789012345678901234567890123456789012345678901234",
  { mode: "simulation", maxPositionSize: 5000 },
);

// 🛒 Basic Buy Operations
async function basicBuyOperations() {
  console.log("💰 Basic Buy Operations\n");

  // Only supported: Buy with USD amount
  const buyUsd = await bot.buy("ETH/USDC", {
    amountUsd: 1000, // Buy $1000 worth of ETH
  });
  console.log("✅ Buy $1000 ETH:", buyUsd.id);

  // TODO: Buy with token amount (not supported)
  // TODO: Buy with percentage of portfolio (not supported)
  // TODO: Buy with slippage protection (not supported)

  return { buyUsd };
}

// 🏪 Basic Sell Operations
async function basicSellOperations() {
  console.log("💸 Basic Sell Operations\n");

  // Only supported: Sell with USD amount
  const sellUsd = await bot.sell("ETH/USDC", {
    amountUsd: 800, // Sell $800 worth of ETH
  });
  console.log("✅ Sell $800 ETH:", sellUsd.id);

  // TODO: Sell with token amount (not supported)
  // TODO: Sell percentage of position (not supported)
  // TODO: Sell all of a position (not supported)

  return { sellUsd };
}

// 🎯 Advanced Order Types
async function advancedOrderTypes() {
  console.log("🎯 Advanced Order Types\n");

  // Supported: Stop Loss Orders
  const stopLoss = await bot.stopLoss("ETH/USDC", {
    stopPrice: 2800, // Trigger at $2800
    limitPrice: 2750, // Execute at $2750 or better
  });
  console.log("✅ Stop Loss placed:", stopLoss.id);

  // Supported: Take Profit Orders
  const takeProfit = await bot.takeProfit("ETH/USDC", {
    targetPrice: 3500, // Target $3500
    amountPercent: 50, // 50% of position
  });
  console.log("✅ Take Profit placed:", takeProfit.id);

  // Supported: Trailing Stop Orders
  const trailingStop = await bot.trailingStop("BTC/USDC", {
    trailDistance: 500, // $500 trail distance
    side: "sell",
    amountPercent: 100,
  });
  console.log("✅ Trailing Stop placed:", trailingStop.id);

  // TODO: OCO (One-Cancels-Other) Orders (not supported)
  // TODO: Iceberg Orders (not supported)

  return { stopLoss, takeProfit, trailingStop };
}

// 📋 Order Management
async function orderManagement() {
  console.log("📋 Order Management\n");
  // TODO: Order management methods (get/cancel/modify orders) not supported in SDK
}

// 🔄 Market vs Limit Orders
async function marketVsLimitOrders() {
  console.log("🔄 Market vs Limit Orders\n");
  // TODO: Market, limit, and post-only order methods not supported in SDK
}

// ⏰ Time-Based Orders
async function timeBasedOrders() {
  console.log("⏰ Time-Based Orders\n");
  // TODO: Scheduled, recurring, and TWAP order methods not supported in SDK
}

// 🌊 Liquidity and Slippage Management
async function liquidityAndSlippage() {
  console.log("🌊 Liquidity and Slippage Management\n");
  // TODO: Liquidity, slippage, smart order, and VWAP order methods not supported in SDK
}

// 📊 Order Analytics and Reporting
async function orderAnalytics() {
  console.log("📊 Order Analytics and Reporting\n");
  // TODO: Order analytics and reporting methods not supported in SDK
}

// 🚨 Emergency Controls
async function emergencyControls() {
  console.log("🚨 Emergency Controls\n");
  // TODO: Emergency controls and risk check methods not supported in SDK
}

// 🎯 Main Demo Function
async function main() {
  console.log("🎯 Mach-One SDK - Trading Operations Examples\n");

  try {
    // Run through all trading examples
    await basicBuyOperations();
    console.log("\n" + "=".repeat(50) + "\n");

    await basicSellOperations();
    console.log("\n" + "=".repeat(50) + "\n");

    await advancedOrderTypes();
    console.log("\n" + "=".repeat(50) + "\n");

    await orderManagement();
    console.log("\n" + "=".repeat(50) + "\n");

    await marketVsLimitOrders();
    console.log("\n" + "=".repeat(50) + "\n");

    await timeBasedOrders();
    console.log("\n" + "=".repeat(50) + "\n");

    await liquidityAndSlippage();
    console.log("\n" + "=".repeat(50) + "\n");

    await orderAnalytics();
    console.log("\n" + "=".repeat(50) + "\n");

    await emergencyControls();

    console.log("\n✅ All trading operation examples completed!");
  } catch (error) {
    console.error("❌ Error in trading operations:", error);
  }
}

// Export all functions for use in other files
export {
  advancedOrderTypes,
  basicBuyOperations,
  basicSellOperations,
  emergencyControls,
  liquidityAndSlippage,
  main,
  marketVsLimitOrders,
  orderAnalytics,
  orderManagement,
  timeBasedOrders,
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
