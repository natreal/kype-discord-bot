/**
 * Centralized error taxonomy.
 *
 * Every error the application throws deliberately is an `AppError` subclass.
 * This lets the interaction handler decide what a user is allowed to see while
 * always logging the full diagnostic detail internally.
 *
 * Nothing in this file may contain secrets: `metadata` is logged internally and
 * must never include tokens, connection strings or raw environment values.
 */

export type ErrorKind =
  | "config"
  | "validation"
  | "database"
  | "discord"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "internal";

export interface AppErrorOptions {
  /** Stable, machine-readable code (e.g. `PERMISSION_DENIED`). */
  readonly code: string;
  /** Whether the failure is expected and safe to describe to end users. */
  readonly expected?: boolean | undefined;
  /** Key/value diagnostics. Never include secrets. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** Original error, preserved for logging. */
  readonly cause?: unknown;
}

/** Base class for all deliberately thrown application errors. */
export class AppError extends Error {
  public readonly kind: ErrorKind = "internal";
  public readonly code: string;
  public readonly expected: boolean;
  public readonly metadata: Record<string, unknown> | undefined;

  public constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.expected = options.expected ?? false;
    this.metadata = options.metadata;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Environment/configuration is missing or invalid. Always fatal at startup. */
export class ConfigError extends AppError {
  public override readonly kind = "config" as const;

  public constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, { code: "CONFIG_INVALID", metadata });
  }
}

/** Input that came from Discord or an operator failed validation. */
export class ValidationError extends AppError {
  public override readonly kind = "validation" as const;

  public constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, { code: "VALIDATION_FAILED", expected: true, metadata });
  }
}

/** Database/ORM failure. */
export class DatabaseError extends AppError {
  public override readonly kind = "database" as const;

  public constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, {
      ...options,
      code: options.metadata?.["code"]?.toString() ?? "DATABASE_ERROR",
    });
  }
}

/** Discord API failure, including rate limits and missing permissions. */
export class DiscordApiError extends AppError {
  public override readonly kind = "discord" as const;

  public constructor(
    message: string,
    options: Omit<AppErrorOptions, "code"> & { code?: string } = {},
  ) {
    super(message, { ...options, code: options.code ?? "DISCORD_API_ERROR" });
  }
}

/** The caller is not allowed to perform the action. */
export class PermissionError extends AppError {
  public override readonly kind = "permission" as const;

  public readonly permission: string;

  public constructor(permission: string, metadata?: Record<string, unknown>) {
    super(`Missing permission: ${permission}`, {
      code: "PERMISSION_DENIED",
      expected: true,
      metadata,
    });
    this.permission = permission;
  }
}

/** A requested resource (guild, command, handler) does not exist. */
export class NotFoundError extends AppError {
  public override readonly kind = "not_found" as const;

  public constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, { code: "NOT_FOUND", expected: true, metadata });
  }
}

/** An unexpected internal failure. */
export class InternalError extends AppError {
  public override readonly kind = "internal" as const;

  public constructor(message: string, options: Omit<AppErrorOptions, "code"> = {}) {
    super(message, { ...options, code: "INTERNAL_ERROR" });
  }
}

/** @returns true when `value` is any `AppError`. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * A user-safe message for the given error, or `undefined` when nothing should
 * be shown (unexpected errors get a generic message from the caller instead).
 */
export function userFacingMessage(error: unknown): string | undefined {
  return isAppError(error) && error.expected ? error.message : undefined;
}

/** Normalizes any thrown value into an `Error` (for logging). */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  return new Error(`Non-error value thrown: ${typeof value}`);
}
