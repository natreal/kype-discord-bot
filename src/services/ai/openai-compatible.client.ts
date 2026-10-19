/**
 * Minimal OpenAI-compatible HTTP client.
 *
 * The whole AI transport layer is a `fetch` client on purpose: pulling in an SDK
 * would pin us to one vendor's error model and one network stack, while OpenAI,
 * Azure, OpenRouter, Groq, Together, vLLM and local Ollama/LM Studio all speak the
 * same `/chat/completions` + `/models` surface. A single client therefore covers
 * every provider by configuration alone.
 *
 * The contract is "never throw on the hot path": every response — including a
 * network drop, a non-2xx body and non-JSON garbage — is folded into a typed
 * `AiClientResult` so the gateway can decide (retry, fail, budget) without a
 * try/catch maze. Throwing is reserved for programmer errors (a missing URL).
 */
import { z } from "zod";

/** Discriminated result of one `complete` call. Never thrown. */
export type CompletionResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly toolCalls: readonly AiToolCall[];
      /** Which provider model answered, for cost logging (`null` when hidden). */
      readonly model: string | null;
      /** Prompt + completion tokens as reported by the provider. */
      readonly usage: AiUsage;
    }
  | {
      readonly ok: false;
      readonly reason: AiClientFailureReason;
      /** Human-readable detail, safe to log (no secrets). */
      readonly detail: string;
      /** Set on a retryable HTTP status so the gateway can back off. */
      readonly retryable?: boolean;
    };

/** Usage accounting, echoed verbatim but bounded to a sane shape. */
export interface AiUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Why a request failed; drives the gateway's retry/backoff decision. */
export type AiClientFailureReason =
  | "http"
  | "timeout"
  | "invalid-json"
  | "schema"
  | "malformed-response"
  | "network";

/** A single message in the OpenAI chat shape. */
export interface AiChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Present only for `role === "tool"`. */
  readonly toolCallId?: string;
  /**
   * Present only for an assistant message that requested tool calls. Providers
   * (OpenAI included) reject a `tool` result whose matching assistant
   * `tool_calls` message is absent, so the assistant turn must be echoed back
   * before its results.
   */
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
}

/** A tool exposed to the model via tool-calling. */
export interface AiToolDeclaration {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema of the tool's parameters. */
    readonly parameters: Record<string, unknown>;
  };
}

/** A tool-call the model asked for. */
export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw argument JSON string; validated by the caller with Zod. */
  readonly arguments: string;
}

export interface AiClientRequest {
  readonly messages: readonly AiChatMessage[];
  readonly model: string;
  readonly tools?: readonly AiToolDeclaration[];
  /** Force a JSON object answer (ignored when `tools` are present). */
  readonly jsonSchema?: Record<string, unknown>;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** Transport options that stay stable across every request. */
export interface AiClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Injectable `fetch`, so tests can substitute a fake transport. */
  readonly fetch?: typeof fetch;
}

const USAGE_SCHEMA = z.object({
  prompt_tokens: z.number().int().min(0).default(0),
  completion_tokens: z.number().int().min(0).default(0),
  total_tokens: z.number().int().min(0).default(0),
});

const COMPLETION_SCHEMA = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().nullable().default(null),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.string().default("function"),
              function: z.object({
                name: z.string(),
                arguments: z.string().default("{}"),
              }),
            }),
          )
          .optional()
          .default([]),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: USAGE_SCHEMA.optional(),
  model: z.string().nullable().optional(),
});

export class OpenAiCompatibleClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  public constructor(options: AiClientOptions) {
    // Strip a trailing slash so `baseURL + "/chat/completions"` never doubles one.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** True when this client has a provider to talk to. */
  public get isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Applies new transport settings at runtime, so the owner can point the bot at
   * a different provider (or rotate the API key) from Discord without a restart.
   * The base URL is normalized the same way the constructor does.
   */
  public reconfigure(options: { readonly baseUrl?: string; readonly apiKey?: string }): void {
    if (options.baseUrl !== undefined) {
      this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    }
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
  }

  /** One chat completion. Returns a result, never throws. */
  public async complete(request: AiClientRequest): Promise<CompletionResult> {
    const body = buildCompletionBody(request);
    const http = await this.post("/chat/completions", body);
    if (!http.ok) {
      return {
        ok: false,
        reason: "http",
        retryable: http.status === 429 || http.status >= 500,
        detail: `HTTP ${http.status}${http.statusText ? ` ${http.statusText}` : ""}`,
      };
    }

    const parsed = COMPLETION_SCHEMA.safeParse(http.body);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "malformed-response",
        detail: "provider returned an unexpected shape",
      };
    }

    // An empty choices array (some providers return it instead of erroring) is not
    // a valid completion: folding it into a failure keeps the gateway honest about
    // "the model said something" vs "the model was silent".
    const choice = parsed.data.choices[0];
    if (!choice) {
      return { ok: false, reason: "malformed-response", detail: "provider returned no choices" };
    }

    const content = choice.message.content ?? "";
    const toolCalls: AiToolCall[] = choice.message.tool_calls
      .filter((call) => call.type === "function" || call.type === undefined)
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));

    const usage = parsed.data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      ok: true,
      text: content,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      toolCalls,
      model: parsed.data.model ?? null,
    };
  }

  /**
   * Validates a constrained JSON completion against `schema` before returning it.
   *
   * This is the "structured output" path: the model is asked for JSON, the answer
   * is parsed eagerly, and a malformed or off-schema answer becomes a `schema`
   * failure rather than a crash or a silently-undefined value. The caller never
   * has to guess whether `data` is actually the type it asked for.
   */
  public async completeJson<T>(
    prompt: readonly AiChatMessage[],
    schema: z.ZodType<T>,
    model: { readonly name: string; readonly jsonSchema?: Record<string, unknown> },
  ): Promise<
    | { ok: true; data: T; usage: AiUsage }
    | { ok: false; reason: AiClientFailureReason; detail: string }
  > {
    const result = await this.complete({
      messages: prompt,
      model: model.name,
      ...(model.jsonSchema === undefined ? {} : { jsonSchema: model.jsonSchema }),
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason, detail: result.detail };
    }

    if (result.text.trim().length === 0) {
      return { ok: false, reason: "invalid-json", detail: "provider returned an empty JSON body" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(extractJson(result.text));
    } catch {
      return { ok: false, reason: "invalid-json", detail: "provider returned unparseable JSON" };
    }

    const validated = schema.safeParse(raw);
    if (!validated.success) {
      return {
        ok: false,
        reason: "schema",
        detail: validated.error.issues[0]?.message ?? "schema mismatch",
      };
    }

    return { ok: true, data: validated.data, usage: result.usage };
  }

  /** Diagnostic ping against `/models`. Never throws. */
  public async ping(): Promise<{ ok: boolean; detail?: string }> {
    const http = await this.post("/models", undefined);
    return http.ok ? { ok: true } : { ok: false, detail: `HTTP ${http.status}` };
  }

  /**
   * One HTTP POST with timeout + normalized error.
   *
   * A timeout is reported as status 408 and an unreachable provider as status 0, so
   * the gateway can distinguish "retry after backoff" from "the provider is down"
   * without parsing the raw `Error`.
   */
  private async post(
    path: string,
    body: unknown,
  ): Promise<
    | { ok: true; status: number; statusText: string; body: unknown }
    | { ok: false; status: number; statusText: string }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const statusText = response.statusText;
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        return { ok: false, status: response.status, statusText };
      }

      return { ok: true, status: response.status, statusText, body: parsed };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        status: aborted ? 408 : 0,
        statusText: aborted ? "Request Timeout" : "",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Builds the request body from the OpenAI-compatible request shape. */
function buildCompletionBody(request: AiClientRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
    })),
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }
  if (request.jsonSchema !== undefined) {
    body.response_format = { type: "json_object", schema: request.jsonSchema };
  }
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  return body;
}

/**
 * Extracts the JSON object from a model answer that may wrap it in prose or a
 * markdown fence. Providers frequently refuse `json_object` cleanly, so we accept
 * the common ` ```json ...``` ` envelope defensively rather than fail a good
 * answer over formatting.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace >= firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}
