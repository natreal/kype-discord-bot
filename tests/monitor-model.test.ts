/**
 * The monitor's arithmetic: every number a frame shows that the feed did not hand it.
 *
 * These are the values a reader acts on — "how fast is it going", "how long is left",
 * "what is least done" — so the assertions are about the answer, not the implementation:
 * a flat series has no finish line, a tie is broken by size, and a group that appears
 * between two readings is new rather than moved.
 */
import { describe, expect, it } from "vitest";

import {
  buildModel,
  hourlyBuckets,
  hourOf,
  lastStepOf,
  lowestGroups,
  movesSince,
  paceOf,
  sampleOf,
  type MonitorSample,
  type MonitorState,
} from "../../src/monitor/model.js";
import { parseProgressSnapshot, type AnyPs5Progress } from "../../src/services/anyps5/progress.js";

const START = new Date("2026-10-25T12:00:00.000Z");

/** @returns the instant `minutes` after {@link START}, which is what the fixtures use. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * 60_000);
}

/** One library as a fixture describes it. */
interface GroupFixture {
  readonly name: string;
  readonly done: number;
  readonly todo: number;
}

/**
 * @returns a validated snapshot.
 *
 * Built through the real parser rather than as a `MonitorSample` literal: the fixture
 * then has to be shaped like `progress.json`, so a schema change breaks this test at
 * the same moment it breaks the monitor.
 */
function snapshot(
  libraries: { readonly done: number; readonly total: number },
  groups: readonly GroupFixture[],
  shaders: { readonly done: number; readonly total: number } = { done: 0, total: 0 },
): AnyPs5Progress {
  const percent = (part: number, whole: number): number => (whole === 0 ? 0 : (100 * part) / whole);
  return parseProgressSnapshot({
    libraries: {
      done: libraries.done,
      total: libraries.total,
      percent: percent(libraries.done, libraries.total),
      groups: groups.map((group) => ({
        name: group.name,
        label: group.name.replace(/^libSce/, ""),
        done: group.done,
        todo: group.todo,
      })),
    },
    shaders: {
      done: shaders.done,
      total: shaders.total,
      percent: percent(shaders.done, shaders.total),
      groups: [],
    },
  });
}

/** @returns one reading of the two sections, taken at `when`. */
function reading(
  when: Date,
  libraries: { readonly done: number; readonly total: number },
  groups: readonly GroupFixture[] = [],
  shaders: { readonly done: number; readonly total: number } = { done: 0, total: 0 },
): MonitorSample {
  return sampleOf(snapshot(libraries, groups, shaders), when);
}

/** @returns a state with `samples` held and its newest also on screen. */
function state(samples: readonly MonitorSample[] = []): MonitorState {
  return {
    repository: "boykopovar/AnyPS5",
    startedAt: START,
    intervalMs: 15_000,
    paused: false,
    authenticated: true,
    polling: false,
    nextPollAt: at(1),
    pollCount: samples.length,
    failureCount: 0,
    progress: samples.at(-1) ?? null,
    progressFailure: null,
    progressCommit: null,
    samples,
    live: undefined,
    liveFailure: null,
    events: [],
  };
}
describe("sampleOf", () => {
  it("keeps both sections and flattens the groups to the drawn columns", () => {
    const sample = reading(
      START,
      { done: 3, total: 4 },
      [
        { name: "libSceAgc", done: 1, todo: 1 },
        { name: "libSceVid", done: 0, todo: 2 },
      ],
      { done: 1, total: 2 },
    );

    expect(sample.at).toBe(START);
    expect(sample.libraries).toEqual({ done: 3, total: 4, percent: 75 });
    expect(sample.shaders).toEqual({ done: 1, total: 2, percent: 50 });
    expect(sample.groups).toEqual([
      { name: "libSceAgc", label: "Agc", done: 1, total: 2, percent: 50 },
      { name: "libSceVid", label: "Vid", done: 0, total: 2, percent: 0 },
    ]);
  });
});

describe("paceOf", () => {
  it("has no rate for an empty series", () => {
    expect(paceOf([])).toEqual({ perHour: null, etaDays: null, change: null });
  });

  it("has no rate for a single reading, because one point has no slope", () => {
    const pace = paceOf([{ capturedAt: START, value: 49 }]);

    expect(pace.perHour).toBeNull();
    expect(pace.change).toBeNull();
    expect(pace.etaDays).toBeNull();
  });

  it("converts the daily figure to points per hour, and estimates from it", () => {
    // One point in an hour: 24 points a day, so 1 an hour, and the 50 points left at
    // that pace is just over two days.
    const pace = paceOf([
      { capturedAt: START, value: 49 },
      { capturedAt: at(60), value: 50 },
    ]);

    expect(pace.perHour).toBe(1);
    expect(pace.change).toBe(1);
    expect(pace.etaDays).toBe(2.1);
  });

  it("refuses a finish line for a flat series instead of inventing one", () => {
    const pace = paceOf([
      { capturedAt: START, value: 49 },
      { capturedAt: at(15), value: 49 },
      { capturedAt: at(30), value: 49 },
    ]);

    expect(pace.perHour).toBe(0);
    expect(pace.change).toBe(0);
    expect(pace.etaDays).toBeNull();
  });
});

describe("lastStepOf", () => {
  it("is null until there are two readings to compare", () => {
    expect(lastStepOf([])).toBeNull();
    expect(lastStepOf([reading(START, { done: 1, total: 2 })])).toBeNull();
  });

  it("reports the last pair in counters and in points", () => {
    const step = lastStepOf([
      reading(at(0), { done: 2, total: 200 }, [], { done: 1, total: 10 }),
      reading(at(15), { done: 6, total: 200 }, [], { done: 2, total: 10 }),
    ]);

    expect(step).toEqual({
      seconds: 900,
      libraryChange: 2,
      shaderChange: 10,
      librariesDone: 4,
      shadersDone: 1,
    });
  });
});

describe("hourOf", () => {
  it("rounds a reading down to the hour it was taken in, on the UTC clock", () => {
    expect(hourOf(new Date("2026-10-25T12:59:59.999Z"))).toEqual(
      new Date("2026-10-25T12:00:00.000Z"),
    );
    expect(hourOf(new Date("2026-10-25T12:00:00.000Z"))).toEqual(
      new Date("2026-10-25T12:00:00.000Z"),
    );
    // Half past eleven at night belongs to the hour that started that evening, not to
    // the next day: a column labelled 23:00 has to mean 23:00 to whoever reads it.
    expect(hourOf(new Date("2026-10-25T23:30:00.000Z"))).toEqual(
      new Date("2026-10-25T23:00:00.000Z"),
    );
  });
});

describe("hourlyBuckets", () => {
  it("gives each observed hour one bucket, oldest first, and none to an hour nobody saw", () => {
    const buckets = hourlyBuckets(
      [
        reading(at(0), { done: 1, total: 100 }),
        // 13:00 has no reading: the window was closed, and the chart must say so by
        // leaving a gap rather than by drawing a zero.
        reading(at(120), { done: 2, total: 100 }),
        reading(at(240), { done: 3, total: 100 }),
      ],
      at(240),
    );

    expect(buckets.map((bucket) => bucket.startsAt.getUTCHours())).toEqual([12, 14, 16]);
  });

  it("averages the hour's percentages instead of recomputing them from the counters", () => {
    const buckets = hourlyBuckets(
      [reading(at(0), { done: 10, total: 100 }), reading(at(30), { done: 30, total: 200 })],
      at(30),
    );

    expect(buckets).toHaveLength(1);
    // The mean of what was read — 10 % and 15 % — not 40/300 = 13.33 %: totals grow as
    // functions are discovered, and that growth is not work done.
    expect(buckets[0]?.libraries).toBe(12.5);
    expect(buckets[0]?.polls).toBe(2);
  });

  it("counts the work inside an hour as its last counters minus its first", () => {
    const [bucket] = hourlyBuckets(
      [
        reading(at(0), { done: 10, total: 100 }, [], { done: 5, total: 50 }),
        reading(at(45), { done: 40, total: 120 }, [], { done: 9, total: 50 }),
      ],
      at(45),
    );

    expect(bucket?.librariesAdded).toBe(30);
    expect(bucket?.shadersAdded).toBe(4);
    expect(bucket?.librariesDone).toBe(40);
    expect(bucket?.shadersDone).toBe(9);
  });

  it("keeps only the hours inside the window it is asked for", () => {
    const samples = [
      reading(at(0), { done: 1, total: 100 }),
      reading(at(60), { done: 2, total: 100 }),
    ];

    const held = hourlyBuckets(samples, at(90), 1);

    expect(held.map((bucket) => bucket.startsAt.getUTCHours())).toEqual([13]);
  });

  it("is empty before the first reading", () => {
    expect(hourlyBuckets([], at(0))).toEqual([]);
  });
});

describe("lowestGroups", () => {
  const groups: readonly GroupFixture[] = [
    { name: "libSceAgc", done: 1, todo: 9 },
    { name: "libSceAudio", done: 0, todo: 50 },
    { name: "libSceVid", done: 0, todo: 100 },
    { name: "libSceEmpty", done: 0, todo: 0 },
  ];

  it("is empty before the first reading", () => {
    expect(lowestGroups(null, 12)).toEqual([]);
  });

  it("leads with the least done, breaks ties by size, and drops empty groups", () => {
    const listed = lowestGroups(reading(START, { done: 1, total: 160 }, groups), 12);

    // 0% before 10%, and between the two untouched libraries the larger one first:
    // that is the library where the next weeks of work are.
    expect(listed.map((group) => group.name)).toEqual(["libSceVid", "libSceAudio", "libSceAgc"]);
  });

  it("honours the limit", () => {
    expect(lowestGroups(reading(START, { done: 1, total: 160 }, groups), 1)).toHaveLength(1);
  });
});

describe("movesSince", () => {
  it("needs two readings", () => {
    expect(movesSince([reading(START, { done: 1, total: 100 })], 6)).toEqual([]);
  });

  it("reports only growth, biggest first, for groups present in both readings", () => {
    const before = reading(START, { done: 10, total: 100 }, [
      { name: "libSceAgc", done: 1, todo: 9 },
      { name: "libSceAudio", done: 5, todo: 5 },
    ]);
    const after = reading(at(15), { done: 20, total: 100 }, [
      { name: "libSceAgc", done: 3, todo: 7 },
      { name: "libSceAudio", done: 5, todo: 5 },
      // Appeared between readings: new, not moved.
      { name: "libSceNew", done: 1, todo: 1 },
    ]);

    expect(movesSince([before, after], 6)).toEqual([
      { name: "libSceAgc", label: "Agc", percent: 30, change: 20 },
    ]);
  });
});

describe("buildModel", () => {
  it("derives uptime, pace, step, groups and movers once, for the frame to copy", () => {
    const samples = [
      reading(at(0), { done: 1, total: 100 }, [{ name: "libSceAgc", done: 1, todo: 9 }], {
        done: 1,
        total: 10,
      }),
      reading(at(15), { done: 2, total: 100 }, [{ name: "libSceAgc", done: 2, todo: 8 }], {
        done: 2,
        total: 10,
      }),
    ];

    const model = buildModel(state(samples), at(20));

    expect(model.uptimeMs).toBe(20 * 60_000);
    // 1 % in a quarter of an hour is 4 points an hour; 10 % is 40.
    expect(model.pace.libraries.perHour).toBe(4);
    expect(model.pace.shaders.perHour).toBe(40);
    expect(model.lastStep?.librariesDone).toBe(1);
    expect(model.groups[0]?.name).toBe("libSceAgc");
    expect(model.movers[0]?.change).toBe(10);
    expect(model.progress).toBe(samples[1]);
    // Both readings were taken in the same hour, so they are one column, and that
    // column is the hour the window is standing in.
    expect(model.hourly).toHaveLength(1);
    expect(model.thisHour).toBe(model.hourly[0]);
    expect(model.thisHour?.polls).toBe(2);
  });

  it("has no hour in progress when the hour being stood in was never read", () => {
    const model = buildModel(state([reading(at(0), { done: 1, total: 100 })]), at(65));

    expect(model.hourly).toHaveLength(1);
    expect(model.thisHour).toBeNull();
  });

  it("never reports a negative uptime, so a clock correction cannot underflow the header", () => {
    expect(buildModel(state(), at(-5)).uptimeMs).toBe(0);
  });

  it("caps the group list the frame is handed", () => {
    const groups = Array.from({ length: 20 }, (_, index) => ({
      name: `libSce${String(index)}`,
      done: index,
      todo: 20 - index,
    }));

    const model = buildModel(state([reading(START, { done: 100, total: 200 }, groups)]), START);

    expect(model.groups).toHaveLength(12);
  });
});
