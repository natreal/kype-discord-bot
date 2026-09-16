/**
 * AI module (foundation only).
 *
 * The AI system itself is not implemented yet. This module exists so that the
 * architecture is already correct when it lands:
 *
 *   AI -> controlled tool -> permission system -> validation -> Discord -> log
 *
 * The AI never receives a Discord client, raw tokens or the ability to run
 * arbitrary code. Every future AI capability must be registered as a tool here
 * and must pass through `AiToolRegistry` before any Discord action happens.
 */
import type { GuildMember } from "discord.js";

import type { BotModule, SetupAction } from "../module.types.js";
import type { PermissionService } from "../../services/permissions/index.js";
import type { Logger } from "../../services/logger/index.js";

/** A single capability the AI is allowed to request. */
export interface AiTool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name, e.g. `summarize_channel`. */
  readonly name: string;
  /** Human-readable description surfaced to the model. */
  readonly description: string;
  /** Bot permissions the invoker must hold for the tool to run. */
  readonly requiredPermissions?: readonly string[];
  /** Validates and normalizes the model-provided input. */
  validate(input: unknown): TInput;
  /** Executes the effect. Must be side-effect scoped and auditable. */
  execute(input: TInput, context: AiToolContext): Promise<TOutput>;
}

/** Everything a tool is allowed to know about the invocation. */
export interface AiToolContext {
  readonly guildId: string;
  readonly invoker: GuildMember;
  readonly permissions: PermissionService;
  readonly logger: Logger;
}

/** Result of a tool invocation. */
export interface AiToolResult<TOutput = unknown> {
  readonly ok: boolean;
  readonly output?: TOutput;
  readonly reason?: string;
}

/**
 * Central choke point for AI-initiated actions.
 *
 * Nothing bypasses this registry: it validates input, enforces bot permissions
 * through the permission service and logs every invocation.
 */
export class AiToolRegistry {
  private readonly tools = new Map<string, AiTool<unknown, unknown>>();
  private readonly logger: Logger;

  public constructor(logger: Logger) {
    this.logger = logger.child("ai:tools");
  }

  public register<TInput, TOutput>(tool: AiTool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`AI tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    this.logger.debug("Registered AI tool", { tool: tool.name });
  }

  public list(): readonly string[] {
    return [...this.tools.keys()];
  }

  /** Validates, authorizes, executes and logs a tool invocation. */
  public async invoke<TInput, TOutput>(
    name: string,
    input: unknown,
    context: AiToolContext,
  ): Promise<AiToolResult<TOutput>> {
    const tool = this.tools.get(name) as AiTool<TInput, TOutput> | undefined;
    if (!tool) {
      return { ok: false, reason: `Unknown AI tool: ${name}` };
    }

    try {
      const validated = tool.validate(input);
      this.logger.info("AI tool invoked", {
        tool: name,
        guildId: context.guildId,
        userId: context.invoker.id,
      });
      const output = await tool.execute(validated, context);
      return { ok: true, output };
    } catch (error) {
      this.logger.error("AI tool failed", error, { tool: name, guildId: context.guildId });
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "tool execution failed",
      };
    }
  }
}

export const aiModule: BotModule = {
  name: "ai",
  description: "AI moderation and assistant capabilities routed through controlled tools.",

  enabled(context): boolean {
    return context.config.ai.enabled;
  },

  plan(planContext): SetupAction[] {
    const { ai } = planContext.config;

    return [
      {
        key: "assistant-channel",
        description: "Verify the configured AI assistant channel still exists.",
        run: async (context) => {
          if (!ai.enabled) {
            return { status: "skipped", detail: "ai disabled" };
          }
          if (!ai.assistantChannelId) {
            return { status: "skipped", detail: "no assistant channel configured" };
          }
          const channel = await context.setuper.findChannelById(ai.assistantChannelId);
          return channel
            ? { status: "reused", resourceId: channel.id }
            : { status: "skipped", detail: "configured channel no longer exists" };
        },
      },
    ];
  },
};
