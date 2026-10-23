/**
 * `/github` — the watched repository's implementation statistics.
 *
 *   /github status  — the latest snapshot, with the trend since the first one kept
 *   /github history — the recorded snapshots, oldest first (24 by default)
 *   /github refresh — take a snapshot now instead of waiting for the hourly task
 *
 * Every number shown comes from the project's own published `progress.json`, stored
 * verbatim by the monitor; this command only formats what is already in the
 * database, so it works with no network access and never disagrees with the
 * hourly report.
 */
import { GuildMember, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { AppError, toError } from "../../utils/errors.js";
import { buildReportContent } from "../../modules/repository/repository-report.content.js";
import type { RepositoryMonitorService } from "../../modules/repository/repository.service.js";
import type { SnapshotRecord } from "../../modules/repository/repository.types.js";

/** Rows `/github history` prints at most: a day at the default cadence. */
const HISTORY_ROWS = 24;

export default defineSlashCommand({
  meta: {
    name: "github",
    description: "Show the implementation progress of the watched GitHub project.",
    category: "utility",
    usage: "/github status | history [limit] | refresh",
    examples: ["/github status", "/github history limit:12"],
  },
  // Read-only for everyone who may use the bot; `refresh` escalates on its own,
  // because it writes a snapshot and can post to the report channel.
  permissions: { custom: ["core.use"] },
  data: new SlashCommandBuilder()
    .setName("github")
    .setDescription("Show the implementation progress of the watched GitHub project.")
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("The latest snapshot and its trend."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("history")
        .setDescription("The recorded snapshots, oldest first.")
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription(`How many snapshots to list (1-${HISTORY_ROWS}, default 12).`)
            .setMinValue(1)
            .setMaxValue(HISTORY_ROWS),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("refresh").setDescription("Take a snapshot now, and announce what changed."),
    ),

  execute: async (interaction, context) => {
    const monitor = context.repositoryMonitor;
    if (!monitor) {
      await interaction.editReply({
        embeds: [errorEmbed("GitHub monitor", "The repository monitor is not wired in this process.")],
      });
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "status":
        await handleStatus(interaction, monitor);
        return;
      case "history":
        await handleHistory(interaction, monitor);
        return;
      case "refresh":
        await handleRefresh(interaction, context, monitor);
        return;
      default:
        await interaction.editReply({
          embeds: [errorEmbed("GitHub monitor", "Unknown subcommand.")],
        });
    }
  },
});

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
): Promise<void> {
  const history = await monitor.history(HISTORY_ROWS);
  const latest = history.at(-1) ?? null;
  if (latest === null) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(`${monitor.fullName} — no snapshot yet`).setDescription(
          "The monitor has not recorded a reading. Run `/github refresh`, or wait for the hourly task.",
        ),
      ],
    });
    return;
  }

  const previous = history.at(-2) ?? null;
  // The stored snapshot is enough to render the numbers; the parts of a report that
  // need a live reading (open pull requests, the project's own description) are
  // simply absent here rather than fabricated.
  const content = buildReportContent(
    {
      facts: {
        fullName: monitor.fullName,
        description: null,
        defaultBranch: "main",
        stars: latest.state.stars,
        forks: latest.state.forks,
        openIssues: latest.state.openIssues,
        pushedAt: null,
      },
      progress: progressFromSnapshot(latest),
      progressUnavailable: latest.failures.includes("progress")
        ? "progress.json was unavailable for this snapshot"
        : null,
      progressCommit: latest.progressCommit,
      commits: [],
      pullRequests: [],
      fetchedAt: latest.capturedAt,
    },
    previous,
    [],
    history,
  );

  const embed = brandedEmbed(content.title).setDescription(content.description);
  for (const metric of content.metrics) {
    embed.addFields({ name: metric.name, value: metric.value });
  }
  embed.setFooter({ text: `${content.footer} · snapshot ${latest.id.slice(0, 6)}` });
  await interaction.editReply({ embeds: [embed] });
}

/** `/github history` — one line per stored snapshot. */
async function handleHistory(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
): Promise<void> {
  const limit = interaction.options.getInteger("limit") ?? 12;
  const history = (await monitor.history(HISTORY_ROWS)).slice(-limit);
  if (history.length === 0) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(`${monitor.fullName} — history`).setDescription(
          "Nothing recorded yet. Run `/github refresh` to take the first snapshot.",
        ),
      ],
    });
    return;
  }

  const lines = history.map((snapshot) => {
    const epoch = Math.floor(snapshot.capturedAt.getTime() / 1_000);
    const libraries = percentCell(snapshot.state.libraryPercent);
    const shaders = percentCell(snapshot.state.shaderPercent);
    return `<t:${epoch}:f> · libraries ${libraries} · shaders ${shaders}`;
  });

  await interaction.editReply({
    embeds: [
      brandedEmbed(`${monitor.fullName} — ${history.length} snapshot(s)`)
        .setDescription(lines.join("\n"))
        .setFooter({
          text: "Percentages are the project's published figures, stored per refresh.",
        }),
    ],
  });
}

/** `/github refresh` — a snapshot now, with the same announcement rules. */
async function handleRefresh(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  monitor: RepositoryMonitorService,
): Promise<void> {
  const member = interaction.member;
  // Writing a snapshot and possibly posting to the report channel is a staff action,
  // unlike reading the stored history. `instanceof` is the narrowing the other
  // commands use: an uncached `APIInteractionGuildMember` carries no permissions,
  // and `can` resolves role classes asynchronously, so the await is required.
  const allowed =
    member instanceof GuildMember &&
    (await context.authorization.can(member, { custom: ["server.settings"] }, "github.refresh"));
  if (!allowed) {
    await interaction.editReply({
      embeds: [
        errorEmbed("GitHub monitor", "Taking a snapshot requires the `server.settings` permission."),
      ],
    });
    return;
  }

  const report = await monitor.refresh().catch((error: unknown) => {
    // The generic handler would answer "contact the team", which tells an operator
    // nothing and leaves a broken deployment looking like a bot bug. Reading the
    // snapshot touches the database and three HTTP sources, so the failure is almost
    // always one of two things an operator can act on, and saying which costs nothing.
    throw new AppError(`GitHub monitor could not record a snapshot: ${explainRefreshFailure(error)}`, {
      code: "REPOSITORY_REFRESH_FAILED",
      expected: true,
      cause: error,
    });
  });
  const lines = [
    report.baseline
      ? "Baseline recorded: this is the first snapshot, so history is not announced."
      : `${report.announced} change(s) recorded.`,
    report.librariesPercent === null
      ? "Implementation statistics unavailable this time."
      : `Libraries ${report.librariesPercent}% · shaders ${report.shaderPercent ?? "—"}%`,
    report.failures.length === 0 ? null : `Failed sources: ${report.failures.join(", ")}`,
  ].filter((line): line is string => line !== null);

  await interaction.editReply({
    embeds: [brandedEmbed(`${monitor.fullName} — refreshed`).setDescription(lines.join("\n"))],
  });
}

/** Renders a stored percentage, keeping "no data" distinct from 0%. */
function percentCell(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/**
 * Turns a refresh failure into something the person who ran `/github` can act on.
 *
 * The two causes worth naming are the ones the code can tell apart from the outside:
 * a database that has not been migrated (the tables are missing), and a schema the
 * running client does not match. Everything else is reported by its message, which
 * is still more useful than "contact the team", and is truncated because an embed
 * description is not a log file.
 *
 * Nothing here can leak a secret: the errors that reach this point are Prisma and
 * HTTP failures, and the GitHub token never appears in their messages.
 */
export function explainRefreshFailure(error: unknown): string {
  const message = toError(error).message;

  // Checked before the table rule: a Prisma "column does not exist" message also
  // contains "does not exist in the current database", which would otherwise be
  // reported as a missing migration when the real fault is a stale client.
  if (/column .* does not exist|does not match the schema/i.test(message)) {
    return "the database schema and the built client disagree — rerun `npx prisma migrate deploy` and `npm run build`";
  }
  if (/does not exist in the current database|relation .* does not exist/i.test(message)) {
    return "the database is missing the V9 tables — run `npx prisma migrate deploy` on the host";
  }
  if (/can't reach database server|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return "the database is unreachable — check `DATABASE_URL` on the host";
  }
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

/**
 * Rebuilds just enough of a reading from a stored snapshot for the report builder.
 *
 * Deliberately partial: a snapshot keeps the section totals and percentages the
 * project published, not its per-library breakdown, so `/github status` shows the
 * headline numbers and leaves the library table to the hourly report, which has
 * the live reading. Nothing is recomputed to fill the gap.
 */
function progressFromSnapshot(snapshot: SnapshotRecord) {
  if (
    snapshot.state.libraryPercent === null ||
    snapshot.state.shaderPercent === null ||
    snapshot.state.librariesDone === null ||
    snapshot.state.librariesTotal === null ||
    snapshot.state.shadersDone === null ||
    snapshot.state.shadersTotal === null
  ) {
    return null;
  }
  return {
    libraries: {
      done: snapshot.state.librariesDone,
      total: snapshot.state.librariesTotal,
      percent: snapshot.state.libraryPercent,
      groups: [],
    },
    shaders: {
      done: snapshot.state.shadersDone,
      total: snapshot.state.shadersTotal,
      percent: snapshot.state.shaderPercent,
      groups: [],
      extra: [],
    },
  };
}

/** Re-exported so the history command's formatting is testable. */
export { percentCell, progressFromSnapshot };

