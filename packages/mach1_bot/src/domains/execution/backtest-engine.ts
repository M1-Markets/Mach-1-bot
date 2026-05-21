import * as fs from "fs";
import { createLogger } from "@/shared/utils/logger";

const logger = createLogger("BacktestEngine");

import * as path from "path";
import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";
import { BaseTradingMode } from "@/domains/execution/trading-mode";
import {
  Address,
  type BacktestConfig,
  type BacktestResult,
  type DataFileInfo,
  type ExecutionOrderRecord,
  type ExecutionOrderStatusResult,
  type ExecutionTrade,
  type MarketData,
  type MarketState,
  OHLCV,
  type OrderBookSnapshot,
  OrderRequest,
  OrderResult,
  Position,
  type TradeData,
  TradingPair,
} from "@/shared/types";

interface MemoryStats {
  tradeDataPoints: number;
  portfolioValues: number;
  executedTrades: number;
  candleData: number;
  memoryOptimized: boolean;
  estimatedMemoryUsage: string;
}

export class BacktestEngine extends BaseTradingMode {
  private config: BacktestConfig;
  private historicalData: Map<string, OHLCV[]> = new Map();
  private tradeData: TradeData[] = [];
  private currentTime = 0;
  private positions: Map<Address, bigint> = new Map();
  private cash = 0n;
  private orders: Map<string, ExecutionOrderRecord> = new Map();

  // Enhanced market simulation
  private currentMarketState: MarketState = {
    currentPrice: 0,
    volume24h: 0,
    volatility: 0,
    liquidity: 0,
    orderbook: {
      timestamp: 0,
      bids: [],
      asks: [],
      midPrice: 0,
      spread: 0,
    },
  };
  private virtualOrderbook: Map<number, OrderBookSnapshot> = new Map();
  private executedTrades: Array<{
    timestamp: number;
    pair: TradingPair;
    side: "buy" | "sell";
    price: bigint;
    quantity: bigint;
    pnl: bigint;
    commission: bigint;
    slippage: bigint;
  }> = [];

  // Performance tracking
  private portfolioValues: Array<{ timestamp: number; value: bigint }> = [];
  private dailyReturns: number[] = [];
  private maxDrawdown = 0;
  private peakValue = 0n;

  // Data loading management
  private dataLoadingPromise: Promise<void>;

  // Memory optimization for large datasets
  private readonly MAX_PORTFOLIO_VALUES = 10000; // Limit stored portfolio values
  private readonly MAX_EXECUTED_TRADES = 50000; // Limit stored trade history
  private memoryOptimized = false;

  // Strategy execution support
  private strategyCallback?: (data: MarketData) => Promise<void>;
  private strategyExecutionInterval = 300000; // 5 minutes default
  private strategyExecutionCoordinator?: StrategyExecutionCoordinator;

  // Cancellation support
  private isCancelled = false;

  constructor(config: BacktestConfig) {
    super();
    this.config = config;
    this.cash = config.initialCapital;

    // Enable memory optimization for large datasets
    this.memoryOptimized = this.shouldOptimizeMemory();

    // Start loading backtest data (async)
    this.dataLoadingPromise = this.checkAndLoadBacktestData();
  }

  /**
   * Ensure all data is loaded before proceeding
   */
  async ensureDataLoaded(): Promise<void> {
    if (this.dataLoadingPromise) {
      await this.dataLoadingPromise;
    }
  }

  /**
   * Determine if memory optimization should be enabled
   */
  private shouldOptimizeMemory(): boolean {
    // Check available memory and dataset size estimates
    const memoryUsage = process.memoryUsage();
    const availableMemory = memoryUsage.heapTotal - memoryUsage.heapUsed;

    // Enable optimization if available memory is less than 1GB
    return availableMemory < 1024 * 1024 * 1024;
  }

  /**
   * Discover and parse all data files in the backtest-data directory
   */
  private async discoverDataFiles(): Promise<DataFileInfo[]> {
    const backtestDataDir =
      this.config.dataDirectory ?? path.join(process.cwd(), "backtest-data");
    const dataFiles: DataFileInfo[] = [];

    if (!fs.existsSync(backtestDataDir)) {
      logger.warn("⚠️  backtest-data directory not found.");
      return dataFiles;
    }

    // Recursively scan for CSV files
    const scanDirectory = (dirPath: string): void => {
      const items = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);

        if (item.isDirectory()) {
          // Recursively scan subdirectories
          scanDirectory(fullPath);
        } else if (item.isFile() && item.name.endsWith(".csv")) {
          const fileInfo = this.parseFilePattern(fullPath);
          if (fileInfo) {
            dataFiles.push(fileInfo);
          }
        }
      }
    };

    scanDirectory(backtestDataDir);
    return dataFiles;
  }

  /**
   * Parse file patterns to extract trading pair, date, and other metadata
   */
  private parseFilePattern(filePath: string): DataFileInfo | null {
    const fileName = path.basename(filePath);
    const directory = path.basename(path.dirname(filePath));

    try {
      const stats = fs.statSync(filePath);

      // Pattern 1: {PAIR}-trades-{YYYY-MM-DD}.csv (e.g., SOLUSDT-trades-2024-07-01.csv)
      const pattern1 = /^([A-Z]+)-trades-(\d{4}-\d{2}-\d{2})\.csv$/;
      const match1 = fileName.match(pattern1);

      if (match1) {
        const [, tradingPair, dateStr] = match1;
        return {
          filePath,
          tradingPair,
          date: new Date(dateStr),
          directory,
          fileSize: stats.size,
        };
      }

      // Pattern 2: {PAIR}_{YYYY-MM-DD}.csv (e.g., SOLUSDT_2024-07-01.csv)
      const pattern2 = /^([A-Z]+)_(\d{4}-\d{2}-\d{2})\.csv$/;
      const match2 = fileName.match(pattern2);

      if (match2) {
        const [, tradingPair, dateStr] = match2;
        return {
          filePath,
          tradingPair,
          date: new Date(dateStr),
          directory,
          fileSize: stats.size,
        };
      }

      // Pattern 3: datum.csv (legacy format - assume generic pair)
      if (fileName === "datum.csv") {
        return {
          filePath,
          tradingPair: "UNKNOWN",
          date: new Date(stats.mtime), // Use file modification time
          directory,
          fileSize: stats.size,
        };
      }

      // Pattern 4: {YYYY-MM-DD}_{PAIR}.csv (e.g., 2024-07-01_SOLUSDT.csv)
      const pattern4 = /^(\d{4}-\d{2}-\d{2})_([A-Z]+)\.csv$/;
      const match4 = fileName.match(pattern4);

      if (match4) {
        const [, dateStr, tradingPair] = match4;
        return {
          filePath,
          tradingPair,
          date: new Date(dateStr),
          directory,
          fileSize: stats.size,
        };
      }

      // If no pattern matches, try to extract any trading pair
      const pairPattern = /([A-Z]{3,})/;
      const pairMatch = fileName.match(pairPattern);

      if (pairMatch) {
        return {
          filePath,
          tradingPair: pairMatch[1],
          date: new Date(stats.mtime), // Use file modification time
          directory,
          fileSize: stats.size,
        };
      }

      logger.warn(`⚠️  Could not parse file pattern: ${fileName}`);
      return null;
    } catch (error) {
      logger.error(`❌ Error reading file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Filter data files based on date range and trading pairs
   */
  private filterDataFiles(
    dataFiles: DataFileInfo[],
    startDate?: Date,
    endDate?: Date,
    tradingPairs?: string[],
  ): DataFileInfo[] {
    return dataFiles.filter((file) => {
      // Filter by date range
      if (startDate && file.date < startDate) return false;
      if (endDate && file.date > endDate) return false;

      // Filter by trading pairs
      if (tradingPairs && tradingPairs.length > 0) {
        const normalizedPairs = tradingPairs.map((pair) => pair.toUpperCase());
        if (!normalizedPairs.includes(file.tradingPair.toUpperCase()))
          return false;
      }

      return true;
    });
  }

  /**
   * Check for backtest-data directory and load all matching CSV files
   */
  private async checkAndLoadBacktestData(): Promise<void> {
    try {
      logger.info("🔍 Discovering backtest data files...");

      // Discover all data files
      const allDataFiles = await this.discoverDataFiles();

      if (allDataFiles.length === 0) {
        logger.warn("⚠️  No CSV data files found in backtest-data directory.");
        return;
      }

      logger.info(`📁 Discovered ${allDataFiles.length} data files`);

      // Log discovered files grouped by trading pair and directory
      const filesByPair = new Map<string, DataFileInfo[]>();
      const filesByDir = new Map<string, DataFileInfo[]>();

      for (const file of allDataFiles) {
        // Group by trading pair
        if (!filesByPair.has(file.tradingPair)) {
          filesByPair.set(file.tradingPair, []);
        }
        const pairFiles = filesByPair.get(file.tradingPair);
        if (pairFiles) {
          pairFiles.push(file);
        }

        // Group by directory
        if (!filesByDir.has(file.directory)) {
          filesByDir.set(file.directory, []);
        }
        const dirFiles = filesByDir.get(file.directory);
        if (dirFiles) {
          dirFiles.push(file);
        }
      }

      // Log summary
      logger.info("📊 Data file summary:");
      for (const [pair, files] of filesByPair) {
        const totalSize = files.reduce((sum, f) => sum + f.fileSize, 0);
        const sizeStr =
          totalSize > 1024 * 1024
            ? `${(totalSize / (1024 * 1024)).toFixed(1)}MB`
            : `${(totalSize / 1024).toFixed(1)}KB`;
        logger.info(`   ${pair}: ${files.length} files (${sizeStr})`);
      }

      for (const [dir, files] of filesByDir) {
        logger.info(`   � ${dir}/: ${files.length} files`);
      }

      // Filter files based on backtest configuration
      const startDate = new Date(
        this.config.startDate.getTime() - 24 * 60 * 60 * 1000,
      ); // Start 1 day earlier for context
      const endDate = new Date(
        this.config.endDate.getTime() + 24 * 60 * 60 * 1000,
      ); // End 1 day later for context

      const filteredFiles = this.filterDataFiles(
        allDataFiles,
        startDate,
        endDate,
      );

      if (filteredFiles.length === 0) {
        logger.warn(
          `⚠️  No data files found matching date range ${startDate.toISOString().split("T")[0]} to ${endDate.toISOString().split("T")[0]}`,
        );
        return;
      }

      logger.info(`📅 Loading ${filteredFiles.length} files within date range`);

      // Sort files chronologically
      filteredFiles.sort((a, b) => a.date.getTime() - b.date.getTime());

      // Load all matching files
      await this.loadMultipleDataFiles(filteredFiles);
    } catch (error) {
      logger.error("❌ Error loading backtest data:", error);
    }
  }

  /**
   * Load trade data from multiple CSV files
   */
  private async loadMultipleDataFiles(
    dataFiles: DataFileInfo[],
  ): Promise<void> {
    this.tradeData = []; // Reset existing data
    let totalLoadedTrades = 0;

    logger.info("📊 Loading trade data from multiple files...");

    for (let i = 0; i < dataFiles.length; i++) {
      const file = dataFiles[i];
      const fileNumber = i + 1;

      try {
        logger.info(
          `📁 [${fileNumber}/${dataFiles.length}] Loading ${file.tradingPair} data from ${path.basename(file.filePath)}...`,
        );

        const fileTradeData = await this.loadTradeDataFromCSV(
          file.filePath,
          file.tradingPair,
        );
        totalLoadedTrades += fileTradeData.length;

        logger.info(
          `   ✅ Loaded ${fileTradeData.length.toLocaleString()} trades`,
        );

        // Progress update for large datasets
        if (
          dataFiles.length > 5 &&
          fileNumber % Math.ceil(dataFiles.length / 5) === 0
        ) {
          logger.info(
            `   📈 Progress: ${fileNumber}/${dataFiles.length} files (${totalLoadedTrades.toLocaleString()} total trades)`,
          );
        }
      } catch (error) {
        logger.error(`❌ Error loading ${file.filePath}:`, error);
        continue; // Skip failed files but continue with others
      }
    }

    logger.info(
      `✅ Successfully loaded ${totalLoadedTrades.toLocaleString()} trade records from ${dataFiles.length} files`,
    );

    // Sort all trade data chronologically after loading all files
    logger.info("🔄 Sorting combined trade data chronologically...");
    this.tradeData.sort((a, b) => a.timestamp - b.timestamp);

    // Process the loaded data
    await this.processTradeData();
  }

  /**
   * Load trade data from CSV file (enhanced version with trading pair tracking)
   */
  private async loadTradeDataFromCSV(
    filePath: string,
    tradingPair?: string,
  ): Promise<TradeData[]> {
    const csvContent = fs.readFileSync(filePath, "utf-8");
    const lines = csvContent.trim().split("\n");

    logger.info(
      `   📄 Processing ${lines.length.toLocaleString()} lines from ${path.basename(filePath)}...`,
    );

    const fileTradeData: TradeData[] = [];
    const batchSize = 10000; // Process in smaller batches to avoid stack overflow

    for (let i = 0; i < lines.length; i += batchSize) {
      const batch = lines.slice(i, i + batchSize);

      const batchData = batch.map((line) => {
        const [
          tradeId,
          price,
          quantity,
          volume,
          timestamp,
          isBuyerMaker,
          bestMatch,
        ] = line.split(",");

        return {
          tradeId: parseInt(tradeId),
          price: parseFloat(price),
          quantity: parseFloat(quantity),
          volume: parseFloat(volume),
          timestamp: parseInt(timestamp),
          isBuyerMaker: isBuyerMaker === "True",
          bestMatch: bestMatch === "True",
          tradingPair: tradingPair || "UNKNOWN",
          sourceFile: path.basename(filePath),
        };
      });

      // Add batch to file data (safe for large arrays)
      fileTradeData.push(...batchData);

      // Progress logging for large files
      if (lines.length > 50000 && (i + batchSize) % 50000 === 0) {
        logger.info(
          `      Processed ${(i + batchSize).toLocaleString()}/${lines.length.toLocaleString()} lines...`,
        );
      }
    }

    // Add to the main tradeData array using concat to avoid stack overflow
    if (this.tradeData.length === 0) {
      this.tradeData = fileTradeData;
    } else {
      this.tradeData = this.tradeData.concat(fileTradeData);
    }

    return fileTradeData;
  }

  /**
   * Process the loaded trade data for backtesting.
   * Converts trade data into OHLCV candles, calculates market metrics,
   * and prepares the backtesting environment.
   */
  private async processTradeData(): Promise<void> {
    if (this.tradeData.length === 0) {
      logger.warn("⚠️  No trade data to process");
      return;
    }

    logger.info("🔄 Processing trade data...");

    await this.convertTradesToOHLCV();
    await this.calculateMarketMetrics();
    await this.prepareBacktestEnvironment();

    const firstTrade = this.tradeData[0];
    const lastTrade = this.tradeData[this.tradeData.length - 1];

    // Calculate min/max efficiently for large datasets
    let minPrice = Number.MAX_VALUE;
    let maxPrice = Number.MIN_VALUE;
    let totalVolume = 0;

    for (const trade of this.tradeData) {
      minPrice = Math.min(minPrice, trade.price);
      maxPrice = Math.max(maxPrice, trade.price);
      totalVolume += trade.volume;
    }

    logger.info(
      `📈 Trade data period: ${new Date(firstTrade.timestamp)} to ${new Date(lastTrade.timestamp)}`,
    );
    logger.info(
      `💱 Price range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`,
    );
    logger.info(`📊 Total volume: ${totalVolume.toFixed(2)}`);
  }

  /**
   * Convert trade data to OHLCV candles for multiple timeframes and trading pairs
   */
  private async convertTradesToOHLCV(intervalMs = 60000): Promise<void> {
    logger.info(
      `📊 Converting trades to OHLCV candles (${intervalMs / 1000}s intervals)...`,
    );

    if (this.tradeData.length === 0) return;

    // Support multiple timeframes
    const timeframes = [
      { name: "1m", interval: 60000 },
      { name: "5m", interval: 300000 },
      { name: "1h", interval: 3600000 },
      { name: "1d", interval: 86400000 },
    ];

    // Get available trading pairs
    const tradingPairs = this.getAvailableTradingPairs();
    logger.info(
      `📈 Processing ${tradingPairs.length} trading pairs: ${tradingPairs.join(", ")}`,
    );

    for (const timeframe of timeframes) {
      for (const pair of tradingPairs) {
        const pairKey = `${pair}_${timeframe.name}`;
        const candleMap = new Map<number, OHLCV>();

        // Get trades for this specific pair
        const pairTrades = this.getTradeDataByPair(pair);

        if (pairTrades.length === 0) continue;

        // Process trades in batches for memory efficiency
        const batchSize = 10000;
        let processedCount = 0;

        for (let i = 0; i < pairTrades.length; i += batchSize) {
          const batch = pairTrades.slice(i, i + batchSize);

          for (const trade of batch) {
            const intervalStart =
              Math.floor(trade.timestamp / timeframe.interval) *
              timeframe.interval;

            if (!candleMap.has(intervalStart)) {
              candleMap.set(intervalStart, {
                timestamp: intervalStart,
                open: trade.price,
                high: trade.price,
                low: trade.price,
                close: trade.price,
                volume: trade.volume,
              });
            } else {
              const candle = candleMap.get(intervalStart);
              if (candle) {
                candle.high = Math.max(candle.high, trade.price);
                candle.low = Math.min(candle.low, trade.price);
                candle.close = trade.price; // Last trade in interval becomes close
                candle.volume += trade.volume;
              }
            }
          }

          processedCount += batch.length;
          if (pairTrades.length > 50000 && processedCount % 50000 === 0) {
            logger.info(
              `   Processed ${processedCount.toLocaleString()} trades for ${pair} ${timeframe.name}...`,
            );
          }
        }

        // Convert to sorted array and store
        const candles = Array.from(candleMap.values()).sort(
          (a, b) => a.timestamp - b.timestamp,
        );
        this.historicalData.set(pairKey, candles);

        logger.info(
          `📈 Generated ${candles.length} ${timeframe.name} candles for ${pair}`,
        );
      }
    }
  }

  /**
   * Calculate market metrics and indicators from trade data
   */
  private async calculateMarketMetrics(): Promise<void> {
    logger.info("📊 Calculating market metrics...");

    if (this.tradeData.length === 0) return;

    // Calculate basic metrics efficiently for large datasets
    let totalPrice = 0;
    let totalVolume = 0;
    let minPrice = Number.MAX_VALUE;
    let maxPrice = Number.MIN_VALUE;

    // Process in batches to avoid memory issues
    const batchSize = 10000;
    for (let i = 0; i < this.tradeData.length; i += batchSize) {
      const batch = this.tradeData.slice(i, i + batchSize);

      for (const trade of batch) {
        totalPrice += trade.price;
        totalVolume += trade.volume;
        minPrice = Math.min(minPrice, trade.price);
        maxPrice = Math.max(maxPrice, trade.price);
      }
    }

    const avgPrice = totalPrice / this.tradeData.length;

    // Calculate standard deviation in a second pass
    let sumSquaredDiffs = 0;
    for (let i = 0; i < this.tradeData.length; i += batchSize) {
      const batch = this.tradeData.slice(i, i + batchSize);

      for (const trade of batch) {
        sumSquaredDiffs += Math.pow(trade.price - avgPrice, 2);
      }
    }

    const priceStdDev = Math.sqrt(sumSquaredDiffs / this.tradeData.length);

    logger.info(`📊 Average price: $${avgPrice.toFixed(2)}`);
    logger.info(
      `📊 Price range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`,
    );
    logger.info(`📊 Price volatility (std dev): $${priceStdDev.toFixed(2)}`);
    logger.info(`📊 Total volume: ${totalVolume.toFixed(2)}`);
  }

  /**
   * Prepare backtest environment with market simulation components.
   * All simulation components (orderbook, slippage, commission, etc.)
   * are already implemented and available throughout the class.
   */
  private async prepareBacktestEnvironment(): Promise<void> {
    logger.info("🏗️  Preparing backtest environment...");

    // Initialize market state tracking
    this.currentMarketState = {
      currentPrice: 0,
      volume24h: 0,
      volatility: 0,
      liquidity: 0,
      orderbook: {
        timestamp: 0,
        bids: [],
        asks: [],
        midPrice: 0,
        spread: 0,
      },
    };

    // Clear any existing virtual orderbook data
    this.virtualOrderbook.clear();

    logger.info("✅ Backtest environment prepared");
  }

  /**
   * Set the strategy callback to be executed during backtest
   */
  setStrategyCallback(
    callback: (data: MarketData) => Promise<void>,
    executionInterval = 300000,
  ): void {
    this.strategyCallback = callback;
    this.strategyExecutionInterval = executionInterval;
    this.strategyExecutionCoordinator = new StrategyExecutionCoordinator({
      executor: async () => {
        if (!this.strategyCallback) {
          return false;
        }

        const marketData = this.constructMarketData(this.currentTime);
        if (Object.keys(marketData).length === 0) {
          return false;
        }

        await this.strategyCallback(marketData);
        return true;
      },
      intervalMs: this.strategyExecutionInterval,
      now: () => this.currentTime,
    });
  }

  /**
   * Cancel the ongoing backtest operation
   */
  cancel(): void {
    this.isCancelled = true;
    logger.info("🛑 Backtest cancellation requested...");
  }

  /**
   * Construct market data for strategy execution
   */
  private constructMarketData(timestamp: number): MarketData {
    const marketData: MarketData = {};

    // Get available trading pairs
    const tradingPairs = this.getAvailableTradingPairs();

    for (const pair of tradingPairs) {
      // Get recent trade data around this timestamp
      const recentTrades = this.getTradeDataInRange(
        timestamp - 3600000,
        timestamp,
      ); // Last hour
      const pairTrades = recentTrades.filter(
        (trade) => trade.tradingPair?.toUpperCase() === pair.toUpperCase(),
      );

      if (pairTrades.length === 0) {
        // Try to get any trade from this pair
        const anyPairTrades = this.getTradeDataByPair(pair);
        if (anyPairTrades.length > 0) {
          // Use the closest trade to this timestamp
          const closestTrade = anyPairTrades.reduce((closest, trade) =>
            Math.abs(trade.timestamp - timestamp) <
            Math.abs(closest.timestamp - timestamp)
              ? trade
              : closest,
          );

          // Convert pair format to match expected format
          const formattedPair = this.formatTradingPair(pair);

          marketData[formattedPair] = {
            open: closestTrade.price,
            high: closestTrade.price * 1.001, // Mock high/low with small spread
            low: closestTrade.price * 0.999,
            close: closestTrade.price,
            volume: closestTrade.volume,
            rsi: 50, // Neutral RSI
            macdSignal: 0, // Neutral MACD
            timestamp: timestamp,
          };
        }
        continue;
      }

      // Calculate OHLC from recent trades
      const prices = pairTrades.map((t) => t.price);
      const volumes = pairTrades.map((t) => t.volume);

      const open = pairTrades[0].price;
      const close = pairTrades[pairTrades.length - 1].price;
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      const volume = volumes.reduce((sum, v) => sum + v, 0);

      // Convert pair format to match expected format (e.g., SOLUSDT -> SOL/USDC)
      const formattedPair = this.formatTradingPair(pair);

      marketData[formattedPair] = {
        open,
        high,
        low,
        close,
        volume,
        rsi: 50, // Simple neutral RSI for now
        macdSignal: 0, // Simple neutral MACD for now
        timestamp: timestamp,
      };
    }

    return marketData;
  }

  /**
   * Format trading pair from internal format to expected format
   */
  private formatTradingPair(pair: string): string {
    // Convert common formats to ETH/USDC, BTC/USDC etc.
    const pairMappings: Record<string, string> = {
      SOLUSDT: "SOL/USDC",
      ETHUSDT: "ETH/USDC",
      BTCUSDT: "BTC/USDC",
      SOLUSDC: "SOL/USDC",
      ETHUSDC: "ETH/USDC",
      BTCUSDC: "BTC/USDC",
    };

    return pairMappings[pair.toUpperCase()] || `${pair}/USDC`;
  }

  /**
   * Calculate RSI indicator (simple implementation)
   */
  private calculateRSI(candles: OHLCV[], period = 14): number {
    if (candles.length < period + 1) return 50; // Neutral RSI

    const prices = candles.slice(-period - 1).map((c) => c.close);
    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? Math.abs(change) : 0);
    }

    const avgGain = gains.reduce((sum, gain) => sum + gain, 0) / gains.length;
    const avgLoss = losses.reduce((sum, loss) => sum + loss, 0) / losses.length;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Calculate MACD signal (simple implementation)
   */
  private calculateMACD(candles: OHLCV[]): number {
    if (candles.length < 26) return 0; // Not enough data

    const prices = candles.map((c) => c.close);

    // Simple EMA calculation
    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);

    return ema12 - ema26;
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema =
      prices.slice(0, period).reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * multiplier + ema * (1 - multiplier);
    }

    return ema;
  }

  async loadHistoricalData(pair: TradingPair, data: OHLCV[]): Promise<void> {
    // Load historical OHLCV data for a specific trading pair
    this.historicalData.set(`${pair.base}-${pair.quote}`, data);
    logger.info(
      `📊 Loaded ${data.length} OHLCV candles for ${pair.base}/${pair.quote}`,
    );
  }

  /**
   * Get loaded trade data for analysis or external processing
   */
  getTradeData(): TradeData[] {
    return this.tradeData;
  }

  /**
   * Get trade data for a specific trading pair
   */
  getTradeDataByPair(tradingPair: string): TradeData[] {
    return this.tradeData.filter(
      (trade) => trade.tradingPair?.toUpperCase() === tradingPair.toUpperCase(),
    );
  }

  /**
   * Get available trading pairs from loaded data
   */
  getAvailableTradingPairs(): string[] {
    const pairs = new Set<string>();
    for (const trade of this.tradeData) {
      if (trade.tradingPair) {
        pairs.add(trade.tradingPair);
      }
    }
    return Array.from(pairs).sort();
  }

  /**
   * Get data loading statistics
   */
  getDataLoadingStats(): {
    totalTrades: number;
    tradingPairs: string[];
    dateRange: { start: Date; end: Date } | null;
    sourceFiles: string[];
    memoryStats: MemoryStats;
  } {
    const tradingPairs = this.getAvailableTradingPairs();
    const sourceFiles = [
      ...new Set(
        this.tradeData
          .map((t) => t.sourceFile)
          .filter((f): f is string => f !== undefined),
      ),
    ];

    let dateRange = null;
    if (this.tradeData.length > 0) {
      // Efficiently find min/max timestamps without Math.min/max on large arrays
      let minTimestamp = this.tradeData[0].timestamp;
      let maxTimestamp = this.tradeData[0].timestamp;

      for (const trade of this.tradeData) {
        if (trade.timestamp < minTimestamp) {
          minTimestamp = trade.timestamp;
        }
        if (trade.timestamp > maxTimestamp) {
          maxTimestamp = trade.timestamp;
        }
      }

      dateRange = {
        start: new Date(minTimestamp),
        end: new Date(maxTimestamp),
      };
    }

    return {
      totalTrades: this.tradeData.length,
      tradingPairs,
      dateRange,
      sourceFiles,
      memoryStats: this.getMemoryStats(),
    };
  }

  /**
   * Get trade data within a specific time range
   */
  getTradeDataInRange(startTime: number, endTime: number): TradeData[] {
    return this.tradeData.filter(
      (trade) => trade.timestamp >= startTime && trade.timestamp <= endTime,
    );
  }

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const orderId = `backtest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Validate order against available balance
    if (!this.validateOrder(order)) {
      const result: OrderResult = {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
      this.orders.set(orderId, {
        order,
        timestamp: Date.now(),
        ...result,
      });
      return result;
    }

    // Get current market price from historical data
    const currentPrice = this.getCurrentPrice({
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    });

    if (currentPrice === 0n) {
      const result: OrderResult = {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
      this.orders.set(orderId, {
        order,
        timestamp: Date.now(),
        ...result,
      });
      return result;
    }

    // Calculate slippage based on order size and market liquidity
    const slippage = this.calculateSlippage(order, currentPrice);
    const commission = this.calculateCommission(order, currentPrice);

    // Simulate order execution with slippage
    const executionPrice = order.isBuy
      ? currentPrice + slippage
      : currentPrice - slippage;

    const totalCost = order.isBuy
      ? (executionPrice * order.quantity) / 100n + commission
      : (executionPrice * order.quantity) / 100n - commission;

    // Check if we have enough balance
    if (order.isBuy && this.cash < totalCost) {
      const result: OrderResult = {
        orderId,
        status: "rejected",
        filledQuantity: 0n,
        remainingQuantity: order.quantity,
      };
      this.orders.set(orderId, {
        order,
        timestamp: Date.now(),
        ...result,
      });
      return result;
    }

    // Execute the trade
    this.executeTrade(order, executionPrice, commission, slippage);

    // Log the trade
    const result: OrderResult = {
      orderId,
      status: "filled",
      filledQuantity: order.quantity,
      remainingQuantity: 0n,
    };
    this.orders.set(orderId, {
      order,
      timestamp: Date.now(),
      ...result,
    });
    this.logTrade(order, result);

    return result;
  }

  /**
   * Calculate realistic slippage based on order size and market conditions
   */
  private calculateSlippage(order: OrderRequest, currentPrice: bigint): bigint {
    // Base slippage from config
    const baseSlippage = BigInt(Math.floor(this.config.slippage * 10000)); // Convert to basis points

    // Calculate order size relative to typical volume
    const orderValue = (currentPrice * order.quantity) / 100n;
    const averageVolumeValue = BigInt(
      Math.floor(this.currentMarketState.volume24h * 100),
    ); // Floor before converting to BigInt

    // Increase slippage for larger orders - handle zero volume case
    let sizeMultiplier = 100n; // Default multiplier
    if (averageVolumeValue > 0n) {
      const volumeThreshold = averageVolumeValue / 1000n;
      if (volumeThreshold > 0n && orderValue > volumeThreshold) {
        sizeMultiplier = (orderValue * 100n) / volumeThreshold;
      }
    }

    // Add volatility-based slippage
    const volatilityMultiplier = BigInt(
      Math.floor(this.currentMarketState.volatility * 1000),
    );

    const totalSlippage =
      (currentPrice * baseSlippage * sizeMultiplier * volatilityMultiplier) /
      (100n * 100n * 100n * 1000n);

    return totalSlippage;
  }

  /**
   * Calculate commission fees
   */
  private calculateCommission(
    order: OrderRequest,
    currentPrice: bigint,
  ): bigint {
    const orderValue = (currentPrice * order.quantity) / 100n;
    const commissionRate = BigInt(Math.floor(this.config.commission * 10000)); // Convert to basis points
    return (orderValue * commissionRate) / 10000n;
  }

  /**
   * Execute trade and update positions
   */
  private executeTrade(
    order: OrderRequest,
    executionPrice: bigint,
    commission: bigint,
    slippage: bigint,
  ): void {
    const pair: TradingPair = {
      base: order.baseToken,
      quote: order.quoteToken,
      symbol: `${order.baseToken}/${order.quoteToken}`,
    };

    if (order.isBuy) {
      // Buy: Spend quote token, get base token
      const totalCost = (executionPrice * order.quantity) / 100n + commission;
      this.cash -= totalCost;

      const currentBase = this.positions.get(order.baseToken) ?? 0n;
      this.positions.set(order.baseToken, currentBase + order.quantity);
    } else {
      // Sell: Spend base token, get quote token
      const totalReceived =
        (executionPrice * order.quantity) / 100n - commission;
      this.cash += totalReceived;

      const currentBase = this.positions.get(order.baseToken) ?? 0n;
      this.positions.set(order.baseToken, currentBase - order.quantity);
    }

    // Calculate P&L for this trade
    const pnl = order.isBuy
      ? -(executionPrice * order.quantity) / 100n - commission
      : (executionPrice * order.quantity) / 100n - commission;

    // Record the executed trade with memory optimization
    this.executedTrades.push({
      timestamp: this.currentTime,
      pair,
      side: order.isBuy ? "buy" : "sell",
      price: executionPrice,
      quantity: order.quantity,
      pnl,
      commission,
      slippage,
    });

    logger.info(
      `📝 Recorded trade #${this.executedTrades.length}: ${order.isBuy ? "BUY" : "SELL"} ${pair.symbol} at ${Number(executionPrice) / 100} (Total trades: ${this.executedTrades.length})`,
    );

    // Memory optimization: limit stored trade history
    if (
      this.memoryOptimized &&
      this.executedTrades.length > this.MAX_EXECUTED_TRADES
    ) {
      logger.info(
        `🧹 Memory optimization: trimming trades from ${this.executedTrades.length} to ${Math.floor(this.MAX_EXECUTED_TRADES * 0.8)}`,
      );
      // Remove oldest trades, keeping summary statistics
      this.executedTrades = this.executedTrades.slice(
        -this.MAX_EXECUTED_TRADES * 0.8,
      );
    }

    // Update portfolio value tracking
    this.updatePortfolioValue();
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): {
    tradeDataPoints: number;
    portfolioValues: number;
    executedTrades: number;
    candleData: number;
    memoryOptimized: boolean;
    estimatedMemoryUsage: string;
  } {
    const candleCount = Array.from(this.historicalData.values()).reduce(
      (sum, candles) => sum + candles.length,
      0,
    );
    const estimatedMemoryMB =
      (this.tradeData.length * 0.05 + // ~50 bytes per trade
        this.portfolioValues.length * 0.02 + // ~20 bytes per portfolio value
        this.executedTrades.length * 0.1 + // ~100 bytes per executed trade
        candleCount * 0.05) / // ~50 bytes per candle
      1024; // Convert to MB

    return {
      tradeDataPoints: this.tradeData.length,
      portfolioValues: this.portfolioValues.length,
      executedTrades: this.executedTrades.length,
      candleData: candleCount,
      memoryOptimized: this.memoryOptimized,
      estimatedMemoryUsage: `${estimatedMemoryMB.toFixed(2)} MB`,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    // In backtest mode, orders are executed immediately
    // This is a placeholder for more complex order management
    logger.info(
      `⚠️  Order cancellation not applicable in backtest mode: ${orderId}`,
    );
  }

  async getOrderStatus(orderId: string): Promise<ExecutionOrderStatusResult> {
    const orderData = this.orders.get(orderId);
    if (!orderData) {
      throw new Error("Order not found");
    }

    return {
      orderId,
      status: orderData.status,
      filledQuantity: orderData.filledQuantity,
      remainingQuantity: orderData.remainingQuantity,
    };
  }

  /**
   * Get historical candle data for a specific timeframe and trading pair
   */
  getHistoricalData(timeframe: string, tradingPair?: string): OHLCV[] {
    if (tradingPair) {
      return this.historicalData.get(`${tradingPair}_${timeframe}`) || [];
    }

    // Legacy support: if no trading pair specified, try to get the first available
    const availablePairs = this.getAvailableTradingPairs();
    if (availablePairs.length > 0) {
      return this.historicalData.get(`${availablePairs[0]}_${timeframe}`) || [];
    }

    // Fallback to old format for backward compatibility
    return this.historicalData.get(timeframe) || [];
  }

  /**
   * Get market data feed for strategy execution
   */
  getMarketDataFeed(timestamp: number): {
    candles: OHLCV[];
    trades: TradeData[];
    orderbook: OrderBookSnapshot;
    marketState: MarketState;
  } {
    // Get recent candles around the timestamp
    const candles = this.getHistoricalData("1m").filter(
      (candle) =>
        candle.timestamp <= timestamp && candle.timestamp > timestamp - 3600000, // Last hour
    );

    // Get recent trades
    const trades = this.getTradeDataInRange(timestamp - 300000, timestamp); // Last 5 minutes

    // Construct virtual orderbook from recent trade data
    const orderbook = this.constructOrderbook(timestamp);

    return {
      candles,
      trades,
      orderbook,
      marketState: this.currentMarketState,
    };
  }

  /**
   * Construct virtual orderbook from trade data
   */
  private constructOrderbook(timestamp: number): OrderBookSnapshot {
    const recentTrades = this.getTradeDataInRange(timestamp - 60000, timestamp); // Last minute

    if (recentTrades.length === 0) {
      return {
        timestamp,
        bids: [],
        asks: [],
        midPrice: 0,
        spread: 0,
      };
    }

    // Use the most recent trade as base price
    const basePrice = recentTrades[recentTrades.length - 1].price;
    const spread = basePrice * 0.001; // 0.1% spread

    // Generate synthetic orderbook levels
    const bids = [];
    const asks = [];
    const levels = 10;

    for (let i = 0; i < levels; i++) {
      const bidPrice = basePrice - spread * 0.5 - spread * 0.1 * i;
      const askPrice = basePrice + spread * 0.5 + spread * 0.1 * i;

      // Synthetic quantity based on recent volume
      const avgVolume =
        recentTrades.reduce((sum, t) => sum + t.volume, 0) /
        recentTrades.length;
      const quantity = avgVolume * (1 - i * 0.1); // Decreasing liquidity at further levels

      bids.push({ price: bidPrice, quantity });
      asks.push({ price: askPrice, quantity });
    }

    return {
      timestamp,
      bids: bids.sort((a, b) => b.price - a.price), // Highest bid first
      asks: asks.sort((a, b) => a.price - b.price), // Lowest ask first
      midPrice: basePrice,
      spread: spread / basePrice, // Percentage spread
    };
  }

  async getPosition(pair: TradingPair): Promise<Position> {
    const balance = this.positions.get(pair.base) ?? 0n;
    const currentPrice = this.getCurrentPriceInternal(pair);
    const value = (balance * currentPrice) / 100n;

    // Calculate unrealized P&L by comparing to average entry price
    const unrealizedPnL = this.calculateUnrealizedPnL(
      pair.base,
      balance,
      currentPrice,
    );

    return {
      token: pair.base,
      balance,
      value,
      unrealizedPnL,
    };
  }

  async getBalance(token: Address): Promise<bigint> {
    if (token === ("0x0000000000000000000000000000000000000000" as Address)) {
      return this.cash;
    }
    return this.positions.get(token) ?? 0n;
  }

  /**
   * Calculate unrealized P&L for a position
   */
  private calculateUnrealizedPnL(
    token: Address,
    balance: bigint,
    currentPrice: bigint,
  ): bigint {
    if (balance === 0n) return 0n;

    // Find average entry price from executed trades
    const relevantTrades = this.executedTrades.filter(
      (trade) => trade.pair.base === token && trade.side === "buy",
    );

    if (relevantTrades.length === 0) return 0n;

    let totalCost = 0n;
    let totalQuantity = 0n;

    for (const trade of relevantTrades) {
      totalCost += (trade.price * trade.quantity) / 100n;
      totalQuantity += trade.quantity;
    }

    if (totalQuantity === 0n) return 0n;

    const avgEntryPrice = (totalCost * 100n) / totalQuantity;
    const currentValue = (balance * currentPrice) / 100n;
    const entryValue = (balance * avgEntryPrice) / 100n;

    return currentValue - entryValue;
  }

  /**
   * Update portfolio value tracking with memory optimization
   */
  private updatePortfolioValue(): void {
    const totalValue = this.calculatePortfolioValue();

    this.portfolioValues.push({
      timestamp: this.currentTime,
      value: totalValue,
    });

    // Memory optimization: limit stored portfolio values
    if (
      this.memoryOptimized &&
      this.portfolioValues.length > this.MAX_PORTFOLIO_VALUES
    ) {
      // Keep every nth value to maintain historical perspective
      const keepEvery = 2;
      this.portfolioValues = this.portfolioValues.filter(
        (_, index) =>
          index % keepEvery === 0 ||
          index >= this.portfolioValues.length - 1000, // Keep recent values
      );
    }

    // Update peak value and drawdown tracking
    if (totalValue > this.peakValue) {
      this.peakValue = totalValue;
    } else if (this.peakValue > 0n) {
      const currentDrawdown =
        Number(this.peakValue - totalValue) / Number(this.peakValue);
      this.maxDrawdown = Math.max(this.maxDrawdown, currentDrawdown);
    }
  }

  /**
   * Calculate total portfolio value
   */
  private calculatePortfolioValue(): bigint {
    let totalValue = this.cash;

    for (const [token, balance] of this.positions) {
      if (balance > 0n) {
        const price = this.getCurrentPriceInternal({
          base: token,
          quote: "0x0000000000000000000000000000000000000000" as Address,
          symbol: "TOKEN/USD",
        });
        totalValue += (balance * price) / 100n;
      }
    }

    return totalValue;
  }

  async getPortfolioValue(): Promise<bigint> {
    return this.calculatePortfolioValue();
  }

  getExecutedTrades(): ExecutionTrade[] {
    return [...this.executedTrades];
  }

  getOrderHistory(): Map<string, ExecutionOrderRecord> {
    return new Map(this.orders);
  }

  /**
   * Get current price from historical data at current time (public method)
   */
  getCurrentPrice(pair: TradingPair): bigint {
    return this.getCurrentPriceInternal(pair);
  }

  /**
   * Get current price from historical data at current time
   */
  private getCurrentPriceInternal(pair: TradingPair): bigint {
    if (this.currentTime === 0) {
      // If no current time set, use latest available price
      const latestTrade = this.tradeData[this.tradeData.length - 1];
      return latestTrade
        ? BigInt(Math.floor(latestTrade.price * 100))
        : 100n * 100n; // Default price if no data
    }

    // Find the closest trade to current time
    const closestTrade = this.findClosestTrade(this.currentTime);
    return closestTrade
      ? BigInt(Math.floor(closestTrade.price * 100))
      : 100n * 100n; // Scale price by 100 for precision
  }

  /**
   * Find closest trade to a given timestamp
   */
  private findClosestTrade(timestamp: number): TradeData | null {
    if (this.tradeData.length === 0) return null;

    // Binary search for closest timestamp
    let left = 0;
    let right = this.tradeData.length - 1;
    let closest = this.tradeData[0];
    let minDiff = Math.abs(this.tradeData[0].timestamp - timestamp);

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const trade = this.tradeData[mid];
      const diff = Math.abs(trade.timestamp - timestamp);

      if (diff < minDiff) {
        minDiff = diff;
        closest = trade;
      }

      if (trade.timestamp < timestamp) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return closest;
  }

  /**
   * Run comprehensive backtest with strategy execution
   */
  async runBacktest(): Promise<BacktestResult> {
    logger.info("🚀 Starting backtest execution...");

    if (this.tradeData.length === 0) {
      logger.warn("⚠️  No trade data available for backtesting");
      return {
        totalReturn: 0,
        sharpeRatio: 0,
        maxDrawdown: 0,
        totalTrades: 0,
        winRate: 0,
        trades: [],
      };
    }

    const startTime = this.config.startDate.getTime();
    const endTime = this.config.endDate.getTime();

    // Filter trade data to backtest period
    const backtestTrades = this.getTradeDataInRange(startTime, endTime);
    logger.info(
      `📊 Running backtest on ${backtestTrades.length} trades from ${this.config.startDate.toISOString()} to ${this.config.endDate.toISOString()}`,
    );

    // Initialize backtest state
    this.currentTime = startTime;
    this.cash = this.config.initialCapital;
    this.positions.clear();
    this.executedTrades = [];
    this.portfolioValues = [];
    this.maxDrawdown = 0;
    this.peakValue = this.config.initialCapital;

    // Initial portfolio value
    this.updatePortfolioValue();

    // Process each time period in the backtest
    await this.executeBacktestPeriod(startTime, endTime);

    // Calculate final metrics
    return this.calculateBacktestResults();
  }

  /**
   * Execute backtest over the specified time period
   */
  private async executeBacktestPeriod(
    startTime: number,
    endTime: number,
  ): Promise<void> {
    // Get trades within the backtest period
    const backtestTrades = this.getTradeDataInRange(startTime, endTime);

    if (backtestTrades.length === 0) {
      logger.info("📊 No trades found in backtest period");
      return;
    }

    logger.info(
      `⏱️  Processing ${backtestTrades.length.toLocaleString()} trades for backtest simulation...`,
    );

    // Sample trades for efficient processing (every Nth trade for large datasets)
    const sampleSize = Math.min(backtestTrades.length, 10000); // Limit to 10K samples max
    const sampleStep = Math.max(
      1,
      Math.floor(backtestTrades.length / sampleSize),
    );

    let processedCount = 0;
    let strategyExecutions = 0;

    for (let i = 0; i < backtestTrades.length; i += sampleStep) {
      // Check for cancellation
      if (this.isCancelled) {
        logger.info("🛑 Backtest cancelled by user");
        break;
      }

      const trade = backtestTrades[i];
      this.currentTime = trade.timestamp;

      // Update market state based on actual trade
      this.updateMarketState(trade.timestamp);

      // Update portfolio value
      this.updatePortfolioValue();

      // Execute strategy if callback is set and enough time has passed
      if (this.strategyExecutionCoordinator) {
        try {
          const executed =
            await this.strategyExecutionCoordinator.executeIfIntervalElapsed(
              this.currentTime,
            );
          if (executed) {
            strategyExecutions++;
          }
        } catch (error) {
          logger.warn(
            `⚠️  Strategy execution error at ${new Date(this.currentTime).toISOString()}:`,
            error,
          );
        }
      }

      // Progress logging
      processedCount++;
      if (processedCount % 1000 === 0) {
        // Calculate actual progress based on position in array, not processed count
        const progress = ((i / backtestTrades.length) * 100).toFixed(1);
        // Calculate display count based on progress percentage of sampleSize
        const displayCount = Math.min(
          Math.round((i / backtestTrades.length) * sampleSize),
          sampleSize,
        );
        logger.info(
          `   📈 Backtest progress: ${progress}% (${displayCount.toLocaleString()}/${sampleSize.toLocaleString()} samples, ${strategyExecutions} strategy executions)`,
        );
      }

      // Yield control to event loop every 100 iterations to allow signal handlers to execute
      if (processedCount % 100 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    // Show final 100% progress message
    const finalCappedCount = Math.min(processedCount, sampleSize);
    logger.info(
      `   📈 Backtest progress: 100.0% (${sampleSize.toLocaleString()}/${sampleSize.toLocaleString()} samples, ${strategyExecutions} strategy executions)`,
    );

    // Final completion message with capped count
    logger.info(
      `✅ Backtest simulation completed with ${finalCappedCount.toLocaleString()} samples and ${strategyExecutions} strategy executions`,
    );
  }

  /**
   * Update market state for current time
   */
  private updateMarketState(timestamp: number): void {
    const currentTrade = this.findClosestTrade(timestamp);

    if (currentTrade) {
      this.currentMarketState.currentPrice = currentTrade.price;

      // Calculate 24h volume and volatility from recent trades
      const recentTrades = this.getTradeDataInRange(
        timestamp - 86400000,
        timestamp,
      ); // Last 24h

      if (recentTrades.length > 0) {
        this.currentMarketState.volume24h = recentTrades.reduce(
          (sum, trade) => sum + trade.volume,
          0,
        );

        // Calculate price volatility
        const prices = recentTrades.map((t) => t.price);
        const avgPrice =
          prices.reduce((sum, price) => sum + price, 0) / prices.length;
        const variance =
          prices.reduce(
            (sum, price) => sum + Math.pow(price - avgPrice, 2),
            0,
          ) / prices.length;
        this.currentMarketState.volatility = Math.sqrt(variance) / avgPrice;
      }
    }
  }

  /**
   * Calculate comprehensive backtest results
   */
  private calculateBacktestResults(): BacktestResult {
    logger.info(
      `🔍 Calculating results: ${this.executedTrades.length} executed trades found`,
    );

    if (this.executedTrades.length > 0) {
      logger.info(
        `📊 First few trades:`,
        this.executedTrades.slice(0, 3).map((t) => ({
          side: t.side,
          price: Number(t.price),
          quantity: Number(t.quantity),
          pnl: Number(t.pnl),
        })),
      );
    }

    const initialValue = Number(this.config.initialCapital);
    const finalValue = Number(this.calculatePortfolioValue());

    const totalReturn = (finalValue - initialValue) / initialValue;
    const sharpeRatio = this.calculateSharpeRatio();
    const winRate = this.calculateWinRate();

    const trades = this.executedTrades.map((trade) => ({
      timestamp: trade.timestamp,
      pair: trade.pair,
      side: trade.side,
      price: trade.price,
      quantity: trade.quantity,
      pnl: trade.pnl,
    }));

    const result = {
      totalReturn,
      sharpeRatio,
      maxDrawdown: this.maxDrawdown,
      totalTrades: this.executedTrades.length,
      winRate,
      trades,
    };

    logger.info(`📈 Final backtest result summary:`, {
      totalReturn: (result.totalReturn * 100).toFixed(2) + "%",
      totalTrades: result.totalTrades,
      winRate: (result.winRate * 100).toFixed(2) + "%",
      initialValue,
      finalValue,
    });

    return result;
  }

  /**
   * Calculate Sharpe ratio from daily returns
   */
  private calculateSharpeRatio(): number {
    if (this.portfolioValues.length < 2) return 0;

    // Calculate daily returns
    const returns: number[] = [];
    for (let i = 1; i < this.portfolioValues.length; i++) {
      const prevValue = Number(this.portfolioValues[i - 1].value);
      const currentValue = Number(this.portfolioValues[i].value);

      if (prevValue > 0) {
        returns.push((currentValue - prevValue) / prevValue);
      }
    }

    if (returns.length === 0) return 0;

    // Calculate mean and standard deviation
    const meanReturn =
      returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance =
      returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) /
      returns.length;
    const stdDev = Math.sqrt(variance);

    // Sharpe ratio (assuming risk-free rate of 0)
    return stdDev > 0 ? meanReturn / stdDev : 0;
  }

  /**
   * Calculate win rate from executed trades
   */
  private calculateWinRate(): number {
    if (this.executedTrades.length === 0) return 0;

    const winningTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) > 0,
    ).length;
    return winningTrades / this.executedTrades.length;
  }

  /**
   * Calculate Sortino ratio (downside deviation)
   */
  private calculateSortinoRatio(): number {
    if (this.portfolioValues.length < 2) return 0;

    // Calculate daily returns
    const returns: number[] = [];
    for (let i = 1; i < this.portfolioValues.length; i++) {
      const prevValue = Number(this.portfolioValues[i - 1].value);
      const currentValue = Number(this.portfolioValues[i].value);

      if (prevValue > 0) {
        returns.push((currentValue - prevValue) / prevValue);
      }
    }

    if (returns.length === 0) return 0;

    const meanReturn =
      returns.reduce((sum, ret) => sum + ret, 0) / returns.length;

    // Calculate downside deviation (only negative returns)
    const negativeReturns = returns.filter((ret) => ret < 0);
    if (negativeReturns.length === 0) return meanReturn > 0 ? Infinity : 0;

    const downsideVariance =
      negativeReturns.reduce((sum, ret) => sum + Math.pow(ret, 2), 0) /
      negativeReturns.length;
    const downsideDeviation = Math.sqrt(downsideVariance);

    return downsideDeviation > 0 ? meanReturn / downsideDeviation : 0;
  }

  async setCurrentTime(timestamp: number): Promise<void> {
    this.currentTime = timestamp;
    this.updateMarketState(timestamp);
  }

  async generateReport(): Promise<{
    summary: BacktestResult;
    dailyReturns: number[];
    drawdownCurve: number[];
    tradingMetrics: Record<string, unknown>;
  }> {
    logger.info("📈 Generating backtest report...");

    // Ensure all data is loaded before running backtest
    await this.ensureDataLoaded();

    const summary = await this.runBacktest();

    // Calculate daily returns
    const dailyReturns = this.calculateDailyReturns();

    // Generate drawdown curve
    const drawdownCurve = this.calculateDrawdownCurve();

    // Calculate advanced trading metrics
    const tradingMetrics = {
      dataQuality: this.validateTradeData(),
      totalDataPoints: this.tradeData.length,
      dataRange: this.getDataRange(),

      // Performance metrics
      totalReturn: summary.totalReturn,
      annualizedReturn: this.calculateAnnualizedReturn(summary.totalReturn),
      sharpeRatio: summary.sharpeRatio,
      sortinoRatio: this.calculateSortinoRatio(),
      maxDrawdown: summary.maxDrawdown,

      // Risk metrics
      volatility: this.calculateVolatility(dailyReturns),
      valueAtRisk: this.calculateVaR(dailyReturns, 0.05), // 5% VaR
      calmarRatio: summary.totalReturn / (summary.maxDrawdown || 1),

      // Trading metrics
      totalTrades: summary.totalTrades,
      winRate: summary.winRate,
      avgTradeReturn: this.calculateAverageTradeReturn(),
      profitFactor: this.calculateProfitFactor(),

      // Portfolio metrics
      initialCapital: Number(this.config.initialCapital),
      finalValue: Number(this.calculatePortfolioValue()),
      totalCommission: this.calculateTotalCommission(),
      totalSlippage: this.calculateTotalSlippage(),
    };

    return {
      summary,
      dailyReturns,
      drawdownCurve,
      tradingMetrics,
    };
  }

  /**
   * Calculate daily returns from portfolio values
   */
  private calculateDailyReturns(): number[] {
    const returns: number[] = [];

    if (this.portfolioValues.length < 2) return returns;

    for (let i = 1; i < this.portfolioValues.length; i++) {
      const prevValue = Number(this.portfolioValues[i - 1].value);
      const currentValue = Number(this.portfolioValues[i].value);

      if (prevValue > 0) {
        returns.push((currentValue - prevValue) / prevValue);
      }
    }

    return returns;
  }

  /**
   * Calculate drawdown curve
   */
  private calculateDrawdownCurve(): number[] {
    const drawdowns: number[] = [];
    let runningPeak = 0;

    for (const point of this.portfolioValues) {
      const value = Number(point.value);
      runningPeak = Math.max(runningPeak, value);

      const drawdown =
        runningPeak > 0 ? (runningPeak - value) / runningPeak : 0;
      drawdowns.push(drawdown);
    }

    return drawdowns;
  }

  /**
   * Calculate annualized return
   */
  private calculateAnnualizedReturn(totalReturn: number): number {
    const startTime = this.config.startDate.getTime();
    const endTime = this.config.endDate.getTime();
    const durationYears =
      (endTime - startTime) / (365.25 * 24 * 60 * 60 * 1000);

    if (durationYears <= 0) return 0;

    return Math.pow(1 + totalReturn, 1 / durationYears) - 1;
  }

  /**
   * Calculate portfolio volatility
   */
  private calculateVolatility(returns: number[]): number {
    if (returns.length === 0) return 0;

    const meanReturn =
      returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance =
      returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) /
      returns.length;

    return Math.sqrt(variance);
  }

  /**
   * Calculate Value at Risk (VaR)
   */
  private calculateVaR(returns: number[], confidence: number): number {
    if (returns.length === 0) return 0;

    const sortedReturns = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * sortedReturns.length);

    return Math.abs(sortedReturns[index] || 0);
  }

  /**
   * Calculate average trade return
   */
  private calculateAverageTradeReturn(): number {
    if (this.executedTrades.length === 0) return 0;

    const totalPnL = this.executedTrades.reduce(
      (sum, trade) => sum + Number(trade.pnl),
      0,
    );
    return totalPnL / this.executedTrades.length;
  }

  /**
   * Calculate profit factor
   */
  private calculateProfitFactor(): number {
    const winningTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) > 0,
    );
    const losingTrades = this.executedTrades.filter(
      (trade) => Number(trade.pnl) < 0,
    );

    const grossProfit = winningTrades.reduce(
      (sum, trade) => sum + Number(trade.pnl),
      0,
    );
    const grossLoss = Math.abs(
      losingTrades.reduce((sum, trade) => sum + Number(trade.pnl), 0),
    );

    return grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Infinity
        : 0;
  }

  /**
   * Calculate total commission paid
   */
  private calculateTotalCommission(): number {
    return this.executedTrades.reduce(
      (sum, trade) => sum + Number(trade.commission),
      0,
    );
  }

  /**
   * Calculate total slippage cost
   */
  private calculateTotalSlippage(): number {
    return this.executedTrades.reduce(
      (sum, trade) => sum + Number(trade.slippage),
      0,
    );
  }

  /**
   * Validate the quality and completeness of loaded trade data
   */
  private validateTradeData(): {
    isValid: boolean;
    issues: string[];
    coverage: number;
  } {
    const issues: string[] = [];

    if (this.tradeData.length === 0) {
      issues.push("No trade data loaded");
      return { isValid: false, issues, coverage: 0 };
    }

    // Check for data gaps
    const timestamps = this.tradeData
      .map((t) => t.timestamp)
      .sort((a, b) => a - b);
    const gaps = [];
    const sampleSize = Math.min(1000, timestamps.length); // Sample to avoid performance issues
    const step = Math.floor(timestamps.length / sampleSize);

    for (let i = step; i < timestamps.length; i += step) {
      const gap = timestamps[i] - timestamps[i - step];
      if (gap > 300000 * step) {
        // 5 minutes * step
        gaps.push(gap);
      }
    }

    if (gaps.length > 0) {
      issues.push(`Found ${gaps.length} potential data gaps in sample`);
    }

    // Check for price anomalies using a sample
    const priceSample = this.tradeData
      .filter(
        (_, index) => index % Math.floor(this.tradeData.length / 1000) === 0,
      )
      .map((t) => t.price)
      .sort((a, b) => a - b);

    if (priceSample.length > 0) {
      const medianPrice = priceSample[Math.floor(priceSample.length / 2)];
      const priceOutliers = priceSample.filter(
        (p) => p > medianPrice * 2 || p < medianPrice * 0.5,
      );

      if (priceOutliers.length > 0) {
        issues.push(
          `Found ${priceOutliers.length} potential price outliers in sample`,
        );
      }
    }

    const coverage = this.calculateDataCoverage();

    return {
      isValid: issues.length === 0,
      issues,
      coverage,
    };
  }

  /**
   * Calculate data coverage percentage for the configured backtest period
   */
  private calculateDataCoverage(): number {
    if (this.tradeData.length === 0) return 0;

    const startTime = this.config.startDate.getTime();
    const endTime = this.config.endDate.getTime();
    const configPeriod = endTime - startTime;

    // Calculate min/max efficiently
    let firstTrade = Number.MAX_VALUE;
    let lastTrade = Number.MIN_VALUE;

    for (const trade of this.tradeData) {
      firstTrade = Math.min(firstTrade, trade.timestamp);
      lastTrade = Math.max(lastTrade, trade.timestamp);
    }

    const actualPeriod = lastTrade - firstTrade;

    return Math.min(100, (actualPeriod / configPeriod) * 100);
  }

  /**
   * Get data range information
   */
  private getDataRange(): {
    start: Date;
    end: Date;
    duration: string;
    tradeCount: number;
  } {
    if (this.tradeData.length === 0) {
      return {
        start: new Date(0),
        end: new Date(0),
        duration: "No data",
        tradeCount: 0,
      };
    }

    const firstTrade = this.tradeData[0];
    const lastTrade = this.tradeData[this.tradeData.length - 1];
    const durationMs = lastTrade.timestamp - firstTrade.timestamp;
    const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24));

    return {
      start: new Date(firstTrade.timestamp),
      end: new Date(lastTrade.timestamp),
      duration: `${durationDays} days`,
      tradeCount: this.tradeData.length,
    };
  }
}

export type {
  BacktestConfig,
  BacktestResult,
  DataFileInfo,
  MarketState,
  OrderBookSnapshot,
  TradeData,
};
