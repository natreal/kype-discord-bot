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
 *   stored row, so "opened" and "merged" are two events, never two rows.
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
import { toReportedState, type ProgressEvent, type RepositoryReading } from "../../services/anyps5/repository.types.js";
import type {
  MonitorRecord,
  RepositoryMonitorRepository,
  SnapshotRecord,
} from "./repository.types.js";
import { deriveEvents } from "./repository.events.js";

/** How many snapshots are kept per repository (about four days at hourly). */
export const SNAPSHOT_RETENTION = 100;
/** How many snapshots the history view reads (one day at hourly). */
export const HISTORY_WINDOW = 24;

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

  public constructor(options: RepositoryMonitorOptions) {
    this.repository = options.repository;
    this.probe = options.probe;
    this.report = options.report;
    this.logger = options.logger.child("repository-monitor");
    this.now = options.now ?? (() => new Date());
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
    const [commitShas, pullResult] = await Promise.all([
      this.repository.upsertCommits(record.id, reading.commits),
      this.repository.upsertPullRequests(record.id, reading.pullRequests),
    ]);

    const state = toReportedState(reading);
    await this.repository.appendSnapshot({
      repositoryId: record.id,
      capturedAt: reading.fetchedAt,
      state,
      progressCommit: reading.progressCommit,
      progress: reading.progress,
      commitCount: Math.min(reading.commits.length, COMMIT_WINDOW),
      pullCount: Math.min(reading.pullRequests.length, PULL_REQUEST_WINDOW),
      failures,
    });
    await this.repository.saveSyncState(record.id, {
      commitsEtag: nextCache.commitsEtag,
      pullRequestsEtag: nextCache.pullRequestsEtag,
      cursorCommit: reading.commits[0]?.sha ?? record.cursorCommit,
      repositoryId: record.repositoryId,
    });
    await this.prune(record.id);

    const events = announce
      ? deriveEvents(reading, previous, commitShas, pullResult)
      : [];
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

  /** Deletes snapshots beyond the retention window. */
  private async prune(repositoryId: string): Promise<void> {
    const cutoff = new Date(this.now().getTime() - SNAPSHOT_RETENTION * 3_600_000);
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

