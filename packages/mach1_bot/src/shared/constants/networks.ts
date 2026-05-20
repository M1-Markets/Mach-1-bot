/**
 * Network configuration constants
 */

import { NetworkPreset } from "../types/config";

// Built-in network presets
export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  "sei-mainnet": {
    name: "Sei Mainnet",
    network: "sei-mainnet",
    chainId: 1329,
    rpcUrl: "https://evm-rpc.sei-apis.com",
  },
  "sei-testnet": {
    name: "Sei Testnet",
    network: "sei-testnet",
    chainId: 1328,
    rpcUrl: "https://evm-rpc-testnet.sei-apis.com",
  },
};
