/**
 * AI gateway tests, against a fake OpenAI-compatible transport.
 *
 * These prove the gateway's non-negotiable behaviours without a network: success,
 * retry/backoff on 429, invalid shape, schema mismatch and budget exhaustion. The
 * fake `fetch` is injected into the client, and the gateway's `sleep` is stubbed
 * so timing is deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenAiCompatibleClient } from "../src/services/ai/openai-compatible.client.js";
import { AiGateway, type AiUsage } from "../src/services/ai/ai.gateway.js";
import { testLogger } from "./helpers/logger.js";

function completionBody(text: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content: text, tool_calls: [] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "test-model",
  };
}

function makeGateway(options: {
  fetch?: typeof fetch;
  dailyTokenBudget?: number;
  onUsage?: (tier: "fast" | "smart", usage: AiUsage) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): AiGateway {
  const client = new OpenAiCompatibleClient({
    baseUrl: "https://example.test/v1",
    apiKey: "test",
    timeoutMs: 10_000,
    fetch: options.fetch ?? (async () => new Response(JSON.stringify(completionBody("hello")), { status: 200 })) as unknown as typeof fetch,
  });
  return new AiGateway({
    logger: testLogger,
    provider: client,
    models: { fast: "fast-model", smart: "smart-model" },
    dailyTokenBudget: options.dailyTokenBudget ?? 0,
    sleep: options.sleep ?? (() => Promise.resolve()),
    onUsage: options.onUsage,
  });
}

describe("AiGateway", () => {
  it("returns a successful completion and selects the smart model by default", async () => {
    const gateway = makeGateway();
    const result = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("hello");
      expect(result.modelLevel).toBe("smart");
      expect(result.usage.totalTokens).toBe(15);
    }
  });

  it("reports 'not-configured' when no provider is present", async () => {
    const gateway = new AiGateway({
      logger: testLogger,
      provider: {
        isConfigured: false,
        complete: async () => ({ ok: false, reason: "x", detail: "x" }),
        ping: async () => ({ ok: false }),
      },
      models: { smart: "smart-model" },
      dailyTokenBudget: 0,
    });
    const result = await gateway.complete({ messages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-configured");
    }
  });

  it("retries on 429 with exponential backoff, then succeeds", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }
      return new Response(JSON.stringify(completionBody("ok after retry")), { status: 200 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const gateway = makeGateway({
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await gateway.complete({ messages: [] });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("returns provider-error when the provider sends no choices", async () => {
    const gateway = makeGateway({
      fetch: (async () => new Response('{"choices":[]}', { status: 200 })) as unknown as typeof fetch,
    });
    const result = await gateway.complete({ messages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("provider-error");
    }
  });

  it("exhausts the daily token budget and refuses further requests", async () => {
    const gateway = makeGateway({ dailyTokenBudget: 10 });
    const first = await gateway.complete({ messages: [] });
    expect(first.ok).toBe(true);
    const second = await gateway.complete({ messages: [] });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("budget-exhausted");
    }
  });

  it("validates structured JSON output against a schema", async () => {
    const gateway = makeGateway({
      fetch: (async () => new Response(JSON.stringify(completionBody('{"name":"test"}')), { status: 200 })) as unknown as typeof fetch,
    });
    const result = await gateway.completeJson([{ role: "user", content: "json" }], z.object({ name: z.string() }), "fast");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("test");
      expect(result.modelLevel).toBe("fast");
    }
  });

  it("rejects JSON that does not match the schema", async () => {
    const gateway = makeGateway({
      fetch: (async () => new Response(JSON.stringify(completionBody('{"wrong":1}')), { status: 200 })) as unknown as typeof fetch,
    });
    const result = await gateway.completeJson([{ role: "user", content: "" }], z.object({ name: z.string() }));
    expect(result.ok).toBe(false);
  });
});
