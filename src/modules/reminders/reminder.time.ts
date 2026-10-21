/**
 * Duration parsing for reminders.
 *
 * `/reminder` accepts either a raw duration (`90m`, `1h30m`, `2 days`) or a
 * natural-language phrase (`in 2 hours`, `tomorrow 9am`). Both are parsed here, in
 * one place, so the command, the prompt for a missing duration and the tests all
 * agree on what a duration means.
 *
 * Two deliberate choices:
 *
 * - **Absolute times are resolved against a timezone the server configured**, not
 *   against the host's clock. A bot can run on a machine in another timezone from
 *   the server it serves, and "9am" must mean 9am for the members.
 * - **A bare number is rejected.** `30` is either half a minute or half an hour,
 *   and silently picking one produces a reminder that is wrong by 30x. The error
 *   says so instead.
 */

/** Bounds, exported so the command, the errors and the docs cannot drift. */
export const REMINDER_DURATION_LIMITS = {
  /** Below one minute a reminder is indistinguishable from a reply. */
  minSeconds: 60,
  /** Thirty days: anything longer is a calendar item, not a reminder. */
  maxSeconds: 30 * 24 * 60 * 60,
} as const;

/** Suffix units, in descending order so `2h30` reads as hours then minutes. */
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  w: 7 * 86_400,
  week: 7 * 86_400,
  weeks: 7 * 86_400,
  d: 86_400,
  day: 86_400,
  days: 86_400,
  h: 3_600,
  hr: 3_600,
  hrs: 3_600,
  hour: 3_600,
  hours: 3_600,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
};

/** A duration that could not be understood, phrased for a Discord user. */
export class DurationParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DurationParseError";
  }
}

/**
 * Parses a duration into a whole number of seconds.
 *
 * Accepts, in any order and combination: `1h30m`, `2 hours 15 min`, `90 m`,
 * `in 3 days`, `2j` (French for days). Returns `null` when the text contains no
 * duration at all, so the caller can decide whether that is an error (a command
 * value) or a prompt (a message that may only name an absolute time).
 *
 * @throws DurationParseError when the text *looks* like a duration but is
 * ambiguous (a bare number).
 */
export function parseDurationSeconds(raw: string): number | null {
  // French and English both show up in practice; normalising the full words keeps
  // the parser a single table instead of two. Single-letter units (`d`, `h`, `m`,
  // `j`) are left alone: they are already unambiguous inside a number-unit pair,
  // and rewriting every `s` would corrupt the surrounding sentence.
  const text = raw
    .toLowerCase()
    .replace(/\b(semaines?|sem)\b/g, "weeks")
    .replace(/\b(jours?|journ[ée]es?)\b/g, "days")
    .replace(/\b(heures?|hres?|hrs?)\b/g, "hours")
    .replace(/\b(minutes?|mins?|mn)\b/g, "minutes")
    .replace(/\b(secondes?|secs?)\b/g, "seconds")
    .replace(/[\s,]+/g, " ")
    .trim();

  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2] ?? "";
    const seconds = UNIT_SECONDS[unit];
    if (seconds === undefined) {
      throw new DurationParseError(
        `I don't know the unit "${unit}". Use minutes, hours, days or weeks (e.g. \`1h30m\`).`,
      );
    }
    total += amount * seconds;
    matched = true;
  }

  if (!matched) {
    // A bare number is the one input that cannot be guessed safely.
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      throw new DurationParseError(
        "Please add a unit: `30m` for thirty minutes, `30` alone is ambiguous.",
      );
    }
    return null;
  }

  return Math.round(total);
}

/** @returns the duration clamped and validated into the supported range. */
export function clampDurationSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < REMINDER_DURATION_LIMITS.minSeconds) {
    throw new DurationParseError(
      `A reminder must be at least ${REMINDER_DURATION_LIMITS.minSeconds / 60} minute(s) away.`,
    );
  }
  if (seconds > REMINDER_DURATION_LIMITS.maxSeconds) {
    throw new DurationParseError(
      `A reminder can be at most ${REMINDER_DURATION_LIMITS.maxSeconds / 86_400} days away.`,
    );
  }
  return Math.round(seconds);
}
