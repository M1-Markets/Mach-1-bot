# Using RSI Strategy with Mach-One CLI

This guide explains how to configure and use the RSI (Relative Strength Index) strategy from the examples in the Mach-One CLI configuration.

## Overview

The RSI strategy is a mean reversion trading strategy that:
- Buys when RSI indicates oversold conditions (typically RSI < 30)
- Sells when RSI indicates overbought conditions (typically RSI > 70)
- Uses configurable parameters for fine-tuning

## Quick Start

1. **List available strategies** to confirm RSI strategy is available:
   ```bash
   mach-one-bot list-strategies
   ```

2. **Get detailed RSI strategy information**:
   ```bash
   mach-one-bot strategy rsi_strategy_v1
   ```

3. **Use one of the example configurations**:
   ```bash
   # Copy an example configuration
   cp examples/rsi-strategy-bot.toml my-rsi-bot.toml

   # Edit the configuration with your private key
   nano my-rsi-bot.toml

   # Run the bot
   mach-one-bot run --config my-rsi-bot.toml
   ```

## Configuration Structure

### Basic RSI Strategy Configuration

```toml
[strategy]
type = "rsi"                    # Strategy type
id = "rsi_strategy_v1"          # Specific RSI strategy from examples
risk_level = "medium"           # Risk level: "low", "medium", "high"
trading_pairs = ["ETH/USDC"]    # Trading pairs to monitor

[strategy.parameters]
rsiPeriod = 14                  # RSI calculation period
oversoldThreshold = 30          # Buy trigger (RSI below this value)
overboughtThreshold = 70        # Sell trigger (RSI above this value)
positionSize = 0.1              # Percentage of portfolio per trade
stopLoss = 0.05                 # Stop loss percentage
```

## Parameter Explanations

| Parameter | Description | Default | Range | Notes |
|-----------|-------------|---------|-------|-------|
| `rsiPeriod` | Number of periods for RSI calculation | 14 | 5-50 | Smaller = more sensitive |
| `oversoldThreshold` | RSI level to trigger buy orders | 30 | 10-40 | Lower = fewer but stronger signals |
| `overboughtThreshold` | RSI level to trigger sell orders | 70 | 60-90 | Higher = fewer but stronger signals |
| `positionSize` | Portfolio percentage per trade | 0.1 (10%) | 0.01-1.0 | Higher = more aggressive |
| `stopLoss` | Maximum loss before exit | 0.05 (5%) | 0.01-0.2 | Lower = tighter risk control |

## Example Configurations

### 1. Conservative RSI (Low Risk)
```toml
[strategy.parameters]
rsiPeriod = 21              # Longer period for stability
oversoldThreshold = 25      # Very oversold
overboughtThreshold = 75    # Very overbought
positionSize = 0.05         # Small positions (5%)
stopLoss = 0.03             # Tight stop loss (3%)
```

### 2. Standard RSI (Medium Risk)
```toml
[strategy.parameters]
rsiPeriod = 14              # Standard period
oversoldThreshold = 30      # Standard oversold
overboughtThreshold = 70    # Standard overbought
positionSize = 0.1          # Medium positions (10%)
stopLoss = 0.05             # Standard stop loss (5%)
```

### 3. Aggressive RSI (High Risk)
```toml
[strategy.parameters]
rsiPeriod = 10              # Shorter period for faster signals
oversoldThreshold = 35      # Less extreme oversold
overboughtThreshold = 65    # Less extreme overbought
positionSize = 0.15         # Larger positions (15%)
stopLoss = 0.08             # Wider stop loss (8%)
```

## Trading Modes

### Backtesting
Test the strategy with historical data:
```toml
[trading]
mode = "backtest"
```

### Paper Trading (Simulation)
Test with live data but no real money:
```toml
[trading]
mode = "simulation"
```

### Live Trading
Trade with real money (use carefully):
```toml
[trading]
mode = "live"
```

## Best Practices

1. **Start with backtesting** to understand strategy performance
2. **Use paper trading** to validate live performance before risking real money
3. **Begin conservatively** with smaller position sizes and tighter stop losses
4. **Monitor performance** and adjust parameters based on market conditions
5. **Use multiple trading pairs** to diversify risk

## Running the Strategy

```bash
# Create configuration
cp examples/rsi-strategy-bot.toml my-config.toml

# Edit configuration (add your private key)
nano my-config.toml

# Validate configuration
mach-one-bot run --config my-config.toml --dry-run

# Run backtest
mach-one-bot run --config my-config.toml

# Monitor the output for trading signals:
# 📈 RSI Oversold (28.5) - Bought ETH/USDC
# 📉 RSI Overbought (72.1) - Sold ETH/USDC
```

## Troubleshooting

### Strategy not found
If you get "Strategy 'rsi_strategy_v1' not found":
1. Ensure the strategy examples are properly compiled
2. Check that the strategy ID matches exactly
3. Try using legacy mode: `type = "rsi"` without the `id` field

### No trading signals
If the strategy isn't generating trades:
1. Check that trading pairs have data available
2. Verify RSI thresholds aren't too extreme
3. Ensure the time period has sufficient volatility

### Performance issues
To optimize strategy performance:
1. Adjust RSI period based on market volatility
2. Fine-tune thresholds based on backtesting results
3. Consider market conditions when setting parameters

## Advanced Usage

### Custom Trading Pairs
```toml
trading_pairs = ["BTC/USDC", "ETH/USDC", "SOL/USDC", "AVAX/USDC"]
```

### Risk Management
```toml
[trading]
max_position_size = 1000    # Maximum USD per position
max_daily_loss = 500        # Maximum daily loss limit
```

### Multi-Timeframe Analysis
The RSI strategy can be enhanced by considering multiple timeframes in future versions. For now, it operates on the default timeframe provided by the market data.

## Support

For additional help:
1. Check the main documentation: `README.md`
2. View all available strategies: `mach-one-bot list-strategies`
3. Get strategy details: `mach-one-bot strategy <strategy-id>`
4. Examine example configurations in the `examples/` directory
