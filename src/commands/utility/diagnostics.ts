/**
 * `/diagnostics` — server and platform health.
 *
 * The command owns no checks: it builds a `DiagnosticContext` for the guild, asks
 * the registry to run everything (or one category), and renders the report. A new
 * module therefore adds a check without touching this file.
 */
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { EmbedBuilder } from "discord.js";

import { defineSlashCommand } from "../define.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";
import {
  DIAGNOSTIC_CATEGORIES,
  buildDiagnosticReport,
  describeVerdict,
  statusSymbol,
  type DiagnosticCategory,
  type DiagnosticCategoryReport,
  type DiagnosticContext,
  type DiagnosticReport,
} from "../../diagnostics/index.js";

export default defineSlashCommand({
  meta: {
    name: "diagnostics",
    description: "Inspect the health of the bot and this server.",
    category: "utility",
    usage: "/diagnostics [category]",
    examples: ["/diagnostics", "/diagnostics category:resources"],
  },
  permissions: {
    discord: [PermissionFlagsBits.ManageGuild],
    botPermissions: ["core.settings"],
  },
  // No `setDefaultMemberPermissions` here (see `/settings` for why): hiding the
  // command from anyone without `ManageGuild` made it impossible to even *type* in a
  // server where the caller's role lacked that bit, while the runtime gate already
  // enforces the same requirement with a clear denial.
  data: new SlashCommandBuilder()
    .setName("diagnostics")
    .setDescription("Inspect the health of the bot and this server.")
    .addStringOption((option) =>
      option
        .setName("category")
        .setDescription("Limit the report to one category (default: everything).")
        .addChoices(
          ...DIAGNOSTIC_CATEGORIES.map((category) => ({ name: category, value: category })),
        ),
    ),

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const category = interaction.options.getString("category") as DiagnosticCategory | null;
    const guild = interaction.guild;

    const diagnosticContext: DiagnosticContext = {
      guild,
      client: context.client,
      database: context.database,
      config: context.config,
      permissions: context.permissions,
      authorization: context.authorization,
      setupResources: context.setupResources,
      setupContext: context.setupContext,
      // Moderation checks read the guild's live state through the same service
      // the commands use, so "what /diagnostics reports" and "what a command
      // does" can never disagree.
      moderation: context.moderation,
      // The intent is a property of the running client, so it is read from the
      // client itself rather than inferred: an automod check must be able to say
      // "this module cannot see messages" instead of silently reporting "pass".
      hasMessageContentIntent: context.client.options.intents.has("MessageContent"),
      // Deployment checks need the shared deployment service: the same instance
      // the startup path used, so "is this server deployed?" is answered against
      // the payload this process is actually running.
      deployment: context.deployment,
      logger: context.logger,
      uptimeMs: context.uptimeMs,
      commands: context.commands,
    };

    const registry = context.diagnostics;
    if (!registry) {
      await interaction.editReply({
        embeds: [
          errorEmbed("Diagnostics unavailable", "The diagnostics registry is not wired up here."),
        ],
      });
      return;
    }

    const run = category
      ? await registry.runCategory(category, diagnosticContext)
      : await registry.runAll(diagnosticContext);

    const report = buildDiagnosticReport(run.results, {
      guildId: guild?.id ?? null,
      durationMs: run.durationMs,
    });

    await interaction.editReply({ embeds: [renderDiagnosticReport(report)] });
  },
});

/**
 * Renders the report as the brief specifies: one field per category, a symbol and
 * a reason per check, then the verdict.
 */
export function renderDiagnosticReport(report: DiagnosticReport): EmbedBuilder {
  const embed = brandedEmbed("Bot diagnostics");

  for (const category of report.categories) {
    embed.addFields({
      name: category.category,
      value: formatCategory(category),
    });
  }

  embed.setDescription(describeVerdict(report));

  const actionItems = report.results
    .filter((result) => result.status !== "pass")
    .map((result) => `**${result.label}** — ${result.remediation ?? result.detail}`);

  if (actionItems.length > 0) {
    embed.addFields({
      name: "What to do",
      value: actionItems.join("\n").slice(0, 1_024),
    });
  }

  embed.addFields({
    name: "Result",
    value: [
      report.issues === 0
        ? `All checks passed (${report.passed}).`
        : `${report.issues} issue(s): ${report.failures} failing, ${report.warnings} warning(s).`,
      `Ran ${report.results.length} check(s) in ${formatDuration(report.durationMs)}.`,
    ].join("\n"),
  });

  return embed;
}

/** @returns one line per check, with the symbol, label and detail. */
function formatCategory(category: DiagnosticCategoryReport): string {
  const lines = category.results.map((result) => {
    const values = formatMetrics(result.metrics);
    const suffix = values.length > 0 ? ` (${values.join(", ")})` : "";
    return `${statusSymbol(result.status)} ${result.label}: ${result.detail}${suffix}`;
  });
  const value = lines.join("\n");
  return value.length > 1_024 ? `${value.slice(0, 1_020).trimEnd()}…` : value;
}

/** @returns the measured values as `key=value` pairs, or an empty list. */
function formatMetrics(metrics: Readonly<Record<string, number>> | undefined): string[] {
  if (!metrics) {
    return [];
  }
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`);
}
