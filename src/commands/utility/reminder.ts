/**
 * `/reminder` — personal timers.
 *
 *   /reminder set    duration text   — ping me here in <duration> about <text>
 *   /reminder list                   — what I have pending
 *   /reminder cancel id              — cancel one of mine
 *   /reminder clear                  — cancel all of mine
 *
 * Design choices worth stating:
 *
 * - **A reminder lands where it was set.** The channel is captured at creation, not
 *   resolved at fire time, so a member moving channels later does not move their
 *   reminder. DMs are not used: many members close them, and an undeliverable
 *   reminder is not a reminder.
 * - **A reminder belongs to the member who set it.** `list`, `cancel` and `clear` are
 *   scoped to the caller, so the command cannot be used to read or cancel somebody
 *   else's timers.
 * - **The list is read from the scheduler, not from a second table.** What `/reminder`
 *   shows is exactly what will fire, because it is the same pending queue the engine
 *   dispatches from.
 */
import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import {
  clampDurationSeconds,
  DurationParseError,
  parseDurationSeconds,
  REMINDER_DURATION_LIMITS,
} from "../../modules/reminders/reminder.time.js";
import { brandedEmbed, errorEmbed, formatDuration } from "../../utils/presenters.js";

/** Message text is capped well below Discord's limit, to keep the ping readable. */
const MAX_TEXT_LENGTH = 300;

export default defineSlashCommand({
  meta: {
    name: "reminder",
    description: "Set a timer and get pinged when it ends.",
    category: "utility",
    usage: "/reminder set duration text | list | cancel id | clear",
    examples: [
      "/reminder set duration:30m text:stretch",
      "/reminder set duration:1h30m text:check the oven",
      "/reminder list",
      "/reminder cancel id:12",
    ],
  },
  // `core.use` is the right gate: a personal timer is not a server setting, and every
  // member who may use the bot may use it.
  permissions: { custom: ["core.use"] },
  data: new SlashCommandBuilder()
    .setName("reminder")
    .setDescription("Set a timer and get pinged when it ends.")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Ping me in this channel after a delay.")
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("How long to wait: 30m, 1h30m, 2 days (1 minute to 30 days).")
            .setRequired(true)
            .setMaxLength(50),
        )
        .addStringOption((option) =>
          option
            .setName("text")
            .setDescription("What should I remind you about?")
            .setRequired(true)
            .setMaxLength(MAX_TEXT_LENGTH),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List my pending reminders."))
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("Cancel one of my reminders.")
        .addStringOption((option) =>
          option
            .setName("id")
            .setDescription("The reminder id shown by /reminder list.")
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("clear").setDescription("Cancel all my reminders.")),

  autocomplete: async (interaction, context) => {
    const guild = interaction.guild;
    if (!context.reminders || !guild) {
      await interaction.respond([]);
      return;
    }
    // Only the caller's own reminders: an id belonging to somebody else must not even
    // appear as a candidate.
    const pending = await context.reminders.list(guild.id, { userId: interaction.user.id });
    await interaction.respond(
      pending.slice(0, 25).map((reminder) => ({
        name: `${reminder.id.slice(0, 6)} — ${truncate(reminder.text)}`,
        value: reminder.id,
      })),
    );
  },

  execute: async (interaction, context) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.guild) {
      await interaction.editReply({
        embeds: [errorEmbed("Reminder", "This command only works inside a server.")],
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    switch (subcommand) {
      case "set":
        await handleSet(interaction, context);
        return;
      case "list":
        await handleList(interaction, context);
        return;
      case "cancel":
        await handleCancel(interaction, context);
        return;
      case "clear":
        await handleClear(interaction, context);
        return;
      default:
        await interaction.editReply({
          embeds: [errorEmbed("Reminder", `Unknown subcommand \`${subcommand}\`.`)],
        });
    }
  },
});

async function handleSet(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const service = context.reminders;
  if (!service || !interaction.guild) {
    await replyUnavailable(interaction);
    return;
  }

  const rawDuration = interaction.options.getString("duration", true);
  const text = interaction.options.getString("text", true).trim();
  if (text.length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed("Reminder", "Tell me what to remind you about.")],
    });
    return;
  }

  let seconds: number;
  try {
    const parsed = parseDurationSeconds(rawDuration);
    if (parsed === null) {
      // Parsing produced nothing recognisable: the most useful reply is the format,
      // not the parser's internals.
      throw new DurationParseError(
        "That does not look like a duration. Try `30m`, `1h30m` or `2 days`.",
      );
    }
    seconds = clampDurationSeconds(parsed);
  } catch (error) {
    if (!(error instanceof DurationParseError)) {
      throw error;
    }
    await interaction.editReply({
      embeds: [
        errorEmbed("Reminder", `${error.message}`).setFooter({
          text: `Supported range: 1 minute to ${REMINDER_DURATION_LIMITS.maxSeconds / 86_400} days.`,
        }),
      ],
    });
    return;
  }

  const created = await service.createPersonalReminder({
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    // Where the command was used, not a configured channel: the member asked here.
    channelId: interaction.channelId,
    text,
    delaySeconds: seconds,
  });

  const dueEpoch = Math.floor(created.dueAt.getTime() / 1_000);
  await interaction.editReply({
    embeds: [
      brandedEmbed("Reminder set").setDescription(
        [
          `I'll ping you <t:${dueEpoch}:R> (<t:${dueEpoch}:f>) in <#${created.channelId}>.`,
          `> ${text}`,
          "",
          "-# Setting the same reminder again replaces it. Cancel with `/reminder cancel`.",
        ].join("\n"),
      ),
    ],
  });
}

/** Reminder for the "feature not wired in this process" reply, shared by the handlers. */
async function replyUnavailable(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.editReply({
    embeds: [errorEmbed("Reminder", "Reminders are not available in this process.")],
  });
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const service = context.reminders;
  if (!service || !interaction.guild) {
    await replyUnavailable(interaction);
    return;
  }

  const pending = await service.list(interaction.guild.id, { userId: interaction.user.id });
  if (pending.length === 0) {
    await interaction.editReply({
      embeds: [
        brandedEmbed("Your reminders").setDescription(
          "Nothing pending. Set one with `/reminder set duration:30m text:…`.",
        ),
      ],
    });
    return;
  }

  const lines = pending.map((reminder) => {
    const dueEpoch = Math.floor(reminder.dueAt.getTime() / 1_000);
    const remaining = formatDuration(Math.max(0, reminder.dueAt.getTime() - Date.now()));
    return `\`${reminder.id.slice(0, 6)}\` <t:${dueEpoch}:R> (in ${remaining}) — ${truncate(reminder.text)}`;
  });

  await interaction.editReply({
    embeds: [
      brandedEmbed(`Your reminders (${pending.length})`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: "Cancel one with /reminder cancel id:<id>." }),
    ],
  });
}

async function handleCancel(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const service = context.reminders;
  if (!service || !interaction.guild) {
    await replyUnavailable(interaction);
    return;
  }

  const id = interaction.options.getString("id", true).trim();
  const cancelled = await service.cancel(interaction.guild.id, id, interaction.user.id);
  await interaction.editReply({
    embeds: [
      cancelled
        ? brandedEmbed("Reminder cancelled").setDescription("That timer will not fire.")
        : errorEmbed(
            "Reminder",
            "No pending reminder of yours matches that id. Check `/reminder list`.",
          ),
    ],
  });
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
): Promise<void> {
  const service = context.reminders;
  if (!service || !interaction.guild) {
    await replyUnavailable(interaction);
    return;
  }

  const count = await service.cancelAll(interaction.guild.id, interaction.user.id);
  await interaction.editReply({
    embeds: [
      brandedEmbed("Reminders cleared").setDescription(
        count === 0
          ? "You had no pending reminders."
          : `Cancelled ${count} reminder${count === 1 ? "" : "s"}.`,
      ),
    ],
  });
}

/** Shortens a reminder for one-line display without cutting a word in half. */
function truncate(text: string, limit = 60): string {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}…`;
}
