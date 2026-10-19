/**
 * `/backup` — snapshots of this server's structure.
 *
 * `create`, `list`, `restore` and `delete`. The command is deliberately blunt about
 * what a backup is and is not:
 *
 * - it captures **structure and configuration** (roles, channels, overwrites, the
 *   bot's own settings), never members or messages;
 * - a restore is **additive**: it recreates what is missing and repairs what
 *   drifted, and it never deletes anything the snapshot does not know about,
 *   because a channel an operator created afterwards is legitimate work;
 * - a snapshot is **per server**. There is no export and no import across guilds,
 *   and `restore` refuses a payload whose embedded guild does not match.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { renderBackupList, renderRestoreReport } from "../utility/settings-backup.js";

export default defineSlashCommand({
  meta: {
    name: "backup",
    description: "Snapshot and restore this server's structure.",
    category: "security",
    usage: "/backup <create|list|restore|delete>",
    examples: ["/backup create", "/backup list", "/backup restore backup:<id>"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ManageGuild],
    // Backups are a server-level operation: `security.configure` is the permission
    // that already means "may change how this server is protected".
    custom: ["security.configure"],
  },
  data: new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Snapshot and restore this server's structure.")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Snapshot roles, channels, permissions and configuration."),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List this server's snapshots, newest first."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("restore")
        .setDescription("Recreate what a snapshot is missing and repair what drifted.")
        .addStringOption((option) =>
          option
            .setName("backup")
            .setDescription("Snapshot ID, as shown by /backup list (defaults to the latest).")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete one of this server's snapshots.")
        .addStringOption((option) =>
          option.setName("backup").setDescription("Snapshot ID.").setRequired(true),
        ),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        embeds: [errorEmbed("Server only", "Backups are per server.")],
      });
      return;
    }
    const backup = context.backup;
    if (!backup) {
      await interaction.editReply({
        embeds: [errorEmbed("Unavailable", "Backups are not available in this build.")],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "create") {
      const summary = await backup.capture(guild.id, guild.name, {
        kind: "manual",
        createdBy: interaction.user.id,
      });
      await interaction.editReply({
        embeds: [
          brandedEmbed("Backup created").setDescription(
            [
              `Snapshot \`${summary.id}\``,
              `${summary.roleCount} role(s) and ${summary.channelCount} channel(s) captured.`,
              "Restore it with `/backup restore` after an incident.",
            ].join("\n"),
          ),
        ],
      });
      return;
    }

    if (subcommand === "list") {
      const snapshots = await backup.list(guild.id, 10);
      await interaction.editReply({ embeds: [renderBackupList(snapshots, guild.id)] });
      return;
    }

    if (subcommand === "delete") {
      const backupId = interaction.options.getString("backup", true);
      const removed = await backup.remove(guild.id, backupId, interaction.user.id);
      await interaction.editReply({
        embeds: [
          removed
            ? brandedEmbed("Backup deleted").setDescription(`Snapshot \`${backupId}\` removed.`)
            : errorEmbed("Not found", "That snapshot does not belong to this server."),
        ],
      });
      return;
    }

    // `restore`
    const requested = interaction.options.getString("backup");
    const snapshot = requested
      ? await backup.find(guild.id, requested)
      : await backup.latest(guild.id);
    if (!snapshot) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            "No snapshot",
            "There is no backup to restore. Take one with `/backup create` before you need it.",
          ),
        ],
      });
      return;
    }

    try {
      const report = await backup.restore(guild.id, snapshot.id, interaction.user.id);
      await interaction.editReply({ embeds: [renderRestoreReport(report, snapshot.id)] });
    } catch (error) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            "Restore refused",
            error instanceof Error ? error.message : "The snapshot could not be applied.",
          ),
        ],
      });
    }
  },
});
