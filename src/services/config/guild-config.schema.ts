/**
 * Guild configuration schema and defaults.
 *
 * Every module owns a section here. Values are validated by Zod before they are
 * persisted, so stored configuration can always be trusted.
 */
import { z } from "zod";

/**
 * Helper: a nested object whose default value is the complete set of defaults.
 *
 * Nested schemas declare their own field defaults, so `parse({})` yields a fully
 * populated value. The cast is unavoidable (Zod cannot narrow the output of a
 * generic object schema) and is deliberately confined to this one helper.
 */
const nested = <T extends z.ZodObject<z.ZodRawShape>>(schema: T): z.ZodDefault<T> =>
  schema.default((() => schema.parse({})) as () => never);

/** Discord snowflake validator reused across module schemas. */
export const snowflakeSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, "must be a Discord snowflake (17-20 digits)");

export const supportedLanguageSchema = z.enum(["en", "fr"]).default("en");

/** Nested logging event toggles. Declared separately so its defaults are typed. */
const logEventsSchema = z.object({
  memberJoin: z.boolean().default(true),
  memberLeave: z.boolean().default(true),
  messageDelete: z.boolean().default(true),
  messageEdit: z.boolean().default(true),
  roleChanges: z.boolean().default(true),
  channelChanges: z.boolean().default(true),
  moderation: z.boolean().default(true),
  security: z.boolean().default(true),
});

/** Nested anti-raid thresholds. */
const antiRaidSchema = z.object({
  enabled: z.boolean().default(false),
  joinsPerMinute: z.number().int().min(2).max(1000).default(10),
  minAccountAgeDays: z.number().int().min(0).max(365).default(7),
  /** Length of the burst window, in seconds. */
  windowSeconds: z.number().int().min(5).max(600).default(60),
  /** `Mention` a burst is considered a raid. `joinsPerMinute` remains the threshold. */
  burstThreshold: z.number().int().min(2).max(1000).default(10),
  /** Restrict newcomers until they confirm they are human. */
  verifyNewMembers: z.boolean().default(false),
  /** Seconds a raid mode lasts before it can recover automatically. */
  raidModeSeconds: z.number().int().min(30).max(86_400).default(600),
  /** Lock the server down automatically when a raid is detected. */
  lockdownOnRaid: z.boolean().default(true),
  /** Refuse accounts whose username matches a suspicious pattern. */
  suspiciousUsernameDetection: z.boolean().default(true),
});

/** Nested anti-nuke thresholds. */
const antiNukeSchema = z.object({
  enabled: z.boolean().default(false),
  actionThreshold: z.number().int().min(1).max(100).default(5),
  windowSeconds: z.number().int().min(5).max(3600).default(60),
  /** Strip permissions from the account responsible instead of only logging. */
  stripPermissions: z.boolean().default(true),
  /** Roles that are never considered a threat (bot's own roles, owners, ...). */
  whitelistRoleIds: z.array(snowflakeSchema).max(50).default([]),
  /** Users (including bots) that may act freely. */
  whitelistUserIds: z.array(snowflakeSchema).max(50).default([]),
  /** Alert a human when a nuke is stopped. */
  escalateToOwner: z.boolean().default(true),
});

/** Nested automod rule thresholds. */
const automodRulesSchema = z.object({
  antiSpam: z.boolean().default(false),
  antiFlood: z.boolean().default(false),
  antiMentionSpam: z.boolean().default(true),
  antiLink: z.boolean().default(false),
  antiInvite: z.boolean().default(true),
  antiCaps: z.boolean().default(false),
  antiRepeatedMessages: z.boolean().default(false),
  antiEmojiSpam: z.boolean().default(false),
  antiMassReactions: z.boolean().default(false),
});

/** Automod module configuration. */
export const automodConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    /** Delete the message that triggered a rule, when Discord permits it. */
    deleteTriggerMessages: z.boolean().default(true),
    /** Warn the author on the first trigger, then punish on repeats. */
    warnOnFirstTrigger: z.boolean().default(true),
    /** Sliding-window length shared by every rate-based rule, in seconds. */
    windowSeconds: z.number().int().min(2).max(300).default(10),
    rules: nested(automodRulesSchema),
    thresholds: nested(
      z.object({
        /** Messages per window before `anti-spam` fires. */
        spamMessages: z.number().int().min(2).max(100).default(5),
        /** Channels touched per window before `anti-flood` fires. */
        floodChannels: z.number().int().min(2).max(50).default(4),
        /** Mentions in a single message before `anti-mention-spam` fires. */
        mentions: z.number().int().min(2).max(50).default(5),
        /** Channel links in a single message before `anti-link` fires. */
        links: z.number().int().min(1).max(20).default(2),
        /** Minimum letters before caps are judged. */
        capsMinLength: z.number().int().min(4).max(100).default(10),
        /** Percentage of uppercase letters that counts as shouting. */
        capsPercent: z.number().int().min(50).max(100).default(70),
        /** Identical messages in a row before `anti-repeated-messages` fires. */
        repeatedMessages: z.number().int().min(2).max(20).default(3),
        /** Emojis in a single message before `anti-emoji-spam` fires. */
        emojis: z.number().int().min(3).max(100).default(8),
        /** Reactions added per window before `anti-mass-reactions` fires. */
        reactions: z.number().int().min(2).max(100).default(10),
      }),
    ),
    /** Escalation ladder: trigger count → action. Ordered, first match wins. */
    escalation: z
      .array(
        z.object({
          triggers: z.number().int().min(1).max(100),
          action: z.enum(["warn", "mute", "timeout", "none"]).default("warn"),
          durationMs: z
            .number()
            .int()
            .min(0)
            .max(28 * 24 * 60 * 60 * 1_000)
            .default(600_000),
        }),
      )
      .max(10)
      .default([
        { triggers: 1, action: "warn", durationMs: 0 },
        { triggers: 3, action: "mute", durationMs: 600_000 },
        { triggers: 5, action: "timeout", durationMs: 3_600_000 },
      ]),
  }),
);

/** Logging module configuration (channels are resolved or created by setup). */
export const loggingConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    channelId: snowflakeSchema.nullable().default(null),
    /**
     * Security log channel, kept separate from the moderation channel on purpose:
     * a raid alert mixed into the moderation stream is a raid nobody reads.
     * `setup` creates `#bot-security` and records its ID here.
     */
    securityChannelId: snowflakeSchema.nullable().default(null),
    events: nested(logEventsSchema),
  }),
);

/** Moderation module configuration. */
export const moderationConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(true),
    dmOnPunishment: z.boolean().default(true),
    warnThreshold: z.number().int().min(0).max(100).default(3),
    autoDeleteTriggerMessages: z.boolean().default(false),
  }),
);

/** Security module configuration (anti-raid / anti-nuke). */
export const securityConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    lockdown: z.boolean().default(false),
    antiRaid: nested(antiRaidSchema),
    antiNuke: nested(antiNukeSchema),
  }),
);

/** AI module configuration. AI never receives unrestricted Discord access. */
export const aiConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    assistantChannelId: snowflakeSchema.nullable().default(null),
    moderationAssist: z.boolean().default(false),
    maxRequestsPerHour: z.number().int().min(0).max(10_000).default(60),
    /**
     * The keyword that wakes the agent in this server, or `null` to inherit the
     * global `AI_DEFAULT_TRIGGER`. A guild that sets its own trigger takes over
     * from the default, so two servers can share one deployment with different
     * wake words without the operator editing environment variables.
     */
    trigger: z.string().trim().min(1).max(32).nullable().default(null),
    /**
     * Which tool surface the agent exposes. `strict` (~10 safe tools), `large`
     * (everything, including ban/kick/purge/permission changes) and `custom`
     * (only the categories the server ticked) — the value is a scope decision,
     * not a capability hint, so the menu is built from it deterministically.
     */
    mode: z.enum(["strict", "large", "custom"]).default("strict"),
    /** Tool categories enabled in `custom` mode; ignored elsewhere. */
    enabledCategories: z.array(z.string().trim().min(1)).max(50).default([]),
    /** Whether the guild-scoped memory is read and written by the assistant. */
    memoryEnabled: z.boolean().default(false),
    /**
     * Risk ceiling below which the agent may act on its own (0–100). At `0` —
     * the default — the agent only ever recommends and the deterministic layer
     * disposes via `ModerationService`; higher values widen auto-execution.
     */
    autoActThreshold: z.number().int().min(0).max(100).default(0),
  }),
);

/** Ticket module configuration. */
export const ticketConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    categoryId: snowflakeSchema.nullable().default(null),
    staffRoleId: snowflakeSchema.nullable().default(null),
    /**
     * How many tickets one member may keep open at once.
     *
     * The per-category rule (one open ticket per category) still applies; this is the
     * ceiling across every category, so a member cannot accumulate an unbounded pile of
     * private channels. The default of 3 matches the three categories setup seeds.
     */
    memberTicketLimit: z.number().int().min(1).max(25).default(3),
  }),
);

/**
 * Automation module configuration.
 *
 * Also the home of the bump reminder, because a bump reminder *is* automation: it
 * reacts to an event and acts later, without a member asking. Keeping it here rather
 * than in a `reminders` section avoids a second switch for the same idea, and keeps
 * `/settings` to one page for "things the bot does on its own".
 */
export const automationConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    timezone: z.string().trim().min(1).default("UTC"),
    /**
     * Whether a Disboard bump schedules a "bump again" reminder.
     *
     * Off by default: a server that never bumps should not discover the feature by
     * being pinged. Independent of `automation.enabled`, so an operator can use bump
     * reminders without switching on the rule engine. `bumpChannelId` is optional —
     * the channel the bump was posted in is used when it is unset.
     */
    bumpReminderEnabled: z.boolean().default(false),
    /**
     * How long after a bump the reminder fires, in seconds (default 2h, the Disboard
     * cooldown). A function rather than a literal so an operator can nudge it a minute
     * past the real cooldown, when Discord has already accepted the next bump.
     */
    bumpReminderDelaySeconds: z
      .number()
      .int()
      .min(60)
      .max(48 * 60 * 60)
      .default(2 * 60 * 60),
    /** Where the reminder is posted. `null` means "not configured yet". */
    bumpChannelId: snowflakeSchema.nullable().default(null),
    /**
     * Role pinged when the member who bumped has left, or `null`. Optional because a
     * small server may simply want the announcement in a channel.
     */
    bumpPingRoleId: snowflakeSchema.nullable().default(null),
    /**
     * Bot whose messages count as bumps.
     *
     * Configurable rather than hardcoded: Disboard has more than one bot id in the
     * wild (the staging instance, regional deployments), and a hardcoded id would
     * silently stop reminding servers the day Disboard changes it. The default is
     * Disboard's public bot.
     */
    bumpBotId: snowflakeSchema.default("302050872383242240"),
  }),
);

/**
 * Maintenance mode.
 *
 * A guild-scoped pause switch: while it is on, interactions and AI replies are
 * refused for everyone except the people who can turn it back off (God Access, the
 * guild owner, Administrators and `server.settings` holders). Automod, security and
 * moderation sweeps keep running — maintenance pauses *conversation*, not
 * protection.
 *
 * `until` is an ISO timestamp, like `setup.lastRunAt`, and the expiry is evaluated
 * on read. A bot that restarts mid-window therefore comes back with the remaining
 * window intact, with no scheduler row that could be lost.
 */
export const maintenanceConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    /** Free-text reason, shown to members who try to use the bot. */
    reason: z.string().trim().max(500).default(""),
    /** ISO timestamp of when maintenance began. */
    since: z.string().nullable().default(null),
    /** ISO timestamp for automatic resume; `null` means "until turned off". */
    until: z.string().nullable().default(null),
    /** Discord user ID that enabled maintenance. */
    by: snowflakeSchema.nullable().default(null),
  }),
);

/** Member-scoped configuration (welcome messages, default roles). */
export const memberConfigSchema = nested(
  z.object({
    welcomeEnabled: z.boolean().default(false),
    welcomeChannelId: snowflakeSchema.nullable().default(null),
    welcomeMessage: z.string().trim().max(2_000).default("Welcome {user} to {guild}!"),
    autoRoleIds: z.array(snowflakeSchema).max(25).default([]),
  }),
);

/**
 * Orchestration state of the automatic setup system.
 *
 * `resources` is retained for backwards compatibility and operator visibility;
 * the authoritative resource identity lives in the `setup_resources` table
 * (`SetupResourceService`), because names change and a flat JSON map cannot
 * answer "which guild/key does this Discord ID belong to?".
 */
export const setupStateSchema = nested(
  z.object({
    completedSections: z.array(z.string()).default([]),
    resources: z.record(z.string(), z.string()).default({}),
    /** Channels created by the auto-setup system, included in every run. */
    grantedResourceKeys: z.array(z.string()).default([]),
    lastRunAt: z.string().nullable().default(null),
  }),
);

/**
 * Complete guild configuration.
 *
 * `setup` is the orchestration state of the automatic setup system: which
 * sections have already been applied, and the IDs of the resources it created.
 */
export const guildConfigSchema = z.object({
  language: supportedLanguageSchema,
  logging: loggingConfigSchema,
  moderation: moderationConfigSchema,
  automod: automodConfigSchema,
  security: securityConfigSchema,
  ai: aiConfigSchema,
  tickets: ticketConfigSchema,
  automation: automationConfigSchema,
  members: memberConfigSchema,
  maintenance: maintenanceConfigSchema,
  setup: setupStateSchema,
});

/** Fully parsed guild configuration. */
export type GuildConfig = z.output<typeof guildConfigSchema>;

/** Sections that the automatic setup system orchestrates. */
export const SETUP_SECTIONS = [
  "core",
  "logging",
  "moderation",
  "security",
  "tickets",
  "ai",
] as const;

export type SetupSection = (typeof SETUP_SECTIONS)[number];

/** Baseline configuration applied to every guild the bot joins. */
export function defaultGuildConfig(): GuildConfig {
  return guildConfigSchema.parse({});
}
