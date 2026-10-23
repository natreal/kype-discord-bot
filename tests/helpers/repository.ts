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
  readonly pulls: { repositoryId: string; number: number; merged: boolean }[];
  readonly events: PendingEvent[];
}

/** Builds an isolated store. One per test. */
export function memoryMonitorRepository(): MemoryMonitorRepository {
  const monitors: MonitorRecord[] = [];
  const snapshots: (SnapshotInput & { readonly id: string })[] = [];
  const commits: { repositoryId: string; sha: string }[] = [];
  const pulls: { repositoryId: string; number: number; merged: boolean }[] = [];
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
          pulls.push({ repositoryId, number: pull.number, merged: pull.merged });
          created.push(pull.number);
          continue;
        }
        if (pull.merged && !existing.merged) {
          merged.push(pull.number);
        }
        existing.merged = pull.merged;
      }
      return Promise.resolve({ created, merged });
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
