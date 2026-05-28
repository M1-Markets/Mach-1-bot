import { DEFAULT_RATE_LIMIT } from "./constants";

export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;

export const getRecord = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

export const getStringProp = (
  record: UnknownRecord | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

export const getNumberProp = (
  record: UnknownRecord | undefined,
  key: string,
): number | undefined => {
  const value = record?.[key];

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

export function normalizePrivateKey(privateKey: string): `0x${string}` {
  return privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : (`0x${privateKey}` as `0x${string}`);
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

class Logger {
  private readonly component: string;
  private readonly level: LogLevel;

  constructor(component: string) {
    this.component = component;
    this.level = this.readLevel();
  }

  debug(message: string, metadata?: unknown): void {
    this.log("DEBUG", message, metadata);
  }

  info(message: string, metadata?: unknown): void {
    this.log("INFO", message, metadata);
  }

  warn(message: string, metadata?: unknown, error?: unknown): void {
    this.log(
      "WARN",
      message,
      this.mergeMetadata(metadata, error),
      console.warn,
    );
  }

  error(message: string, metadata?: unknown, error?: unknown): void {
    this.log(
      "ERROR",
      message,
      this.mergeMetadata(metadata, error),
      console.error,
    );
  }

  private readLevel(): LogLevel {
    const envLevel = process.env.MONACO_LOG_LEVEL?.toUpperCase();
    if (
      envLevel === "DEBUG" ||
      envLevel === "INFO" ||
      envLevel === "WARN" ||
      envLevel === "ERROR"
    ) {
      return envLevel;
    }

    return "INFO";
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private log(
    level: LogLevel,
    message: string,
    metadata?: unknown,
    writer: (
      message?: unknown,
      ...optionalParams: unknown[]
    ) => void = console.log,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const payload = this.normalizeMetadata(metadata);
    if (payload === undefined) {
      writer(
        `[${new Date().toISOString()}] [${level}] [${this.component}] ${message}`,
      );
      return;
    }

    writer(
      `[${new Date().toISOString()}] [${level}] [${this.component}] ${message}`,
      payload,
    );
  }

  private mergeMetadata(metadata?: unknown, error?: unknown): unknown {
    if (!error) {
      return metadata;
    }

    const normalizedError =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : { error: String(error) };

    if (isRecord(metadata)) {
      return { ...metadata, ...normalizedError };
    }

    if (metadata === undefined) {
      return normalizedError;
    }

    return { metadata, ...normalizedError };
  }

  private normalizeMetadata(metadata?: unknown): unknown {
    if (metadata === undefined) {
      return undefined;
    }

    if (metadata instanceof Error) {
      return { error: metadata.message, stack: metadata.stack };
    }

    return metadata;
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}

export function exponentialBackoff(
  attempt: number,
  baseMs: number = DEFAULT_RATE_LIMIT.backoffBaseMs,
  maxMs: number = DEFAULT_RATE_LIMIT.backoffMaxMs,
): number {
  const exponentialDelay = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = exponentialDelay * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private lastRefillTime: number;
  private queue: Array<() => void> = [];

  constructor(
    capacity: number = DEFAULT_RATE_LIMIT.burstCapacity,
    refillRate: number = DEFAULT_RATE_LIMIT.maxRequestsPerSecond,
  ) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefillTime = Date.now();
    this.startRefillTimer();
  }

  async acquire(): Promise<void> {
    this.refillTokens();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  getRateLimitStatus(): {
    tokensAvailable: number;
    queueLength: number;
    capacity: number;
    refillRate: number;
  } {
    this.refillTokens();
    return {
      tokensAvailable: this.tokens,
      queueLength: this.queue.length,
      capacity: this.capacity,
      refillRate: this.refillRate,
    };
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRate;

    if (tokensToAdd <= 0) {
      return;
    }

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
    this.processQueue();
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--;
      const resolve = this.queue.shift();
      resolve?.();
    }
  }

  private startRefillTimer(): void {
    const timer = setInterval(() => {
      this.refillTokens();
    }, 100);

    timer.unref?.();
  }
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (attempt: number, error: unknown, delay: number) => void;
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = DEFAULT_RATE_LIMIT.backoffBaseMs,
    maxDelayMs = DEFAULT_RATE_LIMIT.backoffMaxMs,
    shouldRetry = () => true,
    onRetry,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = exponentialBackoff(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(attempt + 1, error, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("retryWithBackoff exhausted unexpectedly");
}
