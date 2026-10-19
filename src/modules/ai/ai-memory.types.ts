/**
 * Guild memory contracts for the AI assistant.
 *
 * Memory is deliberately small: a short fact stored under a `(kind, key)` pair,
 * never a conversation transcript. The bounds (entry count, content length) are
 * the service's, not the schema's, so they live here as types and are testable
 * off-DB, and the `kind` value is an open string (the service trims/validates it)
 * rather than a Prisma enum so adding a namespace needs no migration.
 */

/** The coarse namespaces memory is bucketed under. */
export type AiGuildMemoryKind = "user" | "project" | "rule" | "note";

export const AI_MEMORY_KINDS: readonly AiGuildMemoryKind[] = ["user", "project", "rule", "note"];

export const AI_MEMORY_LIMITS = {
  /** Longest stored content, to bound how much a runaway note can cost. */
  maxContentLength: 2000,
  /** Longest key, so a lookup stays cheap and grep-able. */
  maxKeyLength: 100,
  /** Maximum entries per guild before `remember` refuses. */
  maxEntriesPerGuild: 200,
} as const;

/** A persisted memory note. */
export interface AiGuildMemoryRecord {
  readonly id: string;
  readonly guildId: string;
  readonly kind: AiGuildMemoryKind;
  readonly key: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Storage port, implemented by `PrismaAiGuildMemoryRepository`. */
export interface AiGuildMemoryRepository {
  /** Creates or replaces the note at (guild, kind, key). */
  upsert(draft: { guildId: string; kind: AiGuildMemoryKind; key: string; content: string }): Promise<AiGuildMemoryRecord>;
  /** @returns the note, or `null` when absent. */
  find(guildId: string, kind: AiGuildMemoryKind, key: string): Promise<AiGuildMemoryRecord | null>;
  /** @returns every note for a guild, limited, newest first. */
  list(guildId: string, limit: number): Promise<AiGuildMemoryRecord[]>;
  /** Deletes a note; @returns false when it did not exist. */
  remove(guildId: string, kind: AiGuildMemoryKind, key: string): Promise<boolean>;
  /** @returns the number of notes currently stored for a guild. */
  count(guildId: string): Promise<number>;
}
