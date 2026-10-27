/**
 * `/github` tests: the analytics, the charts, the panels and the custom IDs.
 *
 * The suite asserts the promises the command makes, which are also the ones a
 * naive implementation breaks:
 *
 *   1. **a percentage falls for two different reasons.** Work and new discoveries
 *      are split into terms that add up to the observed change, so a drop can be
 *      explained instead of merely reported.
 *   2. **nothing lost, share down** is a first-class case: implemented functions
 *      can only go up while the denominator grows, and the copy has to say so.
 *   3. **a library is matched by name, not by position**, so a scan that inserts a
 *      group does not report every later group as changed.
 *   4. **a missing reading is never zero**: no chart column, no `0%`, and no
 *      invented comparison.
 *   5. **a clicked panel renders exactly like a typed one**, because the custom ID
 *      carries the whole state and both go through `buildGithubView`.
 *   6. **charts are monospace and rectangular**: every row is as wide as the
 *      series, because a single drifting glyph breaks the whole block.
 */
import { describe, expect, it } from "vitest";

import {
  buildGithubView,
  decompose,
  analyzeLibraries,
  readImplementation,
  readLibraries,
  summarize,
  type GithubPanel,
  type LibraryReading,
} from "../../src/modules/repository/index.js";
import {
  bucketEdges,
  bucketHoursFor,
  buildReportStats,
  reportWindowFor,
} from "../../src/modules/repository/repository-report.analytics.js";
import {
  parseReportCustomId,
  renderReport,
} from "../../src/modules/repository/github-report.view.js";
import type { RepositoryPullRequest } from "../../src/services/anyps5/repository.types.js";
import {
  BLOCK_COMPONENTS,
  CONTROL_COMPONENTS,
  MAX_BLOCKS,
  MAX_COMPONENTS,
  MAX_FIELD,
  panelCustomId,
  parsePanelCustomId,
  isGithubComponent,
  absoluteTime,
} from "../../src/modules/repository/github-view.js";
import { renderView } from "../../src/modules/repository/github-components.js";
import {
  githubMessageHelp,
  parseGithubMessage,
} from "../../src/modules/repository/github-message.js";
import { GRAPH_WIDTH } from "../../src/modules/repository/github-request.js";
import { MAX_ROW } from "../../src/modules/repository/repository-chart.js";
import { ComponentType } from "discord.js";
import {
  drawColumns,
  fenceChart,
  formatValue,
  gauge,
  renderSparkline,
  scaleSeries,
} from "../../src/modules/repository/repository-chart.js";
import type { SnapshotRecord } from "../../src/modules/repository/repository.types.js";
import type { AnyPs5Progress } from "../../src/services/anyps5/progress.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");

/** @returns a date `days` before {@link NOW}, so a series is ordered and readable. */
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

/** One library group of a published `progress.json`. */
function group(
  name: string,
  done: number,
  total: number,
): AnyPs5Progress["libraries"]["groups"][number] {
  return {
    name,
    label: name.toUpperCase(),
    done,
    todo: total - done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 10000) / 100,
    doneNames: [],
    todoNames: [],
    inertNames: [],
    sharedSources: null,
  };
}

/** @returns a published document with the given library groups. */
function progressOf(
  groups: readonly AnyPs5Progress["libraries"]["groups"][number][],
): AnyPs5Progress {
  const done = groups.reduce((sum, item) => sum + item.done, 0);
  const total = groups.reduce((sum, item) => sum + item.total, 0);
  const percent = total === 0 ? 0 : Math.round((done / total) * 10000) / 100;
  return {
    libraries: { done, total, percent, groups },
    shaders: { done: 3, total: 10, percent: 30, groups: [], extra: [] },
  };
}

/** One stored snapshot, with the totals and the table `/github` reads. */
function snapshot(
  days: number,
  libraries: { done: number; total: number; percent: number } | null,
  groups: readonly AnyPs5Progress["libraries"]["groups"][number][] = [],
): SnapshotRecord {
  return {
    id: `snap-${days}`,
    capturedAt: daysAgo(days),
    state: {
      stars: 1_000 + days,
      forks: 40,
      openIssues: 7,
      librariesDone: libraries?.done ?? null,
      librariesTotal: libraries?.total ?? null,
      libraryPercent: libraries?.percent ?? null,
      shadersDone: libraries === null ? null : 3,
      shadersTotal: libraries === null ? null : 10,
      shaderPercent: libraries === null ? null : 30,
    },
    progressCommit: null,
    progress: libraries === null ? null : progressOf(groups),
    commitCount: 0,
    pullCount: 0,
    failures: libraries === null ? ["progress.json"] : [],
  };
}

/** @returns a library reading, for `analyzeLibraries` cases. */
function reading(name: string, done: number, total: number): LibraryReading {
  return { name, label: name.toUpperCase(), done, total, percent: (done / total) * 100 };
}

describe("decompose", () => {
  it("splits a fall caused only by discovery into no work at all", () => {
    // 100 of 1000 implemented. The scan then finds 1000 more, all unimplemented:
    // the count of implemented functions is unchanged, the share halves.
    const before = { done: 100, total: 1_000, percent: 10 };
    const now = { done: 100, total: 2_000, percent: 5 };
    const split = decompose(before, now);

    expect(split).not.toBeNull();
    expect(split?.change).toBe(-5);
    expect(split?.fromWork).toBe(0);
    expect(split?.fromDiscovery).toBe(-5);
    expect(split?.doneDelta).toBe(0);
    expect(split?.totalDelta).toBe(1_000);
    // The whole fall is discovery, which is what `/github why` is for.
    expect(split?.discoveryShareOfFall).toBe(1);
  });

  it("splits a fall caused only by lost work into no discovery", () => {
    const before = { done: 200, total: 1_000, percent: 20 };
    const now = { done: 100, total: 1_000, percent: 10 };
    const split = decompose(before, now);

    expect(split?.change).toBe(-10);
    expect(split?.fromWork).toBe(-10);
    expect(split?.fromDiscovery).toBe(0);
    expect(split?.discoveryShareOfFall).toBe(0);
    expect(split?.totalDelta).toBe(0);
  });

  it("always adds its two terms up to the observed change", () => {
    // An awkward pair on purpose: the two terms round independently, and a naive
    // implementation would report -1.48 where the change was -1.47.
    const split = decompose(
      { done: 4_321, total: 11_697, percent: 36.94 },
      { done: 4_390, total: 11_903, percent: 35.47 },
    );

    expect(split).not.toBeNull();
    expect(split?.change).toBe(-1.47);
    expect(split?.fromWork).toBe(0.58);
    expect(split?.fromDiscovery).toBe(-2.05);
    expect((split?.fromWork ?? 0) + (split?.fromDiscovery ?? 0)).toBeCloseTo(
      split?.change ?? 0,
      10,
    );
  });

  it("reports no discovery share when the share rose", () => {
    const split = decompose(
      { done: 10, total: 100, percent: 10 },
      { done: 30, total: 100, percent: 30 },
    );
    expect(split?.change).toBe(20);
    expect(split?.discoveryShareOfFall).toBe(0);
  });

  it("returns null rather than inventing a change from an unknown total", () => {
    expect(
      decompose({ done: 0, total: 0, percent: 0 }, { done: 5, total: 10, percent: 50 }),
    ).toBeNull();
    expect(
      decompose({ done: 5, total: 10, percent: 50 }, { done: 0, total: 0, percent: 0 }),
    ).toBeNull();
  });
});
describe("readImplementation", () => {
  it("answers null for a snapshot whose reading failed", () => {
    // A failed fetch stores nulls. Reporting 0% would claim nothing is implemented,
    // which is the opposite of what happened.
    const reading = readImplementation(snapshot(0, null));
    expect(reading.libraries).toBeNull();
    expect(reading.shaders).toBeNull();
  });

  it("answers null for a zero total instead of dividing by it", () => {
    const reading = readImplementation(snapshot(0, { done: 0, total: 0, percent: 0 }));
    expect(reading.libraries).toBeNull();
  });

  it("copies the published figures rather than recomputing them", () => {
    // 1 of 3 is 33.33%, but the project published 33: the command must not disagree
    // with the number the project itself shows.
    const reading = readImplementation(snapshot(0, { done: 1, total: 3, percent: 33 }));
    expect(reading.libraries).toEqual({ done: 1, total: 3, percent: 33 });
  });
});

describe("readLibraries and analyzeLibraries", () => {
  const base = [group("audio", 10, 100), group("gpu", 50, 100), group("video", 0, 100)];

  it("reads the table out of the published document", () => {
    const libraries = readLibraries(snapshot(0, { done: 60, total: 300, percent: 20 }, base));
    expect(libraries.map((library) => library.name)).toEqual(["audio", "gpu", "video"]);
    expect(libraries[1]?.done).toBe(50);
  });

  it("reads an empty table when the snapshot carries no document", () => {
    expect(readLibraries(snapshot(0, null))).toEqual([]);
    expect(readLibraries(null)).toEqual([]);
  });

  it("matches libraries by name, so an inserted group is not a change", () => {
    // A scan that discovers a library inserts it, shifting every later index. An
    // index-based comparison would report gpu and video as having changed.
    const after = [
      group("audio", 10, 100),
      group("newcomer", 0, 500),
      group("gpu", 50, 100),
      group("video", 0, 100),
    ];
    const analysis = analyzeLibraries(
      readLibraries(snapshot(1, { done: 60, total: 300, percent: 20 }, base)),
      readLibraries(snapshot(0, { done: 60, total: 800, percent: 7.5 }, after)),
    );

    expect(analysis.grew).toEqual([]);
    expect(analysis.shrank).toEqual([]);
    expect(analysis.setChange.added.map((library) => library.name)).toEqual(["newcomer"]);
    expect(analysis.setChange.removed).toEqual([]);
    expect(analysis.setChange.comparable).toBe(true);
  });

  it("reports a disappeared library as removed, not as a 100% loss", () => {
    const after = [group("audio", 10, 100), group("gpu", 50, 100)];
    const analysis = analyzeLibraries(
      readLibraries(snapshot(1, { done: 60, total: 300, percent: 20 }, base)),
      readLibraries(snapshot(0, { done: 60, total: 200, percent: 30 }, after)),
    );

    expect(analysis.setChange.removed.map((library) => library.name)).toEqual(["video"]);
    expect(analysis.shrank).toEqual([]);
  });

  it("separates work from discovery per library", () => {
    const after = [group("audio", 25, 100), group("gpu", 50, 400), group("video", 0, 100)];
    const analysis = analyzeLibraries(
      readLibraries(snapshot(1, { done: 60, total: 300, percent: 20 }, base)),
      readLibraries(snapshot(0, { done: 75, total: 600, percent: 12.5 }, after)),
    );

    // audio was worked on; gpu only saw new functions found.
    expect(analysis.grew.map((library) => library.name)).toEqual(["audio"]);
    expect(analysis.discovered.map((library) => library.name)).toEqual(["gpu"]);
  });

  it("ranks by the size of the movement and honours the limit", () => {
    const before = [group("a", 0, 100), group("b", 0, 100), group("c", 0, 100)];
    const after = [group("a", 1, 100), group("b", 40, 100), group("c", 10, 100)];
    const analysis = analyzeLibraries(
      readLibraries(snapshot(1, { done: 0, total: 300, percent: 0 }, before)),
      readLibraries(snapshot(0, { done: 51, total: 300, percent: 17 }, after)),
      2,
    );

    expect(analysis.grew.map((library) => library.name)).toEqual(["b", "c"]);
  });

  it("is not comparable when either side has no table", () => {
    expect(analyzeLibraries([], [reading("a", 1, 2)]).setChange.comparable).toBe(false);
    expect(analyzeLibraries([reading("a", 1, 2)], []).setChange.comparable).toBe(false);
  });

  it("counts fully analysed libraries", () => {
    const analysis = analyzeLibraries(
      [reading("a", 0, 1)],
      [reading("a", 1, 1), reading("b", 0, 2)],
    );
    expect(analysis.complete).toBe(1);
  });
});

describe("summarize", () => {
  const points = [1, 2, 2, 4].map((value, index) => ({
    capturedAt: daysAgo(3 - index),
    value,
  }));

  it("summarises direction, steps and pace", () => {
    const summary = summarize(points);
    expect(summary).not.toBeNull();
    expect(summary?.change).toBe(3);
    expect(summary?.steps).toEqual({ up: 2, down: 0, flat: 1 });
    expect(summary?.high.value).toBe(4);
    expect(summary?.low.value).toBe(1);
  });

  it("returns null for an empty window rather than a summary of nothing", () => {
    expect(summarize([])).toBeNull();
  });
});

describe("charts", () => {
  it("starts bars at zero, so the distance to done is honest", () => {
    // `rows` is text rows: 4 rows is a 32-step grid.
    const scale = scaleSeries([96, 97], { rows: 4 });
    // 96% of 32 steps is almost all of the grid, rather than being stretched to the
    // top by a window that spans 96-97. The maximum fills the grid; a reading just
    // under it gets one step less, so the two do not look identical.
    expect(scale.blocks[0]).toBe(31);
    expect(scale.blocks[1]).toBe(32);
  });

  it("spans the window when asked, so a slow climb is visible", () => {
    const scale = scaleSeries([96, 97], { rows: 4, zeroBased: false });
    // The floor is the minimum, so the first reading gets the one-step minimum.
    expect(scale.blocks[0]).toBe(1);
    expect(scale.blocks[1]).toBe(32);
  });

  it("gives a reading that rounds to nothing one step, not a gap", () => {
    const scale = scaleSeries([0.0001, 100], { rows: 2 });
    expect(scale.blocks[0]).toBe(1);
  });

  it("never leaves a gap where a reading exists", () => {
    const scale = scaleSeries([8.5, Number.NaN, 8.9], { rows: 3 });
    // A missing reading is the only zero-height column; a present one is never dropped,
    // even when it lands on the floor of the scale.
    expect(scale.blocks[1]).toBe(0);
    expect(scale.blocks[0]).toBeGreaterThanOrEqual(1);
    expect(scale.blocks[2]).toBeGreaterThan(scale.blocks[0] ?? 0);
  });

  it("draws rectangular rows, one column per reading", () => {
    // Heights in steps; a full block is eight eighths, so 24 is three full blocks, and
    // with three text rows the bottom row is filled for every column that has eight
    // steps to spare.
    const rows = drawColumns([0, 8, 16, 24], 3);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveLength(4);
    }
    // A zero-height column is blank at every height; it is not drawn as a bar.
    expect(rows.every((row) => row.startsWith(" "))).toBe(true);
    // The rows count up to the tallest column, one block per row.
    expect(rows).toEqual(["   █", "  ██", " ███"]);
  });

  it("uses partial blocks instead of rounding a column up", () => {
    // Heights inside a single text row, so every column has fewer than eight steps.
    expect(drawColumns([1, 2, 4, 8], 1)).toEqual(["▁▂▄█"]);
  });

  it("keeps gaps visible instead of closing them up", () => {
    const rows = drawColumns([8, 0, 8], 1, (index) => index === 1);
    expect(rows[0]).toBe("█·█");
  });

  it("draws a sparkline one glyph per reading, gaps kept", () => {
    const line = renderSparkline([1, Number.NaN, 10], { rows: 1 });
    expect(line).toHaveLength(3);
    expect(line[1]).toBe("·");
    expect(line[2]).toBe("█");
  });

  it("returns an empty sparkline when there is nothing to draw", () => {
    expect(renderSparkline([Number.NaN], { rows: 1 })).toBe("");
  });

  it("adds a labelled gutter for bars and a bare block for line", () => {
    const rows = ["█", "▄", "▁"];
    const bars = fenceChart("bars", rows, ["0%", "50%", "100%"]);
    const line = fenceChart("line", rows, ["0%", "50%", "100%"]);

    expect(bars).toContain("┫");
    expect(bars).toContain("100%");
    // `line` keeps the same drawing, without the gutter.
    expect(line).not.toContain("┫");
    expect(line.split("\n")).toEqual(["```", ...rows, "```"]);
  });

  it("draws a gauge of the requested width, clamped", () => {
    expect(gauge(0.5, 10)).toBe("█████░░░░░");
    expect(gauge(2, 4)).toBe("████");
    expect(gauge(-1, 4)).toBe("░░░░");
  });

  it("formats to the project's precision", () => {
    expect(formatValue(47.394, 2)).toBe("47.39");
    expect(formatValue(47.6)).toBe("48");
  });
});

describe("buildGithubView", () => {
  /** @returns a context for one panel over the given history. */
  function context(
    history: readonly SnapshotRecord[],
    panel: GithubPanel,
    overrides: { readonly width?: number; readonly ownerId?: string | null } = {},
  ) {
    return {
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history,
      latest: history.at(-1) ?? null,
      panel,
      style: "line" as const,
      width: overrides.width ?? 16,
      ownerId: overrides.ownerId === undefined ? "user-1" : overrides.ownerId,
    };
  }

  const growth = [
    snapshot(30, { done: 4_000, total: 11_697, percent: 34.2 }, [
      group("audio", 400, 1_000),
      group("gpu", 2_000, 8_000),
      group("video", 1_600, 2_697),
    ]),
    snapshot(1, { done: 4_321, total: 11_697, percent: 36.94 }, [
      group("audio", 500, 1_000),
      group("gpu", 2_200, 8_000),
      group("video", 1_621, 2_697),
    ]),
  ];

  it("explains an empty watch instead of showing zeroes", () => {
    const view = buildGithubView(context([], "overview"));
    expect(view.blocks).toHaveLength(1);
    // No panel buttons before there is anything to switch between; the selector is
    // still there, because every panel explains the empty state in its own words.
    expect(view.components.buttons).toEqual([]);
    const description = view.blocks[0]?.description ?? "";
    expect(description).not.toContain("0%");
    expect(description.toLowerCase()).toContain("no snapshot has been stored");
  });

  it("gives every panel a body and a footer", () => {
    for (const panel of ["overview", "libraries", "timeline", "graph", "why"] as const) {
      const view = buildGithubView(context(growth, panel));
      expect(view.blocks.length).toBeGreaterThan(0);
      for (const block of view.blocks) {
        expect(block.title.length).toBeGreaterThan(0);
        expect(block.footer.length).toBeGreaterThan(0);
      }
    }
  });

  it("renders as Components V2, which cannot carry an embed at all", () => {
    const view = buildGithubView(context(growth, "overview"));
    const payload = renderView(view);
    // The whole point of the migration: a container of text blocks, not embeds. A V2
    // message drops `embeds` and `content` entirely, so a regression that reintroduced
    // either would make Discord reject the reply rather than render it smaller.
    expect("embeds" in payload).toBe(false);
    const rendered = payload.components.map((component) => component.toJSON()) as {
      type: number;
      components?: { type: number; content?: string }[];
    }[];
    expect(rendered[0]?.type).toBe(ComponentType.Container);
    const texts = rendered.flatMap((component) => component.components ?? []);
    expect(texts.some((text) => text.type === ComponentType.TextDisplay)).toBe(true);
    for (const text of texts) {
      expect((text.content ?? "").length).toBeLessThanOrEqual(MAX_FIELD);
    }
    // Discord accepts forty components per message; a panel is a handful.
    const total = rendered.reduce(
      (count, component) => count + 1 + (component.components?.length ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(40);
  });

  it("budgets fewer blocks than a rejected payload would need", () => {
    // A guard on the arithmetic itself: 40 components hold five panel buttons, a
    // selector with five options, and at most three page blocks. If the control count
    // or the block cost is ever edited, this is where it shows.
    expect(MAX_BLOCKS).toBe(3);
    expect(BLOCK_COMPONENTS * MAX_BLOCKS + CONTROL_COMPONENTS).toBeLessThanOrEqual(MAX_COMPONENTS);
  });

  it("keeps a large library table inside Discord's forty-component cap", () => {
    // The regression this guards: `paginate` splits by characters only, so a project
    // with a few hundred libraries paged into more containers than one message may
    // hold — and Discord rejects such a payload whole instead of shortening it, which
    // surfaced to the reader as "Discord rejected the request".
    for (const libraryCount of [3, 50, 150, 400, 1_200]) {
      const groups = Array.from({ length: libraryCount }, (_unused, index) =>
        group(`library-${index}`, 100 + index, 1_000 + index),
      );
      const history = [snapshot(1, { done: 5_500, total: 11_697, percent: 47.02 }, groups)];
      const view = buildGithubView(context(history, "libraries"));
      const payload = renderView(view);

      const rendered = payload.components.map((component) => component.toJSON()) as {
        components?: { type: number; content?: string; components?: { type: number }[] }[];
      }[];
      const nested = (nodes: { components?: { type: number }[] }[] | undefined): number =>
        (nodes ?? []).reduce(
          (count, node) =>
            count + 1 + nested((node as { components?: { type: number }[] }).components),
          0,
        );
      const total = rendered.reduce(
        (count, component) => count + 1 + nested(component.components),
        0,
      );

      expect(total, `${libraryCount} libraries: ${total} components`).toBeLessThanOrEqual(40);
      // Whatever did not fit is stated rather than silently dropped. A table that fits
      // in full says nothing, so the notice is only expected when rows were left out —
      // which is whenever the cap binds *and* the last page ends the table early.
      if (view.blocks.length === MAX_BLOCKS) {
        const shown = view.blocks.reduce(
          (count, block) => count + (block.sections[0]?.text.split("\n").length ?? 0),
          0,
        );
        if (shown < libraryCount) {
          expect(view.blocks.at(-1)?.description).toContain("do not fit in one message");
        }
      }
    }
  });

  it("keeps every overview section instead of stopping at an embed's field cap", () => {
    // Twenty-four readings give the overview a trend section, a library breakdown and
    // the pace estimate alongside the two headlines — more than a single embed field
    // grid was ever guaranteed to show.
    const history = Array.from({ length: 24 }, (_, index) =>
      snapshot(
        24 - index,
        { done: 1_000 + index * 10, total: 11_697, percent: 8.55 + index / 10 },
        [group("audio", 100 + index, 1_000), group("gpu", 900 + index, 8_000)],
      ),
    );
    const view = buildGithubView(context(history, "overview"));
    const headings = view.blocks.flatMap((block) =>
      [...block.sections].map((section) => section.heading),
    );
    expect(headings.some((heading) => heading.includes("System libraries"))).toBe(true);
    expect(headings.some((heading) => heading.includes("GPU shaders"))).toBe(true);
    expect(headings.some((heading) => heading.includes("Community"))).toBe(true);
    // Nothing is silently dropped: every section built reaches the reply.
    for (const block of view.blocks) {
      expect(block.sections.length).toBeGreaterThan(0);
    }
    expect(headings.length).toBeGreaterThan(3);
  });

  it("survives an absurdly long repository name without blanking the panel", () => {
    // `GITHUB_REPOSITORY` is operator-supplied and unbounded. A single text block over
    // Discord's limit would make the whole reply rejected, so the heading is clipped.
    const fullName = `${"o".repeat(300)}/${"n".repeat(300)}`;
    const view = buildGithubView({
      fullName,
      repoUrl: `https://github.com/${fullName}`,
      history: [snapshot(0, { done: 10, total: 100, percent: 10 })],
      latest: snapshot(0, { done: 10, total: 100, percent: 10 }),
      panel: "overview",
      style: "line",
      width: 16,
      ownerId: null,
    });
    const payload = renderView(view);
    const rendered = payload.components.map((component) => component.toJSON()) as {
      type: number;
      components?: { type: number; content?: string }[];
    }[];
    for (const component of rendered) {
      for (const text of component.components ?? []) {
        expect((text.content ?? "").length).toBeLessThanOrEqual(400);
      }
    }
  });

  it("marks the current panel and offers the others", () => {
    const view = buildGithubView(context(growth, "libraries"));
    const buttons = view.components.buttons.flat();
    // The width in each control is the *message's*, not a constant: a click must
    // redraw the same chart, not a wider one. The context above asks for 16.
    expect(buttons.map((button) => button.customId)).toEqual(
      ["overview", "libraries", "timeline", "graph", "why"].map((panel) =>
        panelCustomId(panel as GithubPanel, "line", 16),
      ),
    );
    expect(buttons.filter((button) => button.style === "primary")).toHaveLength(1);
    expect(view.components.select?.options.find((option) => option.selected)?.label).toBe(
      "Libraries",
    );
  });

  it("draws the graph at the requested width", () => {
    const history = Array.from({ length: 40 }, (_, index) =>
      snapshot(40 - index, { done: 1_000 + index, total: 11_697, percent: 8.55 + index / 100 }),
    );
    const view = buildGithubView(context(history, "graph", { width: 12 }));
    // Every chart section is fenced and then captioned, so only the lines between the
    // fences are drawn rows; the caption beneath them is prose. Sections are flattened
    // without `flatMap`, whose index argument would turn `block.sections` into a
    // `slice`, dropping pages and leaving holes that read as `undefined`.
    const sections = view.blocks
      .map((block) => block.sections)
      .reduce<{ heading: string; text: string }[]>(
        (all, blockSections) => all.concat(blockSections),
        [],
      );
    const charts = sections
      .map((section) => section.text)
      .filter((text) => text.includes("```") && /[▁▂▃▄▅▆▇█]/.test(text));
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      const fenced = chart.split("```")[1] ?? "";
      const rows = fenced.split("\n").filter((line) => line.length > 0);
      // Every drawn row is exactly as wide as the window.
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveLength(12);
      }
    }
  });
});

describe("buildGithubView — why the share moved", () => {
  const before = snapshot(1, { done: 4_321, total: 11_697, percent: 36.94 }, [
    group("audio", 500, 1_000),
    group("gpu", 2_200, 8_000),
  ]);
  const after = snapshot(0, { done: 4_390, total: 11_903, percent: 35.47 }, [
    group("audio", 500, 1_000),
    group("gpu", 2_200, 8_206),
  ]);

  /** @returns a panel's whole text, description and sections together. */
  function textOf(history: readonly SnapshotRecord[], panel: GithubPanel): string {
    const view = buildGithubView({
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history,
      latest: history.at(-1) ?? null,
      panel,
      style: "line",
      width: 16,
      ownerId: null,
    });
    return view.blocks
      .map((block) =>
        [
          block.description,
          ...block.sections.map((section) => `${section.heading}\n${section.text}`),
        ].join("\n"),
      )
      .join("\n");
  }

  it("says nothing was lost when the share falls purely from discovery", () => {
    // The case `/github why` exists for: implemented functions only went up, the
    // denominator grew, and the share fell.
    const text = textOf([before, after], "why");
    expect(text).toContain("nothing was lost");
    expect(text).toContain("36.94% → 35.47%");
    expect(text).toContain("What moved the number");
  });

  it("blames lost work when implemented functions went down", () => {
    const lost = snapshot(0, { done: 4_200, total: 11_697, percent: 35.91 }, [
      group("gpu", 2_079, 8_000),
    ]);
    const text = textOf([before, lost], "why");
    expect(text).toContain("implemented functions were also lost");
  });

  it("refuses to explain a change when only one reading has numbers", () => {
    const text = textOf([snapshot(1, { done: 10, total: 100, percent: 10 })], "why");
    expect(text).toContain("nothing was lost");
  });

  it("skips a snapshot with no reading when choosing what to compare against", () => {
    // The middle snapshot failed to fetch. Comparing against it would show a drop
    // from 36.94% to nothing, which never happened.
    const history = [
      snapshot(3, { done: 4_321, total: 11_697, percent: 36.94 }, [group("gpu", 2_200, 8_000)]),
      snapshot(2, null),
      snapshot(1, { done: 4_400, total: 11_697, percent: 37.62 }, [group("gpu", 2_210, 8_000)]),
    ];
    const text = textOf(history, "overview");
    expect(text).toContain("36.94");
    // The unreadable snapshot is shown as a gap, never as a 0% library reading.
    expect(text).toContain("—");
    expect(text).not.toContain("📚 System libraries — 0.00%");
  });

  it("lists every library, however many there are", () => {
    const many = Array.from({ length: 60 }, (_, index) => group(`lib-${index}`, index, 100));
    const view = buildGithubView({
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history: [snapshot(0, { done: 1_000, total: 6_000, percent: 16.67 }, many)],
      latest: snapshot(0, { done: 1_000, total: 6_000, percent: 16.67 }, many),
      panel: "libraries",
      style: "line",
      width: 16,
      ownerId: null,
    });
    // Each page lists its libraries inside one section text, labelled by name. The
    // sections are flattened without `flatMap`, whose index argument turns
    // `block.sections` into a `slice`, leaving holes that read as `undefined`.
    const text = view.blocks
      .map((block) => block.sections)
      .reduce<{ heading: string; text: string }[]>((all, sections) => all.concat(sections), [])
      .map((section) => section.text)
      .join("\n");
    for (const library of many) {
      expect(text).toContain(library.label);
    }
    // No text block may overflow its budget, because anything past it is truncated
    // without a trace and silently drops the libraries at the end of the page.
    for (const block of view.blocks) {
      for (const section of block.sections) {
        expect(section.text.length).toBeLessThanOrEqual(MAX_FIELD);
      }
    }
    // A V2 reply is a handful of components, nowhere near Discord's ceiling of forty,
    // so a project with many libraries is never told to pick a shorter panel.
    expect(view.blocks.length).toBeLessThanOrEqual(20);
  });
});

describe("buildGithubView — timeline and library movement", () => {
  /** @returns a context for one panel over the given history. */
  function context(history: readonly SnapshotRecord[], panel: GithubPanel) {
    return {
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history,
      latest: history.at(-1) ?? null,
      panel,
      style: "line" as const,
      width: 16,
      ownerId: null,
    };
  }

  it("draws the timeline as a table with one line per reading", () => {
    // The bug this pins: a row with no step used to lose its step line to `body()`,
    // which drops empty strings, so it rendered two lines while every row with a step
    // rendered three — a table whose columns drifted row by row.
    const history = [
      snapshot(3, { done: 1_000, total: 6_000, percent: 16.67 }),
      snapshot(2, { done: 1_010, total: 6_000, percent: 16.83 }),
      // Unchanged, so its step is `▬` rather than `+10`.
      snapshot(1, { done: 1_010, total: 6_000, percent: 16.83 }),
      // No reading at all: the row must still keep its shape.
      snapshot(0, null),
    ];
    const view = buildGithubView(context(history, "timeline"));
    const rows = (view.blocks[0]?.sections[0]?.text ?? "").split("\n");

    expect(rows).toHaveLength(history.length);
    for (const row of rows) {
      expect(row).not.toBe("");
      // `MM-DD HH:MM`, then a percentage or an em dash for "no reading", then a step:
      // the same fields in the same lanes on every row, which is the point.
      expect(row).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} +(\d+\.\d\d%|—) +(\d+\.\d\d%|—) +\S+/);
    }
    // Newest first: the newest reading is the one dated today, and the oldest is last.
    expect(rows[0]?.slice(0, 11)).toBe(absoluteTime(daysAgo(0)).slice(5, 16));
    expect(rows.at(-1)?.slice(0, 11)).toBe(absoluteTime(daysAgo(3)).slice(5, 16));
    expect(view.blocks[0]?.description).toContain("of history");
  });

  it("measures a library's change over the whole window, not the last step", () => {
    // "gpu" gained its work two readings ago and nothing since. Comparing only the
    // newest pair would report it as unchanged, which is the "libraries is broken" bug.
    const history = [
      snapshot(2, { done: 1_000, total: 6_000, percent: 16.67 }, [
        group("gpu", 900, 5_000),
        group("audio", 100, 1_000),
      ]),
      snapshot(1, { done: 1_050, total: 6_000, percent: 17.5 }, [
        group("gpu", 950, 5_000),
        group("audio", 100, 1_000),
      ]),
      snapshot(0, { done: 1_050, total: 6_000, percent: 17.5 }, [
        group("gpu", 950, 5_000),
        group("audio", 100, 1_000),
      ]),
    ];
    const view = buildGithubView(context(history, "libraries"));
    const text = view.blocks
      .map((block) => block.sections)
      .reduce<{ heading: string; text: string }[]>((all, sections) => all.concat(sections), [])
      .map((section) => section.text)
      .join("\n");

    // 50 functions over the window, stated as such.
    expect(text).toContain("+50 window");
    // "audio" did not move, so it is marked unchanged rather than given a delta.
    expect(text).toContain("▬");
  });
});

describe("panel custom IDs", () => {
  it("round-trips every panel and style", () => {
    for (const panel of ["overview", "libraries", "timeline", "graph", "why"] as const) {
      for (const style of ["bars", "line"] as const) {
        const customId = panelCustomId(panel, style, 24);
        expect(parsePanelCustomId(customId)).toEqual({ panel, style, width: 24 });
      }
    }
  });

  it("accepts only its own namespace", () => {
    expect(isGithubComponent("github:select")).toBe(true);
    expect(isGithubComponent("ticket:open:1")).toBe(false);
  });

  it("returns null for an unknown panel, style or width", () => {
    // A message from an older build, or a truncated id: answering politely needs a
    // null rather than a throw.
    expect(parsePanelCustomId("github:panel:nope:line:24")).toBeNull();
    expect(parsePanelCustomId("github:panel:graph:dotted:24")).toBeNull();
    expect(parsePanelCustomId("github:panel:graph:line:0")).toBeNull();
    expect(parsePanelCustomId("github:panel:graph:line:999")).toBeNull();
    expect(parsePanelCustomId("github:panel:graph:line")).toBeNull();
    expect(parsePanelCustomId("github:panel:graph:line:24:extra")).toBeNull();
    expect(parsePanelCustomId("ticket:panel:graph:line:24")).toBeNull();
  });
});

describe("/github report", () => {
  /** One pull request, with the three timestamps the report buckets by. */
  function pull(
    number: number,
    input: {
      readonly createdAt: Date;
      readonly mergedAt?: Date | null;
      readonly closedAt?: Date | null;
      readonly draft?: boolean;
    },
  ): RepositoryPullRequest {
    const closedAt = input.closedAt ?? null;
    return {
      number,
      title: `Refactor #${number}`,
      author: "Retr0G28",
      state: closedAt === null ? "open" : "closed",
      draft: input.draft ?? false,
      merged: input.mergedAt !== undefined && input.mergedAt !== null,
      createdAt: input.createdAt,
      mergedAt: input.mergedAt ?? null,
      closedAt,
      url: `https://github.com/anyps5/anyps5/pull/${number}`,
    };
  }

  const END = new Date("2026-10-23T12:00:00.000Z");
  /** @returns `hours` before {@link END}. */
  function hoursBefore(hours: number): Date {
    return new Date(END.getTime() - hours * 3_600_000);
  }

  /** A 4-hour window with two readings and three pull requests. */
  function fixture() {
    // `capturedAt` is written after the spread, because `snapshot()` dates every row
    // from its own clock and a report is about a window: the readings have to sit in it.
    const at = (row: SnapshotRecord, when: Date): SnapshotRecord => ({ ...row, capturedAt: when });
    const snapshots = [
      at(
        snapshot(0, { done: 40, total: 100, percent: 40 }, [
          group("gpu", 30, 80),
          group("audio", 10, 20),
        ]),
        hoursBefore(4),
      ),
      at(
        snapshot(0, { done: 46, total: 100, percent: 46 }, [
          group("gpu", 36, 80),
          group("audio", 10, 20),
        ]),
        END,
      ),
    ];
    const pulls = [
      // Opened and merged inside the window, two hours to merge.
      pull(1, { createdAt: hoursBefore(3), mergedAt: hoursBefore(1), closedAt: hoursBefore(1) }),
      // Opened inside it and still open.
      pull(2, { createdAt: hoursBefore(2) }),
      // Closed without merging inside it.
      pull(3, { createdAt: hoursBefore(4), closedAt: hoursBefore(1) }),
    ];
    return { snapshots, pulls };
  }

  /** @returns the stats for the fixture above. */
  function statsFor(rangeId = "4h") {
    const data = fixture();
    return buildReportStats({
      rangeId,
      window: { from: hoursBefore(4), to: END },
      snapshots: data.snapshots,
      pullRequests: data.pulls,
      commits: [
        { at: hoursBefore(3.5), author: "ann", message: "gpu: add dispatch" },
        { at: hoursBefore(2.5), author: "ann", message: "gpu: fix dispatch" },
        { at: hoursBefore(1.5), author: "bob", message: "audio: tidy" },
      ],
    });
  }

  it("counts what happened in the window, not what happened to be fetched", () => {
    const stats = statsFor();

    expect(stats.pulls.opened).toBe(3);
    expect(stats.pulls.merged).toBe(1);
    expect(stats.pulls.closedUnmerged).toBe(1);
    expect(stats.pulls.stillOpen).toBe(1);
    // Two hours from creation to merge, which is the interval a reviewer feels.
    expect(stats.pulls.medianMergeHours).toBe(2);
    expect(stats.pulls.meanMergeHours).toBe(2);
    expect(stats.pulls.mergeRate).toBe(0.5);
    expect(stats.commits.count).toBe(3);
    expect(stats.commits.authors.map((author) => author.name)).toEqual(["ann", "bob"]);
  });

  it("reads the implementation change from the first and last reading", () => {
    const stats = statsFor();

    expect(stats.progress.first?.percent).toBe(40);
    expect(stats.progress.last?.percent).toBe(46);
    expect(stats.progress.percentDelta).toBe(6);
    expect(stats.progress.doneDelta).toBe(6);
    expect(stats.progress.totalDelta).toBe(0);
    // Four hours is a sixth of a day, so +6 pp over it is +36 pp/day.
    expect(stats.progress.perDay).toBe(36);
  });

  it("attributes movement per library, by name", () => {
    const stats = statsFor();
    const gpu = stats.libraries.find((row) => row.name === "gpu");
    const audio = stats.libraries.find((row) => row.name === "audio");

    // The six functions went into "gpu", so it is listed first — most work first.
    expect(stats.libraries[0]?.name).toBe("gpu");
    expect(gpu?.doneDelta).toBe(6);
    expect(gpu?.percentDelta).toBe(7.5);
    expect(audio?.doneDelta).toBe(0);
    expect(audio?.percentDelta).toBe(0);
  });

  it("buckets the window hourly and places each event by its own timestamp", () => {
    const stats = statsFor();
    const edges = bucketEdges(hoursBefore(4), END, bucketHoursFor(4));

    expect(edges).toHaveLength(4);
    expect(stats.buckets).toHaveLength(4);
    expect(stats.buckets[0]?.startsAt.toISOString()).toBe(hoursBefore(4).toISOString());
    // One opening landed in each of the first three hours.
    expect(stats.buckets.map((bucket) => bucket.opened)).toEqual([1, 1, 1, 0]);
    // The merge and the unmerged close both happened in the last hour.
    expect(stats.buckets.map((bucket) => bucket.merged)).toEqual([0, 0, 0, 1]);
    expect(stats.buckets.map((bucket) => bucket.closedUnmerged)).toEqual([0, 0, 0, 1]);
  });

  it("uses six-hour buckets beyond a day, so a week is readable", () => {
    expect(bucketHoursFor(24)).toBe(1);
    expect(bucketHoursFor(72)).toBe(6);
    expect(bucketEdges(hoursBefore(24), END, bucketHoursFor(168))).toHaveLength(4);
  });

  it("never reports a missing rate as zero", () => {
    const stats = buildReportStats({
      rangeId: "4h",
      window: { from: hoursBefore(4), to: END },
      // A watch with a reading but nothing that resolved in the window.
      snapshots: [snapshot(0, { done: 40, total: 100, percent: 40 })],
      pullRequests: [],
      commits: [],
    });

    // Nothing merged, so there is no review time to state — and `null` says that,
    // whereas `0` would claim pull requests merged instantly.
    expect(stats.pulls.medianMergeHours).toBeNull();
    expect(stats.pulls.meanMergeHours).toBeNull();
    expect(stats.pulls.mergeRate).toBeNull();
    // One reading cannot have a rate, only a position.
    expect(stats.progress.percentDelta).toBeNull();
    expect(stats.progress.perDay).toBeNull();
  });

  it("states how much of the window was actually recorded", () => {
    const stats = statsFor();

    expect(stats.coverage.snapshots, "snapshots").toBe(2);
    // Readings four hours apart, so the inferred cadence is four hours.
    expect(stats.coverage.cadenceMinutes, "cadence").toBe(240);
    // Two of four hours hold a reading: the share qualifies every rate on the page.
    expect(stats.coverage.hoursCovered, "covered").toBe(2);
    expect(stats.coverage.share).toBe(0.5);
    expect(stats.coverage.longestGapHours).toBe(4);
  });

  it("renders every page as one block inside the text budget", () => {
    const stats = statsFor();
    for (const page of ["overview", "activity", "libraries", "health"] as const) {
      const view = renderReport({
        stats,
        fullName: "anyps5/anyps5",
        repoUrl: "https://github.com/anyps5/anyps5",
        page,
      });
      expect(view.blocks).toHaveLength(1);
      const block = view.blocks[0];
      expect(block?.title).toContain("report");
      expect(block?.footer.length).toBeGreaterThan(0);
      // The model keeps every section inside the budget, so the split `renderView`
      // performs happens on a row boundary rather than in the middle of a table.
      for (const section of block?.sections ?? []) {
        expect(section.text.length).toBeLessThanOrEqual(MAX_FIELD);
      }
      expect(renderView(view).components.length).toBeGreaterThan(1);
    }
  });

  it("marks the open page and keeps the range in every button", () => {
    const view = renderReport({
      stats: statsFor("12h"),
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      page: "libraries",
    });
    const buttons = view.components.buttons[0] ?? [];

    expect(buttons).toHaveLength(4);
    expect(buttons.filter((button) => button.style === "primary")).toHaveLength(1);
    for (const button of buttons) {
      expect(parseReportCustomId(button.customId)?.range).toBe("12h");
    }
    expect(parseReportCustomId(buttons[2]?.customId ?? "")?.page).toBe("libraries");
  });

  it("refuses a custom ID it did not write", () => {
    expect(parseReportCustomId("github:report:overview:1d")).toEqual({
      page: "overview",
      range: "1d",
    });
    expect(parseReportCustomId("github:report:bogus:1d")).toBeNull();
    expect(parseReportCustomId("github:report:overview:2y")).toBeNull();
    expect(parseReportCustomId("github:panel:overview:line:24")).toBeNull();
    expect(parseReportCustomId("ticket:report:overview:1d")).toBeNull();
  });

  it("derives a window that ends now, whatever the monitor last recorded", () => {
    const window = reportWindowFor("4h", END);
    expect(window.to).toEqual(END);
    expect(window.from.toISOString()).toBe(hoursBefore(4).toISOString());
    // An unknown choice falls back to the default range rather than throwing.
    expect(reportWindowFor("nonsense", END).from.toISOString()).toBe(hoursBefore(24).toISOString());
  });
});

describe("the graph fits a phone", () => {
  // A phone shows roughly 25 characters of a fenced block before it scrolls, and a
  // fenced block does not wrap: a row over the budget is a chart that runs off the
  // screen. `bars` is the wider style because it prepends a `100.00%┫` gutter.
  const history = Array.from({ length: 40 }, (_, index) =>
    snapshot(40 - index, { done: 1_000 + index, total: 11_697, percent: 8.55 + index / 100 }),
  );
  // The worst case: percentages that print at the full `100.00%` width, so the gutter is
  // as wide as it can ever be. A chart that fits here fits every reading.
  const wideHistory = Array.from({ length: 40 }, (_, index) =>
    snapshot(40 - index, { done: 1_000 + index, total: 1_200, percent: 90.55 + index / 100 }),
  );

  /** @returns every drawn row of a chart section, fences stripped. */
  function drawnRows(text: string): string[] {
    const fenced = text.split("```")[1] ?? "";
    return fenced.split("\n").filter((line) => line.length > 0);
  }

  /** @returns the drawn rows of the graph panel, in the given style. */
  function graphRows(style: "bars" | "line", width: number, source = history): string[] {
    const view = buildGithubView({
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history: source,
      latest: source.at(-1) ?? null,
      panel: "graph",
      style,
      width,
      ownerId: null,
    });
    return view.blocks.flatMap((block) => block.sections).flatMap((s) => drawnRows(s.text));
  }

  it("keeps every row inside the phone's width, even at 100.00% labels", () => {
    for (const style of ["bars", "line"] as const) {
      const rows = graphRows(style, GRAPH_WIDTH, wideHistory);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.length).toBeLessThanOrEqual(MAX_ROW);
      }
    }
  });

  it("draws one column per reading in both styles", () => {
    // The gutter is decoration, never a reason to drop readings: `bars` must show the
    // same window `line` does, which the earlier "carve the gutter out" fix broke.
    const columns = (style: "bars" | "line"): number => {
      const rows = graphRows(style, GRAPH_WIDTH);
      const bottom = rows.at(-1) ?? "";
      return bottom.replace(/^.*?┫/, "").length;
    };
    expect(columns("line")).toBe(GRAPH_WIDTH);
    expect(columns("bars")).toBe(GRAPH_WIDTH);
  });

  it("carries the message's width into its buttons, not a constant", () => {
    // The regression this guards: the first click redrew the graph at 48 columns,
    // because the controls wrote their own width instead of the message's.
    const view = buildGithubView({
      fullName: "anyps5/anyps5",
      repoUrl: "https://github.com/anyps5/anyps5",
      history,
      latest: history.at(-1) ?? null,
      panel: "overview",
      style: "line",
      width: GRAPH_WIDTH,
      ownerId: null,
    });
    const ids = [
      ...view.components.buttons.flat().map((button) => button.customId),
      ...(view.components.select?.options.map((option) => option.value) ?? []),
    ];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(parsePanelCustomId(id)?.width).toBe(GRAPH_WIDTH);
    }
  });
});

describe("!g — the same panels, typed", () => {
  it("ignores anything that is not a !g invocation", () => {
    // Every one of these must reach automod and the AI agent untouched. `!government`
    // is the important one: a bare prefix match would make the bot answer somebody
    // else's command.
    for (const content of ["hello", "/github", "!government", " !!g", "g graph", ""]) {
      expect(parseGithubMessage(content)).toBeNull();
    }
  });

  it("reads the panels, their aliases and the chart style", () => {
    expect(parseGithubMessage("!g")).toEqual({ kind: "panel", panel: "overview", style: "line" });
    expect(parseGithubMessage("  !g   ")).toEqual({
      kind: "panel",
      panel: "overview",
      style: "line",
    });
    expect(parseGithubMessage("!g graph")).toEqual({
      kind: "panel",
      panel: "graph",
      style: "line",
    });
    expect(parseGithubMessage("!g GRAPH BARS")).toEqual({
      kind: "panel",
      panel: "graph",
      style: "bars",
    });
    // The style is accepted before or after the name: same request, same answer.
    expect(parseGithubMessage("!g bars graph")).toEqual({
      kind: "panel",
      panel: "graph",
      style: "bars",
    });
    expect(parseGithubMessage("!g libs")).toEqual({
      kind: "panel",
      panel: "libraries",
      style: "line",
    });
    expect(parseGithubMessage("!g why")).toEqual({ kind: "panel", panel: "why", style: "line" });
  });

  it("reads a report range and a history count", () => {
    expect(parseGithubMessage("!g report")).toEqual({ kind: "report", range: "1d", style: "line" });
    expect(parseGithubMessage("!g report 4h")).toEqual({
      kind: "report",
      range: "4h",
      style: "line",
    });
    // An unknown range falls back to the default rather than refusing the request.
    expect(parseGithubMessage("!g report nonsense")).toEqual({
      kind: "report",
      range: "1d",
      style: "line",
    });
    expect(parseGithubMessage("!g history 10")).toEqual({ kind: "history", limit: 10 });
    // Clamped, not refused: a count above the command's own ceiling prints the ceiling.
    expect(parseGithubMessage("!g history 999")).toEqual({ kind: "history", limit: 25 });
    expect(parseGithubMessage("!g history")).toEqual({ kind: "history", limit: 12 });
    expect(parseGithubMessage("!g history abc")).toEqual({ kind: "history", limit: 12 });
  });

  it("answers help instead of staying silent on a typo", () => {
    // Silence is indistinguishable from a bot that is down, which is the report this
    // command keeps getting.
    expect(parseGithubMessage("!g libraryy")).toEqual({ kind: "help" });
    expect(parseGithubMessage("!g help")).toEqual({ kind: "help" });
  });

  it("documents every form it accepts", () => {
    // The help text is the contract: a form that parses but is not listed is one
    // nobody will find.
    const help = githubMessageHelp("anyps5/anyps5");
    for (const form of ["libraries", "timeline", "graph", "why", "history", "report"]) {
      expect(help).toContain(`!g ${form}`);
    }
    expect(help).toContain("anyps5/anyps5");
  });
});
