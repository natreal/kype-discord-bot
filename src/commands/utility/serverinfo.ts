/**
 * `/serverinfo` — server diagnostics.
 *
 * Demonstrates that commands can read guild data and validated guild
 * configuration through the injected services (no global state, no direct
 * database access from the command).
 */
import { ChannelType, EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { NotFoundError } from "../../utils/errors.js";

export default defineSlashCommand({
  meta: {
    name: "serverinfo",
    description: "Show information about this server and its bot configuration.",
    category: "utility",
  },
  botPermissions: ["core.use"],
  data: new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show information about this server and its bot configuration."),
  execute: async (interaction, context) => {
    const { guild } = interaction;
    if (!guild) {
      throw new NotFoundError("This command requires a guild context");
    }

    const owner = await guild.fetchOwner().catch(() => null);
    const channels = guild.channels.cache;
    const textChannels = channels.filter((channel) => channel.type === ChannelType.GuildText).size;
    const voiceChannels = channels.filter(
      (channel) => channel.type === ChannelType.GuildVoice,
    ).size;
    const config = context.guildConfig;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL({ size: 128 }))
      .addFields(
        { name: "Members", value: String(guild.memberCount), inline: true },
        { name: "Owner", value: owner ? owner.user.tag : "unknown", inline: true },
        {
          name: "Created",
          value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:R>`,
          inline: true,
        },
        { name: "Channels", value: `${textChannels} text / ${voiceChannels} voice`, inline: true },
        { name: "Roles", value: String(guild.roles.cache.size), inline: true },
        { name: "Boosts", value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
      )
      .setFooter({ text: `Guild ID: ${guild.id}` })
      .setTimestamp();

    if (config) {
      embed.addFields({
        name: "Bot configuration",
        value: [
          `Language: \`${config.language}\``,
          `Logging: ${config.logging.enabled ? "enabled" : "disabled"}`,
          `Moderation: ${config.moderation.enabled ? "enabled" : "disabled"}`,
          `Security: ${config.security.enabled ? "enabled" : "disabled"}`,
          `Setup sections: ${config.setup.completedSections.length > 0 ? config.setup.completedSections.join(", ") : "not run yet"}`,
        ].join("\n"),
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});
