/**
 * Prisma CLI configuration (Prisma ORM 7+).
 *
 * Notes:
 * - In Prisma ORM 7 the CLI no longer loads `.env` automatically, so `dotenv`
 *   is imported explicitly here (this is the documented v7 setup).
 * - The datasource URL is declared here instead of in `schema.prisma`, which is
 *   the only place the CLI accepts it in v7.
 * - The application runtime does NOT read this file: connection settings come
 *   from the validated configuration layer (`src/config`), so there is a single
 *   source of truth for the app itself.
 */
import "dotenv/config";

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
