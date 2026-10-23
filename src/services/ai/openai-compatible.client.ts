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
    // Trim first: a value pasted into `/ai config set` often carries a trailing
    // space, which survives JSON and turns the path into `/v1beta/openai /chat/...`
    // — a 404 that looks exactly like a wrong URL.
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
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
    // An empty string is "nothing was configured", not an instruction to disconnect:
    // honouring it would turn a settings read that found no row into a live client
    // with `"" + "/chat/completions"` as its URL, which fails as a relative fetch.
    if (options.baseUrl !== undefined && options.baseUrl.length > 0) {
      this.baseUrl = normalizeBaseUrl(options.baseUrl);
    }
    if (options.apiKey !== undefined && options.apiKey.length > 0) {
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
        detail: describeFailure(http.status, http.statusText, http.body),
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

  /**
   * Diagnostic ping against `/models`. Never throws.
   *
   * `GET` first, because that is the documented verb for listing models and the
   * one every OpenAI-compatible provider implements. A few permissive providers
   * (OpenAI itself included) also accept `POST /models`, so a `404`/`405` on the
   * `GET` is retried once as `POST` instead of being reported as a dead endpoint.
   * Any other failure — a `401` for a bad key, a `403` for a restricted project —
   * is reported as-is: those are the answers an operator needs to see.
   *
   * The returned `detail` carries the status *and* what Google/OpenAI said, which
   * is the difference between "misconfigured" and "the model or path is wrong".
   */
  public async ping(): Promise<{ ok: boolean; detail?: string }> {
    const first = await this.get("/models");
    if (first.ok) {
      return { ok: true };
    }
    // Only a verb/shape rejection is retried; an auth failure is final.
    if (first.status === 404 || first.status === 405) {
      const retry = await this.post("/models", undefined);
      if (retry.ok) {
        return { ok: true };
      }
      return { ok: false, detail: describeFailure(retry.status, retry.statusText, retry.body) };
    }
    return { ok: false, detail: describeFailure(first.status, first.statusText, first.body) };
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
    | { ok: false; status: number; statusText: string; body: unknown }
  > {
    return this.send("POST", path, body);
  }

  /**
   * One HTTP GET with the same timeout and error normalization as `post`.
   *
   * `GET` is not optional machinery: the OpenAI-compatible surface lists models
   * with `GET /models`, and providers that implement only the documented verb —
   * Google's compatibility layer is the one that bit us — answer a `POST /models`
   * with a bare `404`, which reads like a broken deployment instead of a
   * mislabelled diagnostic. `ping` therefore tries `GET` first.
   */
  private async get(path: string): Promise<
    | { ok: true; status: number; statusText: string; body: unknown }
    | { ok: false; status: number; statusText: string; body: unknown }
  > {
    return this.send("GET", path, undefined);
  }

  /** Shared transport for `post` and `get`: one timeout, one error shape. */
  private async send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Promise<
    | { ok: true; status: number; statusText: string; body: unknown }
    | { ok: false; status: number; statusText: string; body: unknown }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await this.fetch(url, {
        method,
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
        return { ok: false, status: response.status, statusText, body: parsed };
      }

      return { ok: true, status: response.status, statusText, body: parsed };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false,
        status: aborted ? 408 : 0,
        statusText: aborted ? "Request Timeout" : "",
        body: undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Normalizes a provider base URL: trims surrounding whitespace and drops trailing
 * slashes, so `baseUrl + "/chat/completions"` is always well formed.
 */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Turns a failed HTTP exchange into one line an operator can act on.
 *
 * Providers disagree about where the reason lives (`error.message`,
 * `error.detail`, a bare string), and the OpenAI shape nests it, so all three are
 * probed. A status alone is not enough: `404` means "wrong URL" to one provider
 * and "unknown model" to another, and only the message distinguishes them.
 */
function describeFailure(status: number, statusText: string, body: unknown): string {
  const base = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
  const message = extractErrorMessage(body);
  return message ? `${base} — ${message}` : base;
}

/** Best-effort extraction of a provider's human-readable error. */
function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    return body.slice(0, 300);
  }
  if (!body || typeof body !== "object") {
    return undefined;
  }
  // Google returns an *array* of errors; OpenAI an object with `error.message`.
  const candidates: unknown[] = Array.isArray(body) ? (body as unknown[]) : [body];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) {
        return message.slice(0, 300);
      }
    }
    for (const key of ["message", "detail", "error_description"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value.slice(0, 300);
      }
    }
  }
  return undefined;
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
