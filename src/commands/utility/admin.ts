/**
 * Administrative root command.
 *
 * `/admin` groups operator-facing tooling. Subcommands land in later phases
 * (`/admin permissions`, `/admin setup`, ...); for V1 it exposes the invite link
 * so an install can always be corrected without leaving Discord.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { buildInviteLink, profilePermissionValue } from "../../utils/invite.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { INSTALL_PROFILES } from "../../services/permissions/index.js";
import type { CommandExecutionContext } from "../context.js";

export default defineSlashCommand({
  meta: {
    name: "admin",
    description: "Operator tools: invite links and installation diagnostics.",
    category: "utility",
  },
  botPermissions: ["core.settings"],
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Operator tools: invite links, installation and command deployment.")
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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("deploy")
        .setDescription("Register this bot's commands in this server, right now.")
        .addBooleanOption((option) =>
          option
            .setName("force")
            .setDescription("Register even if the stored deployment record says it is current."),
        ),
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

    if (interaction.options.getSubcommand() === "deploy") {
      await handleDeploy(interaction, context);
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

/**
 * `/admin deploy` — publishes the command payload on demand.
 *
 * This exists because "automatic" still needs an escape hatch. A server whose
 * commands were removed by hand, a deployment that failed while the bot was
 * offline, or a permission problem that has since been fixed should be repairable
 * from inside Discord, without restarting the bot and without shell access.
 *
 * It follows the *configured scope*, exactly like startup, and it verifies
 * afterwards: the reply states what Discord actually holds, not merely that a
 * request returned 200. Deploying into this guild's own scope regardless of the
 * configured one is what used to leave every command listed twice — a global
 * registration plus a guild copy — so a manual deploy now removes those leftovers
 * as part of the same action.
 */
async function handleDeploy(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command must be run inside a server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const force = interaction.options.getBoolean("force") ?? false;
  const deployment = context.deployment;

  const result = await deployment.deployForGuild({ id: guild.id, name: guild.name }, "manual", {
    force,
  });

  if (!result.ok) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Command registration failed",
          [
            `Discord rejected the request: ${result.reason ?? "unknown error"}.`,
            "",
            "The most common causes are a missing `applications.commands` scope on the invite, or a token that no longer matches the application.",
          ].join("\n"),
        ),
      ],
    });
    return;
  }

  // A 200 is not proof: read the scope back so the operator sees the truth. Under
  // `global` the guild scope is empty by design, so the global registration is what
  // says whether this server has the commands.
  const deployScope = context.appConfig.discord.deployScope;
  const verification =
    deployScope === "global"
      ? await deployment.verifyGlobal()
      : await deployment.verifyGuild(guild.id);

  const summary =
    result.action === "global"
      ? result.cleared > 0
        ? `Published application-wide and removed **${result.cleared}** guild-scoped duplicate(s) from this server.`
        : "Published application-wide. This server reads the global registration, so nothing is registered here."
      : result.skipped
        ? "This server already had the current commands, so nothing was re-registered."
        : `Registered **${result.commands}** command(s) in this server.`;

  const embed = brandedEmbed("Command deployment")
    .setDescription(summary)
    .addFields(
      { name: "Commands", value: String(result.commands), inline: true },
      { name: "Scope", value: deployScope, inline: true },
      { name: "Duplicates removed", value: String(result.cleared), inline: true },
      {
        name: "Verified",
        value:
          verification.failed.length > 0
            ? `could not verify (${verification.failed.join(", ")})`
            : verification.missing.length === 0
              ? "all commands present"
              : `still missing ${verification.missing.join(", ")}`,
        inline: true,
      },
    )
    .setFooter({
      text:
        result.skipped && result.action !== "global"
          ? "Use `force: True` to re-register regardless."
          : "Commands may take a few seconds to appear in the client. If they still look duplicated, reload the client (Ctrl+R).",
    });

  await interaction.editReply({ embeds: [embed] });
}
