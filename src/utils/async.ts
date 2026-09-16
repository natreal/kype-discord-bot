/**
 * Small, dependency-free helpers shared across the codebase.
 */

/** @returns a promise that resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs `runnable`, retrying on failure with exponential backoff.
 *
 * Used for transient network/API failures. Rate-limit aware: `shouldRetry` can
 * be supplied to avoid retrying errors that must not be repeated.
 */
export async function retry<T>(
  runnable: () => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await runnable();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt > retries;
      if (isLastAttempt || options.shouldRetry?.(error, attempt) === false) {
        break;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Returns `value` when it is a non-empty string, otherwise `undefined`. */
export function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Chunks an array into arrays of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) {
    throw new RangeError("chunk size must be greater than zero");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Groups items by a derived key. */
export function groupBy<T, K extends string>(
  items: readonly T[],
  keySelector: (item: T) => K,
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keySelector(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
