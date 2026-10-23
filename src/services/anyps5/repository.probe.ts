/**
 * Reads the AnyPS5 repository: facts, published progress, commits, pull requests.
 *
 * This is the only place that knows which GitHub endpoints and which URLs make up
 * "the AnyPS5 project". Everything above it (storage, reporting, Discord events)
 * works with `RepositoryReading`, so changing a data source is a change here and
 * nowhere else.
 *
 * Each section degrades on its own. A rate-limited commits call must not cost the
 * implementation statistics, and a repository that publishes no `progress.json`
 * must still yield commits: losing a whole snapshot to one failing endpoint would
 * make the hourly history patchy for no reason.
 */
import type { GitHubClient } from "../github/client.js";
import { toError } from "../../utils/errors.js";
import { parseProgressSnapshot, type AnyPs5Progress } from "./progress.js";
import type {
  RepositoryCommit,
  RepositoryFacts,
  RepositoryPullRequest,
  RepositoryReading,
} from "./repository.types.js";

/** Where the project publishes the statistics its own CI generates. */
export const PROGRESS_URL = "https://boykopovar.github.io/AnyPS5/progress.json";
/** The published snapshot is a small JSON document; anything huge is not it. */
const MAX_PROGRESS_BYTES = 2_000_000;
/** How many commits one reading keeps. */
export const COMMIT_WINDOW = 50;
/** How many pull requests one reading keeps, newest first. */
export const PULL_REQUEST_WINDOW = 30;

/** Repository coordinates, from configuration rather than hard-coded. */
export interface RepositoryTarget {
  readonly owner: string;
  readonly repo: string;
  /** Branch the statistics describe. `undefined` means the repository default. */
  readonly branch: string | undefined;
}

/** What a reading is compared against, for conditional requests. */
export interface RepositoryCache {
  /** `ETag` of the last successful commits response. */
  readonly commitsEtag: string | null;
  /** `ETag` of the last successful pull-request response. */
  readonly pullRequestsEtag: string | null;
}

/** The reading plus the fresh `ETag`s the next call should send. */
export interface RepositoryProbeResult {
  readonly reading: RepositoryReading;
  readonly cache: RepositoryCache;
  /** Endpoints that failed, for the caller's log line. */
  readonly failures: readonly string[];
}

export interface RepositoryProbeOptions {
  readonly client: GitHubClient;
  readonly target: RepositoryTarget;
  /** Overridable so tests do not touch the network. */
  readonly progressUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export const EMPTY_CACHE: RepositoryCache = { commitsEtag: null, pullRequestsEtag: null };

export class RepositoryProbe {
  private readonly client: GitHubClient;
  private readonly target: RepositoryTarget;
  private readonly progressUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: RepositoryProbeOptions) {
    this.client = options.client;
    this.target = options.target;
    this.progressUrl = options.progressUrl ?? PROGRESS_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** The `owner/repo` string used in URLs and rendered by the bot. */
  public get fullName(): string {
    return `${this.target.owner}/${this.target.repo}`;
  }

  /**
   * Collects one reading.
   *
   * @param cache `ETag`s from the previous reading, so an unchanged repository
   * costs no rate-limit quota on the list endpoints.
   */
  public async read(cache: RepositoryCache = EMPTY_CACHE): Promise<RepositoryProbeResult> {
    const facts = await this.readFacts();
    const branch = this.target.branch ?? facts?.defaultBranch ?? "main";

    // Sequential where it costs nothing and parallel where it saves a round trip:
    // the branch is only known after the repository call, and the other three are
    // independent of each other.
    const [progress, commits, pullRequests] = await Promise.all([
      this.readProgress(),
      this.readCommits(branch, cache.commitsEtag),
      this.readPullRequests(cache.pullRequestsEtag),
    ]);

    const failures = [
      ...(facts === null ? ["repository"] : []),
      ...(progress.progress === null ? ["progress"] : []),
      ...(commits.entries === null ? ["commits"] : []),
      ...(pullRequests.entries === null ? ["pull-requests"] : []),
    ];

    return {
      reading: {
        facts: facts ?? fallbackFacts(this.fullName),
        progress: progress.progress,
        progressUnavailable: progress.reason,
        progressCommit: progress.commit,
        commits: commits.entries ?? [],
        pullRequests: pullRequests.entries ?? [],
        fetchedAt: new Date(),
      },
      cache: {
        commitsEtag: commits.etag ?? cache.commitsEtag,
        pullRequestsEtag: pullRequests.etag ?? cache.pullRequestsEtag,
      },
      failures,
    };
  }

  /** Fetches the repository facts. `null` when the call failed. */
  private async readFacts(): Promise<RepositoryFacts | null> {
    const result = await this.client.request({ path: repositoryPath(this.target) });
    const body = result.ok ? asRecord(result.response.body) : null;
    if (body === null) {
      return null;
    }
    return {
      fullName: typeof body["full_name"] === "string" ? body["full_name"] : this.fullName,
      description: typeof body["description"] === "string" ? body["description"] : null,
      defaultBranch: typeof body["default_branch"] === "string" ? body["default_branch"] : "main",
      stars: asCount(body["stargazers_count"]),
      forks: asCount(body["forks_count"]),
      openIssues: asCount(body["open_issues_count"]),
      pushedAt: asDate(body["pushed_at"]),
    };
  }

  /**
   * Fetches the published implementation statistics.
   *
   * Deliberately *not* routed through the GitHub client: the file lives on the
   * project's Pages host, which is a different origin, a different rate-limit
   * regime (none) and a different failure mode (a deploy in progress answers
   * `404` briefly). It is read with a conditional request for the same reason the
   * commits are: unchanged statistics should cost nothing.
   */
  private async readProgress(): Promise<{
    readonly progress: AnyPs5Progress | null;
    readonly reason: string | null;
    readonly commit: string | null;
  }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.progressUrl, {
        headers: { Accept: "application/json", "User-Agent": "kype-discord-bot" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return {
        progress: null,
        reason: `progress.json unreachable: ${toError(error).message}`,
        commit: null,
      };
    }

    if (!response.ok) {
      return { progress: null, reason: `progress.json answered HTTP ${response.status}`, commit: null };
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_PROGRESS_BYTES) {
      return { progress: null, reason: "progress.json is larger than expected", commit: null };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return { progress: null, reason: "progress.json is not valid JSON", commit: null };
    }

    try {
      return {
        progress: parseProgressSnapshot(raw),
        reason: null,
        // The Pages deployment is pinned to a commit, which is what makes the
        // per-function scan comparable with the published totals.
        commit: response.headers.get("x-anyps5-progress-commit"),
      };
    } catch (error) {
      return { progress: null, reason: toError(error).message, commit: null };
    }
  }

  /** Fetches recent commits of `branch`, newest first. */
  private async readCommits(
    branch: string,
    etag: string | null,
  ): Promise<{ readonly entries: readonly RepositoryCommit[] | null; readonly etag: string | null }> {
    const result = await this.client.request({
      path: `${repositoryPath(this.target)}/commits`,
      query: { sha: branch, per_page: COMMIT_WINDOW },
      etag: etag ?? undefined,
    });
    if (!result.ok) {
      return { entries: null, etag: null };
    }
    if (result.response.notModified) {
      // Unchanged: the caller keeps the previous reading's commits.
      return { entries: null, etag };
    }
    const body = result.response.body;
    if (!Array.isArray(body)) {
      return { entries: null, etag: result.response.etag };
    }
    return {
      entries: body.flatMap(toCommit),
      etag: result.response.etag,
    };
  }

  /** Fetches recent pull requests, newest first, open and closed. */
  private async readPullRequests(
    etag: string | null,
  ): Promise<{
    readonly entries: readonly RepositoryPullRequest[] | null;
    readonly etag: string | null;
  }> {
    const result = await this.client.request({
      path: `${repositoryPath(this.target)}/pulls`,
      query: { state: "all", sort: "created", direction: "desc", per_page: PULL_REQUEST_WINDOW },
      etag: etag ?? undefined,
    });
    if (!result.ok) {
      return { entries: null, etag: null };
    }
    if (result.response.notModified) {
      return { entries: null, etag };
    }
    const body = result.response.body;
    if (!Array.isArray(body)) {
      return { entries: null, etag: result.response.etag };
    }
    return { entries: body.flatMap(toPullRequest), etag: result.response.etag };
  }
}

/** The `repos/{owner}/{repo}` path, shared by every endpoint below. */
function repositoryPath(target: RepositoryTarget): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

/** A count that GitHub may omit; a missing count is zero, never NaN. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** An ISO timestamp from GitHub, or `null` when absent or unparseable. */
function asDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Facts used when the repository call itself failed. */
function fallbackFacts(fullName: string): RepositoryFacts {
  return {
    fullName,
    description: null,
    defaultBranch: "main",
    stars: 0,
    forks: 0,
    openIssues: 0,
    pushedAt: null,
  };
}

/** @returns the value as a plain object, or `null` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalizes one commit payload.
 *
 * @returns a one-element array, or an empty one when the payload is unusable — so
 * a single malformed row is skipped rather than failing the whole list.
 */
function toCommit(value: unknown): RepositoryCommit[] {
  const row = asRecord(value);
  const commit = asRecord(row?.["commit"]);
  const sha = row?.["sha"];
  if (row === null || commit === null || typeof sha !== "string") {
    return [];
  }
  const message = typeof commit["message"] === "string" ? commit["message"] : "";
  const author = asRecord(commit["author"]);
  return [
    {
      sha,
      message: message.split("\n")[0] ?? "",
      author: typeof author?.["name"] === "string" ? author["name"] : null,
      committedAt:
        asDate(author?.["date"]) ??
        asDate(asRecord(commit["committer"])?.["date"]) ??
        new Date(0),
      url: typeof row["html_url"] === "string" ? row["html_url"] : "",
    },
  ];
}

/** Normalizes one pull-request payload; `[]` when unusable. */
function toPullRequest(value: unknown): RepositoryPullRequest[] {
  const row = asRecord(value);
  const number = row?.["number"];
  if (row === null || typeof number !== "number") {
    return [];
  }
  const mergedAt = asDate(row["merged_at"]);
  const createdAt = asDate(row["created_at"]) ?? new Date(0);
  const login = asRecord(row["user"])?.["login"];
  return [
    {
      number,
      title: typeof row["title"] === "string" ? row["title"] : `#${number}`,
      author: typeof login === "string" ? login : null,
      state: row["state"] === "open" ? "open" : "closed",
      draft: row["draft"] === true,
      merged: mergedAt !== null,
      createdAt,
      mergedAt,
      url: typeof row["html_url"] === "string" ? row["html_url"] : "",
    },
  ];
}




