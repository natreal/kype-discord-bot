/**
 * In-memory collaborators for the repository-monitor tests.
 *
 * The fake replaces *PostgreSQL only*: the service, the event rules, the scanner
 * and the report builder under test are the production ones, so the suite exercises
 * the code the bot actually runs.
 *
 * Two behaviours are modelled deliberately, because they are what the production
 * guarantees rest on:
 *
 * - `upsertCommits` keeps one row per SHA and returns only the SHAs it had not seen,
 *   which is what makes "announce a commit once" true even across two refreshes;
 * - `upsertPullRequests` reports the same two things the Prisma implementation does:
 *   an opening only for a pull request that is new **and open** (a closed one arrives
 *   through the recently-closed window and is history), and a merge for any row the
 *   store has not already recorded as merged;
 * - `claimEvents` rejects a duplicate key exactly as the unique index does, so a
 *   replayed announcement is dropped here for the same reason it would be dropped in
 *   the database.
 */
import type {
  MonitorRecord,
  PendingEvent,
  RepositoryMonitorRepository,
  SnapshotInput,
  SnapshotRecord,
} from "../../src/modules/repository/repository.types.js";
import type {
  RepositoryCommit,
  RepositoryPullRequest,
} from "../../src/services/anyps5/repository.types.js";

/** Interface for the in-memory store, exposing internals for assertions. */
export interface MemoryMonitorRepository extends RepositoryMonitorRepository {
  readonly monitors: MonitorRecord[];
  readonly snapshots: (SnapshotInput & { readonly id: string })[];
  readonly commits: { repositoryId: string; sha: string }[];
  /** Stored pull requests, in the shape the real table returns. */
  readonly pulls: (RepositoryPullRequest & { readonly repositoryId: string })[];
  readonly events: PendingEvent[];
}

/** Strips the storage-only field, leaving the reading's pull-request shape. */
function toPull(row: RepositoryPullRequest & { repositoryId: string }): RepositoryPullRequest {
  return {
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state,
    draft: row.draft,
    merged: row.merged,
    createdAt: row.createdAt,
    mergedAt: row.mergedAt,
    url: row.url,
  };
}

/** Builds an isolated store. One per test. */
export function memoryMonitorRepository(): MemoryMonitorRepository {
  const monitors: MonitorRecord[] = [];
  const snapshots: (SnapshotInput & { readonly id: string })[] = [];
  const commits: { repositoryId: string; sha: string }[] = [];
  const pulls: (RepositoryPullRequest & { repositoryId: string })[] = [];
  const events: PendingEvent[] = [];
  let counter = 0;

  const toRecord = (input: {
    owner: string;
    name: string;
    branch: string | null;
    displayName: string | null;
    repositoryId: number | null;
  }): MonitorRecord => ({
    id: `repo-${counter + 1}`,
    owner: input.owner,
    name: input.name,
    branch: input.branch,
    displayName: input.displayName,
    repositoryId: input.repositoryId,
    enabled: true,
    commitsEtag: null,
    pullRequestsEtag: null,
    cursorCommit: null,
  });

  const toSnapshotRecord = (input: SnapshotInput & { id: string }): SnapshotRecord => ({
    id: input.id,
    capturedAt: input.capturedAt,
    state: input.state,
    progressCommit: input.progressCommit,
    commitCount: input.commitCount,
    pullCount: input.pullCount,
    failures: input.failures,
  });

  return {
    monitors,
    snapshots,
    commits,
    pulls,
    events,

    ensure(input) {
      const existing = monitors.find(
        (monitor) => monitor.owner === input.owner && monitor.name === input.name,
      );
      if (existing) {
        return Promise.resolve(existing);
      }
      counter += 1;
      const record = toRecord(input);
      monitors.push(record);
      return Promise.resolve(record);
    },

    listEnabled() {
      return Promise.resolve(monitors.filter((monitor) => monitor.enabled));
    },

    saveSyncState(id, state) {
      const monitor = monitors.find((candidate) => candidate.id === id);
      if (monitor) {
        Object.assign(monitor, state);
      }
      return Promise.resolve();
    },

    appendSnapshot(input) {
      counter += 1;
      const row = { ...input, id: `snapshot-${counter}` };
      snapshots.push(row);
      return Promise.resolve(toSnapshotRecord(row));
    },

    latestSnapshot(repositoryId) {
      const rows = snapshots.filter((row) => row.repositoryId === repositoryId);
      const last = rows.at(-1);
      return Promise.resolve(last === undefined ? null : toSnapshotRecord(last));
    },

    recentSnapshots(repositoryId, limit) {
      const rows = snapshots.filter((row) => row.repositoryId === repositoryId).slice(-limit);
      return Promise.resolve(rows.map(toSnapshotRecord));
    },

    upsertCommits(repositoryId, incoming: readonly RepositoryCommit[]) {
      const fresh: string[] = [];
      for (const commit of incoming) {
        const known = commits.some(
          (row) => row.repositoryId === repositoryId && row.sha === commit.sha,
        );
        if (!known) {
          commits.push({ repositoryId, sha: commit.sha });
          fresh.push(commit.sha);
        }
      }
      return Promise.resolve(fresh);
    },

    upsertPullRequests(repositoryId, incoming: readonly RepositoryPullRequest[]) {
      const created: number[] = [];
      const merged: number[] = [];
      for (const pull of incoming) {
        const existing = pulls.find(
          (row) => row.repositoryId === repositoryId && row.number === pull.number,
        );
        if (existing === undefined) {
          pulls.push({ ...pull, repositoryId });
          // A pull request first seen closed arrived through the recently-closed
          // window: it was not "opened" while the bot was watching.
          if (pull.state === "open") {
            created.push(pull.number);
          }
          if (pull.merged) {
            merged.push(pull.number);
          }
          continue;
        }
        if (pull.merged && !existing.merged) {
          merged.push(pull.number);
        }
        Object.assign(existing, pull);
      }
      return Promise.resolve({ created, merged });
    },

    recentPullRequests(repositoryId, limit) {
      const rows = pulls
        .filter((row) => row.repositoryId === repositoryId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, limit)
        .map(toPull);
      return Promise.resolve(rows);
    },

    claimEvents(repositoryId, incoming: readonly PendingEvent[]) {
      const claimed: PendingEvent[] = [];
      for (const event of incoming) {
        const key = `${repositoryId}:${event.key}`;
        if (events.some((row) => `${repositoryId}:${row.key}` === key)) {
          continue;
        }
        events.push(event);
        claimed.push(event);
      }
      return Promise.resolve(claimed);
    },

    pruneSnapshots(repositoryId, before) {
      const kept = snapshots.filter(
        (row) => row.repositoryId !== repositoryId || row.capturedAt >= before,
      );
      const removed = snapshots.length - kept.length;
      snapshots.splice(0, snapshots.length, ...kept);
      return Promise.resolve(removed);
    },
  };
}
