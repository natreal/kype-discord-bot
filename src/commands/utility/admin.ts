/**
 * Administrative root command.
 *
 * `/admin` groups operator-facing tooling. Subcommands land in later phases
 * (`/admin permissions`, `/admin setup`, ...); for V1 it exposes the invite link
 * so an install can always be corrected without leaving Discord.
 */
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { defineSlashCommand } from "../define.js";
import { buildInviteLink, profilePermissionValue } from "../../utils/invite.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { INSTALL_PROFILES } from "../../services/permissions/index.js";
import { isDeployRequested, requestDeploy } from "../../runtime/deploy-request.js";
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
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("update")
        .setDescription("Ask the host to deploy the latest code from GitHub within ~1 minute.")
        .addStringOption((option) =>
          option.setName("reason").setDescription("Why, for the deploy log (optional)."),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("update-status")
        .setDescription("Show what the last deploy did and whether the running build matches."),
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

    if (interaction.options.getSubcommand() === "update") {
      await handleUpdate(interaction, context);
      return;
    }

    if (interaction.options.getSubcommand() === "update-status") {
      await handleUpdateStatus(interaction, context);
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

  // Read from this process's own payload, which is exactly what was sent: if a
  // command is missing here, the running build does not contain it.
  const payloadNames = deployment
    .deployableCommands()
    .map((command) => command.name)
    .sort((left, right) => left.localeCompare(right));

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
    .addFields({
      // The names, not just the count. A count alone cannot answer "did my new
      // command ship?" -- and a stale build reports the same number as a current
      // one, so an operator is left comparing totals by eye and guessing.
      name: `Registered (${payloadNames.length})`,
      value: payloadNames.join(", ").slice(0, 1024) || "none",
    })
    .setFooter({
      text:
        result.skipped && result.action !== "global"
          ? "Use `force: True` to re-register regardless."
          : "Commands may take a few seconds to appear in the client. If they still look duplicated, reload the client (Ctrl+R).",
    });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * `/admin update` — asks the host to deploy the latest commit from the phone.
 *
 * The bot cannot deploy itself. `deploy.ps1` stops the bot as its first mutating
 * step, and running `git merge` + `npm ci` from a chat command is remote code
 * execution with extra steps. So this writes `.run/deploy.request` and returns: the
 * scheduled `deploy.ps1` task — already ticking every minute and already owning the
 * deploy lock, the rollback and the health check — sees the request and does the
 * work. Nothing here fetches, builds or restarts.
 *
 * The request is deliberately *not* executed inline: fetching under the bot's own
 * lock would race the scheduled run, and a deploy that interrupts itself mid-`npm
 * ci` is how a host ends up with a half-installed `node_modules`.
 */
async function handleUpdate(
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

  const reason = interaction.options.getString("reason") ?? undefined;
  const actor = `${interaction.user.username} (${interaction.user.id})`;

  let markerPath: string;
  try {
    markerPath = requestDeploy({
      requestedBy: actor,
      ...(reason === undefined ? {} : { reason }),
    });
  } catch (error) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          "Update request not written",
          [
            `The host could not be asked to deploy: ${error instanceof Error ? error.message : String(error)}.`,
            "",
            "This needs the bot to run from the project directory, with `.run` writable.",
          ].join("\n"),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const build = context.appConfig.build;
  await interaction.reply({
    embeds: [
      brandedEmbed("Update requested")
        .setDescription(
          [
            "The deploy task checks GitHub every minute. Your request jumps the queue: on its next tick it will stop the bot, deploy the newest commit, rebuild, run the tests and start the bot again.",
            "",
            "**You will be disconnected for 1–3 minutes.** If the deploy fails, the previous commit is restored automatically and the bot comes back on the old code.",
          ].join("\n"),
        )
        .addFields(
          { name: "Requested by", value: actor, inline: true },
          {
            name: "Currently running",
            value: build
              ? `${build.commit.slice(0, 7)}${build.dirty ? " (dirty)" : ""}`
              : "unbuilt",
            inline: true,
          },
          { name: "Marker", value: `\`${path.basename(markerPath)}\``, inline: true },
        )
        .setFooter({ text: "Check the result with `/admin update-status`." }),
    ],
    ephemeral: true,
  });
}

/** What `deploy.ps1` writes to `.run/deploy-state.json`. */
interface DeployStateRecord {
  readonly checkedAt?: string;
  readonly result?: string;
  readonly message?: string;
  readonly branch?: string;
  readonly deployedSha?: string;
  readonly targetSha?: string;
}

/** Reads the deploy state, or `null` when the file is absent/corrupt. */
function readDeployState(): DeployStateRecord | null {
  try {
    const file = path.join(process.cwd(), ".run", "deploy-state.json");
    if (!existsSync(file)) {
      return null;
    }
    return JSON.parse(readFileSync(file, "utf8")) as DeployStateRecord;
  } catch {
    return null;
  }
}

/**
 * `/admin update-status` — did the update land?
 *
 * Reports the deploy record *and* the running build side by side, because those are
 * the two facts that can disagree: a deploy can succeed while the bot is still the
 * old process (it comes back on restart), and a bot can restart while the deploy is
 * still running. Only the comparison answers "am I on the new code?".
 */
async function handleUpdateStatus(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const state = readDeployState();
  const build = context.appConfig.build;
  const pending = isDeployRequested();

  const lines: string[] = [];
  if (!state) {
    lines.push("No deployment has run on this host yet (`.run/deploy-state.json` is absent).");
  } else {
    lines.push(`**Last result:** \`${state.result ?? "unknown"}\``);
    if (state.message) {
      lines.push(`**Detail:** ${state.message}`);
    }
    if (state.checkedAt) {
      lines.push(`**Checked:** ${state.checkedAt}`);
    }
  }

  const deployed = state?.deployedSha;
  const running = build?.commit;
  const matches = Boolean(deployed && running && deployed === running);

  const embed = brandedEmbed("Update status")
    .setDescription(lines.join("\n"))
    .addFields(
      {
        name: "Running build",
        value: build ? `${build.commit.slice(0, 7)}${build.dirty ? " (dirty)" : ""}` : "unbuilt",
        inline: true,
      },
      {
        name: "Deployed commit",
        value: deployed ? deployed.slice(0, 7) : "unknown",
        inline: true,
      },
      {
        name: "Match",
        value: matches ? "yes" : "no",
        inline: true,
      },
      {
        // Answers "does the *running* code contain the command I just added?"
        // without needing a successful deploy first.
        name: "Commands in this build",
        value: String(context.deployment.deployableCommands().length),
        inline: true,
      },
    )
    .setFooter({
      text: pending
        ? "An update request is queued; the next deploy tick will pick it up."
        : "Use `/admin update` to request the newest commit.",
    });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
