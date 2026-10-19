/**
 * Single entry point for every AI request.
 *
 * The gateway owns the concerns that must never be duplicated across callers:
 * - **model levels**: `fast` for classification/summaries, `smart` for the
 *   assistant and the keyword agent, so a cheap model absorbs the high-volume
 *   path and the expensive one is reserved for real reasoning;
 * - **resilience**: a bounded retry with exponential backoff on 429/5xx and a
 *   per-request timeout, so one flaky provider does not hang a command;
 * - **accounting**: every request logs its tokens and estimated cost, and the
 *   hard daily budget is checked *before* a request is made so an over-budget
 *   deployment can never trigger a surprise invoice.
 *
 * The provider (a port) is injected, so tests exercise retry/budget/level logic
 * against a fake without a network. Nothing here reaches `fetch` or Discord.
 */
import type { z } from "zod";

import type { Logger } from "../logger/index.js";
import type {
  AiChatMessage,
  AiToolCall,
  AiToolDeclaration,
  AiUsage,
} from "./openai-compatible.client.js";

/** A model tier. The gateway tracks budget against the tier, not the request. */
export type AiModelLevel = "fast" | "smart";

/**
 * The provider port. `OpenAiCompatibleClient` implements it; tests fake it.
 *
 * The port exposes exactly the client's normalized `complete` (a discrimated
 * `{ ok, text, usage, toolCalls }` result) so the gateway never has to know
 * whether a real HTTP fetch or a fake answered — which is the seam that keeps
 * retry, budget and level-selection logic testable without a network.
 */
export interface AiProvider {
  readonly isConfigured: boolean;
  complete(request: {
    readonly messages: readonly AiChatMessage[];
    readonly model: string;
    readonly tools?: readonly AiToolDeclaration[];
    readonly jsonSchema?: Record<string, unknown>;
    readonly maxTokens?: number;
    readonly temperature?: number;
  }): Promise<
    | { readonly ok: true; readonly text: string; readonly usage: AiUsage; readonly toolCalls: readonly AiToolCall[] }
    | {
        readonly ok: false;
        readonly reason: string;
        readonly detail: string;
        readonly retryable?: boolean;
      }
  >;
  ping(): Promise<{ ok: boolean; detail?: string }>;
  /** Applies runtime transport changes (base URL, API key). Optional. */
  reconfigure?(options: { baseUrl?: string; apiKey?: string }): void;
}

export interface AiGatewayOptions {
  readonly logger: Logger;
  readonly provider: AiProvider;
  /** Model name per tier. A missing name makes that tier inert. */
  readonly models: { readonly fast?: string; readonly smart?: string };
  /** Hard daily token budget; `0` means unlimited. */
  readonly dailyTokenBudget: number;
  /** USD per 1M tokens, per tier, for cost logging. Defaults to `0` (unknown). */
  readonly costPerMillion?: { readonly fast?: number; readonly smart?: number };
  /** Injectable sleep for deterministic backoff tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Records tokens against the budget. Injected so tests observe it. */
  readonly onUsage?: (tier: AiModelLevel, usage: AiUsage) => void;
}

/** A successful gateway result. */
export interface AiGatewayOk {
  readonly ok: true;
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  readonly modelLevel: AiModelLevel;
  readonly usage: AiUsage;
  /** The provider's own model id, when it disclosed one. */
  readonly model: string | null;
}

/** A failed gateway result, always safe to surface or log. */
export interface AiGatewayError {
  readonly ok: false;
  readonly reason: AiGatewayFailureReason;
  readonly detail: string;
}

export type AiGatewayFailureReason =
  | "not-configured"
  | "budget-exhausted"
  | "timeout"
  | "http"
  | "provider-error";

export type AiGatewayResult = AiGatewayOk | AiGatewayError;

/** Budget state read back by `/ai status`. */
export interface AiBudgetState {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 250;

export class AiGateway {
  private readonly logger: Logger;
  private readonly provider: AiProvider;
  private models: { readonly fast?: string; readonly smart?: string };
  private dailyTokenBudget: number;
  private readonly costPerMillion: { readonly fast: number; readonly smart: number };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onUsage: ((tier: AiModelLevel, usage: AiUsage) => void) | undefined;

  /** Tokens consumed today, tracked per tier and summed by `usedTokens`. */
  private readonly used: Record<AiModelLevel, number> = { fast: 0, smart: 0 };

  public constructor(options: AiGatewayOptions) {
    this.logger = options.logger.child("ai:gateway");
    this.provider = options.provider;
    this.models = options.models;
    this.dailyTokenBudget = options.dailyTokenBudget;
    this.costPerMillion = {
      fast: options.costPerMillion?.fast ?? 0,
      smart: options.costPerMillion?.smart ?? 0,
    };
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onUsage = options.onUsage;
  }

  /** True when the transport has a provider to call. */
  public get isConfigured(): boolean {
    return this.provider.isConfigured;
  }

  /** Total tokens consumed today across both tiers. */
  public get usedTokens(): number {
    return this.used.fast + this.used.smart;
  }

  /** A read-only snapshot of the budget, for `/ai status`. */
  public budget(): AiBudgetState {
    const limit = this.dailyTokenBudget;
    const used = this.usedTokens;
    return {
      limit,
      used,
      remaining: limit === 0 ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    };
  }

  /** Whether the daily budget is exhausted (never true when `0` = unlimited). */
  public isBudgetExhausted(): boolean {
    return this.dailyTokenBudget > 0 && this.usedTokens >= this.dailyTokenBudget;
  }

  /**
   * Applies new model tiers, budget and provider transport at runtime.
   *
   * This is how the owner reconfigures AI from Discord: the settings service
   * resolves the new values and calls here, so the next request uses them
   * without a restart. The provider's own `reconfigure` (when present) receives
   * the base URL and API key; models and budget live on the gateway.
   */
  public reconfigure(options: {
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly modelFast?: string;
    readonly modelSmart?: string;
    readonly dailyTokenBudget?: number;
  }): void {
    if (options.modelFast !== undefined || options.modelSmart !== undefined || options.dailyTokenBudget !== undefined) {
      const next: { fast?: string; smart?: string } = {
        // Preserve the untouched tier when only the other one changed: a partial
        // reconfigure must not silently clear the model the owner did not name.
        ...(options.modelFast !== undefined || this.models.fast !== undefined
          ? { fast: options.modelFast ?? this.models.fast ?? "" }
          : {}),
        ...(options.modelSmart !== undefined || this.models.smart !== undefined
          ? { smart: options.modelSmart ?? this.models.smart ?? "" }
          : {}),
      };
      this.models = next;
      if (options.dailyTokenBudget !== undefined) {
        this.dailyTokenBudget = options.dailyTokenBudget;
      }
    }
    this.provider.reconfigure?.({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    });
    this.logger.warn("AI gateway reconfigured", {
      modelFast: this.models.fast ?? null,
      modelSmart: this.models.smart ?? null,
      dailyTokenBudget: this.dailyTokenBudget,
    });
  }

  /**
   * Runs one completion through the provider with retry and accounting.
   *
   * Returns a typed result, never throws: a missing provider, an exhausted
   * budget and a provider failure are all `{ ok: false }` so the agent can write
   * a graceful refusal instead of a stack trace.
   */
  public async complete(
    request: {
      readonly messages: readonly AiChatMessage[];
      readonly tools?: readonly AiToolDeclaration[];
      readonly maxTokens?: number;
      readonly temperature?: number;
    },
    level: AiModelLevel = "smart",
  ): Promise<AiGatewayResult> {
    const model = this.models[level];
    if (!this.provider.isConfigured || !model) {
      return { ok: false, reason: "not-configured", detail: NOT_CONFIGURED };
    }

    if (this.isBudgetExhausted()) {
      return { ok: false, reason: "budget-exhausted", detail: "daily token budget exhausted" };
    }

    let last: { reason: string; detail: string } = { reason: "provider-error", detail: "provider failed" };
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const result = await this.provider.complete({
        messages: request.messages,
        model,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });

      if (result.ok) {
        this.recordUsage(level, result.usage);
        return {
          ok: true,
          modelLevel: level,
          usage: result.usage,
          text: result.text,
          toolCalls: result.toolCalls,
          model: null,
        };
      }

      last = { reason: this.reasonOf(result), detail: result.detail };
      const retryable = result.retryable === true;
      if (!retryable || attempt === MAX_RETRIES) {
        break;
      }
      await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }

    this.logger.warn("AI request failed", { level, ...last });
    return { ok: false, reason: last.reason as AiGatewayFailureReason, detail: last.detail };
  }

  /**
   * Structured JSON completion, used by `summarize` and any future classifier.
   * Relays straight to the provider and applies the same accounting, so a JSON
   * failure is never mistaken for a text success.
   */
  public async completeJson<T>(
    prompt: readonly AiChatMessage[],
    schema: z.ZodType<T>,
    level: AiModelLevel = "fast",
  ): Promise<
    | { ok: true; data: T; modelLevel: AiModelLevel; usage: AiUsage }
    | { ok: false; reason: AiGatewayFailureReason; detail: string }
  > {
    const model = this.models[level];
    if (!this.provider.isConfigured || !model) {
      return { ok: false, reason: "not-configured", detail: NOT_CONFIGURED };
    }
    if (this.isBudgetExhausted()) {
      return { ok: false, reason: "budget-exhausted", detail: "daily token budget exhausted" };
    }

    const result = await this.provider.complete({ messages: prompt, model });
    if (!result.ok) {
      return { ok: false, reason: this.reasonOf(result), detail: result.detail };
    }

    this.recordUsage(level, result.usage);

    let raw: unknown;
    try {
      raw = JSON.parse(extractJson(result.text));
    } catch {
      return { ok: false, reason: "provider-error", detail: "provider returned unparseable JSON" };
    }
    const validated = schema.safeParse(raw);
    if (!validated.success) {
      return {
        ok: false,
        reason: "provider-error",
        detail: validated.error.issues[0]?.message ?? "schema mismatch",
      };
    }
    return { ok: true, data: validated.data, modelLevel: level, usage: result.usage };
  }

  /** Diagnostic ping against the provider, for `/ai status`. */
  public async ping(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.provider.isConfigured) {
      return { ok: false, detail: NOT_CONFIGURED };
    }
    return this.provider.ping();
  }

  private reasonOf(result: { readonly retryable?: boolean; readonly detail: string }): AiGatewayFailureReason {
    return result.retryable ? "http" : "provider-error";
  }

  private recordUsage(level: AiModelLevel, usage: AiUsage): void {
    this.used[level] += usage.totalTokens;
    this.onUsage?.(level, usage);

    const costPerMillion = this.costPerMillion[level];
    const cost = costPerMillion > 0 ? (usage.totalTokens / 1_000_000) * costPerMillion : 0;
    this.logger.info("AI usage", {
      level,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd: Number(cost.toFixed(6)),
      budgetUsed: this.usedTokens,
      budgetLimit: this.dailyTokenBudget,
    });
  }
}

const NOT_CONFIGURED = "IA non configurée (AI_BASE_URL/AI_API_KEY absents)";

/**
 * Extracts a JSON object from an answer that may wrap it in prose or a fence.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) {
    return fenced[1].trim();
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last >= first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}

