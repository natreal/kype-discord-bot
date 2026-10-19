/**
 * Moderation vocabulary and policy.
 *
 * The action table is the single source of truth for "what moderation can do":
 * the commands, the case history, the audit trail and the log channel all read
 * from it, so an action cannot exist in one place and be missing in another.
 *
 * Two deliberate design choices, made for the V4 brief and for the phases after
 * it:
 *
 * 1. `scope` separates a punishment applied to a member from guild-wide work (a
 *    purge removes messages, not a person). `/history` shows both, but only
 *    member actions take part in the warn threshold.
 * 2. `reversible` and `autoModAllowed` are declared, not guessed: a later AI
 *    moderation assistant must know which actions it may undo, and which it may
 *    trigger without a human. Nothing in V4 reads `autoModAllowed` yet — the
 *    field exists so that adding automation later cannot silently widen what a
 *    non-human actor is allowed to do.
 */
import type { Permission } from "../../services/authorization/permissions.js";

/** Every action moderation can record. Adding one requires no migration. */
export const MODERATION_ACTIONS = [
  "warn",
  "unwarn",
  "note",
  "mute",
  "unmute",
  "timeout",
  "untimeout",
  "kick",
  "ban",
  "unban",
  "softban",
  "purge",
  "quarantine",
  "unquarantine",
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** @returns true when `value` is a known moderation action. */
export function isModerationAction(value: unknown): value is ModerationAction {
  return typeof value === "string" && (MODERATION_ACTIONS as readonly string[]).includes(value);
}

/**
 * What an action applies to.
 *
 * Member actions punish or pardon a person and are the only ones counted by the
 * warning threshold. The `message` scope exists today for `purge`; `channel` and
 * `guild` are reserved for the security module (lockdown) and are declared here
 * so that module does not have to reopen this table.
 */
export const MODERATION_SCOPES = ["member", "message", "channel", "guild"] as const;

export type ModerationScope = (typeof MODERATION_SCOPES)[number];

/**
 * The action table.
 *
 * Annotated as a complete `Record` so a new entry in `MODERATION_ACTIONS`
 * without a definition here fails the type check instead of silently having no
 * permission requirement.
 */
export const MODERATION_ACTION_DEFINITIONS: Readonly<
  Record<ModerationAction, ModerationActionDefinition>
> = {
  warn: {
    action: "warn",
    scope: "member",
    permission: "moderation.warn",
    botPermission: "moderation.warn",
    label: "Warning",
    reversible: true,
    autoModAllowed: true,
    countsTowardsThreshold: true,
    requiresModerationEnabled: true,
  },
  unwarn: {
    action: "unwarn",
    scope: "member",
    permission: "moderation.warn",
    botPermission: "moderation.warn",
    label: "Warning removed",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    // A pardon must keep working with moderation disabled, otherwise a server
    // that turns the module off can never clear a warning it recorded.
    requiresModerationEnabled: false,
  },
  note: {
    action: "note",
    scope: "member",
    permission: "moderation.warn",
    botPermission: "moderation.warn",
    label: "Note",
    // A note changes nothing about the member, so there is nothing to undo.
    reversible: false,
    // V5 automod uses `note` for "this happened, but no punishment was applied
    // yet", which is exactly the kind of record a non-human actor may write.
    autoModAllowed: true,
    countsTowardsThreshold: false,
    // A note must be recordable even with moderation disabled: an operator who
    // turns punishments off still wants the evidence of a first trigger.
    requiresModerationEnabled: false,
  },
  mute: {
    action: "mute",
    scope: "member",
    permission: "moderation.mute",
    botPermission: "moderation.timeout",
    label: "Mute (Muted role)",
    reversible: true,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  unmute: {
    action: "unmute",
    scope: "member",
    permission: "moderation.mute",
    botPermission: "moderation.timeout",
    label: "Unmute",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: false,
  },
  timeout: {
    action: "timeout",
    scope: "member",
    permission: "moderation.timeout",
    botPermission: "moderation.timeout",
    label: "Timeout",
    reversible: true,
    autoModAllowed: true,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  untimeout: {
    action: "untimeout",
    scope: "member",
    permission: "moderation.timeout",
    botPermission: "moderation.timeout",
    label: "Timeout removed",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: false,
  },
  kick: {
    action: "kick",
    scope: "member",
    permission: "moderation.kick",
    botPermission: "moderation.kick",
    label: "Kick",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  ban: {
    action: "ban",
    scope: "member",
    permission: "moderation.ban",
    botPermission: "moderation.ban",
    label: "Ban",
    reversible: true,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  unban: {
    action: "unban",
    scope: "member",
    permission: "moderation.unban",
    botPermission: "moderation.ban",
    label: "Unban",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: false,
  },
  softban: {
    action: "softban",
    scope: "member",
    permission: "moderation.ban",
    botPermission: "moderation.ban",
    label: "Softban",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  purge: {
    action: "purge",
    scope: "message",
    permission: "moderation.purge",
    botPermission: "moderation.purge",
    label: "Purge",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: true,
  },
  quarantine: {
    action: "quarantine",
    scope: "member",
    permission: "security.lockdown",
    botPermission: "moderation.timeout",
    label: "Quarantine",
    reversible: true,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    // Containment must keep working with moderation disabled: an operator who
    // turned punishments off did not ask to lose raid containment.
    requiresModerationEnabled: false,
  },
  unquarantine: {
    action: "unquarantine",
    scope: "member",
    permission: "security.lockdown",
    botPermission: "moderation.timeout",
    label: "Quarantine lifted",
    reversible: false,
    autoModAllowed: false,
    countsTowardsThreshold: false,
    requiresModerationEnabled: false,
  },
};

/** @returns the definition of `action`, or `undefined` when unknown. */
export function moderationActionDefinition(action: string): ModerationActionDefinition | undefined {
  return isModerationAction(action) ? MODERATION_ACTION_DEFINITIONS[action] : undefined;
}

/** Actions that the built-in `moderator` class does not grant (senior-only). */
export const SENIOR_ONLY_ACTIONS: readonly ModerationAction[] = ["ban", "unban", "softban"];

/**
 * Actions the `/note` command can write, so a moderator can park context on a
 * member without changing their state. Declared here because the action table is
 * the single source of truth for "what moderation can record".
 */
export const NOTE_ONLY_ACTIONS: readonly ModerationAction[] = ["note"];

/** Bounds enforced by every command, so no caller can bypass them. */
export const MODERATION_LIMITS = {
  /**
   * Discord's own maximum for a timeout.
   *
   * 28 days is the documented limit, but Discord rejects a
   * `communication_disabled_until` that lands *on* the boundary, so the maximum
   * this bot accepts is one minute short of it. A caller passing exactly 28 days
   * used to fail with `INVALID_COMMUNICATION_DISABLED_TIMESTAMP`; the choice list
   * and the guard now agree on a value Discord actually accepts.
   */
  maxTimeoutMs: 28 * 24 * 60 * 60 * 1_000 - 60_000,
  /** Minimum timeout accepted: anything shorter is noise, not a punishment. */
  minTimeoutMs: 5_000,
  /** Maximum mute duration: 365 days. */
  maxMuteMs: 365 * 24 * 60 * 60 * 1_000,
  /** Minimum mute duration. */
  minMuteMs: 60_000,
  /** `purge` bounds. Discord refuses bulk deletes above 100 messages. */
  minPurgeCount: 1,
  maxPurgeCount: 100,
  /** Messages older than this cannot be bulk-deleted by Discord. */
  purgeMaxAgeMs: 14 * 24 * 60 * 60 * 1_000,
  /** Hard cap on how many entries `/history` renders. */
  maxHistoryEntries: 100,
  /** Default page size of `/history` when no limit is given. */
  defaultHistoryLimit: 25,
  /** Maximum length of a stored reason. */
  maxReasonLength: 500,
} as const;

export type ModerationBotPermission =
  | "moderation.warn"
  | "moderation.timeout"
  | "moderation.kick"
  | "moderation.ban"
  | "moderation.purge";

/** Static description of one action. */
export interface ModerationActionDefinition {
  readonly action: ModerationAction;
  readonly scope: ModerationScope;
  /** Granular permission required to perform it (`PermissionRequest.custom`). */
  readonly permission: Permission;
  /** Discord permission the *member* must hold (resolved through the catalog). */
  readonly botPermission: ModerationBotPermission;
  /** Human-readable label, used in history and log output. */
  readonly label: string;
  /** Whether the action can be undone by a later action. */
  readonly reversible: boolean;
  /** Whether an automated actor (automod, AI) may ever trigger it. */
  readonly autoModAllowed: boolean;
  /**
   * Whether the action is subject to `moderation.warnThreshold`.
   *
   * Only `warn` is: the threshold triggers an *automatic* punishment once a
   * member accumulates warnings, and counting the automated punishment itself
   * would let one bad day escalate a member forever.
   */
  readonly countsTowardsThreshold: boolean;
  /**
   * Whether the action is refused when the guild has `moderation.enabled =
   * false`. Pardons (`unban`, `unmute`, ...) stay available, so a server that
   * turns moderation off can still be unblocked.
   */
  readonly requiresModerationEnabled: boolean;
}
