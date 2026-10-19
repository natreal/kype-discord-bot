/**
 * `/security` — the command definition.
 *
 * The subcommand *bodies* live in `security.handlers.ts`, so the definition stays a
 * readable description of the interface and each behaviour is testable in isolation
 * (they take the context, not the interaction, wherever possible).
 *
 * Every decision here is either read-only (`status`) or a decision a human makes
 * about containment. Nothing in this command can punish a member directly:
 * `quarantine` runs through the moderation service, and a nuke response removes
 * Discord roles instead of banning, exactly as the V5 brief requires.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import {
  handleLockdown,
  handleQuarantine,
  handleRecover,
  handleSecurityStatus,
  handleUnlock,
} from "./security.handlers.js";

export default defineSlashCommand({
  meta: {
    name: "security",
    description: "Anti-raid, anti-nuke and lockdown controls.",
    category: "security",
    usage: "/security <status|lockdown|unlock|quarantine|recover>",
    examples: ["/security status", "/security lockdown", "/security unlock"],
  },
  // `ManageGuild` is the Discord-side floor; the granular permissions below are
  // what actually authorize each action, and both are checked by the handler.
  permissions: {
    discord: [PermissionFlagsBits.ManageGuild],
    custom: ["security.view"],
  },
  data: new SlashCommandBuilder()
    .setName("security")
    .setDescription("Anti-raid, anti-nuke and lockdown controls.")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show the security state and any active incident."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("lockdown")
        .setDescription("Lock every text channel and start a containment window.")
        .addStringOption((option) =>
          option.setName("reason").setDescription("Why the server is being locked down."),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("unlock").setDescription("Lift the lockdown and close the incident."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("quarantine")
        .setDescription("Restrict a member to the Quarantined role, through moderation.")
        .addUserOption((option) =>
          option.setName("user").setDescription("The member to contain.").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Why they are being contained.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("recover").setDescription("End the incident and restore the server now."),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand(true);
    switch (subcommand) {
      case "status":
        return handleSecurityStatus(interaction, context);
      case "lockdown":
        return handleLockdown(interaction, context);
      case "unlock":
        return handleUnlock(interaction, context);
      case "quarantine":
        return handleQuarantine(interaction, context);
      default:
        return handleRecover(interaction, context);
    }
  },
});
