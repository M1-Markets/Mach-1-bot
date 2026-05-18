/**
 * Mach-One SDK Examples Index
 *
 * Complete collection of examples demonstrating every feature of the Mach-One SDK.
 * Start here to explore the full capabilities of the SDK.
 */

// Import all example modules

// Explicit named exports to avoid duplicate 'main' export errors
export { main as gettingStartedMain } from "./01-getting-started";
export {
  basicBuyOperations,
  main as tradingOpsMain,
} from "./02-trading-operations";
export {
  dcaStrategies,
  main as strategyExamplesMain,
} from "./03-strategy-examples";
export { main as riskAnalyticsMain } from "./04-risk-management-analytics";
export { main as advancedTradingMain } from "./05-backtesting-live-trading";
export { main as monacoIntegrationMain } from "./06-monaco-protocol-integration";
// Legacy examples (maintained for backwards compatibility)
// simple-bot does not export simpleBotMain, so skip this export.
export * from "./better-configuration";
export * from "./monaco-compatibility";

/**
 * 📚 EXAMPLE GUIDE
 *
 * This index provides access to all Mach-One SDK examples, organized by complexity and use case.
 * Each example file contains multiple detailed examples with full documentation.
 *
 * 🎯 RECOMMENDED LEARNING PATH:
 *
 * 1. **Getting Started** (01-getting-started.ts)
 *    - Quick setup and basic usage
 *    - First trades and portfolio checks
 *    - Simple strategies and backtesting
 *
 * 2. **Trading Operations** (02-trading-operations.ts)
 *    - All types of buy/sell operations
 *    - Advanced order types (stop-loss, take-profit, trailing stops)
 *    - Order management and analytics
 *
 * 3. **Strategy Examples** (03-strategy-examples.ts)
 *    - DCA (Dollar-Cost Averaging) strategies
 *    - Grid trading strategies
 *    - Portfolio management
 *    - Custom algorithmic strategies
 *
 * 4. **Risk Management & Analytics** (04-risk-management-analytics.ts)
 *    - Risk controls and limits
 *    - Portfolio analytics and performance metrics
 *    - Visualization and reporting
 *    - Advanced risk analytics
 *
 * 5. **Advanced Trading** (05-backtesting-live-trading.ts)
 *    - Comprehensive backtesting
 *    - Paper trading validation
 *    - Live trading setup
 *    - AI-powered trading
 *
 * 6. **Monaco Protocol Integration** (06-monaco-protocol-integration.ts)
 *    - Direct Monaco Protocol SDK usage
 *    - Low-level trading operations
 *    - Event streaming and WebSockets
 *    - Integration patterns
 *
 * 🚀 QUICK START EXAMPLES:
 */

import { quickStart } from "./01-getting-started";
import { basicBuyOperations } from "./02-trading-operations";
import { dcaStrategies } from "./03-strategy-examples";

/**
 * Run the most essential examples to get started quickly
 */
export async function runQuickStartExamples() {
  console.log("🚀 Running Quick Start Examples...\n");

  try {
    // 1. Basic setup and first trade
    console.log("1️⃣ Getting Started...");
    await quickStart();

    // 2. Basic trading operations
    console.log("\n2️⃣ Basic Trading...");
    await basicBuyOperations();

    // 3. Simple DCA strategy
    console.log("\n3️⃣ DCA Strategy...");
    await dcaStrategies();

    console.log("\n✅ Quick start examples completed!");
    console.log("🎓 Ready to explore more advanced features!");
  } catch (error) {
    console.error("❌ Error in quick start:", error);
  }
}

/**
 * 📋 COMPLETE FEATURE COVERAGE
 *
 * The examples in this directory cover 100% of SDK functionality:
 *
 * 🤖 BOT FEATURES:
 * ✅ Bot initialization and configuration
 * ✅ Network presets and custom networks
 * ✅ Environment variable configuration
 * ✅ Builder pattern configuration
 *
 * 💰 TRADING OPERATIONS:
 * ✅ Market orders (buy/sell)
 * ✅ Limit orders with various time-in-force options
 * ✅ Stop-loss and take-profit orders
 * ✅ Trailing stops and OCO orders
 * ✅ Iceberg orders for large trades
 * ✅ Time-weighted average price (TWAP) orders
 * ✅ Volume-weighted average price (VWAP) orders
 * ✅ Post-only orders (maker-only)
 * ✅ IOC (Immediate-or-Cancel) orders
 * ✅ FOK (Fill-or-Kill) orders
 * ✅ Scheduled and recurring orders
 *
 * 📊 STRATEGIES:
 * ✅ Dollar-Cost Averaging (DCA)
 * ✅ Grid trading (neutral, directional, infinite)
 * ✅ Portfolio rebalancing and allocation
 * ✅ Momentum strategies
 * ✅ Mean reversion strategies
 * ✅ Risk parity portfolios
 * ✅ Multi-timeframe strategies
 * ✅ Custom algorithmic strategies
 * ✅ Machine learning strategies
 * ✅ Sentiment-based strategies
 *
 * 🛡️ RISK MANAGEMENT:
 * ✅ Position sizing models
 * ✅ Risk limits and controls
 * ✅ Real-time risk monitoring
 * ✅ Value at Risk (VaR) calculations
 * ✅ Stress testing and scenario analysis
 * ✅ Drawdown management
 * ✅ Correlation analysis
 * ✅ Emergency controls and circuit breakers
 *
 * 📈 ANALYTICS:
 * ✅ Portfolio performance metrics
 * ✅ Trade execution analytics
 * ✅ Risk-adjusted returns
 * ✅ Attribution analysis
 * ✅ Rolling performance analysis
 * ✅ Benchmark comparisons
 * ✅ Factor analysis
 * ✅ Market regime detection
 *
 * 📊 VISUALIZATION:
 * ✅ Equity curve charts
 * ✅ Drawdown charts
 * ✅ P&L distribution histograms
 * ✅ Risk heatmaps
 * ✅ Performance dashboards
 * ✅ HTML report generation
 * ✅ Chart exports (PNG, SVG, etc.)
 *
 * 🧪 BACKTESTING:
 * ✅ Historical backtesting with realistic costs
 * ✅ Walk-forward analysis
 * ✅ Monte Carlo simulations
 * ✅ Parameter optimization
 * ✅ Multi-strategy backtesting
 * ✅ Cross-validation techniques
 *
 * 📄 PAPER TRADING:
 * ✅ Real-time simulation
 * ✅ Accelerated simulation
 * ✅ Realistic order execution
 * ✅ Slippage and latency modeling
 * ✅ Market impact simulation
 *
 * 🔴 LIVE TRADING:
 * ✅ Live trading setup and configuration
 * ✅ Enhanced risk controls for live trading
 * ✅ Real-time monitoring and alerting
 * ✅ Emergency stop mechanisms
 * ✅ Order validation and checks
 * ✅ Live trading dashboard
 *
 * 🤖 AI INTEGRATION:
 * ✅ AI-powered market analysis
 * ✅ Automated decision making
 * ✅ Sentiment analysis integration
 * ✅ Continuous learning and improvement
 * ✅ Multiple AI provider support
 *
 * 🏛️ MONACO PROTOCOL:
 * ✅ Direct SDK integration
 * ✅ Low-level trading operations
 * ✅ Batch operations
 * ✅ Real-time market data
 * ✅ Event streaming and WebSockets
 * ✅ Account management
 * ✅ Utility functions and formatting
 *
 * 🔧 CONFIGURATION:
 * ✅ Network configurations
 * ✅ Risk parameter settings
 * ✅ API key management
 * ✅ Environment-based configuration
 * ✅ Configuration validation
 * ✅ Hot-reload configuration updates
 *
 * 📱 MONITORING & ALERTS:
 * ✅ Real-time performance monitoring
 * ✅ Risk breach alerts
 * ✅ Trade execution notifications
 * ✅ Multi-channel alerting (email, webhook, Slack)
 * ✅ Custom alert conditions
 * ✅ Dashboard and web interface
 *
 * 💾 DATA EXPORT:
 * ✅ Trade history export (CSV, JSON)
 * ✅ Performance report generation
 * ✅ Chart image exports
 * ✅ Raw data access
 * ✅ Custom data formatting
 */

/**
 * Run all examples in sequence (for comprehensive testing)
 */
export async function runAllExamples() {
  console.log("🎯 Running ALL Mach-One SDK Examples...\n");
  console.log("⚠️ This will take several minutes to complete.\n");

  try {
    const { main: gettingStarted } = await import("./01-getting-started");
    const { main: tradingOps } = await import("./02-trading-operations");
    const { main: strategies } = await import("./03-strategy-examples");
    const { main: riskAnalytics } = await import(
      "./04-risk-management-analytics"
    );
    const { main: advancedTrading } = await import(
      "./05-backtesting-live-trading"
    );
    const { main: monacoIntegration } = await import(
      "./06-monaco-protocol-integration"
    );

    console.log("📚 1/6 - Getting Started Examples...");
    await gettingStarted();

    console.log("\n📚 2/6 - Trading Operations Examples...");
    await tradingOps();

    console.log("\n📚 3/6 - Strategy Examples...");
    await strategies();

    console.log("\n📚 4/6 - Risk Management & Analytics Examples...");
    await riskAnalytics();

    console.log("\n📚 5/6 - Advanced Trading Examples...");
    await advancedTrading();

    console.log("\n📚 6/6 - Monaco Protocol Integration Examples...");
    await monacoIntegration();

    console.log("\n🎉 ALL EXAMPLES COMPLETED SUCCESSFULLY!");
    console.log("🏆 You have now seen every feature of the Mach-One SDK!");
  } catch (error) {
    console.error("❌ Error running examples:", error);
  }
}

/**
 * Example categories for easy navigation
 */
export const ExampleCategories = {
  BEGINNER: ["01-getting-started", "02-trading-operations (basic sections)"],

  INTERMEDIATE: [
    "02-trading-operations (advanced sections)",
    "03-strategy-examples",
    "04-risk-management-analytics",
  ],

  ADVANCED: ["05-backtesting-live-trading", "06-monaco-protocol-integration"],

  BY_FEATURE: {
    TRADING: "02-trading-operations",
    STRATEGIES: "03-strategy-examples",
    RISK_MANAGEMENT: "04-risk-management-analytics",
    BACKTESTING: "05-backtesting-live-trading",
    LIVE_TRADING: "05-backtesting-live-trading",
    MONACO_PROTOCOL: "06-monaco-protocol-integration",
  },
};

// Export utility for running specific example categories
export { runAllExamples as runAll, runQuickStartExamples as quickStart };

// Make this the default export for easy importing
export default {
  quickStart: runQuickStartExamples,
  runAll: runAllExamples,
  categories: ExampleCategories,
};
