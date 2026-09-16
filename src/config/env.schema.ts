import { z } from "zod";

/** Supported runtime environments. */
export const ENVIRONMENTS = ["development", "test", "production"] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

/** Supported log levels. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A Discord snowflake: a non-empty sequence of digits.
 *
 * Discord IDs are never hardcoded in this project; they always come from the
 * environment or from the Discord API, and they are validated here.
 */
const snowflake = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, "must be a Discord snowflake (17-20 digits)");

/** Treats `""` (a common `.env` placeholder) as "not provided". */
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/**
 * Raw environment schema.
 *
 * Validated with Zod so that a misconfigured deployment fails immediately with
 * an actionable message instead of failing later at an unpredictable point.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(ENVIRONMENTS).default("development"),

  DISCORD_TOKEN: z
    .string()
    .trim()
    .min(1, "DISCORD_TOKEN is required (see .env.example)")
    .describe("Bot token used to authenticate with the Discord gateway."),

  DISCORD_CLIENT_ID: snowflake.describe(
    "Application ID used to register application (slash) commands.",
  ),

  DISCORD_DEV_GUILD_ID: optionalString
    .pipe(snowflake.optional())
    .describe(
      "Optional guild ID. When set, commands are registered in that guild for instant updates.",
    ),

  DATABASE_URL: z
    .string()
    .trim()
    .min(1, "DATABASE_URL is required (see .env.example)")
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      "must be a PostgreSQL connection string (postgresql://...)",
    )
    .describe("PostgreSQL connection string including credentials and database name."),

  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

/** Parsed, validated environment variables. */
export type Env = z.output<typeof envSchema>;
/** Raw (pre-parse) environment variables as read from the process. */
export type RawEnv = z.input<typeof envSchema>;
