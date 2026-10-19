/**
 * Setup resource persistence smoke test.
 *
 * The unit suite proves the resolution *logic*; this proves the part only a real
 * PostgreSQL server can: that `setup_resources` enforces one identity row per
 * `(guildId, key)`, that writes are idempotent, and that a stale reference is
 * repaired rather than duplicated.
 *
 * Usage:
 *   npx tsx scripts/setup-resource-smoke.ts            # runs against DATABASE_URL
 *   npx tsx scripts/setup-resource-smoke.ts --cleanup  # also removes the test guild
 */
import { createConfig } from "../src/config/config.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";
import { DatabaseService } from "../src/services/database/index.js";
import { PrismaSetupResourceRepository } from "../src/modules/setup/prisma-setup-resource.repository.js";
import { SETUP_RESOURCE_KEYS } from "../src/modules/setup/setup-resources.js";
import { formatError } from "../src/utils/serialization.js";

const GUILD_ID = "999999999999999998";
const cleanup = process.argv.includes("--cleanup");

const config = createConfig();
const logger = createLogger("setup-resource-smoke", {
  level: "info",
  sinks: [new ConsoleSink({ color: false })],
});

const results: string[] = [];
const record = (label: string, detail = ""): void => {
  results.push(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
};

const database = new DatabaseService(config, logger);

try {
  await database.connect();
  const repository = new PrismaSetupResourceRepository(database.prisma, "Setup Resource Smoke");

  // A clean slate for a deterministic run.
  await database.prisma.setupResource.deleteMany({ where: { guildId: GUILD_ID } });

  const first = {
    guildId: GUILD_ID,
    key: SETUP_RESOURCE_KEYS.welcomeChannel,
    type: "TEXT_CHANNEL" as const,
    discordId: "111111111111111111",
    name: "welcome",
    config: { label: "#welcome" },
  };

  await repository.remember(first);
  record("remember (create)", "one row written");

  const stored = await repository.find(GUILD_ID, first.key);
  if (stored?.discordId !== first.discordId) {
    throw new Error("expected the stored Discord ID to round-trip");
  }
  record("find", `discordId=${stored.discordId}`);

  // Writing the same key again must update, never duplicate.
  await repository.remember({ ...first, discordId: "222222222222222222", name: "welcome-renamed" });
  const all = await repository.list(GUILD_ID);
  if (all.length !== 1) {
    throw new Error(`expected 1 row after an idempotent write, found ${String(all.length)}`);
  }
  record("remember (idempotent)", "still one row");

  // The repaired identity must be what is read back.
  const repaired = await repository.find(GUILD_ID, first.key);
  if (repaired?.discordId !== "222222222222222222") {
    throw new Error("expected the updated Discord ID");
  }
  record("recovery (id updated)", `discordId=${repaired.discordId}`);

  // The unique constraint is the race-condition safety net: a second row for the
  // same (guildId, key) must be impossible at the database level.
  let duplicateRejected = false;
  try {
    await database.prisma.setupResource.create({
      data: {
        guildId: GUILD_ID,
        key: first.key,
        type: "TEXT_CHANNEL",
        discordId: "333333333333333333",
        name: "duplicate",
      },
    });
  } catch {
    duplicateRejected = true;
  }
  if (!duplicateRejected) {
    throw new Error("the (guildId, key) unique constraint did not reject a duplicate");
  }
  record("unique constraint", "duplicate (guildId, key) rejected");

  await repository.forget(GUILD_ID, first.key);
  record("forget", "row removed");
  record("list", `${String((await repository.list(GUILD_ID)).length)} row(s)`);

  if (cleanup) {
    await database.prisma.guild.delete({ where: { id: GUILD_ID } }).catch(() => undefined);
    record("cleanup", "test guild removed");
  }

  process.stdout.write(`\nSetup resource persistence smoke test PASSED\n${results.join("\n")}\n`);
} catch (error) {
  process.stderr.write(
    `\nSetup resource persistence smoke test FAILED\n${results.join("\n")}\n\n${formatError(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.disconnect();
}
