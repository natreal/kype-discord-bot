/**
 * The figures behind `/github report`.
 *
 * Everything here is a pure function of one window — the snapshots and pull requests
 * that fall inside it — so a report can be asserted on without a database, a clock or
 * a Discord client. The rendering lives in `github-report.view.ts`.
 *
 * Three rules the functions below follow, because a report is read as fact:
 *
 * 1. **A missing number is `null`, never zero.** A rate nobody measured and a rate that
 *    was zero are different findings, and only one of them means "nothing happened".
 * 2. **Events are placed by when they happened**, not by when the bot noticed them: a
 *    commit is bucketed by its `committedAt`, a merge by its `mergedAt`. That is what
 *    makes a 4-hour report meaningful with a 15-minute poll — the data is finer than
 *    the cadence.
 * 3. **Every rate carries its coverage.** A figure per day is only worth reading next to
 *    how much of the window the monitor actually recorded.
 */
import type { RepositoryPullRequest } from "../../services/anyps5/repository.types.js";
import type { SnapshotRecord } from "./repository.types.js";
import {
  libraryMovement,
  readImplementation,
  type ImplementationReading,
  type ImplementationSeries,
  type LibraryMovementRow,
} from "./repository-analytics.js";

/** A reading that carries a percentage, which is what every series below needs. */
export type UsableReading = ImplementationReading & {
  readonly libraries: ImplementationSeries;
};

/** The ranges `/github report` offers. */
export const REPORT_RANGES = [
  { id: "4h", label: "4 hours", hours: 4 },
  { id: "12h", label: "12 hours", hours: 12 },
  { id: "1d", label: "1 day", hours: 24 },
  { id: "3d", label: "3 days", hours: 72 },
  { id: "7d", label: "7 days", hours: 168 },
] as const;

/** A range identifier, as the subcommand's choice list carries it. */
export type ReportRangeId = (typeof REPORT_RANGES)[number]["id"];

/** Ranges at or below this many hours are bucketed hourly; longer ones six-hourly. */
export const HOURLY_RANGE_LIMIT_HOURS = 24;

/** @returns the range a `/github report` choice names, defaulting to one day. */
export function reportRange(id: string): (typeof REPORT_RANGES)[number] {
  return REPORT_RANGES.find((range) => range.id === id) ?? REPORT_RANGES[2];
}

/**
 * @returns the window a report covers, ending now.
 *
 * Ends at the moment it is run rather than at the newest snapshot: a monitor that has
 * been down for three hours then reports three empty hours, which is the truth, instead
 * of shrinking the window to hide the gap.
 */
export function reportWindowFor(id: string, now: Date): { readonly from: Date; readonly to: Date } {
  const range = reportRange(id);
  return { from: new Date(now.getTime() - range.hours * 3_600_000), to: now };
}

const HOUR_MS = 3_600_000;

/** @returns `value` rounded to two decimals. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** @returns the median of `values` rounded, or `null` for none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : round2(sorted[middle] ?? 0);
}

/** @returns the mean of `values` rounded, or `null` for none. */
function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** @returns the bucket size a window of `hours` deserves. */
export function bucketHoursFor(hours: number): number {
  return hours <= HOURLY_RANGE_LIMIT_HOURS ? 1 : 6;
}

/**
 * @returns the bucket start times for a window, from `from` up to (not past) `to`.
 *
 * A list of starts rather than of `[start, end)` pairs: a bucket's end is the next
 * bucket's start, except for the last one, which is clipped to `to` so a report run at
 * 14:37 does not pretend to cover a full hour it has not seen yet.
 */
export function bucketEdges(from: Date, to: Date, hours: number): Date[] {
  const edges: Date[] = [];
  for (let edge = from.getTime(); edge < to.getTime(); edge += hours * HOUR_MS) {
    edges.push(new Date(edge));
  }
  return edges.length === 0 ? [from] : edges;
}

/** One bucket of the report's time series. */
export interface ReportBucket {
  /** Start of the bucket. */
  readonly startsAt: Date;
  /** Hours the bucket covers, so a partial last bucket is visible as such. */
  readonly hours: number;
  /** Pull requests created inside it. */
  readonly opened: number;
  /** Pull requests merged inside it. */
  readonly merged: number;
  /** Pull requests closed without merging inside it. */
  readonly closedUnmerged: number;
  /**
   * The library percentage as of the bucket's end, or `null` when no reading landed in
   * the bucket. `null` is drawn as a gap: an hour nobody measured is not 0%.
   */
  readonly libraryPercent: number | null;
  /** Implemented functions as of the bucket's end, carried forward from the last reading. */
  readonly librariesDone: number | null;
}

/** How many pull requests arrived and left in the window, and how fast. */
export interface PullRequestStats {
  readonly opened: number;
  readonly merged: number;
  readonly closedUnmerged: number;
  /** Of those opened in the window, how many are still open. */
  readonly stillOpen: number;
  /** Creation-to-merge time in hours, averaged over merges inside the window. */
  readonly meanMergeHours: number | null;
  /** The same as a median, so one ancient pull request does not move it. */
  readonly medianMergeHours: number | null;
  /** Merges that finished in the window, per day. */
  readonly mergesPerDay: number | null;
  /** Openings that arrived in the window, per day. */
  readonly opensPerDay: number | null;
  /** `merged / (merged + closedUnmerged)`; `null` when nothing was resolved. */
  readonly mergeRate: number | null;
  /** How many of the window's pull requests were filed as drafts. */
  readonly drafts: number;
}

/** Activity of the code itself. */
export interface CommitStats {
  readonly count: number;
  /** Distinct authors, largest first. */
  readonly authors: readonly { readonly name: string; readonly count: number }[];
  /** Commits per day over the window. */
  readonly perDay: number | null;
  /** The newest commit in the window, or `null` when none is stored. */
  readonly latest: {
    readonly message: string;
    readonly at: Date;
    readonly author: string | null;
  } | null;
}

/** The implementation percentage's own trend over the window. */
export interface ProgressStats {
  readonly first: { readonly percent: number; readonly at: Date } | null;
  readonly last: { readonly percent: number; readonly at: Date } | null;
  readonly percentDelta: number | null;
  /** Percentage points per day over the window. `null` with fewer than two readings. */
  readonly perDay: number | null;
  /** Functions implemented between the first and last reading. */
  readonly doneDelta: number | null;
  /** Functions newly discovered between them. */
  readonly totalDelta: number | null;
  /** Readings that carry no percentage, so they could not join the series. */
  readonly unreadable: number;
  /** The newest usable reading, for the headline. */
  readonly latest: UsableReading | null;
}

/** How much of the window the monitor actually recorded, which qualifies every rate. */
export interface Coverage {
  readonly snapshots: number;
  /** The refresh cadence inferred from the readings, in minutes. */
  readonly cadenceMinutes: number | null;
  /** Hours of the window with at least one snapshot. */
  readonly hoursCovered: number;
  readonly hoursTotal: number;
  /** `hoursCovered / hoursTotal`, `0` to `1`. */
  readonly share: number;
  /** The longest stretch with no snapshot, in hours. */
  readonly longestGapHours: number;
  /** Snapshots that recorded a failed endpoint. */
  readonly failed: number;
}

/** Everything one report states. */
export interface ReportStats {
  readonly range: (typeof REPORT_RANGES)[number];
  readonly from: Date;
  readonly to: Date;
  readonly buckets: readonly ReportBucket[];
  readonly pulls: PullRequestStats;
  readonly commits: CommitStats;
  readonly progress: ProgressStats;
  readonly coverage: Coverage;
  /** Libraries ordered by functions implemented over the window, most first. */
  readonly libraries: readonly LibraryMovementRow[];
}

/**
 * Builds every figure the report states.
 *
 * `commits` is passed separately because commits live in their own table, not inside a
 * snapshot: a report counts the commits GitHub dated inside the window, whatever the
 * poll happened to notice them in.
 */
export function buildReportStats(input: {
  readonly rangeId: string;
  readonly window: { readonly from: Date; readonly to: Date };
  readonly snapshots: readonly SnapshotRecord[];
  readonly pullRequests: readonly RepositoryPullRequest[];
  readonly commits: readonly {
    readonly at: Date;
    readonly author: string | null;
    readonly message: string;
  }[];
}): ReportStats {
  const range = reportRange(input.rangeId);
  const { from, to } = input.window;
  const ordered = [...input.snapshots].sort(
    (left, right) => left.capturedAt.getTime() - right.capturedAt.getTime(),
  );
  const hours = (to.getTime() - from.getTime()) / HOUR_MS;

  return {
    range,
    from,
    to,
    buckets: buildBuckets(
      ordered,
      input.pullRequests,
      from,
      to,
      bucketHoursFor(range.hours),
    ),
    pulls: pullStats(input.pullRequests, from, to),
    commits: commitStats(input.commits, from, to),
    progress: progressStats(ordered),
    coverage: coverageOf(ordered, from, to, hours),
    libraries: libraryMovement(ordered),
  };
}

/** @returns the implementation trend over the window. */
function progressStats(snapshots: readonly SnapshotRecord[]): ProgressStats {
  const readings = snapshots.map((snapshot) => readImplementation(snapshot));
  const usable = readings.filter(
    (reading): reading is UsableReading => reading.libraries !== null,
  );
  const first = usable[0] ?? null;
  // Two readings are needed for a change: with one, `first` and `last` are the same
  // point and the difference is a meaningless zero.
  const last = usable.length < 2 ? null : (usable.at(-1) ?? null);
  // Measured between the two readings the figures come from, not from the window's own
  // bounds: a report over a day with readings at 02:00 and 22:00 covers twenty hours.
  const elapsedDays =
    first === null || last === null || usable.length < 2
      ? null
      : (last.capturedAt.getTime() - first.capturedAt.getTime()) / 86_400_000;
  const change =
    first === null || last === null ? null : round2(last.libraries.percent - first.libraries.percent);

  return {
    first:
      first === null ? null : { percent: first.libraries.percent, at: first.capturedAt },
    last: last === null ? null : { percent: last.libraries.percent, at: last.capturedAt },
    percentDelta: change,
    perDay:
      change === null || elapsedDays === null || elapsedDays <= 0
        ? null
        : round2(change / elapsedDays),
    doneDelta:
      first === null || last === null ? null : last.libraries.done - first.libraries.done,
    totalDelta:
      first === null || last === null ? null : last.libraries.total - first.libraries.total,
    unreadable: readings.length - usable.length,
    latest: last,
  };
}

/**
 * @returns the time series, one entry per bucket.
 *
 * The percentage is *carried forward*: a bucket with no reading of its own repeats the
 * last one before it, because that is the state the project was in. `libraryPercent` is
 * `null` only when no reading had ever landed, which is a gap, not a zero.
 */
function buildBuckets(
  snapshots: readonly SnapshotRecord[],
  pullRequests: readonly RepositoryPullRequest[],
  from: Date,
  to: Date,
  hours: number,
): ReportBucket[] {
  const edges = bucketEdges(from, to, hours);
  return edges.map((startsAt, index) => {
    const endsAt = edges[index + 1] ?? to;
    const upTo = snapshots.filter((snapshot) => snapshot.capturedAt.getTime() <= endsAt.getTime());
    // "Landed in this bucket" is a separate question from "is the latest at or before
    // it": the first decides whether the bucket has a fresh reading, the second decides
    // what percentage to print.
    const latest = upTo.at(-1);
    const fresh =
      latest !== undefined && latest.capturedAt.getTime() >= startsAt.getTime();
    const reading = latest === undefined ? null : readImplementation(latest).libraries;
    return {
      startsAt,
      hours: Math.max((endsAt.getTime() - startsAt.getTime()) / HOUR_MS, 0),
      opened: countIn(pullRequests, (pull) => pull.createdAt, startsAt, endsAt),
      merged: countIn(pullRequests, (pull) => pull.mergedAt, startsAt, endsAt),
      closedUnmerged: countIn(
        pullRequests,
        (pull) => (pull.merged ? null : pull.closedAt),
        startsAt,
        endsAt,
      ),
      libraryPercent: fresh && reading !== null ? reading.percent : null,
      librariesDone: reading?.done ?? null,
    };
  });
}

/**
 * @returns how many items have a timestamp inside `[startsAt, endsAt)`.
 *
 * `at` returns `null` for "no such event", which is not the same as "outside the
 * window": a pull request that was never merged has no merge to count anywhere.
 */
function countIn<T>(
  items: readonly T[],
  at: (item: T) => Date | null,
  startsAt: Date,
  endsAt: Date,
): number {
  let count = 0;
  for (const item of items) {
    const when = at(item);
    if (when !== null && when.getTime() >= startsAt.getTime() && when.getTime() < endsAt.getTime()) {
      count += 1;
    }
  }
  return count;
}

/** @returns the pull-request figures for the window. */
function pullStats(
  pullRequests: readonly RepositoryPullRequest[],
  from: Date,
  to: Date,
): PullRequestStats {
  const inWindow = (at: Date | null): at is Date =>
    at !== null && at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
  const opened = pullRequests.filter((pull) => inWindow(pull.createdAt));
  const merged = pullRequests.filter((pull) => inWindow(pull.mergedAt));
  const closedUnmerged = pullRequests.filter((pull) => !pull.merged && inWindow(pull.closedAt));
  // Creation to merge, which is the interval a reviewer feels. A pull request opened
  // before the window and merged inside it still took that long, so it counts.
  const mergeHours = merged
    .filter((pull) => pull.mergedAt !== null)
    .map((pull) => (pull.mergedAt!.getTime() - pull.createdAt.getTime()) / HOUR_MS)
    .filter((value) => value >= 0);
  const days = Math.max((to.getTime() - from.getTime()) / 86_400_000, 1e-9);
  const resolved = merged.length + closedUnmerged.length;

  return {
    opened: opened.length,
    merged: merged.length,
    closedUnmerged: closedUnmerged.length,
    stillOpen: opened.filter((pull) => pull.state === "open").length,
    meanMergeHours: mean(mergeHours),
    medianMergeHours: median(mergeHours),
    mergesPerDay: round2(merged.length / days),
    opensPerDay: round2(opened.length / days),
    mergeRate: resolved === 0 ? null : round2(merged.length / resolved),
    drafts: opened.filter((pull) => pull.draft).length,
  };
}

/** @returns the commit figures for the window. */
function commitStats(
  commits: readonly { readonly at: Date; readonly author: string | null; readonly message: string }[],
  from: Date,
  to: Date,
): CommitStats {
  const inside = commits
    .filter(
      (commit) => commit.at.getTime() >= from.getTime() && commit.at.getTime() <= to.getTime(),
    )
    .sort((left, right) => right.at.getTime() - left.at.getTime());
  const counts = new Map<string, number>();
  for (const commit of inside) {
    const name = commit.author ?? "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const authors = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  const days = Math.max((to.getTime() - from.getTime()) / 86_400_000, 1e-9);
  const newest = inside[0];
  return {
    count: inside.length,
    authors,
    perDay: round2(inside.length / days),
    latest:
      newest === undefined
        ? null
        : { message: newest.message, at: newest.at, author: newest.author },
  };
}

/** @returns how much of the window the monitor actually recorded. */
function coverageOf(
  snapshots: readonly SnapshotRecord[],
  from: Date,
  to: Date,
  hours: number,
): Coverage {
  const total = Math.max(hours, 1e-9);
  const wholeHours = Math.max(1, Math.ceil(total));
  const covered = new Set<number>();
  for (const snapshot of snapshots) {
    const hour = Math.floor((snapshot.capturedAt.getTime() - from.getTime()) / HOUR_MS);
    // The window is `[from, to]` — inclusive at both ends, because a report run at a
    // snapshot's own instant has certainly observed that hour. Buckets are half-open
    // (`[start, end)`) so an event is counted once, but coverage is not a bucket: an
    // hour either has a reading or it does not.
    if (hour >= 0 && hour <= wholeHours) {
      covered.add(hour);
    }
  }

  // The cadence is inferred from the gaps between readings, by median, so a single
  // outage does not redefine what normal looks like.
  const cadence = median(
    snapshots
      .slice(1)
      .map(
        (snapshot, index) =>
          (snapshot.capturedAt.getTime() - (snapshots[index]?.capturedAt.getTime() ?? 0)) / 60_000,
      )
      .filter((minutes) => minutes > 0),
  );

  // Gaps are measured from the window's own start and to its own end, so a monitor that
  // stopped an hour ago shows that hour as a gap rather than as a shorter window.
  const edges = [
    from.getTime(),
    ...snapshots.map((snapshot) => snapshot.capturedAt.getTime()),
    to.getTime(),
  ].sort((left, right) => left - right);
  const longestGap = edges
    .slice(1)
    .reduce((longest, edge, index) => Math.max(longest, edge - (edges[index] ?? edge)), 0);

  return {
    snapshots: snapshots.length,
    cadenceMinutes: cadence === null ? null : Math.round(cadence),
    hoursCovered: covered.size,
    hoursTotal: round2(total),
    share: round2(Math.min(1, covered.size / wholeHours)),
    longestGapHours: round2(longestGap / HOUR_MS),
    failed: snapshots.filter((snapshot) => snapshot.failures.length > 0).length,
  };
}
