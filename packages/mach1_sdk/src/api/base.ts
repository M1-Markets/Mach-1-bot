import { StatusCodes } from "http-status-codes";
import { APIError } from "../errors/index";

export interface RetryOptions {
  baseDelayMs?: number;
  maxRetries?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export abstract class BaseAPI {
  protected accessToken?: string;
  protected readonly retryOptions: Required<RetryOptions>;

  constructor(
    protected readonly apiUrl: string,
    retryOptions?: RetryOptions,
  ) {
    this.retryOptions = {
      baseDelayMs: retryOptions?.baseDelayMs ?? 1000,
      maxRetries: retryOptions?.maxRetries ?? 3,
    };
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  protected getAccessToken(): string | undefined {
    return this.accessToken;
  }

  private parseRequestBody(body: RequestInit["body"]): unknown {
    if (!body) {
      return undefined;
    }

    if (typeof body === "string") {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }

    if (body instanceof FormData) {
      const out: Record<string, unknown> = {};
      body.forEach((value, key) => {
        out[key] = value instanceof File ? `[File: ${value.name}]` : value;
      });
      return out;
    }

    if (body instanceof URLSearchParams) {
      const out: Record<string, string> = {};
      body.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }

    if (body instanceof Blob) {
      return { contentType: body.type, size: body.size, type: "[Blob]" };
    }

    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return { size: body.byteLength, type: "[ArrayBuffer]" };
    }

    if (
      typeof ReadableStream !== "undefined" &&
      body instanceof ReadableStream
    ) {
      return { note: "Stream body not captured", type: "[ReadableStream]" };
    }

    return { bodyType: typeof body, type: "[Unknown]" };
  }

  private extractResponseMetadata(headers?: Headers): {
    requestId?: string;
    retryAfter?: number;
  } {
    if (!headers) {
      return {};
    }

    const requestId =
      headers.get("x-request-id") ??
      headers.get("request-id") ??
      headers.get("x-correlation-id") ??
      undefined;

    const retryAfterHeader = headers.get("retry-after");
    const retryAfter =
      retryAfterHeader === null
        ? undefined
        : Number.parseInt(retryAfterHeader, 10);

    return {
      requestId,
      retryAfter: Number.isNaN(retryAfter) ? undefined : retryAfter,
    };
  }

  private async executeRequest<T>(
    url: string,
    endpoint: string,
    options: RequestInit,
    requestBody: unknown,
  ): Promise<T> {
    let response: Response;
    let didTimeout = false;
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(options.signal?.reason);
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      abortController.abort(
        new Error(`Request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`),
      );
    }, DEFAULT_REQUEST_TIMEOUT_MS);

    if (options.signal) {
      if (options.signal.aborted) {
        forwardAbort();
      } else {
        options.signal.addEventListener("abort", forwardAbort, { once: true });
      }
    }

    try {
      response = await fetch(url, {
        ...options,
        signal: abortController.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", forwardAbort);
      }

      if (didTimeout) {
        throw new APIError(
          `Request timed out for ${endpoint} after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
          {
            cause: error instanceof Error ? error : new Error(String(error)),
            endpoint: url,
            requestBody,
          },
        );
      }

      throw new APIError(`Network request failed for ${endpoint}`, {
        cause: error instanceof Error ? error : new Error(String(error)),
        endpoint: url,
        requestBody,
      });
    }

    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener("abort", forwardAbort);
    }

    let responseBody: unknown;
    const contentType = response.headers?.get("content-type") || "unknown";
    const responseClone = response.clone ? response.clone() : response;

    try {
      responseBody = await response.json();
    } catch (parseError) {
      let responseText = "[Unable to read response body]";

      try {
        responseText = await responseClone.text();
        // biome-ignore lint/suspicious/noEmptyBlockStatements: guard against text() throwing (e.g. if body is a stream that has already been read)
      } catch {}

      if (!response.ok) {
        const { requestId, retryAfter } = this.extractResponseMetadata(
          response.headers,
        );

        throw new APIError(
          `API request failed: ${response.status}. Response is not JSON (${contentType})`,
          {
            cause: parseError instanceof Error ? parseError : undefined,
            endpoint: url,
            requestBody,
            requestId,
            responseBody: {
              contentType,
              parseError:
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError),
              rawResponse: responseText.slice(0, 500),
            },
            retryAfter,
            statusCode: response.status,
          },
        );
      }

      throw new APIError(`Expected JSON response but received ${contentType}`, {
        cause: parseError instanceof Error ? parseError : undefined,
        endpoint: url,
        requestBody,
        responseBody: {
          contentType,
          rawResponse: responseText.slice(0, 500),
        },
        statusCode: response.status,
      });
    }

    if (!response.ok) {
      const errorBody =
        responseBody !== null && typeof responseBody === "object"
          ? (responseBody as Record<string, unknown>)
          : undefined;
      const message =
        (typeof errorBody?.message === "string"
          ? errorBody.message
          : undefined) ||
        (typeof errorBody?.error === "string" ? errorBody.error : undefined) ||
        `API request failed: ${response.status}`;
      const { requestId, retryAfter } = this.extractResponseMetadata(
        response.headers,
      );

      throw new APIError(message, {
        endpoint: url,
        requestBody,
        requestId,
        responseBody,
        retryAfter,
        statusCode: response.status,
      });
    }

    return responseBody as T;
  }

  protected async makeAuthenticatedRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    if (!this.accessToken) {
      throw new APIError("Access token not set. Call setAccessToken() first.", {
        endpoint: `${this.apiUrl}${endpoint}`,
        statusCode: StatusCodes.UNAUTHORIZED,
      });
    }

    const url = `${this.apiUrl}${endpoint}`;
    const requestBody = this.parseRequestBody(options.body);

    return this.executeRequest<T>(
      url,
      endpoint,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          ...options.headers,
        },
      },
      requestBody,
    );
  }

  protected async makePublicRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;
    const requestBody = this.parseRequestBody(options.body);

    return this.executeRequest<T>(
      url,
      endpoint,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      requestBody,
    );
  }
}
