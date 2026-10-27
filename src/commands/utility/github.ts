/**
 * `/github` — the watched repository's implementation statistics.
 *
 *   /github                    — the overview, with buttons for the other panels
 *   /github libraries          — every library, and how each one moved
 *   /github timeline           — the last readings, newest first
 *   /github graph              — the trend drawn as a text chart
 *   /github why                — why the share moved: work, or new discoveries
 *   /github history [limit]    — the recorded snapshots, oldest first (12 by default,
 *                                25 at most)
 *   /github report [range]     — a paged report over 4h, 12h, 1d, 3d or 7d: counts,
 *                                rates, review time, the hour-by-hour series, the
 *                                libraries that moved, and how complete the data is
 *   /github refresh            — take a snapshot now instead of waiting for the hourly
 *                                task
 *
 * Every number shown is read from the project's own published `progress.json`,
 * stored verbatim by the monitor; this command only formats what is already in
 * the database, so it works with no network access, never disagrees with the
 * hourly report, and cannot recompute a percentage differently from the project.
 *
 * The rendering lives in `modules/repository/github-view.ts`, which returns plain
 * data. This file is the adapter: fetch the history, hand it over, and convert the
 * result into discord.js builders.
 */
import {
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandSubcommandBuilder,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { AppError, toError } from "../../utils/errors.js";
import type { GithubPanel } from "../../modules/repository/github-view.js";
import {
  REPORT_RANGES,
  type ReportRangeId,
} from "../../modules/repository/repository-report.analytics.js";
import { PANEL_WINDOWS, panelWindow } from "../../modules/repository/repository-window.js";
import {
  GRAPH_WIDTH,
  renderGithubHistoryRows,
  renderGithubPanel,
  renderGithubReport,
  type GithubAnswer,
} from "../../modules/repository/github-request.js";
import type { ChartStyle } from "../../modules/repository/repository-chart.js";
import type { RepositoryMonitorService } from "../../modules/repository/repository.service.js";

/**
 * Rows `/github history` prints at most. The monitor records one snapshot an hour, so
 * 25 is "a day of history plus one" rather than the whole archive — an embed that grows
 * without bound is a message Discord eventually refuses. `renderGithubHistory` reads the
 * full window on purpose: reading more history is what lets a trend see past the rows
 * it prints, and it trims to the limit itself.
 */
const HISTORY_LIMIT_MAX = 25;

/** Panels that are their own subcommand, and the option that pins one. */
const PANEL_CHOICES: readonly { readonly name: string; readonly value: GithubPanel }[] = [
  { name: "overview", value: "overview" },
  { name: "libraries", value: "libraries" },
  { name: "timeline", value: "timeline" },
  { name: "graph", value: "graph" },
  { name: "why", value: "why" },
];

/**
 * @returns `style` added to `sub`, typed as the two chart styles readers pick.
 *
 * `bars` draws columns against a labelled 0–100% scale, so the distance to done is
 * honest; `line` shapes blocks against the window's own range, so a slow climb stays
 * visible. There is no free-form width option: the width is how much history fits.
 */
function withStyle(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub.addStringOption((option) =>
    option
      .setName("style")
      .setDescription("How to draw the trend chart (default: line).")
      .addChoices(
        { name: "bars · columns on a labelled scale", value: "bars" },
        { name: "line · columns scaled to the window", value: "line" },
      ),
  );
}

/**
 * @returns `sub` with a `window` choice: how far back the panel reads.
 *
 * On every panel subcommand rather than one global option, because it is the panels that
 * read a series; `history` and `refresh` are not asking the same question and would
 * either ignore it or silently change what they list.
 */
function withWindow(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub.addStringOption((option) =>
    option
      .setName("window")
      .setDescription("How far back to read, and how finely to average (default: 15m).")
      .addChoices(...PANEL_WINDOWS.map((window) => ({ name: window.label, value: window.id }))),
  );
}

/**
 * @returns `sub` with a `private` flag that hides the answer from the channel.
 *
 * The panels are project statistics, and the default is now to keep them to the
 * invoker: a reader checking a number usually wants the number, not to bury the
 * conversation under a table they did not ask the channel for. `private:false` is
 * the opt-in for posting one to everyone, which is what a public project feed does.
 * Deciding per invocation, rather than deployment-wide, is what lets the same command
 * serve both: the buttons inside an ephemeral answer keep working because Discord
 * keeps that message for the invoker.
 */
function withVisibility(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return sub.addBooleanOption((option) =>
    option
      .setName("private")
      .setDescription("Only you see the answer (default). Set false to post it to the channel."),
  );
}

export default defineSlashCommand({
  meta: {
    name: "github",
    description: "Show the implementation progress of the watched GitHub project.",
    category: "utility",
    usage: "/github [overview|libraries|timeline|graph|why|history|report|refresh]",
    examples: [
      "/github",
      "/github graph style:bars",
      "/github why",
      "/github history limit:12",
      "/github report",
      "/github report range:4h",
    ],
  },
  // `status` and `history` only read stored snapshots, so the command declares no
  // permission of its own: they stay open to every member, the way `/ticket open` is.
  // `refresh` writes a snapshot and can post to the report channel, so it escalates to
  // `server.settings` inside its own handler — `core.use` here would have made the two
  // read-only subcommands staff-only as well, which they are not meant to be.
  permissions: {},
  data: new SlashCommandBuilder()
    .setName("github")
    .setDescription("Show the implementation progress of the watched GitHub project.")
    .addSubcommand((sub) =>
      withVisibility(
        withStyle(
          withWindow(
            sub
              .setName("overview")
              .setDescription("Both sections, the pace and the library breakdown."),
          ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        withStyle(
          withWindow(
            sub.setName("libraries").setDescription("Every library, and how each one moved."),
          ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        withWindow(
          sub.setName("timeline").setDescription("The last recorded readings, newest first."),
        ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        withStyle(
          withWindow(
            sub
              .setName("graph")
              .setDescription("The implementation trend drawn as a text chart."),
          ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        withWindow(
          sub
            .setName("why")
            .setDescription(
              "Explain why the library share moved — work, or newly discovered functions.",
            ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        sub
          .setName("history")
          .setDescription("The raw stored snapshots, oldest first.")
          .addIntegerOption((option) =>
            option
              .setName("limit")
              .setDescription(`How many snapshots to list (1-${HISTORY_LIMIT_MAX}, default 12).`)
              .setMinValue(1)
              .setMaxValue(HISTORY_LIMIT_MAX),
          ),
      ),
    )
    .addSubcommand((sub) =>
      withVisibility(
        withStyle(
          sub
            .setName("report")
            .setDescription("A paged report over a window: counts, rates, review time, libraries.")
            .addStringOption((option) =>
              option
                .setName("range")
                .setDescription("How far back to report (default: 1 day).")
                .addChoices(
                  ...REPORT_RANGES.map((range) => ({ name: range.label, value: range.id })),
                ),
            ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      sub.setName("refresh").setDescription("Take a snapshot now, and announce what changed."),
    ),

  execute: async (interaction, context) => {
    // Discord gives an interaction three seconds to be acknowledged. `refresh` reads
    // the database and three HTTP sources, and `status`/`history` read the database,
    // so the answer has to be deferred first: without it `editReply` throws
    // `InteractionNotReplied` and the user is told the application did not respond.
    //
    // Deliberately *not* deferred as Components V2: `refresh`, `history` and the error
    // paths reply with an embed, and a V2 message cannot carry one. Only the panel path
    // sets the flag, on the edit that replaces this deferral.
    //
    // The visibility is read *before* the deferral, because the flag is part of the
    // acknowledgement: it cannot be changed on a later `editReply`.
    await interaction.deferReply({
      flags: isPrivate(interaction) ? MessageFlags.Ephemeral : undefined,
    });

    const monitor = context.repositoryMonitor;
    if (!monitor) {
      await interaction.editReply({
        embeds: [
          errorEmbed("GitHub monitor", "The repository monitor is not wired in this process."),
        ],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "refresh") {
      await handleRefresh(interaction, context, monitor);
      return;
    }
    if (subcommand === "history") {
      await handleHistory(interaction, monitor);
      return;
    }
    if (subcommand === "report") {
      await handleReport(interaction, monitor);
      return;
    }

    // Anything else is a panel; an unknown one falls back to the overview, which is
    // also what a bare `/github` shows without needing a default subcommand.
    const panel = PANEL_CHOICES.find((choice) => choice.value === subcommand)?.value ?? "overview";
    await handlePanel(interaction, monitor, panel);
  },
});

/**
 * Renders one panel and replies with it.
 *
 * The reading and the building live in `renderGithubPanel`, which `!g` also calls:
 * one renderer is what keeps a typed panel identical to a clicked one.
 */
async function handlePanel(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
  panel: GithubPanel,
): Promise<void> {
  await respond(
    interaction,
    await renderGithubPanel({
      monitor,
      panel,
      style: readStyle(interaction),
      // Null, not thrown, when the interaction carries no user: the id only gates the
      // panel buttons a reader may press, and a missing one should cost those buttons
      // rather than the whole answer.
      ownerId: interaction.user?.id ?? null,
      width: GRAPH_WIDTH,
      // The window is read from the same option on every panel subcommand, so a reader
      // who picks "1 hour · averaged" gets it on whichever panel they then look at.
      window: panelWindow(interaction.options.getString("window")).id,
      // Asked through the shared renderer so `/github` and `!g` show the same live
      // fields: the feed is cached for two minutes and has its own deadline, so this
      // costs a reply nothing when GitHub is slow.
      live: "fetch",
    }),
  );
}

/**
 * @returns the chart style the caller asked for, defaulting to `line`.
 *
 * Defaulted rather than required because most readers arrive from the buttons, and a
 * line-style chart reads better than bars at the width a phone gives a code block.
 */
function readStyle(interaction: ChatInputCommandInteraction): ChartStyle {
  const choice = interaction.options.getString("style");
  return choice === "bars" ? "bars" : "line";
}

/**
 * @returns true when this invocation should be answered privately.
 *
 * `refresh` has no `private` option — it is a staff action whose result is a single
 * line — so a missing option reads as `true`, which is the ephemeral default the
 * panels use. Reading it through the option name rather than the subcommand keeps
 * one rule for every subcommand: nothing this command says reaches the channel
 * unless the invoker asked for it.
 */
function isPrivate(interaction: ChatInputCommandInteraction): boolean {
  return interaction.options.getBoolean("private") ?? true;
}

/**
 * Replies with a rendered answer.
 *
 * A Components V2 message holds forty components, and one panel is a container of
 * text blocks plus two rows, so the old "too many embeds" ceiling is gone: the viewer
 * no longer has to be told to pick a shorter panel. `renderView` refuses a text block
 * over Discord's limit rather than sending a payload that would be rejected whole.
 *
 * An answer that is prose — an empty window, a help list — keeps the embed shape the
 * deferral already assumed, because that is what a single line of text is best
 * carried by.
 */
async function respond(
  interaction: ChatInputCommandInteraction,
  answer: GithubAnswer,
  title = "GitHub monitor",
): Promise<void> {
  if (answer.kind === "text") {
    await interaction.editReply({ embeds: [brandedEmbed(title).setDescription(answer.text)] });
    return;
  }
  await interaction.editReply({
    components: answer.payload.components,
    flags: MessageFlags.IsComponentsV2,
  });
}

/** `/github history` — one line per stored snapshot. */
async function handleHistory(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
): Promise<void> {
  // Discord enforces the option's 1-25 range, but the value is still user input:
  // clamped here keeps "at most 25 rows" true for a stale client or a replayed
  // payload, and the shared renderer clamps again for `!g history`.
  const requested = interaction.options.getInteger("limit") ?? 12;
  const limit = Math.min(requested, HISTORY_LIMIT_MAX);
  // The read is capped at the ceiling rather than at the requested count, so one query
  // serves every limit; the rows printed are then the last `limit` of them.
  const history = (await monitor.history(HISTORY_LIMIT_MAX)).slice(-limit);
  // An empty watch has its own sentence rather than a blank embed: `setDescription`
  // refuses an empty string, and "nothing recorded" is a real state worth naming.
  const lines =
    history.length === 0
      ? "Nothing recorded yet. Run `/github refresh` to take the first snapshot."
      : renderGithubHistoryRows(history);

  await interaction.editReply({
    embeds: [
      brandedEmbed(`${monitor.fullName} — ${history.length} snapshot(s)`)
        .setDescription(lines)
        .setFooter({
          text: "Percentages are the project's published figures, stored per refresh.",
        }),
    ],
  });
}

/**
 * `/github report` — a paged report over the window the reader asked for.
 *
 * Read-only, like the panels: every figure comes from what the monitor already stored,
 * so running it costs one database read and no GitHub request. That is deliberate — a
 * report that fetched would spend rate limit on data the bot has already paid for.
 */
async function handleReport(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
): Promise<void> {
  const rangeId = interaction.options.getString("range") ?? "1d";
  const answer = await renderGithubReport({
    monitor,
    range: rangeId as ReportRangeId,
  });
  await respond(interaction, answer, `${monitor.fullName} — report`);
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
        errorEmbed(
          "GitHub monitor",
          "Taking a snapshot requires the `server.settings` permission.",
        ),
      ],
    });
    return;
  }

  const report = await monitor.refresh().catch((error: unknown) => {
    // The generic handler would answer "contact the team", which tells an operator
    // nothing and leaves a broken deployment looking like a bot bug. Reading the
    // snapshot touches the database and three HTTP sources, so the failure is almost
    // always one of two things an operator can act on, and saying which costs nothing.
    throw new AppError(
      `GitHub monitor could not record a snapshot: ${explainRefreshFailure(error)}`,
      {
        code: "REPOSITORY_REFRESH_FAILED",
        expected: true,
        cause: error,
      },
    );
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
