/**
 * Backup payload contracts (V5).
 *
 * A snapshot captures the *structure* of a server — roles, channels, their
 * permission overwrites and the configuration sections the bot owns — and never
 * member data, messages or anything personal. Three properties matter:
 *
 * - **guild-isolated.** The payload carries the `guildId` it was taken from, and a
 *   restore refuses a snapshot whose guild does not match the guild it is applied
 *   to. A backup is never shared between guilds, which is why there is no
 *   "export/import across servers" feature and no path that could grow one.
 * - **checksummed.** `checksum` is a SHA-256 over the canonical JSON, so a restore
 *   can detect a truncated or hand-edited row instead of half-rebuilding a server.
 * - **diffable.** `before`/`after` of a restore are computed by comparing the
 *   snapshot with the live guild, which is what `/backup restore` reports and what
 *   the security log records.
 */

/** One role, as a snapshot stores it. */
export interface BackupRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly hoist: boolean;
  readonly mentionable: boolean;
  /** Permission bitfield, as a string because a bigint does not survive JSON. */
  readonly permissions: string;
  readonly position: number;
  /** True for a role Discord itself manages (a bot or integration role). */
  readonly managed: boolean;
}

/** One channel, as a snapshot stores it. */
export interface BackupChannel {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly position: number;
  readonly topic: string | null;
  readonly nsfw: boolean;
  /** Permission overwrites, keyed by role or member ID. */
  readonly overwrites: readonly BackupOverwrite[];
}

/** One permission overwrite. */
export interface BackupOverwrite {
  readonly id: string;
  /** `role` or `member`. */
  readonly kind: "role" | "member";
  readonly allow: string;
  readonly deny: string;
}

/** Configuration captured alongside the structure. */
export interface BackupConfig {
  readonly sections: Readonly<Record<string, unknown>>;
}

/** A complete snapshot payload. */
export interface BackupPayload {
  /** Format version, so a future restore can refuse or migrate an old payload. */
  readonly version: 1;
  /** The guild this was taken from. A restore requires an exact match. */
  readonly guildId: string;
  readonly guildName: string;
  readonly takenAt: string;
  readonly roles: readonly BackupRole[];
  readonly channels: readonly BackupChannel[];
  readonly config: BackupConfig;
}

/** A stored snapshot, without its payload. */
export interface BackupSummary {
  readonly id: string;
  readonly guildId: string;
  readonly kind: "manual" | "scheduled";
  readonly status: "complete" | "partial";
  readonly roleCount: number;
  readonly channelCount: number;
  readonly checksum: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A stored snapshot including its payload. */
export interface BackupRecord extends BackupSummary {
  readonly payload: BackupPayload | null;
}

/** Persistence port, so the service is testable without PostgreSQL. */
export interface BackupRepository {
  append(record: {
    readonly guildId: string;
    readonly kind: "manual" | "scheduled";
    readonly status: "complete" | "partial";
    readonly payload: BackupPayload;
    readonly checksum: string;
    readonly createdBy: string;
  }): Promise<BackupSummary>;
  list(guildId: string, limit: number): Promise<BackupSummary[]>;
  /** @returns one snapshot of a guild, or `null` when it does not belong to it. */
  find(guildId: string, backupId: string): Promise<BackupRecord | null>;
  /** @returns the most recent snapshot of a guild, or `null`. */
  latest(guildId: string): Promise<BackupRecord | null>;
  delete(guildId: string, backupId: string): Promise<boolean>;
  /** Drops everything but the newest `keep` snapshots of a guild. */
  prune(guildId: string, keep: number): Promise<number>;
}

/** What a restore changed. */
export interface RestoreReport {
  readonly backupId: string;
  readonly rolesCreated: number;
  readonly rolesUpdated: number;
  readonly channelsCreated: number;
  readonly channelsUpdated: number;
  /** Objects the snapshot knew about but that are gone from the guild. */
  readonly missingChannels: readonly string[];
  readonly notes: readonly string[];
}
