/**
 * Centralized database service.
 *
 * Owns the connection lifecycle and exposes typed, purpose-built helpers
 * (`guilds`, `health`, `runInTransaction`) instead of leaking the Prisma client
 * into commands and modules. New feature areas add their own repository classes
 * that receive this service.
 */
import type { AppConfig } from "../../config/config.js";
import type { Logger } from "../logger/index.js";
import { createPrismaClient, toDatabaseError, type PrismaDatabaseClient } from "./client.js";

/** Persisted guild record as stored by the foundation schema. */
export interface GuildRecord {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Data required to create or refresh a guild row. */
export interface GuildUpsertInput {
  readonly id: string;
  readonly name: string;
  readonly language?: string;
}

/** Result of a guild upsert, including whether the row was newly created. */
export interface GuildUpsertResult {
  readonly guild: GuildRecord;
  readonly created: boolean;
}

export class DatabaseService {
  private readonly client: PrismaDatabaseClient;
  private readonly logger: Logger;
  private connected = false;

  public constructor(config: AppConfig, logger: Logger) {
    this.logger = logger.child("database");
    this.client = createPrismaClient(config);
    this.logger.debug("Prisma client created", { adapter: "pg" });
  }

  /** Raw client access for feature repositories inside `src/services`. */
  public get prisma(): PrismaDatabaseClient {
    return this.client;
  }

  /** @returns true once `connect()` has completed successfully. */
  public get isConnected(): boolean {
    return this.connected;
  }

  /** Opens the connection pool and verifies the connection with a query. */
  public async connect(): Promise<void> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      this.connected = true;
      this.logger.info("Database connected");
    } catch (error) {
      this.connected = false;
      throw toDatabaseError(error, "connect");
    }
  }

  /** Executes a lightweight liveness query. */
  public async health(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = performance.now();
    try {
      await this.client.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      this.logger.warn("Database health check failed", { error: String(error) });
      return { ok: false, latencyMs: Math.round(performance.now() - startedAt) };
    }
  }

  /**
   * Creates or updates a guild row.
   *
   * Idempotent: calling it twice for the same guild does not duplicate data.
   */
  public async upsertGuild(input: GuildUpsertInput): Promise<GuildUpsertResult> {
    try {
      const existing = await this.client.guild.findUnique({
        where: { id: input.id },
        select: { id: true },
      });

      const guild = await this.client.guild.upsert({
        where: { id: input.id },
        update: { name: input.name },
        create: {
          id: input.id,
          name: input.name,
          ...(input.language === undefined ? {} : { language: input.language }),
        },
      });

      return { guild, created: existing === null };
    } catch (error) {
      throw toDatabaseError(error, "upsertGuild");
    }
  }

  /** @returns the guild row, or `null` when the bot has no record of it. */
  public async findGuild(guildId: string): Promise<GuildRecord | null> {
    try {
      return await this.client.guild.findUnique({ where: { id: guildId } });
    } catch (error) {
      throw toDatabaseError(error, "findGuild");
    }
  }

  /** @returns every guild the bot knows about, oldest first. */
  public async listGuilds(): Promise<GuildRecord[]> {
    try {
      return await this.client.guild.findMany({ orderBy: { createdAt: "asc" } });
    } catch (error) {
      throw toDatabaseError(error, "listGuilds");
    }
  }

  /**
   * Runs `callback` inside a transaction.
   *
   * Modules must use this instead of manual begin/commit handling so partial
   * writes cannot occur.
   */
  public async runInTransaction<T>(
    callback: (tx: PrismaDatabaseClient) => Promise<T>,
    operation = "transaction",
  ): Promise<T> {
    try {
      return await this.client.$transaction(async (tx) => callback(tx as PrismaDatabaseClient));
    } catch (error) {
      throw toDatabaseError(error, operation);
    }
  }

  /** Releases the connection pool. Safe to call more than once. */
  public async disconnect(): Promise<void> {
    try {
      await this.client.$disconnect();
      this.connected = false;
      this.logger.info("Database connection closed");
    } catch (error) {
      this.logger.error("Failed to close the database connection", error);
    }
  }
}
