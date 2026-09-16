/**
 * Administrative root command.
 *
 * `/admin` groups operator-facing tooling. Subcommands land in later phases
 * (`/admin permissions`, `/admin setup`, ...); for V1 it exposes the invite link
 * so an install can always be corrected without leaving Discord.
 */
import { SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { buildInviteLink, profilePermissionValue } from "../../utils/invite.js";
import { brandedEmbed } from "../../utils/presenters.js";
import { INSTALL_PROFILES } from "../../services/permissions/index.js";

export default defineSlashCommand({
  meta: {
    name: "admin",
    description: "Operator tools: invite links and installation diagnostics.",
    category: "utility",
  },
  botPermissions: ["core.settings"],
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Operator tools: invite links and installation diagnostics.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("invite")
        .setDescription("Show the pre-configured invite link for this bot.")
        .addStringOption((option) =>
          option
            .setName("profile")
            .setDescription("Permission profile to request (default: recommended).")
            .addChoices(...INSTALL_PROFILES.map((profile) => ({ name: profile, value: profile }))),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("permissions")
        .setDescription("Check the bot's permissions in this server."),
    ),
  execute: async (interaction, context) => {
    const guild = interaction.guild;

    if (interaction.options.getSubcommand() === "invite") {
      const profile = (interaction.options.getString("profile") ?? "recommended") as
        "recommended" | "administrator";

      const link = buildInviteLink({
        clientId: context.appConfig.discord.clientId,
        profile,
        ...(guild ? { guildId: guild.id } : {}),
      });

      const embed = brandedEmbed("Invite link")
        .setDescription(
          [
            `Profile: \`${profile}\``,
            `Permission value: \`${profilePermissionValue(profile)}\``,
            "",
            "Share this link to install the bot with the correct scopes and permissions.",
          ].join("\n"),
        )
        .addFields({ name: "Link", value: `[Add to server](${link})` });

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // `/admin permissions`
    const me = guild?.members.me;
    if (!guild || !me) {
      await interaction.reply({
        content: "This check must be run inside a server.",
        ephemeral: true,
      });
      return;
    }

    const missing = context.permissions.missingCriticalPermissions(me);
    const embed = brandedEmbed("Permission check")
      .setDescription(
        missing.length === 0
          ? "All critical permissions are granted. Every feature can operate."
          : [
              "The bot is missing permissions that will break features:",
              "",
              ...missing.map((permission) => `- \`${String(permission)}\``),
            ].join("\n"),
      )
      .addFields(
        { name: "Server", value: guild.name, inline: true },
        {
          name: "Administrator",
          value: me.permissions.has("Administrator") ? "yes" : "no",
          inline: true,
        },
      );

    if (missing.length > 0) {
      embed.addFields({
        name: "Fix",
        value: `[Re-invite with the recommended profile](${buildInviteLink({
          clientId: context.appConfig.discord.clientId,
          profile: "recommended",
          guildId: guild.id,
        })})`,
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});
