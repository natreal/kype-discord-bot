/**
 * Logger and serialization tests.
 *
 * The logger is the only component allowed to write to the console, so its
 * level filtering, secret redaction and sink isolation are all covered here.
 */
import { describe, expect, it } from "vitest";

import { createLogger, nullLogger } from "../../src/services/logger/logger.js";
import { LOG_LEVEL_SEVERITY, isLogLevel } from "../../src/services/logger/types.js";
import { MemorySink, type LogRecord } from "../../src/services/logger/index.js";
import { formatError, redactSecrets, safeStringify } from "../../src/utils/serialization.js";
import { AppError, toError, userFacingMessage } from "../../src/utils/errors.js";

function loggerWith(sink: MemorySink, level: "debug" | "info" | "warn" | "error" = "debug") {
  return createLogger("test", { level, sinks: [sink] });
}

describe("logger", () => {
  it("writes structured records to its sinks", () => {
    const sink = new MemorySink();
    loggerWith(sink).info("Application starting", { guilds: 3 });

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0] as LogRecord;
    expect(record.level).toBe("info");
    expect(record.scope).toBe("test");
    expect(record.message).toBe("Application starting");
    expect(record.metadata).toEqual({ guilds: 3 });
    expect(new Date(record.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("filters records below the configured level", () => {
    const sink = new MemorySink();
    const logger = loggerWith(sink, "warn");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message", new Error("boom"));

    expect(sink.records.map((record) => record.level)).toEqual(["warn", "error"]);
  });

  it("attaches stack traces to errors but never to warnings", () => {
    const sink = new MemorySink();
    const logger = loggerWith(sink);

    logger.error("failed", new Error("boom"));
    logger.warn("careful");

    expect(sink.records[0]?.stack).toContain("boom");
    expect(sink.records[1]?.stack).toBeUndefined();
  });

  it("redacts secret-looking metadata before it reaches a sink", () => {
    const sink = new MemorySink();
    loggerWith(sink).info("connecting", {
      token: "super-secret",
      databaseUrl: "postgresql://user:pass@host/db",
      nested: { apiKey: "abc123", safe: "ok" },
    });

    const serialized = JSON.stringify(sink.records[0]?.metadata);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("pass@host");
    expect(serialized).not.toContain("abc123");
    expect(serialized).toContain("ok");
  });

  it("namespaces child loggers and keeps context on every record", () => {
    const sink = new MemorySink();
    const logger = loggerWith(sink)
      .child("database")
      .withContext({ guildId: "111111111111111111" });

    logger.info("connected");

    const record = sink.records[0] as LogRecord;
    expect(record.scope).toBe("test:database");
    expect(record.context?.guildId).toBe("111111111111111111");
  });

  it("never throws when a sink fails", () => {
    const logger = createLogger("test", {
      level: "debug",
      sinks: [
        {
          name: "broken",
          write() {
            throw new Error("sink is down");
          },
        },
      ],
    });

    expect(() => logger.info("still safe")).not.toThrow();
  });

  it("null logger is a no-op", () => {
    expect(() => nullLogger.error("ignored", new Error("x"))).not.toThrow();
    expect(nullLogger.child("anything")).toBe(nullLogger);
  });

  it("validates log levels", () => {
    expect(isLogLevel("info")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(LOG_LEVEL_SEVERITY.debug).toBeLessThan(LOG_LEVEL_SEVERITY.error);
  });
});

describe("serialization", () => {
  it("serializes cyclic and bigint values without throwing", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic["self"] = cyclic;

    expect(() => safeStringify(cyclic)).not.toThrow();
    expect(safeStringify(cyclic)).toContain("[circular]");
    expect(safeStringify({ value: 10n })).toContain("10");
  });

  it("formats errors with their cause chain", () => {
    const error = new Error("outer", { cause: new Error("inner") });
    const formatted = formatError(error);

    expect(formatted).toContain("Error: outer");
    expect(formatted).toContain("caused by Error: inner");
  });

  it("only redacts keys that look secret", () => {
    expect(redactSecrets({ username: "nathan", password: "hunter2" })).toEqual({
      username: "nathan",
      password: "[redacted]",
    });
  });
});

describe("error taxonomy", () => {
  it("distinguishes expected (user-facing) errors from internal ones", () => {
    const expected = new AppError("Bad input", { code: "VALIDATION_FAILED", expected: true });
    const internal = new AppError("boom", { code: "INTERNAL_ERROR" });

    expect(userFacingMessage(expected)).toBe("Bad input");
    expect(userFacingMessage(internal)).toBeUndefined();
    expect(userFacingMessage(new Error("raw"))).toBeUndefined();
  });

  it("normalizes non-error throws", () => {
    expect(toError("plain string").message).toBe("plain string");
    expect(toError(42).message).toContain("Non-error value thrown");
  });
});
