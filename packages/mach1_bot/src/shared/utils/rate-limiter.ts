/**
 * Rate Limiting Utilities
 *
 * Implements token bucket algorithm for rate limiting API requests
 * and exponential backoff for retry logic.
 */

import { DEFAULT_RATE_LIMIT } from "@/shared/constants/monaco";
import { createLogger } from "./logger";

const logger = createLogger("RateLimiter");

/**
 * Exponential backoff with jitter
 * Prevents thundering herd problem by adding randomization
 */
export function exponentialBackoff(
  attempt: number,
  baseMs: number = DEFAULT_RATE_LIMIT.backoffBaseMs,
  maxMs: number = DEFAULT_RATE_LIMIT.backoffMaxMs,
): number {
  const exponentialDelay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = exponentialDelay * (0.5 + Math.random() * 0.5);
  return Math.floor(jitter);
}

/**
 * Token Bucket Rate Limiter
 * Implements token bucket algorithm with configurable capacity and refill rate
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
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

    // Start refill timer
    this.startRefillTimer();
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquire(category?: string): Promise<void> {
    this.refillTokens();

    if (this.tokens > 0) {
      this.tokens--;
      logger.debug("Token acquired", {
        category,
        tokensRemaining: this.tokens,
        queueLength: this.queue.length,
      });
      return Promise.resolve();
    }

    // No tokens available, queue the request
    logger.debug("Rate limit reached, queuing request", {
      category,
      queueLength: this.queue.length + 1,
    });

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000; // seconds
    const tokensToAdd = elapsed * this.refillRate;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillTime = now;

      // Process queued requests
      this.processQueue();
    }
  }

  /**
   * Process queued requests if tokens are available
   */
  private processQueue(): void {
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--;
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
        logger.debug("Queued request processed", {
          tokensRemaining: this.tokens,
          queueLength: this.queue.length,
        });
      }
    }
  }

  /**
   * Start timer to refill tokens periodically
   */
  private startRefillTimer(): void {
    setInterval(() => {
      this.refillTokens();
    }, 100); // Check every 100ms
  }

  /**
   * Get current rate limit status
   */
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

  /**
   * Reset rate limiter (useful for testing)
   */
  reset(): void {
    this.tokens = this.capacity;
    this.queue = [];
    this.lastRefillTime = Date.now();
  }
}

/**
 * Rate Limited API Client
 * Wraps an API client with rate limiting using a shared rate limiter
 */
export class RateLimitedAPIClient<T extends object> {
  private rateLimiter: TokenBucketRateLimiter;
  private client: T;

  constructor(client: T, rateLimiter?: TokenBucketRateLimiter) {
    this.client = client;
    this.rateLimiter = rateLimiter || new TokenBucketRateLimiter();
  }

  /**
   * Wrap a function with rate limiting
   */
  async withRateLimit<R>(fn: () => Promise<R>, category?: string): Promise<R> {
    await this.rateLimiter.acquire(category);
    return fn();
  }

  /**
   * Get the underlying client (for direct access when needed)
   */
  getClient(): T {
    return this.client;
  }

  /**
   * Get rate limiter status
   */
  getRateLimitStatus() {
    return this.rateLimiter.getRateLimitStatus();
  }

  /**
   * Create a proxied version of the client with automatic rate limiting
   */
  createProxy(): T {
    return new Proxy(this.client, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);

        // If it's a function, wrap it with rate limiting
        if (typeof value === "function") {
          return async (...args: unknown[]) => {
            return this.withRateLimit(
              () => value.apply(target, args),
              String(prop),
            );
          };
        }

        return value;
      },
    });
  }
}

/**
 * Retry a function with exponential backoff
 */
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

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Calculate backoff delay
      const delay = exponentialBackoff(attempt, baseDelayMs, maxDelayMs);

      logger.debug("Retrying after failure", {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });

      // Call onRetry callback if provided
      if (onRetry) {
        onRetry(attempt + 1, error, delay);
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
