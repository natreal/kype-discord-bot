/**
 * The keyword agent: bounded tool-calling loop.
 *
 * The agent is deliberately *not* the decision-maker about what may happen. It:
 *   1. resolves the trigger and menu for the guild,
 *   2. asks the model for its next tool call (or a plain answer),
 *   3. validates the arguments with Zod, checks permissions, executes through the
 *      registry (which re-checks authorisation), and writes an audit trail,
 *   4. feeds the result back and repeats, at most `MAX_TOOL_CALLS` times.
 *
 * Two rules are structural, not aspirational:
 * - a tool not in the menu is refused with "je ne peux pas faire ça dans ce mode",
 *   so the model can never improvise a capability the server did not enable;
 * - the loop is bounded, so a model that keeps calling tools cannot turn one
 *   message into an unbounded (and unbudgeted) session.
 */
import type { GuildMember } from "discord.js";

import type { Logger } from "../../services/logger/index.js";
import type { PermissionService } from "../../services/permissions/index.js";
import type { AuthorizationService } from "../../services/authorization/index.js";
import type { AuditEventService } from "../../services/audit/index.js";
import type { AiGateway } from "../../services/ai/ai.gateway.js";
import type {
  AiChatMessage,
  AiToolDeclaration,
} from "../../services/ai/openai-compatible.client.js";
import type { AiTool, AiToolActionsPort, AiToolContext } from "./ai.module.js";
import { AiToolRegistry } from "./ai.module.js";
import { buildToolMenu, type AiMode } from "./tool-menu.js";

/** Hard cap on tool calls per message, so an agent can never loop unboundedly. */
export const MAX_TOOL_CALLS = 5;

/** The input the agent reasons about. */
export interface AiAgentRequest {
  readonly guildId: string;
  readonly invoker: GuildMember;
  readonly content: string;
  readonly mode: AiMode;
  readonly enabledCategories: readonly string[];
  /** Resolved keyword that woke the agent (for the audit trail). */
  readonly trigger: string;
  /** The tool menu's source of truth (built by the caller or here). */
  readonly tools: readonly AiTool<unknown, unknown>[];
  /**
   * Optional persona/tone appended to the system prompt (the assistant's "voice").
   * Free-form by design: the operator owns the wording.
   */
  readonly persona?: string;
}

/** What the agent reports back to Discord, always reflecting reality. */
export interface AiAgentReport {
  readonly ok: boolean;
  readonly text: string;
}

export interface AiAgentOptions {
  readonly logger: Logger;
  readonly gateway: Pick<AiGateway, "complete">;
  readonly permissions: PermissionService;
  /**
   * Central authorization layer used to gate each tool call through the guild's
   * role → class mapping. Optional only for minimal harnesses; the tool gate
   * fails closed on granular permissions when it is absent.
   */
  readonly authorization?: AuthorizationService;
  readonly audit: AuditEventService;
  readonly actions: AiToolActionsPort;
  /** Optional tool-calling registry; defaults to a fresh (empty) one when absent. */
  readonly registry?: AiToolRegistry;
}

const SYSTEM_PROMPT = [
  "You are Kype, the Discord assistant for this server. Your name is Kype: if someone",
  "asks who or what you are, answer that you are Kype and never deny it.",
  "You may only act by selecting one of the provided tools; never invent a tool or an",
  "action. When asked to create, rename, edit or delete a channel, category, role,",
  "thread or ticket, or to moderate a member, actually call the matching tool rather",
  "than only describing what you would do. Keep replies SHORT — one or two sentences,",
  "no preamble, no filler, no restating the request. Be honest: never claim to have",
  "done something you did not, and if you are unsure, say so.",
  "When a tool refuses, relay the reason plainly and say what the caller can do next.",
  "A permission refusal is always about the member who sent the message, NEVER about you:",
  'say that they lack the permission (e.g. "tu n\'as pas la permission…"), never that you or',
  "the bot lack it, and never present the bot's own Discord permissions as the cause. Do not",
  "ask for another member id or other arguments as a workaround: authorization is checked",
  "before the arguments are read, so changing them cannot unblock the action. Explain that",
  "an administrator must grant the missing permission to that member's role. Only a result",
  "that says the BOT is missing a Discord permission, or a Discord rejection such as",
  '"Missing Permissions", is a bot-permission problem.',
  "If a tool cannot find a member, channel, role or ticket, name the exact value that",
  "did not match and suggest checking the spelling or id (or listing what exists)",
  "instead of a vague failure. Common cases: a member left the server (so there is",
  "nobody to moderate), an unknown channel/role name, or a name that matches nothing.",
  "If you are disrespected or insulted, you may clap back with attitude, but stay",
  "within Discord's rules — no slurs, no threats, no harassment.",
].join(" ");

export class AiAgentService {
  private readonly logger: Logger;
  private readonly gateway: Pick<AiGateway, "complete">;
  private readonly permissions: PermissionService;
  private readonly authorization: AuthorizationService | undefined;
  private readonly audit: AuditEventService;
  private readonly actions: AiToolActionsPort;
  private readonly registry: AiToolRegistry;

  public constructor(options: AiAgentOptions) {
    this.logger = options.logger.child("ai:agent");
    this.gateway = options.gateway;
    this.permissions = options.permissions;
    this.authorization = options.authorization;
    this.audit = options.audit;
    this.actions = options.actions;
    this.registry = options.registry ?? new AiToolRegistry(options.logger);
  }

  /** Builds an active menu from the full registry + guild mode. */
  public static menu(
    registry: AiToolRegistry,
    mode: AiMode,
    enabledCategories: readonly string[],
  ): readonly AiTool<unknown, unknown>[] {
    return buildToolMenu(registry.all(), mode, enabledCategories).tools;
  }

  /**
   * Runs the agent for one message. `request.tools` is the *active menu* (already
   * gated by mode); a tool the model names that is not in it is refused outright.
   */
  public async run(request: AiAgentRequest): Promise<AiAgentReport> {
    const toolDeclarations = request.tools.map(toToolDeclaration);
    const systemPrompt =
      request.persona && request.persona.trim().length > 0
        ? `${SYSTEM_PROMPT} Style/persona: ${request.persona.trim()}`
        : SYSTEM_PROMPT;
    const messages: AiChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: request.content },
    ];

    // When the menu is empty (a custom mode ticking nothing), the agent is inert
    // and says so rather than loading the model with a tool-free prompt it would
    // have to improvise through.
    if (request.tools.length === 0) {
      return { ok: true, text: "I can't do anything in this mode (no tools available)." };
    }

    for (let step = 0; step < MAX_TOOL_CALLS; step += 1) {
      const result = await this.gateway.complete({ messages, tools: toolDeclarations });

      if (!result.ok) {
        await this.auditRequest(request, false, result.detail);
        return { ok: false, text: `⛔ ${result.detail}` };
      }

      if (result.toolCalls.length === 0) {
        await this.auditRequest(request, true, result.text);
        return { ok: true, text: result.text || "I've got nothing to say." };
      }

      // Echo the assistant turn that requested the tools. Providers reject a
      // `tool` result whose matching assistant `tool_calls` message is missing.
      messages.push({
        role: "assistant",
        content: result.text ?? "",
        toolCalls: result.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });

      for (const call of result.toolCalls) {
        const tool = this.registry.get(call.name);
        const inMenu = request.tools.some((candidate) => candidate.name === call.name);

        if (!tool || !inMenu) {
          const refusal = `I can't do that in this mode (${call.name}).`;
          messages.push({ role: "tool", toolCallId: call.id, content: refusal });
          await this.auditTool(call.name, false, refusal);
          continue;
        }

        const context: AiToolContext = {
          guildId: request.guildId,
          invoker: request.invoker,
          permissions: this.permissions,
          ...(this.authorization ? { authorization: this.authorization } : {}),
          logger: this.logger,
          actions: this.actions,
        };

        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }

        const outcome = await this.registry.invoke<unknown, unknown>(call.name, args, context);
        const text = outcome.ok
          ? `✅ ${call.name}: ${JSON.stringify(outcome.output)}`
          : `⛔ Refused: ${outcome.reason ?? "failed"}`;
        messages.push({ role: "tool", toolCallId: call.id, content: text });
        await this.auditTool(call.name, outcome.ok, text);
      }
    }

    // Bounded loop exhausted: ask the model once more for a plain answer, then
    // stop — never extend the loop past the cap.
    const final = await this.gateway.complete({ messages, tools: toolDeclarations });
    if (final.ok && final.toolCalls.length === 0) {
      return { ok: true, text: final.text };
    }
    return { ok: true, text: "I hit the action limit for this message." };
  }

  private async auditRequest(request: AiAgentRequest, ok: boolean, text: string): Promise<void> {
    await this.audit.record({
      guildId: request.guildId,
      action: "ai.agent",
      category: "ai",
      severity: "info",
      actorId: request.invoker.id,
      actorKind: "user",
      targetType: "guildConfig",
      targetId: request.guildId,
      outcome: ok ? "success" : "failure",
      details: { trigger: request.trigger, mode: request.mode, reply: text.slice(0, 500) },
    });
  }

  private async auditTool(tool: string, ok: boolean, detail: string): Promise<void> {
    await this.audit.record({
      action: "ai.action",
      category: "ai",
      severity: ok ? "info" : "privileged",
      outcome: ok ? "success" : "denied",
      details: { tool, detail: detail.slice(0, 500) },
    });
  }
}

/** Converts a tool into the OpenAI tool-calling declaration shape. */
function toToolDeclaration(tool: AiTool<unknown, unknown>): AiToolDeclaration {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: true },
    },
  };
}
