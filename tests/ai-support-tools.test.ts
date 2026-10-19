/**
 * Support-tool tests: the capabilities added on top of the original registry — a
 * channel inventory to check names against, role-level channel overwrites, a purge
 * that reaches the moderation pipeline, and the ticket operations (list, claim,
 * close, transcript, delete).
 */
import { describe, expect, it, vi } from "vitest";

import {
  claimTicketTool,
  closeTicketTool,
  deleteTicketTool,
  listChannelsTool,
  listTicketsTool,
  modifyPermissionsTool,
  purgeTool,
  readTicketTranscriptTool,
} from "../src/modules/ai/ai-tools.js";
import type { AiTicketActionsPort, AiToolActionsPort } from "../src/modules/ai/ai.module.js";
import { buildToolMenu } from "../src/modules/ai/tool-menu.js";
import { testLogger } from "./helpers/logger.js";

const GUILD_ID = "999999999999999999";
const INVOKER_ID = "111111111111111111";

function fakeTickets(overrides: Partial<AiTicketActionsPort> = {}): AiTicketActionsPort {
  return {
    list: async () => [],
    claim: async () => ({ ok: true, detail: "ticket #12 claimed" }),
    close: async () => ({ ok: true, detail: "ticket #12 closed" }),
    remove: async () => ({ ok: true, detail: "ticket #12 deleted" }),
    transcript: async () => ({ ok: true, messageCount: 12 }),
    ...overrides,
  };
}

function fakeActions(overrides: Partial<AiToolActionsPort> = {}): AiToolActionsPort {
  return {
    listRoles: async () => [],
    createChannel: async (name) => ({ id: "c1", name }),
    findChannelByName: async (name) => (name === "v7" ? { id: "c7", name: "v7" } : null),
    editChannel: async () => ({ ok: true }),
    deleteChannel: async () => ({ ok: true }),
    sendMessage: async () => ({ id: "m1" }),
    readMessages: async () => [],
    findRoleByName: async (name) => (name === "Admin" ? { id: "r1", name: "Admin" } : null),
    createRole: async (name) => ({ id: "r1", name }),
    editRole: async () => ({ ok: true }),
    deleteRole: async () => ({ ok: true }),
    setMemberRole: async () => ({ ok: true }),
    createThread: async (_channelId, name) => ({ id: "t1", name }),
    editThread: async () => ({ ok: true }),
    deleteThread: async () => ({ ok: true }),
    findThreadByName: async () => null,
    moderate: async () => ({ ok: true }),
    listChannels: async () => [
      { id: "c7", name: "v7", type: "text", parentId: "cat1" },
      { id: "cat1", name: "Archive", type: "category", parentId: null },
    ],
    setChannelPermissions: async () => ({ ok: true }),
    purgeMessages: async (_channelId, count) => ({ ok: true, purged: count }),
    tickets: fakeTickets(),
    ...overrides,
  };
}

function context(actions: AiToolActionsPort) {
  return {
    guildId: GUILD_ID,
    invoker: { id: INVOKER_ID } as never,
    permissions: { check: () => ({ allowed: true }) } as never,
    logger: testLogger,
    actions,
  };
}

const TICKETS = [
  {
    id: "ticket-1",
    number: 12,
    status: "open",
    subject: "cannot verify",
    channelId: "chan-1",
    claimedById: null,
  },
  {
    id: "ticket-2",
    number: 11,
    status: "closed",
    subject: null,
    channelId: "chan-2",
    claimedById: "222222222222222222",
  },
];

describe("list_channels", () => {
  it("reports name, kind, id and parent so a name can be checked before acting", async () => {
    const output = await listChannelsTool.execute(
      listChannelsTool.validate({}),
      context(fakeActions()),
    );

    expect(output.channels[0]).toContain("v7");
    expect(output.channels[0]).toContain("text");
    expect(output.channels[0]).toContain("<#cat1>");
    expect(output.channels[1]).toContain("Archive");
    expect(output.channels[1]).toContain("category");
  });

  it("is a strict-mode tool: reading the channel list is safe", () => {
    const names = new Set(
      buildToolMenu([listChannelsTool], "strict").tools.map((tool) => tool.name),
    );

    expect(names.has("list_channels")).toBe(true);
  });
});

describe("modify_permissions", () => {
  it("resolves the channel and the role, then applies the overwrite", async () => {
    const setChannelPermissions = vi.fn().mockResolvedValue({ ok: true });

    const output = await modifyPermissionsTool.execute(
      modifyPermissionsTool.validate({ channel: "v7", role: "Admin", deny: ["SendMessages"] }),
      context(fakeActions({ setChannelPermissions })),
    );

    expect(setChannelPermissions).toHaveBeenCalledWith("c7", "r1", { deny: ["SendMessages"] });
    expect(output).toEqual({
      ok: true,
      channel: "v7",
      role: "Admin",
      allowed: [],
      denied: ["SendMessages"],
    });
  });

  it("refuses a request that changes nothing", () => {
    expect(() => modifyPermissionsTool.validate({ channel: "v7", role: "Admin" })).toThrow(
      /no change was specified/,
    );
  });

  it("surfaces a refusal from the port instead of claiming success", async () => {
    const actions = fakeActions({
      setChannelPermissions: async () => ({ ok: false, detail: 'unknown permission "Fly"' }),
    });

    await expect(
      modifyPermissionsTool.execute(
        modifyPermissionsTool.validate({ channel: "v7", role: "Admin", allow: ["Fly"] }),
        context(actions),
      ),
    ).rejects.toThrow(/unknown permission/);
  });

  it("stays out of strict mode", () => {
    const names = new Set(
      buildToolMenu([modifyPermissionsTool], "strict").tools.map((tool) => tool.name),
    );

    expect(names.has("modify_permissions")).toBe(false);
  });
});

describe("purge", () => {
  it("purges the channel and reports how many messages went", async () => {
    const purgeMessages = vi.fn().mockResolvedValue({ ok: true, purged: 37 });

    const output = await purgeTool.execute(
      purgeTool.validate({ channelId: "333333333333333333", count: 50 }),
      context(fakeActions({ purgeMessages })),
    );

    expect(purgeMessages).toHaveBeenCalledWith("333333333333333333", 50);
    expect(output).toEqual({ purged: 37 });
  });

  it("refuses rather than reporting a purge that did not happen", async () => {
    const actions = fakeActions({
      purgeMessages: async () => ({
        ok: false,
        purged: 0,
        detail: "Moderation is disabled in this server.",
      }),
    });

    await expect(
      purgeTool.execute(
        purgeTool.validate({ channelId: "333333333333333333", count: 10 }),
        context(actions),
      ),
    ).rejects.toThrow(/Moderation is disabled/);
  });
});

describe("ticket tools", () => {
  it("lists tickets as quotable lines, including the id it acts on", async () => {
    const actions = fakeActions({ tickets: fakeTickets({ list: async () => TICKETS }) });

    const output = await listTicketsTool.execute(listTicketsTool.validate({}), context(actions));

    expect(output.tickets[0]).toContain("#12");
    expect(output.tickets[0]).toContain("cannot verify");
    expect(output.tickets[0]).toContain("id ticket-1");
    // An unclaimed ticket says so; a claimed one names the handler.
    expect(output.tickets[0]).toContain("nobody yet");
    expect(output.tickets[1]).toContain("<@222222222222222222>");
  });

  it("resolves '#12' to the ticket and claims it for the invoker", async () => {
    const claim = vi.fn().mockResolvedValue({ ok: true, detail: "ticket #12 claimed" });
    const actions = fakeActions({ tickets: fakeTickets({ list: async () => TICKETS, claim }) });

    const output = await claimTicketTool.execute(
      claimTicketTool.validate({ ticket: "#12" }),
      context(actions),
    );

    expect(claim).toHaveBeenCalledWith("ticket-1", INVOKER_ID);
    expect(output.ok).toBe(true);
  });

  it("closes a ticket through the service, with the reason", async () => {
    const close = vi.fn().mockResolvedValue({ ok: true, detail: "ticket #12 closed" });
    const actions = fakeActions({ tickets: fakeTickets({ list: async () => TICKETS, close }) });

    await closeTicketTool.execute(
      closeTicketTool.validate({ ticket: "12", reason: "resolved" }),
      context(actions),
    );

    expect(close).toHaveBeenCalledWith("ticket-1", INVOKER_ID, "resolved");
  });

  it("refuses an unknown ticket with the list of what exists to check", async () => {
    const actions = fakeActions({ tickets: fakeTickets({ list: async () => TICKETS }) });

    await expect(
      claimTicketTool.execute(claimTicketTool.validate({ ticket: "99" }), context(actions)),
    ).rejects.toThrow(/no ticket/);
  });

  it("reports transcript size, and refuses when there is none", async () => {
    const withTranscript = fakeActions({
      tickets: fakeTickets({
        list: async () => TICKETS,
        transcript: async () => ({ ok: true, messageCount: 12 }),
      }),
    });
    const without = fakeActions({
      tickets: fakeTickets({
        list: async () => TICKETS,
        transcript: async () => ({ ok: false, detail: "this ticket has no stored transcript yet" }),
      }),
    });

    const stored = await readTicketTranscriptTool.execute(
      readTicketTranscriptTool.validate({ ticket: "12" }),
      context(withTranscript),
    );
    expect(stored.detail).toContain("12 messages");

    await expect(
      readTicketTranscriptTool.execute(
        readTicketTranscriptTool.validate({ ticket: "12" }),
        context(without),
      ),
    ).rejects.toThrow(/no stored transcript/);
  });

  it("refuses clearly when the process has no ticket module wired", async () => {
    const actions = fakeActions({ tickets: undefined });

    await expect(
      listTicketsTool.execute(listTicketsTool.validate({}), context(actions)),
    ).rejects.toThrow(/tickets are not available/);
  });

  it("keeps ticket operations out of strict mode, and delete with the destructive ones", () => {
    const strict = new Set(
      [
        listTicketsTool,
        claimTicketTool,
        closeTicketTool,
        readTicketTranscriptTool,
        deleteTicketTool,
      ].flatMap((tool) => buildToolMenu([tool], "strict").tools.map((candidate) => candidate.name)),
    );
    const large = new Set(
      [
        listTicketsTool,
        claimTicketTool,
        closeTicketTool,
        readTicketTranscriptTool,
        deleteTicketTool,
      ].flatMap((tool) => buildToolMenu([tool], "large").tools.map((candidate) => candidate.name)),
    );

    expect(strict.size).toBe(0);
    expect(large.size).toBe(5);
    expect(deleteTicketTool.category).toBe("destructive");
  });
});
