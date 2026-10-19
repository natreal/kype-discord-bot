/**
 * Setup contract types.
 *
 * The `Setuper` is the idempotent resource layer: "ensure this channel exists".
 * It never creates duplicates — running setup twice reuses what is already
 * there instead of producing `#logs`, `#logs-2`, ...
 *
 * V2 adds *tracked* resolution on top (see `SetupResourceService`): a resource is
 * first looked up by the Discord ID stored in the database, then by its expected
 * name inside its parent, and only created when neither matches. Both operations
 * are optional on the interface so that lightweight test doubles remain valid.
 */
import type {
  CategoryChannel,
  Guild,
  GuildBasedChannel,
  PermissionResolvable,
  Role,
  TextChannel,
} from "discord.js";

/** Resource kinds the setup system can own (mirrors the Prisma enum). */
export const SETUP_RESOURCE_TYPES = ["CATEGORY", "TEXT_CHANNEL", "VOICE_CHANNEL", "ROLE"] as const;

export type SetupResourceType = (typeof SETUP_RESOURCE_TYPES)[number];

/** @returns true when `value` is a known setup resource type. */
export function isSetupResourceType(value: unknown): value is SetupResourceType {
  return typeof value === "string" && (SETUP_RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Declarative description of a resource the setup system owns.
 *
 * This is the *plan*, not the result: it says "this guild should have a text
 * channel named `welcome` inside the `information` category, and only these
 * permissions". The resource service turns it into a real Discord resource and a
 * persisted identity.
 */
export interface SetupResourceDefinition {
  /** Stable logical key, e.g. `information.welcome`. Unique per guild. */
  readonly key: string;
  /** Discord resource kind. */
  readonly type: SetupResourceType;
  /** Expected resource name; also the adoption hint during recovery. */
  readonly name: string;
  /** Human-readable label used in the Discord-facing setup summary. */
  readonly label: string;
  /** Target channel name for a category, e.g. `INFORMATION`. */
  readonly category?: string;
  /** Absolute permission overwrites applied after resolution. */
  readonly permissions?: readonly SetupPermissionOverwrite[];
  /** Base Discord permissions for a managed role. */
  readonly rolePermissions?: readonly PermissionResolvable[];
  /** Audit-log reason recorded when the resource is created or modified. */
  readonly reason?: string;
  /** Channel topic, applied only when the channel is created. */
  readonly topic?: string;
  /** Keys of resources that must resolve before this one. */
  readonly requires?: readonly string[];
  /** Set when the resource is tracked but never provisioned by V2. */
  readonly provisionable?: boolean;
}

/** A `SetupResourceDefinition` enriched with its resolved Discord snowflake. */
export interface ResolvedSetupResource {
  readonly definition: SetupResourceDefinition;
  readonly discordId: string;
  readonly origin: TrackedResolution["origin"];
}

/** Options used when creating or reusing a role. */
export interface EnsureRoleOptions {
  readonly name: string;
  readonly color?: number;
  readonly hoist?: boolean;
  readonly mentionable?: boolean;
  /**
   * Base permissions for the role.
   *
   * Typed as resolvables (Discord accepts names and bitfields) because callers
   * declare intent declaratively; the Setuper converts them once, at the API
   * boundary.
   */
  readonly permissions?: readonly PermissionResolvable[];
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
  /**
   * Resolves a resource by its logical key, reusing, adopting or creating it.
   *
   * @returns the resource and how it was obtained:
   * - `created` — nothing matched, so a new Discord resource was created;
   * - `reused` — a stored ID or expected name matched an existing resource;
   * - `recovered` — a stale/absent reference was repaired in place.
   */
  resolveTrackedResource?(resource: SetupResourceDefinition): Promise<TrackedResolution>;
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
  /**
   * Applies permission overwrites to a resolved resource.
   *
   * Declared here (rather than only on the permission service) because the
   * resource is already resolved at this point, so no extra Discord fetch is
   * needed and permission changes stay inside the same orchestrated step.
   */
  applyPermissionDiff?(
    resource: CategoryChannel | TextChannel | Role,
    overwrites: readonly SetupPermissionOverwrite[],
  ): Promise<number>;
}

/**
 * One declarative permission rule for a setup-managed resource.
 *
 * `allow`/`deny` are Discord permissions; `target` selects the role or user the
 * overwrite applies to. Keeping this declarative is what makes section 12 of the
 * V2 brief possible: the command never contains overwrite logic, and future
 * modules describe their access rules the same way.
 */
export type SetupPermissionTarget =
  | { readonly kind: "everyone" }
  /** Role created or adopted by setup, referenced by its resource key. */
  | { readonly kind: "resourceRole"; readonly key: string }
  /** Role that already exists in the guild, referenced by name. */
  | { readonly kind: "roleName"; readonly name: string }
  /** The bot itself (its managed role). */
  | { readonly kind: "bot" };

export interface SetupPermissionOverwrite {
  readonly target: SetupPermissionTarget;
  readonly allow?: readonly PermissionResolvable[];
  readonly deny?: readonly PermissionResolvable[];
  /** When true, the overwrite is removed instead of written. */
  readonly remove?: boolean;
  /** Why this rule exists; logged with the audit trail. */
  readonly reason?: string;
}

/** Outcome of resolving (and persisting the identity of) a setup resource. */
export interface TrackedResolution<
  TResource extends CategoryChannel | TextChannel | Role = CategoryChannel | TextChannel,
> extends ReuseResult<TResource> {
  /** How the resource was obtained. */
  readonly origin: "created" | "reused" | "recovered";
  /**
   * True when the stored Discord ID was stale, meaning the resource was recreated
   * or re-adopted and the database identity had to be repaired.
   */
  readonly repaired: boolean;
  /** Discord ID previously stored for this key, when one existed. */
  readonly previousId: string | null;
  /** Human-readable recovery note, included in the setup report. */
  readonly detail?: string;
}

/** Persisted identity of one resource owned by the setup system. */
export interface SetupResourceRecord {
  readonly guildId: string;
  readonly key: string;
  readonly type: SetupResourceType;
  readonly discordId: string | null;
  readonly name: string | null;
  readonly config: Record<string, unknown>;
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
  /**
   * Resources whose identity is tracked in `setup_resources`.
   *
   * Kept separate from `resources` so the Discord-facing summary can show
   * `created` / `reused` / `repaired` per tracked resource without having to
   * understand module-specific key namespaces.
   */
  readonly setupResources: readonly SetupResourceIdentity[];
}

/** Identity of a resource created or repaired by the automatic setup module. */
export interface SetupResourceIdentity {
  readonly key: string;
  readonly resourceId: string;
  readonly created: boolean;
  readonly recovered: boolean;
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
