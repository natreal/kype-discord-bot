/**
 * One `/github` answer, whatever asked for it.
 *
 * The slash command and the `!g` prefix must never disagree: two render paths is how
 * a panel ends up correct when clicked and wrong when typed. This module owns the
 * reading and the building, and each surface only decides how to deliver the result —
 * an interaction edit, or a message reply.
 *
 * Nothing here touches discord.js, so the whole surface is testable without a client.
 */
import { buildGithubView, type GithubContext, type GithubPanel } from "./github-view.js";
import { githubMessageHelp, parseGithubMessage } from "./github-message.js";
import { renderReport, type ReportPage } from "./github-report.view.js";
import { renderView, type ReplyPayload } from "./github-components.js";
import {
  buildReportStats,
  reportWindowFor,
  type ReportRangeId,
} from "./repository-report.analytics.js";
import type { RepositoryMonitorService } from "./repository.service.js";
import type { GitHubLiveFacts } from "../../services/github/live-feed.js";
import { BAR_GUTTER, MAX_ROW } from "./repository-chart.js";

/**
 * Snapshots read per render.
 *
 * The storage window, not a display limit: the trend fields and the decomposition
 * want as much history as the monitor keeps, and each panel trims what it draws.
 */
const HISTORY_ROWS = 72;

/**
 * Columns the graph draws: one per snapshot, at a width that fits a phone.
 *
 * A phone shows roughly 25 characters of a fenced block before it scrolls, and a
 * fenced block does not wrap. `bars` is the wider style — it prepends a `100.00%┫`
 * gutter — so the columns are `MAX_ROW` minus the widest gutter that style can draw.
 * Deriving it instead of writing two numbers is what keeps a `bars` chart from being
 * the one that overflows.
 */
export const GRAPH_WIDTH = MAX_ROW - BAR_GUTTER;

/**
 * What one answer is: a Components V2 payload, or a line of prose.
 *
 * `history` and `help` are lists of text, not panels — a `!g help` that had to be
 * dressed as a container would be a worse answer than the plain sentence it is.
 */
export type GithubAnswer =
  | { readonly kind: "view"; readonly payload: ReplyPayload; readonly blockCount: number }
  | { readonly kind: "text"; readonly text: string };

/**
 * @returns the panel answer for one monitor.
 *
 * The history is read once and handed to the view, which decides what each panel
 * needs: the overview wants the latest two readings, the graph wants the window,
 * `why` wants the last comparable pair. Reading per panel would put that choice in
 * two places and let them drift.
 */
export async function renderGithubPanel(input: {
  readonly monitor: RepositoryMonitorService;
  readonly panel: GithubPanel;
  readonly style: "bars" | "line";
  readonly ownerId: string | null;
  readonly width?: number;
  /**
   * Whether to ask the live feed, and where to put its answer.
   *
   * The slash command asks for it explicitly because its own subcommand already did;
   * `!g` asks here so a typed panel shows the stars and releases a clicked one does.
   * Omitted means "do not ask", which keeps the renderer usable without a feed.
   */
  readonly live?: "fetch" | GitHubLiveFacts | null | undefined;
}): Promise<GithubAnswer> {
  const [history, live] = await Promise.all([
    input.monitor.history(HISTORY_ROWS),
    // Cached for two minutes and time-boxed, so this costs a reply nothing when
    // GitHub is slow, and a failure leaves the panel without the live fields rather
    // than without an answer.
    input.live === "fetch" ? input.monitor.liveFacts().catch(() => undefined) : input.live,
  ]);
  const context: GithubContext = {
    fullName: input.monitor.fullName,
    repoUrl: `https://github.com/${input.monitor.fullName}`,
    history,
    latest: history.at(-1) ?? null,
    panel: input.panel,
    style: input.style,
    width: input.width ?? GRAPH_WIDTH,
    ownerId: input.ownerId,
    // Omitted rather than `null` when the feed is absent: the view treats a missing
    // value as "not asked" and a `null` as "GitHub did not answer", so the two cannot
    // be confused in the reply.
    ...(live === undefined ? {} : { live }),
  };
  const view = buildGithubView(context);
  return { kind: "view", payload: renderView(view), blockCount: view.blocks.length };
}

/** @returns the report answer for one monitor and range. */
export async function renderGithubReport(input: {
  readonly monitor: RepositoryMonitorService;
  readonly range: ReportRangeId;
  readonly page?: ReportPage;
}): Promise<GithubAnswer> {
  const window = reportWindowFor(input.range, new Date());
  const data = await input.monitor.reportWindow(window.from, window.to);
  if (data.snapshots.length === 0 && data.pullRequests.length === 0) {
    return {
      kind: "text",
      text:
        "Nothing is recorded in that window yet. The monitor fills in as it refreshes; " +
        "`/github refresh` takes a snapshot now.",
    };
  }

  const stats = buildReportStats({
    rangeId: input.range,
    window: { from: data.from, to: data.to },
    snapshots: data.snapshots,
    pullRequests: data.pullRequests,
    commits: data.commits.map((commit) => ({
      at: commit.committedAt,
      author: commit.author,
      message: commit.message,
    })),
  });
  const view = renderReport({
    stats,
    fullName: input.monitor.fullName,
    repoUrl: `https://github.com/${input.monitor.fullName}`,
    page: input.page ?? "overview",
  });
  return { kind: "view", payload: renderView(view), blockCount: view.blocks.length };
}

/**
 * @returns the answer for any `!g` message, or `null` when the message is not one.
 *
 * Delegating to {@link parseGithubMessage} and then to the same renderers the slash
 * command uses is the whole point of this module: `!g graph bars` cannot show a
 * different chart from `/github graph style:bars`, because there is one renderer.
 */
export async function renderGithubMessage(input: {
  readonly content: string;
  readonly monitor: RepositoryMonitorService;
  readonly ownerId: string | null;
}): Promise<GithubAnswer | null> {
  const request = parseGithubMessage(input.content);
  if (request === null) {
    return null;
  }
  switch (request.kind) {
    case "help":
      return { kind: "text", text: githubMessageHelp(input.monitor.fullName) };
    case "report":
      return renderGithubReport({ monitor: input.monitor, range: request.range });
    case "history":
      return {
        kind: "text",
        text: await renderGithubHistory({ monitor: input.monitor, limit: request.limit }),
      };
    case "panel":
      return renderGithubPanel({
        monitor: input.monitor,
        panel: request.panel,
        style: request.style,
        ownerId: input.ownerId,
        // A typed panel shows the same live fields a clicked one does. Asking here
        // rather than in `messageCreate` keeps the fetch next to the render that needs
        // it, and the prefix never has to know which panels use it.
        live: "fetch",
      });
  }
}

/**
 * @returns one line per stored snapshot, oldest first, for `!g history`.
 *
 * Timestamps use Discord's `<t:…>` format rather than a formatted date: `!g` has no
 * interaction to localise against, and every client renders that mark in its own
 * language and timezone.
 */
export async function renderGithubHistory(input: {
  readonly monitor: RepositoryMonitorService;
  readonly limit: number;
}): Promise<string> {
  const history = (await input.monitor.history(input.limit)).slice(-input.limit);
  if (history.length === 0) {
    return "Nothing recorded yet. Run `/github refresh` to take the first snapshot.";
  }
  return renderGithubHistoryRows(history);
}

/**
 * @returns one line per snapshot, for a history already read.
 *
 * Exported separately so `/github history` can read once and then format: reading
 * inside the formatter would either fetch twice or force the caller to refetch to
 * know how many rows it got.
 */
export function renderGithubHistoryRows(
  history: readonly { readonly capturedAt: Date; readonly state: SnapshotStateLike }[],
): string {
  const cell = (value: number | null): string => (value === null ? "—" : `${value}%`);
  return history
    .map((snapshot) => {
      const epoch = Math.floor(snapshot.capturedAt.getTime() / 1_000);
      const libraries = cell(snapshot.state.libraryPercent);
      const shaders = cell(snapshot.state.shaderPercent);
      return `<t:${epoch}:f> · libraries ${libraries} · shaders ${shaders}`;
    })
    .join("\n");
}

/** The two figures a history line prints, so the formatter needs nothing else. */
interface SnapshotStateLike {
  readonly libraryPercent: number | null;
  readonly shaderPercent: number | null;
}
