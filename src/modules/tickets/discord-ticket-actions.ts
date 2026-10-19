/**
 * discord.js implementation of `GuildTicketActions`.
 *
 * The only file in the ticket module that knows about discord.js, and deliberately
 * thin: one method maps to a small number of API calls and normalizes the outcome into
 * `{ ok, detail }` rather than throwing, because "the member left mid-conversation" is
 * an ordinary outcome and must not look like a bug.
 *
 * The permission overwrites are the reason this file is reviewed carefully rather than
 * written quickly. A ticket channel must be visible to exactly three audiences — the
 * opener, the category's staff roles, and the bot — and everyone else must be denied
 * `ViewChannel` explicitly rather than by omission, since a category's own permissions
 * would otherwise let the whole server read a private report.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type TextChannel,
} from "discord.js";

import type {
  GuildTicketActions,
  TicketActionResultOutcome,
  TranscriptMessageInput,
} from "./ticket.service.js";
import type { PanelButton, PanelRow } from "./ticket-panel.js";

/** Overwrite set for a freshly created ticket channel. */
interface TicketOverwrites {
  readonly openerId: string;
  readonly staffRoleIds: readonly string[];
  readonly parentId: string | null;
}

export class DiscordTicketActions implements GuildTicketActions {
  private readonly guild: Guild;

  public constructor(guild: Guild) {
    this.guild = guild;
  }

  public async createChannel(input: {
    name: string;
    parentId: string | null;
    openerId: string;
    staffRoleIds: readonly string[];
    topic: string;
  }): Promise<{ ok: boolean; channelId?: string; detail?: string }> {
    try {
      const overwrites = buildOverwrites(this.guild, {
        openerId: input.openerId,
        staffRoleIds: input.staffRoleIds,
        parentId: input.parentId,
      });

      const channel = await this.guild.channels.create({
        name: input.name,
        type: ChannelType.GuildText,
        topic: input.topic.slice(0, 1_024),
        ...(input.parentId === null ? {} : { parent: input.parentId }),
        permissionOverwrites: overwrites,
        reason: `Ticket opened by ${input.openerId}`,
      });
      return { ok: true, channelId: channel.id };
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }
  }

  public async sendMessage(
    channelId: string,
    content: {
      content?: string;
      embeds?: readonly unknown[];
      components?: readonly PanelRow[];
    },
    files?: readonly { name: string; attachment: Buffer }[],
  ): Promise<{ ok: boolean; messageId?: string; detail?: string }> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) {
      return { ok: false, detail: "that channel is gone" };
    }

    try {
      const message = await channel.send({
        ...(content.content === undefined ? {} : { content: content.content }),
        ...(content.embeds === undefined ? {} : { embeds: content.embeds as never }),
        ...(content.components === undefined
          ? {}
          : { components: content.components.map(toActionRow) }),
        ...(files === undefined ? {} : { files: files.map((file) => ({ ...file })) }),
      });
      return { ok: true, messageId: message.id };
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }
  }

  public async renameChannel(
    channelId: string,
    name: string,
    reason: string,
  ): Promise<TicketActionResultOutcome> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) {
      return { ok: false, detail: "that channel is gone" };
    }
    try {
      await channel.setName(name.slice(0, 100), reason);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }
  }

  public async archiveChannel(
    channelId: string,
    reason: string,
  ): Promise<TicketActionResultOutcome> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) {
      // Already gone is a success: the goal state ("this channel is closed") holds.
      return { ok: true };
    }
    try {
      // Locked rather than deleted. The channel is the conversation's context and
      // deleting it would remove a staff member's ability to re-read what was said
      // before the transcript was taken; a human can delete it later once satisfied.
      await channel.permissionOverwrites.edit(
        channel.guild.roles.everyone,
        { SendMessages: false },
        { reason },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }
  }

  public async deleteChannel(
    channelId: string,
    reason: string,
  ): Promise<TicketActionResultOutcome> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) {
      return { ok: true };
    }
    try {
      await channel.delete(reason);
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }
  }

  /**
   * Reads a channel's recent history as transcript messages.
   *
   * Paginated by message id rather than by offset, because a busy ticket can gain
   * messages while the transcript is being taken and an offset would then skip or
   * duplicate them. The cap is deliberate: a transcript is evidence, and an unbounded
   * read of a ten-year-old channel is a way to hold the process open indefinitely.
   */
  public async fetchHistory(
    channelId: string,
    limit: number,
  ): Promise<{ ok: boolean; messages?: readonly TranscriptMessageInput[]; detail?: string }> {
    const channel = await this.fetchTextChannel(channelId);
    if (!channel) {
      return { ok: false, detail: "that channel is gone" };
    }

    const collected: TranscriptMessageInput[] = [];
    let before: string | undefined;

    try {
      while (collected.length < limit) {
        const page = await channel.messages.fetch({
          limit: Math.min(100, limit - collected.length),
          ...(before === undefined ? {} : { before }),
        });
        if (page.size === 0) {
          break;
        }
        for (const message of page.values()) {
          collected.push({
            authorId: message.author.id,
            authorName: message.member?.displayName ?? message.author.username,
            authorIsBot: message.author.bot,
            content: message.content,
            createdAt: message.createdAt,
            attachments: [...message.attachments.values()].map((item) => item.name ?? "file"),
          });
        }
        // `fetch` yields newest-first; the oldest id in the page is the next cursor.
        const oldest = [...page.values()].reduce<string | undefined>(
          (acc, message) =>
            acc === undefined || BigInt(message.id) < BigInt(acc) ? message.id : acc,
          undefined,
        );
        if (oldest === undefined || oldest === before) {
          break;
        }
        before = oldest;
      }
    } catch (error) {
      return { ok: false, detail: describeChannelError(error) };
    }

    // Rendered oldest-first, which is how a conversation is read.
    collected.reverse();
    return { ok: true, messages: collected };
  }

  private async fetchTextChannel(channelId: string): Promise<TextChannel | null> {
    // The `type` check is what narrows the cached union to `TextChannel`, so no cast is
    // needed here — and an explicit cast would hide a future case where the narrowing
    // stops working.
    const cached = this.guild.channels.cache.get(channelId);
    if (cached && cached.type === ChannelType.GuildText) {
      return cached;
    }
    try {
      const fetched = await this.guild.channels.fetch(channelId);
      return fetched && fetched.type === ChannelType.GuildText ? fetched : null;
    } catch {
      return null;
    }
  }
}

/**
 * @returns the discord.js `ActionRowBuilder` for one `PanelRow` descriptor.
 *
 * The ticket service and panel builder are deliberately free of discord.js — they emit
 * plain `{ buttons: [...] }` descriptors that this adapter, the only discord.js-aware
 * file, turns into real components. Reused for the ticket panel and the per-ticket
 * controls, so the two can never disagree about what a button means.
 */
function toActionRow(row: PanelRow): ActionRowBuilder<ButtonBuilder> {
  const builder = new ActionRowBuilder<ButtonBuilder>();
  builder.addComponents(row.buttons.map(toButton));
  return builder;
}

/** @returns the discord.js button for one `PanelButton` descriptor. */
function toButton(button: PanelButton): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(button.customId)
    .setLabel(button.label)
    .setStyle(STYLE_OF[button.style])
    .setDisabled(button.disabled ?? false);
}

/** Maps the panel's style names onto discord.js `ButtonStyle` values. */
const STYLE_OF: Record<PanelButton["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/**
 * @returns the permission overwrites for a new ticket channel.
 *
 * `@everyone` is denied `ViewChannel` explicitly. Relying on the parent category's
 * permissions would make a ticket readable by anyone who can see the category — which
 * is the entire server on a default setup, and exactly the wrong behaviour for a
 * private report about another member.
 *
 * The bot's own overwrite is included because denying `@everyone` also denies the bot:
 * without it the bot could create a channel it cannot then read, post to or transcribe.
 */
function buildOverwrites(
  guild: Guild,
  input: TicketOverwrites,
): { id: string; allow: bigint[]; deny: bigint[] }[] {
  const overwrites: { id: string; allow: bigint[]; deny: bigint[] }[] = [
    {
      id: guild.roles.everyone.id,
      allow: [],
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: input.openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
      deny: [],
    },
    {
      // The bot must be able to see and write in the channel it just created.
      id: guild.members.me?.id ?? guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
      deny: [],
    },
  ];

  for (const roleId of input.staffRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
      deny: [],
    });
  }

  return overwrites;
}

/**
 * @returns a short, user-safe reason for a failed channel operation.
 *
 * The distinction that matters is permissions versus everything else: "the bot cannot
 * manage channels" is actionable by an admin, while a generic failure sends them
 * looking in the wrong place.
 */
function describeChannelError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === 50_013) {
    return "I do not have permission to manage that channel";
  }
  if (code === 10_003) {
    return "that channel is gone";
  }
  if (error instanceof PermissionsBitField) {
    return "I am missing permissions to do that";
  }
  return "Discord refused the request";
}

/** Re-exported so the service can name the port's shape without importing discord.js. */
export type { TranscriptMessageInput };
