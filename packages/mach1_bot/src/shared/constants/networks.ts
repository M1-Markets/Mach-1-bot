/**
 * Network configuration constants
 */

import { NetworkPreset } from "../types/config";

// Built-in network presets
export const NETWORK_PRESETS: Record<string, NetworkPreset> = {
  mainnet: {
    name: "Sei Mainnet",
    network: "mainnet",
    chainId: 1329,
    rpcUrl: "https://evm-rpc.sei-apis.com",
  },
  testnet: {
    name: "Sei Testnet",
    network: "testnet",
    chainId: 1328,
    rpcUrl: "https://evm-rpc-testnet.sei-apis.com",
  },
};
