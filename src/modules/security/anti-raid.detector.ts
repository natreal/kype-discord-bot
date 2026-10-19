/**
 * Anti-raid detection.
 *
 * A raid is not "many joins"; it is "joins faster than a server can react". The
 * detector therefore answers a rate question over a sliding window, and adds two
 * independent observations that a human moderator would also make:
 *
 * - **account age.** A burst of week-old accounts is a raid; a burst of
 *   three-year-old accounts is a giveaway, and punishing them would be a
 *   disaster. The two are told apart *before* anyone is restricted.
 * - **suspicious usernames.** `discord_nitro_claim_4412` in a burst is a raid
 *   signature, and it is cheap to spot.
 *
 * The detector is pure: it takes the timestamps it has seen and the join it is
 * judging, and returns a verdict. The *history* lives in the service, which is
 * where the decision to lock down belongs.
 */
import type { GuildConfig } from "../../services/config/index.js";

/** One join, as the detector sees it. */
export interface RaidJoinObservation {
  readonly guildId: string;
  readonly userId: string;
  readonly userTag: string;
  /** True when the account was created less than `minAccountAgeDays` ago. */
  readonly isNewAccount: boolean;
  /** Account creation, in Unix milliseconds, for the log line. */
  readonly accountCreatedMs: number;
  /** True when the username matches a known raid/advertising pattern. */
  readonly suspiciousUsername: boolean;
  /** Unix milliseconds of the join itself, injected so a test controls the clock. */
  readonly joinedAtMs: number;
}

/** What the detector concluded about one burst. */
export interface RaidVerdict {
  /** True when the join rate crossed the configured threshold. */
  readonly burst: boolean;
  /** Joins observed inside the window, including the one being judged. */
  readonly joinsInWindow: number;
  /** Seconds the window covers. */
  readonly windowSeconds: number;
  /** Distinct accounts seen inside the window. */
  readonly suspectedAccountIds: readonly string[];
  /** Accounts inside the window that are also new accounts. */
  readonly newAccountIds: readonly string[];
  /** Accounts inside the window with a suspicious username. */
  readonly suspiciousNameIds: readonly string[];
  /** True when at least one member of the burst is worth restricting. */
  readonly likelyRaid: boolean;
  /** Why it is or is not a raid, for the security log. */
  readonly detail: string;
}

/**
 * Username fragments that show up in advertising/raid waves.
 *
 * Separators are `[\s._-]*` rather than `\s*`: raiders write `free_nitro_claim`,
 * `free-nitro-claim` and `free nitro claim`, and a pattern that only recognises the
 * last one catches almost nobody.
 */
const SUSPICIOUS_NAME_PATTERNS = [
  /(?:free|cheap|\d+%)[\s._-]*(?:nitro|robux|vbucks|gift|giveaway)/i,
  /nitro[\s._-]*(?:gift|claim|drop)/i,
  /(?:steam|discord|twitter)[\s._-]?(?:gift|free|promo)/i,
  /^(?:admin|moderator|staff|official)[_.-]/i,
  /(?:join|click|visit)[_.-]?(?:now|l?ink)/i,
];

/** @returns true when `username` looks like raid or advertising material. */
export function isSuspiciousUsername(username: string): boolean {
  return SUSPICIOUS_NAME_PATTERNS.some((pattern) => pattern.test(username));
}

/** @returns true when an account is younger than `minAccountAgeDays`. */
export function isNewAccount(
  accountCreatedMs: number,
  nowMs: number,
  minAccountAgeDays: number,
): boolean {
  if (minAccountAgeDays === 0) {
    return false;
  }
  const ageDays = (nowMs - accountCreatedMs) / (24 * 60 * 60 * 1_000);
  return ageDays < minAccountAgeDays;
}

/**
 * Judges a burst.
 *
 * @param recent join timestamps already seen **inside** the window, oldest first,
 *   excluding the join being judged
 * @param observation the join being judged
 * @param config the guild's `antiRaid` section
 * @returns the verdict; `burst` alone is not enough to declare a raid
 */
export function detectRaid(
  recent: readonly RaidJoinObservation[],
  observation: RaidJoinObservation,
  config: GuildConfig["security"]["antiRaid"],
): RaidVerdict {
  const windowSeconds = config.windowSeconds;
  const joins = [...recent, observation];
  const joinsInWindow = joins.length;

  const newAccountIds = joins.filter((join) => join.isNewAccount).map((join) => join.userId);
  const suspiciousNameIds = joins
    .filter((join) => join.suspiciousUsername)
    .map((join) => join.userId);

  const burst = joinsInWindow >= config.burstThreshold || joinsInWindow >= config.joinsPerMinute;

  // A burst is only treated as a raid when it carries at least one raid signature:
  // a wave of new accounts, or a wave of advertising names. Two hundred established
  // accounts joining a giveaway is a viral moment, not an attack, and locking down
  // for it would be the single most damaging thing this module could do.
  const likelyRaid = burst && (newAccountIds.length > 0 || suspiciousNameIds.length > 0);

  const detail = !burst
    ? `${joinsInWindow} join(s) in ${windowSeconds}s, below the threshold of ${Math.min(config.burstThreshold, config.joinsPerMinute)}`
    : likelyRaid
      ? `${joinsInWindow} join(s) in ${windowSeconds}s, including ${newAccountIds.length} new account(s) and ${suspiciousNameIds.length} suspicious name(s)`
      : `${joinsInWindow} join(s) in ${windowSeconds}s, but no new accounts or suspicious names`;

  return {
    burst,
    joinsInWindow,
    windowSeconds,
    suspectedAccountIds: joins.map((join) => join.userId),
    newAccountIds,
    suspiciousNameIds,
    likelyRaid,
    detail,
  };
}
