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
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";

import type { ComponentRows, GithubView, ViewBlock, ViewSection } from "./github-view.js";
import { clip, MAX_FIELD, MAX_FIELD_NAME } from "./github-view.js";

/**
 * What `interaction.editReply` and `message.edit` both accept.
 *
 * Components V2, not embeds: a container holds text blocks instead of a fixed
 * twenty-five-field grid, so a panel is no longer truncated at its twenty-fifth
 * figure and a table no longer has to be squeezed into 1024 characters. The flag is
 * what switches the message to this mode, and it cannot be mixed with `content` or
 * `embeds` — Discord rejects the payload if either is present.
 */
export interface ReplyPayload {
  readonly components: (
    ContainerBuilder | ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>
  )[];
}

/** The message flag that turns a payload into Components V2. */
export const IS_COMPONENTS_V2 = 1 << 15;

/** @returns the reply payload for one view. */
export function renderView(view: GithubView): ReplyPayload {
  return {
    components: [...view.blocks.map(toContainer), ...toComponents(view.components)],
  };
}

/**
 * @returns one block as a container.
 *
 * The title is a heading rather than a link, because a container has no clickable
 * title: the repository URL is carried by the command's own link button, and the
 * heading names the panel the reader is on.
 */
export function toContainer(block: ViewBlock): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(block.color);
  // Clipped, not trusted: the title carries `GITHUB_REPOSITORY`, which is
  // operator-supplied and unbounded, and a single text block over the limit would make
  // Discord reject the whole reply rather than shorten it.
  container.addTextDisplayComponents(text(`## ${clip(block.title, MAX_FIELD_NAME)}`));
  if (block.description.length > 0) {
    container.addTextDisplayComponents(text(block.description));
  }
  for (const section of block.sections) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
    // The heading keeps the weight the embed's field name had, so the same words
    // read the same way, and the body stays plain so its code lanes keep monospacing.
    container.addTextDisplayComponents(
      ...sectionTexts({
        heading: `**${clip(section.heading, MAX_FIELD_NAME)}**`,
        text: section.text,
      }),
    );
  }
  if (block.footer.length > 0) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small),
    );
    container.addTextDisplayComponents(text(`-# ${block.footer}`));
  }
  return container;
}

/**
 * @returns the text displays for one section, in order.
 *
 * Split rather than concatenated when a section is longer than one block allows:
 * a chart and its legend belong to one figure, and dropping the legend to fit a
 * character count would leave the chart unexplained. Splitting is preferred to
 * clipping here because the table is the payload, not decoration.
 */
function sectionTexts(section: ViewSection): TextDisplayBuilder[] {
  return [section.heading, ...splitText(section.text)].map(text);
}

/**
 * @returns `content` cut into pieces of at most `MAX_FIELD` characters, on a line
 * boundary.
 *
 * A row is never split when it can be avoided: the library table's rows are code
 * lanes, and breaking one mid-row would misalign the monospaced columns. A single
 * line longer than the budget is cut anyway, since the alternative is a payload
 * Discord rejects.
 */
function splitText(content: string, budget = MAX_FIELD): string[] {
  if (content.length <= budget) {
    return [content];
  }
  const pieces: string[] = [];
  let current = "";
  for (const line of content.split("\n")) {
    // Every line after the first costs one more character for its newline.
    const cost = current.length === 0 ? line.length : line.length + 1;
    if (current.length > 0 && current.length + cost > budget) {
      pieces.push(current);
      current = "";
    }
    if (line.length > budget) {
      if (current.length > 0) {
        pieces.push(current);
        current = "";
      }
      for (let index = 0; index < line.length; index += budget) {
        pieces.push(line.slice(index, index + budget));
      }
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}

/** @returns one text display, refusing anything Discord would reject. */
function text(content: string): TextDisplayBuilder {
  if (content.length > MAX_FIELD) {
    throw new RangeError(`text display content is ${content.length} characters, max ${MAX_FIELD}`);
  }
  return new TextDisplayBuilder().setContent(content);
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
