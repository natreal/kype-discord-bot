/**
 * `/leave` tests.
 *
 * Leaving a server is easy to get subtly wrong in three ways, so each is
 * asserted directly:
 *
 *   1. **the reply is sent before the bot leaves** — once it has left, it cannot
 *      answer in that channel, and an unanswered interaction reads as a failure;
 *   2. **a refused leave is reported, not thrown** — the operator must learn that
 *      the bot is still in the server, and every other guild keeps being served;
 *   3. **only the bot owner may invoke it** — God Access or Discord's application
 *      owner, never a guild administrator.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction, Guild } from "discord.js";

import leaveCommand, { isBotOwner } from "../src/commands/utility/leave.js";
import { GuildLeaveService } from "../src/services/guild/index.js";
import { GOD_ACCESS_USER_ID } from "../src/modules/setup/index.js";
import type { CommandExecutionContext } from "../src/commands/context.js";
import { testLogger } from "./helpers/logger.js";

const GUILD_ID = "222222222222222222";
const GUILD_NAME = "Test Guild";
const STRANGER_ID = "555555555555555555";

/** Records what happened, in order, so the reply-before-leave rule is observable. */
function guildStub(events: string[], options: { fail?: boolean } = {}): Guild {
  return {
    id: GUILD_ID,
    name: GUILD_NAME,
    leave: () => {
      events.push("leave");
      return options.fail
        ? Promise.reject(new Error("Missing Access"))
        : Promise.resolve(null as unknown as Guild);
    },
  } as unknown as Guild;
}

function createService(events: string[], delayMs = 25): GuildLeaveService {
  return new GuildLeaveService({
    logger: testLogger,
    delayMs,
    sleep: (ms) => {
      events.push(`sleep:${ms}`);
      return Promise.resolve();
    },
  });
}

describe("GuildLeaveService", () => {
  it("waits for the reply before leaving", async () => {
    const events: string[] = [];

    const outcome = await createService(events).leave({
      guild: guildStub(events),
      actorId: GOD_ACCESS_USER_ID,
      actorTag: "owner#0001",
    });

    expect(events).toEqual(["sleep:25", "leave"]);
    expect(outcome).toEqual({ ok: true, guildId: GUILD_ID, guildName: GUILD_NAME });
  });

  it("can leave immediately when the grace period is disabled", async () => {
    const events: string[] = [];

    await createService(events, 0).leave({
      guild: guildStub(events),
      actorId: GOD_ACCESS_USER_ID,
      actorTag: "owner#0001",
    });

    expect(events).toEqual(["leave"]);
  });

  it("reports a refused leave instead of throwing", async () => {
    const events: string[] = [];

    const outcome = await createService(events).leave({
      guild: guildStub(events, { fail: true }),
      actorId: GOD_ACCESS_USER_ID,
      actorTag: "owner#0001",
      reason: "cleanup",
    });

    // The bot keeps running and stays in the guild; the caller decides what to say.
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("Missing Access");
  });
});

describe("/leave authorization", () => {
  function interactionStub(userId: string): ChatInputCommandInteraction {
    return { user: { id: userId, tag: "user#0001" } } as unknown as ChatInputCommandInteraction;
  }

  function contextWithOwner(ownerId: string | null): CommandExecutionContext {
    return {
      client: { application: { owner: ownerId === null ? null : { id: ownerId } } },
    } as unknown as CommandExecutionContext;
  }

  it("accepts God Access", () => {
    expect(isBotOwner(interactionStub(GOD_ACCESS_USER_ID), contextWithOwner(null))).toBe(true);
  });

  it("accepts the application owner Discord reports", () => {
    expect(
      isBotOwner(interactionStub("777777777777777777"), contextWithOwner("777777777777777777")),
    ).toBe(true);
  });

  it("rejects everyone else, including a guild owner", () => {
    expect(isBotOwner(interactionStub(STRANGER_ID), contextWithOwner(null))).toBe(false);
    expect(isBotOwner(interactionStub(STRANGER_ID), contextWithOwner("777777777777777777"))).toBe(
      false,
    );
  });
});

describe("/leave command", () => {
  function commandContext(events: string[], ownerId: string | null = null) {
    const record = vi.fn(() => Promise.resolve());
    return {
      context: {
        client: { application: { owner: ownerId === null ? null : { id: ownerId } } },
        guildLeave: createService(events),
        audit: { record },
      } as unknown as CommandExecutionContext,
      record,
    };
  }

  function commandInteraction(userId: string, events: string[], fail = false) {
    const reply = vi.fn(() => Promise.resolve());
    const editReply = vi.fn(() => Promise.resolve());
    const interaction = {
      user: { id: userId, tag: "user#0001" },
      guild: guildStub(events, { fail }),
      options: { getString: (name: string) => (name === "reason" ? "cleaning up" : null) },
      reply,
      editReply,
    } as unknown as ChatInputCommandInteraction;
    return { interaction, reply, editReply };
  }

  it("refuses a non-owner without touching the guild", async () => {
    const events: string[] = [];
    const { interaction, reply } = commandInteraction(STRANGER_ID, events);
    const { context, record } = commandContext(events);

    await leaveCommand.execute(interaction, context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("leaves for the bot owner and records the outcome", async () => {
    const events: string[] = [];
    const { interaction, reply, editReply } = commandInteraction(GOD_ACCESS_USER_ID, events);
    const { context, record } = commandContext(events);

    await leaveCommand.execute(interaction, context);

    // The reply goes out first; only then does the service leave.
    expect(reply).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["sleep:25", "leave"]);
    expect(editReply).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        action: "guild.leave",
        outcome: "success",
        actorId: GOD_ACCESS_USER_ID,
        details: { guildName: GUILD_NAME, reason: "cleaning up" },
      }),
    );
  });

  it("tells the operator when Discord refuses the leave", async () => {
    const events: string[] = [];
    const { interaction, reply, editReply } = commandInteraction(GOD_ACCESS_USER_ID, events, true);
    const { context, record } = commandContext(events);

    await leaveCommand.execute(interaction, context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });
});
