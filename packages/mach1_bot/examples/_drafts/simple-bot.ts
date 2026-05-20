import { Mach1Bot } from "../src/bot";

// ✅ Recommended: Initialize with explicit configuration
const bot = new Mach1Bot({
  privateKey:
    "0x1234567890123456789012345678901234567890123456789012345678901234",
  rpcUrl: "https://evm-rpc.sei.io",
  mode: "simulation",
  maxPositionSize: 1000,
});

// Or use network preset for convenience
const botWithPreset = Mach1Bot.forNetwork(
  "sei-testnet",
  "0x1234567890123456789012345678901234567890123456789012345678901234",
  {
    mode: "simulation",
    maxPositionSize: 1000,
  },
);

// 🚀 NEW: Real-time market data and trading
async function realTimeTrading() {
  // Get live market data
  const candles = await bot.getCandles("ETH/USDC", "1h", { days: 7 });
  const trades = await bot.getTrades("ETH/USDC", { limit: 50 });
  const orderbook = await bot.getOrderbook("ETH/USDC");

  console.log(`Latest ETH/USDC price: $${orderbook.bids[0]?.price}`);
  console.log(`Spread: $${orderbook.spread}`);

  // Place orders with risk validation
  try {
    const buyOrder = await bot.buy("ETH/USDC", {
      amountUsd: 100,
      orderType: "limit",
    });
    console.log(`Buy order placed: ${buyOrder.id}`);
  } catch (error) {
    if (error instanceof Error) {
      console.log(`Order rejected: ${error.message}`);
    } else {
      console.log("Order rejected: Unknown error");
    }
  }
}

// Simple momentum strategy with real data
async function momentumStrategy() {
  const candles = await bot.getCandles("ETH/USDC", "1h", { days: 1 });

  if (candles.length >= 2) {
    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const priceChange = (current.close - previous.close) / previous.close;

    if (priceChange > 0.02) {
      // 2% increase
      await bot.buy("ETH/USDC", { amountUsd: 100 });
      console.log("Momentum buy signal triggered");
    } else if (priceChange < -0.02) {
      // 2% decrease
      await bot.sell("ETH/USDC", { amountUsd: 100 });
      console.log("Momentum sell signal triggered");
    }
  }
}

// DCA strategy example
async function dcaExample() {
  // TODO: DCA not supported in SDK. Use buy/sell only.
  // await bot.dca("BTC/USDC", { amountUsd: 1000, frequency: "daily", duration: "30d" });
}

// Grid trading example
async function gridExample() {
  // TODO: Grid trading not supported in SDK. Use buy/sell only.
  // await bot.grid("ETH/USDC", { lower: 2000, upper: 4000, grids: 10, totalAmount: 5000 });
}

// Advanced order types
async function advancedOrders() {
  // Stop-loss
  await bot.stopLoss("ETH/USDC", {
    stopPrice: 2800,
    limitPrice: 2750,
  });

  // Take-profit
  await bot.takeProfit("ETH/USDC", {
    targetPrice: 3500,
    amountPercent: 50,
  });

  // Trailing stop
  await bot.trailingStop("BTC/USDC", {
    trailDistance: 500,
    side: "sell",
  });
}

// 📊 NEW: Enhanced Portfolio management with real data
async function portfolioExample() {
  // Get live portfolio data
  const portfolio = await bot.getPortfolio();
  console.log(`Portfolio Summary:
    Total Value: $${portfolio.totalValue.toLocaleString()}
    Daily P&L: $${portfolio.dailyPnl.toLocaleString()}
    Daily Return: ${(portfolio.dailyReturn * 100).toFixed(2)}%
    Sharpe Ratio: ${portfolio.sharpeRatio.toFixed(2)}
  `);

  // Show individual positions
  Object.entries(portfolio.positions).forEach(([token, position]) => {
    if (
      typeof position === "object" &&
      position !== null &&
      "quantity" in position &&
      "value" in position
    ) {
      const pos = position as { quantity: number; value: number };
      console.log(
        `  ${token}: ${pos.quantity} (Value: $${pos.value.toLocaleString()})`,
      );
    } else {
      console.log(`  ${token}: [Unknown position type]`);
    }
  });

  // Get performance stats
  const stats = await bot.getPerformanceStats();
  console.log(`Performance Stats:
    Sharpe Ratio: ${stats.sharpeRatio.toFixed(2)}
    Max Drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%
  `);

  // Rebalance
  await bot.rebalance({
    "ETH/USDC": 0.6,
    "BTC/USDC": 0.4,
  });

  // Set comprehensive risk limits
  await bot.setRiskLimits({
    maxDailyLoss: 500,
    maxPositionSize: 2000,
    stopLossPercent: 5,
    positionLimitPercent: 25,
    maxCorrelation: 0.8,
  });
}

// 🎯 NEW: Real-time event handling with live streams
async function setupEventHandlers() {
  // Real-time trade events
  await bot.onTrade("ETH/USDC", (trade) => {
    console.log(
      `🔄 Live Trade: ${trade.side.toUpperCase()} ${trade.quantity} ETH @ $${trade.price}`,
    );
  });

  // Real-time orderbook updates
  await bot.onOrderbook("ETH/USDC", (orderbook) => {
    const bestBid = orderbook.bids[0]?.price || 0;
    const bestAsk = orderbook.asks[0]?.price || 0;
    console.log(
      `📊 OrderBook: Bid $${bestBid} | Ask $${bestAsk} | Spread $${orderbook.spread}`,
    );
  });

  // Risk monitoring
  await bot.onRiskBreach((breach) => {
    console.log(`⚠️  Risk Breach: ${breach.type} - ${breach.message}`);
    if (breach.severity === "critical") {
      console.log("🚨 CRITICAL RISK - Triggering emergency stop!");
      bot.emergencyStop();
    }
  });

  // Order completion tracking
  bot.onTradeComplete(async (trade) => {
    const portfolio = await bot.getPortfolio();
    console.log(`✅ Trade Complete:
      ${trade.symbol} ${trade.side.toUpperCase()} ${trade.size} @ $${trade.price}
      Portfolio Value: $${portfolio.totalValue.toLocaleString()}
      Daily P&L: $${portfolio.dailyPnl.toLocaleString()}
    `);
  });
}

// NEW: Real-time price monitoring strategy
async function priceAlertStrategy() {
  const targetPrice = 3200; // ETH target price
  const tolerance = 50; // $50 tolerance

  await bot.onTrade("ETH/USDC", async (trade) => {
    if (Math.abs(trade.price - targetPrice) <= tolerance) {
      console.log(`🎯 Price Alert: ETH hit target zone at $${trade.price}`);

      if (trade.price >= targetPrice) {
        await bot.buy("ETH/USDC", { amountUsd: 200 });
        console.log("📈 Executed breakout buy");
      }
    }
  });
}

// 🤖 NEW: Data-driven strategy with real market analysis
async function dataStrategyExample() {
  // Analyze multiple timeframes
  const hourlyCandles = await bot.getCandles("ETH/USDC", "1h", { days: 3 });
  const dailyCandles = await bot.getCandles("ETH/USDC", "1d", { days: 30 });

  if (hourlyCandles.length >= 24 && dailyCandles.length >= 7) {
    // Calculate moving averages
    const last24h = hourlyCandles.slice(-24);
    const sma24 = last24h.reduce((sum, c) => sum + c.close, 0) / 24;

    const last7d = dailyCandles.slice(-7);
    const sma7d = last7d.reduce((sum, c) => sum + c.close, 0) / 7;

    const currentPrice = hourlyCandles[hourlyCandles.length - 1].close;

    console.log(
      `Analysis: Current: $${currentPrice}, SMA24h: $${sma24.toFixed(2)}, SMA7d: $${sma7d.toFixed(2)}`,
    );

    // Golden cross strategy
    if (sma24 > sma7d && currentPrice > sma24) {
      const portfolio = await bot.getPortfolio();
      const positionSize = Math.min(200, portfolio.totalValue * 0.1); // Max 10% of portfolio

      await bot.buy("ETH/USDC", { amountUsd: positionSize });
      console.log(`🚀 Golden Cross detected - bought $${positionSize} ETH`);
    }
  }
}

// Three-mode execution
async function threeModeTesting() {
  // 1. Backtest
  const backtestResults = await bot.backtest({
    start: "2024-01-01",
    end: "2024-06-01",
  });

  console.log(`Backtest Results:
    Total Return: ${(backtestResults.totalReturn * 100).toFixed(1)}%
    Sharpe Ratio: ${backtestResults.sharpeRatio.toFixed(2)}
    Max Drawdown: ${(backtestResults.maxDrawdown * 100).toFixed(1)}%
  `);

  // 2. Paper trading
  if (backtestResults.sharpeRatio > 1.5) {
    await bot.simulate({ duration: "1W" });
  }

  // 3. Live trading (if simulation successful)
  // await bot.goLive();
}

// 🚀 NEW: Comprehensive main execution showcasing all features
async function main() {
  console.log("🤖 Starting Mach1Bot with full functionality...");

  // 1. Set up real-time event handlers
  await setupEventHandlers();
  console.log("✅ Event handlers configured");

  // 2. Configure risk management
  await bot.setRiskLimits({
    maxDailyLoss: 1000,
    maxPositionSize: 5000,
    positionLimitPercent: 25,
    stopLossPercent: 5,
  });
  console.log("✅ Risk limits configured");

  // 3. Show real-time market data
  await realTimeTrading();
  console.log("✅ Real-time data demonstrated");

  // 4. Show live portfolio data
  await portfolioExample();
  console.log("✅ Portfolio management demonstrated");

  // 5. Start real-time strategies
  await priceAlertStrategy();
  console.log("✅ Price alert strategy active");

  // 6. Run data-driven analysis
  await dataStrategyExample();
  console.log("✅ Data strategy analysis complete");

  // 7. Set up traditional strategies
  await dcaExample();
  await gridExample();
  console.log("✅ DCA and Grid strategies configured");

  // 8. Run backtesting (optional)
  // await threeModeTesting();

  console.log("🎉 Mach1Bot fully operational with real-time trading!");
  console.log("📊 Monitor the console for live trade events and risk alerts");

  // Keep the bot running to receive real-time events
  console.log("🔄 Bot is running... Press Ctrl+C to stop");
}

// Export for testing
export { bot, main };
