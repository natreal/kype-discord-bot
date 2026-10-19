/**
 * `/setup` — automatic server setup.
 *
 * Deliberately thin: it resolves the scope, delegates to `SetupService` and
 * renders the structured result. No Discord writes, no permission logic, no
 * resource knowledge lives here — the command is the interface, the services are
 * the implementation.
 *
 * V3 adds three subcommands beside `run` and `status`:
 * - `plan`     — what a run would do, with no Discord mutation at all;
 * - `validate` — whether the guild still matches the expected state;
 * - `repair`   — fix only what is missing, reusing V2's adoption behavior.
 *
 * The mutating subcommands are the only ones that touch Discord, and they say so
 * in their descriptions.
 */
import { GuildMember, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";
import { NotFoundError } from "../../utils/errors.js";
import type { SetupReport } from "../../modules/setup.types.js";
import { SETUP_MODULE_NAME } from "../../modules/setup.service.js";
import {
  SetupEngine,
  type SetupPlan,
  type SetupValidation,
} from "../../modules/setup/setup-engine.js";

/** Scopes offered in Discord's picker, in the order they are shown. */
const SCOPE_CHOICES = [
  { name: "all", value: "all" },
  { name: "information", value: "information" },
  { name: "logs", value: "logs" },
] as const;

export default defineSlashCommand({
  meta: {
    name: "setup",
    description: "Configure this server automatically (idempotent, safe to re-run).",
    category: "utility",
    usage: "/setup [plan|run|status|validate|repair] [scope]",
    examples: ["/setup plan", "/setup run", "/setup validate", "/setup repair"],
  },
  botPermissions: ["setup.run"],
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure this server automatically (idempotent, safe to re-run).")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("plan")
        .setDescription("Preview what setup would do. Nothing is created or changed."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("run")
        .setDescription("Create missing resources and apply permissions.")
        .addStringOption((option) =>
          option
            .setName("scope")
            .setDescription("Limit the run to one section (default: everything).")
            .addChoices(...SCOPE_CHOICES),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show what setup manages and whether anything has drifted."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("validate")
        .setDescription("Check whether this server still matches the expected setup state."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("repair")
        .setDescription("Recreate only the resources that are missing or broken."),
    ),

  execute: async (interaction, context) => {
    const guild = interaction.guild;
    if (!guild) {
      throw new NotFoundError("Automatic setup requires a server context");
    }

    // Optional subcommands: resolving the name keeps `/setup` itself runnable
    // while the tree grows.
    const subcommand = interaction.options.getSubcommand(false) ?? "run";

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (subcommand === "status") {
      await replyWithStatus(interaction, context, guild.id);
      return;
    }

    const setupContext = context.setupContext;
    if (!setupContext) {
      await interaction.editReply({
        embeds: [errorEmbed("Setup unavailable", "Setup helpers are not available here.")],
      });
      return;
    }

    const engine = new SetupEngine({ logger: context.logger });

    if (subcommand === "plan") {
      const plan = await engine.plan(guild, setupContext.resources, context.setupResources);
      await interaction.editReply({ embeds: [renderPlan(plan)] });
      return;
    }

    if (subcommand === "validate") {
      const validation = await engine.validate(
        guild,
        setupContext.resources,
        context.setupResources,
      );
      await interaction.editReply({ embeds: [renderValidation(validation)] });
      return;
    }

    if (!(interaction.member instanceof GuildMember)) {
      // The handler already resolved the member for the permission check, so this
      // only happens if Discord sent an incomplete payload; better to say so than
      // to run an unauthenticated setup.
      throw new NotFoundError("Your membership could not be verified for this server");
    }

    if (subcommand === "repair") {
      const report = await context.setup.repair(guild, undefined, interaction.member);
      await interaction.editReply({ embeds: [renderRepair(report)] });
      return;
    }

    const scope = interaction.options.getString("scope") ?? "all";
    const report = await context.setup.run(guild, scope, interaction.member);

    await interaction.editReply({ embeds: [renderReport(report)] });
  },
});

/**
 * Renders a plan.
 *
 * The plan is the promise the run has to keep, so every entry states its action
 * and the reason for it. Nothing here implies that anything already happened:
 * `/setup plan` never mutates.
 */
export function renderPlan(plan: SetupPlan): EmbedBuilder {
  const embed = brandedEmbed("Setup plan")
    .setDescription(
      plan.entries.length === 0
        ? "There is nothing to plan for this server."
        : "Nothing has been created or changed. This is what a run would do.",
    )
    .setFooter({ text: `Guild ${plan.guildId}` });

  if (plan.entries.length > 0) {
    embed.addFields({ name: "Actions", value: formatPlanEntries(plan) });
    embed.addFields({
      name: "Summary",
      value: [
        `Create: **${plan.counts.CREATE}**`,
        `Adopt: **${plan.counts.ADOPT}**`,
        `Repair: **${plan.counts.REPAIR}**`,
        `Reuse: **${plan.counts.REUSE}**`,
        `Skip: **${plan.counts.SKIP}**`,
        `Errors: **${plan.counts.ERROR}**`,
      ].join("\n"),
    });
  }

  if (!plan.ok) {
    embed.addFields({
      name: "Attention",
      value:
        "Some tracked resources are no longer declared by the registry. Deploy a version of the bot that knows them, or migrate the data.",
    });
  }

  return embed;
}

/**
 * Renders a validation.
 *
 * Reports existence per resource and, crucially, whether anything is repairable
 * without mutating: the administrator chooses when to run `/setup repair`.
 */
export function renderValidation(validation: SetupValidation): EmbedBuilder {
  const problems = validation.repairable.length;
  const embed = brandedEmbed("Setup validation")
    .setDescription(
      problems === 0
        ? "This server matches the expected setup state."
        : `${problems} resource(s) require repair. Nothing has been changed; run \`/setup repair\` when ready.`,
    )
    .setFooter({ text: `Guild ${validation.guildId}` });

  if (validation.entries.length > 0) {
    embed.addFields({
      name: "Resources",
      value: validation.entries
        .map((entry) => `${validationMark(entry.status)} ${entry.key} — ${entry.detail}`)
        .join("\n")
        .slice(0, 1_024),
    });
  }

  if (problems > 0) {
    embed.addFields({
      name: "Repairable",
      value: validation.repairable
        .map((key) => `\`${key}\``)
        .join(", ")
        .slice(0, 1_024),
    });
  }

  return embed;
}

/** Renders the outcome of a repair, naming what was actually touched. */
export function renderRepair(report: SetupReport): EmbedBuilder {
  const embed = renderReport(report);

  if (report.created === 0 && report.updated === 0 && report.failed === 0) {
    embed.setDescription("Nothing was missing: this server needed no repair.");
  }

  return embed;
}

/** @returns one line per plan entry, with the action and the reason. */
function formatPlanEntries(plan: SetupPlan): string {
  const lines = plan.entries.map(
    (entry) => `${planMark(entry.action)} **${entry.key}** — ${entry.reason}`,
  );
  const value = lines.join("\n");
  return value.length > 1_024 ? `${value.slice(0, 1_020).trimEnd()}…` : value;
}

/** @returns the symbol used for a plan action. */
function planMark(action: SetupPlan["entries"][number]["action"]): string {
  switch (action) {
    case "CREATE":
      return "＋";
    case "ADOPT":
      return "⇢";
    case "REPAIR":
      return "⚠";
    case "REUSE":
      return "✓";
    case "SKIP":
      return "•";
    default:
      return "✖";
  }
}

/** @returns the symbol used for a validation status. */
function validationMark(status: SetupValidation["entries"][number]["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "missing":
    case "drifted":
      return "⚠";
    default:
      return "✖";
  }
}

/**
 * Renders the structured setup result for Discord.
 *
 * Three shapes, matching the brief: everything done, nothing to do, or partial.
 * Technical detail never appears here — failures show the *reason* only, and the
 * stack traces stay in the logs.
 */
export function renderReport(report: SetupReport): EmbedBuilder {
  const tracked = report.results.filter((entry) => entry.module === SETUP_MODULE_NAME);
  const failures = report.results.filter((entry) => entry.status === "failed");

  const title =
    report.status === "completed"
      ? "Server Setup Complete"
      : report.status === "partial"
        ? "Server Setup Partially Complete"
        : "Server Setup Failed";

  const embed =
    report.status === "completed"
      ? brandedEmbed(title)
      : errorEmbed(title, "Some steps could not be completed.").setFooter({
          text: "See the log for details.",
        });

  const lines = tracked.map((entry) => {
    const mark = entry.status === "failed" ? "⚠" : entry.status === "skipped" ? "•" : "✓";
    const label = entry.description.replace(/^\[[^\]]+\]\s*/, "");
    const suffix =
      entry.status === "created"
        ? "created"
        : entry.status === "reused"
          ? "reused"
          : entry.status === "updated"
            ? "repaired"
            : entry.status === "skipped"
              ? "skipped"
              : "failed";
    return `${mark} ${label} — ${suffix}`;
  });

  if (lines.length > 0) {
    embed.addFields({ name: "Resources", value: lines.join("\n").slice(0, 1_024) });
  }

  embed.addFields(
    {
      name: "Summary",
      value: [
        `Created: **${report.created}**`,
        `Reused: **${report.reused}**`,
        `Repaired: **${report.updated}**`,
        `Skipped: **${report.skipped}**`,
        `Failed: **${report.failed}**`,
      ].join("\n"),
      inline: true,
    },
    { name: "Duration", value: formatDuration(report.durationMs), inline: true },
  );

  if (report.created === 0 && report.updated === 0 && report.failed === 0) {
    embed.setDescription("Nothing needed to be recreated.");
  }

  if (failures.length > 0) {
    const reasons = failures
      .slice(0, 5)
      .map((entry) => `**${entry.key}** — ${entry.errorMessage ?? entry.detail ?? "unknown error"}`)
      .join("\n");
    embed.addFields({ name: "Reason", value: reasons.slice(0, 1_024) });
  }

  return embed;
}

/**
 * `/setup status` — read-only view of the managed resources and their drift.
 *
 * Uses the identity table plus `detectStale`, so an administrator can see a
 * deleted channel *before* running setup. Nothing is created or modified here.
 */
async function replyWithStatus(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  guildId: string,
): Promise<void> {
  const setupContext = context.setupContext;
  if (!setupContext) {
    await interaction.editReply({
      embeds: [errorEmbed("Setup status unavailable", "Setup helpers are not available here.")],
    });
    return;
  }

  const tracked = await setupContext.resources.list();
  const stale = await setupContext.resources.detectStale(tracked);

  const embed = brandedEmbed("Setup status")
    .setDescription(
      tracked.length === 0
        ? "This server has not been configured yet. Run `/setup run` to create the default structure."
        : "Resources managed by the automatic setup system.",
    )
    .addFields({
      name: "Tracked resources",
      value:
        tracked.length === 0
          ? "—"
          : tracked
              .map((record) => {
                const drift = stale.some((entry) => entry.key === record.key);
                return `${drift ? "⚠" : "✓"} \`${record.key}\` — \`${record.discordId ?? "unresolved"}\``;
              })
              .join("\n")
              .slice(0, 1_024),
    })
    .addFields({
      name: "Drift",
      value:
        stale.length === 0
          ? "No drift detected: every stored resource still exists on Discord."
          : `${stale.length} stored resource(s) are missing on Discord. Run \`/setup run\` to repair them.`,
    })
    .setFooter({ text: `Guild ${guildId}` });

  await interaction.editReply({ embeds: [embed] });
}
