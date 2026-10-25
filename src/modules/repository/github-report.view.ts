/**
 * `/github report` — a paged report over a chosen window.
 *
 * A report is not a panel: it answers "what happened in these four hours" with figures a
 * panel has no room to derive — merge latency, an hourly series, per-library work. It is
 * therefore several blocks, and a block is the unit Discord pages on: four *pages*, each
 * a summary followed by its tables, with custom IDs that carry the window so a reader can
 * turn pages without the command re-running.
 *
 * Written as data, like `github-view.ts`: no discord.js here, so every figure can be
 * asserted without a client or a clock.
 */
import type { GithubView, ViewBlock, ViewSection } from "./github-view.js";
import { absoluteTime, clip, MAX_FIELD } from "./github-view.js";
import { gauge } from "./repository-chart.js";
import { formatCount } from "./repository.events.js";
import type { LibraryMovementRow } from "./repository-analytics.js";
import {
  REPORT_RANGES,
  type ReportBucket,
  type ReportStats,
} from "./repository-report.analytics.js";

/** The custom-ID prefix of every `/github report` page button. */
export const REPORT_PREFIX = "github:report";

/** A page of the report. */
export type ReportPage = "overview" | "activity" | "libraries" | "health";

/** The pages, in the order a reader should see them. */
export const REPORT_PAGES: readonly {
  readonly id: ReportPage;
  readonly label: string;
  readonly emoji: string;
  readonly title: string;
}[] = [
  { id: "overview", label: "Summary", emoji: "📄", title: "the window at a glance" },
  { id: "activity", label: "Activity", emoji: "⏱️", title: "hour by hour" },
  { id: "libraries", label: "Libraries", emoji: "📚", title: "which libraries moved" },
  { id: "health", label: "Health", emoji: "🩺", title: "how complete this report is" },
];

/** Everything one report render needs. */
export interface ReportContext {
  readonly fullName: string;
  readonly repoUrl: string;
  readonly stats: ReportStats;
  readonly page: ReportPage;
  /** The chart style the reader asked for, kept so paging does not reset it. */
  readonly style: "bars" | "line";
}

/** @returns the custom ID that opens `page` of a report `range`. */
export function reportCustomId(page: ReportPage, range: string): string {
  return `${REPORT_PREFIX}:${page}:${range}`;
}

/**
 * @returns the page and range a report custom ID names, or `null` for a foreign one.
 *
 * `null` rather than a throw: a message from an older build carries an ID this build
 * does not know, and the handler answers that politely instead of failing.
 */
export function parseReportCustomId(
  customId: string,
): { readonly page: ReportPage; readonly range: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || parts[0] !== "github" || parts[1] !== "report") {
    return null;
  }
  const [, , page, range] = parts;
  if (page === undefined || !REPORT_PAGES.some((candidate) => candidate.id === page)) {
    return null;
  }
  if (range === undefined || !REPORT_RANGES.some((candidate) => candidate.id === range)) {
    return null;
  }
  return { page: page as ReportPage, range };
}

/** @returns the palette colour that matches a change's direction. */
function colourOf(change: number | null): number {
  if (change === null || Math.abs(change) < 1e-9) {
    return 0x8b949e;
  }
  return change > 0 ? 0x2ea043 : 0xda3633;
}

/** @returns `12.3` shortened to a sensible width: two decimals, trailing zeros off. */
function num(value: number, decimals = 2): string {
  return value.toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

/** @returns `+3`, `-1` or `±0`, because the sign is the information. */
function signedInt(value: number): string {
  if (value === 0) {
    return "±0";
  }
  return `${value > 0 ? "+" : ""}${formatCount(value)}`;
}

/** @returns a span in hours as `3h`, `2.4h` or `45m`. */
export function formatHours(hours: number | null): string {
  if (hours === null) {
    return "unknown";
  }
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  if (hours < 48) {
    return `${num(hours, hours < 10 ? 1 : 0)}h`;
  }
  return `${num(hours / 24, 1)}d`;
}

/** @returns lines joined with newlines, clipped to one block's budget. */
function body(lines: readonly string[], limit = MAX_FIELD): string {
  return clip(
    lines.filter((line) => line.length > 0).join("\n"),
    limit,
  );
}

/** @returns the block title for one page of a report. */
function titleOf(context: ReportContext): string {
  const range = context.stats.range.label;
  const page = REPORT_PAGES.find((candidate) => candidate.id === context.page);
  return `${context.fullName} — report · ${range} · ${page?.label ?? "Summary"}`;
}

/** @returns the footer every page carries, so a page read alone still says its window. */
function footerOf(context: ReportContext): string {
  const { stats } = context;
  return clip(
    `${context.fullName} · ${absoluteTime(stats.from)} → ${absoluteTime(stats.to)} · ` +
      `${formatCount(stats.coverage.snapshots)} snapshots · /github report`,
    256,
  );
}

/** @returns the report as blocks: exactly one page, whatever the page asks for. */
export function buildReport(context: ReportContext): ViewBlock[] {
  const block: ViewBlock = {
    title: titleOf(context),
    url: context.repoUrl,
    description: descriptionOf(context),
    color: colourOf(context.stats.progress.percentDelta),
    sections: sectionsOf(context),
    footer: footerOf(context),
  };
  return [block];
}

/**
 * @returns the reply payload for one page of a report.
 *
 * Lives here rather than in the command because the interaction handler also renders
 * report pages when a button is clicked, and a handler that imported a command would
 * invert the layering. The page and the range travel in the custom IDs, so neither
 * route needs a session and an old message keeps working after a restart.
 */
export function renderReport(input: {
  readonly stats: ReportStats;
  readonly fullName: string;
  readonly repoUrl: string;
  readonly page: ReportPage;
}): GithubView {
  const block = buildReport({
    fullName: input.fullName,
    repoUrl: input.repoUrl,
    stats: input.stats,
    page: input.page,
    style: "line",
  });
  // Four pages fit one row of five slots, so the report uses a row of buttons rather
  // than the panels' selector: every page is one click away, and each button carries
  // the range so a click keeps the window the report was opened with.
  return {
    blocks: block,
    components: {
      buttons: [
        REPORT_PAGES.map((candidate) => ({
          customId: reportCustomId(candidate.id, input.stats.range.id),
          label: candidate.label,
          emoji: candidate.emoji,
          style: candidate.id === input.page ? ("primary" as const) : ("secondary" as const),
        })),
      ],
      select: null,
    },
  };
}

/** @returns the introduction of one page: what the window was, and its headline. */
function descriptionOf(context: ReportContext): string {
  const { stats } = context;
  const window = `${absoluteTime(stats.from)} → ${absoluteTime(stats.to)} (${stats.range.label})`;
  const progress = stats.progress;
  const headline =
    progress.first === null || progress.last === null
      ? "▬ no percentage was recorded twice in this window, so there is no change to state"
      : `${progress.first.percent.toFixed(2)}% → **${progress.last.percent.toFixed(2)}%** ` +
        `(${signedPp(progress.percentDelta)})`;

  if (context.page === "activity") {
    return body([
      `⏱️ **${stats.range.label}** in ${stats.buckets.length} buckets.`,
      "A `▬` means no reading landed in that bucket — not that the value was zero.",
    ]);
  }
  if (context.page === "libraries") {
    const moved = stats.libraries.filter((row) => row.doneDelta !== 0).length;
    return body([
      `📚 **${moved}** of **${stats.libraries.length}** libraries implemented something.`,
      "Measured between the first and last reading that carried a library table.",
    ]);
  }
  if (context.page === "health") {
    return body([
      "🩺 Every figure above is only as good as the window behind it.",
      "This page states how much of the window the monitor actually recorded.",
    ]);
  }
  return body([
    `📅 ${window}`,
    `📈 libraries ${headline}`,
    `🔀 **${formatCount(stats.pulls.opened)}** opened · **${formatCount(stats.pulls.merged)}** merged · ` +
      `**${formatCount(stats.pulls.closedUnmerged)}** closed unmerged`,
    `📝 **${formatCount(stats.commits.count)}** commits by **${stats.commits.authors.length}** authors`,
  ]);
}

/** @returns the sections of one page. */
function sectionsOf(context: ReportContext): ViewSection[] {
  switch (context.page) {
    case "activity":
      return activitySections(context.stats);
    case "libraries":
      return librarySections(context.stats);
    case "health":
      return healthSections(context.stats);
    case "overview":
    default:
      return overviewSections(context.stats);
  }
}

/** @returns `+0.42 pp`, `-1.1 pp` or `±0 pp`. */
function signedPp(change: number | null): string {
  if (change === null) {
    return "no comparison possible";
  }
  if (Math.abs(change) < 1e-9) {
    return "±0 pp";
  }
  return `${change > 0 ? "+" : ""}${num(change)} pp`;
}

/** @returns the summary page: the headlines, then the pace a reader can act on. */
function overviewSections(stats: ReportStats): ViewSection[] {
  const { progress, pulls, commits } = stats;
  const sections: ViewSection[] = [];

  sections.push({
    heading: "📈 Implementation",
    text: body([
      `libraries now **${progress.latest === null ? "—" : `${progress.latest.libraries.percent.toFixed(2)}%`}** ` +
        `(${progress.latest === null ? "no reading" : `${formatCount(progress.latest.libraries.done)}/${formatCount(progress.latest.libraries.total)}`})`,
      `change ${signedPp(progress.percentDelta)} · ${progress.perDay === null ? "no rate" : `${num(progress.perDay)} pp/day`}`,
      progress.doneDelta === null
        ? "work done: unknown"
        : `work done **${signedInt(progress.doneDelta)}** functions · discovered **${signedInt(progress.totalDelta ?? 0)}**`,
      // The reason the two can disagree: a percentage can fall while work lands, and the
      // report should say which of the two happened rather than leave it to be inferred.
      progress.doneDelta !== null && progress.doneDelta > 0 && (progress.percentDelta ?? 0) < 0
        ? "▬ the share fell even though work landed: the denominator grew faster"
        : "",
    ]),
  });

  sections.push({
    heading: "🔀 Pull requests",
    text: body([
      `**${formatCount(pulls.opened)}** opened · **${formatCount(pulls.merged)}** merged · ` +
        `**${formatCount(pulls.closedUnmerged)}** closed unmerged`,
      `📥 ${num(pulls.opensPerDay ?? 0)}/day · ✅ ${num(pulls.mergesPerDay ?? 0)}/day`,
      `⏳ review time: **${formatHours(pulls.medianMergeHours)}** median · ${formatHours(pulls.meanMergeHours)} mean`,
      pulls.mergeRate === null
        ? "▬ nothing was resolved in this window"
        : `🏁 **${Math.round(pulls.mergeRate * 100)}%** of resolved pull requests were merged`,
      pulls.stillOpen === 0 ? "" : `🔓 **${formatCount(pulls.stillOpen)}** of those opened are still open`,
    ]),
  });

  sections.push({
    heading: "📝 Commits",
    text: body([
      `**${formatCount(commits.count)}** commits · ${num(commits.perDay ?? 0)}/day`,
      commits.latest === null
        ? "▬ no commit is stored in this window"
        : `latest: ${commits.latest.author ?? "unknown"} — ${clip(commits.latest.message, 70)}`,
      commits.authors.length === 0
        ? ""
        : `👥 ${commits.authors
            .slice(0, 5)
            .map((author) => `${clip(author.name, 18)} ${author.count}`)
            .join(" · ")}`,
    ]),
  });

  const busiest = [...stats.buckets].sort(
    (left, right) => right.opened + right.merged - (left.opened + left.merged),
  )[0];
  if (busiest !== undefined && busiest.opened + busiest.merged > 0) {
    sections.push({
      heading: "🔥 Busiest bucket",
      text: `${bucketLabel(busiest)} — ${busiest.opened} opened, ${busiest.merged} merged, ` +
        `${busiest.closedUnmerged} closed unmerged.`,
    });
  }

  return sections;
}

/** @returns a bucket's start as `MM-DD HH:00` plus `· 6h` when it spans more than an hour. */
function bucketLabel(bucket: ReportBucket): string {
  const time = absoluteTime(bucket.startsAt).slice(5, 16);
  return bucket.hours > 1 ? `${time} · ${num(bucket.hours, 0)}h` : time;
}

/**
 * @returns the activity page: a rate chart, then one row per bucket.
 *
 * The chart is of pull-request flow rather than of the percentage: the percentage moves
 * in hundredths over a few hours and would draw as a flat line, while the flow is what
 * the window is actually for.
 */
function activitySections(stats: ReportStats): ViewSection[] {
  const sections: ViewSection[] = [];
  const peak = Math.max(1, ...stats.buckets.map((bucket) => bucket.opened + bucket.merged));

  sections.push({
    heading: "📊 Pull-request flow",
    text: body(
      stats.buckets.map((bucket) => {
        const total = bucket.opened + bucket.merged;
        return `\`${bucketLabel(bucket).padEnd(16, " ")}\` ${gauge(total / peak, 12)} ` +
          `+${String(bucket.opened).padStart(2, " ")} open · ${String(bucket.merged).padStart(2, " ")} merge`;
      }),
    ),
  });

  // The table is split across as many sections as it needs rather than clipped: on a
  // week the rows are 41 buckets, and a report that dropped the last third of its own
  // history would be worse than one with two tables.
  const rows = stats.buckets.map(
    (bucket) =>
      `\`${bucketLabel(bucket).padEnd(16, " ")}\` ` +
      `${String(bucket.opened).padStart(3, " ")} ${String(bucket.merged).padStart(3, " ")} ` +
      `${String(bucket.closedUnmerged).padStart(3, " ")} ` +
      `${bucket.libraryPercent === null ? "     ▬" : `${bucket.libraryPercent.toFixed(2).padStart(6, " ")}%`}`,
  );
  const header = "`when             ` open mrg clo  share";
  for (const [index, chunk] of chunksOf([header, ...rows], 3_600).entries()) {
    sections.push({
      heading: index === 0 ? "🕘 Per bucket" : "🕘 Per bucket (continued)",
      text: chunk.join("\n"),
    });
  }

  return sections;
}

/**
 * @returns `lines` cut into groups whose joined text fits `budget`.
 *
 * A line is never split, and a single over-long line still gets a group of its own: the
 * alternative is an empty group and an unending loop.
 */
export function chunksOf(lines: readonly string[], budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    const cost = current.length === 0 ? line.length : line.length + 1;
    if (current.length > 0 && length + cost > budget) {
      groups.push(current);
      current = [];
      length = 0;
    }
    length += current.length === 0 ? line.length : line.length + 1;
    current.push(line);
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/** @returns one library's row: the name, then what it gained in the window. */
function libraryRow(row: LibraryMovementRow): string {
  const delta =
    row.doneDelta === 0 && row.percentDelta === 0
      ? "▬ unchanged"
      : `${signedInt(row.doneDelta)} done` +
        (row.totalDelta === 0 ? "" : ` · ${signedInt(row.totalDelta)} found`) +
        ` · ${signedPp(row.percentDelta)}`;
  return body([
    `\`${clip(row.label, 22).padEnd(22, " ")}\` ${gauge(row.percent / 100, 8)}`,
    ` ${row.percent.toFixed(2).padStart(6, " ")}% · \`${formatCount(row.done)}/${formatCount(row.total)}\` · ${delta}`,
  ]);
}

/**
 * @returns the libraries page: the movers and shakers, then the rest.
 *
 * Every library is listed, because "nothing happened here" is itself a finding in a
 * report: a library nobody touched for a day is what a reader wants to spot.
 */
function librarySections(stats: ReportStats): ViewSection[] {
  if (stats.libraries.length === 0) {
    return [
      {
        heading: "▬ No library table in this window",
        text: "No reading in the window carried a per-library table. The next refresh with a readable `progress.json` fills this page in.",
      },
    ];
  }

  const moved = stats.libraries.filter((row) => row.doneDelta !== 0 || row.totalDelta !== 0);
  const still = stats.libraries.filter((row) => row.doneDelta === 0 && row.totalDelta === 0);
  const sections: ViewSection[] = [];

  // Split, never clipped: the rows are two lines each and a week can move forty
  // libraries, which is more than one block holds.
  for (const [index, chunk] of chunksOf(moved.map(libraryRow), 3_600).entries()) {
    sections.push({
      heading: index === 0 ? `🚀 Moved (${moved.length})` : "🚀 Moved (continued)",
      text: chunk.join("\n"),
    });
  }
  if (moved.length === 0) {
    sections.push({ heading: "🚀 Moved (0)", text: "▬ no library moved in this window" });
  }

  // Split rather than clipped, for the same reason the activity table is: a project with
  // eighty libraries must not lose its last ones.
  if (still.length > 0) {
    const rows = still.map((row) => `\`${clip(row.label, 22).padEnd(22, " ")}\` ${row.percent.toFixed(2)}%`);
    for (const [index, chunk] of chunksOf(rows, 3_600).entries()) {
      sections.push({
        heading: index === 0 ? `▬ Unchanged (${still.length})` : "▬ Unchanged (continued)",
        text: chunk.join("\n"),
      });
    }
  }

  return sections;
}

/** @returns the health page: how complete the report's own data is. */
function healthSections(stats: ReportStats): ViewSection[] {
  const { coverage } = stats;
  const sections: ViewSection[] = [
    {
      heading: "🩺 Recording",
      text: body([
        `**${formatCount(coverage.snapshots)}** snapshots · ` +
          `cadence ${coverage.cadenceMinutes === null ? "unknown" : `${coverage.cadenceMinutes}m`}`,
        `⏱️ covered **${coverage.hoursCovered}/${coverage.hoursTotal}h** ` +
          `(${Math.round(coverage.share * 100)}%) · longest gap **${formatHours(coverage.longestGapHours)}**`,
        coverage.failed === 0
          ? "✅ no snapshot recorded a failed endpoint"
          : `⚠️ **${coverage.failed}** snapshots recorded a failed endpoint`,
        // Stated plainly, because a rate over a half-covered window is a half-rate.
        coverage.share < 0.9
          ? "▬ under 90% covered: the per-day rates below are lower bounds, not measurements"
          : "",
      ]),
    },
  ];

  const moved = stats.libraries.filter((row) => row.doneDelta !== 0).length;
  sections.push({
    heading: "🔍 What this report is built from",
    text: body([
      `• **${formatCount(stats.pulls.opened)}** pull requests opened, **${formatCount(stats.pulls.merged)}** merged, ` +
        `**${formatCount(stats.pulls.closedUnmerged)}** closed unmerged`,
      `• **${formatCount(stats.commits.count)}** commits from this repository's history`,
      `• **${moved}** libraries changed, out of **${stats.libraries.length}** in the latest table`,
      stats.progress.unreadable === 0
        ? ""
        : `• **${stats.progress.unreadable}** readings carried no percentage and were left out`,
    ]),
  });

  sections.push({
    heading: "📐 How to read it",
    text: body([
      "Pull requests are placed by when GitHub says they were opened, merged or closed,",
      "not by when the monitor noticed them, so a window is exact to the second.",
      "The percentage is snapshot-based: it is carried forward between readings and shows",
      "a gap (`▬`) for a bucket nobody measured.",
    ]),
  });

  return sections;
}
