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
 * - `discord-repository-report.ts` — the one Discord operation it needs.
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
  repositoryGuildId,
} from "./repository.tasks.js";
export { deriveEvents, formatCount, truncate } from "./repository.events.js";
export { buildReportContent, type ReportContent } from "./repository-report.content.js";
export { DiscordRepositoryReport, renderEmbed } from "./discord-repository-report.js";
export { PrismaRepositoryMonitorRepository } from "./prisma-repository.repository.js";
export type {
  MonitorRecord,
  PendingEvent,
  RepositoryMonitorRepository,
  SnapshotInput,
  SnapshotRecord,
} from "./repository.types.js";
