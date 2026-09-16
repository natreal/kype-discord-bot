/**
 * Safe serialization helpers.
 *
 * `safeStringify` always produces a string (never throws on cycles, BigInt or
 * Errors) and is the only serializer the logger uses. `redactSecrets` is applied
 * to log metadata so that tokens cannot leak accidentally.
 */

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|database[-_]?url|connection[-_]?string)/i;

const REDACTED = "[redacted]";

/** Recursively replaces values of secret-looking keys with `[redacted]`. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[max depth]";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }
  if (value instanceof Date || value instanceof Error) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(entry, depth + 1);
  }
  return result;
}

/** Serializes anything to a log-safe string, including cyclic structures. */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry === "bigint") {
          return entry.toString();
        }
        if (entry instanceof Error) {
          return { name: entry.name, message: entry.message };
        }
        if (typeof entry === "object" && entry !== null) {
          if (seen.has(entry)) {
            return "[circular]";
          }
          seen.add(entry);
        }
        return entry;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

/** Formats an error (plus cause chain) for internal logs. */
export function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `Non-error thrown: ${safeStringify(error)}`;
  }

  const lines = [`${error.name}: ${error.message}`];
  const { cause } = error;
  if (cause instanceof Error) {
    lines.push(`  caused by ${cause.name}: ${cause.message}`);
  }
  if (error.stack) {
    const [, ...rest] = error.stack.split("\n");
    lines.push(...rest.map((line) => line.trimEnd()));
  }
  return lines.join("\n");
}
