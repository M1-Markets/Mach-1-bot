/**
 * Structured Logger Utility
 *
 * Provides structured logging with timestamps, severity levels, and component identification.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ANSI color codes for terminal output
const COLORS = {
  DEBUG: "\x1b[36m", // Cyan
  INFO: "\x1b[32m", // Green
  WARN: "\x1b[33m", // Yellow
  ERROR: "\x1b[31m", // Red
  RESET: "\x1b[0m",
  GRAY: "\x1b[90m",
} as const;

class LoggerImpl {
  private currentLevel: LogLevel = "INFO";
  private component: string;

  constructor(component = "Global") {
    this.component = component;
  }

  setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  getCurrentLevel(): LogLevel {
    return this.currentLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.currentLevel];
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private formatMessage(
    level: LogLevel,
    message: string,
    metadata?: unknown,
  ): string {
    const timestamp = this.formatTimestamp();
    const color = COLORS[level];
    const reset = COLORS.RESET;
    const gray = COLORS.GRAY;

    let formatted = `${gray}[${timestamp}]${reset} ${color}[${level}]${reset} ${gray}[${this.component}]${reset} ${message}`;

    if (metadata !== undefined) {
      try {
        const json = JSON.stringify(metadata);
        if (json && json !== "{}") {
          formatted += ` ${gray}${json}${reset}`;
        }
      } catch {
        formatted += ` ${gray}${String(metadata)}${reset}`;
      }
    }

    return formatted;
  }

  debug(message: string, metadata?: unknown): void {
    if (this.shouldLog("DEBUG")) {
      console.log(
        this.formatMessage("DEBUG", message, this.normalizeMetadata(metadata)),
      );
    }
  }

  info(message: string, metadata?: unknown): void {
    if (this.shouldLog("INFO")) {
      console.log(
        this.formatMessage("INFO", message, this.normalizeMetadata(metadata)),
      );
    }
  }

  warn(message: string, metadata?: unknown, error?: unknown): void {
    if (this.shouldLog("WARN")) {
      const meta = this.extractErrorFromArgs(metadata, error);
      console.warn(this.formatMessage("WARN", message, meta));
    }
  }

  error(message: string, metadata?: unknown, error?: unknown): void {
    if (this.shouldLog("ERROR")) {
      const meta = this.extractErrorFromArgs(metadata, error);
      console.error(this.formatMessage("ERROR", message, meta));
    }
  }

  private extractErrorFromArgs(
    metadata?: unknown,
    error?: unknown,
  ): Record<string, unknown> {
    let meta: Record<string, unknown> = {};
    if (
      metadata &&
      typeof metadata === "object" &&
      !(metadata instanceof Error)
    ) {
      try {
        meta = { ...(metadata as Record<string, unknown>) };
      } catch {
        // fall through, keep as empty meta
      }
    }

    if (metadata instanceof Error && !error) {
      const err = metadata as Error;
      meta = { ...meta, error: err.message, stack: err.stack };
      return meta;
    }

    if (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      meta = { ...meta, error: err.message, stack: err.stack };
    }

    return meta;
  }

  private normalizeMetadata(metadata?: unknown): unknown {
    if (!metadata) return undefined;
    if (metadata instanceof Error) {
      return { error: metadata.message, stack: metadata.stack };
    }
    if (typeof metadata === "object") return metadata;
    return { info: String(metadata) };
  }
}

// Global logger instance
export const logger = new LoggerImpl("Global");

/**
 * Create a logger instance for a specific component
 */
export function createLogger(component: string): LoggerImpl {
  return new LoggerImpl(component);
}

/**
 * Set global log level
 */
export function setGlobalLogLevel(level: LogLevel): void {
  logger.setLogLevel(level);
}

export type Logger = LoggerImpl;
