import { StatusCodes } from "http-status-codes";
import { createPublicClient, http, type WalletClient } from "viem";
import { sei, seiTestnet } from "viem/chains";
import { ApplicationsAPIImpl } from "./api/applications/index";
import { AuthAPIImpl } from "./api/auth/index";
import { FeesAPIImpl } from "./api/fees/index";
import { MarginAccountsAPIImpl } from "./api/margin-accounts/index";
import { MarketAPIImpl } from "./api/market/index";
import { OrderbookAPIImpl } from "./api/orderbook/index";
import { PositionsAPIImpl } from "./api/positions/index";
import { ProfileAPIImpl } from "./api/profile/index";
import { TradesAPIImpl } from "./api/trades/index";
import { TradingAPIImpl } from "./api/trading/index";
import { VaultAPIImpl } from "./api/vault/index";
import {
  createMonacoWebSocket,
  type MonacoWebSocket,
} from "./api/websocket/index";
import {
  APIError,
  InvalidConfigError,
  InvalidStateError,
} from "./errors/index";
import { EMBEDDED_KEY_MATERIAL } from "./internal/embedded-key-material";
import { resolveApiUrl, resolveWsUrl } from "./networks/index";

export type { Interval } from "@0xmonaco/types";

export type SDKConfig = {
  network: "mainnet" | "development" | "staging" | "local";
  seiRpcUrl: string;
  walletClient?: WalletClient;
};

type AuthState = Awaited<ReturnType<AuthAPIImpl["authenticate"]>>;

export type LoginOptions = {
  connectWebSocket?: boolean;
};

export type Mach1SDK = {
  applications: ApplicationsAPIImpl;
  auth: AuthAPIImpl;
  fees: FeesAPIImpl;
  vault: VaultAPIImpl;
  trading: TradingAPIImpl;
  market: MarketAPIImpl;
  marginAccounts: MarginAccountsAPIImpl;
  positions: PositionsAPIImpl;
  profile: ProfileAPIImpl;
  orderbook: OrderbookAPIImpl;
  trades: TradesAPIImpl;
  ws: MonacoWebSocket;
  walletClient: SDKConfig["walletClient"];
  publicClient: ReturnType<typeof createPublicClient>;
  login(options?: LoginOptions): Promise<AuthState>;
  logout(): Promise<void>;
  refreshAuth(): Promise<AuthState>;
  getAuthState(): AuthState | undefined;
  isAuthenticated(): boolean;
  isConnected(): boolean;
  setWalletClient(walletClient: NonNullable<SDKConfig["walletClient"]>): void;
  setAuthState(authState: AuthState): void;
  getAccountAddress(): string;
  getNetwork(): SDKConfig["network"];
  getChainId(): number;
  waitForTransaction(
    hash: string,
    confirmations?: number,
    timeout?: number,
  ): Promise<unknown>;
};

export class Mach1SDKImpl implements Mach1SDK {
  readonly applications;
  readonly auth;
  readonly fees;
  readonly vault;
  readonly trading;
  readonly market;
  readonly marginAccounts;
  readonly positions;
  readonly profile;
  readonly orderbook;
  readonly trades;
  readonly ws;
  readonly publicClient;

  walletClient: SDKConfig["walletClient"];

  private authState?: AuthState;
  private readonly chain;
  private readonly network: SDKConfig["network"];

  constructor(config: SDKConfig) {
    const presetNetworks = ["mainnet", "development", "staging", "local"];

    if (!config.network || !presetNetworks.includes(config.network)) {
      throw new InvalidConfigError(
        `network must be one of: ${presetNetworks.join(", ")}. Got: ${config.network}`,
        "network",
      );
    }

    if (!config.seiRpcUrl) {
      throw new InvalidConfigError("seiRpcUrl is required", "seiRpcUrl");
    }

    try {
      new URL(config.seiRpcUrl);
    } catch {
      throw new InvalidConfigError(
        `seiRpcUrl must be a valid URL, got: ${config.seiRpcUrl}`,
        "seiRpcUrl",
      );
    }

    this.network = config.network;
    this.chain = this.network === "mainnet" ? sei : seiTestnet;

    if (
      config.walletClient &&
      config.walletClient.chain?.id !== undefined &&
      config.walletClient.chain.id !== this.chain.id
    ) {
      throw new InvalidConfigError(
        `Wallet client chain mismatch. Expected ${this.chain.id}, got ${config.walletClient.chain.id}`,
        "walletClient",
      );
    }

    this.walletClient = config.walletClient;

    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.seiRpcUrl),
    });

    const apiUrl = resolveApiUrl(this.network);
    const wsUrl = resolveWsUrl(this.network);

    this.applications = new ApplicationsAPIImpl(apiUrl);
    this.market = new MarketAPIImpl(apiUrl);
    this.marginAccounts = new MarginAccountsAPIImpl(apiUrl);
    this.positions = new PositionsAPIImpl(apiUrl);
    this.auth = new AuthAPIImpl(this.walletClient, this.chain, apiUrl);
    this.fees = new FeesAPIImpl(apiUrl);
    this.profile = new ProfileAPIImpl(apiUrl);
    this.vault = new VaultAPIImpl(
      this.publicClient,
      this.walletClient,
      this.chain,
      this.applications,
      this.profile,
      apiUrl,
    );
    this.trading = new TradingAPIImpl(apiUrl);
    this.orderbook = new OrderbookAPIImpl(apiUrl);
    this.trades = new TradesAPIImpl(apiUrl);
    this.ws = createMonacoWebSocket(wsUrl);

    this.ws.connect().catch(console.error);
  }

  private propagateAccessToken(accessValue: string): void {
    this.auth.setAccessToken(accessValue);
    this.applications.setAccessToken(accessValue);
    this.fees.setAccessToken(accessValue);
    this.vault.setAccessToken(accessValue);
    this.trading.setAccessToken(accessValue);
    this.market.setAccessToken(accessValue);
    this.marginAccounts.setAccessToken(accessValue);
    this.positions.setAccessToken(accessValue);
    this.profile.setAccessToken(accessValue);
    this.orderbook.setAccessToken(accessValue);
    this.trades.setAccessToken(accessValue);
    this.ws.setToken(accessValue);
  }

  async login(options?: LoginOptions): Promise<AuthState> {
    const response = await this.auth.authenticate(EMBEDDED_KEY_MATERIAL);

    this.authState = {
      accessToken: response.accessToken,
      expiresAt: response.expiresAt,
      refreshToken: response.refreshToken,
      user: response.user,
    };

    this.propagateAccessToken(this.authState.accessToken);

    if (options?.connectWebSocket) {
      await this.ws.connect();
    }

    return this.authState;
  }

  getAuthState(): AuthState | undefined {
    return this.authState;
  }

  setAuthState(authState: AuthState): void {
    this.authState = authState;
    this.propagateAccessToken(authState.accessToken);
  }

  async logout(): Promise<void> {
    if (this.authState?.refreshToken) {
      try {
        await this.auth.revokeToken();
        // biome-ignore lint/suspicious/noEmptyBlockStatements: no need to do anything on failure - just clear local state
      } catch {}
    }

    if (this.ws.isConnected()) {
      this.ws.disconnect();
    }

    this.authState = undefined;
    this.propagateAccessToken("");
  }

  async refreshAuth(): Promise<AuthState> {
    if (!this.authState?.refreshToken) {
      throw new APIError("No refresh token available", {
        endpoint: "auth/refresh",
        statusCode: StatusCodes.UNAUTHORIZED,
      });
    }

    try {
      const response = await this.auth.refreshToken(
        this.authState.refreshToken,
      );

      this.authState = {
        ...this.authState,
        accessToken: response.accessToken,
        expiresAt: response.expiresAt,
      };
      this.propagateAccessToken(this.authState.accessToken);
      return this.authState;
    } catch (error) {
      this.authState = undefined;
      throw error;
    }
  }

  isAuthenticated(): boolean {
    return Boolean(this.authState);
  }

  isConnected(): boolean {
    return Boolean(this.walletClient && this.publicClient);
  }

  setWalletClient(walletClient: NonNullable<SDKConfig["walletClient"]>): void {
    if (
      walletClient.chain?.id !== undefined &&
      walletClient.chain.id !== this.chain.id
    ) {
      throw new InvalidConfigError(
        `Wallet client chain mismatch. Expected ${this.chain.id}, got ${walletClient.chain.id}`,
        "walletClient",
      );
    }

    this.walletClient = walletClient;
    this.auth.setWalletClient(walletClient);
    this.vault.setWalletClient(walletClient);
  }

  getAccountAddress(): string {
    if (!this.walletClient) {
      throw new InvalidStateError("Wallet client not set", "walletClient");
    }

    if (this.walletClient.account) {
      return this.walletClient.account.address;
    }

    throw new InvalidStateError("No account available", "account");
  }

  getNetwork(): SDKConfig["network"] {
    return this.network;
  }

  getChainId(): number {
    return this.chain.id;
  }

  async waitForTransaction(
    hash: string,
    confirmations?: number,
    timeout?: number,
  ): Promise<unknown> {
    return this.publicClient.waitForTransactionReceipt({
      confirmations,
      hash: hash as `0x${string}`,
      timeout,
    });
  }
}

export const Mach1SDK = Mach1SDKImpl;
export const MonacoSDK = Mach1SDKImpl;

export function createMach1SDK(config: SDKConfig): Mach1SDK {
  return new Mach1SDKImpl(config);
}

export function createMonacoSDK(config: SDKConfig): Mach1SDK {
  return createMach1SDK(config);
}
