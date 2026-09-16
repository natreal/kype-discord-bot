/**
 * The single Prisma client instance for the process.
 *
 * The generated client is imported here and nowhere else; every other part of
 * the application goes through `DatabaseService`.
 *
 * Note: Prisma's generated client lives in `src/generated/prisma` and is marked
 * `@ts-nocheck`, so its surface is treated as an implementation detail and
 * adapted once, here, rather than leaking through the application.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client.js";
import type { PrismaClient as GeneratedPrismaClient } from "../../generated/prisma/client.js";
import { DatabaseError } from "../../utils/errors.js";
import type { AppConfig } from "../../config/config.js";

/** The exact client type produced by the generated Prisma client. */
export type PrismaDatabaseClient = GeneratedPrismaClient;

/** Creates a driver-adapter backed Prisma client. */
export function createPrismaClient(config: AppConfig): PrismaDatabaseClient {
  const adapter = new PrismaPg({
    connectionString: config.database.url,
    // Bounded connect/idle timeouts keep failure modes predictable: the pg
    // driver defaults are unsuitable for a long-running bot process.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });

  return new PrismaClient({ adapter });
}

/** Wraps an unknown database failure in a `DatabaseError` with diagnostics. */
export function toDatabaseError(error: unknown, operation: string): DatabaseError {
  const code = extractErrorCode(error);
  return new DatabaseError(`Database operation failed: ${operation}`, {
    cause: error,
    metadata: { code, operation },
  });
}

/** Reads a Prisma/`pg` error code without assuming the error shape. */
function extractErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
  }
  return "UNKNOWN";
}
