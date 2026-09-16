/**
 * Database smoke test.
 *
 * Exercises the real `DatabaseService` against the configured PostgreSQL
 * database: connect, health check, guild upsert (idempotency), configuration
 * read/write and setup-run persistence. This is the one path that cannot be
 * covered by the unit suite, because it needs a live server.
 *
 * Usage:
 *   npx tsx scripts/db-smoke.ts            # runs against DATABASE_URL
 *   npx tsx scripts/db-smoke.ts --cleanup  # also removes the test guild
 */
import { createConfig } from "../src/config/config.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";
import { DatabaseService } from "../src/services/database/index.js";
import { ConfigService } from "../src/services/config/index.js";
import { formatError } from "../src/utils/serialization.js";

const GUILD_ID = "999999999999999999";
const cleanup = process.argv.includes("--cleanup");

const config = createConfig();
const logger = createLogger("db-smoke", {
  level: "info",
  sinks: [new ConsoleSink({ color: false })],
});

const results: string[] = [];
const record = (label: string, detail: string): void => {
  results.push(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
};

const database = new DatabaseService(config, logger);
const guildConfig = new ConfigService(database, logger);

try {
  await database.connect();
  record("connect", "SELECT 1 succeeded");

  const health = await database.health();
  if (!health.ok) {
    throw new Error("health check reported failure");
  }
  record("health", `${health.latencyMs}ms`);

  const first = await database.upsertGuild({ id: GUILD_ID, name: "Smoke Test Guild" });
  record("upsertGuild (create)", `created=${first.created}`);
  if (!first.created) {
    throw new Error("expected the first upsert to create the row");
  }

  const second = await database.upsertGuild({ id: GUILD_ID, name: "Smoke Test Guild (renamed)" });
  record("upsertGuild (idempotent)", `created=${second.created}`);
  if (second.created) {
    throw new Error("expected the second upsert to reuse the row");
  }
  if (second.guild.name !== "Smoke Test Guild (renamed)") {
    throw new Error("expected the guild name to be updated");
  }

  const defaults = await guildConfig.get(GUILD_ID, "Smoke Test Guild");
  record(
    "config.get defaults",
    `language=${defaults.language} warnThreshold=${defaults.moderation.warnThreshold}`,
  );

  const updated = await guildConfig.update(GUILD_ID, {
    logging: { enabled: true, channelId: "222222222222222222" },
  });
  record("config.update", `logging.enabled=${updated.logging.enabled}`);

  const reread = await guildConfig.update(GUILD_ID, { logging: { enabled: false } });
  if (reread.logging.channelId !== "222222222222222222") {
    throw new Error("partial update erased an unrelated field");
  }
  record("config.update (merge preserved fields)", `channelId=${reread.logging.channelId}`);

  const run = await database.prisma.setupRun.create({
    data: {
      guildId: GUILD_ID,
      scope: "smoke",
      status: "completed",
      finishedAt: new Date(),
      durationMs: 1,
    },
  });
  record("setupRun.create", `id=${run.id.slice(0, 8)}…`);

  const runCount = await database.prisma.setupRun.count({ where: { guildId: GUILD_ID } });
  record("setupRun.count", `${runCount}`);

  if (cleanup) {
    await database.prisma.setupRun.deleteMany({ where: { guildId: GUILD_ID } });
    await database.prisma.guild.delete({ where: { id: GUILD_ID } });
    record("cleanup", "test guild removed");
  } else {
    record("cleanup", "skipped (pass --cleanup to remove the test guild)");
  }

  process.stdout.write(`\nDatabase smoke test PASSED\n${results.join("\n")}\n`);
} catch (error) {
  process.stderr.write(
    `\nDatabase smoke test FAILED\n${results.join("\n")}\n\n${formatError(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.disconnect();
}
