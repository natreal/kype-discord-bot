/**
 * GitHub client and repository configuration tests.
 *
 * What is asserted here is the contract the hourly job depends on:
 *
 *   1. **a rate limit is waited out, not failed**, and a wait that is too long is
 *      reported with the instant to try again rather than burning an attempt;
 *   2. **a conditional request costs nothing**: a `304` is a success that carries no
 *      body, so an unchanged repository never fails a refresh;
 *   3. **the token never leaks** into a failure detail, and an anonymous client is
 *      still usable;
 *   4. **configuration is validated**: a malformed repository name is a startup
 *      error, not a confusing 404 an hour later, and the token is redacted.
 */
import { describe, expect, it } from "vitest";

import { GitHubClient } from "../../src/services/github/client.js";
import { createConfig, DEFAULT_REPOSITORY, redactConfig } from "../../src/config/config.js";
import { ConfigError } from "../../src/utils/errors.js";
import { rawEnv, testConfig } from "../helpers/config.js";

/** A `fetch` stand-in with a scripted response and the requests it received. */
function fakeFetch(responses: Response[]): typeof fetch & { readonly calls: Request[] } {
  const calls: Request[] = [];
  const queue = [...responses];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(new Request(input, init));
    const next = queue.shift() ?? new Response("{}", { status: 200 });
    return Promise.resolve(next);
  };
  return Object.assign(impl, { calls });
}

describe("GitHub client", () => {
  it("waits for a short rate limit and retries once", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 5;
    const fetchImpl = fakeFetch([
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
      }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const sleeps: number[] = [];
    const client = new GitHubClient({
      fetch: fetchImpl,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await client.request({ path: "/repos/o/r" });

    expect(result.ok).toBe(true);
    // Waited until the advertised reset rather than a guessed backoff.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("fails with the retry instant when the limit is too far away", async () => {
    const resetAt = Math.floor(Date.now() / 1_000) + 3_600;
    const client = new GitHubClient({
      fetch: fakeFetch([
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
        }),
      ]),
      // A one-minute ceiling: an hour-long wait is not worth holding the job open.
      maxRateLimitWaitMs: 60_000,
    });

    const result = await client.request({ path: "/repos/o/r" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rate-limited");
      expect(result.retryable).toBe(true);
      expect(result.retryAt?.getTime()).toBe(resetAt * 1_000);
    }
  });

  it("treats a 304 as success and sends the stored ETag", async () => {
    const fetchImpl = fakeFetch([new Response(null, { status: 304, headers: { etag: '"abc"' } })]);
    const client = new GitHubClient({ fetch: fetchImpl });

    const result = await client.request({ path: "/repos/o/r/commits", etag: '"abc"' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.notModified).toBe(true);
      expect(result.response.body).toBeUndefined();
      expect(result.response.etag).toBe('"abc"');
    }
    expect(fetchImpl.calls[0]?.headers.get("if-none-match")).toBe('"abc"');
  });

  it("reports a 404 as a terminal failure and a 503 as retryable", async () => {
    const client = new GitHubClient({
      fetch: fakeFetch([new Response("{}", { status: 404 }), new Response("{}", { status: 503 })]),
    });

    const missing = await client.request({ path: "/repos/o/r" });
    const unavailable = await client.request({ path: "/repos/o/r" });

    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe("not-found");
      expect(missing.retryable).toBe(false);
    }
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.retryable).toBe(true);
    }
  });

  it("never puts the token in a failure detail", async () => {
    const token = "ghp_supersecretvalue";
    const client = new GitHubClient({
      token,
      fetch: fakeFetch([new Response("nope", { status: 500 })]),
    });

    const result = await client.request({ path: "/repos/o/r" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain(token);
      expect(result.detail).toContain("HTTP 500");
    }
  });

  it("sends the token as a bearer header when configured, and nothing when not", async () => {
    const authenticated = fakeFetch([new Response("{}")]);
    const anonymous = fakeFetch([new Response("{}")]);

    await new GitHubClient({ token: "ghp_x", fetch: authenticated }).request({ path: "/x" });
    await new GitHubClient({ fetch: anonymous }).request({ path: "/x" });

    expect(authenticated.calls[0]?.headers.get("authorization")).toBe("Bearer ghp_x");
    expect(anonymous.calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("surfaces an invalid JSON body instead of throwing", async () => {
    const client = new GitHubClient({ fetch: fakeFetch([new Response("not json", { status: 200 })]) });

    const result = await client.request({ path: "/repos/o/r" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-json");
    }
  });
});

describe("repository configuration", () => {
  it("defaults to the project the monitor was written for", () => {
    expect(testConfig().repository).toEqual({
      fullName: DEFAULT_REPOSITORY,
      token: undefined,
      intervalMinutes: 60,
      reportChannelId: null,
    });
  });

  it("accepts an explicit repository, token and channel", () => {
    const repository = testConfig({
      GITHUB_REPOSITORY: "someone/fork",
      GITHUB_TOKEN: "ghp_x",
      GITHUB_POLL_INTERVAL_MINUTES: "15",
      GITHUB_REPORT_CHANNEL_ID: "123456789012345678",
    }).repository;

    expect(repository.fullName).toBe("someone/fork");
    expect(repository.token).toBe("ghp_x");
    expect(repository.intervalMinutes).toBe(15);
    expect(repository.reportChannelId).toBe("123456789012345678");
  });

  it("rejects a malformed repository name at startup, not on the first poll", () => {
    expect(() => createConfig(rawEnv({ GITHUB_REPOSITORY: "AnyPS5" }), { loadEnvFiles: false })).toThrow(
      ConfigError,
    );
    expect(() =>
      createConfig(rawEnv({ GITHUB_REPOSITORY: "boykopovar/AnyPS5/extra" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
  });

  it("rejects an interval outside the supported range", () => {
    expect(() =>
      createConfig(rawEnv({ GITHUB_POLL_INTERVAL_MINUTES: "0" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
    expect(() =>
      createConfig(rawEnv({ GITHUB_POLL_INTERVAL_MINUTES: "1441" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
  });

  it("rejects a report channel that is not a snowflake", () => {
    expect(() =>
      createConfig(rawEnv({ GITHUB_REPORT_CHANNEL_ID: "#general" }), { loadEnvFiles: false }),
    ).toThrow(ConfigError);
  });

  it("redacts the token from anything that is logged or serialized", () => {
    const token = "ghp_supersecretvalue";
    const redacted = redactConfig(testConfig({ GITHUB_TOKEN: token }));

    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(redacted).toMatchObject({ repository: { token: "[redacted]" } });
    // An absent token stays absent rather than reading as a present credential.
    expect(redactConfig(testConfig())).toMatchObject({ repository: { token: null } });
  });
});

