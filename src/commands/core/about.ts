/**
 * `/about` — build and environment information.
 *
 * Only non-sensitive values are exposed: version, environment name, uptime and
 * library versions. Tokens, connection strings and other secrets never reach
 * Discord.
 */
import { EmbedBuilder, SlashCommandBuilder, version as discordJsVersion } from "discord.js";
import process from "node:process";

import { defineSlashCommand } from "../define.js";
import { BOT_NAME } from "../../config/constants.js";
import { formatDuration } from "../../utils/presenters.js";

export default defineSlashCommand({
  meta: {
    name: "about",
    description: "Show information about the bot and its runtime.",
    category: "core",
  },
  botPermissions: ["core.use"],
  data: new SlashCommandBuilder()
    .setName("about")
    .setDescription("Show information about the bot and its runtime."),
  execute: async (interaction, context) => {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(BOT_NAME)
      .setDescription(
        "A modular Discord platform built on a foundation designed for hundreds of features.",
      )
      .addFields(
        { name: "Environment", value: context.appConfig.environment, inline: true },
        { name: "Uptime", value: formatDuration(context.uptimeMs), inline: true },
        { name: "Commands", value: String(context.client.commands.size), inline: true },
        { name: "Guilds", value: String(context.client.guilds.cache.size), inline: true },
        { name: "discord.js", value: `v${discordJsVersion}`, inline: true },
        { name: "Node.js", value: process.version, inline: true },
      )
      .setFooter({ text: "Foundation v0.1.0" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});
