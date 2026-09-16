/**
 * The human-readable log sink.
 *
 * Development output is colorized when the terminal supports it; production
 * output is plain so it stays readable in CI, systemd, Docker and pm2 logs.
 *
 * This is the ONLY place in the project allowed to write to the console.
 */
import { formatError, safeStringify } from "../../utils/serialization.js";
import type { LogSink, LogRecord } from "./types.js";

interface Palette {
  readonly reset: string;
  readonly dim: string;
  readonly debug: string;
  readonly info: string;
  readonly warn: string;
  readonly error: string;
}

const COLOR: Palette = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  debug: "\u001B[90m",
  info: "\u001B[36m",
  warn: "\u001B[33m",
  error: "\u001B[31m",
};

const PLAIN: Palette = {
  reset: "",
  dim: "",
  debug: "",
  info: "",
  warn: "",
  error: "",
};

export interface ConsoleSinkOptions {
  /** Enables ANSI colors. Detected from the terminal by default. */
  readonly color?: boolean;
}

/** Writes `[LEVEL] message` lines to stdout/stderr. */
export class ConsoleSink implements LogSink {
  public readonly name = "console";

  private readonly palette: Palette;

  public constructor(options: ConsoleSinkOptions = {}) {
    const useColor = options.color ?? Boolean(process.stdout.isTTY);
    this.palette = useColor ? COLOR : PLAIN;
  }

  public write(record: LogRecord): void {
    const { palette } = this;
    const levelColor = palette[record.level];
    const line = [
      `${palette.dim}${record.timestamp}${palette.reset}`,
      `${levelColor}[${record.level.toUpperCase()}]${palette.reset}`,
      `${palette.dim}${record.scope}${palette.reset}`,
      record.message,
    ].join(" ");

    const details: string[] = [];
    if (record.context && Object.keys(record.context).length > 0) {
      details.push(`${palette.dim}context:${palette.reset} ${safeStringify(record.context)}`);
    }
    if (record.metadata && Object.keys(record.metadata).length > 0) {
      details.push(`${palette.dim}meta:${palette.reset} ${safeStringify(record.metadata)}`);
    }
    if (record.stack) {
      details.push(`${palette.dim}${record.stack}${palette.reset}`);
    } else if (record.level === "error") {
      details.push(`${palette.dim}(no stack trace)${palette.reset}`);
    }

    const output = details.length > 0 ? `${line}\n${details.join("\n")}` : line;
    const stream =
      record.level === "warn" || record.level === "error" ? process.stderr : process.stdout;
    stream.write(`${output}\n`);
  }
}

/** Sink that stores nothing; used by tests that only assert on behavior. */
export class MemorySink implements LogSink {
  public readonly name = "memory";
  public readonly records: LogRecord[] = [];

  public write(record: LogRecord): void {
    this.records.push(record);
  }

  public clear(): void {
    this.records.length = 0;
  }

  public find(predicate: (record: LogRecord) => boolean): LogRecord | undefined {
    return this.records.find(predicate);
  }
}

/** Sink that emits structured JSON, ready for external monitoring. */
export class JsonSink implements LogSink {
  public readonly name = "json";

  public write(record: LogRecord): void {
    process.stdout.write(`${safeStringify(record)}\n`);
  }
}

/** Re-exported for sinks that need to render an unknown error value. */
export { formatError };
