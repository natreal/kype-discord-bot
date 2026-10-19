/**
 * `delete_channel` tool tests: it is sensitive (large/custom only, never strict),
 * resolves a channel by name, and reports a refusal rather than pretending.
 */
import { describe, expect, it, vi } from "vitest";

import { deleteChannelTool } from "../src/modules/ai/ai-tools.js";
import {
  buildToolMenu,
  SENSITIVE_CATEGORIES,
  STRICT_CATEGORIES,
} from "../src/modules/ai/tool-menu.js";
import type { AiToolActionsPort } from "../src/modules/ai/ai.module.js";
import { testLogger } from "./helpers/logger.js";

function fakeActions(overrides: Partial<AiToolActionsPort> = {}): AiToolActionsPort {
  return {
    listRoles: async () => [],
    createChannel: async (name) => ({ id: "c1", name }),
    findChannelByName: async () => null,
    editChannel: async () => ({ ok: true }),
    deleteChannel: async () => ({ ok: true }),
    sendMessage: async () => ({ id: "m1" }),
    readMessages: async () => [],
    findRoleByName: async () => null,
    createRole: async (name) => ({ id: "r1", name }),
    editRole: async () => ({ ok: true }),
    deleteRole: async () => ({ ok: true }),
    setMemberRole: async () => ({ ok: true }),
    createThread: async (_channelId, name) => ({ id: "t1", name }),
    editThread: async () => ({ ok: true }),
    deleteThread: async () => ({ ok: true }),
    findThreadByName: async () => null,
    moderate: async () => ({ ok: true }),
    listChannels: async () => [],
    setChannelPermissions: async () => ({ ok: true }),
    purgeMessages: async (_channelId, count) => ({ ok: true, purged: count }),
    ...overrides,
  };
}

const context = {
  guildId: "222222222222222222",
  invoker: { id: "111111111111111111" } as never,
  permissions: { check: () => ({ allowed: true }) } as never,
  logger: testLogger,
};

describe("delete_channel tool", () => {
  it("declares the sensitive `destructive` category (never reachable in strict)", () => {
    expect(deleteChannelTool.category).toBe("destructive");
    expect(SENSITIVE_CATEGORIES).toContain("destructive");
    expect(STRICT_CATEGORIES).not.toContain("destructive");
    // Not part of its name/category, but asserted to catch a re-categorisation.
    const strictMenu = buildToolMenu([deleteChannelTool], "strict");
    expect(strictMenu.tools).toHaveLength(0);
    const largeMenu = buildToolMenu([deleteChannelTool], "large");
    expect(largeMenu.tools).toHaveLength(1);
  });

  it("resolves a channel by name and deletes it", async () => {
    const deleteChannel = vi.fn().mockResolvedValue({ ok: true });
    const actions = fakeActions({
      findChannelByName: async (name) => (name === "v7" ? { id: "c7", name: "v7" } : null),
      deleteChannel,
    });
    const input = deleteChannelTool.validate({ channel: "v7" });
    const output = await deleteChannelTool.execute(input, { ...context, actions });
    expect(output).toEqual({ id: "c7", name: "v7" });
    expect(deleteChannel).toHaveBeenCalledWith("c7");
  });

  it("accepts a snowflake id when no channel name matches", async () => {
    const deleteChannel = vi.fn().mockResolvedValue({ ok: true });
    const actions = fakeActions({ deleteChannel });
    const id = "333333333333333333";
    const output = await deleteChannelTool.execute(deleteChannelTool.validate({ channel: id }), {
      ...context,
      actions,
    });
    expect(output.id).toBe(id);
    expect(deleteChannel).toHaveBeenCalledWith(id);
  });

  it("refuses when no channel matches and the input is not a snowflake", async () => {
    const actions = fakeActions({ findChannelByName: async () => null });
    await expect(
      deleteChannelTool.execute(deleteChannelTool.validate({ channel: "ghost" }), {
        ...context,
        actions,
      }),
    ).rejects.toThrow(/no channel named/);
  });

  it("surfaces a Discord refusal instead of claiming success", async () => {
    const actions = fakeActions({
      findChannelByName: async (name) => ({ id: "c7", name }),
      deleteChannel: async () => ({ ok: false, detail: "Missing Permissions" }),
    });
    await expect(
      deleteChannelTool.execute(deleteChannelTool.validate({ channel: "v7" }), {
        ...context,
        actions,
      }),
    ).rejects.toThrow(/Missing Permissions/);
  });

  it("accepts a bare scalar argument (models sometimes omit the object wrapper)", () => {
    expect(deleteChannelTool.validate("v7")).toEqual({ channel: "v7" });
    expect(deleteChannelTool.validate({ channel: "v7" })).toEqual({ channel: "v7" });
  });
});