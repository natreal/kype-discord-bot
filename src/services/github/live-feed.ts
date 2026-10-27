/**
 * The live half of the GitHub picture: what the REST API knows *right now*.
 *
 * The monitor's snapshots answer "where was the project at the last capture"; this
 * answers "what does GitHub say this second" — the counters, the newest release, the
 * last CI run, the language mix and how much rate-limit quota is left. It exists
 * because a token turns those questions from expensive into cheap: four calls every
 * couple of minutes against 5,000 an hour, instead of the anonymous sixty an hour the
 * refresh job already spends five of.
 *
 * Three rules make it safe to call from a slash command:
 *
 * - **A failure is a value.** `latest()` answers `null` and the panel renders without
 *   the section; a GitHub outage never breaks `/github`.
 * - **It is cached and coalesced.** One fetch per TTL, shared by concurrent callers,
 *   so five people pressing "Libraries" in the same minute cost one round of calls.
 *   A failure is cached for shorter than a success, so a transient error recovers
 *   quickly without hammering a rate limit.
 * - **It never blocks a reply for long.** The whole fetch races a deadline; past it
 *   the panel is answered from the snapshot alone.
 */
import type { GitHubClient, GitHubResult } from "./client.js";

/** One published release, as GitHub describes it. */
export interface GitHubLiveRelease {
  readonly tag: string;
  readonly name: string;
  readonly publishedAt: Date | null;
  readonly url: string;
}

/** The newest workflow run on the monitored branch. */
export interface GitHubLiveWorkflow {
  readonly name: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly updatedAt: Date | null;
  readonly url: string;
}

/** One language of the repository's byte mix. */
export interface GitHubLiveLanguage {
  readonly name: string;
  /** Share of the repository's bytes, 0–100, one decimal. */
  readonly percent: number;
}

/** Everything one live fetch produced. */
export interface GitHubLiveFacts {
  readonly fullName: string;
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly stars: number;
  readonly forks: number;
  /** GitHub's `subscribers_count` is watchers; `watchers_count` is stars. */
  readonly watchers: number;
  readonly openIssues: number;
  readonly pushedAt: Date | null;
  readonly archived: boolean;
  readonly release: GitHubLiveRelease | null;
  readonly workflow: GitHubLiveWorkflow | null;
  readonly languages: readonly GitHubLiveLanguage[];
  /** `x-ratelimit-remaining` after the last call, when GitHub reported it. */
  readonly rateLimitRemaining: number | null;
  /** When the hourly window resets, when GitHub reported it. */
  readonly rateLimitResetAt: Date | null;
  /** Whether the calls were authenticated (5,000/h) or anonymous (60/h). */
  readonly authenticated: boolean;
  readonly fetchedAt: Date;
}

/** What the feed needs: the client, and which repository to ask about. */
export interface GitHubLiveFeedOptions {
  readonly client: GitHubClient;
  readonly target: {
    readonly owner: string;
    readonly repo: string;
    /** Defaults to the repository's own default branch. */
    readonly branch?: string | undefined;
  };
  /** Overridable for tests; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** How long a successful fetch is reused. Defaults to two minutes. */
  readonly ttlMs?: number;
  /** How long a failed fetch is remembered. Defaults to thirty seconds. */
  readonly failureTtlMs?: number;
  /** Deadline for one whole fetch. Defaults to six seconds. */
  readonly deadlineMs?: number;
}

/** Languages listed on a panel: the top of the byte mix, not all eighty of them. */
const LANGUAGE_LIMIT = 3;

export class GitHubLiveFeed {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string | undefined;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly deadlineMs: number;

  /** The last answer and the instant it stops being reused. */
  private cached: { readonly expiresAt: number; readonly value: GitHubLiveFacts | null } | null =
    null;
  /** The fetch in progress, so concurrent readers share one round of calls. */
  private inFlight: Promise<GitHubLiveFacts | null> | null = null;

  public constructor(options: GitHubLiveFeedOptions) {
    this.client = options.client;
    this.owner = options.target.owner;
    this.repo = options.target.repo;
    this.branch = options.target.branch;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 120_000;
    this.failureTtlMs = options.failureTtlMs ?? 30_000;
    this.deadlineMs = options.deadlineMs ?? 6_000;
  }

  /** Whether the underlying client carries a token. */
  public get isAuthenticated(): boolean {
    return this.client.isAuthenticated;
  }

  /**
   * @returns the current facts, or `null` when GitHub could not be read (or the
   * deadline passed). Never throws: a panel is not worth a failed reply.
   */
  public async latest(): Promise<GitHubLiveFacts | null> {
    const now = this.now().getTime();
    if (this.cached !== null && now < this.cached.expiresAt) {
      return this.cached.value;
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const pending = this.read(now);
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      this.inFlight = null;
    }
  }

  /** Performs one fetch, caches it, and never rejects. */
  private async read(now: number): Promise<GitHubLiveFacts | null> {
    let value: GitHubLiveFacts | null;
    try {
      value = await withDeadline(this.collect(now), this.deadlineMs);
    } catch {
      // A client failure is already a value; this catches the impossible case (a bug in
      // the parser) rather than letting it surface as a broken `/github` reply.
      value = null;
    }
    this.cached = {
      expiresAt: now + (value === null ? this.failureTtlMs : this.ttlMs),
      value,
    };
    return value;
  }

  /** Reads the four endpoints this feed needs. */
  private async collect(now: number): Promise<GitHubLiveFacts | null> {
    const repository = await this.client.request({ path: this.repositoryPath() });
    const facts = repository.ok ? asRecord(repository.response.body) : null;
    if (facts === null) {
      return null;
    }
    const defaultBranch = asString(facts["default_branch"]) ?? "main";
    const branch = this.branch ?? defaultBranch;

    // Independent of each other, and of the first call: three round trips at most, and
    // only one of them depends on the repository payload.
    const [release, workflow, languages] = await Promise.all([
      this.client.request({ path: `${this.repositoryPath()}/releases/latest` }),
      this.client.request({
        path: `${this.repositoryPath()}/actions/runs`,
        query: { branch, per_page: 1 },
      }),
      this.client.request({ path: `${this.repositoryPath()}/languages` }),
    ]);

    const rate = rateLimitOf(repository, release, workflow, languages);

    return {
      fullName: asString(facts["full_name"]) ?? `${this.owner}/${this.repo}`,
      description: asString(facts["description"]),
      defaultBranch,
      stars: asCount(facts["stargazers_count"]),
      forks: asCount(facts["forks_count"]),
      watchers: asCount(facts["subscribers_count"]),
      openIssues: asCount(facts["open_issues_count"]),
      pushedAt: asDate(facts["pushed_at"]),
      archived: facts["archived"] === true,
      release: parseRelease(release),
      workflow: parseWorkflow(workflow, branch),
      languages: parseLanguages(languages),
      rateLimitRemaining: rate.remaining,
      rateLimitResetAt: rate.resetAt,
      authenticated: this.client.isAuthenticated,
      fetchedAt: new Date(now),
    };
  }

  /** `/repos/{owner}/{repo}`, the path every other call hangs off. */
  private repositoryPath(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }
}

/** @returns `promise`'s value, or `null` when the deadline passes first. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
    // A panel must never keep the process alive just to give up on its own deadline.
    timer.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** @returns the newest release, or `null` for a repository that has never published one. */
function parseRelease(result: GitHubResult): GitHubLiveRelease | null {
  // A 404 is the documented answer for "no releases", not a failure worth reporting.
  if (!result.ok || result.response.notModified) {
    return null;
  }
  const body = asRecord(result.response.body);
  if (body === null) {
    return null;
  }
  const tag = asString(body["tag_name"]) ?? asString(body["name"]);
  if (tag === null) {
    return null;
  }
  return {
    tag,
    name: asString(body["name"]) ?? tag,
    publishedAt: asDate(body["published_at"]) ?? asDate(body["created_at"]),
    url: asString(body["html_url"]) ?? "",
  };
}

/** @returns the newest run on `branch`, or `null` when the repository runs no CI. */
function parseWorkflow(result: GitHubResult, branch: string): GitHubLiveWorkflow | null {
  if (!result.ok || result.response.notModified) {
    return null;
  }
  const body = asRecord(result.response.body);
  const runs = body === null ? null : body["workflow_runs"];
  if (!Array.isArray(runs)) {
    return null;
  }
  const run = asRecord((runs as unknown[])[0]);
  if (run === null) {
    return null;
  }
  return {
    name: asString(run["name"]) ?? "workflow",
    branch,
    status: asString(run["status"]) ?? "unknown",
    conclusion: asString(run["conclusion"]),
    updatedAt: asDate(run["updated_at"]) ?? asDate(run["created_at"]),
    url: asString(run["html_url"]) ?? "",
  };
}

/** @returns the largest languages by byte share, largest first. */
function parseLanguages(result: GitHubResult): GitHubLiveLanguage[] {
  if (!result.ok || result.response.notModified) {
    return [];
  }
  const body = asRecord(result.response.body);
  if (body === null) {
    return [];
  }
  const entries = Object.entries(body)
    .map(([name, bytes]) => ({ name, bytes: typeof bytes === "number" ? bytes : 0 }))
    .filter((entry) => entry.bytes > 0)
    .sort((left, right) => right.bytes - left.bytes);
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total === 0) {
    return [];
  }
  return entries.slice(0, LANGUAGE_LIMIT).map((entry) => ({
    name: entry.name,
    percent: Math.round((entry.bytes / total) * 1_000) / 10,
  }));
}

/**
 * @returns the lowest remaining quota any of the four calls reported.
 *
 * The lowest, not the first: the calls run in parallel, so the order they resolve in is
 * not the order they were sent, and a panel that shows more quota than is left is
 * worse than one that shows less.
 */
function rateLimitOf(...results: readonly GitHubResult[]): {
  readonly remaining: number | null;
  readonly resetAt: Date | null;
} {
  let remaining: number | null = null;
  let resetAt: Date | null = null;
  for (const result of results) {
    if (!result.ok) {
      continue;
    }
    const { rateLimitRemaining, rateLimitResetAt } = result.response;
    if (rateLimitRemaining !== null && (remaining === null || rateLimitRemaining < remaining)) {
      remaining = rateLimitRemaining;
    }
    if (rateLimitResetAt !== null) {
      resetAt = new Date(rateLimitResetAt * 1_000);
    }
  }
  return { remaining, resetAt };
}

/** @returns `value` as a JSON object, or `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** @returns `value` when it is a non-empty string, else `null`. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @returns `value` as a count, or `0` when it is not a finite number. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** @returns `value` as a `Date`, or `null` when GitHub did not send a usable one. */
function asDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
