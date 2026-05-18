import { StatusCodes } from "http-status-codes";

const REDACTED_FIELDS = [
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "secret",
  "password",
  "authorization",
  "bearer",
  "signature",
  "privateKey",
  "private_key",
  "mnemonic",
  "session",
  "sessionId",
  "session_id",
  "wallet",
  "walletClient",
] as const;

function sanitizeData(data: unknown, maxDepth = 5, currentDepth = 0): unknown {
  if (currentDepth >= maxDepth) {
    return "[Max depth reached]";
  }

  if (data === null || data === undefined) {
    return data;
  }

  if (Array.isArray(data)) {
    const limit = 10;
    const sanitized = data
      .slice(0, limit)
      .map((item) => sanitizeData(item, maxDepth, currentDepth + 1));

    if (data.length > limit) {
      sanitized.push(`[... ${data.length - limit} more items]`);
    }

    return sanitized;
  }

  if (typeof data === "object") {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = REDACTED_FIELDS.some((field) =>
        lowerKey.includes(field.toLowerCase()),
      );

      if (isSensitive) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 500) {
        sanitized[key] = `${value.slice(0, 500)}... [truncated]`;
      } else {
        sanitized[key] = sanitizeData(value, maxDepth, currentDepth + 1);
      }
    }

    return sanitized;
  }

  if (typeof data === "string" && data.length > 1000) {
    return `${data.slice(0, 1000)}... [truncated]`;
  }

  return data;
}

export const ERROR_CODES = {
  API_ERROR: "API_ERROR",
  CONTRACT_ERROR: "CONTRACT_ERROR",
  EVENT_ERROR: "EVENT_ERROR",
  INITIALIZATION_ERROR: "INITIALIZATION_ERROR",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_ORDER: "INVALID_ORDER",
  INVALID_STATE: "INVALID_STATE",
  ORDER_ERROR: "ORDER_ERROR",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  SUBSCRIPTION_ERROR: "SUBSCRIPTION_ERROR",
  TRANSACTION_ERROR: "TRANSACTION_ERROR",
  UNSUPPORTED_NETWORK: "UNSUPPORTED_NETWORK",
} as const;

type MonacoErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

type ErrorOptions = {
  cause?: unknown;
  retryable?: boolean;
  suggestion?: string;
};

export abstract class MonacoCoreError extends Error {
  abstract readonly code: MonacoErrorCode;
  readonly cause?: unknown;
  readonly retryable: boolean;
  readonly suggestion?: string;
  readonly timestamp: number;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
    this.suggestion = options.suggestion;
    this.timestamp = Date.now();
  }

  toJSON(): Record<string, unknown> {
    return {
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
      code: this.code,
      message: this.message,
      name: this.name,
      retryable: this.retryable,
      suggestion: this.suggestion,
      timestamp: this.timestamp,
    };
  }
}

export class InvalidConfigError extends MonacoCoreError {
  readonly code = ERROR_CODES.INVALID_CONFIG;

  constructor(
    message: string,
    readonly field?: string,
    readonly value?: unknown,
    cause?: unknown,
  ) {
    super(message, {
      cause,
      suggestion: field
        ? `Check '${field}' configuration value.`
        : "Review SDK configuration values.",
    });
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      field: this.field,
      value: sanitizeData(this.value),
    };
  }
}

export class InvalidStateError extends MonacoCoreError {
  readonly code = ERROR_CODES.INVALID_STATE;

  constructor(
    message: string,
    readonly currentState?: string,
    readonly expectedState?: string,
    cause?: unknown,
  ) {
    super(message, {
      cause,
      suggestion: expectedState
        ? `${currentState ? `Current state '${currentState}'. ` : ""}Expected '${expectedState}'.`
        : "Check call order before retrying.",
    });
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      currentState: this.currentState,
      expectedState: this.expectedState,
    };
  }
}

type APIErrorOptions = ErrorOptions & {
  endpoint?: string;
  requestBody?: unknown;
  requestId?: string;
  responseBody?: unknown;
  retryAfter?: number;
  statusCode?: number;
};

function getSuggestionForStatus(
  statusCode: number | undefined,
  message?: string,
): { retryable: boolean; suggestion: string } {
  if (statusCode === undefined) {
    return {
      retryable: true,
      suggestion: "Network request failed. Check connection and retry.",
    };
  }

  if (statusCode === StatusCodes.UNAUTHORIZED) {
    if (message?.toLowerCase().includes("expired")) {
      return {
        retryable: false,
        suggestion: "Session expired. Call sdk.refreshAuth() or sdk.login().",
      };
    }

    return {
      retryable: false,
      suggestion: "Authentication required. Call sdk.login() before retrying.",
    };
  }

  if (statusCode === StatusCodes.FORBIDDEN) {
    return {
      retryable: false,
      suggestion: "Access denied. Confirm permissions and account setup.",
    };
  }

  if (statusCode === StatusCodes.TOO_MANY_REQUESTS) {
    return {
      retryable: true,
      suggestion: "Rate limited. Wait briefly, then retry.",
    };
  }

  if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    return {
      retryable: true,
      suggestion: "Remote service failed. Retry after short delay.",
    };
  }

  if (statusCode === StatusCodes.BAD_REQUEST) {
    return {
      retryable: false,
      suggestion: "Request validation failed. Check inputs before retrying.",
    };
  }

  return {
    retryable: false,
    suggestion: "Review request state before retrying.",
  };
}

export class APIError extends MonacoCoreError {
  readonly code = ERROR_CODES.API_ERROR;
  readonly endpoint?: string;
  readonly requestBody?: unknown;
  readonly requestId?: string;
  readonly responseBody?: unknown;
  readonly retryAfter?: number;
  readonly statusCode?: number;

  constructor(message: string, options: APIErrorOptions = {}) {
    const derived = getSuggestionForStatus(options.statusCode, message);

    super(message, {
      cause: options.cause,
      retryable: options.retryable ?? derived.retryable,
      suggestion: options.suggestion ?? derived.suggestion,
    });

    this.endpoint = options.endpoint;
    this.requestBody = options.requestBody;
    this.requestId = options.requestId;
    this.responseBody = options.responseBody;
    this.retryAfter = options.retryAfter;
    this.statusCode = options.statusCode;
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      endpoint: this.endpoint,
      requestBody: sanitizeData(this.requestBody),
      requestId: this.requestId,
      responseBody: sanitizeData(this.responseBody),
      retryAfter: this.retryAfter,
      statusCode: this.statusCode,
    };
  }
}

export class ContractError extends MonacoCoreError {
  readonly code = ERROR_CODES.CONTRACT_ERROR;
}
