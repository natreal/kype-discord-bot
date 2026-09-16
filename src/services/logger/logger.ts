/**
 * Centralized structured logger.
 *
 * Goals:
 * - One entry point for every diagnostic message (`createLogger`).
 * - Sink-based design so Discord log channels, JSON shipping and security/
 *   moderation log streams can be added without touching call sites.
 * - Automatic secret redaction: metadata is scrubbed before it leaves the app.
 * - Never throws: logging must not be able to break a command.
 */
import {
  LOG_LEVEL_SEVERITY,
  type LogContext,
  type LogLevel,
  type LogSink,
  type LogRecord,
} from "./types.js";
import { ConsoleSink } from "./sinks.js";
import { formatError, redactSecrets } from "../../utils/serialization.js";

/** Public logger interface consumed by services, modules and commands. */
export interface Logger {
  readonly scope: string;
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
  /** Creates a child logger whose scope is namespaced (`parent:child`). */
  child(scope: string): Logger;
  /** Returns a logger that attaches fixed context (guild, user) to every record. */
  withContext(context: LogContext): Logger;
}

export interface LoggerOptions {
  /** Minimum level that is written. Defaults to `info`. */
  readonly level: LogLevel;
  /** Destinations for records. Defaults to a single colorized console sink. */
  readonly sinks?: readonly LogSink[];
  /** Base context merged into every record (e.g. process information). */
  readonly context?: LogContext;
}

/** Creates a logger with the given scope and options. */
export function createLogger(scope: string, options: LoggerOptions): Logger {
  const sinks = options.sinks ?? [new ConsoleSink()];
  const threshold = LOG_LEVEL_SEVERITY[options.level];

  return buildLogger(scope, options, sinks, threshold, options.context ?? {});
}

/**
 * Shared construction for root, child and context-bound loggers.
 *
 * All three variants funnel into the same `emit`, so level filtering, redaction,
 * stack traces and context attachment behave identically everywhere.
 */
function buildLogger(
  scope: string,
  options: LoggerOptions,
  sinks: readonly LogSink[],
  threshold: number,
  context: LogContext,
): Logger {
  const emit = (
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>,
    error?: unknown,
  ): void => {
    if (LOG_LEVEL_SEVERITY[level] < threshold) {
      return;
    }

    const record: LogRecord = {
      level,
      timestamp: new Date().toISOString(),
      scope,
      // Error messages carry the guild ID inline so log lines stay greppable,
      // while the structured `context` below remains machine-readable.
      message:
        level === "error" && context.guildId ? `[guild:${context.guildId}] ${message}` : message,
      metadata:
        metadata === undefined ? undefined : (redactSecrets(metadata) as Record<string, unknown>),
      stack: level === "error" && error !== undefined ? formatError(error) : undefined,
      context: Object.keys(context).length > 0 ? { ...context } : undefined,
    };

    for (const sink of sinks) {
      try {
        sink.write(record);
      } catch {
        // A broken sink must never break the application.
      }
    }
  };

  return {
    scope,
    debug: (message, metadata) => {
      emit("debug", message, metadata);
    },
    info: (message, metadata) => {
      emit("info", message, metadata);
    },
    warn: (message, metadata) => {
      emit("warn", message, metadata);
    },
    error: (message, error, metadata) => {
      emit("error", message, metadata, error);
    },
    child: (childScope) =>
      buildLogger(`${scope}:${childScope}`, options, sinks, threshold, context),
    withContext: (extra) => buildLogger(scope, options, sinks, threshold, { ...context, ...extra }),
  };
}

/** No-op logger used in tests and in code paths where logging is optional. */
export const nullLogger: Logger = {
  scope: "null",
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
  withContext: () => nullLogger,
};
