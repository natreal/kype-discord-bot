/**
 * Statistics over the recorded snapshots.
 *
 * Pure, and deliberately separate from both the storage layer and the embed
 * layer: everything `/github` says about a *series* — how far the project moved,
 * whether it is speeding up, which library grew, why a percentage fell — is
 * decided here, from the snapshots the monitor already stored, so it can be
 * tested against plain arrays and can never disagree with the hourly report.
 *
 * The one rule that runs through the whole file: **a missing reading is not a
 * zero.** A snapshot taken while `progress.json` was unreachable has `null`
 * percentages, and every function here skips those instead of interpolating
 * across them — an average that quietly treats "unknown" as "0%" would show a
 * cliff that never happened.
 */
import type { SnapshotRecord } from "./repository.types.js";

/**
 * What an implementation percentage is made of, and therefore what can change it.
 *
 * `done` is the number of implemented functions (or shader instructions) and
 * `total` is the denominator the project publishes: the functions the scan found.
 * The denominator is the *discovered* count, so it grows when the project's scan
 * starts covering a library it did not analyse before.
 */
export interface ImplementationSeries {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** One point of a series, with the snapshot it came from. */
export interface SeriesPoint {
  readonly capturedAt: Date;
  readonly value: number;
}

/** One reading of both implementation percentages. */
export interface ImplementationReading {
  readonly capturedAt: Date;
  readonly libraries: ImplementationSeries | null;
  readonly shaders: ImplementationSeries | null;
}

/**
 * The honest decomposition of a percentage change:
 *
 *   Δpercent = done_now / total_now − done_before / total_before
 *            = **(done_now − done_before) / total_now**   ← new work
 *              **− done_before · (total_now − total_before) / (total_before · total_now)**
 *                                                          ← new discoveries
 *
 * Both terms are exact and add up to the observed change. When `total` did not
 * move, the second term is zero and the whole change is work. When `done` did not
 * move but `total` grew, the first term is zero and the percentage fell purely
 * because the project's scan found more to do — the case `/github why` exists to
 * make legible.
 */
export interface Decomposition {
  /** The observed change in percentage points. */
  readonly change: number;
  /** Percentage points attributable to implementing functions. */
  readonly fromWork: number;
  /** Percentage points attributable to the denominator growing or shrinking. */
  readonly fromDiscovery: number;
  /** Change in the number of implemented functions (signed). */
  readonly doneDelta: number;
  /** Change in the number of discovered functions (signed). */
  readonly totalDelta: number;
  /** Share of a *fall* explained by discovery, `0` to `1`. */
  readonly discoveryShareOfFall: number;
}

/** Totals read off one snapshot; `null` when the snapshot had no reading. */
export function readImplementation(snapshot: SnapshotRecord): ImplementationReading {
  const { state } = snapshot;
  const libraries =
    state.librariesDone === null ||
    state.librariesTotal === null ||
    state.libraryPercent === null ||
    state.librariesTotal <= 0
      ? null
      : {
          done: state.librariesDone,
          total: state.librariesTotal,
          percent: state.libraryPercent,
        };
  const shaders =
    state.shadersDone === null ||
    state.shadersTotal === null ||
    state.shaderPercent === null ||
    state.shadersTotal <= 0
      ? null
      : {
          done: state.shadersDone,
          total: state.shadersTotal,
          percent: state.shaderPercent,
        };
  return { capturedAt: snapshot.capturedAt, libraries, shaders };
}

/** @returns the points of a series over `history`, oldest first, gaps dropped. */
export function implementationPoints(
  history: readonly SnapshotRecord[],
  section: "libraries" | "shaders",
): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const snapshot of history) {
    const reading = readImplementation(snapshot)[section];
    if (reading !== null) {
      points.push({ capturedAt: snapshot.capturedAt, value: reading.percent });
    }
  }
  return points;
}

/** @returns the points of any per-snapshot number series, in order. */
export function counterPoints(
  history: readonly SnapshotRecord[],
  read: (snapshot: SnapshotRecord) => number,
): SeriesPoint[] {
  return history.map((snapshot) => ({ capturedAt: snapshot.capturedAt, value: read(snapshot) }));
}

/**
 * The decomposition described on {@link Decomposition}.
 *
 * @returns `null` when either side has no reading: a change from "unknown" is
 * not a change, and reporting one would be inventing a number.
 */
export function decompose(
  before: ImplementationSeries,
  now: ImplementationSeries,
): Decomposition | null {
  if (before.total <= 0 || now.total <= 0) {
    return null;
  }
  const change = round2(now.percent - before.percent);
  // Work is measured against today's denominator: the functions implemented in
  // between are now part of the same total the percentage is drawn from.
  const fromWork = round2(((now.done - before.done) / now.total) * 100);
  // Discovery is the remainder, so the two terms always add up to the change
  // instead of each rounding away from it independently.
  const fromDiscovery = round2(change - fromWork);
  return {
    change,
    fromWork,
    fromDiscovery,
    doneDelta: now.done - before.done,
    totalDelta: now.total - before.total,
    discoveryShareOfFall:
      change < 0 && fromDiscovery < 0 ? Math.min(1, Math.abs(fromDiscovery) / Math.abs(change)) : 0,
  };
}

/** @returns `value` rounded to two decimals, the project's own precision. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How a series moved over the recorded window. */
export interface TrendSummary {
  readonly first: SeriesPoint;
  readonly last: SeriesPoint;
  /** Change in percentage points over the window. */
  readonly change: number;
  /** Change per day, from the window's wall-clock length. */
  readonly perDay: number | null;
  /** Least-squares slope, in points per day. `null` with fewer than two points. */
  readonly slopePerDay: number | null;
  /** Share of consecutive pairs that improved, `0` to `1`; `null` below two pairs. */
  readonly improvingShare: number | null;
  /** How many steps went up, down and stayed put. */
  readonly steps: { readonly up: number; readonly down: number; readonly flat: number };
  /** Longest run of steps in one direction, and which way. */
  readonly longestRun: { readonly direction: "up" | "down"; readonly length: number } | null;
  /** Highest and lowest readings, with when they happened. */
  readonly high: SeriesPoint;
  readonly low: SeriesPoint;
}

/**
 * Summarizes a series.
 *
 * `null` with no points at all; a one-point window is summarized with `null`
 * slopes rather than a zero, because one reading cannot have a rate.
 */
export function summarize(points: readonly SeriesPoint[]): TrendSummary | null {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }

  const steps = { up: 0, down: 0, flat: 0 };
  let runDirection: "up" | "down" | null = null;
  let runLength = 0;
  let longest: { direction: "up" | "down"; length: number } | null = null;

  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1]?.value ?? 0;
    const now = points[index]?.value ?? 0;
    if (now > before) {
      steps.up += 1;
      runLength = runDirection === "up" ? runLength + 1 : 1;
      runDirection = "up";
    } else if (now < before) {
      steps.down += 1;
      runLength = runDirection === "down" ? runLength + 1 : 1;
      runDirection = "down";
    } else {
      steps.flat += 1;
      runDirection = null;
      runLength = 0;
    }
    if (runDirection !== null && (longest === null || runLength > longest.length)) {
      longest = { direction: runDirection, length: runLength };
    }
  }

  const totalPairs = steps.up + steps.down + steps.flat;
  const days = (last.capturedAt.getTime() - first.capturedAt.getTime()) / 86_400_000;

  return {
    first,
    last,
    change: round2(last.value - first.value),
    perDay: days > 0 ? round2((last.value - first.value) / days) : null,
    slopePerDay: slope(points),
    improvingShare: totalPairs === 0 ? null : steps.up / totalPairs,
    steps,
    longestRun: longest,
    high: points.reduce((best, point) => (point.value > best.value ? point : best), first),
    low: points.reduce((best, point) => (point.value < best.value ? point : best), first),
  };
}

/**
 * @returns the least-squares slope in points per day, or `null` with fewer than
 * two points. Least squares rather than first-to-last: an hourly series is noisy,
 * and the endpoint of a window depends on whichever hour it happens to end on.
 */
export function slope(points: readonly SeriesPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }
  const origin = (points[0]?.capturedAt.getTime() ?? 0) / 86_400_000;
  const xs = points.map((point) => point.capturedAt.getTime() / 86_400_000 - origin);
  const ys = points.map((point) => point.value);
  const count = points.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / count;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = (xs[index] ?? 0) - meanX;
    numerator += dx * ((ys[index] ?? 0) - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? null : round2(numerator / denominator);
}

/** One library as a snapshot recorded it. */
export interface LibraryReading {
  readonly name: string;
  readonly label: string;
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** What changed for one library between two readings. */
export interface LibraryMovement<T> {
  readonly name: string;
  readonly label: string;
  readonly before: T;
  readonly after: LibraryReading;
}

/** How the set of libraries the scan reports changed. */
export interface LibrarySetChange {
  /** Libraries the newer reading analyses and the older one did not. */
  readonly added: readonly LibraryReading[];
  /** Libraries the older reading analysed and the newer one does not. */
  readonly removed: readonly LibraryReading[];
  /** `true` when both readings list libraries, so the sets are comparable. */
  readonly comparable: boolean;
}

/** The per-library comparison behind `/github libraries` and `/github why`. */
export interface LibraryAnalysis {
  readonly before: readonly LibraryReading[];
  readonly after: readonly LibraryReading[];
  readonly setChange: LibrarySetChange;
  /** Libraries present in both readings whose implemented count rose most. */
  readonly grew: readonly LibraryMovement<LibraryReading>[];
  /** …whose implemented count fell (a revert, or a recount). */
  readonly shrank: readonly LibraryMovement<LibraryReading>[];
  /** …whose denominator grew most: the discoveries, and why a share can fall. */
  readonly discovered: readonly LibraryMovement<LibraryReading>[];
  /** Libraries that are fully analysed in the newer reading. */
  readonly complete: number;
}

/**
 * Reads one snapshot's full published statistics.
 *
 * The monitor stores the whole `progress.json` beside every snapshot, which is
 * what makes a per-library history possible at all: the percentages above are
 * copied, and the library table below is read from the same document.
 */
export function readLibraries(snapshot: SnapshotRecord | null): LibraryReading[] {
  const progress = snapshot?.progress;
  if (progress === null || progress === undefined) {
    return [];
  }
  return progress.libraries.groups.map((group) => ({
    name: group.name,
    label: group.label,
    done: group.done,
    total: group.total,
    percent: group.percent,
  }));
}

/**
 * Compares two readings, library by library.
 *
 * Libraries are matched by **name**, not by position: the published document
 * lists them in a stable order, but a scan that discovers a new library inserts
 * one, and comparing index to index would report every later library as changed.
 * A library that disappeared from both sides is reported as removed rather than
 * as a 100% loss, because the two are different facts about the project.
 */
export function analyzeLibraries(
  before: readonly LibraryReading[],
  after: readonly LibraryReading[],
  limit = 5,
): LibraryAnalysis {
  const beforeByName = new Map(before.map((library) => [library.name, library]));
  const afterByName = new Map(after.map((library) => [library.name, library]));

  const grew: LibraryMovement<LibraryReading>[] = [];
  const shrank: LibraryMovement<LibraryReading>[] = [];
  const discovered: LibraryMovement<LibraryReading>[] = [];

  for (const library of after) {
    const previous = beforeByName.get(library.name);
    if (previous === undefined) {
      continue;
    }
    const movement = { name: library.name, label: library.label, before: previous, after: library };
    if (library.done > previous.done) {
      grew.push(movement);
    } else if (library.done < previous.done) {
      shrank.push(movement);
    }
    if (library.total > previous.total) {
      discovered.push(movement);
    }
  }

  const byDelta = <T extends LibraryMovement<LibraryReading>>(
    items: readonly T[],
    delta: (item: T) => number,
  ): T[] => [...items].sort((left, right) => delta(right) - delta(left)).slice(0, limit);

  return {
    before,
    after,
    setChange: {
      added: after.filter((library) => !beforeByName.has(library.name)),
      removed: before.filter((library) => !afterByName.has(library.name)),
      comparable: before.length > 0 && after.length > 0,
    },
    grew: byDelta(grew, (item) => item.after.done - item.before.done),
    shrank: byDelta(shrank, (item) => item.before.done - item.after.done),
    discovered: byDelta(discovered, (item) => item.after.total - item.before.total),
    complete: after.filter((library) => library.total > 0 && library.done >= library.total).length,
  };
}

/**
 * Finds the previous stored reading that actually carries the library table.
 *
 * A snapshot taken while `progress.json` was unreachable stores no table, so
 * "the previous snapshot" is often the wrong comparison for a per-library view;
 * this walks back to the last one that can be compared.
 *
 * @returns its index in `history`, or `null` when none can.
 */
export function lastComparableIndex(
  history: readonly SnapshotRecord[],
  before: number,
): number | null {
  for (let index = Math.min(before, history.length) - 1; index >= 0; index -= 1) {
    if (readLibraries(history[index] ?? null).length > 0) {
      return index;
    }
  }
  return null;
}

/**
 * @returns how long the recent pace needs to reach `target` percent, in days, or
 * `null` when the pace is not positive. Always labelled as an estimate: a
 * project can always discover more to do, which moves the target away.
 */
export function daysToCompletion(summary: TrendSummary, target = 100): number | null {
  const pace = summary.slopePerDay;
  if (pace === null || pace <= 0) {
    return null;
  }
  return Math.round(((target - summary.last.value) / pace) * 10) / 10;
}
