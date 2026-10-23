/**
 * GitHub REST client.
 *
 * A `fetch` client on purpose, mirroring `openai-compatible.client.ts`: the bot
 * needs a handful of endpoints, not an SDK, and a dependency would pin it to one
 * error model and one network stack for those calls.
 *
 * The contract is "every failure is a value, never an exception on the hot path":
 *
 * - **Rate limits are read, not guessed.** GitHub answers `403`/`429` with
 *   `x-ratelimit-remaining: 0` and `x-ratelimit-reset`; the client waits until
 *   that instant (bounded) and retries once, instead of failing the refresh. A
 *   wait that is too long fails with `retryAt` set, so the scheduled job can say
 *   *when* it will try again instead of counting a retry against its attempts.
 * - **A conditional request costs nothing.** `If-None-Match` is sent when the
 *   caller has an `ETag`, so an unchanged repository consumes no rate-limit quota:
 *   that is what makes an hourly poll reasonable on an anonymous token.
 * - **The token is never logged** and never appears in a failure detail.
 */
import { toError } from "../../utils/errors.js";

/** One request, as a caller describes it. */
export interface GitHubRequest {
  /** Path beginning with a slash, e.g. `/repos/o/r/commits`. */
  readonly path: string;
  /** Query parameters; `undefined` values are dropped. */
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** `ETag` from a previous response, for a conditional request. */
  readonly etag?: string | undefined;
}

/** A successful (or not-modified) response. */
export interface GitHubResponse {
  /** HTTP status; `304` for a conditional call that found nothing new. */
  readonly status: number;
  readonly notModified: boolean;
  /** `ETag` to send back as `If-None-Match` next time. */
  readonly etag: string | null;
  /** Parsed JSON body; `undefined` for `304` and for an empty body. */
  readonly body: unknown;
  /** `x-ratelimit-remaining`, when GitHub reported it. */
  readonly rateLimitRemaining: number | null;
  /** `x-ratelimit-reset` as an epoch second, when GitHub reported it. */
  readonly rateLimitResetAt: number | null;
}

/** Why a call failed. Every value is safe to log. */
export type GitHubFailureReason =
  | "not-found"
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "http"
  | "network"
  | "timeout"
  | "invalid-json";

/** A failed call. Never thrown for an API-level failure. */
export interface GitHubFailure {
  readonly ok: false;
  readonly reason: GitHubFailureReason;
  /** Short, token-free description for logs and snapshot failure text. */
  readonly detail: string;
  readonly status: number | null;
  /** When a rate limit resets, or `null`. */
  readonly retryAt: Date | null;
  /** Whether retrying later can plausibly succeed. */
  readonly retryable: boolean;
}

/** A successful call. */
export interface GitHubSuccess {
  readonly ok: true;
  readonly response: GitHubResponse;
}

export type GitHubResult = GitHubSuccess | GitHubFailure;

/** Collaborators, injected so the client is testable without a network. */
export interface GitHubClientOptions {
  /** `undefined` means anonymous: 60 requests/hour instead of 5,000. */
  readonly token?: string | undefined;
  /** `https://api.github.com`; overridable for GitHub Enterprise and tests. */
  readonly baseUrl?: string;
  /** Sent as `User-Agent`, which GitHub requires. */
  readonly userAgent?: string;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** How long a rate-limit wait may be before the call fails instead. */
  readonly maxRateLimitWaitMs?: number;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected for tests; defaults to an unref'd `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const NOT_MODIFIED = 304;


export class GitHubClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  public constructor(options: GitHubClientOptions = {}) {
    this.token = options.token === undefined || options.token === "" ? undefined : options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = options.userAgent ?? "kype-discord-bot";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 60_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  }

  /** Whether requests are authenticated (and therefore rate-limited to 5,000/h). */
  public get isAuthenticated(): boolean {
    return this.token !== undefined;
  }

  /**
   * Performs one request, waiting once for a short rate limit if needed.
   *
   * @returns the response or a typed failure; never throws for an API error.
   */
  public async request(request: GitHubRequest): Promise<GitHubResult> {
    const first = await this.attempt(request);
    if (first.ok || first.reason !== "rate-limited" || first.retryAt === null) {
      return first;
    }
    const waitMs = first.retryAt.getTime() - Date.now();
    if (waitMs <= 0 || waitMs > this.maxRateLimitWaitMs) {
      return first;
    }
    await this.sleep(waitMs);
    // One retry only: a second limit inside the same window means the token is
    // shared with something else, and waiting again would hold the job open.
    return this.attempt(request);
  }

  /** Fetches a binary body (a tarball), with the same failure model. */
  public async download(
    path: string,
  ): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | GitHubFailure> {
    const label = `GET ${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return networkFailure(error);
    }
    if (!response.ok) {
      return httpFailure(response, label);
    }
    return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  /** Sends the request once and converts the response into a result. */
  private async attempt(request: GitHubRequest): Promise<GitHubResult> {
    const label = `GET ${request.path}`;
    const url = new URL(`${this.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          ...this.headers(),
          ...(request.etag === undefined ? {} : { "If-None-Match": request.etag }),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return networkFailure(error);
    }

    if (response.status === NOT_MODIFIED) {
      return {
        ok: true,
        response: {
          status: NOT_MODIFIED,
          notModified: true,
          etag: response.headers.get("etag"),
          body: undefined,
          ...rateLimitHeaders(response),
        },
      };
    }
    if (!response.ok) {
      return httpFailure(response, label);
    }

    const text = await response.text().catch(() => "");
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          reason: "invalid-json",
          detail: `${label} returned a body that is not JSON`,
          status: response.status,
          retryAt: null,
          retryable: false,
        };
      }
    }

    return {
      ok: true,
      response: {
        status: response.status,
        notModified: false,
        etag: response.headers.get("etag"),
        body,
        ...rateLimitHeaders(response),
      },
    };
  }

  /** Request headers; the token lives only here. */
  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
      ...(this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }),
    };
  }
}

/** Reads the two rate-limit headers, ignoring anything unparseable. */
function rateLimitHeaders(response: Response): {
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetAt: number | null;
} {
  return {
    rateLimitRemaining: toNumber(response.headers.get("x-ratelimit-remaining")),
    rateLimitResetAt: toNumber(response.headers.get("x-ratelimit-reset")),
  };
}

/** Maps a `fetch` rejection (DNS, reset, abort) onto a failure. */
function networkFailure(error: unknown): GitHubFailure {
  const timeout = error instanceof Error && error.name === "TimeoutError";
  return {
    ok: false,
    reason: timeout ? "timeout" : "network",
    // The message of a `fetch` rejection names the host, never the token.
    detail: timeout ? "the request timed out" : `network error: ${toError(error).message}`,
    status: null,
    retryAt: null,
    retryable: true,
  };
}

/** Maps a non-2xx response onto the failure taxonomy. */
function httpFailure(response: Response, label: string): GitHubFailure {
  const { rateLimitRemaining, rateLimitResetAt } = rateLimitHeaders(response);
  const retryAfter = toNumber(response.headers.get("retry-after"));
  const limited =
    (response.status === 403 || response.status === 429) &&
    (rateLimitRemaining === 0 || retryAfter !== null);

  if (limited) {
    // `Retry-After` (seconds) wins over `X-RateLimit-Reset` (epoch seconds): it is
    // the header GitHub sets for secondary limits, which reset sooner.
    const retryAt =
      retryAfter !== null
        ? new Date(Date.now() + retryAfter * 1_000)
        : rateLimitResetAt !== null
          ? new Date(rateLimitResetAt * 1_000)
          : null;
    return {
      ok: false,
      reason: "rate-limited",
      detail: `${label} was rate limited`,
      status: response.status,
      retryAt,
      retryable: true,
    };
  }

  const reason: GitHubFailureReason =
    response.status === 404
      ? "not-found"
      : response.status === 401
        ? "unauthorized"
        : response.status === 403
          ? "forbidden"
          : "http";
  return {
    ok: false,
    reason,
    detail: `${label} failed with HTTP ${response.status}`,
    status: response.status,
    retryAt: null,
    // A missing repository will still be missing in an hour; a 5xx may not be.
    retryable: response.status >= 500,
  };
}

/** Parses a numeric header, treating anything unparseable as absent. */
function toNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

