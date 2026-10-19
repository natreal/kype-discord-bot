/**
 * JSON boundary helpers for Prisma columns.
 *
 * Prisma's generated client distinguishes three "empty" JSON values: a real
 * value, SQL `NULL` (`Prisma.DbNull`) and the JSON literal `null`
 * (`Prisma.JsonNull`). Passing a plain `null` for a nullable `Json` column does
 * not type-check under `exactOptionalPropertyTypes`, and choosing wrong would
 * silently store the JSON literal `null` instead of SQL `NULL`.
 *
 * This is the one place that decision is made, so repositories stay readable.
 */
import { Prisma } from "../../generated/prisma/client.js";

/** A value accepted by a nullable Prisma `Json` column. */
export type NullableJsonInput = Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;

/** A value accepted by a required Prisma `Json` column. */
export type RequiredJsonInput = Prisma.InputJsonValue;

/**
 * @returns a Prisma-accepted value for a nullable `Json` column.
 *
 * `null`/`undefined` become SQL `NULL`, so a cleared field is genuinely absent
 * rather than stored as the JSON literal `null`. `undefined` also becomes SQL
 * `NULL`: an omitted key and an explicit clear are the same intent here.
 *
 * The value is cast through `unknown` because a caller passes arbitrary JSON
 * (already validated by Zod upstream) and Prisma's input type is structural.
 */
export function toNullableJson(value: unknown): NullableJsonInput {
  return value === null || value === undefined ? Prisma.DbNull : toRequiredJson(value);
}

/** @returns a Prisma-accepted value for a required `Json` column. */
export function toJson(value: unknown): RequiredJsonInput {
  return toRequiredJson(value);
}

/** Shared cast for a validated JSON value. */
function toRequiredJson(value: unknown): RequiredJsonInput {
  return value as RequiredJsonInput;
}
