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
  NETWORK_RPC_URLS,
  TOKEN_REFRESH_CONFIG,
  type MonacoEnvironment,
  resolveMonacoApiUrl,
} from "./monaco/constants";
export {
  AccountAPI,
  EventsAPI,
  MarketAPI as MonacoMarketAPI,
  MonacoCoreSDK,
  TradingAPI as MonacoTradingAPI,
  UtilsAPI,
  type AuthState as MonacoCoreAuthState,
  type MonacoAddress,
  type MonacoChainNetwork,
  type MonacoCoreOrderRequest,
  type MonacoCoreOrderResult,
  type MonacoCoreSDKConfig,
} from "./monaco/monaco-core-sdk";
export {
  MonacoSDKAdapter,
  type MonacoSDKAdapterConfig,
} from "./monaco/monaco-sdk-adapter";
export {
  TradingPairResolver,
  tradingPairResolver,
  type ResolvedTradingPair,
} from "./monaco/trading-pair-resolver";
export { resolveApiUrl, resolveWsUrl } from "./networks/index";
export {
  createMach1SDK,
  createMonacoSDK,
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
