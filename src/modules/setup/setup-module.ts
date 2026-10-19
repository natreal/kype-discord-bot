/**
 * The V2 automatic setup module.
 *
 * A `BotModule` like every other feature module, but the only one that owns guild
 * *structure*. It is provider-based rather than dependency-captured: the command
 * creates the module per interaction with the guild, the database and the
 * resolver it already has, which keeps the module testable and free of globals.
 *
 * Flow (deterministic and idempotent):
 *
 *   bot permission preflight
 *     → resolve each resource (DB ID → verify → adopt → create)
 *     → apply its declarative permission overwrites
 *     → return one structured result per resource
 */
import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";

import type { BotModule, ModuleContext, SetupAction, SetupActionResult } from "../module.types.js";
import type { SetupResourceDefinition, TrackedResolution } from "../setup.types.js";
import { SETUP_RESOURCES, SETUP_SECTION_KEYS } from "./setup-resources.js";
import type { SetupPermissionService } from "./setup-permission.service.js";
import type { SetupResourceService } from "./setup-resource.service.js";
import type { TrackedSetuper } from "./tracked-setuper.js";

/**
 * The **only** hard-coded authority in the platform, by explicit operator
 * decision: this user may run every command regardless of the Discord permissions
 * they hold, because they own the deployment.
 *
 * The value is a Discord user ID, never a role, token or environment variable:
 * it cannot be spoofed by a guild administrator, and it is validated at import
 * time so a typo cannot silently disable (or worse, wrongly grant) the authority.
 */
export const GOD_ACCESS_USER_ID = "905909797927411732";

/** Validates a user ID at module load so a bad value fails fast and loudly. */
if (!/^\d{17,20}$/.test(GOD_ACCESS_USER_ID)) {
  throw new Error(`GOD_ACCESS_USER_ID is not a valid Discord snowflake: ${GOD_ACCESS_USER_ID}`);
}

/**
 * @returns true when the given user ID holds God Access.
 *
 * Pure, synchronous and dependency-free on purpose: it is the primitive that the
 * permission service, the command diagnostics and the tests all share.
 */
export function isGodAccess(userId: string | null | undefined): boolean {
  return userId === GOD_ACCESS_USER_ID;
}

/**
 * Removes God Access accounts from a member list.
 *
 * Anti-raid and anti-nuke work by acting on members; the owner must never be
 * caught by their own automation, so future modules filter through this helper
 * instead of re-implementing the comparison.
 */
export function filterGodAccounts<T extends { id: string }>(members: readonly T[]): T[] {
  return members.filter((member) => !isGodAccess(member.id));
}

/** Everything the V2 module needs, supplied per guild by the setup service. */
export interface SetupModuleDependencies {
  /** Creates a tracked setuper for the guild being configured. */
  readonly setuperFor: (guild: Guild) => TrackedSetuper;
  /** Resolves the resource identity table for the guild. */
  readonly resourcesFor: (guild: Guild) => SetupResourceService;
  /** Permission rules and bot preflight. */
  readonly permissions: SetupPermissionService;
  /** Bot membership, used for the preflight and permission overwrites. */
  readonly botMember: (guild: Guild) => GuildMember | null;
}

/**
 * Per-run state shared between the preflight and the resource actions.
 *
 * `runResourceAction` is called directly by `SetupService.runAction` (as a plain
 * function), so it cannot read the preflight's result from an instance field. This
 * WeakMap keyed by the guild gives the preflight a way to veto the rest of the run
 * without changing the module contract or leaking state across guilds.
 */
const blockedGuilds = new WeakMap<Guild, string>();

/**
 * Creates the automatic setup module bound to one guild's dependencies.
 *
 * The module performs no writes in `plan()`; it only declares the actions. The
 * preflight runs inside each action so a missing bot permission produces a
 * structured `failed` entry with an actionable reason rather than an exception
 * that aborts the whole run.
 */
export function createSetupModule(dependencies: SetupModuleDependencies): BotModule {
  return {
    name: "setup",
    description: "Automatic server structure: categories, information and log channels.",

    enabled(): boolean {
      return true;
    },

    plan(): SetupAction[] {
      return [
        {
          key: "bot-permissions",
          description: "Verify the bot can create and configure channels and roles.",
          run: (context) => runPreflight(context, dependencies),
        },
        ...SETUP_RESOURCES.map((definition): SetupAction => ({
          key: definition.key,
          description: describeAction(definition),
          run: (context) => runResourceAction(definition, context, dependencies),
        })),
      ];
    },
  };
}

/** Reads the guild from the module context (the setuper is guild-bound). */
function guildOf(context: ModuleContext): Guild {
  return context.setuper.guild;
}

/**
 * Preflight: fail fast and explain, instead of creating half a structure.
 *
 * A guild owner cannot install a bot that lacks these permissions, and God Access
 * does not change the *bot's* rights — it grants a human authority over the bot,
 * not Discord powers to the bot itself, so the check always applies.
 */
function runPreflight(
  context: ModuleContext,
  dependencies: SetupModuleDependencies,
): Promise<SetupActionResult> {
  const guild = guildOf(context);
  const me = dependencies.botMember(guild);

  if (!me) {
    context.logger.warn("Could not resolve the bot member; skipping the permission preflight", {
      guildId: guild.id,
    });
    return Promise.resolve({
      status: "skipped",
      detail: "the bot member is not cached yet; permissions will be enforced by Discord",
    });
  }

  // `Administrator` satisfies every requirement, matching Discord's semantics.
  const missing = me.permissions.has(PermissionFlagsBits.Administrator)
    ? []
    : dependencies.permissions.missingBotPermissions(guild);

  if (missing.length > 0) {
    const reason = dependencies.permissions.describeMissing(missing);
    context.logger.error("Bot is missing permissions required for automatic setup", undefined, {
      guildId: guild.id,
      missing: missing.map(String),
      fix: "Re-invite the bot with the recommended profile (see /admin invite).",
    });
    // Record the veto so the resource actions report an explanation instead of
    // attempting writes Discord would reject one by one.
    blockedGuilds.set(guild, reason);
    return Promise.resolve({ status: "failed", detail: reason, error: reason });
  }

  blockedGuilds.delete(guild);
  return Promise.resolve({
    status: "reused",
    detail: me.permissions.has(PermissionFlagsBits.Administrator)
      ? "administrator profile"
      : `${SETUP_RESOURCES.length} resource(s) checked`,
  });
}

/** One declarative sentence per resource, shown by `/help` and the dry run. */
function describeAction(definition: SetupResourceDefinition): string {
  if (definition.provisionable === false) {
    return `Track ${definition.label} (created when its module is enabled).`;
  }
  switch (definition.type) {
    case "CATEGORY":
      return `Create the ${definition.label} category, or reuse it.`;
    case "ROLE":
      return `Create the ${definition.label} role, or reuse it.`;
    default:
      return `Create ${definition.label} inside ${definition.category ?? "the guild"}, or reuse it.`;
  }
}

/**
 * Resolves one resource and applies its declared permissions.
 *
 * Failure isolation is deliberate: a module that cannot create its *own* resource
 * reports `failed` and leaves every other resource untouched. Resources whose
 * `requires` parent failed are reported as `skipped` with the reason, which is far
 * more useful than Discord's downstream "Unknown Channel" error.
 */
async function runResourceAction(
  definition: SetupResourceDefinition,
  context: ModuleContext,
  dependencies: SetupModuleDependencies,
): Promise<SetupActionResult> {
  const guild = guildOf(context);
  const setuper = dependencies.setuperFor(guild);

  // The preflight is authoritative: if the bot cannot manage channels and roles,
  // nothing is attempted, and every resource explains why in one place.
  const blocked = blockedGuilds.get(guild);
  if (blocked) {
    return {
      status: "skipped",
      detail: `skipped because the bot cannot manage this server: ${blocked}`,
    };
  }

  if (definition.provisionable === false) {
    return {
      status: "skipped",
      detail: `${definition.label} is tracked but not created until its module is enabled`,
    };
  }

  const parentKey = definition.requires?.[0];
  if (parentKey) {
    const parentId = await setuper.resolveKey(parentKey);
    if (!parentId) {
      return {
        status: "skipped",
        detail: `skipped because parent resource "${parentKey}" is not available`,
      };
    }
  }

  const parentId = await resolveParentId(definition, setuper, guild);

  let resolution: TrackedResolution<CategoryChannel | TextChannel | Role>;
  try {
    resolution = await resolveDefinition(definition, setuper, parentId);
  } catch (error) {
    // The reason is surfaced instead of swallowed. A role that cannot be resolved is
    // almost always a missing `Manage Roles`, and "the resource could not be resolved"
    // told the operator nothing about which permission to grant.
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      detail: `${definition.label} could not be resolved: ${message}`,
      error: message,
    };
  }
  if (!resolution) {
    return {
      status: "failed",
      detail: "the resource could not be resolved",
      error: "the resource could not be resolved",
    };
  }

  const permissionOutcome = await applyPermissions(definition, resolution, setuper);

  return {
    status: toActionResultStatus(resolution, permissionOutcome),
    resourceId: resolution.resource.id,
    detail: buildDetail(resolution, permissionOutcome),
    ...(permissionOutcome.error === undefined ? {} : { error: permissionOutcome.error }),
  };
}
/** Resolves the Discord ID of the category a resource belongs to. */
async function resolveParentId(
  definition: SetupResourceDefinition,
  setuper: TrackedSetuper,
  guild: Guild,
): Promise<string | null> {
  if (definition.type === "CATEGORY" || !definition.category) {
    return null;
  }

  const key = SETUP_SECTION_KEYS.categoryKeyFor(definition.category);
  if (key) {
    const stored = await setuper.resolveKey(key);
    if (stored) {
      return stored;
    }
  }

  // Fall back to a name lookup so a category created by an earlier version (or by
  // hand) is still honoured instead of producing a duplicate category.
  const category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === definition.category,
  );
  return category?.id ?? null;
}

/** Applies the declarative permission rules of a resource. */
async function applyPermissions(
  definition: SetupResourceDefinition,
  resolution: TrackedResolution<CategoryChannel | TextChannel | Role>,
  setuper: TrackedSetuper,
): Promise<{ count: number; error?: string }> {
  if (definition.type === "ROLE") {
    // A role has no channel overwrites. Its reconciliation is `applyRolePermissions`,
    // and keeping the two explicit means a role can never reach
    // `setupPermissionsFromOptions`, which throws for one by design.
    return applyRolePermissions(resolution, setuper);
  }

  const overwrites = definition.permissions ?? [];
  if (overwrites.length === 0) {
    return { count: 0 };
  }

  try {
    const count = await setuper.applyPermissionDiff(resolution.resource, overwrites);
    return { count };
  } catch (error) {
    // The resource exists; only its permissions are wrong. Reported as a failure
    // so the operator sees it, while the next run re-applies them idempotently.
    const message = error instanceof Error ? error.message : String(error);
    return { count: 0, error: `Permissions could not be applied: ${message}` };
  }
}

/**
 * Reconciles a managed role's permissions against its declared specification.
 *
 * This is the fix for "the bot should verify the Muted role's permissions and modify
 * it if necessary": until now `ensureRole` returned early for an existing role and
 * never inspected its permissions, so a role that had been created once — or edited
 * by hand afterwards — kept whatever permissions it happened to have. A muted member
 * could still send messages and nothing reported it.
 *
 * The comparison runs through `diffMuteRole` when the resource is the mute role, so
 * the same rules drive `/diagnose` and setup. The result participates in the report
 * through the same `count`/`error` shape the channel path returns, with the
 * differences appended to the run's detail line.
 */
async function applyRolePermissions(
  resolution: TrackedResolution<CategoryChannel | TextChannel | Role>,
  setuper: TrackedSetuper,
): Promise<{ count: number; error?: string }> {
  const role = resolution.resource;
  if (!("permissions" in role)) {
    return { count: 0 };
  }

  try {
    const outcome = await setuper.reconcileRolePermissions(role);
    return { count: outcome.changed ? 1 : 0, ...(outcome.error === undefined ? {} : { error: outcome.error }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { count: 0, error: `Role permissions could not be reconciled: ${message}` };
  }
}
/**
 * Resolves a single definition through the tracked setuper.
 *
 * Roles and channels use different Discord APIs, and the registry only declares
 * roles once a module actually owns one (none in V2), so the branch is explicit
 * rather than a union flowing into every caller.
 */
function resolveDefinition(
  definition: SetupResourceDefinition,
  setuper: TrackedSetuper,
  parentId: string | null,
): Promise<TrackedResolution<CategoryChannel | TextChannel | Role>> {
  return definition.type === "ROLE"
    ? setuper.resolveTrackedRole(definition)
    : setuper.resolveTrackedResource(definition, parentId);
}

/** Maps a tracked resolution onto the report's action status vocabulary. */
function toActionResultStatus(
  resolution: TrackedResolution<CategoryChannel | TextChannel | Role>,
  permissionOutcome: { count: number; error?: string },
): SetupActionResult["status"] {
  // A resource that already existed but had its permissions corrected is `updated`,
  // not `reused`: an operator reading the report must be able to see that setup
  // *changed* something, which is the whole point of reconciling a role.
  if (resolution.origin === "reused" && permissionOutcome.count > 0) {
    return "updated";
  }

  switch (resolution.origin) {
    case "created":
      return "created";
    case "recovered":
      return "updated";
    default:
      return "reused";
  }
}

/** Builds the human-readable detail line for the report. */
function buildDetail(
  resolution: TrackedResolution<CategoryChannel | TextChannel | Role>,
  permissionOutcome: { count: number; error?: string },
): string {
  const parts = [resolution.resource.name];
  if (resolution.detail) {
    parts.push(resolution.detail);
  }
  if (resolution.repaired) {
    parts.push("identity repaired");
  }
  if (permissionOutcome.count > 0) {
    parts.push(`${permissionOutcome.count} permission rule(s) applied`);
  }
  return parts.join(" — ");
}
