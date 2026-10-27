/**
 * The live GitHub feed: what `/github` shows *right now*, on top of the snapshots.
 *
 * What is asserted here is the contract a slash command depends on:
 *
 *   1. **four calls, one answer**: the repository, its newest release, its last CI run
 *      and its language mix are read in one round trip each, and the language list is
 *      the top of the byte mix rather than all eighty of them;
 *   2. **a failure is a value**: `latest()` answers `null` instead of throwing, because
 *      a GitHub outage must never break a reply;
 *   3. **it is cached**: a second reader inside the TTL costs nothing, and a failure is
 *      remembered for *less* time than a success so a transient error recovers;
 *   4. **it never waits forever**: a fetch that hangs is abandoned at the deadline.
 */
import { describe, expect, it } from "vitest";

import { GitHubClient } from "../../src/services/github/client.js";
import { GitHubLiveFeed } from "../../src/services/github/live-feed.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");

/** @returns a JSON response with the rate-limit headers GitHub sends. */
function json(body: unknown, remaining = 4_999, resetAt = 1_800_000_000): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(resetAt),
    },
  });
}

/** The four answers one healthy fetch needs, routed by the path that asks for them. */
function healthy(url: string): Response {
  if (url.endsWith("/languages")) {
    return json({ "C++": 7_000, C: 2_000, CMake: 500, Python: 500, Makefile: 1 }, 4_998);
  }
  if (url.includes("/releases/latest")) {
    return json({ tag_name: "v0.4.2", name: "v0.4.2", published_at: "2026-10-20T00:00:00.000Z" });
  }
  if (url.includes("/actions/runs")) {
    return json(
      {
        workflow_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-10-25T11:00:00.000Z",
          },
        ],
      },
      4_990,
    );
  }
  return json(
    {
      full_name: "anyps5/anyps5",
      description: "a PS5 emulator",
      default_branch: "main",
      stargazers_count: 12_345,
      forks_count: 456,
      subscribers_count: 78,
      open_issues_count: 9,
      pushed_at: "2026-10-25T09:00:00.000Z",
      archived: false,
    },
    4_997,
  );
}

/**
 * A `fetch` stand-in: `respond` decides each answer, and every requested URL is kept.
 *
 * The URLs are recorded rather than the count, because what these tests assert about a
 * cached fetch is *that no request was sent*, and the cheapest way to say that is the
 * length of a list that only `fetch` can grow.
 */
function scriptedFetch(
  respond: (url: string) => Response | Promise<Response>,
): typeof fetch & { readonly calls: string[] } {
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push(request.url);
    return Promise.resolve(respond(request.url));
  };
  return Object.assign(impl, { calls }) as typeof fetch & { readonly calls: string[] };
}

/** A client over `fetchImpl`, with a token — the state a deployment with `GITHUB_TOKEN` has. */
function clientWith(fetchImpl: typeof fetch): GitHubClient {
  return new GitHubClient({ fetch: fetchImpl, token: "test-token" });
}

describe("GitHubLiveFeed", () => {
  /** @returns a feed over `fetchImpl`, with a frozen clock the test moves by hand. */
  function feedOver(
    fetchImpl: typeof fetch,
    clock: { now: Date },
    options: { readonly deadlineMs?: number } = {},
  ): GitHubLiveFeed {
    return new GitHubLiveFeed({
      client: clientWith(fetchImpl),
      target: { owner: "anyps5", repo: "anyps5", branch: undefined },
      now: () => clock.now,
      ...options,
    });
  }

  it("reads the repository, its release, its CI run and its languages in one pass", async () => {
    const fetchImpl = scriptedFetch(healthy);
    const feed = feedOver(fetchImpl, { now: NOW });

    const facts = await feed.latest();

    expect(facts).not.toBeNull();
    expect(fetchImpl.calls).toHaveLength(4);
    expect(facts?.fullName).toBe("anyps5/anyps5");
    expect(facts?.stars).toBe(12_345);
    expect(facts?.watchers).toBe(78);
    // The default branch is taken from the repository, and the CI call asks for it.
    expect(facts?.defaultBranch).toBe("main");
    expect(fetchImpl.calls.some((url) => url.includes("branch=main"))).toBe(true);
    expect(facts?.release?.tag).toBe("v0.4.2");
    expect(facts?.workflow?.conclusion).toBe("success");
    // The largest three by byte share, largest first, and nothing beyond them.
    expect(facts?.languages.map((language) => language.name)).toEqual(["C++", "C", "CMake"]);
    // The lowest quota any of the four calls reported: showing more than is left would
    // be worse than showing less.
    expect(facts?.rateLimitRemaining).toBe(4_990);
    expect(facts?.authenticated).toBe(true);
    expect(facts?.fetchedAt.getTime()).toBe(NOW.getTime());
  });

  it("reuses an answer inside the TTL instead of asking again", async () => {
    const clock = { now: NOW };
    const fetchImpl = scriptedFetch(healthy);
    const feed = feedOver(fetchImpl, clock);

    const first = await feed.latest();
    clock.now = new Date(NOW.getTime() + 60_000);
    const second = await feed.latest();
    // Two minutes after the fetch, the answer is stale and is read again.
    clock.now = new Date(NOW.getTime() + 121_000);
    const third = await feed.latest();

    expect(fetchImpl.calls).toHaveLength(8);
    expect(first).toBe(second);
    expect(third).not.toBeNull();
  });

  it("shares one round of calls between readers that arrive together", async () => {
    const fetchImpl = scriptedFetch(healthy);
    const feed = feedOver(fetchImpl, { now: NOW });

    const [left, right, third] = await Promise.all([
      feed.latest(),
      feed.latest(),
      feed.latest(),
    ]);

    // Three readers, one fetch: five people pressing a panel button in the same minute
    // must not spend five rounds of quota.
    expect(fetchImpl.calls).toHaveLength(4);
    expect(left).toBe(right);
    expect(right).toBe(third);
  });

  it("answers null when GitHub does not, and retries sooner than it would for a success", async () => {
    const clock = { now: NOW };
    let failing = true;
    const fetchImpl = scriptedFetch((url) =>
      failing ? new Response("{}", { status: 500 }) : healthy(url),
    );
    const feed = feedOver(fetchImpl, clock);

    expect(await feed.latest()).toBeNull();
    // The failure is remembered: a burst of clicks does not hammer a broken API.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(await feed.latest()).toBeNull();
    expect(fetchImpl.calls).toHaveLength(1);

    // But for a shorter time than a success, so a transient error clears in half a
    // minute rather than two.
    failing = false;
    clock.now = new Date(NOW.getTime() + 31_000);
    const recovered = await feed.latest();
    expect(recovered).not.toBeNull();
    expect(fetchImpl.calls).toHaveLength(5);
  });

  it("gives up at the deadline rather than holding a reply open", async () => {
    const fetchImpl = scriptedFetch(
      () => new Promise<Response>(() => { /* never answers */ }),
    );
    const feed = feedOver(fetchImpl, { now: NOW }, { deadlineMs: 20 });

    expect(await feed.latest()).toBeNull();
  });

  it("reports whether the client carries a token", () => {
    const anonymous = new GitHubLiveFeed({
      client: new GitHubClient({ fetch: scriptedFetch(healthy) }),
      target: { owner: "anyps5", repo: "anyps5" },
    });
    const authenticated = feedOver(scriptedFetch(healthy), { now: NOW });

    expect(anonymous.isAuthenticated).toBe(false);
    expect(authenticated.isAuthenticated).toBe(true);
  });
});

