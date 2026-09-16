/**
 * Centralized guild configuration service.
 *
 * Rules enforced here so that no command or module has to:
 * - configuration is always guild-specific,
 * - every read is validated and merged over safe defaults,
 * - every write is validated before it reaches the database,
 * - the guild row is created on demand (idempotent).
 */
import { z } from "zod";

import type { DatabaseService } from "../database/index.js";
import type { Logger } from "../logger/index.js";
import { ValidationError } from "../../utils/errors.js";
import { defaultGuildConfig, guildConfigSchema, type GuildConfig } from "./guild-config.schema.js";
import { deepMerge, isPlainObject } from "./merge.js";

/** Section names that may be updated independently. */
const CONFIG_SECTIONS = [
  "language",
  "logging",
  "moderation",
  "security",
  "ai",
  "tickets",
  "automation",
  "members",
  "setup",
] as const satisfies readonly (keyof GuildConfig)[];

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export class ConfigService {
  private readonly database: DatabaseService;
  private readonly logger: Logger;

  public constructor(database: DatabaseService, logger: Logger) {
    this.database = database;
    this.logger = logger.child("config");
  }

  /**
   * Returns the validated configuration for a guild.
   *
   * Missing guilds are created with safe defaults, so this method never fails
   * just because the bot has not seen the guild before.
   */
  public async get(guildId: string, guildName = "unknown"): Promise<GuildConfig> {
    const stored = await this.readStoredConfig(guildId, guildName);
    return this.parseOrDefaults(stored, guildId);
  }

  /**
   * Merges a partial update into the stored configuration and persists it.
   *
   * @throws ValidationError when the update does not match the schema.
   */
  public async update(guildId: string, patch: Partial<GuildConfig>): Promise<GuildConfig> {
    const unknownKeys = Object.keys(patch).filter(
      (key) => !(CONFIG_SECTIONS as readonly string[]).includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new ValidationError(`Unknown configuration sections: ${unknownKeys.join(", ")}`, {
        guildId,
        unknownKeys,
      });
    }

    const current = await this.get(guildId);
    const merged = deepMerge(current, patch) as Record<string, unknown>;
    const validated = this.validate(merged, guildId);

    await this.writeStoredConfig(guildId, validated);
    this.logger.info("Guild configuration updated", {
      guildId,
      sections: Object.keys(patch),
    });

    return validated;
  }

  /** Replaces the configuration of a single section. */
  public async updateSection<K extends ConfigSection>(
    guildId: string,
    section: K,
    value: GuildConfig[K],
  ): Promise<GuildConfig> {
    return this.update(guildId, { [section]: value });
  }

  /** Resets a guild to the default configuration. */
  public async reset(guildId: string): Promise<GuildConfig> {
    const defaults = defaultGuildConfig();
    await this.writeStoredConfig(guildId, defaults);
    this.logger.warn("Guild configuration reset to defaults", { guildId });
    return defaults;
  }

  /**
   * Ensures a guild exists in the database and holds valid configuration.
   *
   * Called from the `guildCreate` event and from the setup service. Idempotent.
   */
  public async ensureGuild(guildId: string, guildName: string): Promise<GuildConfig> {
    await this.database.upsertGuild({ id: guildId, name: guildName });
    return this.get(guildId, guildName);
  }

  /** Parses arbitrary stored JSON into a validated configuration. */
  public parseOrDefaults(stored: unknown, guildId = "unknown"): GuildConfig {
    const defaults = defaultGuildConfig();
    if (!isPlainObject(stored)) {
      return defaults;
    }
    try {
      return guildConfigSchema.parse(deepMerge(defaults, stored));
    } catch (error) {
      this.logger.warn("Stored configuration was invalid; falling back to defaults", {
        guildId,
        issues:
          error instanceof z.ZodError ? error.issues.map((issue) => issue.message) : String(error),
      });
      return defaults;
    }
  }

  /** Validates a complete configuration, throwing on failure. */
  public validate(candidate: unknown, guildId = "unknown"): GuildConfig {
    const result = guildConfigSchema.safeParse(candidate);
    if (!result.success) {
      throw new ValidationError("Guild configuration failed validation", {
        guildId,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }

  private async readStoredConfig(guildId: string, guildName: string): Promise<unknown> {
    await this.database.upsertGuild({ id: guildId, name: guildName });
    const settings = await this.database.prisma.guildSettings.findUnique({
      where: { guildId },
      select: { modules: true },
    });
    return settings?.modules ?? {};
  }

  private async writeStoredConfig(guildId: string, config: GuildConfig): Promise<void> {
    const record = this.database.prisma.guildSettings;
    await record.upsert({
      where: { guildId },
      update: { modules: config },
      create: { guildId, modules: config },
    });
  }
}
