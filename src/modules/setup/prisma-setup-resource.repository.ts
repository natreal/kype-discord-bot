/**
 * Prisma implementation of the setup resource identity store.
 *
 * This is the only place that knows how setup state is persisted. It uses the
 * shared `DatabaseService` (never a second Prisma client) and relies on the
 * `(guildId, key)` unique constraint as the race-condition safety net: two setup
 * runs starting at the same time cannot both register the same logical resource.
 */
import type { PrismaDatabaseClient } from "../../services/database/index.js";
import { toDatabaseError } from "../../services/database/index.js";
import type { SetupResourceRecord, SetupResourceType } from "../setup.types.js";
import { isSetupResourceType } from "../setup.types.js";
import type { SetupResourceRepository } from "./setup-resource.service.js";

/** Shape of a `setup_resources` row as read back from the database. */
interface SetupResourceRow {
  readonly guildId: string;
  readonly key: string;
  readonly type: string;
  readonly discordId: string | null;
  readonly name: string | null;
  readonly config: unknown;
}

/**
 * JSON value accepted by Prisma's `Json` columns.
 *
 * The generated client validates this shape, and `Record<string, unknown>` is not
 * assignable to it. Rather than casting, the repository serializes through this
 * alias, keeping the boundary explicit.
 */
type PrismaJson = Parameters<PrismaDatabaseClient["setupResource"]["upsert"]>[0]["create"] extends {
  config?: infer TConfig;
}
  ? TConfig
  : never;

export class PrismaSetupResourceRepository implements SetupResourceRepository {
  private readonly prisma: PrismaDatabaseClient;
  private readonly guildName: string;

  /**
   * @param prisma Shared database client (from `DatabaseService`).
   * @param guildName Guild name, used to satisfy the `guilds` foreign key.
   */
  public constructor(prisma: PrismaDatabaseClient, guildName = "unknown") {
    this.prisma = prisma;
    this.guildName = guildName;
  }

  /** @returns every tracked resource of the guild. */
  public async list(guildId: string): Promise<SetupResourceRecord[]> {
    const rows = (await this.prisma.setupResource.findMany({
      where: { guildId },
      orderBy: { key: "asc" },
    })) as unknown as SetupResourceRow[];
    return rows.map(toRecord);
  }

  /** @returns the tracked resource for `key`, or `null`. */
  public async find(guildId: string, key: string): Promise<SetupResourceRecord | null> {
    const row = (await this.prisma.setupResource.findUnique({
      // Named `guildId_key` by Prisma for the composite unique constraint.
      where: { guildId_key: { guildId, key } },
    })) as unknown as SetupResourceRow | null;
    return row ? toRecord(row) : null;
  }

  /**
   * Creates or updates the identity row for `(guildId, key)`.
   *
   * The guild row is upserted first so the foreign key always resolves, even when
   * setup runs before the bot has ever seen the guild.
   */
  public async remember(record: SetupResourceRecord): Promise<void> {
    try {
      await this.prisma.guild.upsert({
        where: { id: record.guildId },
        update: { name: this.guildName },
        create: { id: record.guildId, name: this.guildName },
      });

      const data = {
        type: record.type,
        discordId: record.discordId,
        name: record.name,
        config: record.config as PrismaJson,
      };

      await this.prisma.setupResource.upsert({
        // `guildId_key` is the compound unique constraint: the race-condition
        // safety net for two concurrent setup runs.
        where: { guildId_key: { guildId: record.guildId, key: record.key } },
        update: data,
        create: { guildId: record.guildId, key: record.key, ...data },
      });
    } catch (error) {
      // Wrapped so callers get a typed, loggable failure instead of a raw Prisma
      // error; the resource service treats it as a non-fatal warning.
      throw toDatabaseError(error, "setupResource.remember");
    }
  }

  /** Removes a tracked identity (used when a resource is retired). */
  public async forget(guildId: string, key: string): Promise<void> {
    try {
      await this.prisma.setupResource.deleteMany({ where: { guildId, key } });
    } catch (error) {
      throw toDatabaseError(error, "setupResource.forget");
    }
  }
}

/** Normalizes a database row, defending against unexpected stored values. */
function toRecord(row: SetupResourceRow): SetupResourceRecord {
  const type: SetupResourceType = isSetupResourceType(row.type) ? row.type : "TEXT_CHANNEL";
  return {
    guildId: row.guildId,
    key: row.key,
    type,
    discordId: row.discordId,
    name: row.name,
    config: isPlainRecord(row.config) ? row.config : {},
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
