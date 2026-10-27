/**
 * What the monitor knows, and what it derives from what it knows.
 *
 * The split matters: {@link MonitorState} is only ever set by the feed, and every
 * number a frame shows that is not in the state is computed here, once, by a pure
 * function. That keeps the arithmetic testable without a terminal, and it keeps the
 * renderer honest — a frame that needs a new number has to name it as a derived
 * value instead of quietly doing sums in the middle of a layout.
 *
 * The trend maths is the same maths `/github` uses: {@link summarize} and
 * {@link daysToCompletion} are imported, not re-implemented, so "the pace" means one
 * thing in the bot and in this window. The one unit that changes is time: an hourly
 * snapshot is read in points per *day*, while a window polled every fifteen seconds
 * reads better in points per *hour*, so the daily figure is divided rather than
 * recomputed.
 */
import {
  daysToCompletion,
  summarize,
  type SeriesPoint,
} from "../modules/repository/repository-analytics.js";
import type { AnyPs5Progress } from "../services/anyps5/progress.js";
import type { GitHubLiveFacts } from "../services/github/live-feed.js";

/** One section's counters, as the monitor compares them. */
export interface SectionReading {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** One library group, flattened to the columns the monitor draws. */
export interface GroupReading {
  readonly name: string;
  readonly label: string;
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** One `progress.json` reading, with when it was taken. */
export interface MonitorSample {
  readonly at: Date;
  readonly libraries: SectionReading;
  readonly shaders: SectionReading;
  readonly groups: readonly GroupReading[];
}

/** How loudly an event log line is drawn. */
export type MonitorLevel = "info" | "good" | "warn" | "bad";

/** One line of the monitor's own history: what it read, and when. */
export interface MonitorEvent {
  readonly at: Date;
  readonly level: MonitorLevel;
  readonly text: string;
}

/**
 * Everything the feed collected, and nothing derived.
 *
 * `live` is the tri-state `/github` already uses and for the same reason: `undefined`
 * means nobody asked GitHub, `null` means we asked and it did not answer, and an
 * object means *this* is what it says. Collapsing the first two would make a monitor
 * whose live half is broken look exactly like one that never had a live half.
 */
export interface MonitorState {
  readonly repository: string;
  readonly startedAt: Date;
  readonly intervalMs: number;
  readonly paused: boolean;
  /** Whether the GitHub client has a token: 5,000 calls an hour, or 60. */
  readonly authenticated: boolean;
  /** Whether a poll is in flight, so the frame can say so instead of looking stuck. */
  readonly polling: boolean;
  readonly nextPollAt: Date;
  readonly pollCount: number;
  readonly failureCount: number;
  readonly progress: MonitorSample | null;
  readonly progressFailure: string | null;
  readonly progressCommit: string | null;
  /** Oldest first, capped by the feed. */
  readonly samples: readonly MonitorSample[];
  readonly live: GitHubLiveFacts | null | undefined;
  readonly liveFailure: string | null;
  /** Oldest first, capped by the feed. */
  readonly events: readonly MonitorEvent[];
}

/** A section's movement: the change, its rate in the unit a live view reads in, and an estimate. */
export interface MonitorPace {
  /** Percentage points per hour over the samples held; `null` below two samples. */
  readonly perHour: number | null;
  /** Days to 100% at that pace; `null` when the pace is not positive. */
  readonly etaDays: number | null;
  /** Percentage points gained since the first held sample; `null` below two samples. */
  readonly change: number | null;
}

/** The last two readings, which is what "just now" means in this window. */
export interface MonitorStep {
  readonly seconds: number;
  readonly libraryChange: number;
  readonly shaderChange: number;
  readonly librariesDone: number;
  readonly shadersDone: number;
}

/** A group that moved since the first held sample. */
export interface MonitorMovement {
  readonly name: string;
  readonly label: string;
  readonly percent: number;
  readonly change: number;
}

/** The state plus everything the frame derives from it. */
export interface MonitorModel extends MonitorState {
  readonly now: Date;
  readonly uptimeMs: number;
  readonly pace: { readonly libraries: MonitorPace; readonly shaders: MonitorPace };
  readonly lastStep: MonitorStep | null;
  /** Groups with the least of their own work done, least first. */
  readonly groups: readonly GroupReading[];
  /** Groups that gained the most since the first held sample. */
  readonly movers: readonly MonitorMovement[];
}

/** @returns a published snapshot as a monitor sample, timestamped `at`. */
export function sampleOf(progress: AnyPs5Progress, at: Date): MonitorSample {
  return {
    at,
    libraries: {
      done: progress.libraries.done,
      total: progress.libraries.total,
      percent: progress.libraries.percent,
    },
    shaders: {
      done: progress.shaders.done,
      total: progress.shaders.total,
      percent: progress.shaders.percent,
    },
    groups: progress.libraries.groups.map((group) => ({
      name: group.name,
      label: group.label,
      done: group.done,
      total: group.total,
      percent: group.percent,
    })),
  };
}

/** @returns the model for one frame, derived from `state` at `now`. */
export function buildModel(state: MonitorState, now: Date): MonitorModel {
  return {
    ...state,
    now,
    uptimeMs: Math.max(0, now.getTime() - state.startedAt.getTime()),
    pace: {
      libraries: paceOf(pointsOf(state.samples, (sample) => sample.libraries.percent)),
      shaders: paceOf(pointsOf(state.samples, (sample) => sample.shaders.percent)),
    },
    lastStep: lastStepOf(state.samples),
    groups: lowestGroups(state.progress, 12),
    movers: movesSince(state.samples, 6),
  };
}

/**
 * @returns a section's pace over the held samples.
 *
 * A flat or falling series has no honest estimate, so `etaDays` is `null` rather
 * than `Infinity` or a negative — the frame says "no finish line at this pace"
 * instead of printing a number that cannot happen.
 */
export function paceOf(points: readonly SeriesPoint[]): MonitorPace {
  const summary = summarize(points);
  if (summary === null) {
    return { perHour: null, etaDays: null, change: null };
  }
  return {
    perHour: summary.perDay === null ? null : Math.round((summary.perDay / 24) * 100) / 100,
    etaDays: daysToCompletion(summary),
    change: points.length < 2 ? null : summary.change,
  };
}

/** @returns the change between the last two samples, or `null` with fewer than two. */
export function lastStepOf(samples: readonly MonitorSample[]): MonitorStep | null {
  const last = samples.at(-1);
  const before = samples.at(-2);
  if (last === undefined || before === undefined) {
    return null;
  }
  const seconds = Math.round((last.at.getTime() - before.at.getTime()) / 1_000);
  return {
    seconds: Math.max(0, seconds),
    libraryChange: round2(last.libraries.percent - before.libraries.percent),
    shaderChange: round2(last.shaders.percent - before.shaders.percent),
    librariesDone: last.libraries.done - before.libraries.done,
    shadersDone: last.shaders.done - before.shaders.done,
  };
}

/**
 * @returns the groups with the least of their own work done.
 *
 * Least-done rather than biggest: on a porting project the interesting list is what
 * has *not* started, because that is where the next weeks of work are. Ties break on
 * size, so the largest untouched library leads the list.
 */
export function lowestGroups(
  sample: MonitorSample | null,
  limit: number,
): readonly GroupReading[] {
  if (sample === null) {
    return [];
  }
  return [...sample.groups]
    .filter((group) => group.total > 0)
    .sort((left, right) => left.percent - right.percent || right.total - left.total)
    .slice(0, Math.max(0, limit));
}

/**
 * @returns the groups whose percentage grew the most between the first and last
 * sample.
 *
 * A group can appear or disappear between samples (the upstream scan changes what it
 * covers), so the comparison is by name and only on names present in both. That is
 * the same pairing `/github` uses to keep "new" from being read as "moved".
 */
export function movesSince(
  samples: readonly MonitorSample[],
  limit: number,
): readonly MonitorMovement[] {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || first === last) {
    return [];
  }
  const before = new Map(first.groups.map((group) => [group.name, group.percent]));
  return last.groups
    .flatMap((group) => {
      const was = before.get(group.name);
      if (was === undefined) {
        return [];
      }
      const change = round2(group.percent - was);
      return change > 0
        ? [{ name: group.name, label: group.label, percent: group.percent, change }]
        : [];
    })
    .sort((left, right) => right.change - left.change)
    .slice(0, Math.max(0, limit));
}

/** @returns `samples` as a series of one value each, oldest first. */
function pointsOf(
  samples: readonly MonitorSample[],
  pick: (sample: MonitorSample) => number,
): SeriesPoint[] {
  return samples.map((sample) => ({ capturedAt: sample.at, value: pick(sample) }));
}

/** @returns `value` to two decimals, the precision the project publishes. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
