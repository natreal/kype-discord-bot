/**
 * Backup service: snapshot, list, restore.
 *
 * The reason this module exists next to anti-nuke is stated in the V5 brief and is
 * worth repeating in the code: **anti-nuke detects, it does not repair.** A deleted
 * channel is gone; stripping the culprit's roles does not bring it back. A snapshot
 * is what makes the difference between "we stopped it" and "we recovered".
 *
 * Three design points:
 *
 * 1. **Guild isolation is enforced at three layers.** The repository only ever
 *    queries by `guildId`, the restore refuses a snapshot whose embedded `guildId`
 *    differs from the target, and a snapshot ID alone is never enough to address a
 *    row: the guild ID is required too.
 * 2. **Capture is read-only.** `capture()` performs no Discord writes, so taking a
 *    snapshot during an incident cannot make the incident worse.
 * 3. **Restore is additive and explicit.** It creates what is missing and repairs
 *    what drifted. It does not delete anything the snapshot does not know about
 *    (a channel an operator created after the snapshot is legitimate work), and it
 *    reports exactly what it changed.
 */
import type { Logger } from "../../services/logger/index.js";
import type { AuditEventService } from "../../services/audit/index.js";

import { payloadChecksum, verifyChecksum } from "./backup.checksum.js";
import type {
  BackupChannel,
  BackupPayload,
  BackupRecord,
  BackupRepository,
  BackupRole,
  BackupSummary,
  RestoreReport,
} from "./backup.types.js";

/** Configuration sections that belong in a snapshot. */
export const BACKUP_CONFIG_SECTIONS = [
  "language",
  "logging",
  "moderation",
  "automod",
  "security",
  "members",
] as const;

/** How many snapshots a guild keeps before the oldest are pruned. */
export const BACKUP_RETENTION = 20;

/** Discord operations the backup module needs, behind one port. */
export interface GuildBackupActions {
  /** @returns the live structure, for a capture. Read-only by contract. */
  read(): Promise<{
    readonly roles: readonly BackupRole[];
    readonly channels: readonly BackupChannel[];
  }>;
  /** Creates a role that does not exist, and @returns its new ID. */
  createRole(role: BackupRole): Promise<string | null>;
  /** Restores a role that exists but drifted. */
  updateRole(roleId: string, role: BackupRole): Promise<boolean>;
  /** Creates a channel, honouring its parent when that parent exists. */
  createChannel(channel: BackupChannel, parentId: string | null): Promise<string | null>;
  /** Restores a channel's name, topic, position and overwrites. */
  updateChannel(channelId: string, channel: BackupChannel): Promise<boolean>;
  /** @returns the current role IDs, so a create/update decision can be made. */
  roleIds(): Promise<readonly string[]>;
  /**
   * @returns the ID of a live role with this name, or `null`.
   *
   * The restore needs this rather than a name index built from IDs: a role that
   * survived a nuke under a *new* ID is not in the snapshot's ID list, and only the
   * adapter can see it. Matching by name is what prevents `Admin` existing twice
   * after a restore.
   */
  roleIdByName(name: string): Promise<string | null>;
  /** @returns the current channel IDs, so a create/update decision can be made. */
  channelIds(): Promise<readonly string[]>;
}

export interface BackupServiceOptions {
  readonly logger: Logger;
  readonly audit: AuditEventService;
  readonly repository: BackupRepository;
  /** Guild-bound Discord operations. */
  readonly actions: GuildBackupActions;
  /** @returns the guild's configuration sections, for the snapshot. */
  readonly readConfig: (guildId: string) => Promise<Record<string, unknown>>;
  /** Injected clock, so a test controls `takenAt`. */
  readonly now?: () => Date;
}

export class BackupService {
  private readonly logger: Logger;
  private readonly audit: AuditEventService;
  private readonly repository: BackupRepository;
  private readonly actions: GuildBackupActions;
  private readonly readConfig: BackupServiceOptions["readConfig"];
  private readonly now: () => Date;

  public constructor(options: BackupServiceOptions) {
    this.logger = options.logger.child("backup");
    this.audit = options.audit;
    this.repository = options.repository;
    this.actions = options.actions;
    this.readConfig = options.readConfig;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Takes a snapshot and stores it.
   *
   * @param guildId the guild to capture; also the storage scope
   * @param guildName kept in the payload so a restore report is readable
   * @param options `kind` distinguishes a `/backup create` from the periodic
   *   worker, and `createdBy` names the operator (or `system`)
   */
  public async capture(
    guildId: string,
    guildName: string,
    options: { readonly kind?: "manual" | "scheduled"; readonly createdBy?: string } = {},
  ): Promise<BackupSummary> {
    const structure = await this.actions.read();
    const config = await this.readConfig(guildId);
    const capturedAt = this.now();

    const payload: BackupPayload = {
      version: 1,
      guildId,
      guildName,
      takenAt: capturedAt.toISOString(),
      roles: structure.roles,
      channels: structure.channels,
      config: { sections: config },
    };

    const checksum = payloadChecksum(payload);
    const kind = options.kind ?? "manual";
    const createdBy = options.createdBy ?? "system";

    const summary = await this.repository.append({
      guildId,
      kind,
      status: "complete",
      payload,
      checksum,
      createdBy,
    });

    // Retention is applied *after* the write, so a failed prune can never lose the
    // snapshot that was just taken.
    const pruned = await this.repository.prune(guildId, BACKUP_RETENTION);

    await this.audit.record({
      guildId,
      action: "backup.create",
      category: "backup",
      severity: "info",
      actorId: createdBy,
      actorKind: createdBy === "system" ? "system" : "user",
      targetType: "backup",
      targetId: summary.id,
      outcome: "success",
      after: { roles: summary.roleCount, channels: summary.channelCount, checksum },
      details: { kind, pruned },
    });

    this.logger.info("Backup captured", {
      guildId,
      backupId: summary.id,
      roles: summary.roleCount,
      channels: summary.channelCount,
      kind,
    });

    return summary;
  }

  /** @returns the guild's snapshots, newest first. */
  public list(guildId: string, limit = 10): Promise<BackupSummary[]> {
    return this.repository.list(guildId, Math.min(Math.max(limit, 1), 50));
  }

  /** @returns one snapshot of a guild, or `null` when it is not that guild's. */
  public find(guildId: string, backupId: string): Promise<BackupRecord | null> {
    return this.repository.find(guildId, backupId);
  }

  /** @returns the newest snapshot of a guild, or `null`. */
  public latest(guildId: string): Promise<BackupRecord | null> {
    return this.repository.latest(guildId);
  }

  /** Deletes one snapshot, refusing anything that is not the guild's. */
  public async remove(guildId: string, backupId: string, actorId: string): Promise<boolean> {
    const record = await this.repository.find(guildId, backupId);
    if (!record) {
      return false;
    }
    const removed = await this.repository.delete(guildId, backupId);
    if (removed) {
      await this.audit.record({
        guildId,
        action: "backup.delete",
        category: "backup",
        severity: "info",
        actorId,
        actorKind: "user",
        targetType: "backup",
        targetId: backupId,
        outcome: "success",
      });
    }
    return removed;
  }

  /**
   * Restores a snapshot.
   *
   * Refuses, in this order: a snapshot that is not the guild's, a payload that
   * fails its checksum, and a payload whose embedded guild differs from the target.
   * Nothing is written to Discord until all three checks pass.
   */
  public async restore(guildId: string, backupId: string, actorId: string): Promise<RestoreReport> {
    const record = await this.repository.find(guildId, backupId);
    if (!record) {
      throw new Error("That backup does not exist for this server.");
    }

    const payload = record.payload;
    if (!payload) {
      throw new Error("That backup has no readable payload.");
    }

    // Two independent guild checks. The repository already scoped the read by
    // guild, and this catches a payload written by a buggy path — a cross-guild
    // restore must be impossible, not merely unlikely.
    if (payload.guildId !== guildId || record.guildId !== guildId) {
      throw new Error("That backup belongs to another server and was refused.");
    }

    if (!verifyChecksum(payload, record.checksum)) {
      throw new Error(
        "That backup failed its integrity check and was not applied. Take a fresh snapshot before restoring.",
      );
    }

    // The restore works on a *copy* of the payload: `apply()` walks roles and
    // channels, and a storage layer that hands back a live object (an in-memory
    // repository, a cache) must not be able to have its stored snapshot mutated by
    // a restore. The checksum above is what makes that difference observable, and
    // this is what makes it impossible.
    const working: BackupPayload = JSON.parse(JSON.stringify(payload)) as BackupPayload;
    const report = { ...(await this.apply(working)), backupId };

    await this.audit.record({
      guildId,
      action: "backup.restore",
      category: "backup",
      severity: "privileged",
      actorId,
      actorKind: "user",
      targetType: "backup",
      targetId: backupId,
      outcome: "success",
      before: { takenAt: payload.takenAt },
      after: {
        rolesCreated: report.rolesCreated,
        rolesUpdated: report.rolesUpdated,
        channelsCreated: report.channelsCreated,
        channelsUpdated: report.channelsUpdated,
      },
      details: { notes: report.notes, missingChannels: report.missingChannels },
    });

    this.logger.info("Backup restored", {
      guildId,
      backupId,
      rolesCreated: report.rolesCreated,
      channelsCreated: report.channelsCreated,
    });

    return report;
  }

  /**
   * Applies a payload: roles first, then channels.
   *
   * The order is not cosmetic. Discord channels reference role IDs in their
   * overwrites, so restoring roles first means the channel pass can resolve every
   * overwrite; the reverse would create channels whose permission overwrites point
   * at roles that do not exist yet.
   */
  private async apply(payload: BackupPayload): Promise<RestoreReport> {
    const existingRoles = new Set(await this.actions.roleIds());
    const existingChannels = new Set(await this.actions.channelIds());

    // Roles are matched by *name* as well as ID: a restore after a nuke finds the
    // snapshot's roles gone (their IDs no longer exist), and creating a duplicate
    // `Admin` next to a surviving `Admin` would be worse than reusing it. The names
    // have to come from the live guild, which is what `roleIdByName` is for: only
    // the adapter can see a role that survived the nuke under a new ID.
    let rolesCreated = 0;
    let rolesUpdated = 0;
    const roleIdMap = new Map<string, string>();

    for (const role of payload.roles) {
      const knownId = existingRoles.has(role.id)
        ? role.id
        : await this.actions.roleIdByName(role.name);

      if (knownId === undefined || knownId === null) {
        const created = await this.actions.createRole(role);
        if (created) {
          roleIdMap.set(role.id, created);
          rolesCreated += 1;
        }
        continue;
      }
      roleIdMap.set(role.id, knownId);
      if (await this.actions.updateRole(knownId, role)) {
        rolesUpdated += 1;
      }
    }

    // Parents are created before their children, so a restored channel can be
    // reparented in the same pass instead of needing a second restore.
    const ordered = [...payload.channels].sort((left, right) => left.position - right.position);
    const channelIdMap = new Map<string, string>();
    let channelsCreated = 0;
    let channelsUpdated = 0;
    const missing: string[] = [];

    for (const channel of ordered) {
      const existingId = existingChannels.has(channel.id)
        ? channel.id
        : channelIdMap.get(channel.id);
      const parentId =
        channel.parentId === null
          ? null
          : (channelIdMap.get(channel.parentId) ??
            (existingChannels.has(channel.parentId) ? channel.parentId : null));
      const remapped = remapOverwrites(channel, roleIdMap);

      if (existingId !== undefined) {
        channelIdMap.set(channel.id, existingId);
        if (await this.actions.updateChannel(existingId, remapped)) {
          channelsUpdated += 1;
        }
        continue;
      }

      const created = await this.actions.createChannel(remapped, parentId);
      if (created) {
        channelIdMap.set(channel.id, created);
        channelsCreated += 1;
      } else {
        missing.push(channel.name);
      }
    }

    const notes: string[] = [];
    if (missing.length > 0) {
      notes.push(
        `${missing.length} channel(s) could not be restored, usually because the bot lacks Manage Channels there.`,
      );
    }

    return {
      backupId: "",
      rolesCreated,
      rolesUpdated,
      channelsCreated,
      channelsUpdated,
      missingChannels: missing,
      notes,
    };
  }
}

/** Rewrites a channel's role overwrites onto the role IDs that now exist. */
function remapOverwrites(
  channel: BackupChannel,
  roleIdMap: ReadonlyMap<string, string>,
): BackupChannel {
  return {
    ...channel,
    overwrites: channel.overwrites.map((overwrite) => {
      if (overwrite.kind !== "role") {
        return overwrite;
      }
      const mapped = roleIdMap.get(overwrite.id);
      return mapped === undefined ? overwrite : { ...overwrite, id: mapped };
    }),
  };
}
