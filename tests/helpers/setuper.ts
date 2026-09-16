/**
 * Test helper: an in-memory `Setuper` that models Discord's "find or create"
 * semantics, so setup idempotency can be asserted without a gateway connection.
 */
import type { Guild } from "discord.js";

import type { Setuper } from "../../src/modules/setup.types.js";

export interface FakeSetuperHarness {
  readonly setuper: Setuper;
  /** Resource keys that were created, in order. */
  readonly created: string[];
  /** Resource keys that were reused, in order. */
  readonly reused: string[];
  /** Pre-registers an existing resource, as if it were already on Discord. */
  seed(kind: "role" | "category" | "channel", name: string, id?: string): string;
}

export function fakeSetuper(guildId = "111111111111111111"): FakeSetuperHarness {
  const known = new Map<string, string>();
  const created: string[] = [];
  const reused: string[] = [];

  const key = (kind: string, name: string): string => `${kind}:${name}`;
  const nextId = (kind: string): string => `${kind}-${known.size + 1}`;

  const findOrCreate = (
    kind: "role" | "category" | "channel",
    name: string,
  ): { resource: { id: string; name: string }; created: boolean } => {
    const resourceKey = key(kind, name);
    const existing = known.get(resourceKey);
    if (existing) {
      reused.push(resourceKey);
      return { resource: { id: existing, name }, created: false };
    }
    const id = nextId(kind);
    known.set(resourceKey, id);
    created.push(resourceKey);
    return { resource: { id, name }, created: true };
  };

  const guildStub = {
    id: guildId,
    name: "Guild",
    // The security module inspects existing channels; an empty collection models
    // a guild where nothing has been configured yet.
    channels: { fetch: () => Promise.resolve(new Map()) },
    roles: { everyone: { id: guildId } },
  };

  const setuper: Setuper = {
    guild: guildStub as unknown as Guild,
    ensureRole: (options) => Promise.resolve(findOrCreate("role", options.name) as never),
    ensureCategory: (options) => Promise.resolve(findOrCreate("category", options.name) as never),
    ensureTextChannel: (options) => Promise.resolve(findOrCreate("channel", options.name) as never),
    findChannelById: (channelId) => Promise.resolve({ id: channelId } as never),
    findRoleById: (roleId) => Promise.resolve({ id: roleId } as never),
    findCategoryByName: (name) => {
      const id = known.get(key("category", name));
      return Promise.resolve(id ? ({ id } as never) : null);
    },
    findTextChannelByName: (name) => {
      const id = known.get(key("channel", name));
      return Promise.resolve(id ? ({ id, name } as never) : null);
    },
    findRoleByName: (name) => {
      const id = known.get(key("role", name));
      return Promise.resolve(id ? ({ id } as never) : null);
    },
  };
  return {
    setuper,
    created,
    reused,
    seed(kind, name, id = `seeded-${kind}-${name}`) {
      known.set(key(kind, name), id);
      return id;
    },
  };
}
