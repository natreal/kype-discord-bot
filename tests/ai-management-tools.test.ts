/**
 * Management tool tests: the create/rename/edit/destroy capabilities large mode
 * unlocks on top of strict (roles, channels, categories, threads).
 */
import { describe, expect, it } from "vitest";

import {
  createCategoryTool,
  createThreadTool,
  deleteCategoryTool,
  deleteRoleTool,
  deleteThreadTool,
  editChannelTool,
  editRoleTool,
  renameCategoryTool,
  renameChannelTool,
  renameRoleTool,
} from "../src/modules/ai/ai-tools.js";
import type { AiToolActionsPort } from "../src/modules/ai/ai.module.js";
import { testLogger } from "./helpers/logger.js";

const GUILD_ID = "999999999999999999";

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

function context(actions: AiToolActionsPort) {
  return {
    guildId: GUILD_ID,
    invoker: { id: "111111111111111111" } as never,
    permissions: { check: () => ({ allowed: true }) } as never,
    logger: testLogger,
    actions,
  };
}

describe("management tools", () => {
  it("create_category asks the port for a category channel", async () => {
    const calls: Array<{ name: string; type?: string }> = [];
    const actions = fakeActions({
      createChannel: async (name, options) => {
        calls.push({ name, ...(options?.type === undefined ? {} : { type: options.type }) });
        return { id: "cat1", name };
      },
    });
    const output = await createCategoryTool.execute(createCategoryTool.validate({ name: "Archive" }), context(actions));
    expect(output).toEqual({ id: "cat1", name: "Archive" });
    expect(calls).toEqual([{ name: "Archive", type: "category" }]);
  });

  it("rename_channel resolves a name and renames it", async () => {
    const edits: Array<{ id: string; name?: string }> = [];
    const actions = fakeActions({
      findChannelByName: async (name) => (name === "v7" ? { id: "c7", name: "v7" } : null),
      editChannel: async (id, changes) => {
        edits.push({ id, ...(changes.name === undefined ? {} : { name: changes.name }) });
        return { ok: true };
      },
    });
    const output = await renameChannelTool.execute(
      renameChannelTool.validate({ channel: "v7", name: "archive" }),
      context(actions),
    );
    expect(output).toEqual({ id: "c7", name: "archive" });
    expect(edits).toEqual([{ id: "c7", name: "archive" }]);
  });

  it("edit_channel refuses when no field is provided", async () => {
    const actions = fakeActions({ findChannelByName: async (name) => ({ id: "c7", name }) });
    await expect(editChannelTool.execute(editChannelTool.validate({ channel: "v7" }), context(actions))).rejects.toThrow(
      /no change was specified/,
    );
  });

  it("edit_channel maps slowmode and nsfw onto the port", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const actions = fakeActions({
      findChannelByName: async (name) => ({ id: "c7", name }),
      editChannel: async (_id, changes) => {
        seen.push(changes as Record<string, unknown>);
        return { ok: true };
      },
    });
    await editChannelTool.execute(
      editChannelTool.validate({ channel: "v7", nsfw: true, slowmodeSeconds: 30 }),
      context(actions),
    );
    expect(seen[0]).toEqual({ nsfw: true, slowmodeSeconds: 30 });
  });

  it("rename_category only matches category channels", async () => {
    const actions = fakeActions({
      findChannelByName: async (_name, kind) => (kind === "category" ? { id: "cat1", name: "Archive" } : null),
      editChannel: async () => ({ ok: true }),
    });
    const output = await renameCategoryTool.execute(
      renameCategoryTool.validate({ category: "Archive", name: "Old" }),
      context(actions),
    );
    expect(output).toEqual({ id: "cat1", name: "Old" });
  });

  it("delete_category surfaces a Discord refusal instead of claiming success", async () => {
    const actions = fakeActions({
      findChannelByName: async () => ({ id: "cat1", name: "Archive" }),
      deleteChannel: async () => ({ ok: false, detail: "Missing Permissions" }),
    });
    await expect(
      deleteCategoryTool.execute(deleteCategoryTool.validate({ category: "Archive" }), context(actions)),
    ).rejects.toThrow(/Missing Permissions/);
  });

  it("rename_role resolves a role by name and renames it", async () => {
    const actions = fakeActions({
      findRoleByName: async (name) => (name === "Mod" ? { id: "r1", name: "Mod" } : null),
      editRole: async () => ({ ok: true }),
    });
    const output = await renameRoleTool.execute(
      renameRoleTool.validate({ role: "Mod", name: "Staff" }),
      context(actions),
    );
    expect(output).toEqual({ id: "r1", name: "Staff" });
  });

  it("edit_role requires at least one change", async () => {
    const actions = fakeActions({ findRoleByName: async () => ({ id: "r1", name: "Mod" }) });
    await expect(editRoleTool.execute(editRoleTool.validate({ role: "Mod" }), context(actions))).rejects.toThrow(
      /no change was specified/,
    );
  });

  it("edit_role rejects a non-hex colour", () => {
    expect(() => editRoleTool.validate({ role: "Mod", color: "purple" })).toThrow();
    expect(editRoleTool.validate({ role: "Mod", color: "#ffcc00" })).toEqual({ role: "Mod", color: "#ffcc00" });
  });

  it("delete_role resolves a name and deletes it", async () => {
    const deleted: string[] = [];
    const actions = fakeActions({
      findRoleByName: async (name) => ({ id: "r1", name }),
      deleteRole: async (id) => {
        deleted.push(id);
        return { ok: true };
      },
    });
    const output = await deleteRoleTool.execute(deleteRoleTool.validate({ role: "Old Mod" }), context(actions));
    expect(output).toEqual({ id: "r1", name: "Old Mod" });
    expect(deleted).toEqual(["r1"]);
  });

  it("create_thread resolves the parent channel and opens a thread", async () => {
    const actions = fakeActions({
      findChannelByName: async () => ({ id: "c7", name: "general" }),
      createThread: async (channelId, name, isPrivate) => ({ id: "t1", name: `${channelId}:${name}:${isPrivate}` }),
    });
    const output = await createThreadTool.execute(
      createThreadTool.validate({ channel: "general", name: "standup", private: true }),
      context(actions),
    );
    expect(output).toEqual({ id: "t1", name: "c7:standup:true" });
  });

  it("delete_thread finds a thread by name and deletes it", async () => {
    const deleted: string[] = [];
    const actions = fakeActions({
      findThreadByName: async (name) => (name === "standup" ? { id: "t1", name: "standup" } : null),
      deleteThread: async (id) => {
        deleted.push(id);
        return { ok: true };
      },
    });
    const output = await deleteThreadTool.execute(deleteThreadTool.validate({ thread: "standup" }), context(actions));
    expect(output).toEqual({ id: "t1", ok: true });
    expect(deleted).toEqual(["t1"]);
  });

  it("delete_thread refuses an unknown thread name", async () => {
    const actions = fakeActions({ findThreadByName: async () => null });
    await expect(
      deleteThreadTool.execute(deleteThreadTool.validate({ thread: "ghost" }), context(actions)),
    ).rejects.toThrow(/no thread named/);
  });
});
