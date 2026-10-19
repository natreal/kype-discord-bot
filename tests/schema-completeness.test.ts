import { describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/services/database/client.js";

/**
 * The bug this guards against: `backup_snapshots`, `security_incidents` and
 * `verification_pending` were declared in `prisma/schema.prisma` and used by
 * production code, but no migration ever created them. `prisma migrate status`
 * reported "up to date" because the migrations folder simply had no file for them,
 * so the gap only appeared at runtime as a raw `P2021` from Postgres — which the
 * interaction handler can only report as a generic "Something went wrong".
 *
 * These tests run against the real database and assert the three tables exist and
 * are writable, which is the property that was actually broken. That means they
 * need a disposable or fully migrated database, so they are skipped unless
 * `DATABASE_URL` is explicitly provided (CI does this in the database-smoke job).
 * There is deliberately no default URL: silently probing `localhost` turned a
 * missing test database into two confusing failures instead of a clear "skipped".
 */
const DATABASE_URL = process.env.DATABASE_URL;

/** The configured database URL, with the test skipped when it is absent. */
function databaseUrl(): string {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to run the database schema tests");
  }
  return DATABASE_URL;
}

/** The real client, pointed at the real database. */
function openClient() {
  return createPrismaClient({ database: { url: databaseUrl() } } as Parameters<
    typeof createPrismaClient
  >[0]);
}

const describeWithDatabase = DATABASE_URL ? describe : describe.skip;

describeWithDatabase("database schema completeness", () => {
  it("has every table the schema declares", async () => {
    const client = openClient();
    try {
      const rows = await client.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;
      const tables = rows.map((row) => row.tablename);

      // The three that were missing. `backup_snapshots` is the one users hit.
      expect(tables).toContain("backup_snapshots");
      expect(tables).toContain("security_incidents");
      expect(tables).toContain("verification_pending");
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  it("can write and read a backup snapshot", async () => {
    const client = openClient();
    const guildId = `test-guild-${Date.now()}`;
    try {
      await client.guild.create({ data: { id: guildId, name: "Test Guild" } });

      const created = await client.backupSnapshot.create({
        data: {
          guildId,
          kind: "manual",
          roleCount: 1,
          channelCount: 2,
          checksum: "abc123",
          createdBy: "tester",
        },
      });

      expect(created.id).toBeTruthy();
      expect(created.status).toBe("complete");
      expect(created.roleCount).toBe(1);

      const found = await client.backupSnapshot.findFirst({ where: { guildId } });
      expect(found?.checksum).toBe("abc123");
    } finally {
      // Cascade delete from the guild removes the snapshot too.
      await client.guild.deleteMany({ where: { id: guildId } });
      await client.$disconnect();
    }
  }, 30_000);
});
