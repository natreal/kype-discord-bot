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
});

/** Nested anti-nuke thresholds. */
const antiNukeSchema = z.object({
  enabled: z.boolean().default(false),
  actionThreshold: z.number().int().min(1).max(100).default(5),
  windowSeconds: z.number().int().min(5).max(3600).default(60),
});

/** Logging module configuration (channels are resolved or created by setup). */
export const loggingConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    channelId: snowflakeSchema.nullable().default(null),
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
  }),
);

/** Ticket module configuration. */
export const ticketConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    categoryId: snowflakeSchema.nullable().default(null),
    staffRoleId: snowflakeSchema.nullable().default(null),
  }),
);

/** Automation module configuration. */
export const automationConfigSchema = nested(
  z.object({
    enabled: z.boolean().default(false),
    timezone: z.string().trim().min(1).default("UTC"),
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

/** Orchestration state of the automatic setup system. */
export const setupStateSchema = nested(
  z.object({
    completedSections: z.array(z.string()).default([]),
    resources: z.record(z.string(), z.string()).default({}),
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
  security: securityConfigSchema,
  ai: aiConfigSchema,
  tickets: ticketConfigSchema,
  automation: automationConfigSchema,
  members: memberConfigSchema,
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
