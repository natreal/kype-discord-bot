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
import {
  buildGithubView,
  type GithubContext,
  type GithubPanel,
} from "../../modules/repository/github-view.js";
import {
  buildReportStats,
  reportWindowFor,
  REPORT_RANGES,
} from "../../modules/repository/repository-report.analytics.js";
import { renderReport } from "../../modules/repository/github-report.view.js";
import { renderView, type ReplyPayload } from "../../modules/repository/github-components.js";
import type { ChartStyle } from "../../modules/repository/repository-chart.js";
import type { RepositoryMonitorService } from "../../modules/repository/repository.service.js";

/**
 * Snapshots read per render.
 *
 * The storage window, not a display limit: the trend fields and the decomposition
 * want as much history as the monitor keeps, and each panel trims what it draws.
 */
const HISTORY_ROWS = 72;

/**
 * Rows `/github history` prints at most. The monitor records one snapshot an hour, so
 * 25 is "a day of history plus one" rather than the whole archive — an embed that grows
 * without bound is a message Discord eventually refuses. The window above is larger on
 * purpose: reading more history is what lets a trend see past the rows it prints.
 */
const HISTORY_LIMIT_MAX = 25;

/** Columns the graph draws: one per snapshot, at a width that fits a phone. */
const GRAPH_WIDTH = 24;

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
      withStyle(
        sub
          .setName("overview")
          .setDescription("Both sections, the pace and the library breakdown."),
      ),
    )
    .addSubcommand((sub) =>
      withStyle(sub.setName("libraries").setDescription("Every library, and how each one moved.")),
    )
    .addSubcommand((sub) =>
      sub.setName("timeline").setDescription("The last recorded readings, newest first."),
    )
    .addSubcommand((sub) =>
      withStyle(
        sub.setName("graph").setDescription("The implementation trend drawn as a text chart."),
      ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("why")
        .setDescription(
          "Explain why the library share moved — work, or newly discovered functions.",
        ),
    )
    .addSubcommand((sub) =>
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
    )
    .addSubcommand((sub) =>
      withStyle(
        sub
          .setName("report")
          .setDescription("A paged report over a window: counts, rates, review time, libraries.")
          .addStringOption((option) =>
            option
              .setName("range")
              .setDescription("How far back to report (default: 1 day).")
              .addChoices(...REPORT_RANGES.map((range) => ({ name: range.label, value: range.id }))),
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
 * The whole history is read at once and handed to the view, which decides what each
 * panel needs: the overview wants the latest two readings, the graph wants the
 * window, `why` wants the last comparable pair. Fetching per panel would put that
 * choice in two places and let them drift.
 */
async function handlePanel(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
  panel: GithubPanel,
): Promise<void> {
  const style = readStyle(interaction);
  const history = await monitor.history(HISTORY_ROWS);
  // Asked for in parallel with nothing else: the feed is cached for two minutes and
  // has its own deadline, so this costs a reply nothing when GitHub is slow.
  const live = await monitor.liveFacts();
  const viewContext: GithubContext = {
    fullName: monitor.fullName,
    repoUrl: `https://github.com/${monitor.fullName}`,
    history,
    latest: history.at(-1) ?? null,
    panel,
    style,
    width: GRAPH_WIDTH,
    // Null, not thrown, when the interaction carries no user: the id only gates the
    // panel buttons a reader may press, and a missing one should cost those buttons
    // rather than the whole answer.
    ownerId: interaction.user?.id ?? null,
    // Omitted rather than `null` when the deployment has no feed: the view treats a
    // missing value as "not asked" and a `null` as "GitHub did not answer", so the two
    // cannot be confused in the reply.
    ...(live === undefined ? {} : { live }),
  };

  // A fresh watch is answered by the view itself, with an embed that explains why it
  // is empty instead of showing zeroes that would read as "nothing implemented".
  await respond(interaction, renderView(buildGithubView(viewContext)));
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
 * Replies with a rendered view.
 *
 * A Components V2 message holds forty components, and one panel is a container of
 * text blocks plus two rows, so the old "too many embeds" ceiling is gone: the viewer
 * no longer has to be told to pick a shorter panel. `renderView` refuses a text block
 * over Discord's limit rather than sending a payload that would be rejected whole.
 */
async function respond(
  interaction: ChatInputCommandInteraction,
  view: ReplyPayload,
): Promise<void> {
  await interaction.editReply({
    components: view.components,
    flags: MessageFlags.IsComponentsV2,
  });
}

/** `/github history` — one line per stored snapshot. */
async function handleHistory(
  interaction: ChatInputCommandInteraction,
  monitor: RepositoryMonitorService,
): Promise<void> {
  // Discord enforces the option's 1-25 range, but the value is still user input:
  // clamping here keeps "at most 25 rows" true for a stale client or a replayed
  // payload, and the fetch below is capped for the same reason.
  const requested = interaction.options.getInteger("limit") ?? 12;
  const limit = Math.min(requested, HISTORY_LIMIT_MAX);
  const history = (await monitor.history(HISTORY_LIMIT_MAX)).slice(-limit);
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

/** @returns a percentage, keeping "no reading" distinct from 0%. */
function percentCell(value: number | null): string {
  return value === null ? "—" : `${value}%`;
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
  const now = new Date();
  const window = reportWindowFor(rangeId, now);
  const data = await monitor.reportWindow(window.from, window.to);

  if (data.snapshots.length === 0 && data.pullRequests.length === 0) {
    await interaction.editReply({
      embeds: [
        brandedEmbed(`${monitor.fullName} — report`).setDescription(
          "Nothing is recorded in that window yet. The monitor fills in as it refreshes; " +
            "`/github refresh` takes a snapshot now.",
        ),
      ],
    });
    return;
  }

  const stats = buildReportStats({
    rangeId,
    window: { from: data.from, to: data.to },
    snapshots: data.snapshots,
    pullRequests: data.pullRequests,
    commits: data.commits.map((commit) => ({
      at: commit.committedAt,
      author: commit.author,
      message: commit.message,
    })),
  });

  await interaction.editReply({
    components: renderView(
      renderReport({
        stats,
        fullName: monitor.fullName,
        repoUrl: `https://github.com/${monitor.fullName}`,
        page: "overview",
      }),
    ).components,
    flags: MessageFlags.IsComponentsV2,
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
