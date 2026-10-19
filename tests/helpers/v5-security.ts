/**
 * In-memory collaborators for the V5 tests.
 *
 * Like the moderation and setup harnesses, these fake *Discord* and *PostgreSQL*
 * only: the automod service, the evaluator, the escalation ladder, the security
 * service and the detectors are the production ones, so the suite exercises the code
 * the bot actually runs.
 *
 * Three fakes, one per new collaboration seam:
 *
 *   fakeSecurityActions  — lockdown, quarantine role, role stripping (Discord)
 *   memoryIncidents      — raid/nuke episodes (PostgreSQL)
 *   memoryBackups        — snapshots (PostgreSQL)
 */
import type {
  GuildSecurityActions,
  SecurityIncident,
  SecurityIncidentDraft,
  SecurityIncidentKind,
  SecurityIncidentRepository,
  SecurityLogEvent,
} from "../../src/modules/security/index.js";
import type {
  BackupChannel,
  BackupPayload,
  BackupRecord,
  BackupRepository,
  BackupRole,
  BackupSummary,
} from "../../src/modules/backup/index.js";

/** Controllable stand-in for the security module's Discord operations. */
export interface FakeSecurityActions extends GuildSecurityActions {
  /** Every call the service made, in order. */
  readonly calls: string[];
  /** True while the guild is locked down, as the fake sees it. */
  locked: boolean;
  /** Role IDs each member holds, so `roleIdsOf` is honest. */
  readonly roles: Map<string, Set<string>>;
  /** Fail every write with this detail when set. */
  failWith: string | null;
}

export interface FakeSecurityActionsOptions {
  readonly ownerId?: string;
  readonly botId?: string;
  readonly quarantineRole?: { id: string; name: string; position: number } | null;
  /**
   * The mute role containment should preserve.
   *
   * Defaults to `null`, matching a guild with no Muted role; a test that asserts a
   * mute survives a nuke passes one explicitly.
   */
  readonly muteRole?: { id: string; name: string; position: number } | null;
}

export function fakeSecurityActions(options: FakeSecurityActionsOptions = {}): FakeSecurityActions {
  const calls: string[] = [];
  const roles = new Map<string, Set<string>>();
  const adapter: FakeSecurityActions = {
    calls,
    locked: false,
    roles,
    failWith: null,

    lock() {
      calls.push("lock");
      if (adapter.failWith !== null) {
        return Promise.resolve({ ok: false, changed: [], detail: adapter.failWith });
      }
      // A second lockdown during the same raid changes nothing, which is exactly
      // what the real implementation reports through its `changed` list.
      const changed = adapter.locked ? [] : ["chan-1", "chan-2"];
      adapter.locked = true;
      return Promise.resolve({ ok: true, changed });
    },

    unlock() {
      calls.push("unlock");
      const changed = adapter.locked ? ["chan-1", "chan-2"] : [];
      adapter.locked = false;
      return Promise.resolve({ ok: true, changed });
    },

    quarantineRole() {
      return Promise.resolve(
        options.quarantineRole ?? { id: "role-q", name: "Quarantined", position: 1 },
      );
    },

    muteRole() {
      return Promise.resolve(options.muteRole ?? null);
    },

    ownerId() {
      return options.ownerId ?? "999999999999999999";
    },

    botId() {
      return options.botId ?? "bot-user-id";
    },

    roleIdsOf(userId) {
      return Promise.resolve([...(roles.get(userId) ?? [])]);
    },
  };
  return adapter;
}

/** Collects the security log lines the service emitted. */
export function memorySecurityLog(): {
  readonly events: SecurityLogEvent[];
  record(event: SecurityLogEvent): Promise<void>;
} {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    record(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/** In-memory incident store with the same "one active episode per kind" rule. */
export function memoryIncidents(): SecurityIncidentRepository & {
  readonly incidents: SecurityIncident[];
} {
  const incidents: SecurityIncident[] = [];
  let counter = 0;

  return {
    incidents,

    open(draft: SecurityIncidentDraft) {
      const existing = incidents.find(
        (incident) =>
          incident.guildId === draft.guildId &&
          incident.kind === draft.kind &&
          incident.status === "active",
      );
      if (existing) {
        // Extended in place, exactly like the Prisma repository's `touch`.
        const updated: SecurityIncident = {
          ...existing,
          summary: draft.summary,
          details: draft.details,
          targetedIds: draft.targetedIds,
          expiresAt: draft.expiresAt,
        };
        incidents.splice(incidents.indexOf(existing), 1, updated);
        return Promise.resolve(updated);
      }
      counter += 1;
      const record: SecurityIncident = {
        id: `incident-${counter}`,
        guildId: draft.guildId,
        kind: draft.kind,
        status: "active",
        summary: draft.summary,
        details: draft.details,
        targetedIds: [...draft.targetedIds],
        startedAt: new Date(),
        expiresAt: draft.expiresAt,
        resolvedAt: null,
        resolvedBy: null,
      };
      incidents.push(record);
      return Promise.resolve(record);
    },

    active(guildId: string, kind: SecurityIncidentKind) {
      return Promise.resolve(
        incidents.find(
          (incident) =>
            incident.guildId === guildId && incident.kind === kind && incident.status === "active",
        ) ?? null,
      );
    },

    listActive(guildId: string) {
      return Promise.resolve(
        incidents.filter(
          (incident) => incident.guildId === guildId && incident.status === "active",
        ),
      );
    },

    listExpired(now: Date) {
      return Promise.resolve(
        incidents.filter(
          (incident) =>
            incident.status === "active" &&
            incident.expiresAt !== null &&
            incident.expiresAt.getTime() <= now.getTime(),
        ),
      );
    },

    resolve(id: string, resolvedBy: string) {
      const index = incidents.findIndex((incident) => incident.id === id);
      const found = incidents[index];
      if (index === -1 || !found) {
        return Promise.resolve(null);
      }
      const resolved: SecurityIncident = {
        ...found,
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy,
      };
      incidents.splice(index, 1, resolved);
      return Promise.resolve(resolved);
    },
  };
}

/** In-memory snapshot store, guild-scoped like the Prisma one. */
export function memoryBackups(): BackupRepository & {
  readonly snapshots: BackupRecord[];
} {
  const snapshots: BackupRecord[] = [];
  let counter = 0;

  return {
    snapshots,

    append(record) {
      counter += 1;
      const summary: BackupSummary = {
        id: `backup-${counter}`,
        guildId: record.guildId,
        kind: record.kind,
        status: record.status,
        roleCount: record.payload.roles.length,
        channelCount: record.payload.channels.length,
        checksum: record.checksum,
        createdBy: record.createdBy,
        createdAt: new Date(),
      };
      // Copied through JSON, exactly like the Prisma repository does: the store must
      // hold a *snapshot*, not a reference a caller can keep mutating.
      const stored = JSON.parse(JSON.stringify(record.payload)) as BackupPayload;
      snapshots.push({ ...summary, payload: stored });
      return Promise.resolve(summary);
    },

    list(guildId, limit) {
      return Promise.resolve(
        snapshots
          .filter((snapshot) => snapshot.guildId === guildId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, limit),
      );
    },

    find(guildId, backupId) {
      // Both the guild and the ID are required, exactly as the Prisma query is.
      return Promise.resolve(
        snapshots.find((snapshot) => snapshot.id === backupId && snapshot.guildId === guildId) ??
          null,
      );
    },

    latest(guildId) {
      return Promise.resolve(
        snapshots
          .filter((snapshot) => snapshot.guildId === guildId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
      );
    },

    delete(guildId, backupId) {
      const index = snapshots.findIndex(
        (snapshot) => snapshot.id === backupId && snapshot.guildId === guildId,
      );
      if (index === -1) {
        return Promise.resolve(false);
      }
      snapshots.splice(index, 1);
      return Promise.resolve(true);
    },

    prune(guildId, keep) {
      const mine = snapshots
        .filter((snapshot) => snapshot.guildId === guildId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      const stale = mine.slice(keep);
      for (const snapshot of stale) {
        const index = snapshots.indexOf(snapshot);
        if (index !== -1) {
          snapshots.splice(index, 1);
        }
      }
      return Promise.resolve(stale.length);
    },
  };
}

/** In-memory implementation of `GuildBackupActions`, for capture/restore tests. */
export function fakeBackupActions(
  options: {
    readonly roles?: readonly BackupRole[];
    readonly channels?: readonly BackupChannel[];
    /** Fails every create when true, so "partial restore" can be asserted. */
    readonly failCreates?: boolean;
  } = {},
) {
  const live = {
    roles: [...(options.roles ?? [])],
    channels: [...(options.channels ?? [])],
  };
  const calls: string[] = [];
  let nextId = 0;

  const actions = {
    calls,
    live,

    read() {
      calls.push("read");
      return Promise.resolve({ roles: live.roles, channels: live.channels });
    },

    roleIds() {
      return Promise.resolve(live.roles.map((role) => role.id));
    },

    roleIdByName(name: string) {
      const normalized = name.trim().toLowerCase();
      const found = live.roles.find(
        (candidate) => candidate.name.trim().toLowerCase() === normalized,
      );
      return Promise.resolve(found?.id ?? null);
    },

    channelIds() {
      return Promise.resolve(live.channels.map((channel) => channel.id));
    },

    createRole(role: BackupRole) {
      calls.push(`createRole:${role.name}`);
      if (options.failCreates === true) {
        return Promise.resolve(null);
      }
      nextId += 1;
      const id = `new-role-${nextId}`;
      live.roles.push({ ...role, id });
      return Promise.resolve(id);
    },

    updateRole(roleId: string, role: BackupRole) {
      calls.push(`updateRole:${roleId}`);
      const index = live.roles.findIndex((candidate) => candidate.id === roleId);
      if (index !== -1) {
        live.roles.splice(index, 1, { ...role, id: roleId });
      }
      return Promise.resolve(true);
    },

    createChannel(channel: BackupChannel, parentId: string | null) {
      calls.push(`createChannel:${channel.name}`);
      if (options.failCreates === true) {
        return Promise.resolve(null);
      }
      nextId += 1;
      const id = `new-chan-${nextId}`;
      live.channels.push({ ...channel, id, parentId });
      return Promise.resolve(id);
    },

    updateChannel(channelId: string, channel: BackupChannel) {
      calls.push(`updateChannel:${channelId}`);
      const index = live.channels.findIndex((candidate) => candidate.id === channelId);
      if (index !== -1) {
        live.channels.splice(index, 1, { ...channel, id: channelId });
      }
      return Promise.resolve(true);
    },
  };

  return actions;
}

/** A payload shaped like a capture, for restore tests. */
export function backupPayload(overrides: Partial<BackupPayload> = {}): BackupPayload {
  return {
    version: 1,
    guildId: "111111111111111111",
    guildName: "Guild A",
    takenAt: "2026-01-01T00:00:00.000Z",
    roles: [],
    channels: [],
    config: { sections: {} },
    ...overrides,
  };
}

export type { BackupChannel, BackupRole };
