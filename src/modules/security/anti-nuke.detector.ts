/**
 * Anti-nuke detection.
 *
 * A nuke is a *person* doing many destructive things quickly: deleting every
 * channel, creating a hundred roles, mass-banning, or installing a webhook to keep
 * the loot after being removed. So the unit of detection is a `(actor, destructive
 * action)` pair counted inside a short window, exactly like a rate limiter — which
 * is what this file is.
 *
 * Two decisions worth stating:
 *
 * 1. **Detection is pure.** `detectNuke()` takes the actions already seen and the
 *    action being judged. The clock is on the observation, so a test can reproduce
 *    a ten-second nuke in microseconds, and the threshold arithmetic can be proven
 *    without a Discord server.
 * 2. **The response is scoped to the actor, never to the action.** Removing
 *    permissions cannot undo a deleted channel; it can only stop the eleventh. The
 *    detector therefore reports a *decision*, and `AntiNukeService` acts on the
 *    actor — and never bans them, per the V5 brief, because an automated ban of a
 *    possibly-compromised administrator account is how a bad day becomes an outage.
 */
import { PermissionFlagsBits } from "discord.js";

import type { GuildConfig } from "../../services/config/index.js";

/** Kinds of destructive action the detector watches. */
export const NUKE_ACTION_KINDS = [
  "channel-delete",
  "channel-create",
  "role-delete",
  "role-create",
  "permission-update",
  "member-ban",
  "member-kick",
  "webhook-create",
  "bot-add",
] as const;

export type NukeActionKind = (typeof NUKE_ACTION_KINDS)[number];

/** @returns true when `value` is a watched destructive action. */
export function isNukeActionKind(value: unknown): value is NukeActionKind {
  return typeof value === "string" && (NUKE_ACTION_KINDS as readonly string[]).includes(value);
}

/** How dangerous one action is. Weighting lets a `channel-delete` count double. */
export const NUKE_ACTION_WEIGHT: Readonly<Record<NukeActionKind, number>> = {
  "channel-delete": 2,
  "channel-create": 1,
  "role-delete": 2,
  "role-create": 1,
  "permission-update": 1,
  "member-ban": 3,
  "member-kick": 2,
  "webhook-create": 2,
  "bot-add": 3,
};

/** Human labels used by the security log and `/security status`. */
export const NUKE_ACTION_LABEL: Readonly<Record<NukeActionKind, string>> = {
  "channel-delete": "deleted channels",
  "channel-create": "created channels",
  "role-delete": "deleted roles",
  "role-create": "created roles",
  "permission-update": "changed permissions",
  "member-ban": "banned members",
  "member-kick": "kicked members",
  "webhook-create": "created webhooks",
  "bot-add": "added bots",
};

/** One watched action, as the detector sees it. */
export interface NukeActionObservation {
  readonly guildId: string;
  readonly kind: NukeActionKind;
  /** The account that performed it, as reported by Discord's audit log. */
  readonly actorId: string;
  readonly actorTag: string | null;
  /** The object acted upon (`channel:1234`, `role:5678`, ...). */
  readonly targetId: string | null;
  readonly targetName: string | null;
  /** Unix milliseconds, injected so a test controls the clock. */
  readonly atMs: number;
}

/** What the detector concluded. */
export interface NukeVerdict {
  readonly detected: boolean;
  /** Sum of the weights of the actions inside the window. */
  readonly weight: number;
  /** Number of actions inside the window, including the one being judged. */
  readonly actions: number;
  readonly windowSeconds: number;
  readonly threshold: number;
  /** Per-kind tally inside the window, for the log line. */
  readonly breakdown: Readonly<Partial<Record<NukeActionKind, number>>>;
  readonly detail: string;
}

/**
 * Judges one action.
 *
 * @param recent actions already seen inside the window, excluding this one
 * @param observation the action being judged
 * @param config the guild's `antiNuke` section
 */
export function detectNuke(
  recent: readonly NukeActionObservation[],
  observation: NukeActionObservation,
  config: GuildConfig["security"]["antiNuke"],
): NukeVerdict {
  const windowSeconds = config.windowSeconds;
  const all = [...recent, observation];

  const breakdown: Partial<Record<NukeActionKind, number>> = {};
  let weight = 0;
  for (const action of all) {
    breakdown[action.kind] = (breakdown[action.kind] ?? 0) + 1;
    weight += NUKE_ACTION_WEIGHT[action.kind];
  }

  // A single ban is not a nuke, a hundred channel deletions are: the threshold is
  // compared against the *weight*, so a member-ban wave trips it three times
  // faster than a channel-creation wave. `actions` is reported separately for the
  // log line, where "9 actions" is more legible than "weight 14".
  const detected = weight >= config.actionThreshold;
  const detail = detected
    ? `${all.length} destructive action(s) in ${windowSeconds}s (weight ${weight} ≥ ${config.actionThreshold}): ${describeBreakdown(breakdown)}`
    : `${all.length} destructive action(s) in ${windowSeconds}s, weight ${weight} below the threshold of ${config.actionThreshold}`;

  return {
    detected,
    weight,
    actions: all.length,
    windowSeconds,
    threshold: config.actionThreshold,
    breakdown,
    detail,
  };
}

/** @returns the `channel-delete`-style tally as a readable line. */
export function describeBreakdown(
  breakdown: Readonly<Partial<Record<NukeActionKind, number>>>,
): string {
  return Object.entries(breakdown)
    .map(([kind, count]) => `${count}× ${NUKE_ACTION_LABEL[kind as NukeActionKind] ?? kind}`)
    .join(", ");
}

/**
 * @returns the Discord permissions an account must hold for a nuke to be possible.
 *
 * Used by `/security status` to name the exact capability that has to be taken
 * away, and by the diagnostics check that warns an operator *before* the nuke
 * rather than after it.
 */
export const NUKE_RELEVANT_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuild,
];

/**
 * @returns true when an account is exempt from anti-nuke.
 *
 * Three exemptions, each with a reason: the guild owner (who is the authority
 * anti-nuke would escalate to), the bot itself (whose own cleanup would otherwise
 * look like a nuke), and anything the operator explicitly whitelisted. Deliberately
 * *not* included: administrators. A compromised administrator account is the most
 * likely nuke in practice, so it is exactly what this module must be able to stop.
 */
export function isWhitelisted(
  actorId: string,
  options: {
    readonly ownerId: string;
    readonly botId: string;
    readonly whitelistUserIds: readonly string[];
  },
): boolean {
  return (
    actorId === options.ownerId ||
    actorId === options.botId ||
    options.whitelistUserIds.includes(actorId)
  );
}
