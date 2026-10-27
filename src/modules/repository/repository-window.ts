/**
 * The time windows a panel may be read over.
 *
 * `hours: null` means "everything the monitor kept", which is what the panels showed
 * before a window could be chosen.
 *
 * `bucketHours` is the averaging step, and it is chosen so every window draws a chart
 * worth reading rather than to be a round number. The monitor polls every fifteen
 * minutes, so `1h` holds four readings: averaging them whole would answer one number and
 * draw one column, which is why that window averages in fifteen-minute steps and gets
 * its smoothing from `averageMinutes` instead — the mean the caller asked for, without
 * collapsing the shape to a point.
 */
export const PANEL_WINDOWS = [
  {
    id: "15m",
    label: "15 minutes · raw readings",
    hours: 0.25,
    bucketHours: 0,
    averageMinutes: null,
  },
  {
    id: "1h",
    label: "1 hour · averaged",
    hours: 1,
    bucketHours: 0.25,
    averageMinutes: 60,
  },
  {
    id: "6h",
    label: "6 hours · 1h averages",
    hours: 6,
    bucketHours: 1,
    averageMinutes: 60,
  },
  {
    id: "24h",
    label: "24 hours · 3h averages",
    hours: 24,
    bucketHours: 3,
    averageMinutes: 180,
  },
  {
    id: "all",
    label: "all stored history",
    hours: null,
    bucketHours: 0,
    averageMinutes: null,
  },
] as const;

/** A panel window identifier, as the subcommand's choice list carries it. */
export type PanelWindowId = (typeof PANEL_WINDOWS)[number]["id"];

/** The window a panel shows when none is chosen: the raw quarter hour, as before. */
export const DEFAULT_PANEL_WINDOW: PanelWindowId = "15m";

/** @returns the window an option value names, defaulting to the raw quarter hour. */
export function panelWindow(id: string | null | undefined): (typeof PANEL_WINDOWS)[number] {
  return PANEL_WINDOWS.find((window) => window.id === id) ?? PANEL_WINDOWS[0];
}

/**
 * @returns the readings inside `window`, averaged into its buckets.
 *
 * Readings are clipped by `capturedAt`, so a window is the same question whenever it is
 * asked. When `bucketHours` is `0` the readings pass through untouched — a 15-minute
 * window is meant to show the polls it covers, not a summary of them.
 *
 * A bucket keeps the *mean* of the percentages it holds and the newest `capturedAt`, so
 * the point sits where a reader looks for it (the end of the interval it summarizes).
 * Percentages are averaged rather than recomputed from summed `done`/`total`: the totals
 * grow as functions are discovered, and a summed ratio would drift upward purely from
 * that discovery, which is not what the project did.
 */
export function averageReadings<T extends { readonly capturedAt: Date; readonly percent: number }>(
  readings: readonly T[],
  window: { readonly hours: number | null; readonly bucketHours: number },
  now: Date,
): readonly T[] {
  const ordered = [...readings].sort(
    (left, right) => left.capturedAt.getTime() - right.capturedAt.getTime(),
  );
  const cutoff =
    window.hours === null ? Number.NEGATIVE_INFINITY : now.getTime() - window.hours * 3_600_000;
  const inside = ordered.filter((reading) => reading.capturedAt.getTime() >= cutoff);
  if (window.bucketHours <= 0 || inside.length === 0) {
    return inside;
  }

  const buckets = new Map<number, T[]>();
  for (const reading of inside) {
    const size = window.bucketHours * 3_600_000;
    // Anchored on `now` rather than the epoch, so the last bucket ends where the reader
    // is standing instead of wherever a round number falls.
    const index = Math.floor((now.getTime() - reading.capturedAt.getTime()) / size);
    const bucket = buckets.get(index);
    if (bucket === undefined) {
      buckets.set(index, [reading]);
    } else {
      bucket.push(reading);
    }
  }

  return [...buckets.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([, bucket]) => {
      const mean = bucket.reduce((sum, reading) => sum + reading.percent, 0) / bucket.length;
      const newest = bucket.reduce((latest, reading) =>
        reading.capturedAt > latest.capturedAt ? reading : latest,
      );
      return { ...newest, percent: Math.round(mean * 100) / 100 };
    });
}

/**
 * @returns `points` with each percentage replaced by the mean of the readings that fall
 * within `minutes` of it.
 *
 * This is what makes the `1h` window "averaged" in the sense a reader means: every column
 * is the mean of the hour up to and including it, so a single noisy poll cannot put a
 * spike on a chart that is otherwise flat. A point with no earlier reading in range keeps
 * its own value rather than becoming `null`, since a mean of one is that one.
 *
 * `minutes` of `0` passes the points through: the raw quarter-hour window is meant to
 * show the polls untouched.
 */
export function smoothByMinutes<T extends { readonly capturedAt: Date; readonly percent: number }>(
  points: readonly T[],
  minutes: number | null,
): readonly T[] {
  if (minutes === null || minutes <= 0 || points.length === 0) {
    return points;
  }
  const span = minutes * 60_000;
  return points.map((point) => {
    const end = point.capturedAt.getTime();
    const start = end - span;
    const inRange = points.filter((other) => {
      const at = other.capturedAt.getTime();
      return at > start && at <= end;
    });
    const mean = inRange.reduce((sum, other) => sum + other.percent, 0) / inRange.length;
    return { ...point, percent: Math.round(mean * 100) / 100 };
  });
}

/**
 * @returns `readings` clipped to `window`, averaged into buckets, then smoothed.
 *
 * The one call the panels make, so the order is fixed in one place: clip, bucket, then
 * smooth. Smoothing before bucketing would let a bucket's mean be pulled by readings that
 * the window had already excluded, which is the kind of off-by-a-window error that makes
 * a chart disagree with its own caption.
 */
export function windowReadings<T extends { readonly capturedAt: Date; readonly percent: number }>(
  readings: readonly T[],
  id: string | null | undefined,
  now: Date,
): { readonly window: (typeof PANEL_WINDOWS)[number]; readonly points: readonly T[] } {
  const window = panelWindow(id);
  // Smoothing reads the clipped raw series, not the bucketed one: a bucket that already
  // holds a single reading has nothing to average against, so smoothing after bucketing
  // is a no-op on every window whose bucket is as fine as the poll (which is `1h`). The
  // mean a reader asked for is the mean of the readings around each point, so that is
  // computed where the readings still exist, and bucketing then thins the result.
  const clipped = averageReadings(readings, { ...window, bucketHours: 0 }, now);
  const smoothed = smoothByMinutes(clipped, window.averageMinutes);
  const points =
    window.bucketHours <= 0
      ? smoothed
      : averageReadings(smoothed, window, now);
  return { window, points };
}
