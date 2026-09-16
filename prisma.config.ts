import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma ORM 7+).
 *
 * Notes:
 * - In Prisma ORM 7 the CLI no longer loads `.env` automatically, and the
 *   datasource URL is declared here instead of in `schema.prisma`.
 * - The application runtime does NOT read this file. Connection settings are
 *   resolved by `src/services/database/client.ts` through the validated
 *   configuration layer, so there is a single source of truth for the app.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
