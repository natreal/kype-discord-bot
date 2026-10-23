/**
 * Provider `ping()` and base-URL handling.
 *
 * Every assertion here exists because of a real failure, and each one is a promise
 * an operator relies on when `/ai config test` or `/ai ask` reports a number:
 *
 *   1. **`ping` uses `GET /models`**, the documented verb. Google's
 *      OpenAI-compatibility layer answers `POST /models` with a bare `404`, which on
 *      a perfectly healthy Gemini setup reads as "your deployment is broken".
 *   2. **`ping` still works for providers that only accept `POST`**, so fixing one
 *      provider must not break another.
 *   3. **the provider's own message is reported**, because `HTTP 404` alone cannot
 *      distinguish a wrong URL from an unknown model.
 *   4. **a base URL carrying whitespace or a trailing slash is normalized**, since
 *      `/v1beta/openai /chat/completions` also answers `404`.
 */
import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleClient } from "../src/services/ai/openai-compatible.client.js";

/** Records `(url, init)` for every request the client makes. */
function recordingFetch(
  respond: (url: string, init: RequestInit | undefined) => Response,
): { fetch: typeof fetch; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: target, method: init?.method ?? "GET" });
    return respond(target, init);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(options: {
  baseUrl?: string;
  fetch: typeof fetch;
}): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "AIza-test",
    timeoutMs: 5_000,
    fetch: options.fetch,
  });
}

describe("OpenAiCompatibleClient.ping", () => {
  it("lists models with GET, not POST", async () => {
    const { fetch, calls } = recordingFetch(() => json({ data: [] }));
    const result = await makeClient({ fetch }).ping();

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    );
  });

  it("falls back to POST for providers that only accept that verb", async () => {
    const { fetch, calls } = recordingFetch((_url, init) =>
      init?.method === "POST" ? json({ data: [] }) : json({ error: "not found" }, 404),
    );
    const result = await makeClient({ fetch }).ping();

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("reports the provider's message on a genuine 404", async () => {
    const { fetch } = recordingFetch(() =>
      json({ error: { message: "models/x is not found for API version v1beta" } }, 404),
    );
    const result = await makeClient({ fetch }).ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTTP 404");
    expect(result.detail).toContain("is not found for API version v1beta");
  });

  it("does not retry an auth failure", async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({ error: { message: "API key not valid" } }, 401),
    );
    const result = await makeClient({ fetch }).ping();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("API key not valid");
    expect(calls).toHaveLength(1);
  });
});

describe("OpenAiCompatibleClient base URL", () => {
  it("trims whitespace and trailing slashes before building a path", async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({ choices: [{ message: { content: "hi", tool_calls: [] } }], model: "m" }),
    );
    const client = makeClient({ baseUrl: "  https://example.test/v1/  ", fetch });

    const result = await client.complete({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
  });

  it("ignores an empty baseUrl on reconfigure instead of disconnecting", async () => {
    const { fetch, calls } = recordingFetch(() =>
      json({ choices: [{ message: { content: "hi", tool_calls: [] } }], model: "m" }),
    );
    const client = makeClient({ baseUrl: "https://example.test/v1", fetch });

    client.reconfigure({ baseUrl: "" });
    await client.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });

    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
  });
});

describe("OpenAiCompatibleClient.complete", () => {
  it("includes the provider's message when the request fails", async () => {
    const { fetch } = recordingFetch(() =>
      json({ error: { message: "models/gemini-nope is not found" } }, 404),
    );
    const client = makeClient({ fetch });

    const result = await client.complete({
      model: "gemini-nope",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("gemini-nope");
      // A 404 is a configuration mistake, not a transient fault worth retrying.
      expect(result.retryable).toBe(false);
    }
  });
});
