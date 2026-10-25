/**
 * `/github` as discord.js builders.
 *
 * `github-view.ts` decides what a panel says and returns plain data, so it can be
 * tested without a Discord client. This file is the only place that data becomes
 * builders — for the slash command and, when a button is clicked, for the
 * interaction handler. Keeping the conversion in one place is what makes a clicked
 * panel render exactly like a typed one.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import type { ComponentRows, EmbedPayload, GithubView } from "./github-view.js";

/** What `interaction.editReply` and `message.edit` both accept. */
export interface ReplyPayload {
  readonly embeds: EmbedBuilder[];
  readonly components: (
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  )[];
}

/** @returns the reply payload for one view. */
export function renderView(view: GithubView): ReplyPayload {
  return {
    embeds: view.embeds.map(toEmbed),
    components: toComponents(view.components),
  };
}

/** @returns one embed payload as a builder, leaving absent parts unset. */
export function toEmbed(payload: EmbedPayload): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(payload.color).setTitle(payload.title);
  if (payload.url !== null) {
    embed.setURL(payload.url);
  }
  if (payload.description.length > 0) {
    embed.setDescription(payload.description);
  }
  if (payload.fields.length > 0) {
    embed.addFields(payload.fields.map((field) => ({ name: field.name, value: field.value })));
  }
  if (payload.footer !== undefined) {
    embed.setFooter({ text: payload.footer });
  }
  return embed;
}

/** @returns the buttons and then the selector, as the rows Discord expects. */
export function toComponents(rows: ComponentRows): ReplyPayload["components"] {
  const result: ReplyPayload["components"] = [];
  for (const row of rows.buttons) {
    result.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        row.map((button) =>
          new ButtonBuilder()
            .setCustomId(button.customId)
            .setLabel(button.label)
            .setEmoji(button.emoji)
            .setStyle(button.style === "primary" ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(button.disabled ?? false),
        ),
      ),
    );
  }
  const select = rows.select;
  if (select !== null) {
    result.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(select.customId)
          .setPlaceholder(select.placeholder)
          .addOptions(
            select.options.map((option) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(option.label)
                .setValue(option.value)
                .setDescription(option.description)
                .setEmoji(option.emoji)
                .setDefault(option.selected),
            ),
          ),
      ),
    );
  }
  return result;
}
