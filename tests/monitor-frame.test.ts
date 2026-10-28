/**
 * The frame's contract with the terminal that paints it.
 *
 * `renderFrame` returns lines that are addressed by absolute row, so the array's shape
 * is not cosmetic: a short line leaves the previous frame showing through, and a long
 * one wraps and shifts every row under it. That is why the first and largest group of
 * tests here is the same assertion at five sizes, in colour and in plain text, for a
 * full window, an empty one and a broken one.
 *
 * The rest is the narrow-window policy: facts are dropped whole, by width tier, and
 * never sliced in the middle — `· +208` with no `pp/h` is worse than no pace at all.
 */
import { describe, expect, it } from "vitest";

import { renderFrame, type FrameSize } from "../../src/monitor/frame.js";
import {
  buildModel,
  sampleOf,
  type MonitorEvent,
  type MonitorState,
} from "../../src/monitor/model.js";
import { visibleWidth } from "../../src/monitor/theme.js";
import { parseProgressSnapshot } from "../../src/services/anyps5/progress.js";
import type { GitHubLiveFacts } from "../../src/services/github/live-feed.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");

/** A maximised console, a classic terminal, and three sizes a split pane reaches. */
const SIZES: readonly FrameSize[] = [
  { columns: 100, rows: 32 },
  { columns: 80, rows: 24 },
  { columns: 60, rows: 16 },
  { columns: 40, rows: 12 },
  { columns: 24, rows: 8 },
];

/** One library group in the shape `progress.json` publishes. */
function group(
  name: string,
  done: number,
  todo: number,
): { name: string; label: string; done: number; todo: number } {
  return { name: `libSce${name}`, label: name, done, todo };
}

/** @returns a validated snapshot: `librariesDone` of 12,309 libraries, some shaders. */
function snapshot(librariesDone: number, shadersDone: number) {
  return parseProgressSnapshot({
    libraries: {
      done: librariesDone,
      total: 12_309,
      percent: (100 * librariesDone) / 12_309,
      groups: [
        group("FsInternalForVsh", 0, 176),
        group("Agc", 12, 24),
        group("Audio", 3, 10),
        group("Vid", 40, 40),
        group("Net", 1, 15),
        group("Pad", 6, 9),
      ],
    },
    shaders: { done: shadersDone, total: 1_166, percent: (100 * shadersDone) / 1_166, groups: [] },
  });
}

const FIFTEEN_MINUTES = 15 * 60_000;
const FIRST = sampleOf(snapshot(6_033, 1_050), new Date(NOW.getTime() - FIFTEEN_MINUTES));
const SECOND = sampleOf(snapshot(6_111, 1_166), NOW);

const EVENTS: readonly MonitorEvent[] = [
  {
    at: FIRST.at,
    level: "good",
    text: "first reading: 6,033 / 12,309 libraries, 1,050 / 1,166 shaders",
  },
  {
    at: SECOND.at,
    level: "good",
    text: "+78 libraries and +116 shaders since the last poll (15m 00s)",
  },
  {
    at: SECOND.at,
    level: "info",
    text: "live read: 48,124 stars · 4,521 forks · 1,614 open issues · quota 46",
  },
  { at: SECOND.at, level: "good", text: "release v0.1.3 published" },
];

/** @returns the live facts a healthy anonymous read produces. */
function facts(overrides: Partial<GitHubLiveFacts> = {}): GitHubLiveFacts {
  return {
    fullName: "boykopovar/AnyPS5",
    description: "A PS5 emulator",
    defaultBranch: "main",
    stars: 48_124,
    forks: 4_521,
    watchers: 418,
    openIssues: 1_614,
    pushedAt: new Date(NOW.getTime() - 18 * 60_000),
    archived: false,
    release: {
      tag: "v0.1.3",
      name: "v0.1.3",
      publishedAt: new Date(NOW.getTime() - 5 * 86_400_000),
      url: "https://github.com/boykopovar/AnyPS5/releases/tag/v0.1.3",
    },
    workflow: {
      name: "Build",
      branch: "main",
      status: "queued",
      conclusion: null,
      updatedAt: NOW,
      url: "https://github.com/boykopovar/AnyPS5/actions",
    },
    languages: [
      { name: "C++", percent: 92.7 },
      { name: "Python", percent: 5 },
      { name: "CMake", percent: 2.2 },
    ],
    rateLimitRemaining: 46,
    rateLimitResetAt: new Date(NOW.getTime() + 37 * 60_000),
    authenticated: false,
    fetchedAt: NOW,
    ...overrides,
  };
}

/** @returns the state of a window that has polled twice and whose live half answered. */
function fullState(): MonitorState {
  return {
    repository: "boykopovar/AnyPS5",
    startedAt: new Date(NOW.getTime() - 4 * 60_000),
    intervalMs: 15_000,
    paused: false,
    authenticated: false,
    polling: false,
    nextPollAt: new Date(NOW.getTime() + 7_000),
    pollCount: 2,
    failureCount: 0,
    progress: SECOND,
    progressFailure: null,
    progressCommit: "9f3c1aab",
    samples: [FIRST, SECOND],
    live: facts(),
    liveFailure: null,
    events: EVENTS,
  };
}

/** @returns the state of a window opened a moment ago: it has read nothing yet. */
function emptyState(): MonitorState {
  return {
    repository: "boykopovar/AnyPS5",
    startedAt: NOW,
    intervalMs: 15_000,
    paused: false,
    authenticated: false,
    polling: true,
    nextPollAt: NOW,
    pollCount: 1,
    failureCount: 0,
    progress: null,
    progressFailure: null,
    progressCommit: null,
    samples: [],
    live: undefined,
    liveFailure: null,
    events: [],
  };
}

/** @returns the state of a window whose every read failed: the worst frame it can draw. */
function failedState(): MonitorState {
  return {
    ...emptyState(),
    polling: false,
    failureCount: 3,
    progressFailure: "progress.json answered HTTP 503",
    live: null,
    liveFailure: "no GITHUB_TOKEN — anonymous calls are limited to 60 an hour",
    events: [
      { at: NOW, level: "bad", text: "progress.json answered HTTP 503" },
      {
        at: NOW,
        level: "bad",
        text: "live read: no GITHUB_TOKEN — anonymous calls are limited to 60 an hour",
      },
    ],
  };
}

/**
 * @returns the state of a window open across three hours, where the middle hour did the
 * work: the shape the hourly charts exist to show.
 */
function spreadState(): MonitorState {
  const hour = 3_600_000;
  const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
  return {
    ...fullState(),
    startedAt: at(-2 * hour),
    progress: sampleOf(snapshot(6_150, 1_050), NOW),
    samples: [
      // 10:00 and 10:10: four libraries, so the first hour is a short bar.
      sampleOf(snapshot(6_000, 1_000), at(-2 * hour)),
      sampleOf(snapshot(6_004, 1_000), at(-2 * hour + 10 * 60_000)),
      // 11:00 and 11:50: forty libraries and ten shaders, the busiest hour.
      sampleOf(snapshot(6_100, 1_030), at(-hour)),
      sampleOf(snapshot(6_140, 1_040), at(-10 * 60_000)),
      // 12:00: one poll so far, so nothing has finished in the hour yet.
      sampleOf(snapshot(6_150, 1_050), NOW),
    ],
  };
}

/** @returns `count` groups, each further along than the last, so index order is rank order. */
function crowd(count: number, gained = 0): ReturnType<typeof group>[] {
  return Array.from({ length: count }, (_, index) =>
    group(`G${String(index).padStart(2, "0")}`, index + (index === 1 ? gained : 0), 60),
  );
}

/** @returns a snapshot with `groups` under a section total nothing depends on. */
function listed(groups: readonly ReturnType<typeof group>[]) {
  return parseProgressSnapshot({
    libraries: { done: 100, total: 12_309, percent: 0.81, groups },
    shaders: { done: 0, total: 1_166, percent: 0, groups: [] },
  });
}

/**
 * @returns the state of a window reading a snapshot of sixty groups, one of which has
 * gained since the first reading — what the table has to fit, and to mark.
 */
function crowdedState(gained = 4): MonitorState {
  const before = sampleOf(listed(crowd(60)), new Date(NOW.getTime() - FIFTEEN_MINUTES));
  const after = sampleOf(listed(crowd(60, gained)), NOW);
  return { ...fullState(), progress: after, samples: [before, after] };
}

/** @returns `state` rendered at `size`, plain unless `color`. */
function render(state: MonitorState, size: FrameSize, color = false): readonly string[] {
  return renderFrame(buildModel(state, NOW), size, { color });
}

describe("renderFrame", () => {
  describe("the shape contract", () => {
    const windows = [
      { name: "a full window", state: fullState },
      { name: "a window that has read nothing", state: emptyState },
      { name: "a window whose reads all failed", state: failedState },
    ] as const;

    for (const window of windows) {
      for (const size of SIZES) {
        for (const color of [false, true]) {
          const shade = color ? "colour" : "plain";
          it(`${window.name} is exactly ${size.columns}×${size.rows} (${shade})`, () => {
            const frame = render(window.state(), size, color);

            expect(frame).toHaveLength(size.rows);
            for (const line of frame) {
              expect(visibleWidth(line)).toBe(size.columns);
            }
          });
        }
      }
    }

    it("draws the same frame twice, so a repaint cannot shimmer", () => {
      expect(render(fullState(), SIZES[0]!)).toEqual(render(fullState(), SIZES[0]!));
    });
  });

  describe("plain and coloured output", () => {
    it("puts no escape sequences in a plain frame, so it survives a redirect", () => {
      expect(render(fullState(), SIZES[0]!).join("\n")).not.toContain("\u001B");
    });

    it("does colour a coloured frame", () => {
      expect(render(fullState(), SIZES[0]!, true).join("\n")).toContain("\u001B[");
    });

    it("says who it is watching, and that it has no token", () => {
      const frame = render(fullState(), SIZES[1]!).join("\n");

      expect(frame).toContain("boykopovar/AnyPS5");
      expect(frame).toContain("anonymous");
    });
  });

  describe("the narrow-window policy", () => {
    for (const size of SIZES) {
      it(`never ends a ${size.columns}-column line on a dangling separator`, () => {
        for (const line of render(fullState(), size)) {
          expect(line.trimEnd().endsWith("·")).toBe(false);
        }
      });
    }

    it("keeps the languages fact where it fits and drops it whole where it cannot", () => {
      expect(render(fullState(), { columns: 100, rows: 32 }).join("\n")).toContain("C++ 92.7 %");
      expect(render(fullState(), { columns: 24, rows: 8 }).join("\n")).not.toContain("languages");
    });

    it("drops the bars before it drops the numbers", () => {
      const frame = render(fullState(), { columns: 40, rows: 12 }).join("\n");

      expect(frame).toContain("LIBRARIES");
      expect(frame).toContain("%");
      expect(frame).not.toContain("█");
    });

    it("still says what the libraries are doing in 24 columns", () => {
      const frame = render(fullState(), { columns: 24, rows: 8 }).join("\n");

      expect(frame).toContain("LIBRARIES");
      // The second section is what goes: half a section is better than half a fact.
      expect(frame).not.toContain("SHADERS");
    });
  });

  describe("the group table", () => {
    /** @returns the frame's group rows: the per-library table, and nothing else. */
    const table = (state: MonitorState, size: FrameSize): readonly string[] =>
      render(state, size).filter((line) => /G\d\d /.test(line));

    it("lays the groups out across the window instead of down one column", () => {
      const rows = table(crowdedState(), { columns: 120, rows: 40 });

      // Three cells to a row at 120 columns, which is what turns ten rows of table into
      // thirty groups: progress.json publishes hundreds, and one per row showed six.
      expect(rows.length).toBeGreaterThan(4);
      for (const line of rows) {
        expect(line.match(/G\d\d /g)?.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("fills the first column before the second, so the least-done group is top left", () => {
      const rows = table(crowdedState(0), { columns: 120, rows: 40 });
      const first = rows[0] ?? "";

      expect(first).toContain("G00 ");
      expect(first).not.toContain("G01 ");
      expect(rows[1] ?? "").toContain("G01 ");
    });

    it("says how many of the published groups it is showing", () => {
      const narrow = render(crowdedState(), { columns: 100, rows: 32 }).join("\n");
      const tall = render(crowdedState(), { columns: 200, rows: 60 }).join("\n");

      expect(narrow).toMatch(/\d+ of 60 groups/);
      // A window tall enough for all of them says so without a fraction.
      expect(tall).toContain("60 groups");
      expect(tall).not.toContain("of 60 groups");
    });

    it("marks a group that gained rather than spending a column on the amount", () => {
      const frame = render(crowdedState(), { columns: 120, rows: 40 }).join("\n");

      expect(frame).toContain("▲");
    });

    it("keeps every line inside the window, however many groups there are", () => {
      for (const size of SIZES) {
        for (const line of render(crowdedState(), size)) {
          expect(visibleWidth(line)).toBe(size.columns);
        }
      }
    });
  });

  describe("the hourly charts", () => {
    it("puts readings taken in different hours in different columns, and says where the row starts", () => {
      const frame = render(fullState(), SIZES[0]!).join("\n");

      // 11:45 and 12:00 are two hours, so two columns, and the heading carries the span
      // because a separate axis row is the first thing the allocator drops.
      expect(frame).toContain(
        "HOURLY COVERAGE  11:00 → now · 1 column = 1h · 2 hours held · mean of 1 poll so far",
      );
      expect(frame).toContain("libraries ▁█  49.01 → 49.65 %");
    });

    it("counts the work inside an hour, and names the busiest one", () => {
      const frame = render(spreadState(), SIZES[0]!).join("\n");

      expect(frame).toContain(
        "HOURLY WORK  10:00 → now · 1 column = 1h · peak 11:00 · 40 libraries",
      );
    });

    it("draws no bar at all for an hour in which nothing was finished", () => {
      const frame = render(spreadState(), SIZES[0]!).join("\n");

      // The blank column between the bars is 12:00, which has one poll and no work: a
      // lowest-partial `▁` there would read as "a little" rather than as nothing.
      expect(frame).toContain("libraries ▁█   0 so far this hour");
    });

    it("says so instead of drawing empty columns when no hour finished anything", () => {
      const frame = render(fullState(), SIZES[0]!).join("\n");

      expect(frame).toContain("nothing finished in the hours held");
      expect(frame).not.toContain("so far this hour");
    });

    it("says the chart opens with the first reading rather than drawing an empty axis", () => {
      const frame = render(emptyState(), SIZES[0]!).join("\n");

      expect(frame).toContain(
        "HOURLY COVERAGE  1 column = 1h · the chart opens with the first reading",
      );
    });

    it("drops the charts before it drops the gauges", () => {
      expect(render(fullState(), { columns: 80, rows: 24 }).join("\n")).toContain(
        "HOURLY COVERAGE",
      );
      expect(render(fullState(), { columns: 60, rows: 16 }).join("\n")).not.toContain("HOURLY");
    });
  });

  describe("the now panel", () => {
    it("says what the last poll did, and what the hour in progress has done", () => {
      const frame = render(fullState(), SIZES[0]!).join("\n");

      expect(frame).toContain("NOW  last poll 15m 00s ago · +78 libraries · +116 shaders");
      expect(frame).toContain("this hour from 12:00:00 UTC, 1 poll · no libraries · no shaders");
    });

    it("says which commit the reading came from, shortened to what a reader can copy", () => {
      expect(render(fullState(), SIZES[0]!).join("\n")).toContain("progress.json from 9f3c1aa");
    });
  });

  describe("the log", () => {
    it("receives the rows the rest of the window does not need", () => {
      const frame = render(fullState(), { columns: 100, rows: 46 }).join("\n");

      for (const event of EVENTS) {
        expect(frame).toContain(event.text);
      }
    });

    it("keeps newest last, so the eye lands on what just happened", () => {
      const frame = render(fullState(), { columns: 100, rows: 46 });
      // The live panel also names the release, so the order has to be read inside the
      // log rather than across the whole frame.
      const log = frame.slice(frame.findIndex((line) => line.includes("LOG")) + 1);
      const oldest = log.findIndex((line) => line.includes("first reading"));
      const newest = log.findIndex((line) => line.includes("release v0.1.3"));

      expect(oldest).toBeGreaterThanOrEqual(0);
      expect(newest).toBeGreaterThan(oldest);
    });

    it("shows fewer lines when the window is shorter, rather than squeezing them all", () => {
      const counted = (rows: number): number =>
        render(fullState(), { columns: 100, rows }).filter((line) =>
          line.includes("since the last poll"),
        ).length;

      expect(counted(46)).toBe(1);
      expect(counted(24)).toBeLessThanOrEqual(counted(46));
    });
  });
});
