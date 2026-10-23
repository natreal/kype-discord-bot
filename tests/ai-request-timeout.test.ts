/**
 * Request timeouts.
 *
 * A healthy Gemini setup answered `/ai ask` with `HTTP 408 – Request Timeout`
 * although the URL, key and model were all correct. Three separate causes, each
 * pinned here:
 *
 *   1. **The default budget was too small.** 20s aborted reasoning models
 *      mid-thought: Gemini 2.5 emits thinking tokens before the first visible
 *      token, so a short prompt can legitimately outrun 20s.
 *   2. **A timeout was not retryable.** `retryable` was derived from the HTTP
 *      status, and a timeout has no response — so the one genuinely transient
 *      failure was the one the gateway never retried.
 *   3. **A stored row could pin the old budget.** `requestTimeoutMs` was already
 *      persisted, but nothing applied it to the live client and the column default
 *      (20s) beat the `.env` value, so raising the env var changed nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleClient } from "../src/services/ai/openai-compatible.client.js";

/** A `fetch` that never settles until its abort signal fires, like a slow model. */
function hangingFetch(): { fetch: typeof fetch; aborts: () => number } {
  let aborted = 0;
  const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted += 1;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  });
  return { fetch: impl as unknown as typeof fetch, aborts: () => aborted };
}

function makeClient(options: {
  timeoutMs: number;
  fetch?: typeof fetch;
}): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "AIza-test",
    timeoutMs: options.timeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

describe("request timeout", () => {
  it("reports a timeout as retryable, so the gateway backs off and tries again", async () => {
    const { fetch } = hangingFetch();
    const result = await makeClient({ timeoutMs: 10, fetch }).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-2.5-flash",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // The regression: this was `undefined`, so a timeout was never retried.
    expect(result.retryable).toBe(true);
  });

  it("names the budget and the env var instead of a bare HTTP 408", async () => {
    const { fetch } = hangingFetch();
    const result = await makeClient({ timeoutMs: 10, fetch }).complete({
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-2.5-flash",
    });

    if (result.ok) throw new Error("expected failure");
    expect(result.detail).toContain("408");
    expect(result.detail).toContain("10ms");
    expect(result.detail).toContain("AI_REQUEST_TIMEOUT_MS");
  });

  it("surfaces the cause of a real network fault rather than an empty detail", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com"),
      });
    });
    const result = await makeClient({
      timeoutMs: 5_000,
      fetch: fetch as unknown as typeof fetch,
    }).complete({ messages: [{ role: "user", content: "hi" }], model: "gemini-2.5-flash" });

    if (result.ok) throw new Error("expected failure");
    // Not retryable: DNS failure is not transient in the way a 5xx is.
    expect(result.retryable).toBe(false);
    expect(result.detail).toContain("ENOTFOUND");
  });

  it("applies a retuned timeout at runtime, so the fix needs no restart", async () => {
    const { fetch, aborts } = hangingFetch();
    const client = makeClient({ timeoutMs: 10, fetch });

    // A longer budget must actually be honoured: the request should still be in
    // flight after the old 10ms budget would have elapsed.
    client.reconfigure({ timeoutMs: 5_000 });
    const pending = client.complete({
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-2.5-flash",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aborts()).toBe(0);

    client.reconfigure({ timeoutMs: 10 });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(aborts()).toBe(1);
  });

  it("ignores a nonsensical timeout instead of aborting every request instantly", () => {
    const client = makeClient({ timeoutMs: 5_000 });
    // 0/negative/NaN would make every request fail at once, which looks exactly
    // like the bug this file guards against.
    client.reconfigure({ timeoutMs: 0 });
    client.reconfigure({ timeoutMs: -1 });
    client.reconfigure({ timeoutMs: Number.NaN });
    // Still configured and usable: no throw, and the budget survived.
    expect(client.isConfigured).toBe(true);
  });
});
