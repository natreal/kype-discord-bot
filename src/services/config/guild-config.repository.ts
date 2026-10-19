/**
 * Guild configuration persistence port and its Prisma implementation.
 *
 * The configuration service never touches Prisma directly: it depends on the
 * `GuildConfigRepository` port, so the whole configuration layer is testable
 * against an in-memory store and the database stays an implementation detail
 * (the same split `SetupResourceRepository` already uses).
 *
 * Two stores exist on purpose:
 * - `guild_config_sections` (V3) is authoritative: one validated row per section,
 *   which makes "who changed this section and when" answerable;
 * - `guild_settings.modules` (V1/V2) is kept in sync so existing modules and
 *   operators keep observing a complete configuration object.
 */
import type { PrismaDatabaseClient } from "../database/index.js";
import { toDatabaseError, toJson, toNullableJson } from "../database/index.js";

/** A stored configuration section, as returned by the repository. */
export interface ConfigSectionRecord {
  readonly guildId: string;
  readonly section: string;
  readonly value: unknown;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

/** Actor recorded with a configuration write. */
export interface ConfigWriteActor {
  /** Discord user ID, or `null` for automatic writes. */
  readonly id: string | null;
  /** `user`, `system` or `god`. */
  readonly kind: "user" | "system" | "god";
}

/** A revision entry appended whenever a section changes. */
export interface ConfigRevisionRecord {
  readonly guildId: string;
  readonly section: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly actorId: string | null;
  readonly actorKind: string;
}

export interface GuildConfigRepository {
  /** Creates the guild row when absent, so foreign keys always resolve. */
  ensureGuild(guildId: string, guildName: string): Promise<void>;
  list(guildId: string): Promise<ConfigSectionRecord[]>;
  find(guildId: string, section: string): Promise<ConfigSectionRecord | null>;
  /** Upserts one section. Idempotent for `(guildId, section)`. */
  save(
    guildId: string,
    section: string,
    value: unknown,
    actor: ConfigWriteActor | null,
  ): Promise<void>;
  /** Removes a section row, returning the guild to defaults for that section. */
  remove(guildId: string, section: string): Promise<void>;
  appendRevision(record: ConfigRevisionRecord): Promise<void>;
  listRevisions(guildId: string, limit: number): Promise<ConfigRevisionRecord[]>;
}

/**
 * Placeholder name used when a caller only has a guild ID.
 *
 * Treating it as a *real* name would be destructive: `ConfigService.get(guildId)`
 * is called from interaction paths, and the repository's upsert would otherwise
 * rename the guild to "unknown" on every read.
 */
export const UNKNOWN_GUILD_NAME = "unknown";

/** JSON value accepted by Prisma's `Json` columns. */
export class PrismaGuildConfigRepository implements GuildConfigRepository {
  private readonly prisma: PrismaDatabaseClient;

  public constructor(prisma: PrismaDatabaseClient) {
    this.prisma = prisma;
  }

  public async ensureGuild(guildId: string, guildName: string): Promise<void> {
    try {
      await this.prisma.guild.upsert({
        where: { id: guildId },
        // Only a caller that actually knows the name may update it. An interaction
        // path that passes the placeholder must leave display data untouched.
        update: guildName === UNKNOWN_GUILD_NAME ? {} : { name: guildName },
        create: { id: guildId, name: guildName },
      });
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.ensureGuild");
    }
  }

  public async list(guildId: string): Promise<ConfigSectionRecord[]> {
    try {
      const rows = await this.prisma.guildConfigSection.findMany({ where: { guildId } });
      return rows.map(toRecord);
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.list");
    }
  }

  public async find(guildId: string, section: string): Promise<ConfigSectionRecord | null> {
    try {
      const row = await this.prisma.guildConfigSection.findUnique({
        where: { guildId_section: { guildId, section } },
      });
      return row ? toRecord(row) : null;
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.find");
    }
  }

  public async save(
    guildId: string,
    section: string,
    value: unknown,
    actor: ConfigWriteActor | null,
  ): Promise<void> {
    try {
      const json = toJson(value);
      await this.prisma.guildConfigSection.upsert({
        where: { guildId_section: { guildId, section } },
        update: { value: json, updatedBy: actor?.id ?? null },
        create: { guildId, section, value: json, updatedBy: actor?.id ?? null },
      });
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.save");
    }
  }

  public async remove(guildId: string, section: string): Promise<void> {
    try {
      await this.prisma.guildConfigSection.deleteMany({ where: { guildId, section } });
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.remove");
    }
  }

  public async appendRevision(record: ConfigRevisionRecord): Promise<void> {
    try {
      await this.prisma.guildConfigRevision.create({
        data: {
          guildId: record.guildId,
          section: record.section,
          before: toNullableJson(record.before),
          after: toJson(record.after),
          actorId: record.actorId,
          actorKind: record.actorKind,
        },
      });
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.appendRevision");
    }
  }

  public async listRevisions(guildId: string, limit: number): Promise<ConfigRevisionRecord[]> {
    try {
      const rows = await this.prisma.guildConfigRevision.findMany({
        where: { guildId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.map((row) => ({
        guildId: row.guildId,
        section: row.section,
        before: row.before,
        after: row.after,
        actorId: row.actorId,
        actorKind: row.actorKind,
      }));
    } catch (error) {
      throw toDatabaseError(error, "guildConfig.listRevisions");
    }
  }
}

/** Normalizes a section row, keeping only what the layer above needs. */
function toRecord(row: {
  guildId: string;
  section: string;
  value: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}): ConfigSectionRecord {
  return {
    guildId: row.guildId,
    section: row.section,
    value: row.value,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
