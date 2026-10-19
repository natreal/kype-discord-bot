/**
 * V5 backup tests.
 *
 * The suite proves the four properties the brief asks for, plus the reason the
 * module exists next to anti-nuke:
 *
 *   1. **a capture is a real snapshot** of roles, channels, overwrites and
 *      configuration, and it performs no Discord write at all;
 *   2. **a restore recreates what is missing and repairs what drifted**, reporting
 *      honestly what it could not do;
 *   3. **backups are isolated per server.** A snapshot ID is not enough to address
 *      a row: the guild is required, and a payload claiming another guild is
 *      refused even when the row was found;
 *   4. **a corrupt payload is refused, not half-applied**, because the checksum is
 *      verified before Discord is touched.
 */
import { describe, expect, it } from "vitest";

import { AuditEventService } from "../../src/services/audit/index.js";
import { BackupService } from "../../src/modules/backup/index.js";
import { payloadChecksum } from "../../src/modules/backup/backup.checksum.js";
import type { BackupChannel, BackupRole } from "../../src/modules/backup/index.js";
import { GUILD_A, GUILD_B, createV3Harness } from "../helpers/v3-harness.js";
import { testLogger } from "../helpers/logger.js";
import { backupPayload, fakeBackupActions, memoryBackups } from "../helpers/v5-security.js";

/** A role, with sane defaults a test can override. */
function role(overrides: Partial<BackupRole> = {}): BackupRole {
  return {
    id: "role-1",
    name: "Staff",
    color: 0,
    hoist: false,
    mentionable: false,
    permissions: "8",
    position: 3,
    managed: false,
    ...overrides,
  };
}

/** A channel, with sane defaults a test can override. */
function channel(overrides: Partial<BackupChannel> = {}): BackupChannel {
  return {
    id: "chan-1",
    name: "general",
    type: 0,
    parentId: null,
    position: 0,
    topic: "Talk here",
    nsfw: false,
    overwrites: [],
    ...overrides,
  };
}

/** Builds the real service over in-memory storage and a fake guild. */
function backupHarness(
  options: {
    readonly roles?: readonly BackupRole[];
    readonly channels?: readonly BackupChannel[];
    readonly failCreates?: boolean;
  } = {},
) {
  const v3 = createV3Harness();
  const repository = memoryBackups();
  const actions = fakeBackupActions({
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    ...(options.failCreates === undefined ? {} : { failCreates: options.failCreates }),
  });
  const auditActions: string[] = [];

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([]);
    },
  });

  const service = new BackupService({
    logger: testLogger,
    audit,
    repository,
    actions,
    readConfig: (guildId) =>
      v3.config.get(guildId, `Guild ${guildId}`).then((config) => ({
        language: config.language,
        moderation: config.moderation,
      })),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  return { v3, repository, actions, service, auditActions };
}

describe("V5 backups: a snapshot is read-only and complete", () => {
  it("captures roles, channels, configuration and a checksum, without any write", async () => {
    const harness = backupHarness({
      roles: [role(), role({ id: "role-2", name: "Member", position: 1 })],
      channels: [
        channel(),
        channel({
          id: "chan-2",
          name: "voice",
          type: 2,
          overwrites: [{ id: "role-1", kind: "role", allow: "1024", deny: "0" }],
        }),
      ],
    });

    const summary = await harness.service.capture(GUILD_A, "Guild A", { createdBy: "admin-1" });

    expect(summary.roleCount).toBe(2);
    expect(summary.channelCount).toBe(2);
    expect(summary.checksum).toMatch(/^[0-9a-f]{64}$/);
    // Capture is read-only: the only call the adapter saw is `read`.
    expect(harness.actions.calls).toEqual(["read"]);

    const stored = await harness.service.find(GUILD_A, summary.id);
    expect(stored?.payload?.config.sections).toMatchObject({ language: "en" });
    expect(stored?.payload?.channels[1]?.overwrites).toHaveLength(1);
    expect(harness.auditActions).toEqual(["backup.create"]);
  });

  it("lists newest first and keeps only the retention window", async () => {
    const harness = backupHarness({ roles: [role()] });

    for (let index = 0; index < 25; index += 1) {
      await harness.service.capture(GUILD_A, "Guild A");
    }

    const listed = await harness.service.list(GUILD_A, 50);
    // Retention is applied after each write, so the store never grows unbounded.
    expect(listed.length).toBe(20);
    expect(harness.repository.snapshots.length).toBe(20);
  });
});

describe("V5 backups: a snapshot belongs to exactly one server", () => {
  it("cannot be read, deleted or restored from another guild", async () => {
    const harness = backupHarness({ roles: [role()] });
    const summary = await harness.service.capture(GUILD_A, "Guild A", { createdBy: "admin-1" });

    // The ID alone is not enough: the guild is part of the address, which is the
    // storage half of the isolation requirement.
    expect(await harness.service.find(GUILD_B, summary.id)).toBeNull();
    expect(await harness.service.find(GUILD_A, summary.id)).not.toBeNull();
    expect(await harness.service.remove(GUILD_B, summary.id, "attacker")).toBe(false);
    expect(await harness.service.find(GUILD_A, summary.id)).not.toBeNull();
    expect(await harness.service.latest(GUILD_B)).toBeNull();
  });

  it("refuses a payload whose embedded guild is not the target", async () => {
    const harness = backupHarness({ roles: [role()] });
    // A row written for guild A whose payload claims guild B: the shape a buggy or
    // malicious writer would produce. It must be refused before Discord is touched.
    const payload = backupPayload({ guildId: GUILD_B });
    await harness.repository.append({
      guildId: GUILD_A,
      kind: "manual",
      status: "complete",
      payload,
      checksum: payloadChecksum(payload),
      createdBy: "someone",
    });

    await expect(harness.service.restore(GUILD_A, "backup-1", "admin-1")).rejects.toThrow(
      /another server/,
    );
    // Nothing was written: the refusal happened before the first create.
    expect(harness.actions.calls).toEqual([]);
  });

  it("refuses a payload that fails its checksum instead of half-applying it", async () => {
    const harness = backupHarness({ roles: [role()] });
    const payload = backupPayload({ guildId: GUILD_A });
    // Stored with a checksum that does not match its content.
    await harness.repository.append({
      guildId: GUILD_A,
      kind: "manual",
      status: "complete",
      payload,
      checksum: "0".repeat(64),
      createdBy: "someone",
    });

    await expect(harness.service.restore(GUILD_A, "backup-1", "admin-1")).rejects.toThrow(
      /integrity check/,
    );
    expect(harness.actions.calls).toEqual([]);
  });

  it("says so plainly when there is nothing to restore", async () => {
    const harness = backupHarness();
    await expect(
      harness.service.restore(GUILD_A, "backup-does-not-exist", "admin"),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("V5 backups: anti-nuke detects, a restore repairs", () => {
  it("recreates the roles and channels a nuke deleted", async () => {
    // The snapshot is taken while the server is intact.
    const harness = backupHarness({
      roles: [role(), role({ id: "role-2", name: "Member", position: 1 })],
      channels: [
        channel({ id: "cat-1", name: "INFORMATION", type: 4 }),
        channel({ id: "chan-1", name: "welcome", parentId: "cat-1" }),
      ],
    });
    const summary = await harness.service.capture(GUILD_A, "Guild A", { createdBy: "admin-1" });

    // Then the nuke: everything is gone from the live guild.
    harness.actions.live.roles.splice(0, harness.actions.live.roles.length);
    harness.actions.live.channels.splice(0, harness.actions.live.channels.length);

    const report = await harness.service.restore(GUILD_A, summary.id, "admin-1");

    expect(report.rolesCreated).toBe(2);
    expect(report.channelsCreated).toBe(2);
    expect(report.missingChannels).toEqual([]);
    // The category was recreated before its child, so the child could be reparented
    // in the same pass instead of needing a second restore.
    const child = harness.actions.live.channels.find((candidate) => candidate.name === "welcome");
    expect(child?.parentId).not.toBeNull();
    expect(harness.auditActions).toContain("backup.restore");
  });

  it("reuses a role that survived by name instead of creating a duplicate", async () => {
    // The snapshot knows the role by its old ID; the nuke re-created it with a new
    // one. Matching by name is what prevents `Admin` existing twice.
    const harness = backupHarness({ roles: [role({ id: "old-id", name: "Staff" })] });
    const summary = await harness.service.capture(GUILD_A, "Guild A");

    harness.actions.live.roles.splice(0, harness.actions.live.roles.length);
    harness.actions.live.roles.push(role({ id: "new-id", name: "Staff", color: 99 }));

    const report = await harness.service.restore(GUILD_A, summary.id, "admin-1");

    expect(report.rolesCreated).toBe(0);
    expect(report.rolesUpdated).toBe(1);
    expect(harness.actions.live.roles).toHaveLength(1);
    // The drifted colour was repaired from the snapshot.
    expect(harness.actions.live.roles[0]?.color).toBe(0);
  });

  it("reports a partial restore honestly rather than claiming success", async () => {
    const harness = backupHarness({ channels: [channel({ id: "chan-1", name: "general" })] });
    const summary = await harness.service.capture(GUILD_A, "Guild A");

    // Every create now fails, the way it would if the bot lost Manage Channels.
    const failing = new BackupService({
      logger: testLogger,
      audit: new AuditEventService(testLogger),
      repository: harness.repository,
      actions: fakeBackupActions({ failCreates: true }),
      readConfig: () => Promise.resolve({}),
    });

    const report = await failing.restore(GUILD_A, summary.id, "admin-1");

    expect(report.channelsCreated).toBe(0);
    expect(report.missingChannels).toEqual(["general"]);
    expect(report.notes.join(" ")).toMatch(/could not be restored/);
  });

  it("never deletes what the snapshot does not know about", async () => {
    const harness = backupHarness({ channels: [channel({ id: "chan-1", name: "general" })] });
    const summary = await harness.service.capture(GUILD_A, "Guild A");

    // A channel created after the snapshot is legitimate work and must survive.
    harness.actions.live.channels.push(channel({ id: "chan-new", name: "created-later", type: 0 }));

    await harness.service.restore(GUILD_A, summary.id, "admin-1");

    expect(harness.actions.live.channels.map((entry) => entry.name)).toContain("created-later");
    expect(harness.actions.calls.some((call) => call.startsWith("createChannel"))).toBe(false);
  });
});
