/**
 * Strategy Registry
 *
 * Central registry for managing custom strategies. Handles strategy registration,
 * discovery, versioning, and dependency management.
 */

import {
  IStrategy,
  IStrategyFactory,
  StrategyConfig,
  StrategyContext,
  StrategyParameters,
} from "@/domains/strategies/core/i-strategy";

export interface RegisteredStrategy {
  config: StrategyConfig;
  factory: IStrategyFactory;
  registeredAt: number;
  isActive: boolean;
  instances: Map<string, IStrategy>;
  metadata: StrategyMetadata;
}

export interface StrategyMetadata {
  tags: string[];
  documentation?: string;
  examples?: StrategyExample[];
  dependencies?: string[];
  minSdkVersion?: string;
  maxSdkVersion?: string;
  license?: string;
  repositoryUrl?: string;
}

export interface StrategyExample {
  name: string;
  description: string;
  parameters: StrategyParameters;
  expectedReturn?: number;
  riskLevel?: number;
}

export interface StrategyFilter {
  category?: string[];
  riskLevel?: { min?: number; max?: number };
  minCapital?: { min?: number; max?: number };
  tags?: string[];
  author?: string;
  version?: string;
  supportedPairs?: string[];
}

export interface StrategySearchResult {
  strategies: RegisteredStrategy[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Strategy Registry manages all registered strategies
 */
export class StrategyRegistry {
  private strategies: Map<string, RegisteredStrategy> = new Map();
  private versionMap: Map<string, Set<string>> = new Map(); // strategy name -> versions
  private categoryIndex: Map<string, Set<string>> = new Map(); // category -> strategy ids
  private tagIndex: Map<string, Set<string>> = new Map(); // tag -> strategy ids
  private authorIndex: Map<string, Set<string>> = new Map(); // author -> strategy ids

  /**
   * Register a new strategy
   */
  async registerStrategy(
    config: StrategyConfig,
    factory: IStrategyFactory,
    metadata: StrategyMetadata = { tags: [] },
  ): Promise<void> {
    // Validate configuration
    await this.validateStrategyConfig(config);

    // Check for conflicts
    const existingStrategy = this.strategies.get(config.id);
    if (existingStrategy) {
      throw new Error(`Strategy with id '${config.id}' is already registered`);
    }

    // Validate version format
    if (!this.isValidVersion(config.version)) {
      throw new Error(`Invalid version format: ${config.version}`);
    }

    // Check SDK compatibility
    if (
      metadata.minSdkVersion &&
      !this.isCompatibleVersion(metadata.minSdkVersion, "min")
    ) {
      throw new Error(
        `Strategy requires minimum SDK version ${metadata.minSdkVersion}`,
      );
    }
    if (
      metadata.maxSdkVersion &&
      !this.isCompatibleVersion(metadata.maxSdkVersion, "max")
    ) {
      throw new Error(
        `Strategy requires maximum SDK version ${metadata.maxSdkVersion}`,
      );
    }

    // Register strategy
    const registeredStrategy: RegisteredStrategy = {
      config,
      factory,
      registeredAt: Date.now(),
      isActive: true,
      instances: new Map(),
      metadata,
    };

    this.strategies.set(config.id, registeredStrategy);

    // Update indices
    this.updateIndices(config, metadata);

    console.log(
      `✅ Strategy '${config.name}' v${config.version} registered successfully`,
    );
  }

  /**
   * Unregister a strategy
   */
  async unregisterStrategy(strategyId: string): Promise<void> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`Strategy '${strategyId}' not found`);
    }

    // Cleanup all instances
    for (const [instanceId, instance] of strategy.instances) {
      try {
        await instance.cleanup({} as StrategyContext); // Context will be provided by StrategyManager
      } catch (error) {
        console.warn(
          `Warning: Failed to cleanup strategy instance ${instanceId}:`,
          error,
        );
      }
    }

    // Remove from indices
    this.removeFromIndices(strategy.config, strategy.metadata);

    // Remove from registry
    this.strategies.delete(strategyId);

    console.log(
      `✅ Strategy '${strategy.config.name}' unregistered successfully`,
    );
  }

  /**
   * Get strategy by ID
   */
  getStrategy(strategyId: string): RegisteredStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  /**
   * Search strategies with filters
   */
  searchStrategies(
    filter: StrategyFilter = {},
    page = 1,
    pageSize = 20,
  ): StrategySearchResult {
    let matchingIds = new Set<string>(this.strategies.keys());

    // Apply filters
    if (filter.category && filter.category.length > 0) {
      const categoryMatches = new Set<string>();
      filter.category.forEach((cat) => {
        const ids = this.categoryIndex.get(cat);
        if (ids) {
          ids.forEach((id) => categoryMatches.add(id));
        }
      });
      matchingIds = new Set(
        [...matchingIds].filter((id) => categoryMatches.has(id)),
      );
    }

    if (filter.tags && filter.tags.length > 0) {
      const tagMatches = new Set<string>();
      filter.tags.forEach((tag) => {
        const ids = this.tagIndex.get(tag);
        if (ids) {
          ids.forEach((id) => tagMatches.add(id));
        }
      });
      matchingIds = new Set(
        [...matchingIds].filter((id) => tagMatches.has(id)),
      );
    }

    if (filter.author) {
      const authorMatches = this.authorIndex.get(filter.author) || new Set();
      matchingIds = new Set(
        [...matchingIds].filter((id) => authorMatches.has(id)),
      );
    }

    // Filter by other criteria
    const filteredStrategies = [...matchingIds]
      .map((id) => this.strategies.get(id))
      .filter((strategy): strategy is RegisteredStrategy => {
        if (!strategy) {
          return false;
        }
        if (filter.riskLevel) {
          if (
            filter.riskLevel.min &&
            strategy.config.riskLevel < filter.riskLevel.min
          )
            return false;
          if (
            filter.riskLevel.max &&
            strategy.config.riskLevel > filter.riskLevel.max
          )
            return false;
        }

        if (filter.minCapital) {
          if (
            filter.minCapital.min &&
            strategy.config.minCapital < filter.minCapital.min
          )
            return false;
          if (
            filter.minCapital.max &&
            strategy.config.minCapital > filter.minCapital.max
          )
            return false;
        }

        if (filter.version && strategy.config.version !== filter.version)
          return false;

        if (filter.supportedPairs && filter.supportedPairs.length > 0) {
          const hasMatchingPair = filter.supportedPairs.some((pair) =>
            strategy.config.supportedPairs.includes(pair),
          );
          if (!hasMatchingPair) return false;
        }

        return strategy.isActive;
      });

    // Pagination
    const total = filteredStrategies.length;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedStrategies = filteredStrategies.slice(startIndex, endIndex);

    return {
      strategies: paginatedStrategies,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get all strategies by category
   */
  getStrategiesByCategory(category: string): RegisteredStrategy[] {
    const strategyIds = this.categoryIndex.get(category) || new Set();
    return [...strategyIds]
      .map((id) => this.strategies.get(id))
      .filter((strategy): strategy is RegisteredStrategy => !!strategy)
      .filter((strategy) => strategy.isActive);
  }

  /**
   * Get all strategies by author
   */
  getStrategiesByAuthor(author: string): RegisteredStrategy[] {
    const strategyIds = this.authorIndex.get(author) || new Set();
    return [...strategyIds]
      .map((id) => this.strategies.get(id))
      .filter((strategy): strategy is RegisteredStrategy => !!strategy)
      .filter((strategy) => strategy.isActive);
  }

  /**
   * Get strategy versions
   */
  getStrategyVersions(strategyName: string): string[] {
    const versions = this.versionMap.get(strategyName) || new Set();
    return [...versions].sort(this.compareVersions);
  }

  /**
   * Get latest version of a strategy
   */
  getLatestVersion(strategyName: string): RegisteredStrategy | undefined {
    const versions = this.getStrategyVersions(strategyName);
    if (versions.length === 0) return undefined;

    const latestVersion = versions[versions.length - 1];
    return [...this.strategies.values()].find(
      (s) =>
        s.config.name === strategyName && s.config.version === latestVersion,
    );
  }

  /**
   * Create strategy instance
   */
  async createInstance(
    strategyId: string,
    instanceId: string,
    parameters: StrategyParameters,
  ): Promise<IStrategy> {
    const registeredStrategy = this.strategies.get(strategyId);
    if (!registeredStrategy) {
      throw new Error(`Strategy '${strategyId}' not found`);
    }

    if (!registeredStrategy.isActive) {
      throw new Error(`Strategy '${strategyId}' is not active`);
    }

    if (registeredStrategy.instances.has(instanceId)) {
      throw new Error(`Strategy instance '${instanceId}' already exists`);
    }

    // Create instance
    const instance = registeredStrategy.factory.createStrategy(
      registeredStrategy.config,
      parameters,
    );

    // Validate parameters
    const validationErrors = await instance.validateParameters(parameters);
    if (validationErrors.length > 0) {
      throw new Error(
        `Parameter validation failed: ${validationErrors.join(", ")}`,
      );
    }

    // Store instance
    registeredStrategy.instances.set(instanceId, instance);

    return instance;
  }

  /**
   * Remove strategy instance
   */
  async removeInstance(strategyId: string, instanceId: string): Promise<void> {
    const registeredStrategy = this.strategies.get(strategyId);
    if (!registeredStrategy) {
      throw new Error(`Strategy '${strategyId}' not found`);
    }

    const instance = registeredStrategy.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Strategy instance '${instanceId}' not found`);
    }

    // Cleanup instance
    try {
      await instance.cleanup({} as StrategyContext); // Context will be provided by StrategyManager
    } catch (error) {
      console.warn(
        `Warning: Failed to cleanup strategy instance ${instanceId}:`,
        error,
      );
    }

    // Remove instance
    registeredStrategy.instances.delete(instanceId);
  }

  /**
   * Get all registered strategies
   */
  getAllStrategies(): RegisteredStrategy[] {
    return [...this.strategies.values()].filter((s) => s.isActive);
  }

  /**
   * Get strategy statistics
   */
  getRegistryStats(): {
    totalStrategies: number;
    activeStrategies: number;
    totalInstances: number;
    categoriesCount: number;
    authorsCount: number;
    avgRiskLevel: number;
  } {
    const strategies = [...this.strategies.values()];
    const activeStrategies = strategies.filter((s) => s.isActive);
    const totalInstances = strategies.reduce(
      (sum, s) => sum + s.instances.size,
      0,
    );
    const avgRiskLevel =
      activeStrategies.length > 0
        ? activeStrategies.reduce((sum, s) => sum + s.config.riskLevel, 0) /
          activeStrategies.length
        : 0;

    return {
      totalStrategies: strategies.length,
      activeStrategies: activeStrategies.length,
      totalInstances,
      categoriesCount: this.categoryIndex.size,
      authorsCount: this.authorIndex.size,
      avgRiskLevel,
    };
  }

  /**
   * Export strategy configurations
   */
  exportStrategies(): Array<{
    config: StrategyConfig;
    metadata: StrategyMetadata;
  }> {
    return [...this.strategies.values()]
      .filter((s) => s.isActive)
      .map((s) => ({ config: s.config, metadata: s.metadata }));
  }

  /**
   * Import strategy configurations
   */
  async importStrategies(
    strategies: Array<{
      config: StrategyConfig;
      metadata: StrategyMetadata;
      factory: IStrategyFactory;
    }>,
  ): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];

    for (const { config, metadata, factory } of strategies) {
      try {
        await this.registerStrategy(config, factory, metadata);
        imported++;
      } catch (error) {
        errors.push(
          `Failed to import ${config.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { imported, errors };
  }

  // Private helper methods
  private async validateStrategyConfig(config: StrategyConfig): Promise<void> {
    const errors: string[] = [];

    if (!config.id || config.id.trim() === "")
      errors.push("Strategy ID is required");
    if (!config.name || config.name.trim() === "")
      errors.push("Strategy name is required");
    if (!config.version || config.version.trim() === "")
      errors.push("Strategy version is required");
    if (!config.author || config.author.trim() === "")
      errors.push("Strategy author is required");
    if (config.riskLevel < 1 || config.riskLevel > 10)
      errors.push("Risk level must be between 1 and 10");
    if (config.minCapital < 0)
      errors.push("Minimum capital cannot be negative");
    if (!config.supportedPairs || config.supportedPairs.length === 0) {
      errors.push("At least one supported trading pair is required");
    }

    if (errors.length > 0) {
      throw new Error(
        `Strategy configuration validation failed: ${errors.join(", ")}`,
      );
    }
  }

  private updateIndices(
    config: StrategyConfig,
    metadata: StrategyMetadata,
  ): void {
    // Category index
    if (!this.categoryIndex.has(config.category)) {
      this.categoryIndex.set(config.category, new Set());
    }
    const categorySet = this.categoryIndex.get(config.category);
    if (categorySet) {
      categorySet.add(config.id);
    }

    // Author index
    if (!this.authorIndex.has(config.author)) {
      this.authorIndex.set(config.author, new Set());
    }
    const authorSet = this.authorIndex.get(config.author);
    if (authorSet) {
      authorSet.add(config.id);
    }

    // Tag index
    metadata.tags.forEach((tag) => {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      const tagSet = this.tagIndex.get(tag);
      if (tagSet) {
        tagSet.add(config.id);
      }
    });

    // Version index
    if (!this.versionMap.has(config.name)) {
      this.versionMap.set(config.name, new Set());
    }
    const versionSet = this.versionMap.get(config.name);
    if (versionSet) {
      versionSet.add(config.version);
    }
  }

  private removeFromIndices(
    config: StrategyConfig,
    metadata: StrategyMetadata,
  ): void {
    // Category index
    this.categoryIndex.get(config.category)?.delete(config.id);

    // Author index
    this.authorIndex.get(config.author)?.delete(config.id);

    // Tag index
    metadata.tags.forEach((tag) => {
      this.tagIndex.get(tag)?.delete(config.id);
    });

    // Version index
    this.versionMap.get(config.name)?.delete(config.version);
  }

  private isValidVersion(version: string): boolean {
    // Simple semver validation (major.minor.patch)
    return /^\d+\.\d+\.\d+(-[a-zA-Z0-9]+)?$/.test(version);
  }

  private isCompatibleVersion(
    requiredVersion: string,
    type: "min" | "max",
  ): boolean {
    // Simplified version compatibility check
    // In a real implementation, you'd use a proper semver library
    const currentSdkVersion = "1.0.0"; // This should come from package.json
    return type === "min"
      ? this.compareVersions(currentSdkVersion, requiredVersion) >= 0
      : this.compareVersions(currentSdkVersion, requiredVersion) <= 0;
  }

  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split(".").map(Number);
    const v2Parts = version2.split(".").map(Number);

    for (let i = 0; i < 3; i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;

      if (v1Part < v2Part) return -1;
      if (v1Part > v2Part) return 1;
    }

    return 0;
  }
}

// Export singleton instance
export const strategyRegistry = new StrategyRegistry();
