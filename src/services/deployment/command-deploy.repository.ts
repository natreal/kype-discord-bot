/**
 * Storage for command-deployment state.
 *
 * A record answers one question — "what payload did this guild last receive?" —
 * and it exists so automatic deployment can skip the API call for every server
 * that is already up to date. That matters for a bot distributed to many
 * servers: without this table, every boot would PUT to every guild, which is
 * both slow and a needless way to meet Discord's rate limiter.
 *
 * Kept behind a port, like the other repositories, so the deployment service is
 * testable without PostgreSQL and the storage decision stays separate from the
 * deployment decision.
 */
import type { DatabaseService } from "../database/index.js";
import type { Logger } from "../logger/index.js";

/** Where a successful deployment was triggered from. */
export const DEPLOYMENT_SOURCES = ["startup", "guildCreate", "manual", "script"] as const;

export type DeploymentSource = (typeof DEPLOYMENT_SOURCES)[number];

/** A guild's last successful deployment. */
export interface CommandDeploymentRecord {
  readonly guildId: string;
  /** SHA-256 of the payload that was published. */
  readonly fingerprint: string;
  readonly commandCount: number;
  readonly source: string;
  readonly deployedAt: Date;
}

/** What to store after a successful deployment. */
export interface CommandDeploymentWrite {
  readonly guildId: string;
  readonly fingerprint: string;
  readonly commandCount: number;
  readonly source: DeploymentSource;
}

export interface CommandDeploymentRepository {
  /** @returns the guild's record, or `null` when it was never deployed to. */
  find(guildId: string): Promise<CommandDeploymentRecord | null>;
  /** Records a successful deployment; idempotent per guild. */
  save(write: CommandDeploymentWrite): Promise<void>;
  /** Removes a guild's record (used when a guild is cleared or leaves). */
  remove(guildId: string): Promise<void>;
  /**
   * Marks every guild *not* in `keepGuildIds` as needing a deployment.
   *
   * Called after a successful global registration: guild-scoped records that are
   * already on the new fingerprint stay valid, while a guild that inherited the
   * change globally is brought back in sync on the next deploy instead of being
   * left on a stale record.
   */
  pruneExcept(keepGuildIds: readonly string[]): Promise<number>;
}

/** Prisma-backed repository. */
export class PrismaCommandDeploymentRepository implements CommandDeploymentRepository {
  private readonly prisma: DatabaseService["prisma"];

  public constructor(database: DatabaseService) {
    this.prisma = database.prisma;
  }

  public async find(guildId: string): Promise<CommandDeploymentRecord | null> {
    const row = await this.prisma.commandDeployment.findUnique({ where: { guildId } });
    return row ?? null;
  }

  public async save(write: CommandDeploymentWrite): Promise<void> {
    await this.prisma.commandDeployment.upsert({
      where: { guildId: write.guildId },
      update: {
        fingerprint: write.fingerprint,
        commandCount: write.commandCount,
        source: write.source,
        deployedAt: new Date(),
      },
      create: {
        guildId: write.guildId,
        fingerprint: write.fingerprint,
        commandCount: write.commandCount,
        source: write.source,
      },
    });
  }

  public async remove(guildId: string): Promise<void> {
    await this.prisma.commandDeployment.deleteMany({ where: { guildId } });
  }

  public async pruneExcept(keepGuildIds: readonly string[]): Promise<number> {
    const result = await this.prisma.commandDeployment.deleteMany({
      where: { guildId: { notIn: [...keepGuildIds] } },
    });
    return result.count;
  }
}

/**
 * In-memory repository.
 *
 * Used by tests and by a deployment that has no database (a script run before
 * migrations). It is a real implementation, not a stub: `pruneExcept` behaves the
 * same way, so tests exercise the service's actual decisions.
 */
export class MemoryCommandDeploymentRepository implements CommandDeploymentRepository {
  private readonly records = new Map<string, CommandDeploymentRecord>();
  private readonly logger: Logger | undefined;

  public constructor(logger?: Logger) {
    this.logger = logger;
  }

  public find(guildId: string): Promise<CommandDeploymentRecord | null> {
    return Promise.resolve(this.records.get(guildId) ?? null);
  }

  public save(write: CommandDeploymentWrite): Promise<void> {
    this.records.set(write.guildId, {
      guildId: write.guildId,
      fingerprint: write.fingerprint,
      commandCount: write.commandCount,
      source: write.source,
      deployedAt: new Date(),
    });
    return Promise.resolve();
  }

  public remove(guildId: string): Promise<void> {
    this.records.delete(guildId);
    return Promise.resolve();
  }

  public pruneExcept(keepGuildIds: readonly string[]): Promise<number> {
    const keep = new Set(keepGuildIds);
    let removed = 0;
    for (const guildId of [...this.records.keys()]) {
      if (!keep.has(guildId)) {
        this.records.delete(guildId);
        removed += 1;
      }
    }
    this.logger?.debug("Pruned command deployment records", { removed });
    return Promise.resolve(removed);
  }
}

/** @returns true when `value` is a known deployment source. */
export function isDeploymentSource(value: string): value is DeploymentSource {
  return (DEPLOYMENT_SOURCES as readonly string[]).includes(value);
}
