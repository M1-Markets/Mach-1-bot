import { createMach1SDK, type Mach1SDK } from "../sdk";
import { type Chain, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sei, seiTestnet } from "viem/chains";
import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_RATE_LIMIT,
  NETWORK_RPC_URLS,
  TOKEN_REFRESH_CONFIG,
  type MonacoEnvironment,
  resolveMonacoApiUrl,
} from "./constants";
import type {
  AuthState,
  MonacoChainNetwork,
  MonacoCoreOrderRequest,
  MonacoCoreOrderResult,
} from "./monaco-core-sdk";
import {
  TokenBucketRateLimiter,
  createLogger,
  getNumberProp,
  getRecord,
  isRecord,
  normalizePrivateKey,
  retryWithBackoff,
} from "./runtime-utils";
import { tradingPairResolver } from "./trading-pair-resolver";

const logger = createLogger("MonacoSDKAdapter");

export interface MonacoSDKAdapterConfig {
  network: MonacoChainNetwork;
  privateKey: string;
  environment?: MonacoEnvironment;
  skipAuth?: boolean;
  rpcUrl?: string;
  rateLimiter?: TokenBucketRateLimiter;
}

const NETWORK_MAPPING: Record<
  MonacoChainNetwork,
  { chain: Chain; defaultRpcUrl: string }
> = {
  mainnet: {
    chain: sei,
    defaultRpcUrl: NETWORK_RPC_URLS.mainnet,
  },
  testnet: {
    chain: seiTestnet,
    defaultRpcUrl: NETWORK_RPC_URLS.testnet,
  },
};

type UserProfileSummary = {
  id: string;
  address: string;
  username?: string | null;
  account_type?: string;
};

type AccountBalanceSnapshot = {
  token: string;
  symbol: string | null;
  available_balance: string;
  locked_balance: string;
  total_balance: string;
};

type UserBalancesResponse = {
  balances: AccountBalanceSnapshot[];
  total?: number;
};

function requireValidUrl(value: string, label: string): string {
  try {
    return new URL(value).toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} must be a valid URL, got: ${value}. ${message}`);
  }
}

function normalizeExpiresAt(expiresAt: number): number {
  return expiresAt < 1_000_000_000_000 ? expiresAt * 1000 : expiresAt;
}

function isNetworkError(error: unknown): boolean {
  const networkErrors = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "EAI_AGAIN",
  ];

  const errorMessage = error instanceof Error ? error.message : String(error);
  return networkErrors.some((entry) => errorMessage.includes(entry));
}

function isAuthError(error: unknown): boolean {
  const errorMessage =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const errorRecord = getRecord(error);
  const status =
    getNumberProp(errorRecord, "status") ??
    getNumberProp(getRecord(errorRecord?.response), "status");

  if (status === 401 || status === 403) {
    return true;
  }

  return (
    errorMessage.includes("auth") ||
    errorMessage.includes("token") ||
    errorMessage.includes("unauthorized") ||
    errorMessage.includes("401") ||
    errorMessage.includes("403")
  );
}

export class MonacoSDKAdapter {
  private sdk: Mach1SDK | null = null;
  private authState?: AuthState;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly config: MonacoSDKAdapterConfig;
  private isPausedFlag = false;
  private tokenRefreshInProgress = false;
  private tokenRefreshTimer?: NodeJS.Timeout;

  public onTradingPaused?: () => void;

  constructor(config: MonacoSDKAdapterConfig) {
    this.config = config;
    this.rateLimiter =
      config.rateLimiter ||
      new TokenBucketRateLimiter(
        DEFAULT_RATE_LIMIT.burstCapacity,
        DEFAULT_RATE_LIMIT.maxRequestsPerSecond,
      );
  }

  async initialize(): Promise<void> {
    const {
      network,
      privateKey,
      environment = DEFAULT_ENVIRONMENT,
      skipAuth = false,
      rpcUrl,
    } = this.config;
    const networkConfig = NETWORK_MAPPING[network];
    const selectedRpcUrl = rpcUrl || networkConfig.defaultRpcUrl;
    const account = privateKeyToAccount(normalizePrivateKey(privateKey));
    const apiUrl = resolveMonacoApiUrl(environment);

    requireValidUrl(apiUrl, "Monaco API URL");

    const walletClient = createWalletClient({
      account,
      chain: networkConfig.chain,
      transport: http(selectedRpcUrl),
    });

    this.sdk = createMach1SDK({
      walletClient,
      network: network === "mainnet" ? "sei-mainnet" : "sei-testnet",
      seiRpcUrl: selectedRpcUrl,
    });

    if (skipAuth || !this.sdk) {
      return;
    }

    this.authState = await this.sdk.login({
      connectWebSocket: true,
    });

    if (this.authState) {
      this.authState.expiresAt = normalizeExpiresAt(this.authState.expiresAt);
    }

    this.syncAuthAccessToken();
    this.scheduleTokenRefresh();
    await tradingPairResolver.initialize(this.sdk);
    await this.logUserProfileBalances();
  }

  async refreshAuthToken(): Promise<void> {
    if (!this.sdk || this.config.skipAuth) {
      return;
    }

    if (this.tokenRefreshInProgress) {
      while (this.tokenRefreshInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.tokenRefreshInProgress = true;

    try {
      await retryWithBackoff(
        async () => {
          if (!this.sdk) {
            throw new Error("SDK not initialized");
          }

          this.authState = await this.sdk.refreshAuth();
          if (this.authState) {
            this.authState.expiresAt = normalizeExpiresAt(
              this.authState.expiresAt,
            );
          }
          this.syncAuthAccessToken();
        },
        {
          maxRetries: TOKEN_REFRESH_CONFIG.maxRetries,
          baseDelayMs: TOKEN_REFRESH_CONFIG.retryDelayMs,
          shouldRetry: (error) => isNetworkError(error),
        },
      );

      this.scheduleTokenRefresh();
    } catch (error) {
      if (isAuthError(error)) {
        await this.relogin();
        return;
      }

      this.pauseTrading();
      throw error;
    } finally {
      this.tokenRefreshInProgress = false;
    }
  }

  pauseTrading(): void {
    if (this.isPausedFlag) {
      return;
    }

    this.isPausedFlag = true;

    if (this.onTradingPaused) {
      try {
        this.onTradingPaused();
      } catch (error) {
        logger.error("Error in onTradingPaused callback", {}, error as Error);
      }
    }
  }

  resumeTrading(): void {
    this.isPausedFlag = false;
  }

  isPaused(): boolean {
    return this.isPausedFlag;
  }

  async adaptOrderRequest(
    request: MonacoCoreOrderRequest,
  ): Promise<MonacoCoreOrderResult> {
    return this.placeOrderInternal(request, true);
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.sdk) {
      throw new Error("Monaco SDK not initialized");
    }

    if (this.isPausedFlag) {
      throw new Error("Trading is paused. Cannot cancel orders.");
    }

    await this.rateLimiter.acquire();

    await this.retryNetworkOperation(async () => {
      if (!this.sdk) {
        throw new Error("SDK not initialized");
      }

      await this.sdk.trading.cancelOrder(orderId);
    });
  }

  getSDK(): Mach1SDK {
    if (!this.sdk) {
      throw new Error("Monaco SDK not initialized. Call initialize() first.");
    }

    return this.sdk;
  }

  getAuthState(): AuthState | undefined {
    return this.authState;
  }

  isAuthenticated(): boolean {
    if (!this.authState) {
      return false;
    }

    return Date.now() < this.authState.expiresAt;
  }

  getRateLimitStatus() {
    return this.rateLimiter.getRateLimitStatus();
  }

  async shutdown(): Promise<void> {
    try {
      if (this.tokenRefreshTimer) {
        clearTimeout(this.tokenRefreshTimer);
        this.tokenRefreshTimer = undefined;
      }

      if (this.sdk && this.authState?.accessToken) {
        try {
          this.syncAuthAccessToken();
          await this.sdk.logout();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("Access token not set")) {
            logger.warn("Logout failed, continuing shutdown", { message });
          }
        }
      }
    } finally {
      tradingPairResolver.shutdown();
    }
  }

  private async retryNetworkOperation<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(fn, {
      maxRetries: 3,
      shouldRetry: (error) => isNetworkError(error),
    });
  }

  private mapOrderStatus(
    monacoStatus: string,
  ): "pending" | "filled" | "cancelled" | "rejected" {
    const statusMap: Record<
      string,
      "pending" | "filled" | "cancelled" | "rejected"
    > = {
      OPEN: "pending",
      PARTIALLY_FILLED: "pending",
      FILLED: "filled",
      CANCELLED: "cancelled",
      REJECTED: "rejected",
      EXPIRED: "cancelled",
    };

    return statusMap[monacoStatus] || "rejected";
  }

  private async logUserProfileBalances(): Promise<void> {
    if (!this.sdk) {
      return;
    }

    try {
      const profile: UserProfileSummary = await this.sdk.profile.getProfile();
      const balances: UserBalancesResponse =
        await this.sdk.profile.getUserBalances();

      logger.debug("User profile", {
        id: profile.id,
        address: profile.address,
        username: profile.username,
        accountType: profile.account_type,
      });

      logger.debug("User balances", {
        total: balances.total,
        balances: balances.balances.map((balance) => ({
          token: balance.token,
          symbol: balance.symbol,
          available: balance.available_balance,
          locked: balance.locked_balance,
          total: balance.total_balance,
        })),
      });
    } catch (error) {
      logger.warn("Failed to fetch user profile balances", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private syncAuthAccessToken(): void {
    if (!this.sdk || !this.authState?.accessToken) {
      return;
    }

    this.sdk.auth.setAccessToken(this.authState.accessToken);
    this.sdk.applications.setAccessToken(this.authState.accessToken);
    this.sdk.fees.setAccessToken(this.authState.accessToken);
    this.sdk.vault.setAccessToken(this.authState.accessToken);
    this.sdk.trading.setAccessToken(this.authState.accessToken);
    this.sdk.market.setAccessToken(this.authState.accessToken);
    this.sdk.marginAccounts.setAccessToken(this.authState.accessToken);
    this.sdk.positions.setAccessToken(this.authState.accessToken);
    this.sdk.profile.setAccessToken(this.authState.accessToken);
    this.sdk.orderbook.setAccessToken(this.authState.accessToken);
    this.sdk.trades.setAccessToken(this.authState.accessToken);
    this.sdk.ws.setToken(this.authState.accessToken);
  }

  private scheduleTokenRefresh(): void {
    if (this.config.skipAuth || !this.authState?.expiresAt) {
      return;
    }

    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    const refreshAt = this.authState.expiresAt - TOKEN_REFRESH_CONFIG.bufferMs;
    const minimumDelayMs = 30_000;
    const delayMs = Math.max(minimumDelayMs, refreshAt - Date.now());

    this.tokenRefreshTimer = setTimeout(() => {
      this.refreshAuthToken().catch((error) => {
        logger.warn("Scheduled token refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);

    this.tokenRefreshTimer.unref?.();
  }

  private async relogin(): Promise<void> {
    if (!this.sdk || this.config.skipAuth) {
      return;
    }

    this.authState = await this.sdk.login({
      connectWebSocket: true,
    });

    if (this.authState) {
      this.authState.expiresAt = normalizeExpiresAt(this.authState.expiresAt);
    }

    this.syncAuthAccessToken();
    this.scheduleTokenRefresh();
  }

  private async placeOrderInternal(
    request: MonacoCoreOrderRequest,
    allowAuthRetry: boolean,
  ): Promise<MonacoCoreOrderResult> {
    if (!this.sdk) {
      throw new Error("Monaco SDK not initialized. Call initialize() first.");
    }

    if (this.isPausedFlag) {
      throw new Error("Trading is paused. Cannot place orders.");
    }

    try {
      const pairByContracts = tradingPairResolver.getPairByContracts(
        request.baseToken,
        request.quoteToken,
      );
      const symbol = pairByContracts
        ? tradingPairResolver.normalizeSymbol(pairByContracts.symbol)
        : `${request.baseToken}/${request.quoteToken}`;
      const tradingPairId = pairByContracts
        ? pairByContracts.id
        : tradingPairResolver.resolveSymbolToId(symbol);
      const isLimitOrder = request.orderType
        ? request.orderType === "limit"
        : Boolean(request.price && request.price > 0n);

      await this.rateLimiter.acquire();

      let response: unknown;

      if (isLimitOrder) {
        response = await this.retryNetworkOperation(async () => {
          if (!this.sdk) {
            throw new Error("SDK not initialized");
          }

          return this.sdk.trading.placeLimitOrder(
            tradingPairId,
            request.isBuy ? "BUY" : "SELL",
            request.quantity.toString(),
            request.price.toString(),
            { tradingMode: "SPOT" },
          );
        });
      } else {
        response = await this.retryNetworkOperation(async () => {
          if (!this.sdk) {
            throw new Error("SDK not initialized");
          }

          return this.sdk.trading.placeMarketOrder(
            tradingPairId,
            request.isBuy ? "BUY" : "SELL",
            request.quantity.toString(),
            { tradingMode: "SPOT" },
          );
        });
      }

      const dataRecord = isRecord(response) ? response : {};
      const matchResult = getRecord(dataRecord.match_result);
      const orderId = String(dataRecord.order_id ?? dataRecord.orderId ?? "");
      const status = this.mapOrderStatus(
        String(matchResult?.status ?? dataRecord.status ?? ""),
      );
      const filledQuantity = BigInt(
        String(matchResult?.total_filled ?? dataRecord.filledQuantity ?? "0"),
      );
      const quantity = BigInt(String(request.quantity));

      return {
        orderId,
        status,
        filledQuantity,
        remainingQuantity: quantity - filledQuantity,
      };
    } catch (error) {
      if (isAuthError(error)) {
        await this.refreshAuthToken();
        if (allowAuthRetry) {
          return this.placeOrderInternal(request, false);
        }
      }

      throw error;
    }
  }
}
