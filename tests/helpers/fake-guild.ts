/**
 * Fake Discord guild for setup tests.
 *
 * Models the parts of `Guild` the setup system touches: a channel/role cache, name
 * lookups and creation. It is intentionally behavioral (creation assigns IDs and
 * the resource becomes findable) so tests exercise the real resolution logic
 * instead of asserting that a mock was called.
 */
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type Role,
  type TextChannel,
} from "discord.js";

import type { SetupResourceDefinition } from "../../src/modules/setup.types.js";
import type { SetupResourceDiscordAdapter } from "../../src/modules/setup/setup-resource.service.js";

export interface FakeChannel {
  readonly id: string;
  name: string;
  readonly type: ChannelType;
  readonly parentId: string | null;
  /** Overwrites applied through the permission API, keyed by target ID. */
  readonly overwrites: Map<string, Record<string, boolean>>;
  deleted: boolean;
}

/**
 * A role as the setup system sees it.
 *
 * `permissions` is mutable because a role's allow bitfield is what the Muted-role
 * reconciliation verifies and rewrites; a role whose permissions could not change
 * would make the permission path untestable.
 */
export interface FakeRole {
  readonly id: string;
  name: string;
  position: number;
  permissions: bigint;
  setPermissionsCalledWith: bigint[];
}

export interface FakeDiscord extends SetupResourceDiscordAdapter {
  /** Channels that currently exist (deleted ones are removed). */
  readonly channels: Map<string, FakeChannel>;
  readonly roles: Map<string, FakeRole>;
  /** Names passed to `createChannel`, in order. */
  readonly created: string[];
  /** Names passed to `createRole`, in order. */
  readonly createdRoles: string[];
  /**
   * Binds the guild the adapter serves.
   *
   * Needed because the harness constructs the adapter *before* the guild stub (the
   * stub's channel and role caches come from this adapter), and role wrappers must
   * expose `role.guild`.
   */
  attachGuild(guild: Guild): void;
  /**
   * Channels as Discord's own cache would hold them.
   *
   * Reads that go through `guild.channels.cache` (the setup planner does) must
   * observe the same state as reads that go through the adapter, or a seeded
   * channel would appear to exist for one code path and not the other.
   */
  readonly channelCache: Collection<string, unknown>;
  /**
   * Roles as Discord's cache holds them.
   *
   * Shared with the guild stub so a role created through `guild.roles.create` becomes
   * findable through the adapter, exactly as it would on Discord. Without this the
   * Muted-role reconciliation would read a stale permission value.
   */
  readonly roleCache: Collection<string, unknown>;
  /** Creates a channel as if an administrator had done it by hand. */
  seedChannel(name: string, type?: ChannelType, parentId?: string | null, id?: string): FakeChannel;
  /** Removes a channel, simulating manual deletion. */
  deleteChannel(id: string): void;
  /** When true, every creation fails, simulating a missing permission. */
  failCreation: boolean;
  /** Counts creation attempts (successful or not). */
  readonly createAttempts: { count: number };
}

/** The guild cache a `fakeDiscord()` instance reports through `setupGuildStub`. */
export interface FakeGuildCache {
  readonly channels: Collection<string, unknown>;
}

/**
 * Fake Discord adapter for the setup system.
 *
 * Channel and role caches are shared with the guild stub, so a resource created through
 * either path is visible to the other — exactly as it would be on Discord, and the
 * precondition for the Muted-role reconciliation to observe a concurrent write.
 */
export function fakeDiscord(): FakeDiscord {
  const channels = new Map<string, FakeChannel>();
  const roles = new Map<string, FakeRole>();
  const created: string[] = [];
  const createdRoles: string[] = [];
  // Assigned once the harness has built the guild, which needs this adapter first.
  let guild: Guild | null = null;
  const createAttempts = { count: 0 };
  const channelCache = new Collection<string, unknown>();
  // Shares one `Collection` with the guild stub handed to the setup module, so a role
  // created through either path is visible to the other.
  const roleCache = new Collection<string, unknown>();
  let nextId = 1;

  const mintId = (prefix: string): string => {
    const id = `${prefix}${String(nextId).padStart(3, "0")}`;
    nextId += 1;
    return id;
  };

  const adapter: FakeDiscord = {
    channels,
    roles,
    created,
    createdRoles,
    createAttempts,
    channelCache,
    roleCache,
    failCreation: false,

    attachGuild(bound) {
      guild = bound;
    },

    seedChannel(name, type = ChannelType.GuildText, parentId = null, id) {
      const channel: FakeChannel = {
        id: id ?? mintId("chan"),
        name,
        type,
        parentId,
        overwrites: new Map(),
        deleted: false,
      };
      channels.set(channel.id, channel);
      // Discord caches a channel as soon as it exists; the fake must too, or a
      // cache-first lookup would miss a seeded resource.
      channelCache.set(channel.id, channel);
      return channel;
    },

    deleteChannel(id) {
      channels.delete(id);
      channelCache.delete(id);
    },

    findChannelById(channelId) {
      const channel = channels.get(channelId);
      return Promise.resolve(channel ? (channel as unknown as TextChannel) : null);
    },

    findChannelByName(name, parentId) {
      const normalized = name.trim().toLowerCase();
      const found = [...channels.values()].find(
        (channel) =>
          channel.name.trim().toLowerCase() === normalized && channel.parentId === parentId,
      );
      return Promise.resolve(found ? (found as unknown as TextChannel) : null);
    },

    createChannel(definition: SetupResourceDefinition, parentId) {
      createAttempts.count += 1;
      if (adapter.failCreation) {
        return Promise.reject(new Error("Missing Permissions"));
      }
      // Discord rejects a second channel with the same name in the same parent,
      // which is the real-world hurdle a concurrent run must handle.
      const duplicate = [...channels.values()].some(
        (channel) =>
          channel.name.trim().toLowerCase() === definition.name.trim().toLowerCase() &&
          channel.parentId === parentId,
      );
      if (duplicate) {
        return Promise.reject(new Error("A channel with that name already exists"));
      }
      created.push(definition.name);
      const channel: FakeChannel = {
        id: mintId("chan"),
        name: definition.name,
        type: definition.type === "CATEGORY" ? ChannelType.GuildCategory : ChannelType.GuildText,
        parentId,
        overwrites: new Map(),
        deleted: false,
      };
      channels.set(channel.id, channel);
      channelCache.set(channel.id, channel);
      return Promise.resolve(channel as unknown as CategoryChannel | TextChannel);
    },

    findRoleById(roleId) {
      const role = roles.get(roleId);
      // Wrapped, and backed by the stored record rather than copied: the reconciliation
      // reads `role.guild`, `role.permissions.bitfield` and writes through
      // `role.setPermissions`, all of which a bare `{ id, name }` record cannot serve.
      return Promise.resolve(role ? (asDiscordRole(role, guild) as Role) : null);
    },

    findRoleByName(name) {
      const normalized = name.trim().toLowerCase();
      const role = [...roles.values()].find(
        (candidate) => candidate.name.trim().toLowerCase() === normalized,
      );
      return Promise.resolve(role ? (asDiscordRole(role, guild) as Role) : null);
    },

    createRole(definition) {
      createAttempts.count += 1;
      if (adapter.failCreation) {
        return Promise.reject(new Error("Missing Permissions"));
      }
      const role: FakeRole = {
        id: mintId("role"),
        name: definition.name,
        // A newly created role sits at the bottom, just above `@everyone`, which is
        // exactly the position that makes the ordering step in `resolveTrackedRole`
        // observable.
        position: 1,
        permissions: (definition.rolePermissions ?? []).reduce(
          (accumulator, permission) => accumulator | PermissionsBitField.resolve(permission),
          0n,
        ) as bigint,
        setPermissionsCalledWith: [],
      };
      roles.set(role.id, role);
      createdRoles.push(definition.name);
      return Promise.resolve(asDiscordRole(role, guild) as unknown as Role);
    },
  };

  return adapter;
}

/**
 * Adapts a mutable `FakeRole` to the shape the setup system reads from Discord.
 *
 * @param guild exposed as `role.guild`; the reconciliation needs it for `@everyone`
 *   and the bot's own permission bitfield. May be unset when a test seeds roles
 *   before the guild exists, in which case the accessor reports the binding lazily.
 */
function asDiscordRole(role: FakeRole, guild: Guild | null): unknown {
  return {
    id: role.id,
    name: role.name,
    get guild() {
      return guild;
    },
    get position() {
      return role.position;
    },
    permissions: {
      get bitfield() {
        return role.permissions;
      },
    },
    setPermissions(permissions: PermissionsBitField) {
      role.setPermissionsCalledWith.push(permissions.bitfield);
      role.permissions = permissions.bitfield;
      return Promise.resolve(role);
    },
    setPosition(position: number) {
      role.position = position;
      return Promise.resolve(role);
    },
  };
}

/**
 * Builds a `Guild`-shaped stub carrying only the members the services read.
 *
 * The caches are real `Collection`s because discord.js collection semantics are
 * part of the contract the code under test relies on (`.find`, `.get`, `.size`).
 */
export function setupGuildStub(
  id: string,
  botPermissions: readonly bigint[] = [],
  channelCache: Collection<string, unknown> = new Collection(),
  roleCache: Collection<string, unknown> = new Collection(),
  adapter: FakeDiscord | null = null,
  everyonePermissions: bigint = 0n,
): Guild {
  const admin = botPermissions.includes(PermissionFlagsBits.Administrator);

  // Referenced by the role wrappers created through `guild.roles.create`; assigned
  // after the literal below finishes.
  let guild: Guild | null = null;

  const stub = {
    id,
    name: "Setup Test Guild",
    channels: { cache: channelCache, fetch: () => Promise.resolve(channelCache) },
    roles: {
      // `@everyone` is modelled as a role object, not a string: the permission
      // resolver reads `.id` from it exactly as discord.js provides it, and the
      // Muted-role reconciliation reads its `permissions.bitfield` as the baseline the
      // Muted role's denies are measured against.
      everyone: {
        id,
        name: "@everyone",
        permissions: {
          get bitfield() {
            return everyonePermissions;
          },
        },
      },
      cache: roleCache,
      fetch: () => Promise.resolve(roleCache),
      /** Mirrors discord.js: creates a role and makes it findable by ID and name. */
      create: (options: {
        name: string;
        permissions?: readonly bigint[];
        reason?: string;
      }) => {
        const role = asDiscordRole(
          {
            id: `role-${roleCache.size + 1}`,
            name: options.name,
            position: 1,
            permissions: (options.permissions ?? []).reduce((acc, bit) => acc | bit, 0n),
            setPermissionsCalledWith: [],
          },
          guild,
        ) as { id: string };
        roleCache.set(role.id, role);
        return Promise.resolve(role as unknown as Role);
      },
    },
    members: {
      me: {
        id: "bot-user-id",
        user: { username: "test-bot" },
        permissions: {
          // `has` answers true for Administrator too, matching Discord's semantics: an
          // administrator holds every permission.
          has: (permission: bigint) => admin || botPermissions.includes(permission),
          bitfield: botPermissions.reduce((acc, bit) => acc | bit, 0n),
        },
        roles: { highest: { position: 100 } },
      },
    },
  } as unknown as Guild;

  // Bound after the literal because the stub references itself through the role
  // wrappers it creates, which need `role.guild`; the adapter receives the same
  // reference so its wrappers expose a guild too.
  guild = stub;
  adapter?.attachGuild(stub);

  return stub;
}
