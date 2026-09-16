/**
 * Deep merge helpers for nested configuration objects.
 *
 * Only plain objects are merged recursively; arrays and primitives are replaced.
 * This keeps "update one section" semantics predictable for callers.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recursively merges `patch` into `base`, returning a new object. */
export function deepMerge<TBase extends object>(base: TBase, patch: object): TBase {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }

  return result as TBase;
}
