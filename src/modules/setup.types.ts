/**
 * Setup contract types.
 *
 * The `Setuper` is the idempotent resource layer: "ensure this channel exists".
 * It never creates duplicates — running setup twice reuses what is already
 * there instead of producing `#logs`, `#logs-2`, ...
 */
import type { CategoryChannel, Guild, GuildBasedChannel, Role, TextChannel } from "discord.js";

/** Options used when creating or reusing a role. */
export interface EnsureRoleOptions {
  readonly name: string;
  readonly color?: number;
  readonly hoist?: boolean;
  readonly mentionable?: boolean;
  readonly permissions?: readonly bigint[];
  readonly reason?: string;
}

/** Options used when creating or reusing a text channel. */
export interface EnsureTextChannelOptions {
  readonly name: string;
  readonly parentId?: string | null;
  readonly topic?: string;
  readonly reason?: string;
}

/** Options used when creating or reusing a category. */
export interface EnsureCategoryOptions {
  readonly name: string;
  readonly reason?: string;
}

/** Marker: the requested resource already existed and was reused. */
export interface ReuseResult<T> {
  readonly resource: T;
  readonly created: boolean;
}

/**
 * Idempotent Discord resource helpers used by modules during setup.
 *
 * Every method first looks for a matching resource (by stored ID, then by name
 * inside the expected parent) and only creates one when nothing matches. Running
 * setup twice therefore reuses resources instead of duplicating them.
 */
export interface Setuper {
  /** The guild this setuper operates on. */
  readonly guild: Guild;
  ensureRole(options: EnsureRoleOptions): Promise<ReuseResult<Role>>;
  ensureCategory(options: EnsureCategoryOptions): Promise<ReuseResult<CategoryChannel>>;
  ensureTextChannel(options: EnsureTextChannelOptions): Promise<ReuseResult<TextChannel>>;
  /** Finds a channel by ID, verifying it still belongs to the guild. */
  findChannelById(channelId: string): Promise<GuildBasedChannel | null>;
  /** Finds a role by ID, verifying it still exists. */
  findRoleById(roleId: string): Promise<Role | null>;
  /** Finds a category by name (case-insensitive). */
  findCategoryByName(name: string): Promise<CategoryChannel | null>;
  /** Finds a text channel by name, optionally scoped to a parent category. */
  findTextChannelByName(name: string, parentId?: string | null): Promise<TextChannel | null>;
  /** Finds a role by name (case-insensitive). */
  findRoleByName(name: string): Promise<Role | null>;
}

/** A single resolved resource recorded by a setup run. */
export interface SetupResource {
  readonly key: string;
  readonly resourceId: string;
  readonly created: boolean;
}

/** Aggregate outcome of a setup run. */
export interface SetupReport {
  readonly guildId: string;
  readonly scope: string;
  readonly status: "completed" | "partial" | "failed";
  readonly created: number;
  readonly reused: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly results: readonly SetupActionResultEntry[];
  readonly resources: readonly SetupResource[];
}

/** Serialized form of a single action result, safe to persist. */
export interface SetupActionResultEntry {
  readonly module: string;
  readonly key: string;
  readonly description: string;
  readonly status: "created" | "reused" | "updated" | "skipped" | "failed";
  readonly resourceId?: string;
  readonly detail?: string;
  readonly errorMessage?: string;
}
