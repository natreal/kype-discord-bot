/**
 * The hourly report, as data.
 *
 * Pure: it turns a reading plus what changed into the *strings* a message shows,
 * with no discord.js and no repository access. That makes the wording, the deltas
 * and the truncation unit-testable, and it keeps the embed adapter limited to
 * "build an EmbedBuilder from this and post it".
 *
 * Layout is deliberately fixed so an operator scanning the channel finds the same
 * numbers in the same place every hour, with the changes underneath.
 */
import type { ProgressEvent, RepositoryReading } from "../../services/anyps5/repository.types.js";
import type { SnapshotRecord } from "./repository.types.js";
import { formatCount, truncate } from "./repository.events.js";

/** How many libraries are listed as "least complete". */
const LEAST_COMPLETE = 3;
/** Characters allowed in one field body before it is shortened. */
const MAX_FIELD = 1_024;

/** A ready-to-send message: a title, a body, and up to two columns of numbers. */
export interface ReportContent {
  readonly title: string;
  readonly url: string;
  readonly description: string;
  readonly metrics: readonly { readonly name: string; readonly value: string }[];
  readonly changes: string | null;
  readonly footer: string;
  /** `true` when anything changed, so the caller can pick a colour. */
  readonly changed: boolean;
}

/**
 * @param reading the state just fetched.
 * @param previous the last stored snapshot, for the deltas and the trend.
 * @param events the events that were claimed for this refresh.
 * @param history recent snapshots, oldest first, for the trend footer.
 */
export function buildReportContent(
  reading: RepositoryReading,
  previous: SnapshotRecord | null,
  events: readonly ProgressEvent[],
  history: readonly SnapshotRecord[] = [],
): ReportContent {
  const openPulls = reading.pullRequests.filter((pull) => pull.state === "open");
  const description = [
    ...(reading.facts.description === null ? [] : [reading.facts.description]),
    `★ ${formatCount(reading.facts.stars)} · ⑂ ${formatCount(reading.facts.forks)} · ` +
      `${formatCount(reading.facts.openIssues)} open issues · ${openPulls.length} open PRs (of the last ${reading.pullRequests.length})`,
  ].join("\n");

  const metrics: { name: string; value: string }[] = [];
  if (reading.progress === null) {
    metrics.push({
      name: "Implementation statistics",
      // Never "0%": there is no number, and inventing one would be a lie.
      value: `Unavailable — ${reading.progressUnavailable ?? "the project published no progress snapshot"}`,
    });
  } else {
    const { libraries, shaders } = reading.progress;
    metrics.push(
      {
        name: "System libraries",
        value: [
          `**${libraries.percent}%** — ${formatCount(libraries.done)}/${formatCount(libraries.total)} functions`,
          ...changeSince(previous?.state.libraryPercent ?? null, libraries.percent),
        ].join("\n"),
      },
      {
        name: "GPU shader instructions",
        value: [
          `**${shaders.percent}%** — ${formatCount(shaders.done)}/${formatCount(shaders.total)} instructions`,
          ...changeSince(previous?.state.shaderPercent ?? null, shaders.percent),
        ].join("\n"),
      },
    );

    const least = [...libraries.groups]
      .filter((group) => group.total > 0 && group.done < group.total)
      .sort((a, b) => b.total - b.done - (a.total - a.done))
      .slice(0, LEAST_COMPLETE);
    if (least.length > 0) {
      metrics.push({
        name: "Least complete libraries",
        value: least
          .map((group) => `\`${group.label}\` ${group.done}/${group.total} (${group.percent}%)`)
          .join("\n"),
      });
    }
  }

  if (openPulls.length > 0) {
    metrics.push({
      name: "Open pull requests",
      value: truncate(
        openPulls
          .slice(0, 5)
          .map((pull) => `#${pull.number} ${truncate(pull.title, 80)}`)
          .join("\n"),
        MAX_FIELD,
      ),
    });
  }

  return {
    title: `${reading.facts.fullName} — implementation progress`,
    url: `https://github.com/${reading.facts.fullName}`,
    description,
    metrics,
    changes:
      events.length === 0
        ? null
        : truncate(events.map((event) => `• ${event.text}`).join("\n"), MAX_FIELD),
    footer: footerFor(reading, history),
    changed: events.length > 0,
  };
}

/** @returns ["+0.1 pp since the last snapshot"], or nothing when unchanged. */
function changeSince(before: number | null, now: number): string[] {
  if (before === null || before === now) {
    return [];
  }
  const change = Math.round((now - before) * 100) / 100;
  return [`${change > 0 ? "+" : ""}${change} pp since the last snapshot`];
}

/** @returns the footer text: which commit the numbers describe, plus the trend. */
function footerFor(reading: RepositoryReading, history: readonly SnapshotRecord[]): string {
  const at =
    reading.progressCommit === null
      ? reading.progress === null
        ? "Statistics unavailable"
        : "Statistics from the published snapshot"
      : `Statistics at ${reading.progressCommit.slice(0, 7)}`;

  const points = history
    .map((snapshot) => snapshot.state.libraryPercent)
    .filter((value): value is number => value !== null);
  if (points.length < 2) {
    return at;
  }
  const change = Math.round(((points[points.length - 1] ?? 0) - (points[0] ?? 0)) * 100) / 100;
  return `${at} · ${change >= 0 ? "▲" : "▼"} ${Math.abs(change)} pp over ${points.length} snapshots`;
}
