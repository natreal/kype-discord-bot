/**
 * `/maintenance` — pause the bot for this server.
 *
 * A guild-scoped switch, not a process kill. Everything that matters lives in
 * `MaintenanceService` and the guild configuration; this file only maps options
 * onto it and renders the result.
 *
 *   /maintenance <on|off|status> [reason] [minutes]
 *
 * One command with a required `action` choice, not three commands: the three values
 * describe a single switch that shares its permission, its storage and its refusal
 * message, and `/help` should list it once.
 *
 * The command requires `server.settings` — the same permission the maintenance
 * bypass uses — so the people who can turn the pause on are exactly the people who
 * can still reach `/maintenance off` while it is on. No Discord permission bit is
 * required beyond what the authorization layer already implies (owner and
 * Administrators), because a role bound to `bot-manager` must be able to repair the
 * bot without also holding `Manage Server`.
 */
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { NotFoundError } from "../../utils/errors.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import type { ConfigWriteActor } from "../../services/config/index.js";
import type { MaintenanceService, MaintenanceStatus } from "../../services/maintenance/index.js";

/** Maximum automatic window, in minutes (seven days). */
const MAX_MINUTES = 10_080;

/** The required `action` choice: one switch, three values. */
const ACTIONS = [
  { name: "on", value: "on" },
  { name: "off", value: "off" },
  { name: "status", value: "status" },
] as const;

type MaintenanceAction = (typeof ACTIONS)[number]["value"];

export default defineSlashCommand({
  meta: {
    name: "maintenance",
    description: "Pause commands, tickets and AI replies for this server.",
    category: "utility",
    usage: "/maintenance <on|off|status> [reason] [minutes]",
    examples: [
      "/maintenance on reason:Updating the bot minutes:30",
      "/maintenance off",
      "/maintenance status",
    ],
  },
  permissions: { custom: ["server.settings"] },
  data: new SlashCommandBuilder()
    .setName("maintenance")
    .setDescription("Pause commands, tickets and AI replies for this server.")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Turn maintenance on, turn it off, or show its current state.")
        .setRequired(true)
        .addChoices(...ACTIONS.map((action) => ({ ...action }))),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why the bot is paused; shown to members (used by `on`).")
        .setMaxLength(500),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Resume automatically after this many minutes (used by `on`).")
        .setMinValue(1)
        .setMaxValue(MAX_MINUTES),
    ),
  execute: async (interaction, context) => {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        embeds: [errorEmbed("Server only", "Maintenance is stored per server.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const maintenance = requireMaintenance(context);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const action = interaction.options.getString("action", true) as MaintenanceAction;

    if (action === "status") {
      const status = await maintenance.status(guild.id);
      await interaction.editReply({ embeds: [statusEmbed(status)] });
      return;
    }

    const actor = actorFor(interaction);

    if (action === "off") {
      await maintenance.disable(guild.id, actor);
      await interaction.editReply({
        embeds: [
          brandedEmbed("Maintenance disabled").setDescription(
            "The bot is serving this server normally again.",
          ),
        ],
      });
      return;
    }

    const status = await maintenance.enable(guild.id, {
      minutes: interaction.options.getInteger("minutes") ?? undefined,
      reason: interaction.options.getString("reason") ?? undefined,
      actor,
    });

    await interaction.editReply({
      embeds: [
        brandedEmbed("Maintenance enabled")
          .setDescription(
            [
              "Commands, ticket actions and AI replies are paused for members.",
              "God Access, the server owner, Administrators and `server.settings` holders keep working, so `/maintenance off` stays reachable.",
            ].join("\n"),
          )
          .addFields(...statusFields(status)),
      ],
    });
  },
});

/** @returns the maintenance service, or throws when the process was not wired. */
function requireMaintenance(context: CommandExecutionContext): MaintenanceService {
  if (!context.maintenance) {
    throw new NotFoundError("Maintenance mode is not available in this process.");
  }
  return context.maintenance;
}

/** @returns the audit actor for a configuration write. */
function actorFor(interaction: ChatInputCommandInteraction): ConfigWriteActor {
  return { id: interaction.user.id, kind: hasGodAccess(interaction.user.id) ? "god" : "user" };
}

/** The `/maintenance status` embed. */
function statusEmbed(status: MaintenanceStatus): ReturnType<typeof brandedEmbed> {
  if (!status.active) {
    return brandedEmbed("Maintenance mode")
      .setDescription(
        status.expired
          ? "The last maintenance window has **ended**; the bot is serving this server normally."
          : "Maintenance is **off** in this server.",
      )
      .setFooter({ text: "Use `/maintenance on` to pause the bot." });
  }

  return brandedEmbed("Maintenance mode")
    .setDescription("Maintenance is **on** in this server.")
    .addFields(...statusFields(status));
}

/** The fields describing an enabled window. */
function statusFields(status: MaintenanceStatus): { name: string; value: string }[] {
  const state = status.state;
  const fields: { name: string; value: string }[] = [];

  if (state.reason.length > 0) {
    fields.push({ name: "Reason", value: state.reason });
  }
  if (state.by !== null) {
    fields.push({ name: "Enabled by", value: `<@${state.by}>` });
  }
  if (state.since !== null) {
    const since = Date.parse(state.since);
    if (Number.isFinite(since)) {
      fields.push({ name: "Since", value: `<t:${Math.floor(since / 1_000)}:R>` });
    }
  }

  const until = state.until === null ? null : Date.parse(state.until);
  fields.push({
    name: "Resumes",
    value:
      until === null || !Number.isFinite(until)
        ? "when `/maintenance off` is run"
        : `<t:${Math.floor(until / 1_000)}:f> (<t:${Math.floor(until / 1_000)}:R>)`,
  });

  return fields;
}
