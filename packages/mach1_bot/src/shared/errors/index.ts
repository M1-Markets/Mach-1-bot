// Base error class for all SDK errors
export class MachOneError extends Error {
  readonly code: string;
  readonly category:
    | "VALIDATION"
    | "TRADING"
    | "NETWORK"
    | "CONFIG"
    | "STRATEGY"
    | "RISK";

  constructor(
    code: string,
    category:
      | "VALIDATION"
      | "TRADING"
      | "NETWORK"
      | "CONFIG"
      | "STRATEGY"
      | "RISK",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.category = category;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
      stack: this.stack,
    };
  }
}

// Validation Errors
export class ValidationError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", "VALIDATION", message, details);
  }
}

export class InvalidSymbolError extends MachOneError {
  constructor(symbol: string) {
    super(
      "INVALID_SYMBOL",
      "VALIDATION",
      `Invalid trading symbol: ${symbol}. Expected format: BASE/QUOTE (e.g., ETH/USDC)`,
    );
  }
}

export class InvalidAmountError extends MachOneError {
  constructor(amount: number | bigint, reason?: string) {
    super(
      "INVALID_AMOUNT",
      "VALIDATION",
      `Invalid amount: ${amount}${reason ? ` - ${reason}` : ""}`,
    );
  }
}

export class InvalidPriceError extends MachOneError {
  constructor(price: number | bigint, reason?: string) {
    super(
      "INVALID_PRICE",
      "VALIDATION",
      `Invalid price: ${price}${reason ? ` - ${reason}` : ""}`,
    );
  }
}

export class InvalidConfigError extends MachOneError {
  constructor(field: string, value: unknown, reason?: string) {
    super(
      "INVALID_CONFIG",
      "VALIDATION",
      `Invalid configuration for ${field}: ${value}${reason ? ` - ${reason}` : ""}`,
    );
  }
}

// Trading Errors
export class TradingError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("TRADING_ERROR", "TRADING", message, details);
  }
}

export class InsufficientBalanceError extends MachOneError {
  constructor(required: bigint, available: bigint, token: string) {
    super(
      "INSUFFICIENT_BALANCE",
      "TRADING",
      `Insufficient balance for ${token}. Required: ${required}, Available: ${available}`,
    );
  }
}

export class OrderRejectedError extends MachOneError {
  constructor(reason: string, orderId?: string) {
    super(
      "ORDER_REJECTED",
      "TRADING",
      `Order rejected: ${reason}${orderId ? ` (Order ID: ${orderId})` : ""}`,
    );
  }
}

export class SlippageExceededError extends MachOneError {
  constructor(expected: number, actual: number, threshold: number) {
    super(
      "SLIPPAGE_EXCEEDED",
      "TRADING",
      `Slippage exceeded threshold. Expected: ${expected}, Actual: ${actual}, Threshold: ${threshold}%`,
    );
  }
}

export class MarketClosedError extends MachOneError {
  constructor(symbol: string) {
    super("MARKET_CLOSED", "TRADING", `Market is closed for ${symbol}`);
  }
}

// Network Errors
export class NetworkError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("NETWORK_ERROR", "NETWORK", message, details);
  }
}

export class ConnectionError extends MachOneError {
  constructor(endpoint: string, cause?: Error) {
    super(
      "CONNECTION_ERROR",
      "NETWORK",
      `Failed to connect to ${endpoint}${cause ? `: ${cause.message}` : ""}`,
    );
  }
}

export class TransactionFailedError extends MachOneError {
  constructor(txHash: string, reason?: string) {
    super(
      "TRANSACTION_FAILED",
      "NETWORK",
      `Transaction failed: ${txHash}${reason ? ` - ${reason}` : ""}`,
    );
  }
}

export class RPCError extends MachOneError {
  constructor(method: string, error: unknown) {
    super(
      "RPC_ERROR",
      "NETWORK",
      `RPC call failed for ${method}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Configuration Errors
export class ConfigError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("CONFIG_ERROR", "CONFIG", message, details);
  }
}

export class MissingConfigError extends MachOneError {
  constructor(key: string) {
    super("MISSING_CONFIG", "CONFIG", `Missing required configuration: ${key}`);
  }
}

export class InvalidPrivateKeyError extends MachOneError {
  constructor() {
    super(
      "INVALID_PRIVATE_KEY",
      "CONFIG",
      "Invalid private key format. Expected hex string starting with 0x",
    );
  }
}

// Strategy Errors
export class StrategyError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("STRATEGY_ERROR", "STRATEGY", message, details);
  }
}

export class StrategyInitializationError extends MachOneError {
  constructor(strategyName: string, reason: string) {
    super(
      "STRATEGY_INIT_ERROR",
      "STRATEGY",
      `Failed to initialize strategy ${strategyName}: ${reason}`,
    );
  }
}

export class StrategyExecutionError extends MachOneError {
  constructor(strategyName: string, error: Error) {
    super(
      "STRATEGY_EXECUTION_ERROR",
      "STRATEGY",
      `Strategy execution failed for ${strategyName}: ${error.message}`,
    );
  }
}

export class BacktestError extends MachOneError {
  constructor(reason: string, details?: unknown) {
    super("BACKTEST_ERROR", "STRATEGY", `Backtest failed: ${reason}`, details);
  }
}

// Risk Management Errors
export class RiskError extends MachOneError {
  constructor(message: string, details?: unknown) {
    super("RISK_ERROR", "RISK", message, details);
  }
}

export class RiskLimitExceededError extends MachOneError {
  constructor(limitType: string, current: number, limit: number) {
    super(
      "RISK_LIMIT_EXCEEDED",
      "RISK",
      `${limitType} limit exceeded. Current: ${current}, Limit: ${limit}`,
    );
  }
}

export class PositionLimitError extends MachOneError {
  constructor(symbol: string, requestedSize: number, maxSize: number) {
    super(
      "POSITION_LIMIT_ERROR",
      "RISK",
      `Position size limit exceeded for ${symbol}. Requested: ${requestedSize}, Max: ${maxSize}`,
    );
  }
}

export class DailyLossLimitError extends MachOneError {
  constructor(currentLoss: number, limit: number) {
    super(
      "DAILY_LOSS_LIMIT_ERROR",
      "RISK",
      `Daily loss limit exceeded. Current loss: ${currentLoss}, Limit: ${limit}`,
    );
  }
}

// Monaco SDK Error
export class MonacoSDKError extends MachOneError {
  readonly originalCode?: string;

  constructor(message: string, code?: string, details?: unknown) {
    super(code ?? "MONACO_ERROR", "NETWORK", message, details);
    this.originalCode = code;
  }
}

// Error factory function
export function createError(
  type: "validation" | "trading" | "network" | "config" | "strategy" | "risk",
  code: string,
  message: string,
  details?: unknown,
): MachOneError {
  const errorMap = {
    validation: ValidationError,
    trading: TradingError,
    network: NetworkError,
    config: ConfigError,
    strategy: StrategyError,
    risk: RiskError,
  };

  const ErrorClass = errorMap[type];
  const error = new ErrorClass(message, details);
  return error;
}

// Error handler utility
export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorCallbacks: Array<(error: MachOneError) => void> = [];

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  onError(callback: (error: MachOneError) => void): void {
    this.errorCallbacks.push(callback);
  }

  handle(error: Error | MachOneError): void {
    const machError =
      error instanceof MachOneError
        ? error
        : new MachOneError("UNKNOWN_ERROR", "TRADING", error.message, {
            originalError: error,
          });

    // Log error
    console.error("SDK Error:", machError.toJSON());

    // Notify callbacks
    this.errorCallbacks.forEach((callback) => {
      try {
        callback(machError as MachOneError);
      } catch (callbackError) {
        console.error("Error in error callback:", callbackError);
      }
    });
  }

  isRetryable(error: MachOneError): boolean {
    const retryableCodes = ["CONNECTION_ERROR", "RPC_ERROR", "NETWORK_ERROR"];
    return retryableCodes.includes(error.code);
  }

  shouldEmergencyStop(error: MachOneError): boolean {
    const emergencyStopCodes = [
      "DAILY_LOSS_LIMIT_ERROR",
      "RISK_LIMIT_EXCEEDED",
      "INVALID_PRIVATE_KEY",
    ];
    return emergencyStopCodes.includes(error.code);
  }
}
