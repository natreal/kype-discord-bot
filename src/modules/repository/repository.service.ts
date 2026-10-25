/**
 * The repository monitor service (V9).
 *
 * One refresh = read the repository, store what is new, work out what changed, and
 * say so. Everything here is written to be safe to run *twice*:
 *
 * - **The schedule is a single row.** The hourly job is one recurring
 *   `repository.refresh` task per repository, created with a dedupe key. Overlapping
 *   runs are prevented by the scheduler's conditional claim, not by a flag in this
 *   process, so a second process cannot double-post either.
 * - **A commit is announced once.** Presence in `repository_commits` decides it:
 *   the first refresh that sees a commit stores it and announces it, and every later
 *   refresh finds it already there.
 * - **A pull request's *merge* is announced once.** Before/after state comes from the
 *   stored row, so "opened" and "merged" are two events, never two rows. The merge
 *   is also the reason the probe reads two GitHub windows: by the time a pull request
 *   merges it is long out of the newest-created one.
 * - **An announcement is claimed before it is sent.** `claimEvents` inserts into a
 *   unique index, so a retried task cannot repeat a message even if it failed
 *   halfway through posting.
 *
 * The first refresh after a watch is created announces nothing: the repository
 * already has a history, and reposting it would be noise rather than news. It
 * records the state the trend line starts from.
 */
import type { Logger } from "../../services/logger/index.js";
import {
  type RepositoryProbe,
  COMMIT_WINDOW,
  PULL_REQUEST_WINDOW,
  type RepositoryCache,
} from "../../services/anyps5/repository.probe.js";
import {
  toReportedState,
  type ProgressEvent,
  type RepositoryPullRequest,
  type RepositoryReading,
} from "../../services/anyps5/repository.types.js";
import type {
  MonitorRecord,
  ReportCommit,
  RepositoryMonitorRepository,
  SnapshotRecord,
} from "./repository.types.js";
import { deriveEvents } from "./repository.events.js";

/**
 * Snapshots kept per repository: a count, which becomes a cutoff when it is pruned.
 *
 * Sized so the count never cuts inside a window a report can ask for: at the default
 * fifteen-minute refresh 960 rows is ten days. Pruning and reporting are two different
 * measures — rows kept and hours asked for — and the row count has to be the larger one
 * or `/github report range:1d` would silently lose its oldest hours after a few days.
 */
export const SNAPSHOT_RETENTION = 960;

/**
 * Hours of history kept, derived from the count at the configured cadence.
 *
 * The cutoff is in hours rather than rows because that is what the storage port prunes
 * by (`pruneSnapshots(id, before)`), and because a cadence change must move the cutoff
 * with it: ten days at fifteen minutes is 960 rows, and the same 960 at an hourly
 * cadence would be forty days of rows but still one honest cutoff.
 */
export function retentionHours(intervalMinutes: number): number {
  return (SNAPSHOT_RETENTION * Math.max(1, intervalMinutes)) / 60;
}
/** How many snapshots the history view reads (six hours at the default cadence). */
export const HISTORY_WINDOW = 24;

/**
 * Snapshots one report reads at most.
 *
 * Equal to {@link SNAPSHOT_RETENTION}: the two are a pair, and a report reading fewer
 * rows than are kept would drop the *oldest* hours of the longest range it offers —
 * exactly the part a reader asking for a long range has not seen yet. The cap is still
 * written down here, because a query needs one.
 */
export const REPORT_SNAPSHOT_ROWS = SNAPSHOT_RETENTION;

/**
 * Pull requests one report reads at most.
 *
 * Comfortably above what a repository creating a few pull requests a day can produce
 * over the longest range offered, and still one bounded query.
 */
export const REPORT_PULL_ROWS = 2_000;

/** The data one report is built from: one window, read once. */
export interface ReportWindow {
  /** Oldest instant included. */
  readonly from: Date;
  /** Newest instant included. */
  readonly to: Date;
  /** Snapshots in the window, oldest first, each with its published document. */
  readonly snapshots: readonly SnapshotRecord[];
  /** Pull requests created, merged or closed in the window. */
  readonly pullRequests: readonly RepositoryPullRequest[];
  /** Commits dated inside the window, newest first. */
  readonly commits: readonly ReportCommit[];
}

/** Commits one report reads at most: a week of a very busy branch, and still one query. */
export const REPORT_COMMIT_ROWS = 5_000;

/** Where a report goes. Narrow on purpose: the service posts, it does not own Discord. */
export interface RepositoryReportPort {
  /**
   * @param events the events claimed for this refresh. Passed in rather than
   * re-derived, so the message can never disagree with what was recorded.
   * @returns true when a message was delivered, false when there was nowhere to send.
   */
  publish(
    reading: RepositoryReading,
    previous: SnapshotRecord | null,
    events: readonly ProgressEvent[],
  ): Promise<boolean>;
}

export interface RepositoryMonitorOptions {
  readonly repository: RepositoryMonitorRepository;
  readonly probe: RepositoryProbe;
  readonly report: RepositoryReportPort;
  readonly logger: Logger;
  /** Overridable for tests; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * The refresh cadence, which sets how many hours of snapshots are kept.
   *
   * Optional so an existing caller keeps the hourly retention it had: a monitor that
   * does not say how often it runs cannot know that ten days of history is the right
   * window, and guessing shorter would throw away a week of a report's data.
   */
  readonly intervalMinutes?: number;
}

/** What one refresh did, for the task result detail and the tests. */
export interface RefreshReport {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly capturedAt: Date;
  readonly librariesPercent: number | null;
  readonly shaderPercent: number | null;
  readonly stars: number;
  /** `true` when this refresh was the baseline and announced nothing. */
  readonly baseline: boolean;
  readonly announced: number;
  readonly failures: readonly string[];
}

export class RepositoryMonitorService {
  private readonly repository: RepositoryMonitorRepository;
  private readonly probe: RepositoryProbe;
  private readonly report: RepositoryReportPort;
  private readonly logger: Logger;
  private readonly now: () => Date;
  /** History kept, in hours, derived from the refresh cadence. */
  private readonly retentionHours: number;

  public constructor(options: RepositoryMonitorOptions) {
    this.repository = options.repository;
    this.probe = options.probe;
    this.report = options.report;
    this.logger = options.logger.child("repository-monitor");
    this.now = options.now ?? (() => new Date());
    // Defaulted to the fifteen-minute cadence the deployment ships with, so a caller that
    // does not know the interval still keeps the same number of readings of history.
    this.retentionHours = retentionHours(options.intervalMinutes ?? 15);
  }

  /** The `owner/repo` name the probe is configured with. */
  public get fullName(): string {
    return this.probe.fullName;
  }

  /**
   * Ensures the watch exists and returns it.
   *
   * Called on every refresh, so a deployment that only configures the repository in
   * `.env` needs no seeding step.
   */
  public async ensureWatched(): Promise<MonitorRecord> {
    const [owner = "", name = ""] = this.probe.fullName.split("/");
    const record = await this.repository.ensure({
      owner,
      name,
      branch: null,
      displayName: null,
      repositoryId: null,
    });
    this.logger.debug("Repository watch resolved", {
      id: record.id,
      fullName: this.probe.fullName,
    });
    return record;
  }

  /**
   * Reads, stores and reports one snapshot.
   *
   * @param options `announce: false` records a baseline without posting the
   * repository's existing history. The first refresh is always a baseline, whatever
   * the caller asks, because there is no "before" to compare with.
   */
  public async refresh(options: { readonly announce?: boolean } = {}): Promise<RefreshReport> {
    const record = await this.ensureWatched();
    const cache: RepositoryCache = {
      commitsEtag: record.commitsEtag,
      pullRequestsEtag: record.pullRequestsEtag,
    };

    const { reading, cache: nextCache, failures } = await this.probe.read(cache);
    const previous = await this.repository.latestSnapshot(record.id);
    const baseline = previous === null;
    const announce = (options.announce ?? true) && !baseline;

    // Stored before they are reported: an announcement that cannot find its commit
    // in the table on a retry would be announced a second time.
    //
    // The merge window goes through the same upsert, in the same call: it is a third
    // *view* of pull requests the first two may already hold, and upserting by number
    // means a merge it carries is written to the row the created window made.
    const merges = reading.recentlyMerged;
    const [commitShas, pullResult] = await Promise.all([
      this.repository.upsertCommits(record.id, reading.commits),
      this.repository.upsertPullRequests(
        record.id,
        merges.length === 0 ? reading.pullRequests : [...reading.pullRequests, ...merges],
      ),
    ]);

    const state = toReportedState(reading);
    await this.repository.appendSnapshot({
      repositoryId: record.id,
      capturedAt: reading.fetchedAt,
      state,
      progressCommit: reading.progressCommit,
      progress: reading.progress,
      commitCount: Math.min(reading.commits.length, COMMIT_WINDOW),
      // Both pull-request windows are counted: `pullCount` says how many rows the
      // reading held, not how many fit in one window.
      pullCount: reading.pullRequests.length,
      merges,
      failures,
    });
    await this.repository.saveSyncState(record.id, {
      commitsEtag: nextCache.commitsEtag,
      pullRequestsEtag: nextCache.pullRequestsEtag,
      cursorCommit: reading.commits[0]?.sha ?? record.cursorCommit,
      repositoryId: record.repositoryId,
    });
    await this.prune(record.id);

    const events = announce ? deriveEvents(reading, previous, commitShas, pullResult) : [];
    const claimed = events.length === 0 ? [] : await this.repository.claimEvents(record.id, events);
    // Nothing changed and nothing new: no message. An hourly "still 47.39%" would
    // train the channel to ignore the bot, which is the failure mode worth avoiding.
    const published = claimed.length > 0 ? await this.publish(reading, previous, claimed) : false;

    this.logger.info("Repository snapshot stored", {
      fullName: this.probe.fullName,
      capturedAt: reading.fetchedAt.toISOString(),
      librariesPercent: state.libraryPercent,
      shaderPercent: state.shaderPercent,
      commits: reading.commits.length,
      pullRequests: reading.pullRequests.length,
      baseline,
      newEvents: claimed.length,
      published,
      failures,
    });

    return {
      repositoryId: record.id,
      fullName: this.probe.fullName,
      capturedAt: reading.fetchedAt,
      librariesPercent: state.libraryPercent,
      shaderPercent: state.shaderPercent,
      stars: state.stars,
      baseline,
      announced: claimed.length,
      failures,
    };
  }

  /** The most recent snapshots, oldest first, for the trend view. */
  public async history(limit = HISTORY_WINDOW): Promise<SnapshotRecord[]> {
    const record = await this.ensureWatched();
    return this.repository.recentSnapshots(record.id, limit);
  }

  /** The latest stored snapshot, or `null` on a fresh watch. */
  public async latest(): Promise<SnapshotRecord | null> {
    const record = await this.ensureWatched();
    return this.repository.latestSnapshot(record.id);
  }

  /**
   * Everything `/github report` needs for one window, read in two queries.
   *
   * Returned together rather than through three getters so the report cannot mix
   * windows: the snapshots, the pull requests and their wall-clock bounds all describe
   * the same `[from, to]`, and a caller that assembled them itself could pick two.
   *
   * @param from the oldest instant included.
   * @param to the newest instant included; defaults to now, not to the newest snapshot,
   * so a report says "the last 4 hours" even if the monitor has been down for three
   * of them — the gap is then visible in the data instead of hidden by the bounds.
   */
  public async reportWindow(from: Date, to: Date = this.now()): Promise<ReportWindow> {
    const record = await this.ensureWatched();
    // All three reads are bounded, so a report is a bounded amount of work whatever
    // range it is asked for.
    const [snapshots, pullRequests, commits] = await Promise.all([
      this.repository.snapshotsBetween(record.id, from, to, REPORT_SNAPSHOT_ROWS),
      this.repository.pullRequestsBetween(record.id, from, to, REPORT_PULL_ROWS),
      this.repository.commitsBetween(record.id, from, to, REPORT_COMMIT_ROWS),
    ]);
    return { from, to, snapshots, pullRequests, commits };
  }

  /**
   * The pull requests the last refresh stored, newest created first.
   *
   * `/github status` renders a snapshot, so it reads this rather than the network:
   * a command that fetched would show pull requests from a different moment than
   * the percentages beside them.
   */
  public async recentPullRequests(
    limit = PULL_REQUEST_WINDOW,
  ): Promise<readonly RepositoryPullRequest[]> {
    const record = await this.ensureWatched();
    return this.repository.recentPullRequests(record.id, limit);
  }

  /** Deletes snapshots beyond the retention window. */
  private async prune(repositoryId: string): Promise<void> {
    // Kept as hours, not rows: the storage port prunes by date, and a count here would
    // mean reading every row back to find the cutoff. `SNAPSHOT_RETENTION` is the count
    // that window is sized from, so the two cannot drift apart.
    const cutoff = new Date(this.now().getTime() - this.retentionHours * 3_600_000);
    const removed = await this.repository.pruneSnapshots(repositoryId, cutoff);
    if (removed > 0) {
      this.logger.debug("Pruned old repository snapshots", { repositoryId, removed });
    }
  }

  /** Posts the report; a delivery failure is logged, never rethrown. */
  private async publish(
    reading: RepositoryReading,
    previous: SnapshotRecord | null,
    events: readonly ProgressEvent[],
  ): Promise<boolean> {
    try {
      return await this.report.publish(reading, previous, events);
    } catch (error) {
      // The events are already claimed, so this message will not be retried: that is
      // deliberate. Reposting a day of commits because one embed failed would be
      // worse than missing one notification, and the snapshot itself is stored.
      this.logger.error("Failed to publish the repository report", error, {
        fullName: this.probe.fullName,
      });
      return false;
    }
  }
}
