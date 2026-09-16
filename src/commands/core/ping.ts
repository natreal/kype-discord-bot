/**
 * `/ping` — liveness check.
 *
 * Proves command discovery, registration, interaction handling, permission
 * checking and error handling all work end to end.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed } from "../../utils/presenters.js";

export default defineSlashCommand({
  meta: {
    name: "ping",
    description: "Check that the bot is online and responsive.",
    category: "core",
  },
  botPermissions: ["core.use"],
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check that the bot is online and responsive."),
  execute: async (interaction: ChatInputCommandInteraction, context: CommandExecutionContext) => {
    const websocketLatency = interaction.client.ws.ping;
    const roundTrip = Date.now() - interaction.createdTimestamp;
    const database = await context.database.health();

    const embed = brandedEmbed("Pong!")
      .setDescription("The bot is online and processing interactions.")
      .addFields(
        { name: "Round trip", value: `${roundTrip}ms`, inline: true },
        {
          name: "Gateway",
          value: websocketLatency >= 0 ? `${websocketLatency}ms` : "unknown",
          inline: true,
        },
        {
          name: "Database",
          value: database.ok ? `${database.latencyMs}ms` : "unavailable",
          inline: true,
        },
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});
