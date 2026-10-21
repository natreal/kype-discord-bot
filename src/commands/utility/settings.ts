/**
 * `/settings` — guild configuration.
 *
 * A thin interface over `ConfigService`. Everything that matters (validation,
 * guild isolation, provenance, auditing) happens in the service; this file only
 * maps Discord options onto a validated patch and renders the result.
 *
 * Shape: one command with a small number of subcommands plus an "area" option,
 * never fifty top-level commands.
 *   /settings view   [area]
 *   /settings set    area option value
 *   /settings reset  [area]
 *
 * The option set is deliberately narrow in V3: it proves the infrastructure end
 * to end (validate → authorize → persist → audit) for the sections that already
 * exist, without inventing configuration for modules that do not.
 */
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

import { defineSlashCommand } from "../define.js";
import type { CommandExecutionContext } from "../context.js";
import { brandedEmbed, errorEmbed } from "../../utils/presenters.js";
import { ValidationError } from "../../utils/errors.js";
import type { ConfigWriteActor } from "../../services/config/index.js";
import { hasGodAccess } from "../../services/authorization/index.js";
import { replyWithModerationView } from "./settings-moderation.js";
import { replyWithSecurityView } from "./settings-security.js";

/** Configuration areas that V5 exposes, with their user-facing labels. */
const AREAS = [
  "language",
  "logging",
  "moderation",
  "automod",
  "security",
  "members",
  "tickets",
  "automation",
] as const;

type Area = (typeof AREAS)[number];

/**
 * The concrete settings a `/settings set` call can change. Exported so the
 * guidance test can assert that every `setting:…` the bot quotes is real.
 */
export const SETTINGS = [
  { name: "language", area: "language", description: "The language the bot replies in." },
  {
    name: "logging-enabled",
    area: "logging",
    description: "Whether the bot writes to the configured log channel.",
  },
  {
    name: "logging-member-join",
    area: "logging",
    description: "Log member join events.",
  },
  {
    name: "logging-member-leave",
    area: "logging",
    description: "Log member leave events.",
  },
  {
    name: "logging-channel",
    area: "logging",
    description: "The text channel where logs are posted (a channel ID).",
  },
  {
    name: "moderation-enabled",
    area: "moderation",
    description: "Whether moderation commands are available.",
  },
  {
    name: "moderation-warn-threshold",
    area: "moderation",
    description: "Warnings before an automatic action (0 disables it).",
  },
  {
    name: "moderation-dm-on-punishment",
    area: "moderation",
    description: "DM the affected member when they are punished.",
  },
  {
    name: "automod-enabled",
    area: "automod",
    description: "Whether automatic message rules are active.",
  },
  {
    name: "automod-delete-triggers",
    area: "automod",
    description: "Delete the message that triggered a rule.",
  },
  {
    name: "automod-warn-on-first-trigger",
    area: "automod",
    description: "Record a note on a member's first trigger.",
  },
  {
    name: "automod-window",
    area: "automod",
    description: "Length of the sliding window, in seconds.",
  },
  {
    name: "automod-anti-spam",
    area: "automod",
    description: "Detect too many messages in the window.",
  },
  {
    name: "automod-anti-flood",
    area: "automod",
    description: "Detect one account posting across many channels at once.",
  },
  {
    name: "automod-anti-mention-spam",
    area: "automod",
    description: "Detect too many mentions in one message.",
  },
  {
    name: "automod-anti-link",
    area: "automod",
    description: "Detect too many links in one message.",
  },
  {
    name: "automod-anti-invite",
    area: "automod",
    description: "Detect Discord invite links.",
  },
  {
    name: "automod-anti-caps",
    area: "automod",
    description: "Detect shouting: mostly uppercase text.",
  },
  {
    name: "automod-anti-repeated-messages",
    area: "automod",
    description: "Detect the same message posted over and over.",
  },
  {
    name: "automod-anti-emoji-spam",
    area: "automod",
    description: "Detect too many emojis in one message.",
  },
  {
    name: "automod-anti-mass-reactions",
    area: "automod",
    description: "Detect reaction spam.",
  },
  {
    name: "automod-spam-messages",
    area: "automod",
    description: "Messages per window before anti-spam fires.",
  },
  {
    name: "automod-mentions",
    area: "automod",
    description: "Mentions in one message before anti-mention-spam fires.",
  },
  {
    name: "automod-links",
    area: "automod",
    description: "Links in one message before anti-link fires.",
  },
  {
    name: "automod-repeated-messages",
    area: "automod",
    description: "Identical messages in a row before the rule fires.",
  },
  {
    name: "automod-emojis",
    area: "automod",
    description: "Emojis in one message before anti-emoji-spam fires.",
  },
  {
    name: "automod-reactions",
    area: "automod",
    description: "Reactions per window before anti-mass-reactions fires.",
  },
  {
    name: "security-enabled",
    area: "security",
    description: "Whether the security module is active.",
  },
  {
    name: "security-lockdown",
    area: "security",
    description: "Whether the server is currently in lockdown.",
  },
  {
    name: "security-anti-raid",
    area: "security",
    description: "Whether join-rate monitoring is active.",
  },
  {
    name: "security-joins-per-minute",
    area: "security",
    description: "Join-rate threshold per window.",
  },
  {
    name: "security-min-account-age-days",
    area: "security",
    description: "Accounts younger than this count as raid signatures.",
  },
  {
    name: "security-verify-new-members",
    area: "security",
    description: "Restrict newcomers until they confirm they are human.",
  },
  {
    name: "security-lockdown-on-raid",
    area: "security",
    description: "Lock the server down automatically when a raid is detected.",
  },
  {
    name: "security-anti-nuke",
    area: "security",
    description: "Whether destructive-action monitoring is active.",
  },
  {
    name: "security-nuke-threshold",
    area: "security",
    description: "Weight of destructive actions that trips anti-nuke.",
  },
  {
    name: "security-nuke-window",
    area: "security",
    description: "Anti-nuke observation window, in seconds.",
  },
  {
    name: "security-strip-permissions",
    area: "security",
    description: "Remove the culprit's permissions instead of only logging.",
  },
  {
    name: "welcome-enabled",
    area: "members",
    description: "Whether welcome messages are posted.",
  },
  {
    name: "welcome-message",
    area: "members",
    description: "The welcome message text ({user}, {guild}, {count}).",
  },
  {
    name: "welcome-channel",
    area: "members",
    description: "The text channel where welcome messages are posted (a channel ID).",
  },
  {
    name: "auto-roles",
    area: "members",
    description: "Roles granted to every new member (role IDs, space or comma separated).",
  },
  {
    name: "tickets-enabled",
    area: "tickets",
    description: "Whether the ticket system is available.",
  },
  {
    name: "tickets-category",
    area: "tickets",
    description: "The Discord category new ticket channels open in (a category ID).",
  },
  {
    name: "tickets-staff-role",
    area: "tickets",
    description: "The role that can see and handle tickets (a role ID).",
  },
  {
    name: "tickets-member-limit",
    area: "tickets",
    description: "How many open tickets one member may have at a time (1-25).",
  },
  {
    name: "automation-bump-reminder-enabled",
    area: "automation",
    description: 'Post a "bump again" reminder after a Disboard bump.',
  },
  {
    name: "automation-bump-reminder-delay",
    area: "automation",
    description: "Seconds after a bump before the reminder fires (60 to 172800).",
  },
  {
    name: "automation-bump-channel",
    area: "automation",
    description: "The channel the bump reminder is posted in (a channel ID).",
  },
  {
    name: "automation-bump-ping-role",
    area: "automation",
    description: "Role pinged with the bump reminder (a role ID, or empty for none).",
  },
] as const;

type SettingName = (typeof SETTINGS)[number]["name"];

/**
 * The label shown for a setting in the autocomplete list.
 *
 * The chosen `area` is already visible in the command, so a prefix of
 * `automod-`/`security-`/`moderation-` in front of every option is redundant: a
 * user picking `area:automod` does not need to read `automod-` fourteen times.
 * The label strips that prefix while the `value` keeps the full name the
 * persistence layer resolves against.
 */
function settingLabel(setting: (typeof SETTINGS)[number]): string {
  return setting.name.startsWith(`${setting.area}-`)
    ? setting.name.slice(setting.area.length + 1)
    : setting.name;
}

export default defineSlashCommand({
  meta: {
    name: "settings",
    description: "View or change this server's configuration.",
    category: "utility",
    usage: "/settings <view|set|reset>",
    examples: [
      "/settings view",
      "/settings set area:moderation setting:moderation-enabled value:false",
      "/settings set area:tickets setting:tickets-member-limit value:5",
    ],
  },
  permissions: {
    discord: [PermissionFlagsBits.ManageGuild],
    botPermissions: ["core.settings"],
  },
  // No `setDefaultMemberPermissions` here: visibility is left to the picker and the
  // actual gate is the runtime authorization above. Hiding the command from anyone
  // without `ManageGuild` produced "I can type `/settings` in one server but not
  // another" — a server where the caller's role is missing `ManageGuild` simply
  // erased the command from the picker, with no explainer, while every other admin
  // command (`/admin`, `/setup`) stayed visible and reported a clear denial.
  data: new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View or change this server's configuration.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("view")
        .setDescription("Show the configuration of this server.")
        .addStringOption((option) =>
          option
            .setName("area")
            .setDescription("Limit the view to one area (default: everything).")
            .addChoices(...AREAS.map((area) => ({ name: area, value: area }))),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Change one setting.")
        .addStringOption((option) =>
          option
            .setName("area")
            .setDescription("Which category the setting belongs to.")
            .setRequired(true)
            .addChoices(...AREAS.map((area) => ({ name: area, value: area }))),
        )
        .addStringOption((option) =>
          option
            .setName("setting")
            .setDescription("Which setting to change. Filtered by the category above.")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("The new value (text, number, true or false).")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("reset")
        .setDescription("Return one area, or the whole configuration, to its defaults.")
        .addStringOption((option) =>
          option
            .setName("area")
            .setDescription("Area to reset (default: everything).")
            .addChoices(...AREAS.map((area) => ({ name: area, value: area }))),
        ),
    ),

  execute: async (interaction, context) => {
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        embeds: [errorEmbed("Server only", "Configuration is stored per server.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const subcommand = interaction.options.getSubcommand();
    const actor = actorFor(context, interaction);

    if (subcommand === "view") {
      // The moderation and security areas get their operational view, not the raw
      // configuration dump: an administrator asking about them wants "is it working"
      // rather than a list of booleans.
      const area = interaction.options.getString("area");
      if (area === "moderation") {
        await replyWithModerationView(interaction, context);
        return;
      }
      if (area === "security") {
        await replyWithSecurityView(interaction, context);
        return;
      }
      await replyWithView(interaction, context, guild.id, guild.name);
      return;
    }

    if (subcommand === "reset") {
      await replyWithReset(interaction, context, guild.id, guild.name);
      return;
    }

    await replyWithSet(interaction, context, guild.id, guild.name, actor);
  },

  autocomplete: async (interaction) => {
    // The focused option. Only the `setting` option of `/settings set` has
    // autocomplete; anything else is answered with an empty list.
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "setting") {
      await interaction.respond([]);
      return;
    }

    const area = interaction.options.getString("area");
    const query = focused.value.trim().toLowerCase();

    const matches = SETTINGS.filter((setting) => {
      if (area && setting.area !== area) {
        return false;
      }
      const label = settingLabel(setting);
      return query.length === 0 || label.toLowerCase().includes(query);
    })
      .slice(0, 25)
      .map((setting) => ({ name: settingLabel(setting), value: setting.name }));

    await interaction.respond(matches);
  },
});

/**
 * Renders the guild configuration.
 *
 * Every displayed value is marked as default or explicitly configured, which is
 * the distinction the brief requires and V2 could not make.
 */
async function replyWithView(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  guildId: string,
  guildName: string,
): Promise<void> {
  const area = interaction.options.getString("area") as Area | null;
  const result = await context.config.read(guildId, guildName);

  if (!result.valid) {
    // Reported, not hidden: the guild is running on repaired values.
    context.logger.warn("Guild configuration required repair while being viewed", {
      guildId,
      issues: result.issues,
    });
  }

  const configured = new Set(result.configuredSections);
  const embed = brandedEmbed("Server settings").setFooter({ text: `Guild ${guildId}` });

  const sections = area ? [area] : Object.keys(result.config);
  for (const section of sections) {
    const value = result.config[section as keyof typeof result.config];
    embed.addFields({
      name: `${configured.has(section) ? "✎" : "•"} ${section}`,
      value: `\`\`\`json\n${truncate(JSON.stringify(value, null, 2), 1_000)}\n\`\`\``,
    });
  }

  embed.setDescription(
    [
      `Configured sections: **${result.configuredSections.length}** (marked ✎).`,
      "Everything else uses the bot's defaults (marked •).",
      result.valid ? "" : `⚠ Stored configuration needed repair: ${result.issues.join("; ")}`,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );

  await interaction.editReply({ embeds: [embed] });
}

/** Applies a `/settings set` call: parse, validate, persist, audit. */
async function replyWithSet(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  guildId: string,
  guildName: string,
  actor: ConfigWriteActor,
): Promise<void> {
  const name = interaction.options.getString("setting", true) as SettingName;
  const raw = interaction.options.getString("value", true);
  const area = interaction.options.getString("area");
  const setting = SETTINGS.find((candidate) => candidate.name === name);

  if (!setting) {
    await interaction.editReply({
      embeds: [errorEmbed("Unknown setting", `\`${name}\` is not a known setting.`)],
    });
    return;
  }

  // The autocomplete filters by area, but a crafted invocation could still name a
  // setting from another category: refuse it so configuration cannot be changed in
  // a category the operator did not select.
  if (area && setting.area !== area) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Wrong category",
          `\`${setting.name}\` belongs to the \`${setting.area}\` category, not \`${area}\`.`,
        ),
      ],
    });
    return;
  }

  const before = await context.config.get(guildId, guildName);
  const patch = buildPatch(setting.name, raw);

  let after;
  try {
    // The service validates before writing, so an invalid value never reaches the
    // database and the administrator gets a precise reason.
    after = await context.config.update(guildId, patch, actor);
  } catch (error) {
    const message =
      error instanceof ValidationError ? describeValidation(error) : "The value was rejected.";
    await interaction.editReply({ embeds: [errorEmbed("Invalid value", message)] });
    return;
  }

  const changed = context.config.diff(before, after);
  await interaction.editReply({
    embeds: [
      brandedEmbed("Setting updated")
        .setDescription(`\`${setting.name}\` is now \`${raw}\`.`)
        .addFields({
          name: "Changed",
          value: changed.length > 0 ? changed.map((path) => `\`${path}\``).join("\n") : "—",
        })
        .setFooter({ text: `Guild ${guildId}` }),
    ],
  });
}

/** Applies a `/settings reset` call. */
async function replyWithReset(
  interaction: ChatInputCommandInteraction,
  context: CommandExecutionContext,
  guildId: string,
  guildName: string,
): Promise<void> {
  const area = interaction.options.getString("area") as Area | null;
  // Resetting configuration is destructive and therefore restricted to the guild
  // owner (or the owner account), matching how Discord itself treats the action.
  const actor = actorFor(context, interaction);
  if (actor.kind !== "god" && interaction.guild?.ownerId !== interaction.user.id) {
    await interaction.editReply({
      embeds: [errorEmbed("Not allowed", "Only the server owner can reset configuration.")],
    });
    return;
  }

  if (area) {
    await context.config.resetSection(guildId, area, actor);
  } else {
    await context.config.reset(guildId, actor);
  }
  await context.config.ensureGuild(guildId, guildName);

  await interaction.editReply({
    embeds: [
      brandedEmbed("Settings reset")
        .setDescription(
          area
            ? `\`${area}\` has been returned to its default values.`
            : "Every area has been returned to its default values.",
        )
        .setFooter({ text: `Guild ${guildId}` }),
    ],
  });
}

/** Translates a setting name plus raw text into a validated patch. */
function buildPatch(name: SettingName, raw: string): Record<string, unknown> {
  switch (name) {
    case "language":
      return { language: raw.trim().toLowerCase() };
    case "logging-enabled":
      return { logging: { enabled: parseBoolean(raw) } };
    case "logging-member-join":
      return { logging: { events: { memberJoin: parseBoolean(raw) } } };
    case "logging-member-leave":
      return { logging: { events: { memberLeave: parseBoolean(raw) } } };
    case "moderation-enabled":
      return { moderation: { enabled: parseBoolean(raw) } };
    case "moderation-warn-threshold":
      return { moderation: { warnThreshold: parseNumber(raw) } };
    case "moderation-dm-on-punishment":
      return { moderation: { dmOnPunishment: parseBoolean(raw) } };
    case "automod-enabled":
      return { automod: { enabled: parseBoolean(raw) } };
    case "automod-delete-triggers":
      return { automod: { deleteTriggerMessages: parseBoolean(raw) } };
    case "automod-warn-on-first-trigger":
      return { automod: { warnOnFirstTrigger: parseBoolean(raw) } };
    case "automod-window":
      return { automod: { windowSeconds: parseNumber(raw) } };
    case "automod-anti-spam":
      return { automod: { rules: { antiSpam: parseBoolean(raw) } } };
    case "automod-anti-flood":
      return { automod: { rules: { antiFlood: parseBoolean(raw) } } };
    case "automod-anti-mention-spam":
      return { automod: { rules: { antiMentionSpam: parseBoolean(raw) } } };
    case "automod-anti-link":
      return { automod: { rules: { antiLink: parseBoolean(raw) } } };
    case "automod-anti-invite":
      return { automod: { rules: { antiInvite: parseBoolean(raw) } } };
    case "automod-anti-caps":
      return { automod: { rules: { antiCaps: parseBoolean(raw) } } };
    case "automod-anti-repeated-messages":
      return { automod: { rules: { antiRepeatedMessages: parseBoolean(raw) } } };
    case "automod-anti-emoji-spam":
      return { automod: { rules: { antiEmojiSpam: parseBoolean(raw) } } };
    case "automod-anti-mass-reactions":
      return { automod: { rules: { antiMassReactions: parseBoolean(raw) } } };
    case "automod-spam-messages":
      return { automod: { thresholds: { spamMessages: parseNumber(raw) } } };
    case "automod-mentions":
      return { automod: { thresholds: { mentions: parseNumber(raw) } } };
    case "automod-links":
      return { automod: { thresholds: { links: parseNumber(raw) } } };
    case "automod-repeated-messages":
      return { automod: { thresholds: { repeatedMessages: parseNumber(raw) } } };
    case "automod-emojis":
      return { automod: { thresholds: { emojis: parseNumber(raw) } } };
    case "automod-reactions":
      return { automod: { thresholds: { reactions: parseNumber(raw) } } };
    case "security-enabled":
      return { security: { enabled: parseBoolean(raw) } };
    case "security-lockdown":
      return { security: { lockdown: parseBoolean(raw) } };
    case "security-anti-raid":
      return { security: { antiRaid: { enabled: parseBoolean(raw) } } };
    case "security-joins-per-minute":
      return { security: { antiRaid: { burstThreshold: parseNumber(raw) } } };
    case "security-min-account-age-days":
      return { security: { antiRaid: { minAccountAgeDays: parseNumber(raw) } } };
    case "security-verify-new-members":
      return { security: { antiRaid: { verifyNewMembers: parseBoolean(raw) } } };
    case "security-lockdown-on-raid":
      return { security: { antiRaid: { lockdownOnRaid: parseBoolean(raw) } } };
    case "security-anti-nuke":
      return { security: { antiNuke: { enabled: parseBoolean(raw) } } };
    case "security-nuke-threshold":
      return { security: { antiNuke: { actionThreshold: parseNumber(raw) } } };
    case "security-nuke-window":
      return { security: { antiNuke: { windowSeconds: parseNumber(raw) } } };
    case "security-strip-permissions":
      return { security: { antiNuke: { stripPermissions: parseBoolean(raw) } } };
    case "welcome-enabled":
      return { members: { welcomeEnabled: parseBoolean(raw) } };
    case "welcome-channel":
      return { members: { welcomeChannelId: parseSnowflake(raw) } };
    case "auto-roles":
      return { members: { autoRoleIds: parseSnowflakeList(raw) } };
    case "logging-channel":
      return { logging: { channelId: parseSnowflake(raw) } };
    case "tickets-enabled":
      return { tickets: { enabled: parseBoolean(raw) } };
    case "tickets-category":
      return { tickets: { categoryId: parseSnowflake(raw) } };
    case "tickets-staff-role":
      return { tickets: { staffRoleId: parseSnowflake(raw) } };
    case "tickets-member-limit":
      return { tickets: { memberTicketLimit: parseNumber(raw) } };
    case "automation-bump-reminder-enabled":
      return { automation: { bumpReminderEnabled: parseBoolean(raw) } };
    case "automation-bump-reminder-delay":
      return { automation: { bumpReminderDelaySeconds: parseNumber(raw) } };
    case "automation-bump-channel":
      return { automation: { bumpChannelId: parseSnowflake(raw) } };
    case "automation-bump-ping-role": {
      // An empty value clears the ping, which is the common case: a server may want
      // the announcement without pinging anyone. `parseSnowflake` rejects empty input,
      // so `null` is handled before it rather than by loosening the parser.
      const trimmed = raw.trim();
      return {
        automation: { bumpPingRoleId: trimmed.length === 0 ? null : parseSnowflake(trimmed) },
      };
    }
    default:
      return { members: { welcomeMessage: raw } };
  }
}

/**
 * Parses a Discord snowflake from a raw ID or a channel/role mention.
 *
 * Accepts `123456789012345678`, `<#123456789012345678>` or `<@&123456789012345678>`
 * so a moderator can paste a mention Discord gives them. Rejects anything else,
 * matching the `snowflakeSchema` the config validator applies on write.
 */
function parseSnowflake(raw: string): string {
  const match = raw.trim().match(/(\d{17,20})/);
  if (!match) {
    throw new ValidationError(`Expected a Discord ID (a 17–20 digit number), received "${raw}"`, {
      value: raw,
    });
  }
  return match[1] as string;
}

/**
 * Parses a list of Discord snowflakes from raw text.
 *
 * Accepts the same forms as {@link parseSnowflake} — bare IDs, `<@&…>` role
 * mentions, `<#…>` channel mentions — separated by commas, spaces or newlines,
 * so an operator can paste several mentions straight from a message. An empty
 * value is allowed and clears the list, which is how `auto-roles` is reset
 * without touching the rest of the `members` section.
 */
function parseSnowflakeList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const ids = [...trimmed.matchAll(/\d{17,20}/g)].map((match) => match[0]);
  if (ids.length === 0) {
    throw new ValidationError(`Expected at least one Discord ID, received "${raw}"`, {
      value: raw,
    });
  }
  // De-duplicated while preserving order, so a pasted list never grants a role twice.
  return [...new Set(ids)];
}

/** Parses `true`/`false` (and the usual shorthands) strictly. */
function parseBoolean(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["true", "on", "yes", "y", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "off", "no", "n", "0"].includes(normalized)) {
    return false;
  }
  throw new ValidationError(`Expected a boolean value, received "${raw}"`, { value: raw });
}

/** Parses an integer, rejecting anything else. */
function parseNumber(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`Expected a whole number, received "${raw}"`, { value: raw });
  }
  return value;
}

/** @returns the validation issues as a compact, user-readable list. */
function describeValidation(error: ValidationError): string {
  const issues = error.metadata?.["issues"];
  if (!Array.isArray(issues)) {
    return error.message;
  }
  return issues
    .map((issue) => {
      const entry = issue as { path?: string; message?: string };
      return `\`${entry.path ?? "value"}\`: ${entry.message ?? "invalid"}`;
    })
    .join("\n");
}

/** @returns the audit actor for a write, distinguishing the owner account. */
function actorFor(
  context: CommandExecutionContext,
  interaction: ChatInputCommandInteraction,
): ConfigWriteActor {
  const markGod = hasGodAccess(interaction.user.id);
  if (markGod) {
    context.logger.warn("Configuration changed by the owner account", {
      guildId: interaction.guildId ?? "unknown",
      userId: interaction.user.id,
    });
  }
  return { id: interaction.user.id, kind: markGod ? "god" : "user" };
}

/** Truncates a string to a Discord-safe length. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
