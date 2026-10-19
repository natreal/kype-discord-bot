/**
 * Rendering helpers for `/backup`.
 *
 * The list shows the ID an operator has to copy, and the restore report shows what
 * actually changed — never "restored successfully", which would be a claim the
 * module cannot back up.
 */
import type { EmbedBuilder } from "discord.js";

import { brandedEmbed } from "../../utils/presenters.js";
import type { BackupSummary, RestoreReport } from "../../modules/backup/index.js";

/** Renders the snapshot list, newest first. */
export function renderBackupList(
  snapshots: readonly BackupSummary[],
  guildId: string,
): EmbedBuilder {
  if (snapshots.length === 0) {
    return brandedEmbed("Backups").setDescription(
      "No snapshot yet. Take one with `/backup create` — anti-nuke can stop an attack, but only a backup can undo it.",
    );
  }

  return brandedEmbed("Backups")
    .setDescription(
      snapshots
        .map((snapshot) => {
          const age = Math.floor(snapshot.createdAt.getTime() / 1_000);
          return [
            `\`${snapshot.id}\` — **${snapshot.kind}** · ${snapshot.roleCount} role(s), ${snapshot.channelCount} channel(s)`,
            `Taken <t:${age}:R> by ${
              snapshot.createdBy === "system" ? "the scheduler" : `<@${snapshot.createdBy}>`
            } · checksum \`${snapshot.checksum?.slice(0, 12) ?? "none"}\``,
          ].join("\n");
        })
        .join("\n\n")
        .slice(0, 4_000),
    )
    .setFooter({ text: `Guild ${guildId} · restore with /backup restore backup:<id>` });
}

/** Renders what a restore changed, honestly including what it could not change. */
export function renderRestoreReport(report: RestoreReport, backupId: string): EmbedBuilder {
  const embed = brandedEmbed("Restore complete").setDescription(
    [
      `Snapshot \`${backupId}\`.`,
      `**Roles** — ${report.rolesCreated} created, ${report.rolesUpdated} repaired.`,
      `**Channels** — ${report.channelsCreated} created, ${report.channelsUpdated} repaired.`,
    ].join("\n"),
  );

  if (report.missingChannels.length > 0) {
    embed.addFields({
      name: "Not restored",
      value: `${report.missingChannels.length} channel(s): ${report.missingChannels
        .slice(0, 20)
        .join(", ")}`.slice(0, 1_024),
    });
  }
  if (report.notes.length > 0) {
    embed.addFields({ name: "Notes", value: report.notes.join("\n").slice(0, 1_024) });
  }
  return embed;
}
