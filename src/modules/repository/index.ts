/**
 * Repository monitor module (V9).
 *
 * Tracks a GitHub project's implementation statistics, commits and pull requests.
 * The split is the same one the other modules use:
 *
 * - `services/anyps5/*` — reading the project (its published `progress.json`, its
 *   commits and pull requests) and the port of its own scan script;
 * - `services/github/*` — the REST client that reading goes through;
 * - `repository.service.ts` — the rules: what is new, what to announce, what to
 *   keep;
 * - `repository.events.ts` — the pure judgement about what counts as news;
 * - `repository.tasks.ts` — the recurring scheduler task that runs it hourly;
 * - `discord-repository-report.ts` — the one Discord operation it needs;
 * - `repository-analytics.ts` — the series statistics behind `/github`;
 * - `repository-chart.ts` — the text charts those statistics are drawn with;
 * - `github-view.ts` — `/github` itself, as embeds and components, without
 *   discord.js;
 * - `github-components.ts` — the one conversion of that view into discord.js
 *   builders, shared by the slash command and the component handler.
 * - `github-message.ts` — `!g`, the same panels typed as a message prefix.
 */
export {
  HISTORY_WINDOW,
  RepositoryMonitorService,
  SNAPSHOT_RETENTION,
  type RefreshReport,
  type RepositoryMonitorOptions,
  type RepositoryReportPort,
} from "./repository.service.js";
export {
  RepositoryRefresher,
  REPOSITORY_REFRESH_TASK_KIND,
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  MIN_REFRESH_INTERVAL_MINUTES,
} from "./repository.tasks.js";
export { deriveEvents, formatCount, truncate } from "./repository.events.js";
export { buildReportContent, type ReportContent } from "./repository-report.content.js";
export { DiscordRepositoryReport, renderEmbed } from "./discord-repository-report.js";
export { PrismaRepositoryMonitorRepository } from "./prisma-repository.repository.js";
export {
  buildGithubView,
  chunk,
  formatSpan,
  isGithubComponent,
  PANEL_IDS,
  panelCustomId,
  parsePanelCustomId,
  relativeTime,
  absoluteTime,
  sparklineStrip,
  type ComponentButton,
  type ComponentRows,
  type ComponentSelect,
  type GithubContext,
  type GithubPanel,
  type GithubView,
  type PanelRequest,
  type ViewBlock,
  type ViewSection,
} from "./github-view.js";
export {
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
  type ImplementationSeries,
  type LibraryAnalysis,
  type LibraryMovementRow,
  type LibraryReading,
  type SeriesPoint,
  type TrendSummary,
} from "./repository-analytics.js";
export {
  buildReportStats,
  bucketEdges,
  bucketHoursFor,
  HOURLY_RANGE_LIMIT_HOURS,
  REPORT_RANGES,
  reportRange,
  reportWindowFor,
  type Coverage,
  type CommitStats,
  type ProgressStats,
  type PullRequestStats,
  type ReportBucket,
  type ReportRangeId,
  type ReportStats,
} from "./repository-report.analytics.js";
export {
  buildReport,
  chunksOf,
  formatHours,
  parseReportCustomId,
  reportCustomId,
  REPORT_PAGES,
  REPORT_PREFIX,
  type ReportContext,
  type ReportPage,
} from "./github-report.view.js";
export {
  renderView,
  toComponents,
  toContainer,
  IS_COMPONENTS_V2,
  type ReplyPayload,
} from "./github-components.js";
export {
  GITHUB_MESSAGE_PREFIX,
  githubMessageHelp,
  parseGithubMessage,
  type GithubMessageRequest,
} from "./github-message.js";
export type {
  MonitorRecord,
  PendingEvent,
  RepositoryMonitorRepository,
  SnapshotInput,
  SnapshotRecord,
} from "./repository.types.js";
