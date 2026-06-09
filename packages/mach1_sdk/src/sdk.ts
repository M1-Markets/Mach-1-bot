import type {
  CancelOrderResponse,
  ClosePositionRequest,
  ClosePositionResponse,
  CreateOrderResponse,
  GetAvailableCollateralParams,
  GetAvailableCollateralResponse,
  GetPaginatedOrdersParams,
  GetPaginatedOrdersResponse,
  GetPositionResponse,
  ListMarginAccountsParams,
  ListMarginAccountsResponse,
  ListPositionsParams,
  ListPositionsResponse,
  MarginAccountSummary,
  OrderSide,
  ParentTpSlLegParams,
  PositionMarginResponse,
  PositionSide,
  ReducePositionMarginRequest,
  SimulateOrderRiskRequest,
  SimulateOrderRiskResponse,
  TimeInForce,
} from "@0xmonaco/types";
import { StatusCodes } from "http-status-codes";
import { createPublicClient, http, type WalletClient } from "viem";
import { sei, seiTestnet } from "viem/chains";
import { ApplicationsAPIImpl } from "./api/applications/index";
import { AuthAPIImpl } from "./api/auth/index";
import { DelegatedAgentsAPIImpl } from "./api/delegated-agents/index";
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
import type { SessionCredentials } from "@0xmonaco/types";

export type { Interval } from "@0xmonaco/types";

export type SDKConfig = {
  network: "sei-testnet" | "sei-mainnet";
  seiRpcUrl: string;
  walletClient?: WalletClient;
  apiUrl?: string;
  wsUrl?: string;
};

type AuthState = Awaited<ReturnType<AuthAPIImpl["authenticate"]>>;

export type LoginOptions = {
  connectWebSocket?: boolean;
};

export type IsolatedMarginPerpPositionSide = Exclude<PositionSide, "NONE">;

export interface IsolatedMarginPerpLimitOrderRequest {
  tradingPairId: string;
  side: OrderSide;
  quantity: string;
  price: string;
  marginAccountId: string;
  positionSide: IsolatedMarginPerpPositionSide;
  leverage?: string;
  reduceOnly?: boolean;
  timeInForce?: TimeInForce;
  takeProfit?: ParentTpSlLegParams;
  stopLoss?: ParentTpSlLegParams;
}

export interface IsolatedMarginPerpMarketOrderRequest {
  tradingPairId: string;
  side: OrderSide;
  quantity: string;
  marginAccountId: string;
  positionSide: IsolatedMarginPerpPositionSide;
  leverage?: string;
  reduceOnly?: boolean;
  slippageTolerance?: number;
  takeProfit?: ParentTpSlLegParams;
  stopLoss?: ParentTpSlLegParams;
}

export interface IsolatedMarginPerpsAPI {
  listMarginAccounts(
    params?: ListMarginAccountsParams,
  ): Promise<ListMarginAccountsResponse>;
  getMarginAccountSummary(
    marginAccountId: string,
  ): Promise<MarginAccountSummary>;
  getAvailableCollateral(
    params?: GetAvailableCollateralParams,
  ): Promise<GetAvailableCollateralResponse>;
  simulateOrderRisk(
    marginAccountId: string,
    request: SimulateOrderRiskRequest,
  ): Promise<SimulateOrderRiskResponse>;
  listOpenPositions(
    params?: Omit<ListPositionsParams, "status">,
  ): Promise<ListPositionsResponse>;
  getPosition(positionId: string): Promise<GetPositionResponse>;
  listOrders(
    params?: Omit<GetPaginatedOrdersParams, "trading_mode">,
  ): Promise<GetPaginatedOrdersResponse>;
  placeLimitOrder(
    request: IsolatedMarginPerpLimitOrderRequest,
  ): Promise<CreateOrderResponse>;
  placeMarketOrder(
    request: IsolatedMarginPerpMarketOrderRequest,
  ): Promise<CreateOrderResponse>;
  cancelOrder(orderId: string): Promise<CancelOrderResponse>;
  closePosition(
    positionId: string,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResponse>;
  reducePositionMargin(
    positionId: string,
    request: ReducePositionMarginRequest,
  ): Promise<PositionMarginResponse>;
}

class IsolatedMarginPerpsAPIImpl implements IsolatedMarginPerpsAPI {
  constructor(
    private readonly marginAccounts: MarginAccountsAPIImpl,
    private readonly positions: PositionsAPIImpl,
    private readonly trading: TradingAPIImpl,
  ) {}

  listMarginAccounts(
    params?: ListMarginAccountsParams,
  ): Promise<ListMarginAccountsResponse> {
    return this.marginAccounts.listMarginAccounts(params);
  }

  getMarginAccountSummary(
    marginAccountId: string,
  ): Promise<MarginAccountSummary> {
    return this.marginAccounts.getMarginAccountSummary(marginAccountId);
  }

  getAvailableCollateral(
    params?: GetAvailableCollateralParams,
  ): Promise<GetAvailableCollateralResponse> {
    return this.marginAccounts.getAvailableCollateral(params);
  }

  simulateOrderRisk(
    marginAccountId: string,
    request: SimulateOrderRiskRequest,
  ): Promise<SimulateOrderRiskResponse> {
    return this.marginAccounts.simulateOrderRisk(marginAccountId, request);
  }

  listOpenPositions(
    params?: Omit<ListPositionsParams, "status">,
  ): Promise<ListPositionsResponse> {
    return this.positions.listPositions({
      ...params,
      status: "OPEN",
    });
  }

  getPosition(positionId: string): Promise<GetPositionResponse> {
    return this.positions.getPosition(positionId);
  }

  listOrders(
    params?: Omit<GetPaginatedOrdersParams, "trading_mode">,
  ): Promise<GetPaginatedOrdersResponse> {
    return this.trading.getPaginatedOrders({
      ...params,
      trading_mode: "MARGIN",
    });
  }

  placeLimitOrder(
    request: IsolatedMarginPerpLimitOrderRequest,
  ): Promise<CreateOrderResponse> {
    return this.trading.placeLimitOrder(
      request.tradingPairId,
      request.side,
      request.quantity,
      request.price,
      {
        marginAccountId: request.marginAccountId,
        positionSide: request.positionSide,
        leverage: request.leverage,
        reduceOnly: request.reduceOnly,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        timeInForce: request.timeInForce,
        // Monaco perp orders require explicit MARGIN mode plus margin account.
        tradingMode: "MARGIN",
      },
    );
  }

  placeMarketOrder(
    request: IsolatedMarginPerpMarketOrderRequest,
  ): Promise<CreateOrderResponse> {
    return this.trading.placeMarketOrder(
      request.tradingPairId,
      request.side,
      request.quantity,
      {
        leverage: request.leverage,
        marginAccountId: request.marginAccountId,
        positionSide: request.positionSide,
        reduceOnly: request.reduceOnly,
        slippageTolerance: request.slippageTolerance,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        tradingMode: "MARGIN",
      },
    );
  }

  cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    return this.trading.cancelOrder(orderId);
  }

  closePosition(
    positionId: string,
    request: ClosePositionRequest,
  ): Promise<ClosePositionResponse> {
    return this.positions.closePosition(positionId, request);
  }

  reducePositionMargin(
    positionId: string,
    request: ReducePositionMarginRequest,
  ): Promise<PositionMarginResponse> {
    return this.positions.reducePositionMargin(positionId, request);
  }
}

export type Mach1SDK = {
  applications: ApplicationsAPIImpl;
  auth: AuthAPIImpl;
  delegatedAgents: DelegatedAgentsAPIImpl;
  fees: FeesAPIImpl;
  vault: VaultAPIImpl;
  trading: TradingAPIImpl;
  market: MarketAPIImpl;
  marginAccounts: MarginAccountsAPIImpl;
  positions: PositionsAPIImpl;
  profile: ProfileAPIImpl;
  orderbook: OrderbookAPIImpl;
  trades: TradesAPIImpl;
  perps: IsolatedMarginPerpsAPI;
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
  readonly delegatedAgents;
  readonly fees;
  readonly vault;
  readonly trading;
  readonly market;
  readonly marginAccounts;
  readonly positions;
  readonly profile;
  readonly orderbook;
  readonly trades;
  readonly perps;
  readonly ws;
  readonly publicClient;

  walletClient: SDKConfig["walletClient"];

  private authState?: AuthState;
  private readonly chain;
  private readonly network: SDKConfig["network"];

  constructor(config: SDKConfig) {
    const presetNetworks = ["sei-testnet", "sei-mainnet"];

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
    this.chain = this.network === "sei-mainnet" ? sei : seiTestnet;

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

    const apiUrl = config.apiUrl || resolveApiUrl(this.network);
    const wsUrl = config.wsUrl || resolveWsUrl(this.network);

    this.applications = new ApplicationsAPIImpl(apiUrl);
    this.market = new MarketAPIImpl(apiUrl);
    this.marginAccounts = new MarginAccountsAPIImpl(apiUrl);
    this.positions = new PositionsAPIImpl(apiUrl);
    this.auth = new AuthAPIImpl(this.walletClient, this.chain, apiUrl);
    this.delegatedAgents = new DelegatedAgentsAPIImpl(apiUrl);
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
    this.perps = new IsolatedMarginPerpsAPIImpl(
      this.marginAccounts,
      this.positions,
      this.trading,
    );
    this.ws = createMonacoWebSocket(wsUrl);
  }

  private propagateSession(credentials: SessionCredentials | undefined): void {
    this.auth.setSessionKeypair(credentials);
    this.delegatedAgents.setSessionKeypair(credentials);
    this.applications.setSessionKeypair(credentials);
    this.fees.setSessionKeypair(credentials);
    this.vault.setSessionKeypair(credentials);
    this.trading.setSessionKeypair(credentials);
    this.market.setSessionKeypair(credentials);
    this.marginAccounts.setSessionKeypair(credentials);
    this.positions.setSessionKeypair(credentials);
    this.profile.setSessionKeypair(credentials);
    this.orderbook.setSessionKeypair(credentials);
    this.trades.setSessionKeypair(credentials);
    this.ws.setSessionKeypair(credentials);
  }

  private sessionFromAuthState(authState: AuthState): SessionCredentials {
    return {
      privateKey: authState.sessionPrivateKey,
      publicKey: authState.sessionPublicKey,
    };
  }

  async login(options?: LoginOptions): Promise<AuthState> {
    this.authState = await this.auth.authenticate(EMBEDDED_KEY_MATERIAL);
    this.propagateSession(this.sessionFromAuthState(this.authState));

    if (options?.connectWebSocket && !this.ws.isConnected()) {
      await this.ws.connect();
    }

    return this.authState;
  }

  getAuthState(): AuthState | undefined {
    return this.authState;
  }

  setAuthState(authState: AuthState): void {
    this.authState = authState;
    this.propagateSession(this.sessionFromAuthState(authState));
  }

  async logout(): Promise<void> {
    if (this.authState) {
      try {
        await this.auth.revokeSession();
        // biome-ignore lint/suspicious/noEmptyBlockStatements: no need to do anything on failure - just clear local state
      } catch {}
    }

    if (this.ws.isConnected()) {
      this.ws.disconnect();
    }

    this.authState = undefined;
    this.propagateSession(undefined);
  }

  async refreshAuth(): Promise<AuthState> {
    if (!this.authState) {
      throw new APIError("No active session to refresh", {
        endpoint: "auth/refresh",
        statusCode: StatusCodes.UNAUTHORIZED,
      });
    }

    try {
      const response = await this.auth.refreshSession();

      this.authState = {
        ...this.authState,
        expiresAt: response.expiresAt,
      };
      return this.authState;
    } catch (error) {
      this.authState = undefined;
      this.propagateSession(undefined);
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
