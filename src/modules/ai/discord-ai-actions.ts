/**
 * Discord-backed implementation of `AiToolActionsPort`.
 *
 * This is the only file that knows about discord.js for the AI *tool* layer, and
 * it is deliberately thin: each method maps to one service or one API call. Role
 * and member mutations route through the existing `DiscordRoleActions` /
 * `DiscordMemberActions` / `ModerationService` adapters, so the AI tool effects
 * pass the same hierarchy and audit guards a human command does — the invariant
 * that "the AI never does anything a human moderator could not" is structural.
 *
 * Channel/category/thread reads and mutations and message writes reach the `Guild`
 * directly for the narrow operations the core services do not expose (create / edit
 * / delete a channel, category or thread, send a message, read recent messages);
 * everything else stays behind an adapter. The AI is thereby able to do whatever a
 * human moderator with the same permissions could — no more, no less.
 */
import {
  ChannelType,
  type Guild,
  type PermissionOverwriteOptions,
  type PermissionsString,
  type TextChannel,
} from "discord.js";

import type { AiChannelSummary, AiTicketActionsPort, AiToolActionsPort } from "./ai.module.js";
import { DiscordRoleActions } from "../roles/discord-role-actions.js";
import { DiscordMemberActions } from "../moderation/discord-member-actions.js";
import type { ModerationService } from "../moderation/moderation.service.js";

/**
 * The permission names the AI may set on a channel overwrite.
 *
 * A fixed allow-list rather than a lookup over every Discord flag: an overwrite is
 * a privileged write, and `Administrator` (or role/webhook management) is exactly
 * what a prompt-injected model reaches for. A name outside the list is refused with
 * the allowed names spelled out, so the model can correct itself in one turn
 * instead of guessing twice.
 */
const OVERWRITE_PERMISSION_NAMES = [
  "ViewChannel",
  "SendMessages",
  "SendMessagesInThreads",
  "CreatePublicThreads",
  "CreatePrivateThreads",
  "ReadMessageHistory",
  "ManageMessages",
  "AddReactions",
  "AttachFiles",
  "EmbedLinks",
  "MentionEveryone",
  "UseExternalEmojis",
  "Connect",
  "Speak",
  "Stream",
  "UseVAD",
  "ManageWebhooks",
  "ManageChannels",
] as const satisfies readonly PermissionsString[];

type OverwritePermissionName = (typeof OVERWRITE_PERMISSION_NAMES)[number];

/** Resolves permission names to the overwrite options discord.js expects. */
function resolveOverwrite(
  names: readonly string[],
  value: boolean,
):
  | { ok: true; entries: Partial<Record<OverwritePermissionName, boolean>> }
  | { ok: false; detail: string } {
  const entries: Partial<Record<OverwritePermissionName, boolean>> = {};
  for (const name of names) {
    const permission = OVERWRITE_PERMISSION_NAMES.find(
      (candidate) => candidate.toLowerCase() === name.trim().toLowerCase(),
    );
    if (permission === undefined) {
      return {
        ok: false,
        detail: `unknown permission "${name}" — the permissions I may set are: ${OVERWRITE_PERMISSION_NAMES.join(", ")}`,
      };
    }
    entries[permission] = value;
  }
  return { ok: true, entries };
}

/** @returns the coarse channel kind the AI reports, instead of a raw enum number. */
function channelKind(channel: {
  readonly type: ChannelType;
  isThread(): boolean;
  isTextBased(): boolean;
}): string {
  if (channel.isThread()) {
    return "thread";
  }
  if (channel.type === ChannelType.GuildCategory) {
    return "category";
  }
  if (channel.type === ChannelType.GuildVoice) {
    return "voice";
  }
  if (channel.type === ChannelType.GuildStageVoice) {
    return "stage";
  }
  if (channel.type === ChannelType.GuildForum) {
    return "forum";
  }
  return channel.isTextBased() ? "text" : "other";
}

/** Maps a tool-level channel kind to the discord.js `ChannelType`. */
function channelType(
  kind: "text" | "voice" | "category",
): ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildCategory {
  if (kind === "voice") {
    return ChannelType.GuildVoice;
  }
  if (kind === "category") {
    return ChannelType.GuildCategory;
  }
  return ChannelType.GuildText;
}

/** Normalizes a discord.js mutation error into a plain detail string. */
function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export class DiscordAiActions implements AiToolActionsPort {
  private readonly guild: Guild;
  private readonly roles: DiscordRoleActions;
  private readonly members: DiscordMemberActions;
  private readonly moderation: ModerationService;
  /**
   * Ticket operations, when the process wired the ticket module.
   *
   * Optional by construction: the adapter never reaches for a ticket service it was
   * not handed, and the ticket tools refuse with a clear reason instead.
   */
  public readonly tickets?: AiTicketActionsPort;

  public constructor(guild: Guild, moderation: ModerationService, tickets?: AiTicketActionsPort) {
    this.guild = guild;
    this.roles = new DiscordRoleActions(guild);
    this.members = new DiscordMemberActions(guild);
    this.moderation = moderation;
    if (tickets) {
      this.tickets = tickets;
    }
  }

  public listChannels(): Promise<readonly AiChannelSummary[]> {
    return Promise.resolve(
      [...this.guild.channels.cache.values()].map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channelKind(channel),
        parentId: channel.parentId,
      })),
    );
  }

  public async setChannelPermissions(
    channelId: string,
    roleId: string,
    changes: { allow?: readonly string[]; deny?: readonly string[] },
  ): Promise<{ ok: boolean; detail?: string }> {
    const channel = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { ok: false, detail: "that channel does not exist" };
    }
    if (!("permissionOverwrites" in channel)) {
      return { ok: false, detail: "that channel does not support permission overwrites" };
    }

    const allowed = resolveOverwrite(changes.allow ?? [], true);
    if (!allowed.ok) {
      return { ok: false, detail: allowed.detail };
    }
    const denied = resolveOverwrite(changes.deny ?? [], false);
    if (!denied.ok) {
      return { ok: false, detail: denied.detail };
    }

    try {
      const options: PermissionOverwriteOptions = { ...allowed.entries, ...denied.entries };
      await channel.permissionOverwrites.edit(roleId, options, { reason: "AI agent" });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the permission change") };
    }
  }

  public async purgeMessages(
    channelId: string,
    count: number,
    authorId?: string,
  ): Promise<{ ok: boolean; purged: number; detail?: string }> {
    const channel = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { ok: false, purged: 0, detail: "that channel does not exist" };
    }
    if (!channel.isTextBased() || channel.isDMBased()) {
      return { ok: false, purged: 0, detail: "that channel is not a server text channel" };
    }
    // The purge goes through `ModerationService`, the same count-bounded,
    // author-filterable, case-recording path `/purge` uses, so an AI purge cannot
    // remove more than a human could or escape the audit trail.
    try {
      const outcome = await this.moderation.execute(this.guild.id, {
        action: "purge",
        actor: { id: "system:ai", kind: "system", tag: "ai" },
        target: { type: "channel", id: channel.id, name: channel.name },
        reason: "AI agent",
        count,
        authorId: authorId ?? null,
        source: "ai",
      });
      return { ok: true, purged: outcome.purgedCount ?? 0 };
    } catch (error) {
      return {
        ok: false,
        purged: 0,
        detail: error instanceof Error ? error.message : "moderation refused the purge",
      };
    }
  }

  public listRoles(): Promise<readonly { id: string; name: string; position: number }[]> {
    return Promise.resolve(
      [...this.guild.roles.cache.values()].map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
      })),
    );
  }

  public findRoleByName(name: string): Promise<{ id: string; name: string } | null> {
    const needle = name.trim().toLowerCase();
    const role = this.guild.roles.cache.find(
      (candidate) => candidate.name.toLowerCase() === needle || candidate.id === name,
    );
    return Promise.resolve(role ? { id: role.id, name: role.name } : null);
  }

  public async createRole(name: string): Promise<{ id: string; name: string }> {
    const role = await this.guild.roles.create({ name });
    return { id: role.id, name: role.name };
  }

  public async setMemberRole(
    userId: string,
    roleId: string,
    present: boolean,
  ): Promise<{ ok: boolean; detail?: string }> {
    return this.roles.setRole(userId, roleId, present, "AI agent");
  }

  public async createChannel(
    name: string,
    options: {
      type?: "text" | "voice" | "category";
      topic?: string;
      parentId?: string;
      nsfw?: boolean;
    } = {},
  ): Promise<{ id: string; name: string }> {
    const channel = await this.guild.channels.create({
      name,
      type: channelType(options.type ?? "text"),
      ...(options.topic === undefined ? {} : { topic: options.topic }),
      ...(options.parentId === undefined ? {} : { parent: options.parentId }),
      ...(options.nsfw === undefined ? {} : { nsfw: options.nsfw }),
    });
    return { id: channel.id, name: channel.name };
  }

  public findChannelByName(
    name: string,
    kind?: "category" | "non-category",
  ): Promise<{ id: string; name: string } | null> {
    const needle = name.trim().toLowerCase();
    const channel = this.guild.channels.cache.find((candidate) => {
      const named = candidate.name.toLowerCase() === needle || candidate.id === name;
      if (!named) {
        return false;
      }
      const isCategory = candidate.type === ChannelType.GuildCategory;
      if (kind === "category") {
        return isCategory;
      }
      if (kind === "non-category") {
        return !isCategory;
      }
      // Default: text-based, non-DM channels only (matches the historical lookup).
      return candidate.isTextBased() && !candidate.isDMBased();
    });
    return Promise.resolve(channel ? { id: channel.id, name: channel.name } : null);
  }

  public findThreadByName(name: string): Promise<{ id: string; name: string } | null> {
    const needle = name.trim().toLowerCase();
    const threads = this.guild.channels.cache
      .filter((channel) => channel.isThread())
      .map((thread) => ({ id: thread.id, name: thread.name }));
    const match = threads.find((thread) => thread.name.toLowerCase() === needle);
    return Promise.resolve(match ?? null);
  }

  public async editChannel(
    channelId: string,
    changes: {
      name?: string;
      topic?: string;
      nsfw?: boolean;
      slowmodeSeconds?: number;
      parentId?: string | null;
    },
  ): Promise<{ ok: boolean; detail?: string }> {
    const channel = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { ok: false, detail: "that channel does not exist" };
    }
    try {
      await channel.edit({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.parentId === undefined ? {} : { parent: changes.parentId }),
        ...(changes.topic === undefined ? {} : { topic: changes.topic }),
        ...(changes.nsfw === undefined ? {} : { nsfw: changes.nsfw }),
        ...(changes.slowmodeSeconds === undefined
          ? {}
          : { rateLimitPerUser: changes.slowmodeSeconds }),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the change") };
    }
  }

  public async deleteChannel(channelId: string): Promise<{ ok: boolean; detail?: string }> {
    const channel = await this.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { ok: false, detail: "that channel does not exist" };
    }
    try {
      await channel.delete("AI agent");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the deletion") };
    }
  }

  public async editRole(
    roleId: string,
    changes: { name?: string; color?: string },
  ): Promise<{ ok: boolean; detail?: string }> {
    const role = await this.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      return { ok: false, detail: "that role does not exist" };
    }
    try {
      await role.edit({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.color === undefined ? {} : { color: changes.color as `#${string}` }),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the change") };
    }
  }

  public async deleteRole(roleId: string): Promise<{ ok: boolean; detail?: string }> {
    const role = await this.guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      return { ok: false, detail: "that role does not exist" };
    }
    // A managed role (bot/integration/booster) cannot be deleted by hand; Discord
    // rejects it, but we refuse up front for a clear reason.
    if (role.managed) {
      return { ok: false, detail: "that role is managed by an integration and cannot be deleted" };
    }
    try {
      await role.delete("AI agent");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the deletion") };
    }
  }

  public async createThread(
    channelId: string,
    name: string,
    privateThread = false,
  ): Promise<{ id: string; name: string }> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("threads" in channel)) {
      throw new Error("channel not found or cannot hold threads");
    }
    const thread = await (channel as TextChannel).threads.create({
      name,
      type: privateThread ? ChannelType.PrivateThread : ChannelType.PublicThread,
    });
    return { id: thread.id, name: thread.name };
  }

  public async editThread(
    threadId: string,
    changes: { name?: string; archived?: boolean; locked?: boolean },
  ): Promise<{ ok: boolean; detail?: string }> {
    const thread = await this.guild.channels.fetch(threadId).catch(() => null);
    if (!thread || !thread.isThread()) {
      return { ok: false, detail: "that thread does not exist" };
    }
    try {
      await thread.edit({
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.archived === undefined ? {} : { archived: changes.archived }),
        ...(changes.locked === undefined ? {} : { locked: changes.locked }),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the change") };
    }
  }

  public async deleteThread(threadId: string): Promise<{ ok: boolean; detail?: string }> {
    const thread = await this.guild.channels.fetch(threadId).catch(() => null);
    if (!thread || !thread.isThread()) {
      return { ok: false, detail: "that thread does not exist" };
    }
    try {
      await thread.delete("AI agent");
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describe(error, "Discord refused the deletion") };
    }
  }

  public async sendMessage(channelId: string, content: string): Promise<{ id: string }> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error("channel not found or not a text channel");
    }
    const message = await (channel as TextChannel).send(content);
    return { id: message.id };
  }

  public async readMessages(
    channelId: string,
    limit: number,
  ): Promise<readonly { authorTag: string; content: string }[]> {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return [];
    }
    const messages = await channel.messages.fetch({ limit: Math.min(limit, 100) });
    return [...messages.values()]
      .filter((message) => message.content.length > 0)
      .map((message) => ({ authorTag: message.author.tag, content: message.content }));
  }

  public async moderate(
    action: string,
    targetId: string,
    reason: string | null,
  ): Promise<{ ok: boolean; detail?: string }> {
    // Sensitive actions go through `ModerationService.execute`, the same guarded
    // pipeline a human command uses. A refusal (hierarchy, missing reason, disabled
    // module) is a thrown ValidationError, which the registry turns into a clean
    // refusal — never a raw Discord call.
    const target = await this.members.readTarget(this.guild.id, targetId);
    if (!target) {
      return {
        ok: false,
        detail: `I could not find a member with id ${targetId} in this server, so there is nobody to ${action}. Check the id, or mention the member directly — someone who already left the server cannot be acted on.`,
      };
    }
    try {
      await this.moderation.execute(this.guild.id, {
        action: action as never,
        actor: { id: "system:ai", kind: "system", tag: "ai" },
        target,
        reason: reason ?? "AI agent",
        source: "ai",
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "moderation refused" };
    }
  }
}
