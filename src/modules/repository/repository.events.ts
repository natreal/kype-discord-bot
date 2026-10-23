/**
 * Turns one refresh into the events worth announcing.
 *
 * Pure on purpose: this is the part with all the judgement (what counts as news,
 * what is noise, what is a regression) and none of the I/O, so it is tested as a
 * function rather than through Discord or a database.
 *
 * The rules, and why each exists:
 *
 * - **Implementation progress is reported as a delta, not a level.** "+12 functions,
 *   47.39% → 47.49%" is news; "47.49%" every hour is not. A decrease is reported
 *   too: the project does revert functions, and hiding that would make the bot's
 *   history disagree with the project's own badge.
 * - **A commit is a headline only when it is new.** The repository merges several
 *   times an hour, so new commits are summarized as up to three subjects plus a
 *   count rather than one line per commit.
 * - **A merge is a transition.** A pull request already merged before the watch
 *   existed is never announced, which is why the store reports transitions.
 */
import type { ProgressEvent, RepositoryReading } from "../../services/anyps5/repository.types.js";
import { roundPercent } from "../../services/anyps5/progress.js";
import type { SnapshotRecord } from "./repository.types.js";

/** How many commit subjects are quoted by name when several arrived at once. */
const COMMIT_HEADLINES = 3;
/** A subject longer than this is shortened; a Discord line must stay scannable. */
const SUBJECT_LIMIT = 90;

/**
 * @param reading the freshly fetched state.
 * @param previous the last stored snapshot, or `null` for a baseline.
 * @param newCommitShas SHAs `upsertCommits` reported as new.
 * @param pulls `upsertPullRequests`' created/merged split.
 * @returns the events to announce, in the order they should be read.
 */
export function deriveEvents(
  reading: RepositoryReading,
  previous: SnapshotRecord | null,
  newCommitShas: readonly string[],
  pulls: { readonly created: readonly number[]; readonly merged: readonly number[] },
): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const progress = reading.progress;

  if (progress !== null) {
    const libraries = deltaEvent({
      kind: "libraries",
      label: "System libraries",
      unit: "functions",
      now: progress.libraries.percent,
      before: previous?.state.libraryPercent ?? null,
      done: progress.libraries.done,
      total: progress.libraries.total,
    });
    if (libraries !== null) {
      events.push(libraries);
    }

    const shaders = deltaEvent({
      kind: "shaders",
      label: "GPU shader instructions",
      unit: "instructions",
      now: progress.shaders.percent,
      before: previous?.state.shaderPercent ?? null,
      done: progress.shaders.done,
      total: progress.shaders.total,
    });
    if (shaders !== null) {
      events.push(shaders);
    }
  }

  const commitEvent = describeCommits(reading, newCommitShas);
  if (commitEvent !== null) {
    events.push(commitEvent);
  }

  for (const pull of pullEvents(reading, pulls)) {
    events.push(pull);
  }

  const stars = counterEvent("stars", "★ Stars", reading.facts.stars, previous?.state.stars ?? null);
  if (stars !== null) {
    events.push(stars);
  }
  const forks = counterEvent("forks", "Forks", reading.facts.forks, previous?.state.forks ?? null);
  if (forks !== null) {
    events.push(forks);
  }

  return events;
}

/** Builds a percentage-delta event, or `null` when nothing moved. */
function deltaEvent(input: {
  readonly kind: string;
  readonly label: string;
  readonly unit: string;
  readonly now: number;
  readonly before: number | null;
  readonly done: number;
  readonly total: number;
}): ProgressEvent | null {
  if (input.before === null) {
    return null;
  }
  const delta = roundPercent(input.now - input.before);
  if (delta === 0) {
    return null;
  }
  const moved = Math.round((delta / 100) * input.total);
  const movedText = moved === 0 ? "" : ` (${moved > 0 ? "+" : ""}${moved} ${input.unit})`;
  return {
    kind: input.kind,
    // The count is part of the key as well as the percentage: reaching 47.39% twice
    // (a revert, then a re-implementation) is a genuinely new event.
    key: `${input.kind}:${input.done}/${input.total}`,
    text: `${delta > 0 ? "📈" : "📉"} **${input.label}**: ${input.before}% → ${input.now}%${movedText} — ${input.done}/${input.total}`,
  };
}

/** Builds the pull-request events: merges first, then openings. */
function pullEvents(
  reading: RepositoryReading,
  pulls: { readonly created: readonly number[]; readonly merged: readonly number[] },
): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  const merged = new Set(pulls.merged);

  for (const number of pulls.merged) {
    const pull = reading.pullRequests.find((candidate) => candidate.number === number);
    if (pull !== undefined) {
      events.push({
        kind: "pull-request",
        key: `pull-request:${number}:merged`,
        text: `**Merged** PR #${number} — ${truncate(pull.title, SUBJECT_LIMIT)}${by(pull.author)}`,
      });
    }
  }

  for (const number of pulls.created) {
    // A merge already produced a line for this pull request; announcing both would
    // describe one change twice.
    const pull = merged.has(number)
      ? undefined
      : reading.pullRequests.find((candidate) => candidate.number === number);
    if (pull !== undefined) {
      events.push({
        kind: "pull-request",
        key: `pull-request:${number}:opened`,
        text: `**Opened** PR #${number} — ${truncate(pull.title, SUBJECT_LIMIT)}${by(pull.author)}`,
      });
    }
  }

  return events;
}

/** @returns ` (by name)`, or nothing when the author is unknown. */
function by(author: string | null): string {
  return author === null ? "" : ` (by ${author})`;
}

/** Summarizes newly seen commits, or `null` when none are new. */
function describeCommits(
  reading: RepositoryReading,
  newShas: readonly string[],
): ProgressEvent | null {
  if (newShas.length === 0) {
    return null;
  }
  const fresh = reading.commits.filter((commit) => newShas.includes(commit.sha));
  if (fresh.length === 0) {
    // The store reported commits this reading no longer holds (the window rolled
    // past them between the two calls), so the count is all that can be said.
    return {
      kind: "commits",
      key: `commits:${[...newShas].sort().join(",")}`,
      text: `${newShas.length} new commit${newShas.length === 1 ? "" : "s"}`,
    };
  }

  const head = fresh.slice(0, COMMIT_HEADLINES);
  const lines = head.map(
    (commit) => `\`${commit.sha.slice(0, 7)}\` ${truncate(commit.message, SUBJECT_LIMIT)}`,
  );
  const more = fresh.length - head.length;
  if (more > 0) {
    lines.push(`…and ${more} more`);
  }
  return {
    kind: "commits",
    key: `commits:${fresh.map((commit) => commit.sha).join(",")}`,
    text: lines.join("\n"),
  };
}

/** Builds a "★ Stars: 47,115 → 47,118 (+3)" event, or `null` when unchanged. */
function counterEvent(
  kind: string,
  label: string,
  now: number,
  before: number | null,
): ProgressEvent | null {
  if (before === null || now === before) {
    return null;
  }
  const delta = now - before;
  return {
    kind,
    key: `${kind}:${now}`,
    text: `**${label}**: ${formatCount(before)} → ${formatCount(now)} (${delta > 0 ? "+" : ""}${delta})`,
  };
}

/** Groups digits for readability (`47118` → `47,118`). */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Shortens a subject at a word boundary where possible. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}…`;
}

