/**
 * Storage contracts for the repository monitor (V9).
 *
 * The service depends on this port rather than on Prisma, exactly as the scheduler
 * and the backup module do, so its rules — deduplication, event derivation, history
 * windows — are testable against an in-memory store.
 */
import type {
  ReportedState,
  RepositoryCommit,
  RepositoryPullRequest,
} from "../../services/anyps5/repository.types.js";
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
  /**
   * The full `progress.json` this snapshot recorded, per-library table included.
   *
   * `null` when the reading could not fetch it. Kept because a per-library trend
   * (`/github libraries`, `/github why`) needs the table behind the headline
   * percentage, and re-fetching a past document is not possible: the project
   * publishes only its current state.
   */
  readonly progress: AnyPs5Progress | null;
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
  /**
   * Recently merged pull requests, from the dedicated merge window.
   *
   * Stored through the same upsert as the row windows, and *only* through it: a merge
   * is dated by `mergedAt`, and `mergedAt` reaches the database only when the payload
   * that carried it does. Persisting this window is what lets `/github report` count
   * merges precisely instead of inferring them from a percentage step.
   */
  readonly merges: readonly RepositoryPullRequest[];
  readonly failures: readonly string[];
}

/** One stored commit, as a report reads it: when it landed, who wrote it, what it said. */
export interface ReportCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: string | null;
  readonly committedAt: Date;
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
   * The newest `limit` snapshots whose `capturedAt` falls in `[from, to)`, oldest
   * first, with the published `progress.json` **included**.
   *
   * A separate read rather than an option on {@link recentSnapshots} because of what
   * it costs: the stored document is a per-library table of roughly ten kilobytes per
   * row, so a report over a day loads megabytes. Paying that on every `/github` panel
   * would be wasting it; paying it once for a report that needs the table is the
   * point of the command.
   */
  snapshotsBetween(
    repositoryId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<SnapshotRecord[]>;

  /**
   * Every stored pull request created, merged or closed in `[from, to]`, newest
   * creation first.
   *
   * Filtered in the database on the three timestamps rather than by reading the
   * newest rows: `/github report` counts what happened in a window, and a pull request
   * created last month but merged an hour ago belongs to that hour.
   */
  pullRequestsBetween(
    repositoryId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<readonly RepositoryPullRequest[]>;

  /**
   * Stored commits with `committedAt` in `[from, to]`, newest first.
   *
   * Commits are their own table, so a report cannot get them from a snapshot: a window
   * of snapshots says what the project was, and only this says how much landed.
   */
  commitsBetween(
    repositoryId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<readonly ReportCommit[]>;

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
   * @returns the events worth announcing: a pull request that is new **and still
   * open** — one first seen already closed is history, not news — and one whose
   * merge this refresh is the first to record. A merge is included even when the
   * row was never seen before, because a merged pull request usually reaches the
   * monitor through the closed window, days after it was created.
   */
  upsertPullRequests(
    repositoryId: string,
    pulls: readonly RepositoryPullRequest[],
  ): Promise<{ readonly created: readonly number[]; readonly merged: readonly number[] }>;

  /**
   * The newest stored pull requests, by creation, for the snapshot views.
   *
   * Read from storage rather than re-fetched: `/github status` describes one
   * snapshot, and a command that went to GitHub would mix two moments in one embed.
   */
  recentPullRequests(
    repositoryId: string,
    limit: number,
  ): Promise<readonly RepositoryPullRequest[]>;

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
