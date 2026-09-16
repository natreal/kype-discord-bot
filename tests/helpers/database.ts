/**
 * In-memory stand-in for `DatabaseService`.
 *
 * Implements only the surface the configuration and setup layers use, which is
 * enough to test their behavior without a running PostgreSQL instance. Keeping
 * the stub small is deliberate: if production code needs more from the database
 * layer, this stub has to grow with it and the tests stay honest.
 */
import type { GuildRecord } from "../../src/services/database/index.js";

interface StoredGuildSettings {
  guildId: string;
  modules: unknown;
}

export interface MemoryDatabaseStub {
  readonly guilds: Map<string, GuildRecord>;
  /** Raw `guildSettings.modules` values keyed by guild ID. */
  readonly settings: Map<string, unknown>;
  readonly setupRuns: unknown[];
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

  const stub: MemoryDatabaseStub = {
    guilds,
    settings,
    setupRuns,
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
