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
