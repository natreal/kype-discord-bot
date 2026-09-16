/**
 * `/help` — command discovery driven help.
 *
 * Categories and entries are derived from the command registry, so the output can
 * never become stale. It is also the living proof that nested command discovery
 * works.
 */
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { COMMAND_CATEGORIES } from "../../config/constants.js";

export default defineSlashCommand({
  meta: {
    name: "help",
    description: "List the available commands, grouped by category.",
    category: "utility",
  },
  botPermissions: ["core.use"],
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("List the available commands, grouped by category."),
  execute: async (interaction, context) => {
    const { commands } = context;
    const grouped = new Map<string, string[]>();

    for (const command of commands.list()) {
      if (command.kind !== "slash") {
        continue;
      }
      const entries = grouped.get(command.category) ?? [];
      entries.push(`**/${command.name}** — ${command.description}`);
      grouped.set(command.category, entries);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("Command reference")
      .setDescription(`The bot currently exposes ${commands.size} command(s).`)
      .setTimestamp();

    for (const category of COMMAND_CATEGORIES) {
      const entries = grouped.get(category);
      if (entries && entries.length > 0) {
        embed.addFields({ name: capitalize(category), value: entries.sort().join("\n") });
      }
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
