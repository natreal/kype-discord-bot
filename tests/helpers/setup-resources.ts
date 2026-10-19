/**
 * In-memory setup resource repository.
 *
 * Enforces the same `(guildId, key)` uniqueness the database does, so tests can
 * prove that duplicate identities are impossible rather than merely unobserved.
 */
import type { SetupResourceRecord, SetupResourceType } from "../../src/modules/setup.types.js";
import type { SetupResourceRepository } from "../../src/modules/setup/setup-resource.service.js";

export interface MemoryResourceRepository extends SetupResourceRepository {
  /** Raw rows, keyed by `guildId:key`, for direct assertions. */
  readonly rows: Map<string, SetupResourceRecord>;
  /** Number of write attempts (successful or not). */
  readonly writes: { count: number };
  /** When true, every write throws, simulating an unreachable database. */
  failWrites: boolean;
}

export function memoryResourceRepository(
  initial: readonly SetupResourceRecord[] = [],
): MemoryResourceRepository {
  const rows = new Map<string, SetupResourceRecord>();
  const writes = { count: 0 };

  const keyOf = (guildId: string, key: string): string => `${guildId}:${key}`;

  const repository: MemoryResourceRepository = {
    rows,
    writes,
    failWrites: false,
    list(guildId) {
      return Promise.resolve(
        [...rows.values()]
          .filter((record) => record.guildId === guildId)
          .sort((left, right) => left.key.localeCompare(right.key)),
      );
    },
    find(guildId, key) {
      return Promise.resolve(rows.get(keyOf(guildId, key)) ?? null);
    },
    remember(record) {
      writes.count += 1;
      if (repository.failWrites) {
        return Promise.reject(new Error("database unavailable"));
      }
      // Mirrors the unique constraint: a write is an update for an existing
      // `(guildId, key)`, never an insert of a second row.
      rows.set(keyOf(record.guildId, record.key), record);
      return Promise.resolve();
    },
    forget(guildId, key) {
      rows.delete(keyOf(guildId, key));
      return Promise.resolve();
    },
  };

  for (const record of initial) {
    rows.set(keyOf(record.guildId, record.key), record);
  }

  return repository;
}

/** Convenience builder for a stored identity row. */
export function storedResource(
  guildId: string,
  key: string,
  discordId: string,
  type: SetupResourceType = "TEXT_CHANNEL",
  name: string | null = null,
): SetupResourceRecord {
  return { guildId, key, type, discordId, name, config: {} };
}
