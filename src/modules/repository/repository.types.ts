/**
 * Storage contracts for the repository monitor (V9).
 *
 * The service depends on this port rather than on Prisma, exactly as the scheduler
 * and the backup module do, so its rules — deduplication, event derivation, history
 * windows — are testable against an in-memory store.
 */
import type { ReportedState, RepositoryCommit, RepositoryPullRequest } from "../../services/anyps5/repository.types.js";
import type { AnyPs5Progress } from "../../services/anyps5/progress.js";

/** A watched repository, as stored. */
export interface MonitorRecord {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly branch: string | null;
  readonly displayName: string | null;
  readonly repositoryId: number | null;
  readonly enabled: boolean;
  readonly commitsEtag: string | null;
  readonly pullRequestsEtag: string | null;
  readonly cursorCommit: string | null;
}

/** One stored snapshot, normalized for reporting. */
export interface SnapshotRecord {
  readonly id: string;
  readonly capturedAt: Date;
  readonly state: ReportedState;
  readonly progressCommit: string | null;
  readonly commitCount: number;
  readonly pullCount: number;
  readonly failures: readonly string[];
}

/** What a refresh writes. */
export interface SnapshotInput {
  readonly repositoryId: string;
  readonly capturedAt: Date;
  readonly state: ReportedState;
  readonly progressCommit: string | null;
  readonly progress: AnyPs5Progress | null;
  readonly commitCount: number;
  readonly pullCount: number;
  readonly failures: readonly string[];
}

/** An event that has not been announced yet. */
export interface PendingEvent {
  readonly kind: string;
  readonly key: string;
  readonly text: string;
}

export interface RepositoryMonitorRepository {
  /** @returns the stored row for `owner/name`, creating it on first use. */
  ensure(input: {
    readonly owner: string;
    readonly name: string;
    readonly branch: string | null;
    readonly displayName: string | null;
    readonly repositoryId: number | null;
  }): Promise<MonitorRecord>;

  /** Every enabled watch. */
  listEnabled(): Promise<MonitorRecord[]>;

  /** Persists the tokens a refresh learned. */
  saveSyncState(
    id: string,
    state: {
      readonly commitsEtag: string | null;
      readonly pullRequestsEtag: string | null;
      readonly cursorCommit: string | null;
      readonly repositoryId: number | null;
    },
  ): Promise<void>;

  /** Inserts a snapshot. Always a new row: history is the point. */
  appendSnapshot(input: SnapshotInput): Promise<SnapshotRecord>;

  /** The most recent snapshot, or `null` on a fresh watch. */
  latestSnapshot(repositoryId: string): Promise<SnapshotRecord | null>;

  /** The newest `limit` snapshots, oldest first, for a trend line. */
  recentSnapshots(repositoryId: string, limit: number): Promise<SnapshotRecord[]>;

  /**
   * Stores a window of commits.
   *
   * @returns the SHAs that were **new** — i.e. the commits this refresh is the
   * first to observe. That return value is the whole mechanism behind "announce a
   * commit once": presence in the table, not a comparison with the last message.
   */
  upsertCommits(repositoryId: string, commits: readonly RepositoryCommit[]): Promise<string[]>;

  /**
   * Stores a window of pull requests, updating state in place.
   *
   * @returns the events worth announcing: a pull request that is new, and one that
   * has just been merged.
   */
  upsertPullRequests(
    repositoryId: string,
    pulls: readonly RepositoryPullRequest[],
  ): Promise<{ readonly created: number[]; readonly merged: number[] }>;

  /**
   * Records `events` as announced, atomically.
   *
   * @returns only those that were not already recorded, so the caller can render
   * exactly what is new even when two runs overlap.
   */
  claimEvents(repositoryId: string, events: readonly PendingEvent[]): Promise<PendingEvent[]>;

  /** Deletes snapshots older than `before`. @returns how many were removed. */
  pruneSnapshots(repositoryId: string, before: Date): Promise<number>;
}
