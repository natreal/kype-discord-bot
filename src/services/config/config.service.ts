/**
 * Centralized guild configuration service (V3).
 *
 * Rules enforced here so that no command or module has to:
 * - configuration is always guild-specific (keyed by `guildId`, never global);
 * - every read is validated and merged over safe defaults, and reports which
 *   values are defaults versus explicitly configured;
 * - every write is validated before it reaches the repository;
 * - every write is recorded as a revision and, where an actor is known, as an
 *   audit event;
 * - the guild row is created on demand (idempotent).
 *
 * Storage layout: V3 is authoritative in `guild_config_sections` (one row per
 * section, with `updatedBy`). `guild_settings.modules` from V1/V2 is written
 * through at the same time, so existing modules and operator tooling keep
 * observing a complete, valid configuration object — and so a V2-era stored
 * configuration is picked up transparently on first read.
 *
 * The database is reached only through `GuildConfigRepository`; commands and
 * modules never see Prisma from here.
 */
import { z } from "zod";

import type { DatabaseService } from "../database/index.js";
import type { Logger } from "../logger/index.js";
import type { AuditEventService } from "../audit/index.js";
import { ValidationError } from "../../utils/errors.js";
import { ConfigValidator, type ConfigValidationResult } from "./config.validator.js";
import {
  PrismaGuildConfigRepository,
  UNKNOWN_GUILD_NAME,
  type ConfigWriteActor,
  type GuildConfigRepository,
} from "./guild-config.repository.js";
import { defaultGuildConfig, guildConfigSchema, type GuildConfig } from "./guild-config.schema.js";
import { deepMerge, isPlainObject } from "./merge.js";

/**
 * The logging projection of a guild's configuration, readable synchronously.
 *
 * Exists solely so the Discord log sink — called from a synchronous `write` — can
 * resolve a channel without awaiting the database. Kept module-level rather than on
 * the service instance because the sink is registered on the platform logger, which
 * is constructed before any guild is read.
 */
const LOGGING_PROJECTION = new Map<
  string,
  {
    enabled: boolean;
    channelId: string | null;
    securityChannelId: string | null;
    events: Record<string, boolean>;
  }
>();

/**
 * @returns the cached logging configuration of a guild, or `null` when this process
 * has never read it.
 *
 * A `null` is not "logging is off": the caller falls back to resolving a channel by
 * the name `setup` created, which is what keeps logging working on a freshly
 * bootstrapped guild whose configuration has not been read yet.
 */
export function readCachedLogging(guildId: string): {
  enabled: boolean;
  channelId: string | null;
  securityChannelId: string | null;
  events: Record<string, boolean>;
} | null {
  return LOGGING_PROJECTION.get(guildId) ?? null;
}

/** Section names that may be updated independently. */
const CONFIG_SECTIONS = [
  "language",
  "logging",
  "moderation",
  "automod",
  "security",
  "ai",
  "tickets",
  "automation",
  "members",
  "maintenance",
  "setup",
] as const satisfies readonly (keyof GuildConfig)[];

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

/** Sections a command may change (`setup` is owned by the setup engine). */
export const WRITABLE_CONFIG_SECTIONS = [
  "language",
  "logging",
  "moderation",
  "automod",
  "security",
  "ai",
  "tickets",
  "automation",
  "members",
  "maintenance",
] as const satisfies readonly ConfigSection[];

export interface ConfigServiceOptions {
  readonly database: DatabaseService;
  readonly logger: Logger;
  /** Optional override so tests can supply an in-memory repository. */
  readonly repository?: GuildConfigRepository;
  /**
   * Optional audit trail. When omitted, configuration writes are still logged
   * through the structured logger but no audit row is written.
   */
  readonly audit?: AuditEventService;
}

export class ConfigService {
  private readonly database: DatabaseService;
  private readonly logger: Logger;
  private readonly repository: GuildConfigRepository;
  private readonly validator: ConfigValidator;
  private readonly audit: AuditEventService | undefined;

  /** V1-compatible constructor: `new ConfigService(database, logger)`. */
  public constructor(database: DatabaseService, logger: Logger);
  /** V3 constructor with repository/audit injection. */
  public constructor(options: ConfigServiceOptions);
  public constructor(databaseOrOptions: DatabaseService | ConfigServiceOptions, logger?: Logger) {
    const options: ConfigServiceOptions =
      logger === undefined
        ? (databaseOrOptions as ConfigServiceOptions)
        : { database: databaseOrOptions as DatabaseService, logger };
    this.database = options.database;
    this.logger = options.logger.child("config");
    this.repository =
      options.repository ?? new PrismaGuildConfigRepository(options.database.prisma);
    this.validator = new ConfigValidator();
    this.audit = options.audit;
  }

  /**
   * Returns the validated configuration for a guild.
   *
   * Missing guilds are created with safe defaults, so this method never fails
   * just because the bot has not seen the guild before.
   */
  public async get(guildId: string, guildName = UNKNOWN_GUILD_NAME): Promise<GuildConfig> {
    const { config } = await this.read(guildId, guildName);
    this.cacheLogging(guildId, config);
    return config;
  }

  /**
   * Retains the logging projection of a guild's configuration.
   *
   * The Discord log sink is called from the logger, whose `write` is synchronous by
   * contract, so it cannot await the database. Caching the two fields it needs —
   * the enabled flag and the two channel IDs — keeps the hot path free of I/O while
   * still letting `/settings` redirect the log stream immediately. Only this small
   * projection is kept: caching the whole configuration here would duplicate the
   * repository's own cache and could serve a value an administrator just changed.
   */
  private cacheLogging(guildId: string, config: GuildConfig): void {
    LOGGING_PROJECTION.set(guildId, {
      enabled: config.logging.enabled,
      channelId: config.logging.channelId,
      securityChannelId: config.logging.securityChannelId,
      // Copied rather than referenced: the projection must not alias the caller's
      // object, or a later in-place edit would mutate what the sink reads.
      events: { ...config.logging.events },
    });
  }

  /**
   * Returns the configuration *and* its provenance.
   *
   * `overriddenPaths` tells the command layer which values an administrator set
   * explicitly; `issues` reports stored values that had to fall back to defaults.
   */
  public async read(
    guildId: string,
    guildName = UNKNOWN_GUILD_NAME,
  ): Promise<ConfigValidationResult> {
    await this.repository.ensureGuild(guildId, guildName);
    return this.parseStored(guildId);
  }

  /**
   * Reads a guild's configuration without creating or touching its guild row.
   *
   * The interaction hot path uses this: autocomplete fires on every keystroke, and
   * learning whether a guild is in maintenance must not cost a `guilds` write each
   * time. A guild with no stored sections simply gets the defaults.
   */
  public async peek(guildId: string): Promise<GuildConfig> {
    const { config } = await this.parseStored(guildId);
    return config;
  }

  /** Lists, merges and validates the stored sections (shared by `read` and `peek`). */
  private async parseStored(guildId: string): Promise<ConfigValidationResult> {
    const stored = await this.repository.list(guildId);
    const entries = stored.length > 0 ? stored : await this.legacySections(guildId);

    const result = this.validator.parse(entries, guildId);
    for (const issue of result.issues) {
      this.logger.warn("Stored guild configuration required repair", { guildId, issue });
    }
    return result;
  }

  /** @returns the sections an administrator has explicitly configured. */
  public async configuredSections(guildId: string): Promise<readonly string[]> {
    const { configuredSections } = await this.read(guildId);
    return configuredSections;
  }

  /**
   * Merges a partial update into the stored configuration and persists it.
   *
   * @param actor Who is writing. Omitted for automatic writes (`system`).
   * @throws ValidationError when the update does not match the schema.
   */
  public async update(
    guildId: string,
    patch: Partial<GuildConfig>,
    actor?: ConfigWriteActor,
  ): Promise<GuildConfig> {
    const unknownKeys = Object.keys(patch).filter(
      (key) => !(CONFIG_SECTIONS as readonly string[]).includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new ValidationError(`Unknown configuration sections: ${unknownKeys.join(", ")}`, {
        guildId,
        unknownKeys,
      });
    }

    const before = await this.get(guildId);
    const merged = deepMerge(before, patch) as Record<string, unknown>;
    const validated = this.validator.validate(merged, guildId);

    const touched = Object.keys(patch) as ConfigSection[];
    for (const section of touched) {
      await this.repository.save(guildId, section, validated[section], actor ?? null);
      await this.appendRevision(guildId, section, before[section], validated[section], actor);
    }

    // V1/V2 compatibility: keep the generic key/value blob in sync so existing
    // readers (and operators inspecting the table) still see a full config.
    await this.writeLegacyConfig(guildId, validated);

    this.logger.info("Guild configuration updated", { guildId, sections: touched });
    // Keep the synchronous logging projection in sync so the Discord log sinks pick
    // up a new channel or a flipped `enabled` flag immediately, not on the next `get`.
    this.cacheLogging(guildId, validated);
    await this.recordAudit(guildId, touched, before, validated, actor);
    return validated;
  }

  /** Replaces the configuration of a single section. */
  public async updateSection<K extends ConfigSection>(
    guildId: string,
    section: K,
    value: GuildConfig[K],
    actor?: ConfigWriteActor,
  ): Promise<GuildConfig> {
    return this.update(guildId, { [section]: value }, actor);
  }

  /** Resets a guild to the default configuration (all sections). */
  public async reset(guildId: string, actor?: ConfigWriteActor): Promise<GuildConfig> {
    const before = await this.get(guildId);
    const defaults = defaultGuildConfig();

    for (const section of CONFIG_SECTIONS) {
      await this.repository.remove(guildId, section);
      await this.appendRevision(guildId, section, before[section], defaults[section], actor);
    }
    await this.writeLegacyConfig(guildId, defaults);

    this.logger.warn("Guild configuration reset to defaults", { guildId });
    this.cacheLogging(guildId, defaults);
    await this.recordAudit(guildId, [...CONFIG_SECTIONS], before, defaults, actor);
    return defaults;
  }

  /** Resets a single section to its defaults. */
  public async resetSection(
    guildId: string,
    section: ConfigSection,
    actor?: ConfigWriteActor,
  ): Promise<GuildConfig> {
    const before = await this.get(guildId);
    const defaults = defaultGuildConfig();

    await this.repository.remove(guildId, section);
    await this.appendRevision(guildId, section, before[section], defaults[section], actor);

    const config = { ...before, [section]: defaults[section] };
    await this.writeLegacyConfig(guildId, config);

    this.cacheLogging(guildId, config);
    await this.recordAudit(guildId, [section], before, config, actor);
    return config;
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
    return this.validator.validate(candidate, guildId);
  }

  /** Validates a single section value, throwing on failure. */
  public validateSection<K extends ConfigSection>(
    section: K,
    value: unknown,
    guildId = "unknown",
  ): GuildConfig[K] {
    return this.validator.validateSection(section, value, guildId);
  }

  /** @returns the changed leaf paths between two configurations. */
  public diff(before: unknown, after: unknown): string[] {
    return this.validator.diff(before, after);
  }

  /**
   * Reads a V2-era `guild_settings.modules` blob.
   *
   * Only used when no V3 section rows exist: an installation upgrading from V2
   * keeps its configuration instead of being silently reset to defaults.
   */
  private async legacySections(guildId: string): Promise<{ section: string; value: unknown }[]> {
    const settings = await this.database.prisma.guildSettings.findUnique({
      where: { guildId },
      select: { modules: true },
    });
    if (!isPlainObject(settings?.modules)) {
      return [];
    }
    return Object.entries(settings.modules)
      .filter(([section]) => (CONFIG_SECTIONS as readonly string[]).includes(section))
      .map(([section, value]) => ({ section, value }));
  }

  /** Appends a revision row. Failure is logged, never propagated. */
  private async appendRevision(
    guildId: string,
    section: string,
    before: unknown,
    after: unknown,
    actor: ConfigWriteActor | undefined,
  ): Promise<void> {
    try {
      await this.repository.appendRevision({
        guildId,
        section,
        before: before ?? null,
        after,
        actorId: actor?.id ?? null,
        actorKind: actor?.kind ?? "system",
      });
    } catch (error) {
      // History is valuable but must never block a legitimate configuration write.
      this.logger.warn("Failed to record a configuration revision", {
        guildId,
        section,
        error: String(error),
      });
    }
  }

  /** Records the audit event for a configuration write. */
  private async recordAudit(
    guildId: string,
    sections: readonly string[],
    before: GuildConfig,
    after: GuildConfig,
    actor: ConfigWriteActor | undefined,
  ): Promise<void> {
    if (!this.audit) {
      return;
    }
    await this.audit.record({
      guildId,
      action: "config.update",
      category: "config",
      severity: actor?.kind === "god" ? "privileged" : "info",
      actorId: actor?.id ?? null,
      actorKind: actor?.kind ?? "system",
      targetType: "guildConfig",
      targetId: guildId,
      outcome: "success",
      before: project(before, sections),
      after: project(after, sections),
      details: {
        sections: [...sections],
        changedPaths: this.validator.diff(before, after),
      },
    });
  }

  /**
   * Mirrors the configuration into `guild_settings.modules` (V1/V2 store).
   *
   * Best-effort by design: the V3 section rows are authoritative, and a failure
   * here must not fail a write that already succeeded.
   */
  private async writeLegacyConfig(guildId: string, config: GuildConfig): Promise<void> {
    try {
      await this.database.prisma.guildSettings.upsert({
        where: { guildId },
        update: { modules: config },
        create: { guildId, modules: config },
      });
    } catch (error) {
      this.logger.warn("Failed to mirror the configuration into guild_settings", {
        guildId,
        error: String(error),
      });
    }
  }
}

/** @returns only the requested sections of a configuration. */
function project(config: GuildConfig, sections: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const section of sections) {
    result[section] = config[section as keyof GuildConfig];
  }
  return result;
}
