/**
 * Automod observation contract.
 *
 * A plain data record, deliberately free of discord.js: the message handler turns
 * a Discord message into an {@link AutomodObservation}, the evaluator judges it,
 * and the service acts on the verdict. A test can therefore build an observation
 * literal and assert the verdict, with no guild, client or clock involved.
 */
import type { AutomodRule } from "./automod-rules.js";

/** One message, as automod sees it. */
export interface AutomodMessageObservation {
  readonly kind: "message";
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly messageId: string;
  readonly authorId: string;
  /** Display handle, `null` when Discord did not send one (a partial payload). */
  readonly authorTag: string | null;
  /** True when the author is the guild's owner: automod never judges them. */
  readonly authorIsOwner: boolean;
  /** True when the author holds Discord `Administrator`. */
  readonly authorIsAdministrator: boolean;
  readonly botAuthor: boolean;
  /** Message text at the time of observation (edits are observed too). */
  readonly content: string;
  /** Channel mentions in this one message. */
  readonly mentionCount: number;
  /** Total character length of the custom emojis in the message. */
  readonly emojiCount: number;
  /** Unix milliseconds, from the message itself so a replay stays deterministic. */
  readonly timestampMs: number;
}

/** One reaction, as automod sees it. */
export interface AutomodReactionObservation {
  readonly kind: "reaction";
  readonly guildId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly messageId: string;
  readonly authorId: string;
  /** Display handle, `null` when Discord sent a partial user payload. */
  readonly authorTag: string | null;
  readonly authorIsOwner: boolean;
  readonly authorIsAdministrator: boolean;
  readonly botAuthor: boolean;
  readonly emoji: string;
  readonly timestampMs: number;
}

export type AutomodObservation = AutomodMessageObservation | AutomodReactionObservation;

/** Why one rule fired. */
export interface AutomodMatch {
  readonly rule: AutomodRule;
  /** What was measured, e.g. `6 messages in 10s`. */
  readonly observed: string;
  /** The configured bound it crossed. */
  readonly threshold: number;
  /** Short, user-safe reason recorded on the case and the log line. */
  readonly detail: string;
}

/** The verdict of one evaluation. */
export interface AutomodVerdict {
  /** True when no rule fired, or when the author is exempt. */
  readonly clean: boolean;
  /** The rule matches, in rule-table order, when `clean` is false. */
  readonly matches: readonly AutomodMatch[];
  /** Set when the author was exempt, explaining why nothing was judged. */
  readonly exemptReason: "bot" | "owner" | "administrator" | null;
}
