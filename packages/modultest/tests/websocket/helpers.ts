import "dotenv/config";
import type { Network } from "@0xmonaco/types";

export const NETWORK_PRESETS: Record<string, string> = {
  local: "ws://localhost:8080/ws",
  development: "wss://develop.apimonaco.xyz/ws",
  staging: "wss://staging.apimonaco.xyz/ws",
  mainnet: "wss://api.monaco.xyz/ws",
};

export function resolveWsUrl(network: string, explicitWsUrl?: string): string {
  if (explicitWsUrl) {
    return explicitWsUrl;
  }
  const preset = NETWORK_PRESETS[network];
  if (preset !== undefined) {
    return preset;
  }
  const networkUrl = new URL(network);
  const wsProtocol = networkUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${networkUrl.host}/ws`;
}

function resolveNetwork(value: string | undefined): Network {
  switch (value) {
    case "local":
    case "development":
    case "staging":
    case "mainnet":
      return value;
    default:
      return "staging";
  }
}

/**
 * Waits for a value delivered via a subscription callback.
 * The setup function must return the unsubscribe handle.
 */
export function waitFor<T>(
  setup: (
    resolve: (value: T) => void,
    reject: (err: Error) => void,
  ) => () => void,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((res, rej) => {
    let done = false;
    const finish = (): void => {
      done = true;
      clearTimeout(timer);
      unsub();
    };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      rej(new Error(`waitFor: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = setup(
      (val) => {
        if (done) return;
        finish();
        res(val);
      },
      (err) => {
        if (done) return;
        finish();
        rej(err);
      },
    );
  });
}

/**
 * Like waitFor but resolves with undefined on timeout instead of rejecting.
 * Used for channels that may be quiet in low-activity markets or that only
 * emit events on user activity.
 */
export function waitForOptional<T>(
  setup: (resolve: (value: T) => void) => () => void,
  timeoutMs = 5_000,
): Promise<T | undefined> {
  return new Promise<T | undefined>((res) => {
    let done = false;
    const finish = (val: T | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      res(val);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const unsub = setup((val) => finish(val));
  });
}

export async function logoutIgnoringKnownRevokeMismatch(sdk: {
  logout(): Promise<void>;
}): Promise<void> {
  const originalWarn = console.warn;

  console.warn = (...args: unknown[]) => {
    const [message, error] = args;
    if (
      typeof message === "string" &&
      message.includes("Failed to revoke token on logout:")
    ) {
      const apiErrorMessage =
        error instanceof Error ? error.message : String(error ?? "");
      if (apiErrorMessage.includes("Revoke request body must be empty")) {
        return;
      }
    }

    originalWarn(...args);
  };

  try {
    await sdk.logout();
  } finally {
    console.warn = originalWarn;
  }
}

export const network = resolveNetwork(process.env.NETWORK);
export const serverUrl = resolveWsUrl(network, process.env.WS_URL);
export const seiRpcUrl =
  network === "mainnet"
    ? "https://evm-rpc.sei-apis.com"
    : "https://evm-rpc-testnet.sei-apis.com";
