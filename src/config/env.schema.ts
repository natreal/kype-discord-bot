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

/**
 * Treats `""` (a common `.env` placeholder) as "not provided".
 */
const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/** Deployment scopes a command deployment may target. */
export const DEPLOY_SCOPES = ["global", "global+guilds", "dev-guild"] as const;

export type DeployScope = (typeof DEPLOY_SCOPES)[number];

/**
 * A boolean written the way `.env` files actually write them.
 *
 * `z.coerce.boolean()` is wrong here: it treats the string `"false"` as truthy,
 * so a deployment that explicitly disables a feature would silently enable it.
 * Only the documented spellings are accepted, and anything else is a
 * configuration error rather than a guess.
 */
const booleanString = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .default("false")
  .transform((value) => ["true", "1", "yes", "on"].includes(value));

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

  /**
   * Whether the bot registers its slash commands by itself.
   *
   * The foundation deliberately deployed commands out of band
   * (`npm run deploy:commands`), which is correct for one server and untenable
   * for a bot distributed to many: nobody runs a script per installation. This
   * switch is the operator's choice between the two models, and it is read from
   * the environment so a deployment can change it without a code change.
   */
  COMMANDS_AUTO_DEPLOY: booleanString.default(false),

  /**
   * Which scopes an automatic (or scripted) deployment targets.
   *
   * Defaults to `global`, which registers each command once. `global+guilds` is
   * deliberately *not* the default: Discord keeps global and guild commands in
   * independent scopes and treats a name as unique only within a scope, so
   * publishing the same payload to both makes every command appear twice in every
   * server's picker. It remains available because per-guild registration is the
   * only way to get sub-hour propagation while iterating.
   */
  COMMANDS_DEPLOY_SCOPE: z.enum(DEPLOY_SCOPES).default("global"),

  /**
   * AI transport, model and budget configuration.
   *
   * Every key here is optional so a deployment that has no AI provider still
   * starts and runs at full capacity: the AI module degrades gracefully to
   * "IA non configurée" and the keyword agent stays inert. The foundation must
   * not make its availability depend on a third-party LLM being reachable.
   */

  /** OpenAI-compatible base URL (OpenAI, Azure, OpenRouter, Groq, Together, vLLM, Ollama). */
  AI_BASE_URL: optionalString
    .pipe(
      z
        .string()
        .url("AI_BASE_URL must be an absolute http(s) URL")
        .optional(),
    )
    .describe("OpenAI-compatible base URL like https://api.openai.com/v1."),

  /** API key for the provider. Masked by `redactConfig`; never logged. */
  AI_API_KEY: optionalString.describe("API key for the OpenAI-compatible provider."),

  /** Model for low-latency tasks (classification, summaries). */
  AI_MODEL_FAST: optionalString.describe("Model used for classification and summaries."),

  /** Model for the assistant and the keyword agent. */
  AI_MODEL_SMART: optionalString.describe("Model used for the assistant and agent."),

  /**
   * Hard, process-wide daily token budget. `0` means "unlimited".
   *
   * Read live so an operator can raise or drop the ceiling without a restart, and
   * so a runaway loop cannot burn through a paying account in a single night.
   */
  AI_DAILY_TOKEN_BUDGET: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Hard daily token budget across all requests (0 = unlimited)."),

  /**
   * Per-request timeout, in milliseconds.
   *
   * 60s, not 20s. `/ai ask` runs reasoning models (Gemini 2.5 and its peers emit
   * thinking tokens before the first visible token), and a 20s budget aborted
   * healthy requests mid-thought — showing up as `HTTP 408` on a setup that was
   * working. A shorter value is fine for a fast classification model, but the
   * default must not be the reason a correct prompt fails.
   */
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).default(60_000).describe(
    "Per-request timeout in milliseconds.",
  ),

  /** Global default keyword trigger; a guild may override it via `/ai trigger`. */
  AI_DEFAULT_TRIGGER: optionalString
    .pipe(z.string().min(1).max(32).default("kype"))
    .describe("Default keyword that wakes the agent (server-overridable)."),

  /**
   * Optional global persona/tone injected into the agent's system prompt (the
   * "voice" the assistant replies in). Free-form by design: the operator owns the
   * wording, so no register is hard-coded into the prompt.
   */
  AI_PERSONA: optionalString.describe("Default persona/tone added to the assistant system prompt."),

  /**
   * The GitHub repository the monitor watches, as `owner/name`.
   *
   * Empty (or absent) means "the AnyPS5 project", which is what this feature was
   * built for. It is configurable because the monitor itself is generic — it reads
   * `progress.json` from the project's Pages host and falls back to commits and
   * pull requests only — and because a fork or a mirror should be watchable
   * without a code change.
   */
  GITHUB_REPOSITORY: optionalString
    .pipe(
      z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, "must be written as owner/repository")
        .optional(),
    )
    .describe("Repository to monitor, as owner/repository."),

  /**
   * GitHub token.
   *
   * Optional, and the difference is a rate limit rather than a capability:
   * anonymous requests get 60/hour, a token gets 5,000. The job uses conditional
   * requests, so an unchanged repository costs almost nothing either way.
   *
   * A fine-grained token with no scopes is enough: everything read here is public.
   * It is a credential, so it is redacted from logs and diagnostics.
   */
  GITHUB_TOKEN: optionalString.describe("Optional GitHub token; raises the rate limit to 5,000/h."),

  /** Minutes between refreshes. The default matches AnyPS5's own CI cadence. */
  GITHUB_POLL_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_440)
    .default(60)
    .describe("How often the repository monitor refreshes, in minutes."),

  /**
   * Channel the hourly report is posted to.
   *
   * Empty means "record the history, post nothing". That is a real use — a bot
   * that keeps the statistics for `/github` without a notification channel — so it
   * is not an error, only a quieter deployment.
   */
  GITHUB_REPORT_CHANNEL_ID: optionalString
    .pipe(snowflake.optional())
    .describe("Discord channel that receives the hourly repository report."),
});

/** Parsed, validated environment variables. */
export type Env = z.output<typeof envSchema>;
/** Raw (pre-parse) environment variables as read from the process. */
export type RawEnv = z.input<typeof envSchema>;
