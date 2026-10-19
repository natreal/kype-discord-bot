/**
 * Setup resource identity tests.
 *
 * These exercise the real business logic of V2's idempotency contract:
 *
 *   1. first run creates;
 *   2. second run reuses;
 *   3. a deleted resource is recreated exactly once;
 *   4. a stale reference is recovered instead of duplicated;
 *   5. duplicate identities are impossible for the same guild/key.
 *
 * The fakes model Discord and the database behaviorally, so the assertions are
 * about observed outcomes (which resources exist, which IDs were persisted)
 * rather than about mock call counts.
 */
import { describe, expect, it } from "vitest";

import { SetupResourceService } from "../../src/modules/setup/setup-resource.service.js";
import { SETUP_RESOURCE_KEYS } from "../../src/modules/setup/setup-resources.js";
import type { SetupResourceDefinition } from "../../src/modules/setup.types.js";
import { fakeDiscord, setupGuildStub } from "../helpers/fake-guild.js";
import { memoryResourceRepository, storedResource } from "../helpers/setup-resources.js";
import { testLogger } from "../helpers/logger.js";

const GUILD_ID = "111111111111111111";

const CHANNEL: SetupResourceDefinition = {
  key: SETUP_RESOURCE_KEYS.welcomeChannel,
  type: "TEXT_CHANNEL",
  name: "welcome",
  label: "#welcome",
  category: "INFORMATION",
};

const CATEGORY: SetupResourceDefinition = {
  key: SETUP_RESOURCE_KEYS.informationCategory,
  type: "CATEGORY",
  name: "INFORMATION",
  label: "INFORMATION",
};

interface Harness {
  readonly service: SetupResourceService;
  readonly discord: ReturnType<typeof fakeDiscord>;
  readonly repository: ReturnType<typeof memoryResourceRepository>;
}

function harness(initial: readonly ReturnType<typeof storedResource>[] = []): Harness {
  const discord = fakeDiscord();
  const repository = memoryResourceRepository(initial);
  const service = new SetupResourceService({
    guild: setupGuildStub(GUILD_ID),
    repository,
    discord,
    logger: testLogger,
  });
  return { service, discord, repository };
}

describe("SetupResourceService idempotency", () => {
  it("creates a resource on the first run and reuses it on the second", async () => {
    const { service, discord } = harness();

    const first = await service.ensure(CHANNEL);
    const second = await service.ensure(CHANNEL);

    expect(first.origin).toBe("created");
    expect(first.created).toBe(true);
    expect(second.origin).toBe("reused");
    expect(second.created).toBe(false);
    // The crucial assertion: exactly one channel exists, no `#welcome-2`.
    expect(discord.created).toEqual(["welcome"]);
    expect(second.resource.id).toBe(first.resource.id);
  });

  it("persists the Discord ID so reuse does not depend on the name", async () => {
    const { service, discord, repository } = harness();
    const created = await service.ensure(CHANNEL);

    // An administrator renames the channel: identity must still follow the ID.
    const channel = discord.channels.get(created.resource.id);
    expect(channel).toBeDefined();
    if (channel) {
      channel.name = "welcome-and-rules";
    }

    const second = await service.ensure(CHANNEL);
    expect(second.resource.id).toBe(created.resource.id);
    expect(discord.created).toEqual(["welcome"]);
    // The stored name is refreshed so future adoption stays accurate.
    expect(await repository.find(GUILD_ID, CHANNEL.key)).toMatchObject({
      discordId: created.resource.id,
      name: "welcome-and-rules",
    });
  });

  it("adopts an existing channel instead of creating a duplicate", async () => {
    const { service, discord } = harness();
    const preexisting = discord.seedChannel("welcome", undefined, null, "existing-welcome");

    const resolution = await service.ensure(CHANNEL);

    expect(resolution.origin).toBe("reused");
    expect(resolution.resource.id).toBe(preexisting.id);
    expect(discord.created).toEqual([]);
  });
});

describe("SetupResourceService recovery", () => {
  it("recreates a resource whose stored reference is stale", async () => {
    const { service, discord } = harness();
    const first = await service.ensure(CHANNEL);

    // The administrator deleted the channel; the stored ID is now dangling.
    discord.deleteChannel(first.resource.id);

    const recovered = await service.ensure(CHANNEL);

    expect(recovered.origin).toBe("recovered");
    expect(recovered.repaired).toBe(true);
    expect(recovered.created).toBe(true);
    expect(recovered.resource.id).not.toBe(first.resource.id);
    // Two channels were created *across time* (the original, then its replacement)
    // but only one exists now: no `#welcome` plus `#welcome-2` was ever left behind.
    expect(discord.created).toEqual(["welcome", "welcome"]);
    expect(await service.ensure(CHANNEL)).toMatchObject({
      resource: { id: recovered.resource.id },
    });
    expect(discord.created).toEqual(["welcome", "welcome"]);
  });

  it("re-adopts a manually recreated channel rather than creating another", async () => {
    const { service, discord } = harness();
    const first = await service.ensure(CHANNEL);

    // Deleted and recreated by hand: same name, new ID.
    discord.deleteChannel(first.resource.id);
    const manual = discord.seedChannel("welcome", undefined, null, "manual-welcome");

    const recovered = await service.ensure(CHANNEL);

    expect(recovered.origin).toBe("recovered");
    expect(recovered.resource.id).toBe(manual.id);
    expect(recovered.created).toBe(false);
    expect(discord.created).toEqual(["welcome"]);
  });

  it("recovers a stale reference inherited from an earlier run", async () => {
    const { service, discord } = harness([
      storedResource(
        GUILD_ID,
        CHANNEL.key,
        "chan-that-no-longer-exists",
        "TEXT_CHANNEL",
        "welcome",
      ),
    ]);

    const resolution = await service.ensure(CHANNEL);

    expect(resolution.origin).toBe("recovered");
    expect(resolution.repaired).toBe(true);
    // The dangling ID is reported so operators can see what was repaired.
    expect(resolution.previousId).toBe("chan-that-no-longer-exists");
    expect(discord.created).toEqual(["welcome"]);
  });

  it("keeps working when the identity table cannot be written", async () => {
    const { service, discord, repository } = harness();
    repository.failWrites = true;

    // A broken audit table must not turn a successful Discord operation into a
    // failure: the channel exists and the next run adopts it by name.
    const resolution = await service.ensure(CHANNEL);

    expect(resolution.origin).toBe("created");
    expect(discord.created).toEqual(["welcome"]);
    expect(repository.rows.size).toBe(0);
  });
});

describe("SetupResourceService uniqueness", () => {
  it("stores one identity row per guild and key", async () => {
    const { service, repository } = harness();

    await service.ensure(CHANNEL);
    await service.ensure(CHANNEL);
    await service.ensure(CHANNEL);

    const rows = await repository.list(GUILD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(CHANNEL.key);
  });

  it("keeps separate keys for separate resources", async () => {
    const { service, repository } = harness();

    await service.ensure(CATEGORY);
    await service.ensure({ ...CHANNEL, key: SETUP_RESOURCE_KEYS.rulesChannel, name: "rules" });

    const rows = await repository.list(GUILD_ID);
    expect(rows.map((row) => row.key).sort()).toEqual([
      SETUP_RESOURCE_KEYS.informationCategory,
      SETUP_RESOURCE_KEYS.rulesChannel,
    ]);
  });

  it("handles two runs resolving the same key concurrently", async () => {
    const { service, repository, discord } = harness();

    // Both runs observe an empty identity table and race to resolve the key; the
    // unique constraint means a single row survives and no duplicate is left behind.
    const [left, right] = await Promise.all([service.ensure(CHANNEL), service.ensure(CHANNEL)]);

    const rows = await repository.list(GUILD_ID);
    expect(rows).toHaveLength(1);
    expect(left.resource.id).toBe(right.resource.id);
    expect(discord.created).toEqual(["welcome"]);
  });

  it("rejects creation failures instead of silently succeeding", async () => {
    const { service, discord } = harness();
    discord.failCreation = true;

    await expect(service.ensure(CHANNEL)).rejects.toThrow(/Missing Permissions/);
    expect(discord.createAttempts.count).toBe(1);
  });
});
