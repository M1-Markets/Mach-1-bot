/**
 * @mach-one-sdk/config
 * Configuration utilities
 */

import { ConfigManager } from "./domains/configuration/config-manager";
import { SDKConfigBuilder as ConfigBuilder } from "./shared/utils/validation/sdk-config-builder";

// Factory functions
export function createConfigManager(): ConfigManager {
  return new ConfigManager();
}

export function createConfigBuilder(): ConfigBuilder {
  return ConfigBuilder.create();
}

// Re-export constants
export {
  DEFAULT_CONTRACT_ADDRESSES,
  NETWORK_PRESETS,
} from "./shared/constants";
// Re-export SDK-facing types only; BotConfig lives in the bot module
export type {
  ContractAddresses,
  NetworkPreset,
  SDKConfig,
} from "./shared/types";
// Re-export classes
export { ConfigBuilder, ConfigManager };
