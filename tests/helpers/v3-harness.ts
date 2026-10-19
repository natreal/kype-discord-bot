/**
 * Shared test harness for the V3 layers (configuration, authorization,
 * diagnostics).
 *
 * Like the V2 setup harness, this wires the *real* services and replaces only
 * Discord and PostgreSQL, so the tests exercise the code the bot actually runs.
 * Two guilds are created up front because guild isolation is a requirement, not an
 * afterthought.
 */
import {
  Collection,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";

import { ConfigService } from "../../src/services/config/index.js";
import {
  AuthorizationService,
  PermissionClassStore,
  type PermissionClassRepository,
  type PermissionClassRow,
} from "../../src/services/authorization/index.js";
import { AuditEventService, type AuditEventRecord } from "../../src/services/audit/index.js";
import type { DatabaseService } from "../../src/services/database/index.js";
import { CommandRegistry } from "../../src/commands/command.registry.js";
import { PermissionService } from "../../src/services/permissions/index.js";
import { memoryDatabaseStub, type MemoryDatabaseStub } from "./database.js";
import { testLogger } from "./logger.js";

/** Guild A: the guild under test. */
export const GUILD_A = "111111111111111111";
/** Guild B: the control guild. Its state must never be visible from A. */
export const GUILD_B = "222222222222222222";

/** Discord user IDs used across the V3 tests. */
export const USER_ID = "333333333333333333";
export const OTHER_USER_ID = "444444444444444444";
/** The compiled-in God Access account, read from the module that owns it. */
export { GOD_ACCESS_USER_ID } from "../../src/modules/setup/index.js";

/** In-memory permission class repository. */
export function memoryPermissionClasses(): PermissionClassRepository & {
  readonly classes: Map<string, PermissionClassRow>;
  readonly bindings: Map<string, { guildId: string; roleId: string; classKey: string }>;
} {
  const classes = new Map<string, PermissionClassRow>();
  const bindings = new Map<string, { guildId: string; roleId: string; classKey: string }>();
  const keyOf = (guildId: string, key: string): string => `${guildId}:${key}`;

  return {
    classes,
    bindings,
    listClasses(guildId) {
      return Promise.resolve(
        [...classes.values()]
          .filter((row) => row.guildId === guildId)
          .sort((a, b) => b.priority - a.priority),
      );
    },
    saveClass(row) {
      classes.set(keyOf(row.guildId, row.key), row);
      return Promise.resolve();
    },
    removeClass(guildId, key) {
      classes.delete(keyOf(guildId, key));
      return Promise.resolve();
    },
    listBindings(guildId) {
      return Promise.resolve([...bindings.values()].filter((row) => row.guildId === guildId));
    },
    bindRole(guildId, roleId, classKey) {
      bindings.set(`${guildId}:${roleId}:${classKey}`, { guildId, roleId, classKey });
      return Promise.resolve();
    },
    unbindRole(guildId, roleId, classKey) {
      bindings.delete(`${guildId}:${roleId}:${classKey}`);
      return Promise.resolve();
    },
  };
}

/** Records audit events in memory. */
export function memoryAuditRepository(): {
  readonly events: AuditEventRecord[];
} & import("../../src/services/audit/index.js").AuditEventRepository {
  const events: AuditEventRecord[] = [];
  return {
    events,
    append(event) {
      events.push(event);
      return Promise.resolve();
    },
    list(guildId, limit) {
      return Promise.resolve(
        events
          .filter((event) => event.guildId === guildId)
          .slice(-limit)
          .reverse(),
      );
    },
  };
}

/** A member stub that the authorization service can inspect fully. */
export interface V3MemberOptions {
  readonly guildId: string;
  readonly userId?: string;
  readonly ownerId?: string;
  readonly permissions?: readonly bigint[];
  readonly roleIds?: readonly string[];
  readonly botPermissions?: readonly bigint[];
}

/**
 * Builds a `GuildMember`-shaped object.
 *
 * Real discord.js objects (`PermissionsBitField`, `Collection`) are used for the
 * parts the services read, because their semantics are part of the contract.
 */
export function v3Member(options: V3MemberOptions): GuildMember {
  const permissions = new PermissionsBitField(options.permissions ?? []);
  const roleIds = options.roleIds ?? [];
  const roles = new Collection<string, Role>(
    roleIds.map((id) => [id, { id, name: id } as unknown as Role]),
  );
  const bot = {
    id: "bot-user-id",
    user: { username: "test-bot" },
    permissions: new PermissionsBitField(options.botPermissions ?? []),
  };

  return {
    id: options.userId ?? USER_ID,
    permissions,
    roles: { cache: roles },
    guild: {
      id: options.guildId,
      ownerId: options.ownerId ?? "999999999999999999",
      members: { me: bot },
    },
  } as unknown as GuildMember;
}

/**
 * Minimal guild stub for diagnostics and authorization checks.
 *
 * Roles carry a real `permissions.bitfield`, and `@everyone` does too, because the
 * Muted-role check computes its target from the guild's actual `@everyone` value: a
 * member's permissions are `@everyone | roles`, so a deny only works relative to what
 * `@everyone` already grants. A stub without bitfields would make that check
 * unverifiable rather than merely lenient.
 */
export function v3Guild(options: {
  guildId: string;
  botPermissions?: readonly bigint[];
  channels?: readonly { id: string; name: string; type: number; parentId?: string | null }[];
  roles?: readonly { id: string; name: string; position?: number; permissions?: bigint }[];
  everyonePermissions?: bigint;
}): Guild {
  const channels = new Collection(
    (options.channels ?? []).map((channel) => [
      channel.id,
      { ...channel, parentId: channel.parentId ?? null },
    ]),
  );

  const roles = new Collection(
    (options.roles ?? []).map((role) => [
      role.id,
      {
        ...role,
        position: role.position ?? 1,
        // `permissions` must come *after* the spread: callers pass a bare bigint, and
        // the diagnostic reads `.bitfield`, exactly as discord.js exposes it.
        permissions: { bitfield: role.permissions ?? 0n },
      },
    ]),
  );

  const botMember = {
    id: "bot-user-id",
    user: { username: "test-bot" },
    permissions: new PermissionsBitField(options.botPermissions ?? []),
    roles: { highest: { position: 50 } },
    // `permissionsIn` is what a delivery check needs to answer "can the bot post
    // here?", so the stub answers it from the same permission set.
    permissionsIn: () => new PermissionsBitField(options.botPermissions ?? []),
  };

  return {
    id: options.guildId,
    name: `Guild ${options.guildId}`,
    channels: { cache: channels, fetch: () => Promise.resolve(channels) },
    roles: {
      everyone: {
        id: options.guildId,
        name: "@everyone",
        permissions: { bitfield: options.everyonePermissions ?? 0n },
      },
      cache: roles,
      fetch: () => Promise.resolve(roles),
    },
    members: {
      me: botMember,
      cache: new Collection(),
    },
    ownerId: "999999999999999999",
  } as unknown as Guild;
}

/** Everything the V3 test suites need. */
export interface V3Harness {
  readonly database: MemoryDatabaseStub;
  readonly config: ConfigService;
  readonly audit: AuditEventService;
  readonly auditEvents: AuditEventRecord[];
  readonly classes: ReturnType<typeof memoryPermissionClasses>;
  readonly authorization: AuthorizationService;
  readonly permissions: PermissionService;
  readonly commands: CommandRegistry;
  /** Registers a command so `diagnostics` sees a populated registry. */
  registerCommand(name: string): void;
}

/**
 * Builds the V3 services against in-memory persistence.
 *
 * `guildName` is irrelevant here on purpose: every store is keyed by `guildId`,
 * which is exactly the isolation property the tests assert.
 */
export function createV3Harness(): V3Harness {
  const database = memoryDatabaseStub();
  const auditEvents: AuditEventRecord[] = [];
  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditEvents.push(event);
      return Promise.resolve();
    },
    list(guildId, limit) {
      return Promise.resolve(
        auditEvents
          .filter((event) => event.guildId === guildId)
          .slice(-limit)
          .reverse(),
      );
    },
  });

  const config = new ConfigService({
    database: database as unknown as DatabaseService,
    logger: testLogger,
    repository: database.configRepository,
    audit,
  });

  const classes = memoryPermissionClasses();
  const authorization = new AuthorizationService({
    logger: testLogger,
    classes: new PermissionClassStore({ logger: testLogger, repository: classes }),
    audit,
  });

  const commands = new CommandRegistry();

  return {
    database,
    config,
    audit,
    auditEvents,
    classes,
    authorization,
    permissions: new PermissionService(),
    commands,
    registerCommand(name: string) {
      commands.register({
        kind: "slash",
        meta: { name, description: name, category: "utility" },
        name,
        description: name,
        category: "utility",
        permissions: {},
        guildOnly: true,
        data: { name } as never,
        execute: () => Promise.resolve(),
      });
    },
  };
}
