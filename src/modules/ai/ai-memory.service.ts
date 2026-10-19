/**
 * Guild memory service: remember / recall / forget / list.
 *
 * The service is the only writer, and it enforces the bounds the schema does not:
 * a note longer than `maxContentLength`, or a guild that has hit `maxEntriesPerGuild`,
 * is refused with a clear reason rather than stored. It is *also* the memory gate:
 * every call checks `enabled` (the guild's `ai.memoryEnabled`) and returns the
 * inert "memory is off" result when disabled, so no caller — command or agent —
 * can read or write memory a server turned off.
 */
import type { Logger } from "../../services/logger/index.js";
import { ValidationError } from "../../utils/errors.js";
import {
  AI_MEMORY_KINDS,
  AI_MEMORY_LIMITS,
  type AiGuildMemoryKind,
  type AiGuildMemoryRecord,
  type AiGuildMemoryRepository,
} from "./ai-memory.types.js";

export interface AiMemoryServiceOptions {
  readonly logger: Logger;
  readonly repository: AiGuildMemoryRepository;
  /** Whether memory is on for this guild (read live, not captured at startup). */
  readonly enabled: (guildId: string) => Promise<boolean>;
}

/** A normalized result, so callers never branch on exceptions. */
export type AiMemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "disabled" | "not-found" | "limit" | "invalid"; detail: string };

const DISABLED: AiMemoryResult<never> = {
  ok: false,
  reason: "disabled",
  detail: "memory is disabled for this server",
};

export class AiMemoryService {
  private readonly logger: Logger;
  private readonly repository: AiGuildMemoryRepository;
  private readonly enabled: (guildId: string) => Promise<boolean>;

  public constructor(options: AiMemoryServiceOptions) {
    this.logger = options.logger.child("ai:memory");
    this.repository = options.repository;
    this.enabled = options.enabled;
  }

  /** Stores a note, replacing an existing one at the same (kind, key). */
  public async remember(
    guildId: string,
    kind: AiGuildMemoryKind,
    key: string,
    content: string,
  ): Promise<AiMemoryResult<AiGuildMemoryRecord>> {
    if (!(await this.enabled(guildId))) {
      return DISABLED;
    }

    const trimmedKind = kind.trim();
    const trimmedKey = key.trim();
    const trimmedContent = content.trim();

    if (!AI_MEMORY_KINDS.includes(trimmedKind as AiGuildMemoryKind)) {
      return { ok: false, reason: "invalid", detail: `unknown memory kind: ${kind}` };
    }
    if (trimmedKey.length === 0 || trimmedKey.length > AI_MEMORY_LIMITS.maxKeyLength) {
      return { ok: false, reason: "invalid", detail: "memory key is empty or too long" };
    }
    if (trimmedContent.length === 0 || trimmedContent.length > AI_MEMORY_LIMITS.maxContentLength) {
      return { ok: false, reason: "limit", detail: "memory content is empty or too long" };
    }

    const existing = await this.repository.find(guildId, trimmedKind as AiGuildMemoryKind, trimmedKey);
    if (!existing) {
      const count = await this.repository.count(guildId);
      if (count >= AI_MEMORY_LIMITS.maxEntriesPerGuild) {
        return { ok: false, reason: "limit", detail: "memory is full for this server" };
      }
    }

    const record = await this.repository.upsert({
      guildId,
      kind: trimmedKind as AiGuildMemoryKind,
      key: trimmedKey,
      content: trimmedContent,
    });
    this.logger.info("AI memory remembered", { guildId, kind, key: trimmedKey });
    return { ok: true, value: record };
  }

  /** Reads a note, or `not-found` when absent. */
  public async recall(
    guildId: string,
    kind: AiGuildMemoryKind,
    key: string,
  ): Promise<AiMemoryResult<AiGuildMemoryRecord>> {
    if (!(await this.enabled(guildId))) {
      return DISABLED;
    }
    const record = await this.repository.find(guildId, kind, key.trim());
    return record
      ? { ok: true, value: record }
      : { ok: false, reason: "not-found", detail: "no such memory" };
  }

  /** Deletes a note. */
  public async forget(
    guildId: string,
    kind: AiGuildMemoryKind,
    key: string,
  ): Promise<AiMemoryResult<boolean>> {
    if (!(await this.enabled(guildId))) {
      return DISABLED;
    }
    const removed = await this.repository.remove(guildId, kind, key.trim());
    return { ok: true, value: removed };
  }

  /** Lists a guild's notes, newest first, bounded. */
  public async list(guildId: string): Promise<AiMemoryResult<AiGuildMemoryRecord[]>> {
    if (!(await this.enabled(guildId))) {
      return DISABLED;
    }
    const records = await this.repository.list(guildId, AI_MEMORY_LIMITS.maxEntriesPerGuild);
    return { ok: true, value: records };
  }

  /** Validates the kind at the command boundary (throws `ValidationError`). */
  public assertKind(kind: string): AiGuildMemoryKind {
    const normalized = kind.trim() as AiGuildMemoryKind;
    if (!AI_MEMORY_KINDS.includes(normalized)) {
      throw new ValidationError(
        `Unknown memory kind "${kind}". Use one of: ${AI_MEMORY_KINDS.join(", ")}.`,
      );
    }
    return normalized;
  }
}
