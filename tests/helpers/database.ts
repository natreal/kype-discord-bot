/**
 * In-memory stand-in for `DatabaseService` and `GuildConfigRepository`.
 *
 * Implements only the surface the configuration and setup layers use, which is
 * enough to test their behavior without a running PostgreSQL instance. Keeping
 * the stub small is deliberate: if production code needs more from the database
 * layer, this stub has to grow with it and the tests stay honest.
 *
 * Since V3 the configuration layer also runs through a repository port, so the
 * stub exposes `configRepository` — an in-memory implementation of the same port
 * the Prisma repository implements. That keeps `ConfigService` tests behavioral
 * (they exercise the real merge/validate/provenance logic) without PostgreSQL.
 */
import type { GuildRecord } from "../../src/services/database/index.js";
import type {
  ConfigRevisionRecord,
  ConfigSectionRecord,
  ConfigWriteActor,
  GuildConfigRepository,
} from "../../src/services/config/index.js";

interface StoredGuildSettings {
  guildId: string;
  modules: unknown;
}

export interface MemoryDatabaseStub {
  readonly guilds: Map<string, GuildRecord>;
  /** Raw `guildSettings.modules` values keyed by guild ID. */
  readonly settings: Map<string, unknown>;
  readonly setupRuns: unknown[];
  /** In-memory `GuildConfigRepository` for `ConfigService`. */
  readonly configRepository: GuildConfigRepository;
  /** Raw `guild_config_sections` rows, keyed by `guildId:section`. */
  readonly configSections: Map<string, ConfigSectionRecord>;
  /** Appended configuration revisions. */
  readonly configRevisions: ConfigRevisionRecord[];
  seedGuildSettings(guildId: string, modules: unknown): void;
  upsertGuild(input: { id: string; name: string; language?: string }): Promise<{
    guild: GuildRecord;
    created: boolean;
  }>;
  findGuild(guildId: string): Promise<GuildRecord | null>;
  prisma: {
    guildSettings: {
      findUnique(args: { where: { guildId: string } }): Promise<StoredGuildSettings | null>;
      upsert(args: {
        where: { guildId: string };
        update: { modules: unknown };
        create: { guildId: string; modules: unknown };
      }): Promise<StoredGuildSettings>;
    };
    setupRun: {
      create(args: { data: unknown }): Promise<unknown>;
    };
  };
}

/** Creates an isolated in-memory database stub. */
export function memoryDatabaseStub(): MemoryDatabaseStub {
  const guilds = new Map<string, GuildRecord>();
  const settings = new Map<string, unknown>();
  const setupRuns: unknown[] = [];
  const configSections = new Map<string, ConfigSectionRecord>();
  const configRevisions: ConfigRevisionRecord[] = [];

  const keyOf = (guildId: string, section: string): string => `${guildId}:${section}`;

  const configRepository: GuildConfigRepository = {
    // The memory stub tracks guild rows itself, so "ensure" only has to exist.
    ensureGuild(guildId, guildName) {
      if (!guilds.has(guildId)) {
        const now = new Date();
        guilds.set(guildId, {
          id: guildId,
          name: guildName,
          language: "en",
          createdAt: now,
          updatedAt: now,
        });
      }
      return Promise.resolve();
    },
    list(guildId) {
      return Promise.resolve(
        [...configSections.values()].filter((record) => record.guildId === guildId),
      );
    },
    find(guildId, section) {
      return Promise.resolve(configSections.get(keyOf(guildId, section)) ?? null);
    },
    save(guildId, section, value, actor: ConfigWriteActor | null) {
      const now = new Date();
      configSections.set(keyOf(guildId, section), {
        guildId,
        section,
        value,
        updatedBy: actor?.id ?? null,
        updatedAt: now,
      });
      return Promise.resolve();
    },
    remove(guildId, section) {
      configSections.delete(keyOf(guildId, section));
      return Promise.resolve();
    },
    appendRevision(record) {
      configRevisions.push(record);
      return Promise.resolve();
    },
    listRevisions(guildId, limit) {
      return Promise.resolve(
        configRevisions.filter((record) => record.guildId === guildId).slice(0, limit),
      );
    },
  };

  const stub: MemoryDatabaseStub = {
    guilds,
    settings,
    setupRuns,
    configRepository,
    configSections,
    configRevisions,
    seedGuildSettings(guildId, modules) {
      settings.set(guildId, modules);
    },
    upsertGuild(input) {
      const existing = guilds.get(input.id);
      const now = new Date();
      const guild: GuildRecord = {
        id: input.id,
        name: input.name,
        language: existing?.language ?? input.language ?? "en",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      guilds.set(input.id, guild);
      return Promise.resolve({ guild, created: existing === undefined });
    },
    findGuild(guildId) {
      return Promise.resolve(guilds.get(guildId) ?? null);
    },
    prisma: {
      guildSettings: {
        findUnique({ where }) {
          if (!settings.has(where.guildId)) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ guildId: where.guildId, modules: settings.get(where.guildId) });
        },
        upsert({ where, update, create }) {
          const modules = settings.has(where.guildId) ? update.modules : create.modules;
          settings.set(where.guildId, modules);
          return Promise.resolve({ guildId: where.guildId, modules });
        },
      },
      setupRun: {
        create({ data }) {
          setupRuns.push(data);
          return Promise.resolve(data);
        },
      },
    },
  };

  return stub;
}
