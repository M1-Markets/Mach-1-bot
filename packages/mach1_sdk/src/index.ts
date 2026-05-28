export {
  createMonacoWebSocket,
  type MonacoWebSocket,
  type MonacoWebSocketOptions,
} from "./api/websocket/index";
export {
  APIError,
  ContractError,
  InvalidConfigError,
  InvalidStateError,
  MonacoCoreError,
} from "./errors/index";
export { EMBEDDED_KEY_MATERIAL } from "./internal/embedded-key-material";
export {
  DEFAULT_ENVIRONMENT,
  DEFAULT_RATE_LIMIT,
  getClientId,
  getMonacoConfig,
  MONACO_API_URLS,
  MONACO_CLIENT_IDS,
  type MonacoEnvironment,
  NETWORK_RPC_URLS,
  OrderSide,
  OrderStatus,
  OrderType,
  resolveMonacoApiUrl,
  TOKEN_REFRESH_CONFIG,
  TRADING_PAIR_REFRESH_INTERVAL_MS,
  WEBSOCKET_CONFIG,
} from "./monaco/constants";
export {
  AccountAPI,
  type AuthState as MonacoCoreAuthState,
  EventsAPI,
  MarketAPI as MonacoMarketAPI,
  type MonacoAddress,
  type MonacoChainNetwork,
  type MonacoCoreOrderRequest,
  type MonacoCoreOrderResult,
  MonacoCoreSDK,
  type MonacoCoreSDKConfig,
  TradingAPI as MonacoTradingAPI,
  UtilsAPI,
} from "./monaco/monaco-core-sdk";
export {
  MonacoSDKAdapter,
  type MonacoSDKAdapterConfig,
} from "./monaco/monaco-sdk-adapter";
export {
  type ResolvedTradingPair,
  TradingPairResolver,
  tradingPairResolver,
} from "./monaco/trading-pair-resolver";
export { resolveApiUrl, resolveWsUrl } from "./networks/index";
export {
  createMach1SDK,
  createMonacoSDK,
  type IsolatedMarginPerpLimitOrderRequest,
  type IsolatedMarginPerpMarketOrderRequest,
  type IsolatedMarginPerpPositionSide,
  type IsolatedMarginPerpsAPI,
  type LoginOptions,
  Mach1SDK,
  type Mach1SDK as Mach1SDKInstance,
  Mach1SDKImpl,
  MonacoSDK,
} from "./sdk";
export * from "./types";
export {
  ALL_MAGNITUDES,
  calculateValidMagnitudes,
  MAX_BUCKETS_ALLOWED,
  MIN_BUCKETS_ALLOWED,
} from "./utils/index";
