// ✅ BETTER: Direct Configuration Examples
import { Mach1Bot } from "../src/bot";

// Example 1: Direct Configuration (Recommended)
async function directConfigurationExample() {
  const bot = new Mach1Bot({
    // Required: Authentication
    privateKey:
      "0x1234567890123456789012345678901234567890123456789012345678901234",

    // Required: Network
    rpcUrl: "https://evm-rpc.sei.io",

    // Optional: Additional settings
    mode: "simulation",
    maxPositionSize: 1000,
    maxDailyLoss: 500,
    chainId: 1329,
  });

  // Use the bot
  await bot.buy("ETH/USDC", { amountUsd: 100 });
}

// Example 2: Network Preset (Convenient)
async function networkPresetExample() {
  const bot = Mach1Bot.forNetwork(
    "sei-mainnet",
    "0x1234567890123456789012345678901234567890123456789012345678901234",
    {
      mode: "simulation",
      maxPositionSize: 2000,
    },
  );

  // TODO: DCA not supported in SDK. Use buy/sell only.
  // await bot.dca("BTC/USDC", { amountUsd: 1000, frequency: "daily", duration: "30d" });
}

// Example 3: Configuration Builder (Fluent)
async function configBuilderExample() {
  const bot = Mach1Bot.builder()
    .withPrivateKey(
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    )
    .withNetwork("sei-testnet")
    .withMode("simulation")
    .withRiskLimits(1500, 300)
    .build();

  // TODO: Grid trading not supported in SDK. Use buy/sell only.
  // await bot.grid("ETH/USDC", { lower: 2800, upper: 3200, grids: 15, totalAmount: 5000 });
}

// Example 4: Multiple Bot Instances (Different Configs)
async function multipleBotExample() {
  // Mainnet bot for real trading
  const mainnetBot = new Mach1Bot({
    privateKey:
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    rpcUrl: "https://evm-rpc.sei.io",
    mode: "live",
    maxPositionSize: 5000,
    chainId: 1329,
  });

  // Testnet bot for testing
  const testnetBot = new Mach1Bot({
    privateKey:
      "0x9876543210987654321098765432109876543210987654321098765432109876", // Different key
    rpcUrl: "https://evm-rpc-testnet.sei.io",
    mode: "simulation",
    maxPositionSize: 1000,
    chainId: 713715,
  });

  // Different strategies on different networks
  await mainnetBot.buy("ETH/USDC", { amountUsd: 1000 });
  await testnetBot.buy("ETH/USDC", { amountUsd: 100 });
}

// Example 5: Monaco Protocol SDK Direct Configuration
async function monacoDirectExample() {
  // TODO: MonacoCoreSDK not supported in SDK. Example is placeholder only.
  // const monaco = new MonacoCoreSDK({
  //   rpcUrl: "https://evm-rpc.sei.io",
  //   privateKey: "0x1234567890123456789012345678901234567890123456789012345678901234",
  //   chainId: 1329,
  //   enableWebsockets: true,
  //   logLevel: 'INFO'
  // });
  // // Direct Monaco Protocol API usage
  // const txHash = await monaco.trading.placeLimitOrder({ ... });
  // console.log('Order placed:', txHash);
}

// ❌ OLD WAY (Environment Variables - Deprecated)
async function oldEnvironmentWay() {
  // This still works but is deprecated for library usage
  // Only use this for applications, not when using SDK as a package

  // Requires these environment variables to be set:
  // MACH1_PRIVATE_KEY=0x...
  // MACH1_RPC_URL=https://evm-rpc.sei.io

  const bot = Mach1Bot.fromEnv(); // ⚠️ Deprecated
  await bot.buy("ETH/USDC", { amountUsd: 100 });
}

// Configuration validation example
async function configValidationExample() {
  try {
    const bot = new Mach1Bot({
      // Missing required fields - will throw error
      privateKey: "", // Invalid
      rpcUrl: "", // Invalid - empty
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Configuration error:", error.message);
    } else {
      console.error("Configuration error:", error);
    }
    // Will output validation errors for missing/invalid fields
  }
}

// Production-grade configuration example
async function productionConfigExample() {
  // Load sensitive data from secure sources
  const privateKey = await loadFromSecureVault("TRADING_PRIVATE_KEY");
  const pitPass = await loadFromSecureVault("PIT_PASS_CODE");

  const bot = new Mach1Bot({
    privateKey,
    rpcUrl: "https://evm-rpc.sei.io",
    mode: "live",

    // Production settings
    maxPositionSize: 10000,
    maxDailyLoss: 2000,
    defaultSlippage: 0.005,
    stopLossPercent: 3,
    logLevel: "warn", // Less verbose in production
  });

  // Production risk management
  bot.setRiskLimits({
    maxDailyLoss: 2000,
    maxPositionSize: 10000,
    maxPortfolioRisk: 0.02,
    correlationLimit: 0.7,
  });

  return bot;
}

async function loadFromSecureVault(key: string): Promise<string> {
  // TODO: Implement secure credential loading
  // Could be AWS Secrets Manager, HashiCorp Vault, etc.
  return "secure_value";
}

export {
  configBuilderExample,
  directConfigurationExample,
  monacoDirectExample,
  multipleBotExample,
  networkPresetExample,
  productionConfigExample,
};
