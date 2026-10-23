/**
 * Prisma implementation of the monitor's storage port.
 *
 * Two guarantees live here rather than in the service, because they are database
 * properties: a commit is stored once per repository (`@@unique([repositoryId,
 * sha])`), and an announced event is recorded once (`@@unique([repositoryId,
 * key])`). Both are expressed as `createMany({ skipDuplicates })` / a unique-index
 * insert, so they hold even if two processes refresh the same repository at once.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError, toJson, toNullableJson } from "../../services/database/index.js";
import type {
  RepositoryCommit,
  RepositoryPullRequest,
} from "../../services/anyps5/repository.types.js";
import type {
  MonitorRecord,
  PendingEvent,
  RepositoryMonitorRepository,
  SnapshotInput,
  SnapshotRecord,
} from "./repository.types.js";

export class PrismaRepositoryMonitorRepository implements RepositoryMonitorRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async ensure(input: {
    readonly owner: string;
    readonly name: string;
    readonly branch: string | null;
    readonly displayName: string | null;
    readonly repositoryId: number | null;
  }): Promise<MonitorRecord> {
    try {
      const row = await this.prisma.monitoredRepository.upsert({
        where: { owner_name: { owner: input.owner, name: input.name } },
        // Only the descriptive fields are refreshed: the ETags and the cursor are
        // sync state, and overwriting them here would discard a conditional-request
        // token every time the watch is resolved.
        update: {
          ...(input.branch === null ? {} : { branch: input.branch }),
          ...(input.displayName === null ? {} : { displayName: input.displayName }),
          ...(input.repositoryId === null ? {} : { repositoryId: input.repositoryId }),
        },
        create: {
          owner: input.owner,
          name: input.name,
          branch: input.branch,
          displayName: input.displayName,
          repositoryId: input.repositoryId,
        },
      });
      return toMonitor(row);
    } catch (error) {
      throw toDatabaseError(error, "repository.ensure");
    }
  }

  public async listEnabled(): Promise<MonitorRecord[]> {
    try {
      const rows = await this.prisma.monitoredRepository.findMany({
        where: { enabled: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toMonitor);
    } catch (error) {
      throw toDatabaseError(error, "repository.listEnabled");
    }
  }

  public async saveSyncState(
    id: string,
    state: {
      readonly commitsEtag: string | null;
      readonly pullRequestsEtag: string | null;
      readonly cursorCommit: string | null;
      readonly repositoryId: number | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.monitoredRepository.update({
        where: { id },
        data: {
          commitsEtag: state.commitsEtag,
          pullRequestsEtag: state.pullRequestsEtag,
          ...(state.cursorCommit === null ? {} : { cursorCommit: state.cursorCommit }),
          ...(state.repositoryId === null ? {} : { repositoryId: state.repositoryId }),
        },
      });
    } catch (error) {
      throw toDatabaseError(error, "repository.saveSyncState");
    }
  }

  public async appendSnapshot(input: SnapshotInput): Promise<SnapshotRecord> {
    try {
      const row = await this.prisma.repositorySnapshot.create({
        data: {
          repositoryId: input.repositoryId,
          capturedAt: input.capturedAt,
          librariesDone: input.state.librariesDone,
          librariesTotal: input.state.librariesTotal,
          librariesPercent: input.state.libraryPercent,
          shadersDone: input.state.shadersDone,
          shadersTotal: input.state.shadersTotal,
          shadersPercent: input.state.shaderPercent,
          progressCommit: input.progressCommit,
          stars: input.state.stars,
          forks: input.state.forks,
          openIssues: input.state.openIssues,
          commitCount: input.commitCount,
          pullCount: input.pullCount,
          progress: toNullableJson(input.progress),
          failures: toJson([...input.failures]),
        },
      });
      return toSnapshot(row);
    } catch (error) {
      throw toDatabaseError(error, "repository.appendSnapshot");
    }
  }

  public async latestSnapshot(repositoryId: string): Promise<SnapshotRecord | null> {
    try {
      const row = await this.prisma.repositorySnapshot.findFirst({
        where: { repositoryId },
        orderBy: { capturedAt: "desc" },
      });
      return row === null ? null : toSnapshot(row);
    } catch (error) {
      throw toDatabaseError(error, "repository.latestSnapshot");
    }
  }

  public async recentSnapshots(repositoryId: string, limit: number): Promise<SnapshotRecord[]> {
    try {
      const rows = await this.prisma.repositorySnapshot.findMany({
        where: { repositoryId },
        orderBy: { capturedAt: "desc" },
        take: limit,
      });
      return rows.reverse().map(toSnapshot);
    } catch (error) {
      throw toDatabaseError(error, "repository.recentSnapshots");
    }
  }

  public async upsertCommits(
    repositoryId: string,
    commits: readonly RepositoryCommit[],
  ): Promise<string[]> {
    if (commits.length === 0) {
      return [];
    }
    try {
      // Read-then-insert rather than "insert and swallow conflicts": the caller needs
      // to know *which* commits are new, and `createMany` reports only a count.
      const existing = await this.prisma.repositoryCommitRecord.findMany({
        where: { repositoryId, sha: { in: commits.map((commit) => commit.sha) } },
        select: { sha: true },
      });
      const known = new Set(existing.map((row) => row.sha));
      const fresh = commits.filter((commit) => !known.has(commit.sha));
      if (fresh.length === 0) {
        return [];
      }

      await this.prisma.repositoryCommitRecord.createMany({
        // A concurrent refresh may insert one in between; skipping is correct
        // because the row it would insert is identical.
        skipDuplicates: true,
        data: fresh.map((commit) => ({
          repositoryId,
          sha: commit.sha,
          message: commit.message,
          author: commit.author,
          committedAt: commit.committedAt,
          url: commit.url,
        })),
      });
      return fresh.map((commit) => commit.sha);
    } catch (error) {
      throw toDatabaseError(error, "repository.upsertCommits");
    }
  }

  public async upsertPullRequests(
    repositoryId: string,
    pulls: readonly RepositoryPullRequest[],
  ): Promise<{ readonly created: readonly number[]; readonly merged: readonly number[] }> {
    if (pulls.length === 0) {
      return { created: [], merged: [] };
    }
    try {
      const existing = await this.prisma.repositoryPullRequestRecord.findMany({
        where: { repositoryId, number: { in: pulls.map((pull) => pull.number) } },
        select: { number: true, merged: true },
      });
      const known = new Map(existing.map((row) => [row.number, row.merged]));

      for (const pull of pulls) {
        const data = {
          title: pull.title,
          author: pull.author,
          state: pull.state,
          draft: pull.draft,
          merged: pull.merged,
          createdAt: pull.createdAt,
          mergedAt: pull.mergedAt,
          url: pull.url,
        };
        await this.prisma.repositoryPullRequestRecord.upsert({
          where: { repositoryId_number: { repositoryId, number: pull.number } },
          update: data,
          create: { repositoryId, number: pull.number, ...data },
        });
      }

      return {
        // A pull request first seen already closed was not "opened" as far as the
        // channel is concerned: reporting it would announce a decision as if it
        // were still pending. These rows reach the store through the closed window.
        created: pulls
          .filter((pull) => !known.has(pull.number) && pull.state === "open")
          .map((pull) => pull.number),
        // "Merged" is a transition, not a state: a pull request merged before this
        // watch existed must not be announced on the first refresh. A row the table
        // has never seen counts as a transition, because that is how a merge arrives
        // here — through the closed window, long after the created window moved on.
        merged: pulls
          .filter((pull) => pull.merged && known.get(pull.number) !== true)
          .map((pull) => pull.number),
      };
    } catch (error) {
      throw toDatabaseError(error, "repository.upsertPullRequests");
    }
  }

  public async recentPullRequests(
    repositoryId: string,
    limit: number,
  ): Promise<readonly RepositoryPullRequest[]> {
    try {
      const rows = await this.prisma.repositoryPullRequestRecord.findMany({
        where: { repositoryId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map(toPullRequestRecord);
    } catch (error) {
      throw toDatabaseError(error, "repository.recentPullRequests");
    }
  }

  public async claimEvents(
    repositoryId: string,
    events: readonly PendingEvent[],
  ): Promise<PendingEvent[]> {
    const claimed: PendingEvent[] = [];
    for (const event of events) {
      try {
        // One row at a time behind the `(repositoryId, key)` unique index: the
        // database decides who wins, and a concurrent run gets a conflict instead of
        // posting the same line twice.
        await this.prisma.repositoryEventRecord.create({
          data: { repositoryId, kind: event.kind, key: event.key },
        });
        claimed.push(event);
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw toDatabaseError(error, "repository.claimEvents");
        }
      }
    }
    return claimed;
  }

  public async pruneSnapshots(repositoryId: string, before: Date): Promise<number> {
    try {
      const result = await this.prisma.repositorySnapshot.deleteMany({
        where: { repositoryId, capturedAt: { lt: before } },
      });
      return result.count;
    } catch (error) {
      throw toDatabaseError(error, "repository.pruneSnapshots");
    }
  }
}

/** @returns true for Prisma's unique-constraint violation (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Normalizes a stored watch row. */
function toMonitor(row: {
  id: string;
  owner: string;
  name: string;
  branch: string | null;
  displayName: string | null;
  repositoryId: number | null;
  enabled: boolean;
  commitsEtag: string | null;
  pullRequestsEtag: string | null;
  cursorCommit: string | null;
}): MonitorRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    branch: row.branch,
    displayName: row.displayName,
    repositoryId: row.repositoryId,
    enabled: row.enabled,
    commitsEtag: row.commitsEtag,
    pullRequestsEtag: row.pullRequestsEtag,
    cursorCommit: row.cursorCommit,
  };
}

/** Normalizes a stored pull-request row back into the reading's shape. */
function toPullRequestRecord(row: {
  number: number;
  title: string;
  author: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  createdAt: Date;
  mergedAt: Date | null;
  url: string;
}): RepositoryPullRequest {
  return {
    number: row.number,
    title: row.title,
    author: row.author,
    // The column holds GitHub's own wording; anything but `open` was closed.
    state: row.state === "open" ? "open" : "closed",
    draft: row.draft,
    merged: row.merged,
    createdAt: row.createdAt,
    mergedAt: row.mergedAt,
    url: row.url,
  };
}

/**
 * Normalizes a snapshot row.
 *
 * The nullable counters are preserved as `null`, not coerced to zero: a snapshot
 * taken while `progress.json` was unreachable has *no* percentage, and rendering
 * that as 0% would be a false statement about the project.
 */
function toSnapshot(row: {
  id: string;
  capturedAt: Date;
  librariesDone: number | null;
  librariesTotal: number | null;
  librariesPercent: number | null;
  shadersDone: number | null;
  shadersTotal: number | null;
  shadersPercent: number | null;
  progressCommit: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  commitCount: number;
  pullCount: number;
  failures: unknown;
}): SnapshotRecord {
  return {
    id: row.id,
    capturedAt: row.capturedAt,
    state: {
      stars: row.stars,
      forks: row.forks,
      openIssues: row.openIssues,
      libraryPercent: row.librariesPercent,
      librariesDone: row.librariesDone,
      librariesTotal: row.librariesTotal,
      shaderPercent: row.shadersPercent,
      shadersDone: row.shadersDone,
      shadersTotal: row.shadersTotal,
    },
    progressCommit: row.progressCommit,
    commitCount: row.commitCount,
    pullCount: row.pullCount,
    failures: Array.isArray(row.failures)
      ? row.failures.filter((item): item is string => typeof item === "string")
      : [],
  };
}
