import { Mach1Bot } from "../src/bot";

// 🚀 Advanced Bot Features Example
// This example showcases the complete suite of bot functionality

const bot = new Mach1Bot({
  privateKey:
    "0x1234567890123456789012345678901234567890123456789012345678901234",
  rpcUrl: "https://evm-rpc.sei.io",
  mode: "simulation",
});

// 📊 Advanced Market Analysis
async function advancedMarketAnalysis() {
  console.log("📊 Advanced Market Analysis Starting...");

  // Multi-timeframe analysis
  const timeframes = ["1h", "4h", "1d"];
  const symbols = ["ETH/USDC", "BTC/USDC"];

  for (const symbol of symbols) {
    console.log(`\n🔍 Analyzing ${symbol}:`);

    for (const timeframe of timeframes) {
      const candles = await bot.getCandles(symbol, timeframe, { days: 30 });
      const trades = await bot.getTrades(symbol, { limit: 100 });
      const orderbook = await bot.getOrderbook(symbol);

      // Calculate technical indicators
      if (candles.length >= 20) {
        const prices = candles.map((c) => c.close);
        const sma20 = prices.slice(-20).reduce((a, b) => a + b) / 20;
        const currentPrice = prices[prices.length - 1];
        const volatility = calculateVolatility(prices.slice(-20));

        console.log(
          `  ${timeframe}: Price $${currentPrice.toFixed(2)} | SMA20 $${sma20.toFixed(2)} | Vol ${(volatility * 100).toFixed(2)}%`,
        );
        console.log(
          `  OrderBook: Spread $${orderbook.spread.toFixed(2)} | Depth ${orderbook.bids.length + orderbook.asks.length}`,
        );
        console.log(
          `  Recent Trades: ${trades.length} | Last Price $${trades[0]?.price.toFixed(2)}`,
        );
      }
    }
  }
}

// 🎯 Advanced Order Management
async function advancedOrderManagement() {
  console.log("\n🎯 Advanced Order Management Demo...");

  try {
    // Demonstrate different order types
    console.log("Testing different order types:");

    // Market order
    const marketOrder = await bot.buy("ETH/USDC", {
      amountUsd: 100,
      orderType: "market",
    });
    console.log(`✅ Market Order: ${marketOrder.id} - ${marketOrder.status}`);

    // Limit order
    const limitOrder = await bot.buy("BTC/USDC", {
      amountUsd: 200,
      orderType: "limit",
    });
    console.log(`✅ Limit Order: ${limitOrder.id} - ${limitOrder.status}`);

    // Advanced order types
    await bot.stopLoss("ETH/USDC", {
      stopPrice: 3000,
      limitPrice: 2950,
    });
    console.log("✅ Stop-Loss order placed");

    await bot.takeProfit("ETH/USDC", {
      targetPrice: 3500,
      amountPercent: 50,
    });
    console.log("✅ Take-Profit order placed");
  } catch (error) {
    if (error instanceof Error) {
      console.log(`❌ Order rejected: ${error.message}`);
    } else {
      console.log("❌ Order rejected: Unknown error");
    }
  }
}

// 🛡️ Comprehensive Risk Management
async function comprehensiveRiskManagement() {
  console.log("\n🛡️ Comprehensive Risk Management...");

  // Set detailed risk limits
  await bot.setRiskLimits({
    maxDailyLoss: 1000, // $1000 max daily loss
    maxPositionSize: 5000, // $5000 max single position
    positionLimitPercent: 25, // 25% max position size
    stopLossPercent: 5, // 5% stop loss
    maxCorrelation: 0.8, // 80% max correlation
    maxDrawdown: 15, // 15% max drawdown
    maxOrderValue: 2000, // $2000 max single order
  });

  console.log("✅ Risk limits configured");

  // Monitor portfolio risk
  const portfolio = await bot.getPortfolio();
  console.log(`Portfolio Risk Assessment:
    Total Value: $${portfolio.totalValue.toLocaleString()}
    Daily P&L: $${portfolio.dailyPnl.toLocaleString()}
    Daily Return: ${(portfolio.dailyReturn * 100).toFixed(2)}%
    Sharpe Ratio: ${portfolio.sharpeRatio.toFixed(2)}
  `);

  // Test risk breach handling
  await bot.onRiskBreach(async (breach) => {
    console.log(`⚠️  Risk Breach Detected:
      Type: ${breach.type}
      Severity: ${breach.severity}
      Message: ${breach.message}
      Timestamp: ${new Date(breach.timestamp).toISOString()}
    `);

    if (breach.severity === "critical") {
      console.log("🚨 CRITICAL BREACH - Triggering emergency procedures");
      await bot.emergencyStop();
    }
  });
}

// 📈 Real-time Strategy Implementation
async function realTimeStrategy() {
  console.log("\n📈 Real-time Strategy Implementation...");

  let tradeCount = 0;
  let lastPrice = 0;

  // Real-time momentum strategy
  await bot.onTrade("ETH/USDC", async (trade) => {
    tradeCount++;
    const priceChange =
      lastPrice > 0 ? (trade.price - lastPrice) / lastPrice : 0;

    console.log(
      `🔄 Trade #${tradeCount}: ${trade.side.toUpperCase()} ${trade.quantity} @ $${trade.price} (${(priceChange * 100).toFixed(2)}%)`,
    );

    // Momentum threshold: 1% price movement
    if (Math.abs(priceChange) > 0.01) {
      try {
        if (priceChange > 0.01) {
          // Strong upward momentum
          const order = await bot.buy("ETH/USDC", { amountUsd: 150 });
          console.log(`📈 Momentum BUY triggered: ${order.id}`);
        } else if (priceChange < -0.01) {
          // Strong downward momentum
          const order = await bot.sell("ETH/USDC", { amountUsd: 150 });
          console.log(`📉 Momentum SELL triggered: ${order.id}`);
        }
      } catch (error) {
        if (error instanceof Error) {
          console.log(`❌ Momentum trade rejected: ${error.message}`);
        } else {
          console.log("❌ Momentum trade rejected: Unknown error");
        }
      }
    }

    lastPrice = trade.price;
  });

  // Real-time orderbook strategy
  await bot.onOrderbook("ETH/USDC", async (orderbook) => {
    const spread = orderbook.spread;
    const midPrice = (orderbook.bids[0]?.price + orderbook.asks[0]?.price) / 2;

    // Large spread opportunity (> 0.5%)
    if (spread / midPrice > 0.005) {
      console.log(
        `💰 Large Spread Detected: $${spread.toFixed(2)} (${((spread / midPrice) * 100).toFixed(2)}%)`,
      );
      // Could implement market making strategy here
    }
  });
}

// 🤖 Multi-Asset Portfolio Strategy
async function multiAssetStrategy() {
  console.log("\n🤖 Multi-Asset Portfolio Strategy...");

  const assets = ["ETH/USDC", "BTC/USDC"];
  const correlationData: Record<string, number[]> = {};

  // Collect price data for correlation analysis
  for (const asset of assets) {
    const candles = await bot.getCandles(asset, "1h", { days: 7 });
    correlationData[asset] = candles.map((c) => c.close);

    console.log(`${asset} - ${candles.length} data points collected`);
  }

  // Calculate correlation (simplified)
  const ethPrices = correlationData["ETH/USDC"];
  const btcPrices = correlationData["BTC/USDC"];

  if (ethPrices.length > 0 && btcPrices.length > 0) {
    const correlation = calculateCorrelation(ethPrices, btcPrices);
    console.log(`ETH-BTC Correlation: ${(correlation * 100).toFixed(1)}%`);

    // Portfolio allocation based on correlation
    if (correlation < 0.5) {
      // Low correlation - can hold both assets
      await bot.rebalance({
        "ETH/USDC": 0.5,
        "BTC/USDC": 0.5,
      });
      console.log("✅ Balanced allocation due to low correlation");
    } else {
      // High correlation - focus on stronger performer
      const ethReturn =
        (ethPrices[ethPrices.length - 1] - ethPrices[0]) / ethPrices[0];
      const btcReturn =
        (btcPrices[btcPrices.length - 1] - btcPrices[0]) / btcPrices[0];

      if (ethReturn > btcReturn) {
        await bot.rebalance({ "ETH/USDC": 0.8, "BTC/USDC": 0.2 });
        console.log("✅ ETH-heavy allocation due to better performance");
      } else {
        await bot.rebalance({ "ETH/USDC": 0.2, "BTC/USDC": 0.8 });
        console.log("✅ BTC-heavy allocation due to better performance");
      }
    }
  }
}

// 🔍 Performance Analytics
async function performanceAnalytics() {
  console.log("\n🔍 Performance Analytics...");

  const stats = await bot.getPerformanceStats();
  const portfolio = await bot.getPortfolio();

  console.log(`📊 Performance Metrics:
    Sharpe Ratio: ${stats.sharpeRatio.toFixed(2)}
    Max Drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%
    Total Value: $${portfolio.totalValue.toLocaleString()}
    Daily Return: ${(portfolio.dailyReturn * 100).toFixed(2)}%
  `);

  // Position breakdown
  console.log("\n📈 Position Breakdown:");
  Object.entries(portfolio.positions).forEach(([token, position]) => {
    // Defensive: position may be unknown type
    if (
      typeof position === "object" &&
      position !== null &&
      "value" in position &&
      "unrealizedPnl" in position
    ) {
      const pos = position as { value: number; unrealizedPnl: number };
      const allocation = ((pos.value / portfolio.totalValue) * 100).toFixed(1);
      console.log(
        `  ${token}: $${pos.value.toLocaleString()} (${allocation}%) - P&L: $${pos.unrealizedPnl.toLocaleString()}`,
      );
    } else {
      console.log(`  ${token}: [Unknown position type]`);
    }
  });

  // Risk heatmap
  const riskHeatmap = await bot.getRiskHeatmap();
  console.log("\n🌡️  Risk Heatmap:");
  console.log(riskHeatmap.display());
}

// Utility functions
function calculateVolatility(prices: number[]): number {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance =
    returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) /
    returns.length;
  return Math.sqrt(variance);
}

function calculateCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  const sumX = x.slice(0, n).reduce((a, b) => a + b);
  const sumY = y.slice(0, n).reduce((a, b) => a + b);
  const sumXY = x.slice(0, n).reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.slice(0, n).reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.slice(0, n).reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
  );

  return denominator === 0 ? 0 : numerator / denominator;
}

// 🚀 Main execution function
async function main() {
  console.log("🚀 Advanced Mach1Bot Features Demo Starting...\n");

  try {
    // 1. Market Analysis
    await advancedMarketAnalysis();

    // 2. Order Management
    await advancedOrderManagement();

    // 3. Risk Management
    await comprehensiveRiskManagement();

    // 4. Real-time Strategy
    await realTimeStrategy();

    // 5. Multi-Asset Strategy
    await multiAssetStrategy();

    // 6. Performance Analytics
    await performanceAnalytics();

    console.log("\n🎉 All advanced features demonstrated successfully!");
    console.log("📊 Bot is now running with real-time strategies...");
    console.log("🔄 Monitor console for live updates. Press Ctrl+C to stop.");

    // Keep running for real-time events
    setInterval(() => {
      // Keep alive
    }, 1000);
  } catch (error) {
    if (error instanceof Error) {
      console.error("❌ Error during execution:", error.message);
    } else {
      console.error("❌ Error during execution: Unknown error");
    }
    await bot.emergencyStop();
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down bot gracefully...");
  await bot.emergencyStop();
  process.exit(0);
});

// Export for testing
export { bot, main };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
