/**
 * Strategy Utilities for CLI
 *
 * Provides utilities for listing and displaying available strategies.
 */

import fs from "fs";
import path from "path";
import pc from "picocolors";
import { BUILTIN_STRATEGIES } from "@/domains/strategies/builtin";
import {
  IStrategy,
  IStrategyFactory,
  StrategyConfig,
  StrategyParameters,
} from "@/domains/strategies/core/i-strategy";
import {
  RegisteredStrategy,
  strategyRegistry,
} from "@/domains/strategies/management/strategy-registry";
import {
  getNumberProp,
  isRecord,
  type UnknownRecord,
} from "@/shared/utils/record-utils";

const hasFactoryShape = (value: unknown): value is IStrategyFactory => {
  if (typeof value === "function") {
    return "createStrategy" in value;
  }
  return isRecord(value) && typeof value.createStrategy === "function";
};

type StrategyConstructor = new () => IStrategy;

const getStrategyConstructor = (
  value: unknown,
): StrategyConstructor | undefined =>
  typeof value === "function" &&
  isRecord((value as { prototype?: unknown }).prototype) &&
  typeof (value as { prototype: UnknownRecord }).prototype.initialize ===
    "function" &&
  typeof (value as { prototype: UnknownRecord }).prototype.execute ===
    "function" &&
  typeof (value as { prototype: UnknownRecord }).prototype
    .validateParameters === "function" &&
  typeof (value as { prototype: UnknownRecord }).prototype.updateParameters ===
    "function" &&
  typeof (value as { prototype: UnknownRecord }).prototype.cleanup ===
    "function"
    ? (value as StrategyConstructor)
    : undefined;

const createPlaceholderConfig = (
  filePath: string,
  exportName?: string,
): StrategyConfig => ({
  id: `custom.${path.basename(filePath, path.extname(filePath))}.${exportName || "default"}`,
  name: `Custom Strategy (${exportName || "default"})`,
  description: "Custom strategy loaded for inspection",
  version: "0.0.0",
  author: "Custom User",
  supportedPairs: ["*"],
  category: "custom",
  riskLevel: 1,
  minCapital: 0,
  parametersSchema: {},
});

export interface StrategyDisplayInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  category: string;
  description: string;
  riskLevel: number;
  minCapital: number;
  supportedPairs: string[];
  tags: string[];
  examples: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    expectedReturn?: number;
    riskLevel?: number;
  }>;
}

/**
 * Initialize built-in strategies in the registry
 */
export async function initializeBuiltinStrategies(): Promise<void> {
  try {
    for (const { factory, config, metadata } of BUILTIN_STRATEGIES) {
      try {
        await strategyRegistry.registerStrategy(config, factory, metadata);
      } catch (error) {
        // Strategy might already be registered, which is fine
        if (
          error instanceof Error &&
          !error.message.includes("already registered")
        ) {
          console.warn(
            pc.yellow(
              `Warning: Failed to register strategy ${config.name}: ${error.message}`,
            ),
          );
        }
      }
    }
  } catch (error) {
    console.warn(
      pc.yellow(
        `Warning: Failed to initialize some built-in strategies: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Scan directory for strategy files and load them
 */
async function loadStrategiesFromDirectory(directory: string): Promise<void> {
  try {
    if (!fs.existsSync(directory)) {
      console.warn(
        pc.yellow(`Warning: Strategy directory does not exist: ${directory}`),
      );
      return;
    }

    const stats = fs.statSync(directory);
    if (!stats.isDirectory()) {
      console.warn(pc.yellow(`Warning: Path is not a directory: ${directory}`));
      return;
    }

    console.log(pc.gray(`🔍 Scanning strategy directory: ${directory}`));

    // Recursively find all .ts and .js files
    const strategyFiles = findStrategyFiles(directory);

    for (const filePath of strategyFiles) {
      try {
        await loadStrategyFromFile(filePath);
      } catch (error) {
        console.warn(
          pc.yellow(
            `Warning: Failed to load strategy from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  } catch (error) {
    console.warn(
      pc.yellow(
        `Warning: Failed to scan directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Recursively find all strategy files in a directory
 */
function findStrategyFiles(directory: string): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(directory);

    for (const entry of entries) {
      const fullPath = path.join(directory, entry);
      const stats = fs.statSync(fullPath);

      if (
        stats.isDirectory() &&
        !entry.startsWith(".") &&
        entry !== "node_modules"
      ) {
        // Recursively scan subdirectories
        files.push(...findStrategyFiles(fullPath));
      } else if (
        stats.isFile() &&
        (entry.endsWith(".ts") || entry.endsWith(".js"))
      ) {
        // Only include TypeScript and JavaScript files
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.warn(
      pc.yellow(
        `Warning: Failed to read directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  return files;
}

/**
 * Load strategy from a specific file
 */
async function loadStrategyFromFile(filePath: string): Promise<void> {
  try {
    // For TypeScript files, we need to compile them first or use ts-node
    // For now, we'll focus on compiled JavaScript files
    if (filePath.endsWith(".ts")) {
      console.warn(
        pc.yellow(
          `Warning: TypeScript files require compilation. Please compile ${filePath} to JavaScript first.`,
        ),
      );
      return;
    }

    // Dynamically import the strategy file
    const strategyModule = await import(path.resolve(filePath));

    // Look for strategy exports - try common export patterns
    const possibleExports = [
      "default",
      "strategy",
      "strategies",
      "STRATEGIES",
      "EXAMPLE_STRATEGIES",
    ];

    for (const exportName of possibleExports) {
      if (strategyModule[exportName]) {
        await processStrategyExport(strategyModule[exportName], filePath);
      }
    }

    // Also check for named strategy exports (look for Factory suffix)
    for (const [key, value] of Object.entries(strategyModule)) {
      if (key.endsWith("Factory") || key.endsWith("Strategy")) {
        await processStrategyExport(value, filePath, key);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to import strategy from ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Process a strategy export and register it
 */
async function processStrategyExport(
  exportValue: unknown,
  filePath: string,
  exportName?: string,
): Promise<void> {
  try {
    // Handle object with multiple strategies (like EXAMPLE_STRATEGIES)
    if (isRecord(exportValue) && !("config" in exportValue)) {
      for (const [key, strategy] of Object.entries(exportValue)) {
        if (isRecord(strategy)) {
          await processStrategyExport(strategy, filePath, key);
        }
      }
      return;
    }

    // Handle individual strategy with config and factory
    if (isRecord(exportValue) && exportValue.config && exportValue.factory) {
      const config = exportValue.config as StrategyConfig;
      const factory = exportValue.factory as IStrategyFactory;
      const metadata =
        (exportValue.metadata as RegisteredStrategy["metadata"]) || {
          tags: ["custom", "user-defined"],
          documentation: `Custom strategy loaded from ${path.basename(filePath)}`,
        };

      // Add source file info to config
      const enhancedConfig = {
        ...config,
        id:
          config.id ||
          `custom.${path.basename(filePath, path.extname(filePath))}.${exportName || "default"}`,
        author: config.author || "Custom User",
        sourceFile: filePath,
      };

      await strategyRegistry.registerStrategy(
        enhancedConfig,
        factory,
        metadata,
      );
      console.log(
        pc.green(
          `✅ Custom strategy '${enhancedConfig.name}' loaded from ${path.basename(filePath)}`,
        ),
      );
    }

    // Handle factory function directly
    else if (typeof exportValue === "function") {
      // Try to create a strategy instance to get config
      try {
        if (hasFactoryShape(exportValue)) {
          const placeholderConfig = createPlaceholderConfig(
            filePath,
            exportName,
          );
          const strategyInstance = exportValue.createStrategy(
            placeholderConfig,
            {} as StrategyParameters,
          );
          if (strategyInstance.config) {
            const config = {
              ...strategyInstance.config,
              id:
                strategyInstance.config.id ||
                `custom.${path.basename(filePath, path.extname(filePath))}.${exportName || "default"}`,
              author: strategyInstance.config.author || "Custom User",
              sourceFile: filePath,
            };

            const metadata = {
              tags: ["custom", "user-defined"],
              documentation: `Custom strategy loaded from ${path.basename(filePath)}`,
            };

            await strategyRegistry.registerStrategy(
              config,
              exportValue,
              metadata,
            );
            console.log(
              pc.green(
                `✅ Custom strategy '${config.name}' loaded from ${path.basename(filePath)}`,
              ),
            );
          }
          return;
        }

        const StrategyConstructor = getStrategyConstructor(exportValue);
        if (!StrategyConstructor) {
          return;
        }

        const strategyInstance = new StrategyConstructor();
        if (strategyInstance && isRecord(strategyInstance.config)) {
          const config = {
            ...(strategyInstance.config as StrategyConfig),
            id:
              strategyInstance.config.id ||
              `custom.${path.basename(filePath, path.extname(filePath))}.${exportName || "default"}`,
            author: strategyInstance.config.author || "Custom User",
            sourceFile: filePath,
          };

          const metadata = {
            tags: ["custom", "user-defined"],
            documentation: `Custom strategy loaded from ${path.basename(filePath)}`,
          };

          const constructorFactory: IStrategyFactory = {
            createStrategy: () => new StrategyConstructor(),
          };

          await strategyRegistry.registerStrategy(
            config,
            constructorFactory,
            metadata,
          );
          console.log(
            pc.green(
              `✅ Custom strategy '${config.name}' loaded from ${path.basename(filePath)}`,
            ),
          );
        }
      } catch (_error) {
        // Ignore errors when trying to instantiate - might not be a strategy
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      !error.message.includes("already registered")
    ) {
      console.warn(
        pc.yellow(
          `Warning: Failed to register strategy from ${filePath}: ${error.message}`,
        ),
      );
    }
  }
}

/**
 * Get all available strategies from the registry
 */
export async function getAvailableStrategies(
  customDirectories: string[] = [],
): Promise<StrategyDisplayInfo[]> {
  await initializeBuiltinStrategies();

  // Load strategies from custom directories
  for (const directory of customDirectories) {
    await loadStrategiesFromDirectory(directory);
  }

  const registeredStrategies = strategyRegistry.getAllStrategies();

  return registeredStrategies.map((strategy) => convertToDisplayInfo(strategy));
}

/**
 * Get strategies filtered by category
 */
export async function getStrategiesByCategory(
  category: string,
  customDirectories: string[] = [],
): Promise<StrategyDisplayInfo[]> {
  await initializeBuiltinStrategies();

  // Load strategies from custom directories
  for (const directory of customDirectories) {
    await loadStrategiesFromDirectory(directory);
  }

  const strategies = strategyRegistry.getStrategiesByCategory(category);

  return strategies.map((strategy) => convertToDisplayInfo(strategy));
}

/**
 * Search strategies with filters
 */
export async function searchStrategies(
  filters: {
    category?: string[];
    riskLevel?: { min?: number; max?: number };
    tags?: string[];
    author?: string;
  },
  customDirectories: string[] = [],
): Promise<StrategyDisplayInfo[]> {
  await initializeBuiltinStrategies();

  // Load strategies from custom directories
  for (const directory of customDirectories) {
    await loadStrategiesFromDirectory(directory);
  }

  const searchResult = strategyRegistry.searchStrategies(filters);

  return searchResult.strategies.map((strategy) =>
    convertToDisplayInfo(strategy),
  );
}

/**
 * Get strategy by ID
 */
export async function getStrategyById(
  strategyId: string,
): Promise<StrategyDisplayInfo | null> {
  await initializeBuiltinStrategies();

  const strategy = strategyRegistry.getStrategy(strategyId);

  return strategy ? convertToDisplayInfo(strategy) : null;
}

/**
 * Display strategies in a formatted table
 */
export function displayStrategiesTable(
  strategies: StrategyDisplayInfo[],
): void {
  if (strategies.length === 0) {
    console.log(pc.yellow("No strategies found."));
    return;
  }

  console.log(pc.cyan("\n📊 Available Strategies:\n"));

  strategies.forEach((strategy, index) => {
    const riskColor =
      strategy.riskLevel <= 3
        ? pc.green
        : strategy.riskLevel <= 6
          ? pc.yellow
          : pc.red;
    const pairsDisplay = strategy.supportedPairs.slice(0, 3).join(", ");

    console.log(
      `${index + 1}. ${pc.bold(strategy.name)} ${pc.gray(`v${strategy.version}`)}`,
    );
    console.log(
      `   Category: ${strategy.category} | Risk: ${riskColor(`${strategy.riskLevel}/10`)} | Min Capital: $${strategy.minCapital}`,
    );
    console.log(
      `   Pairs: ${pairsDisplay}${strategy.supportedPairs.length > 3 ? "..." : ""}`,
    );
    console.log(`   ${strategy.description}`);

    if (index < strategies.length - 1) {
      console.log();
    }
  });

  console.log();
}

/**
 * Display detailed information for a specific strategy
 */
export function displayStrategyDetails(strategy: StrategyDisplayInfo): void {
  console.log(pc.cyan(`\n📋 Strategy Details: ${pc.bold(strategy.name)}\n`));

  console.log(pc.bold("Basic Information:"));
  console.log(`   ID: ${strategy.id}`);
  console.log(`   Name: ${strategy.name}`);
  console.log(`   Version: ${strategy.version}`);
  console.log(`   Author: ${strategy.author}`);
  console.log(`   Category: ${strategy.category}`);
  console.log(`   Description: ${strategy.description}`);

  const riskColor =
    strategy.riskLevel <= 3
      ? pc.green
      : strategy.riskLevel <= 6
        ? pc.yellow
        : pc.red;
  console.log(`   Risk Level: ${riskColor(`${strategy.riskLevel}/10`)}`);
  console.log(`   Minimum Capital: $${strategy.minCapital}`);

  console.log(
    `\n${pc.bold("Supported Trading Pairs:")} ${strategy.supportedPairs.join(", ")}`,
  );

  if (strategy.tags.length > 0) {
    console.log(
      `\n${pc.bold("Tags:")} ${strategy.tags.map((tag) => pc.gray(`#${tag}`)).join(" ")}`,
    );
  }

  if (strategy.examples.length > 0) {
    console.log(`\n${pc.bold("Example Configurations:")}`);
    strategy.examples.forEach((example, index) => {
      console.log(`\n   ${pc.bold(`${index + 1}. ${example.name}`)}`);
      console.log(`      ${example.description}`);
      if (example.expectedReturn) {
        console.log(
          `      Expected Return: ${pc.green(`${example.expectedReturn}%`)}`,
        );
      }
      if (example.riskLevel) {
        const exampleRiskColor =
          example.riskLevel <= 3
            ? pc.green
            : example.riskLevel <= 6
              ? pc.yellow
              : pc.red;
        console.log(
          `      Risk Level: ${exampleRiskColor(`${example.riskLevel}/10`)}`,
        );
      }
      console.log(
        `      Parameters: ${pc.gray(JSON.stringify(example.parameters, null, 8))}`,
      );
    });
  }

  console.log();
}

/**
 * Display strategies by category
 */
export function displayStrategiesByCategory(
  strategies: StrategyDisplayInfo[],
): void {
  const categorized = strategies.reduce(
    (acc, strategy) => {
      if (!acc[strategy.category]) {
        acc[strategy.category] = [];
      }
      acc[strategy.category].push(strategy);
      return acc;
    },
    {} as Record<string, StrategyDisplayInfo[]>,
  );

  Object.entries(categorized).forEach(([category, categoryStrategies]) => {
    console.log(
      pc.cyan(
        `\n📂 ${pc.bold(category.toUpperCase())} (${categoryStrategies.length} strategies)`,
      ),
    );

    categoryStrategies.forEach((strategy) => {
      const riskColor =
        strategy.riskLevel <= 3
          ? pc.green
          : strategy.riskLevel <= 6
            ? pc.yellow
            : pc.red;
      console.log(`   ${pc.bold(strategy.name)} - ${strategy.description}`);
      console.log(
        `      Risk: ${riskColor(`${strategy.riskLevel}/10`)} | Min Capital: $${strategy.minCapital} | Pairs: ${strategy.supportedPairs.slice(0, 3).join(", ")}`,
      );
    });
  });

  console.log();
}

/**
 * Get available categories
 */
export async function getAvailableCategories(): Promise<string[]> {
  const strategies = await getAvailableStrategies();
  const categories = [...new Set(strategies.map((s) => s.category))];
  return categories.sort();
}

/**
 * Get available tags
 */
export async function getAvailableTags(): Promise<string[]> {
  const strategies = await getAvailableStrategies();
  const tags = [...new Set(strategies.flatMap((s) => s.tags))];
  return tags.sort();
}

/**
 * Validate strategy configuration parameters
 */
export function validateStrategyConfig(
  strategyId: string,
  parameters: Record<string, unknown>,
): { isValid: boolean; errors: string[] } {
  // Basic validation - in a real implementation, this would use the strategy's validateParameters method
  const errors: string[] = [];

  if (!parameters.pair && !parameters.allocationTargets) {
    errors.push("Trading pair is required for most strategies");
  }

  const totalAmountUsd = getNumberProp(parameters, "totalAmountUsd");
  if (totalAmountUsd !== undefined && totalAmountUsd <= 0) {
    errors.push("Total amount must be positive");
  }

  const riskLevel = getNumberProp(parameters, "riskLevel");
  if (riskLevel !== undefined && (riskLevel < 1 || riskLevel > 10)) {
    errors.push("Risk level must be between 1 and 10");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Convert RegisteredStrategy to StrategyDisplayInfo
 */
function convertToDisplayInfo(
  strategy: RegisteredStrategy,
): StrategyDisplayInfo {
  return {
    id: strategy.config.id,
    name: strategy.config.name,
    version: strategy.config.version,
    author: strategy.config.author,
    category: strategy.config.category,
    description: strategy.config.description,
    riskLevel: strategy.config.riskLevel,
    minCapital: strategy.config.minCapital,
    supportedPairs: strategy.config.supportedPairs,
    tags: strategy.metadata.tags,
    examples: strategy.metadata.examples || [],
  };
}
