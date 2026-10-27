/**
 * `/github` as data: the panels, the embeds and the components behind them.
 *
 * Pure. It reads snapshots the monitor already stored and returns plain objects —
 * titles, fields, buttons — with no discord.js in sight, so the wording, the
 * arithmetic and the layout are all testable against arrays, and the command file
 * stays a thin "fetch, then render" adapter.
 *
 * Two rules are structural rather than stylistic:
 *
 * - **Nothing is recomputed that was recorded.** Every figure shown is read from a
 *   snapshot (or summed from snapshots); the analytics helpers only subtract them.
 *   `/github` therefore cannot disagree with the hourly report.
 * - **A gap is never zero.** Snapshot fields are nullable, and most of this file
 *   exists to keep "no reading" out of the averages and the charts.
 */
import type { SnapshotRecord } from "./repository.types.js";
import {
  analyzeLibraries,
  decompose,
  implementationPoints,
  lastComparableIndex,
  libraryMovement,
  readImplementation,
  readLibraries,
  round2,
  summarize,
  type Decomposition,
  type ImplementationReading,
  type ImplementationSeries,
  type LibraryAnalysis,
  type LibraryMovementRow,
  type LibraryReading,
  type SeriesPoint,
  type TrendSummary,
} from "./repository-analytics.js";
import {
  drawColumns,
  fenceChart,
  formatValue,
  gauge,
  MAX_ROW,
  BAR_GUTTER,
  renderSparkline,
  scaleSeries,
  type ChartStyle,
} from "./repository-chart.js";
import { formatCount } from "./repository.events.js";

/**
 * The most text one block of a reply may hold.
 *
 * Raised from 1024 when the panels moved to Components V2: an embed field capped at
 * 1024 characters, so the library table had to be split into 1024-character pages and
 * the overview had to drop sections past its twenty-fifth field. A text block has no
 * such grid, so the table pages on its own size and the overview keeps every section.
 */
export const MAX_FIELD = 4_000;
/** Characters allowed in one section heading, matching an embed field's name. */
export const MAX_FIELD_NAME = 256;
/** Characters allowed in a panel's introduction. */
export const MAX_DESCRIPTION = 4_096;

/**
 * Components Discord accepts in one message, from the Components V2 reference:
 * "Messages allow up to 40 total components".
 *
 * The count is of *every* component, not just the top-level ones, so a panel is
 * budgeted in whole blocks rather than in characters alone.
 */
export const MAX_COMPONENTS = 40;

/**
 * What the buttons and the selector cost: five panel buttons in one action row, the
 * selector row itself, and the five options inside it.
 */
export const CONTROL_COMPONENTS = 5 + 1 + 5;

/**
 * What one page block costs inside its container, measured against a real paginated
 * table: the heading, the description, a separator, a heading and a body text display
 * for the section, then a separator and the footer.
 *
 * Taken at the *most expensive* shape. A block with an empty description is one
 * cheaper, and a body that splits across several text displays is one more per extra
 * piece; budgeting for the common case keeps that split from pushing a full message
 * over the cap.
 */
export const BLOCK_COMPONENTS = 8;

/**
 * The most page blocks one message may carry.
 *
 * Derived rather than guessed: {@link MAX_COMPONENTS} in total, minus what the buttons
 * and selector cost, divided by what one block costs. Being one block short is a
 * shorter table, while being one block over is a reply Discord rejects whole — so the
 * block cost is taken at its most expensive and the division rounds down.
 */
export const MAX_BLOCKS = Math.max(
  1,
  Math.floor((MAX_COMPONENTS - CONTROL_COMPONENTS) / BLOCK_COMPONENTS),
);

/** The panels `/github` can show, and the buttons that switch between them. */
export type GithubPanel = "overview" | "libraries" | "timeline" | "graph" | "why";

/** A section of a panel: a heading, then its text. */
export interface ViewSection {
  readonly heading: string;
  readonly text: string;
}

/**
 * One rendered block of a reply, as data.
 *
 * Shaped like a Components V2 container and not like an embed: an embed gave every
 * figure a 1024-character field inside a 25-field grid, which is what forced the
 * library table into pages and let the overview drop its tail. A block is an accent
 * colour, an introduction, and as many sections as the panel actually has.
 */
export interface ViewBlock {
  readonly title: string;
  readonly url: string | null;
  /** The introduction: when the snapshot was taken and what it describes. */
  readonly description: string;
  /** 0 to 0xffffff; picked from the panel's own palette. */
  readonly color: number;
  readonly sections: readonly ViewSection[];
  readonly footer: string;
}

/** A button, as data. */
export interface ComponentButton {
  readonly customId: string;
  readonly label: string;
  readonly emoji: string;
  readonly style: "primary" | "secondary" | "success" | "danger";
  readonly disabled?: boolean;
}

/**
 * One select option, as data.
 *
 * Required rather than optional, unlike Discord's own type: the panel selector
 * always has a description and an emoji, and an optional field would only push the
 * "is it there?" question into every consumer.
 */
export interface ComponentOption {
  readonly label: string;
  readonly value: string;
  readonly description: string;
  readonly emoji: string;
  readonly selected: boolean;
}

/** A select menu, as data. */
export interface ComponentSelect {
  readonly customId: string;
  readonly placeholder: string;
  readonly options: readonly ComponentOption[];
}

/** What a `/github` reply carries besides text. */
export interface ComponentRows {
  readonly buttons: readonly (readonly ComponentButton[])[];
  readonly select: ComponentSelect | null;
}

/** One complete `/github` render. */
export interface GithubView {
  /** One block per page; almost always a single block. */
  readonly blocks: readonly ViewBlock[];
  readonly components: ComponentRows;
}

/** Everything the panels read, built once per render. */
export interface GithubContext {
  /** Repository `owner/name`, as the project publishes it. */
  readonly fullName: string;
  /** `https://github.com/<fullName>`. */
  readonly repoUrl: string;
  /** Stored snapshots, oldest first. */
  readonly history: readonly SnapshotRecord[];
  /** The newest snapshot, or `null` before the first refresh. */
  readonly latest: SnapshotRecord | null;
  /** Which panel to build. */
  readonly panel: GithubPanel;
  /** Chart style for the graph panel. */
  readonly style: ChartStyle;
  /** How many readings the graph panel draws. */
  readonly width: number;
  /** `null` when the clicker did not open this view, so buttons stay usable. */
  readonly ownerId: string | null;
}

/** Fallback palette, used when the project name is not known yet. */
const PALETTE = {
  idle: 0x5865f2,
  up: 0x2ea043,
  down: 0xda3633,
  flat: 0x8b949e,
} as const;

/**
 * Builds one `/github` render.
 *
 * @returns the blocks and components. A fresh watch — no snapshots at all — is a
 * valid state with its own copy, not an error: there is simply nothing recorded
 * yet, and saying so is more useful than an empty block.
 */
export function buildGithubView(context: GithubContext): GithubView {
  if (context.latest === null) {
    return {
      blocks: [freshWatchBlock(context)],
      components: componentRows("overview", context.style, context.width, false),
    };
  }
  const bodies = panelBody(context);
  return {
    // Every block carries the footer, so a multi-block table reads the same on its
    // last page as the overview does.
    blocks: bodies.map((body) => ({ ...body, footer: footerFor(context) })),
    components: componentRows(context.panel, context.style, context.width, true),
  };
}

/**
 * @returns one block per panel page. A list rather than a single block because a
 * project with many libraries needs more than one: the table continues onto further
 * blocks instead of being truncated.
 */
function panelBody(context: GithubContext): Omit<ViewBlock, "footer">[] {
  switch (context.panel) {
    case "libraries":
      return librariesPanel(context);
    case "timeline":
      return timelinePanel(context);
    case "graph":
      return graphPanel(context);
    case "why":
      return whyPanel(context);
    case "overview":
    default:
      return [overviewPanel(context)];
  }
}

/** The newest reading, or `null` when the latest snapshot could not read one. */
function latestReading(context: GithubContext): ImplementationReading | null {
  const latest = context.latest;
  return latest === null ? null : readImplementation(latest);
}

/**
 * The reading to compare against: the last snapshot that actually recorded both
 * sections, which is *not* necessarily the previous row — a failed fetch stores a
 * snapshot with no percentages, and comparing against that would show a drop.
 */
function previousReading(context: GithubContext): ImplementationReading | null {
  const history = context.history;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const reading = readImplementation(history[index] as SnapshotRecord);
    if (reading.libraries !== null || reading.shaders !== null) {
      return reading;
    }
  }
  return null;
}

/** @returns both series as plain points, oldest first. */
function seriesFor(context: GithubContext, section: "libraries" | "shaders"): SeriesPoint[] {
  return implementationPoints(context.history, section);
}

/** @returns `+0.12`, `-0.4` or `±0` — the sign is the information. */
function signed(value: number, decimals = 2): string {
  if (Math.abs(value) < 1e-9) {
    return "±0";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(decimals).replace(/\.?0+$/, "")}`;
}

/** @returns `▲ 0.4 pp` in colour, or `▬ 0 pp` when nothing moved. */
function movement(change: number | null, unit = "pp"): string {
  if (change === null) {
    return "▬ no earlier reading to compare";
  }
  if (Math.abs(change) < 1e-9) {
    return `▬ 0 ${unit} — unchanged`;
  }
  const arrow = change > 0 ? "▲" : "▼";
  return `${arrow} ${signed(change)} ${unit}`;
}

/** @returns the colour that matches a change's direction. */
function colourFor(change: number | null): number {
  if (change === null || Math.abs(change) < 1e-9) {
    return PALETTE.flat;
  }
  return change > 0 ? PALETTE.up : PALETTE.down;
}

/** @returns a gauge plus the two counts, aligned for an inline field. */
function gaugeLine(section: ImplementationSeries): string {
  return `${gauge(section.percent / 100, 14)} **${formatValue(section.percent, 2)}%**`;
}

/** @returns a snapshot's absolute time, in UTC so every reader sees the same clock. */
export function absoluteTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * @returns a relative age (`3h ago`), which is what a reader actually wants from a
 * monitor that runs hourly — and which stays right when the message is old.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1_000);
  if (seconds < 0) {
    return "just now";
  }
  if (seconds < 90) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/** Cuts text to `limit` on a word boundary where possible, ellipsis included. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, Math.max(0, limit - 1));
  const space = cut.lastIndexOf(" ");
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** @returns lines joined with newlines, clipped to one field body. */
function body(lines: readonly string[], limit = MAX_FIELD): string {
  return clip(lines.filter((line) => line.length > 0).join("\n"), limit);
}

/**
 * The default panel: both sections at a glance, the community counters, and the
 * composition of what the project has not finished.
 *
 * Field order is fixed — headline, then counters, then composition — so an
 * operator reading the channel hourly finds the same numbers in the same place.
 */
function overviewPanel(context: GithubContext): Omit<ViewBlock, "footer"> {
  const snapshot = context.latest as SnapshotRecord;
  const reading = latestReading(context);
  const previous = previousReading(context);
  const description = body(
    [
      `🕒 Captured **${relativeTime(snapshot.capturedAt)}** — ${absoluteTime(snapshot.capturedAt)}`,
      `📌 ${describeCommit(snapshot)}`,
    ],
    MAX_DESCRIPTION,
  );
  const title = `${context.fullName} — implementation progress`;

  if (reading === null || reading.libraries === null || reading.shaders === null) {
    return {
      title,
      url: context.repoUrl,
      description,
      color: PALETTE.flat,
      sections: [
        {
          heading: "⚠️ No implementation numbers in this snapshot",
          text: body([
            "The project's `progress.json` could not be read when this snapshot was taken,",
            "so this reading carries no percentage. That is *unknown*, not zero: nothing",
            "was lost, and the earlier readings are still on the next snapshots.",
          ]),
        },
        communitySection(context),
      ],
    };
  }

  const libraryChange =
    previous?.libraries === null || previous?.libraries === undefined
      ? null
      : reading.libraries.percent - previous.libraries.percent;
  const decomposition =
    previous?.libraries === null || previous?.libraries === undefined
      ? null
      : decompose(previous.libraries, reading.libraries);

  const sections: ViewSection[] = [
    librarySection(reading.libraries, previous?.libraries ?? null),
    shaderSection(reading.shaders, previous?.shaders ?? null),
    communitySection(context),
    ...compositionSections(context),
    ...trendSections(context),
  ];

  // The one figure people misread, given a line of its own: a falling share while
  // implemented functions rise can only come from the denominator growing.
  if (decomposition !== null && decomposition.change < 0) {
    sections.push({
      heading: "🔎 The library share fell — the grid is not shrinking",
      text: body([
        footerDiscovered(decomposition),
        "`/github why` explains it, and `/github libraries` names the libraries involved.",
      ]),
    });
  }

  // No slice: a text block holds every section, where an embed stopped at twenty-five
  // fields and dropped the rest without saying so.
  return {
    title,
    url: context.repoUrl,
    description,
    color: colourFor(libraryChange),
    sections,
  };
}

/** @returns the libraries headline: gauge, counts, and what moved since before. */
function librarySection(
  now: ImplementationSeries,
  before: ImplementationSeries | null,
): ViewSection {
  return {
    heading: `📚 System libraries — ${formatValue(now.percent, 2)}%`,
    text: body([
      gaugeLine(now),
      `\`${formatCount(now.done)}\` / \`${formatCount(now.total)}\` functions implemented`,
      before === null ? "▬ no earlier reading to compare" : movement(now.percent - before.percent),
      before === null
        ? ""
        : `\`${signed(now.done - before.done, 0)}\` implemented · \`${signed(now.total - before.total, 0)}\` discovered`,
    ]),
  };
}

/** @returns the shaders headline, shaped like the library one. */
function shaderSection(
  now: ImplementationSeries,
  before: ImplementationSeries | null,
): ViewSection {
  return {
    heading: `🎮 GPU shaders — ${formatValue(now.percent, 2)}%`,
    text: body([
      gaugeLine(now),
      `\`${formatCount(now.done)}\` / \`${formatCount(now.total)}\` instructions translated`,
      before === null ? "▬ no earlier reading to compare" : movement(now.percent - before.percent),
      before === null
        ? ""
        : `\`${signed(now.done - before.done, 0)}\` instructions · \`${signed(now.total - before.total, 0)}\` discovered`,
    ]),
  };
}

/** @returns the repository counters that frame the percentages. */
function communitySection(context: GithubContext): ViewSection {
  const latest = context.latest as SnapshotRecord;
  const first = context.history[0] ?? latest;
  const stored = context.history.length;
  return {
    heading: "⭐ Community",
    text: body([
      `**${formatCount(latest.state.stars)}** stars · **${formatCount(latest.state.forks)}** forks`,
      `**${formatCount(latest.state.openIssues)}** open issues`,
      stored > 1
        ? `\`${signed(latest.state.stars - first.state.stars, 0)}\` stars over ${stored} snapshots (${relativeTime(first.capturedAt)} → now)`
        : "▬ the trend starts with the next snapshot",
    ]),
  };
}

/** @returns which commit the published numbers describe. */
function describeCommit(snapshot: SnapshotRecord): string {
  const sha = snapshot.progressCommit;
  if (sha === null) {
    return "statistics from the published snapshot (commit not reported)";
  }
  return `statistics at \`${sha.slice(0, 7)}\``;
}

/** @returns how much of each section is finished, and which libraries are closest. */
function compositionSections(context: GithubContext): ViewSection[] {
  const latest = context.latest as SnapshotRecord;
  const libraries = readLibraries(latest);
  if (libraries.length === 0) {
    // A snapshot stored before the table was kept: say so, rather than drawing an
    // empty panel that reads like a broken command.
    return [
      {
        heading: "🧩 Library breakdown",
        text: "▬ this snapshot stored no per-library table. It appears from the next refresh.",
      },
    ];
  }

  const complete = libraries.filter(
    (library) => library.total > 0 && library.done >= library.total,
  );
  const unfinished = libraries
    .filter((library) => library.total > 0 && library.done < library.total)
    .sort((left, right) => left.total - left.done - (right.total - right.done))
    .slice(0, 4);

  return [
    {
      heading: "🧩 Library breakdown",
      text: body([
        `**${complete.length}** of **${libraries.length}** libraries complete`,
        ...(unfinished.length === 0
          ? ["every analysed library is finished 🎉"]
          : unfinished.map(
              (library) =>
                `\`${clip(library.label, 26).padEnd(26, " ")}\` ${gauge(library.percent / 100, 6)} ${formatValue(library.percent, 2)}% · ${formatCount(library.total - library.done)} left`,
            )),
      ]),
    },
  ];
}

/** @returns the pace fields: change over the window, pace, and a rough estimate. */
function trendSections(context: GithubContext): ViewSection[] {
  const libraries = summarize(seriesFor(context, "libraries"));
  const shaders = summarize(seriesFor(context, "shaders"));
  const window = windowLabel(context);

  const lines: string[] = [];
  if (libraries !== null) {
    lines.push(`📚 ${movement(libraries.change)} ${window}`);
    lines.push(
      `    pace ${paceLabel(libraries)} · high ${formatValue(libraries.high.value, 2)}% · low ${formatValue(libraries.low.value, 2)}%`,
    );
  }
  if (shaders !== null) {
    lines.push(`🎮 ${movement(shaders.change)} ${window}`);
    lines.push(`    pace ${paceLabel(shaders)}`);
  }

  const fields: ViewSection[] = [
    { heading: "📈 Trend", text: body(lines.length === 0 ? ["▬ no readings yet"] : lines) },
  ];
  const estimate = estimateSection(libraries);
  if (estimate !== null) {
    fields.push(estimate);
  }
  return fields;
}

/** @returns "over the last 24 snapshots (2d 3h)". */
function windowLabel(context: GithubContext): string {
  const first = context.history[0];
  const last = context.latest;
  if (first === undefined || last === null || first === last) {
    return "in this snapshot";
  }
  const hours = Math.round((last.capturedAt.getTime() - first.capturedAt.getTime()) / 3_600_000);
  const shown = `the last ${context.history.length} snapshots`;
  return hours < 48 ? `over ${shown} (${hours}h)` : `over ${shown} (${Math.round(hours / 24)}d)`;
}

/** @returns `+0.12 pp/day`, or `flat` when the fitted pace rounds to nothing. */
function paceLabel(summary: TrendSummary): string {
  if (summary.slopePerDay === null) {
    return "not enough readings";
  }
  if (Math.abs(summary.slopePerDay) < 1e-9) {
    return "flat";
  }
  return `${signed(summary.slopePerDay)} pp/day`;
}

/**
 * @returns the extrapolated finish time, or `null` when the pace is not positive.
 *
 * Hedged on purpose: it divides the distance left by the window's pace, and a
 * project that keeps discovering functions pushes the finish line out as it
 * approaches it. Shown as a rough figure, never as a promise.
 */
function estimateSection(summary: TrendSummary | null): ViewSection | null {
  if (summary === null || summary.slopePerDay === null || summary.slopePerDay <= 0) {
    return null;
  }
  const remaining = 100 - summary.last.value;
  if (remaining <= 0) {
    return null;
  }
  return {
    heading: "🧭 At this pace",
    text: body([
      `100% would arrive in **${formatSpan(remaining / summary.slopePerDay)}** at ${signed(summary.slopePerDay)} pp/day.`,
      "An extrapolation from the window above — discoveries move the finish line.",
    ]),
  };
}

/** @returns days as `3d 4h`, `6h` or `~20 min`. */
export function formatSpan(days: number): string {
  if (!Number.isFinite(days) || days <= 0) {
    return "no time at all";
  }
  const hours = days * 24;
  if (hours < 2) {
    return `~${Math.round(hours * 60)} min`;
  }
  if (hours < 48) {
    return `${Math.round(hours)}h`;
  }
  const whole = Math.floor(days);
  const rest = Math.round((days - whole) * 24);
  return rest === 0 ? `${whole}d` : `${whole}d ${rest}h`;
}

/**
 * The full library table, with how each one moved since the last comparable read.
 *
 * The comparison is against the last snapshot that *has* a table, not simply the
 * previous row: a failed fetch stores a snapshot with no library data, and using
 * it would mark every library as new.
 *
 * Rows are one code lane per library (`name  gauge  12.34%`), so the numbers line
 * up in the monospaced run the way a table would.
 */
function librariesPanel(context: GithubContext): Omit<ViewBlock, "footer">[] {
  const snapshot = context.latest as SnapshotRecord;
  const libraries = readLibraries(snapshot);
  const previous = comparableLibraries(context);
  const title = `${context.fullName} — libraries`;
  const url = context.repoUrl;

  if (libraries.length === 0) {
    return [
      {
        title,
        url,
        description: `Captured **${relativeTime(snapshot.capturedAt)}**.`,
        color: PALETTE.flat,
        sections: [
          {
            heading: "▬ No per-library table in this snapshot",
            text: "This snapshot stored no library data, or `progress.json` was unreadable when it was taken. The next successful refresh fills the table in.",
          },
        ],
      },
    ];
  }

  const before = previous === null ? [] : readLibraries(previous);
  const analysis = analyzeLibraries(before, libraries, 4);
  const done = libraries.reduce((sum, library) => sum + library.done, 0);
  const total = libraries.reduce((sum, library) => sum + library.total, 0);
  const complete = libraries.filter(
    (library) => library.total > 0 && library.done >= library.total,
  );
  const share = total > 0 ? (done / total) * 100 : 0;
  // Movement over the whole stored window, not just against one earlier reading: a
  // library that gained work six hours ago and none since looked untouched when the
  // panel only compared the newest two readings.
  const movement = libraryMovement(context.history);

  const description = body(
    [
      `${gauge(share / 100, 20)} **${formatValue(share, 2)}%**`,
      `\`${formatCount(done)}\` of \`${formatCount(total)}\` functions · \`${formatCount(total - done)}\` left`,
      `🧩 **${complete.length}** of **${libraries.length}** libraries complete`,
      previous === null
        ? "▬ no earlier table to compare against"
        : `🔁 compared with ${relativeTime(previous.capturedAt)} — ${absoluteTime(previous.capturedAt)}`,
    ],
    MAX_DESCRIPTION,
  );

  // Most incomplete first: the libraries a reader can act on belong at the top, and
  // a project with many small libraries continues over further embeds.
  const ordered = [...libraries].sort(
    (left, right) => right.total - right.done - (left.total - left.done),
  );
  // Pages are filled to the field's character budget, not to a fixed row count: the
  // rows themselves are two lines each and vary with the size of the numbers, so a
  // fixed count of 22 overflowed `MAX_FIELD` and silently dropped the last libraries
  // of every page.
  const rows = ordered.map((library) => ({
    library,
    text: libraryRow(library, analysis.before, movement),
  }));
  const paginated = paginate(rows, MAX_FIELD);
  // A table with a great many libraries paginates to more blocks than one message can
  // hold, and Discord rejects such a payload whole rather than shortening it — which is
  // how the libraries panel came to answer "Discord rejected the request". The cap is on
  // blocks, not characters, because the component count is what Discord checks.
  const pages = paginated.slice(0, MAX_BLOCKS);
  // Counted, not estimated: a reader is told the real number of libraries left out.
  const omitted = paginated.slice(pages.length).reduce((sum, page) => sum + page.length, 0);

  return pages.map((page, index) => {
    const last = index === pages.length - 1;
    // A cut table says so on the page that was cut, and names the way to see the rest:
    // a reader who is not told would take the shortened table for the whole project.
    const cut =
      last && omitted > 0
        ? `▬ **${formatCount(omitted)} more ${omitted === 1 ? "library" : "libraries"}** do not fit in one message. \`/github report\` charts them by movement.`
        : "";
    // A `+` in the counter, so "3/3+" never claims to be the end of a longer table.
    const counter = omitted > 0 ? `${index + 1}/${pages.length}+` : `${index + 1}/${pages.length}`;
    return {
      title: pages.length === 1 && omitted === 0 ? title : `${title} (${counter})`,
      url,
      description: body(
        [
          index === 0
            ? description
            : `Captured **${relativeTime(snapshot.capturedAt)}** · most incomplete first.`,
          cut,
        ],
        MAX_DESCRIPTION,
      ),
      color: PALETTE.idle,
      sections: [
        {
          heading: "Library · share · implemented / discovered · change",
          text: page.map((row) => row.text).join("\n"),
        },
      ],
    };
  });
}

/**
 * @returns one library's table row: a labelled gauge, then the numbers.
 *
 * The change is measured over the whole stored window when there is one, which is what
 * makes the column useful: the delta against the single previous reading was usually
 * `▬`, so a reader could not tell a library that had been worked on yesterday from one
 * nobody had ever touched.
 */
function libraryRow(
  library: LibraryReading,
  before: readonly LibraryReading[],
  window: readonly LibraryMovementRow[] = [],
): string {
  const moved = window.find((row) => row.name === library.name);
  const earlier = before.find((candidate) => candidate.name === library.name);
  const delta =
    moved === undefined
      ? earlier === undefined
        ? "🆕"
        : library.done === earlier.done
          ? "▬"
          : `${library.done > earlier.done ? "+" : ""}${formatCount(library.done - earlier.done)}`
      : moved.doneDelta === 0 && moved.totalDelta === 0
        ? "▬"
        : `${moved.doneDelta > 0 ? "+" : ""}${formatCount(moved.doneDelta)} window`;
  return body([
    `\`${clip(library.label, 24).padEnd(24, " ")}\` ${gauge(library.percent / 100, 8)}`,
    ` ${formatValue(library.percent, 2).padStart(6, " ")}% · \`${formatCount(library.done)}/${formatCount(library.total)}\` · ${delta}`,
  ]);
}

/**
 * @returns `rows` split into pages whose joined text fits `budget`.
 *
 * A row is never split, and a single row that is too long on its own still gets a
 * page: the alternative would be an empty page and an unending loop.
 */
function paginate<T extends { readonly text: string }>(rows: readonly T[], budget: number): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];
  let length = 0;
  for (const row of rows) {
    // Rows are joined with a newline, so every row after the first costs one more.
    const cost = current.length === 0 ? row.text.length : row.text.length + 1;
    if (current.length > 0 && length + cost > budget) {
      pages.push(current);
      current = [];
      length = 0;
    }
    length += current.length === 0 ? row.text.length : row.text.length + 1;
    current.push(row);
  }
  if (current.length > 0) {
    pages.push(current);
  }
  return pages;
}

/** @returns the last snapshot that carries a library table, or `null`. */
function comparableLibraries(context: GithubContext): SnapshotRecord | null {
  const index = lastComparableIndex(context.history, context.history.length);
  return index === null ? null : (context.history[index] as SnapshotRecord);
}

/** @returns `items` split into arrays of at most `size`, in order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/**
 * The last readings as a table, newest first.
 *
 * Each row is one snapshot: when it was taken, both percentages, and how many
 * functions were implemented in that step. A snapshot with no reading shows as
 * `—`, never as `0%`, because those two are different facts and only one of them
 * is bad news.
 */
function timelinePanel(context: GithubContext): Omit<ViewBlock, "footer">[] {
  const history = trimmedHistory(context, TIMELINE_ROWS);
  const summary = summarize(seriesFor(context, "libraries"));

  // Stored oldest first, drawn newest first: the step is still the change from the
  // previous reading, so it is read before the rows are flipped for display.
  const rows = history.map((snapshot, index) => {
    const reading = readImplementation(snapshot);
    const earlier = history[index - 1];
    const before = earlier === undefined ? null : readImplementation(earlier).libraries;
    // A step is always rendered, even when there is none: `body()` drops empty lines, so
    // a missing step used to collapse that row to two lines and every row with one to
    // three — a table that alternated height and misaligned its columns.
    const step =
      reading.libraries === null || before === null
        ? "     ·"
        : reading.libraries.done === before.done
          ? "     ▬"
          : ` ${reading.libraries.done > before.done ? "+" : ""}${formatCount(reading.libraries.done - before.done)}`;
    // `absoluteTime(...).slice(5, 16)` is 16 characters (`MM-DD HH:MM UTC`), so the
    // lane is padded to exactly that and one space separates it from the percentages.
    return (
      `${absoluteTime(snapshot.capturedAt).slice(5, 16)} ` +
      `${reading.libraries === null ? "      —" : `${formatValue(reading.libraries.percent, 2).padStart(7, " ")}%`}` +
      `${reading.shaders === null ? "      —" : `${formatValue(reading.shaders.percent, 2).padStart(7, " ")}%`}` +
      ` ${step.padStart(6, " ")}`
    );
  });
  rows.reverse();

  // The span the rows actually cover, so "the last 24 readings" says what it is worth:
  // at fifteen-minute cadence that is six hours, and the reader should not have to work
  // that out from the row count.
  const oldest = history[0];
  const newest = history.at(-1);
  const span =
    oldest === undefined || newest === undefined
      ? null
      : (newest.capturedAt.getTime() - oldest.capturedAt.getTime()) / 3_600_000;

  const description = body(
    [
      `🕘 The last **${history.length}** readings, newest first` +
        (span === null ? "." : ` — ${formatSpan(span)} of history.`),
      summary === null
        ? "▬ no reading carries a percentage yet"
        : `📚 from **${formatValue(summary.first.value, 2)}%** to **${formatValue(summary.last.value, 2)}%** — ${movement(summary.change)}`,
    ],
    MAX_DESCRIPTION,
  );

  return [
    {
      title: `${context.fullName} — timeline`,
      url: context.repoUrl,
      description,
      color: colourFor(summary?.change ?? null),
      sections: [
        {
          heading: "🕘 When (UTC) · libraries · shaders · implemented step",
          text: body(rows),
        },
        ...(summary === null ? [] : [stepsSection(summary)]),
      ],
    },
  ];
}

/** Readings the timeline lists. Enough to show the recent past without paging. */
const TIMELINE_ROWS = 24;

/** @returns how often the reading went up, down or stayed put. */
function stepsSection(summary: TrendSummary): ViewSection {
  const { up, down, flat } = summary.steps;
  const longest =
    summary.longestRun === null
      ? "▬ no run of changes yet"
      : `longest run: ${summary.longestRun.length} ${summary.longestRun.direction === "up" ? "▲ up" : "▼ down"}`;
  return {
    heading: "🔀 Steps",
    text: body([
      `**${up}** up · **${down}** down · **${flat}** unchanged`,
      summary.improvingShare === null
        ? longest
        : `${Math.round(summary.improvingShare * 100)}% of steps improved · ${longest}`,
    ]),
  };
}

/** @returns the tail of the history, so a long-running watch stays one embed. */
function trimmedHistory(context: GithubContext, limit: number): readonly SnapshotRecord[] {
  return context.history.slice(Math.max(0, context.history.length - limit));
}

/**
 * The trend as a chart, in the requested style.
 *
 * The chart is fenced so Discord renders it monospaced; the legend beneath is
 * plain text, so its numbers stay readable where a code block would scroll.
 */
function graphPanel(context: GithubContext): Omit<ViewBlock, "footer">[] {
  const libraries = seriesFor(context, "libraries");
  const shaders = seriesFor(context, "shaders");
  // One column per reading, capped so the *widest* row a phone has to show still fits:
  // `bars` prepends a `100.00%┫` gutter to the columns, which is why the columns are
  // `MAX_ROW` minus the widest gutter that style can draw. Sizing from the bare columns
  // is what let the bar chart be the one that ran off the screen.
  const requested = Math.max(8, Math.min(48, Math.trunc(context.width)));
  const width = context.style === "bars" ? Math.min(requested, MAX_ROW - BAR_GUTTER) : requested;
  const libraryWindow = libraries.slice(Math.max(0, libraries.length - width));
  const shaderWindow = shaders.slice(Math.max(0, shaders.length - width));
  const title = `${context.fullName} — graph`;

  if (libraryWindow.length === 0 && shaderWindow.length === 0) {
    return [
      {
        title,
        url: context.repoUrl,
        description: "▬ no reading carries a percentage yet, so there is nothing to plot.",
        color: PALETTE.flat,
        sections: [],
      },
    ];
  }

  const fields: ViewSection[] = [];
  if (libraryWindow.length > 0) {
    fields.push(chartSection("📚 System libraries", libraryWindow, context.style, 6));
  }
  if (shaderWindow.length > 0) {
    fields.push(chartSection("🎮 GPU shaders", shaderWindow, context.style, 4));
  }
  const summary = summarize(libraryWindow);
  const description = body(
    [
      `📈 **${libraryWindow.length}** readings · style \`${context.style}\` · ${context.style === "bars" ? "scale starts at 0%" : "scale spans the window"}`,
      summary === null
        ? "▬ no library reading in this window"
        : `📚 ${movement(summary.change)} — from **${formatValue(summary.first.value, 2)}%** to **${formatValue(summary.last.value, 2)}%**`,
      `🕒 ${relativeTime(libraryWindow[0]?.capturedAt ?? new Date())} → ${relativeTime(libraryWindow.at(-1)?.capturedAt ?? new Date())}`,
    ],
    MAX_DESCRIPTION,
  );

  return [
    {
      title,
      url: context.repoUrl,
      description,
      color: colourFor(summary?.change ?? null),
      sections: fields,
    },
  ];
}

/** @returns one series as a chart section plus a legend in plain text. */
function chartSection(
  title: string,
  points: readonly SeriesPoint[],
  style: ChartStyle,
  rows: number,
): ViewSection {
  const values = points.map((point) => point.value);
  // `bars` starts at zero, the honest frame for "how far from done"; `line` spans
  // the window so a slow climb stays visible. `rows` is text rows either way:
  // `scaleSeries` converts them to steps itself.
  const scale = scaleSeries(values, { rows, zeroBased: style === "bars" });
  const labels: readonly [string, string, string] | null =
    scale.range === null
      ? null
      : [
          `${formatValue(scale.range.min, 2)}%`,
          `${formatValue((scale.range.min + scale.range.max) / 2, 2)}%`,
          `${formatValue(scale.range.max, 2)}%`,
        ];
  const chart = fenceChart(style, drawColumns(scale.blocks, rows), labels);
  const first = points[0];
  const last = points.at(-1);
  const span =
    first === undefined || last === undefined
      ? ""
      : `${relativeTime(first.capturedAt)} → ${relativeTime(last.capturedAt)}`;
  const high = values.length === 0 ? "" : `${formatValue(Math.max(...values), 2)}%`;
  const low = values.length === 0 ? "" : `${formatValue(Math.min(...values), 2)}%`;
  const legend =
    span === ""
      ? ""
      : `${span} · ${movement((last?.value ?? 0) - (first?.value ?? 0))} · low ${low} · high ${high}`;

  return {
    heading: clip(title, MAX_FIELD_NAME),
    text: body([chart, legend]),
  };
}

/** @returns a sparkline strip for the last `width` readings, gaps kept as gaps. */
export function sparklineStrip(points: readonly SeriesPoint[], width: number): string {
  const window = points.slice(Math.max(0, points.length - Math.max(1, Math.trunc(width))));
  return renderSparkline(
    window.map((point) => point.value),
    { zeroBased: false },
  );
}

/**
 * Why the library share moved — the panel that exists for one question.
 *
 * "The percentage went down but we did not lose anything" is not a contradiction,
 * it is arithmetic: the share is `done / total`, and `total` is what the project's
 * scan has *discovered*. Finding more to do lowers the share without a single
 * function being lost. This panel splits the change into those two terms
 * ({@link decompose}), names the libraries the denominator grew in, and states
 * plainly how much of a fall the discovery accounts for.
 *
 * It is written to answer a fair reading of the number rather than to reassure:
 * when the fall really was work being lost, or a recount of implemented functions,
 * it says that instead, and the two terms still add up to what was observed.
 */
function whyPanel(context: GithubContext): Omit<ViewBlock, "footer">[] {
  const snapshot = context.latest as SnapshotRecord;
  const now = readImplementation(snapshot).libraries;
  const previous = lastReadingBefore(context);
  const title = `${context.fullName} — why the share moved`;
  const url = context.repoUrl;

  if (now === null || previous === null) {
    return [
      {
        title,
        url,
        description: body(
          [
            now === null
              ? "▬ this snapshot has no library percentage to explain."
              : `▬ only one reading with a library percentage has been recorded (${relativeTime(snapshot.capturedAt)}).`,
            "",
            "There is nothing to compare yet, so there is no change to explain — and",
            "nothing was lost. The next refresh with numbers makes this panel work.",
          ],
          MAX_DESCRIPTION,
        ),
        color: PALETTE.flat,
        sections: [],
      },
    ];
  }

  const change = round2(now.percent - previous.value.percent);
  const decomposition = decompose(previous.value, now);
  const comparison = previous.snapshot;

  // A rise needs no explanation, so the panel says why it rose and stops there;
  // the interesting branch is the fall people ask about.
  const fields: ViewSection[] =
    decomposition === null
      ? [unreadableSection(previous.value, now)]
      : [splitField(previous.value, now, decomposition), ...causeSections(context, comparison)];

  return [
    {
      title,
      url,
      description: body(
        [
          `📚 **${formatValue(previous.value.percent, 2)}% → ${formatValue(now.percent, 2)}%** — ${movement(change)}`,
          `Compared with ${relativeTime(comparison.capturedAt)} — ${absoluteTime(comparison.capturedAt)}`,
          "",
          verdict(decomposition, change),
        ],
        MAX_DESCRIPTION,
      ),
      color: colourFor(change),
      sections: fields,
    },
  ];
}

/** @returns the last snapshot before the latest that carries a library reading. */
function lastReadingBefore(
  context: GithubContext,
): { readonly snapshot: SnapshotRecord; readonly value: ImplementationSeries } | null {
  const history = context.history;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const snapshot = history[index] as SnapshotRecord;
    const value = readImplementation(snapshot).libraries;
    if (value !== null) {
      return { snapshot, value };
    }
  }
  return null;
}

/**
 * @returns the one-line answer, phrased for the direction that actually happened.
 *
 * Deliberately does not congratulate a project for "discovering" its way down when
 * work was also lost: the share is explained, not excused.
 */
function verdict(decomposition: Decomposition | null, change: number): string {
  if (decomposition === null) {
    return "▬ the two totals cannot be compared, so the change is not explainable from these readings.";
  }
  if (Math.abs(change) < 5e-3) {
    return "▬ the share did not move.";
  }
  if (change > 0) {
    return decomposition.fromWork > 0
      ? "▲ it **rose**: more was implemented than was newly discovered."
      : "▲ it **rose** without new work, so the denominator shrank — a library left the scan, or a recount.";
  }
  const share = Math.round(decomposition.discoveryShareOfFall * 100);
  if (decomposition.doneDelta >= 0 && decomposition.totalDelta > 0) {
    return `▼ it **fell** while **nothing was lost** — ${share}% of the drop is newly discovered work.`;
  }
  if (decomposition.doneDelta < 0) {
    return `▼ it **fell**: ${formatCount(-decomposition.doneDelta)} implemented functions were also lost, and ${formatCount(decomposition.totalDelta)} new ones were found.`;
  }
  return `▼ it **fell**: the denominator grew by ${formatCount(decomposition.totalDelta)}.`;
}

/**
 * @returns the arithmetic of the change, term by term.
 *
 * The counts are shown beside each term so a reader can check them: work is
 * implemented functions over today's total, discovery is the denominator's growth
 * applied to the earlier count. They add up to `change` exactly.
 */
function splitField(
  before: ImplementationSeries,
  now: ImplementationSeries,
  decomposition: Decomposition,
): ViewSection {
  return {
    heading: "🧮 What moved the number",
    text: body([
      `\`change  \` **${signed(decomposition.change)} pp**  ${formatValue(before.percent, 2)}% → ${formatValue(now.percent, 2)}%`,
      `\`work    \` ${signed(decomposition.fromWork)} pp  ${signed(decomposition.doneDelta, 0)} implemented ÷ ${formatCount(now.total)}`,
      `\`discover\` ${signed(decomposition.fromDiscovery)} pp  ${signed(decomposition.totalDelta, 0)} found ÷ ${formatCount(before.total)}`,
      "",
      clue(decomposition),
    ]),
  };
}

/** @returns the field shown when the two readings carry no comparable totals. */
function unreadableSection(before: ImplementationSeries, now: ImplementationSeries): ViewSection {
  return {
    heading: "🧮 What moved the number",
    text: body([
      `\`${formatCount(before.done)}\` / \`${formatCount(before.total)}\` → \`${formatCount(now.done)}\` / \`${formatCount(now.total)}\``,
      "One of the two readings has no usable total, so the change cannot be split into work and discovery.",
    ]),
  };
}

/**
 * @returns how to read the split, in the terms of the case at hand.
 *
 * Ordered by how surprising each conclusion is, so the first line that applies is
 * the one worth leading with.
 */
function clue(decomposition: Decomposition): string {
  if (decomposition.totalDelta === 0) {
    return "The denominator did not move: every point of the change is work.";
  }
  if (decomposition.doneDelta >= 0 && decomposition.change < 0) {
    return `Nothing was lost. Of the ${formatValue(Math.abs(decomposition.change), 2)} pp fall, ${formatValue(Math.abs(decomposition.fromDiscovery), 2)} pp is new discoveries — ${Math.round(decomposition.discoveryShareOfFall * 100)}% of it.`;
  }
  if (decomposition.doneDelta > 0 && decomposition.change > 0) {
    return "Both terms point the same way: more implemented, and the share still rose.";
  }
  if (decomposition.doneDelta < 0) {
    return "Some implemented functions were lost too, so the fall is not only discovery.";
  }
  return "The denominator moved without any functions being implemented.";
}

/**
 * @returns which libraries moved, named where the stored table allows it.
 *
 * Reads the per-library tables of the two snapshots being compared. When either
 * predates the table being stored, the field says so and gives the totals instead
 * of inventing a per-library story.
 */
function causeSections(context: GithubContext, comparison: SnapshotRecord): ViewSection[] {
  const latest = context.latest as SnapshotRecord;
  const after = readLibraries(latest);
  const before = readLibraries(comparison);

  if (before.length === 0 || after.length === 0) {
    return [
      {
        heading: "🔬 Which libraries",
        text: body([
          before.length === 0
            ? "▬ the earlier snapshot stored no per-library table, so the growth cannot be attributed to a library."
            : "▬ this snapshot stored no per-library table, so there is nothing to attribute yet.",
        ]),
      },
    ];
  }

  const analysis = analyzeLibraries(before, after, 3);
  return [discoverySection(analysis), workSection(analysis), ...setChangeSections(analysis)];
}

/** @returns the libraries whose denominator grew — the usual cause of a fall. */
function discoverySection(analysis: LibraryAnalysis): ViewSection {
  const lines =
    analysis.discovered.length === 0
      ? ["▬ no library's denominator grew, so discovery was not what moved the share."]
      : analysis.discovered.map((movement) => {
          const added = movement.after.total - movement.before.total;
          return `\`${clip(movement.label, 20).padEnd(20, " ")}\` +${formatCount(added)} found · ${formatCount(movement.before.total)} → ${formatCount(movement.after.total)} total`;
        });
  return { heading: "🔬 Newly discovered work", text: body(lines) };
}

/** @returns the libraries where implemented functions rose, or fell. */
function workSection(analysis: LibraryAnalysis): ViewSection {
  const lines: string[] = [];
  for (const movement of analysis.grew) {
    lines.push(
      `\`${clip(movement.label, 20).padEnd(20, " ")}\` +${formatCount(movement.after.done - movement.before.done)} · ${formatValue(movement.before.percent, 2)}% → ${formatValue(movement.after.percent, 2)}%`,
    );
  }
  for (const movement of analysis.shrank) {
    lines.push(
      `\`${clip(movement.label, 20).padEnd(20, " ")}\` −${formatCount(movement.before.done - movement.after.done)} lost · ${formatValue(movement.before.percent, 2)}% → ${formatValue(movement.after.percent, 2)}%`,
    );
  }
  return {
    heading: "🛠️ Work recorded",
    text: body(lines.length === 0 ? ["▬ no library's implemented count changed."] : lines),
  };
}

/** @returns libraries that joined or left the scan, when any did. */
function setChangeSections(analysis: LibraryAnalysis): ViewSection[] {
  const { added, removed } = analysis.setChange;
  if (added.length === 0 && removed.length === 0) {
    return [];
  }
  const names = (libraries: readonly { readonly label: string }[]): string =>
    libraries
      .slice(0, 4)
      .map((library) => library.label)
      .join(", ");
  return [
    {
      heading: "🔄 The scan's library set changed",
      text: body([
        ...(added.length === 0 ? [] : [`➕ now analysed: ${clip(names(added), 300)}`]),
        ...(removed.length === 0 ? [] : [`➖ no longer analysed: ${clip(names(removed), 300)}`]),
        "A library joining the scan adds its functions to the denominator, which lowers the share on its own.",
      ]),
    },
  ];
}

/**
 * @returns the one-line explanation of a fall, for the places that show it inline.
 *
 * Kept to two clauses on purpose: the overview has room for a pointer, not for the
 * whole `why` panel.
 */
function footerDiscovered(decomposition: Decomposition): string {
  const share = Math.round(decomposition.discoveryShareOfFall * 100);
  if (decomposition.totalDelta > 0 && decomposition.doneDelta >= 0) {
    return `\`${signed(decomposition.fromDiscovery)}\` pp came from **${formatCount(decomposition.totalDelta)}** newly discovered functions — ${share}% of the fall. Nothing implemented was lost.`;
  }
  return `\`${signed(decomposition.fromDiscovery)}\` pp came from the denominator moving by **${signed(decomposition.totalDelta, 0)}** functions.`;
}

/** @returns the shared footer: where the numbers came from, and when. */
function footerFor(context: GithubContext): string {
  const count = context.history.length;
  const last =
    context.latest === null ? "" : ` · last capture ${relativeTime(context.latest.capturedAt)}`;
  return clip(
    `${context.fullName} · ${count} snapshot${count === 1 ? "" : "s"}${last} · figures read from the project's progress.json`,
    MAX_FIELD_NAME,
  );
}

/**
 * @returns the "nothing recorded yet" embed.
 *
 * A fresh watch is a valid state, not an error: the reply says what will appear
 * and when rather than showing empty percentages that would read as 0%.
 */
function freshWatchBlock(context: GithubContext): ViewBlock {
  return {
    title: `${context.fullName} — waiting for the first reading`,
    url: context.repoUrl,
    description: body(
      [
        "This repository is being watched, but no snapshot has been stored yet.",
        "",
        "The next refresh records the commit, the pull requests and the project's",
        "`progress.json`; every panel of this command fills in from it. Nothing is",
        "missing and nothing was lost — the history simply starts here.",
      ],
      MAX_DESCRIPTION,
    ),
    color: PALETTE.idle,
    sections: [],
    footer: `${context.fullName} · 0 snapshots`,
  };
}

/** The panels a reader can switch to, and how they appear. */
const PANELS: readonly {
  readonly id: GithubPanel;
  readonly label: string;
  readonly emoji: string;
  readonly blurb: string;
}[] = [
  {
    id: "overview",
    label: "Overview",
    emoji: "📊",
    blurb: "both sections, the pace and the breakdown",
  },
  {
    id: "libraries",
    label: "Libraries",
    emoji: "📚",
    blurb: "every library, and how each one moved",
  },
  { id: "timeline", label: "Timeline", emoji: "🕘", blurb: "the last readings, one row each" },
  { id: "graph", label: "Graph", emoji: "📈", blurb: "the trend drawn as text" },
  { id: "why", label: "Why it moved", emoji: "🔎", blurb: "why the share rose or fell" },
];

/** Every panel, exported so the interaction handler can validate a custom ID. */
export const PANEL_IDS: readonly GithubPanel[] = PANELS.map((panel) => panel.id);

/** The custom ID prefix of every `/github` component. */
export const GITHUB_PREFIX = "github";

/** @returns the custom ID that opens `panel` with the given chart settings. */
export function panelCustomId(panel: GithubPanel, style: ChartStyle, width: number): string {
  return `${GITHUB_PREFIX}:panel:${panel}:${style}:${width}`;
}

/**
 * @returns the panel buttons and the panel selector.
 *
 * The current panel's button is primary rather than disabled: disabling it would
 * lose the one slot that says where the reader is. Nothing here is restricted to
 * the invoker — this is public project data, and a reply only its author could use
 * would be useless in a channel.
 *
 * `width` travels in every custom ID instead of a constant. The chart columns are
 * the *message's* width, not the command's: a control that wrote its own width
 * would redraw the graph wider the first time anyone pressed a button, which is
 * exactly how a chart that fits a phone came to overflow one.
 */
function componentRows(
  current: GithubPanel,
  style: ChartStyle,
  width: number,
  withAll: boolean,
): ComponentRows {
  const buttons = PANELS.map((panel) => ({
    customId: panelCustomId(panel.id, style, width),
    label: panel.label,
    emoji: panel.emoji,
    style: panel.id === current ? ("primary" as const) : ("secondary" as const),
  }));
  return {
    buttons: withAll ? chunk(buttons, 5) : [],
    select: {
      customId: `${GITHUB_PREFIX}:select`,
      placeholder: "Switch panel…",
      options: PANELS.map((panel) => ({
        label: panel.label,
        value: panelCustomId(panel.id, style, width),
        description: panel.blurb,
        emoji: panel.emoji,
        selected: panel.id === current,
      })),
    },
  };
}

/** A parsed `/github` component interaction. */
export interface PanelRequest {
  readonly panel: GithubPanel;
  readonly style: ChartStyle;
  readonly width: number;
}

/**
 * Parses a `/github` custom ID.
 *
 * @returns the panel and chart settings it asked for, or `null` for a custom ID
 * this command did not write — a message from an older version, or another
 * command's component that happens to start the same way. Returning `null` rather
 * than throwing lets the handler answer politely instead of failing.
 */
export function parsePanelCustomId(customId: string): PanelRequest | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || parts[0] !== GITHUB_PREFIX || parts[1] !== "panel") {
    return null;
  }
  const [, , panel, style, width] = parts;
  if (panel === undefined || !PANEL_IDS.includes(panel as GithubPanel)) {
    return null;
  }
  if (style !== "bars" && style !== "line") {
    return null;
  }
  const parsed = Number(width);
  if (!Number.isFinite(parsed) || parsed < 8 || parsed > 48) {
    return null;
  }
  return { panel: panel as GithubPanel, style, width: Math.trunc(parsed) };
}

/** @returns `true` for any component belonging to `/github`. */
export function isGithubComponent(customId: string): boolean {
  return customId.startsWith(`${GITHUB_PREFIX}:`);
}
