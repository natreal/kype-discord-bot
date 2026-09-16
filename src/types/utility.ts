/**
 * Shared type utilities.
 *
 * These are the only "type tricks" allowed in the project: they turn object types
 * into readable unions (`"a" | "b"` instead of `string`) so that configuration
 * keys, permission names and event names stay strongly typed.
 */

/** All keys of `T` as a union of string literals. */
export type KeysOf<T> = keyof T & string;

/** Makes the selected keys of `T` required. */
export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

/** Makes every property of `T` deeply readonly. */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** A value that may be present asynchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** Recursively partial version of `T`, used for configuration patches. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Extracts the element type of an array type. */
export type ArrayElement<T> = T extends readonly (infer U)[] ? U : never;
