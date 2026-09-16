/**
 * Log record types.
 *
 * The logger core only depends on these types, so additional sinks (Discord log
 * channels, JSON transports, external monitoring) can be added later without
 * touching call sites.
 */
import type { LogLevel } from "../../config/env.schema.js";

export type { LogLevel };

/** Structured, redacted log record handed to every sink. */
export interface LogRecord {
  readonly level: LogLevel;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** Logger name, e.g. `loader:commands` or `service:database`. */
  readonly scope: string;
  readonly message: string;
  /** Redacted key/value diagnostics. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Human-readable stack trace for errors (never sent to Discord users). */
  readonly stack?: string | undefined;
  /** Optional guild/actor context used by future Discord log channels. */
  readonly context?: LogContext | undefined;
}

/** Additional context used to route records to per-guild log channels later. */
export interface LogContext {
  readonly guildId?: string | undefined;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  /** Categorizes records once Discord logging lands: `moderation`, `security`, ... */
  readonly category?: string | undefined;
}

/** A log destination. Implementations must never throw. */
export interface LogSink {
  readonly name: string;
  write(record: LogRecord): void;
}

/** Numeric severity used for level filtering. */
export const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** @returns true when the given level is a valid log level. */
export function isLogLevel(value: string): value is LogLevel {
  return value in LOG_LEVEL_SEVERITY;
}
