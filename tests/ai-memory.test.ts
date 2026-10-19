/**
 * AI memory tests: remember/recall/forget/list, guild isolation, bounds and the
 * `memoryEnabled` gate.
 */
import { describe, expect, it } from "vitest";

import { AiMemoryService } from "../src/modules/ai/ai-memory.service.js";
import type {
  AiGuildMemoryKind,
  AiGuildMemoryRecord,
  AiGuildMemoryRepository,
} from "../src/modules/ai/ai-memory.types.js";
import { testLogger } from "./helpers/logger.js";

/** An in-memory repository backed by a Map, per guild. */
function memRepo(): AiGuildMemoryRepository & { store: Map<string, AiGuildMemoryRecord[]> } {
  const store = new Map<string, AiGuildMemoryRecord[]>();
  const rows = (guildId: string): AiGuildMemoryRecord[] => store.get(guildId) ?? [];
  return {
    store,
    async upsert(draft) {
      const list = rows(draft.guildId);
      const existing = list.find((row) => row.kind === draft.kind && row.key === draft.key);
      const record: AiGuildMemoryRecord = {
        id: existing?.id ?? `${draft.guildId}:${draft.kind}:${draft.key}`,
        guildId: draft.guildId,
        kind: draft.kind,
        key: draft.key,
        content: draft.content,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      const without = list.filter((row) => row.kind !== draft.kind || row.key !== draft.key);
      store.set(draft.guildId, [...without, record]);
      return record;
    },
    async find(guildId, kind, key) {
      return rows(guildId).find((row) => row.kind === kind && row.key === key) ?? null;
    },
    async list(guildId) {
      return [...rows(guildId)];
    },
    async remove(guildId, kind, key) {
      const before = rows(guildId).length;
      const after = rows(guildId).filter((row) => row.kind !== kind || row.key !== key);
      store.set(guildId, after);
      return after.length < before;
    },
    async count(guildId) {
      return rows(guildId).length;
    },
  };
}

function makeService(enabled = true): { service: AiMemoryService; repository: ReturnType<typeof memRepo> } {
  const repository = memRepo();
  const service = new AiMemoryService({
    logger: testLogger,
    repository,
    enabled: async () => enabled,
  });
  return { service, repository };
}

describe("AiMemoryService", () => {
  const guild = "111111111111111111";
  const other = "222222222222222222";
  const kind: AiGuildMemoryKind = "note";

  it("remembers, recalls and lists a note", async () => {
    const { service } = makeService();
    await service.remember(guild, kind, "welcome", "Welcome!");
    const recall = await service.recall(guild, kind, "welcome");
    expect(recall.ok).toBe(true);
    if (recall.ok) {
      expect(recall.value.content).toBe("Welcome!");
    }
    const list = await service.list(guild);
    expect(list.ok && list.value.length).toBe(1);
  });

  it("isolates memory between guilds", async () => {
    const { service } = makeService();
    await service.remember(guild, kind, "key", "A");
    const recall = await service.recall(other, kind, "key");
    expect(recall.ok).toBe(false);
  });

  it("forgets a note", async () => {
    const { service } = makeService();
    await service.remember(guild, kind, "key", "x");
    const forget = await service.forget(guild, kind, "key");
    expect(forget.ok && forget.value).toBe(true);
    const recall = await service.recall(guild, kind, "key");
    expect(recall.ok).toBe(false);
  });

  it("is inert when memoryEnabled is false", async () => {
    const { service } = makeService(false);
    const result = await service.remember(guild, kind, "key", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("disabled");
    }
  });

  it("enforces the content length bound", async () => {
    const { service } = makeService();
    const result = await service.remember(guild, kind, "key", "x".repeat(2001));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("limit");
    }
  });
});
