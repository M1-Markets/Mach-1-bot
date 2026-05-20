export type Mach1Network = "sei-testnet" | "sei-mainnet";

export const NETWORK_API_URLS: Record<Mach1Network, string> = {
  "sei-mainnet": "https://api.monaco.xyz",
  "sei-testnet": "https://develop.apimonaco.xyz",
};

export const NETWORK_WS_URLS: Record<Mach1Network, string> = {
  "sei-mainnet": "wss://api.monaco.xyz",
  "sei-testnet": "wss://develop.apimonaco.xyz",
};

export function resolveApiUrl(network: Mach1Network): string {
  return NETWORK_API_URLS[network];
}

export function resolveWsUrl(network: Mach1Network): string {
  return NETWORK_WS_URLS[network];
}
