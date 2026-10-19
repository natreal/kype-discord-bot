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
import { hasGodAccess } from "../../services/permissions/index.js";
import type { AuthorizationService, Permission } from "../../services/authorization/index.js";
import type { Logger } from "../../services/logger/index.js";

/** A single capability the AI is allowed to request. */
export interface AiTool<TInput = unknown, TOutput = unknown> {
  /** Unique tool name, e.g. `summarize_channel`. */
  readonly name: string;
  /** Human-readable description surfaced to the model. */
  readonly description: string;
  /**
   * Arbitrary-free grouping used by `buildToolMenu` to gate a tool by mode.
   * See `AI_TOOL_CATEGORIES` in `tool-menu.js` — the value must be one of those
   * keys, never a free-form string, so a typo is a visible menu bug instead of a
   * silently-unavailable tool.
   */
  readonly category: AiToolCategory;
  /**
   * Discord permission bits the *bot* must hold for the tool to do anything.
   * Checked first, because a tool the bot physically cannot perform must fail
   * with "I can't do that" rather than a Discord error surfaced to the user.
   */
  readonly requiredBotPermissions?: readonly string[];
  /**
   * Granular permissions the *author* must hold (`ai.use` plus the business
   * permission, e.g. `moderation.ban`). The registry enforces these before any
   * tool runs, so the AI can never act as a more privileged user than the human
   * who invoked it.
   */
  readonly requiredGranularPermissions?: readonly Permission[];
  /**
   * JSON Schema for the tool's arguments, advertised to the model so it sends
   * named fields instead of guessing. Omitted tools fall back to a permissive
   * object schema (`additionalProperties: true`).
   */
  readonly parameters?: Record<string, unknown>;
  /** Validates and normalizes the model-provided input. */
  validate(input: unknown): TInput;
  /** Executes the effect. Must be side-effect scoped and auditable. */
  execute(input: TInput, context: AiToolContext): Promise<TOutput>;
}

/** The tool category vocabulary (mirrors the menu categories). */
export type AiToolCategory =
  | "roles"
  | "channels"
  | "messages"
  | "summary"
  | "history"
  | "moderation"
  | "memory"
  | "recommendation"
  | "permissions"
  | "threads"
  | "tickets"
  | "webhooks"
  | "categories"
  | "destructive";

/** Everything a tool is allowed to know about the invocation. */
export interface AiToolContext {
  readonly guildId: string;
  readonly invoker: GuildMember;
  readonly permissions: PermissionService;
  /**
   * Central authorization layer, used for the tool's granular permissions.
   *
   * Optional so a minimal test harness still compiles; when absent, the tool
   * gate falls back to the legacy permission service, which *fails closed* for
   * granular permissions rather than silently allowing them.
   */
  readonly authorization?: AuthorizationService;
  readonly logger: Logger;
  /** Guild-bound collaborators, injected per invocation. */
  readonly roles?: unknown;
  readonly moderation?: unknown;
  readonly actions: AiToolActionsPort;
}

/**
 * Discord-side operations AI tools may reach, all behind a narrow port.
 *
 * The agent never receives a `Guild`/`Client`/`REST` instance: every effect goes
 * through a service (`RoleService`, `ModerationService`) or this port, so the
 * "no raw discord.js in a service" rule is structural. Tests substitute a fake.
 */
export interface AiToolActionsPort {
  /** @returns the role names/ids in the guild, for listing. */
  listRoles(): Promise<readonly { id: string; name: string; position: number }[]>;
  /**
   * Creates a channel of the requested kind and returns its id/name. `type`
   * distinguishes a text channel, a voice channel and a category, so the agent
   * can build a whole structure, not just text channels.
   */
  createChannel(
    name: string,
    options?: {
      type?: "text" | "voice" | "category";
      topic?: string;
      parentId?: string;
      nsfw?: boolean;
    },
  ): Promise<{ id: string; name: string }>;
  /** Resolves an existing channel by name (case-insensitive), or `null`. */
  findChannelByName(
    name: string,
    kind?: "category" | "non-category",
  ): Promise<{ id: string; name: string } | null>;
  /**
   * Edits a channel: rename it, set its topic, toggle NSFW or set slow-mode, or
   * move it under a category. Only the provided fields change.
   */
  editChannel(
    channelId: string,
    changes: {
      name?: string;
      topic?: string;
      nsfw?: boolean;
      slowmodeSeconds?: number;
      parentId?: string | null;
    },
  ): Promise<{ ok: boolean; detail?: string }>;
  /** Deletes a channel by id. Returns `{ ok, detail }`; never a partial effect. */
  deleteChannel(channelId: string): Promise<{ ok: boolean; detail?: string }>;
  /** Sends a message to a channel; returns its id. */
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  /** Reads up to `limit` recent messages from a channel. */
  readMessages(
    channelId: string,
    limit: number,
  ): Promise<readonly { authorTag: string; content: string }[]>;
  /** Resolves an existing role by name (case-insensitive), or `null`. */
  findRoleByName(name: string): Promise<{ id: string; name: string } | null>;
  /** Creates a role and returns its id/name. */
  createRole(name: string): Promise<{ id: string; name: string }>;
  /** Renames a role and/or recolours it. Only the provided fields change. */
  editRole(
    roleId: string,
    changes: { name?: string; color?: string },
  ): Promise<{ ok: boolean; detail?: string }>;
  /** Deletes a role by id. `{ ok, detail }`; never a partial effect. */
  deleteRole(roleId: string): Promise<{ ok: boolean; detail?: string }>;
  /** Assigns (or removes) a role on a member. */
  setMemberRole(
    userId: string,
    roleId: string,
    present: boolean,
  ): Promise<{ ok: boolean; detail?: string }>;
  /** Creates a thread off a channel (or message) and returns its id/name. */
  createThread(
    channelId: string,
    name: string,
    privateThread?: boolean,
  ): Promise<{ id: string; name: string }>;
  /** Edits a thread: rename it, archive/lock it, or the reverse. */
  editThread(
    threadId: string,
    changes: { name?: string; archived?: boolean; locked?: boolean },
  ): Promise<{ ok: boolean; detail?: string }>;
  /** Deletes a thread by id. `{ ok, detail }`; never a partial effect. */
  deleteThread(threadId: string): Promise<{ ok: boolean; detail?: string }>;
  /** Resolves an active/public thread by name (case-insensitive), or `null`. */
  findThreadByName(name: string): Promise<{ id: string; name: string } | null>;
  /**
   * Dispatches a moderation action through `ModerationService` (the same path a
   * human uses). Returns `{ ok, detail }`; never a partial or ad-hoc effect.
   */
  moderate(
    action: string,
    targetId: string,
    reason: string | null,
  ): Promise<{ ok: boolean; detail?: string }>;
  /** Searches/recently-read history is provided by the memory/history service. */
  searchHistory?(query: {
    channelId?: string;
    targetId?: string;
    limit?: number;
  }): Promise<readonly { authorTag: string; content: string }[]>;
  /**
   * @returns every channel in the guild, with the kind and parent the agent needs
   * to answer "what channels do we have?" without guessing from a name.
   */
  listChannels(): Promise<readonly AiChannelSummary[]>;
  /**
   * Applies a permission overwrite for one role on one channel.
   *
   * Names are the human permission names (`"ViewChannel"`, `"SendMessages"`), not
   * raw bitfields: the adapter resolves them against a fixed allow-list, so a model
   * cannot grant itself or a role an arbitrary bit (see `DiscordAiActions`).
   */
  setChannelPermissions(
    channelId: string,
    roleId: string,
    changes: { allow?: readonly string[]; deny?: readonly string[] },
  ): Promise<{ ok: boolean; detail?: string }>;
  /**
   * Bulk-deletes up to `count` recent messages in a channel, optionally limited to
   * one author, and reports how many were actually removed.
   *
   * Deliberately *not* routed through {@link AiToolActionsPort.moderate}: a purge
   * targets a channel, not a member, and the two must not share a target shape.
   */
  purgeMessages(
    channelId: string,
    count: number,
    authorId?: string,
  ): Promise<{ ok: boolean; purged: number; detail?: string }>;
  /**
   * Ticket operations, present only where the ticket module is wired.
   *
   * Optional so a process (or a test harness) without tickets compiles, and the
   * ticket tools refuse clearly when it is absent rather than reaching for a
   * singleton.
   */
  readonly tickets?: AiTicketActionsPort;
}

/** One channel, as the AI tools need to describe it. */
export interface AiChannelSummary {
  readonly id: string;
  readonly name: string;
  /** `text`, `voice`, `category`, `thread`, `forum`, `stage` or `other`. */
  readonly type: string;
  /** The parent category id, or `null` for a top-level channel. */
  readonly parentId: string | null;
}

/** One ticket, as the AI tools need to describe it. */
export interface AiTicketSummary {
  readonly id: string;
  readonly number: number;
  readonly status: string;
  readonly subject: string | null;
  readonly channelId: string;
  readonly claimedById: string | null;
}

/** Result of one ticket mutation the agent asked for. */
export interface AiTicketActionResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * The ticket operations the AI may reach.
 *
 * Every method maps onto `TicketService`, so the one-open-ticket rule, the claim
 * race, the transcript capture and the audit trail are the same ones a human
 * clicking the buttons gets — the agent never re-implements a ticket rule.
 */
export interface AiTicketActionsPort {
  /** @returns the guild's tickets, newest first. */
  list(query?: { status?: string; limit?: number }): Promise<readonly AiTicketSummary[]>;
  /** Assigns a ticket to `actorId`. */
  claim(ticketId: string, actorId: string): Promise<AiTicketActionResult>;
  /** Stores the transcript and locks the channel. */
  close(ticketId: string, actorId: string, reason: string): Promise<AiTicketActionResult>;
  /** Stores the transcript, deletes the channel and marks the record deleted. */
  remove(ticketId: string, actorId: string): Promise<AiTicketActionResult>;
  /** @returns the stored transcript's size, or why there is none. */
  transcript(ticketId: string): Promise<{ ok: boolean; detail?: string; messageCount?: number }>;
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

  /** @returns the registered tools with their static metadata (for menus). */
  public all(): readonly AiTool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  public get(name: string): AiTool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  /**
   * Validates, authorizes, executes and logs a tool invocation.
   *
   * Authorization is deterministic and happens *before* execution in two steps:
   * first the author's granular permissions (`ai.use` + the business permission),
   * then the bot's Discord permissions. A failing check returns `{ ok: false }`
   * with a clear reason, never a partial execution — so a tool that the human (or
   * the bot) cannot perform refuses outright rather than doing half its work.
   */
  public async invoke<TInput, TOutput>(
    name: string,
    input: unknown,
    context: AiToolContext,
  ): Promise<AiToolResult<TOutput>> {
    const tool = this.tools.get(name) as AiTool<TInput, TOutput> | undefined;
    if (!tool) {
      return { ok: false, reason: `Unknown AI tool: ${name}` };
    }

    const authz = await this.authorize(tool, context);
    if (!authz.ok) {
      this.logger.warn("AI tool refused by authorization", {
        tool: name,
        guildId: context.guildId,
        reason: authz.reason,
      });
      return { ok: false, reason: authz.reason };
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

  /**
   * Resolves the permission gate for a tool.
   *
   * God Access is absolute and precedes everything: the compiled-in owner account
   * may make the AI do anything, regardless of the Discord roles or permissions it
   * holds — it may even hold zero roles. Every other caller must pass the same
   * check a human running the command would: `ai.use` plus each granular
   * permission the tool declares, resolved through the guild's role → class
   * mapping by the authorization layer.
   *
   * This gate used to ask `PermissionService` instead, which ignored granular
   * permissions entirely: any member able to trigger the agent could make it run
   * `moderation.ban`/`server.settings` tools. It is now asynchronous by design —
   * resolving classes requires a guild-scoped store read.
   */
  private async authorize(
    tool: AiTool<unknown, unknown>,
    context: AiToolContext,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // The owner account is never refused. This is a deliberate, behavior-affecting
    // rule: the operator can direct the assistant freely even in a guild where they
    // hold no roles at all.
    if (hasGodAccess(context.invoker.id)) {
      this.logger.warn("AI tool authorized by God Access", {
        tool: tool.name,
        guildId: context.guildId,
        userId: context.invoker.id,
      });
      return { ok: true };
    }

    const granular = tool.requiredGranularPermissions ?? [];
    const required: Permission[] = ["ai.use", ...granular];

    if (context.authorization) {
      const decision = await context.authorization.authorize(
        context.invoker,
        { custom: required },
        `ai.tool:${tool.name}`,
      );
      if (!decision.allowed) {
        return {
          ok: false,
          reason: this.memberRefusal(
            tool,
            decision.missing.length > 0 ? decision.missing : required,
          ),
        };
      }
      return { ok: true };
    }

    // Harnesses without the authorization layer: the legacy service fails closed
    // on granular permissions, so this can never become a silent allow.
    const check = context.permissions.check(context.invoker, {
      custom: required,
    });
    if (!check.allowed) {
      return {
        ok: false,
        reason: this.memberRefusal(tool, check.missing.length > 0 ? check.missing : required),
      };
    }
    return { ok: true };
  }

  /**
   * Builds the refusal text for a *member* authorization failure.
   *
   * The wording is deliberately explicit about who is missing the permission.
   * The agent hands this string to the model, and the previous phrasing —
   * "you don't have the required permission (…)" — was paraphrased back to the
   * member as "the bot lacks `ai.use`", which is false and suggests a bot
   * misconfiguration instead of the member's actual authorization gap.
   *
   * It also states that the check runs before the arguments are read, so the
   * model does not ask for a different member id or role name as if that could
   * unblock the call: authorization fails first, every time.
   */
  private memberRefusal(tool: AiTool<unknown, unknown>, missing: readonly string[]): string {
    const label = missing.length === 1 ? "permission" : "permissions";
    const list = missing.join(", ");
    return (
      `the member who asked (NOT the bot) lacks the ${label} required for "${tool.name}": ${list}. ` +
      "This is a member-authorization refusal, not a bot-permission problem, and it happens " +
      "before the tool's arguments are read: a different member id or target role name will not change " +
      `it. An administrator must grant ${list} to that member's role.`
    );
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
