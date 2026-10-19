/**
 * Maintenance mode tests.
 *
 * The invariants under test:
 * - the switch is guild-scoped and survives a fresh service instance (it is config);
 * - an automatic window expires on read, with no scheduler row to lose;
 * - only God Access, the guild owner, Administrators and `server.settings` holders
 *   bypass a pause — everyone else, staff included, is stopped;
 * - the interaction handler refuses a paused command *before* it executes, and
 *   still lets an exempt member through.
 */
import { GuildMember, PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";

import maintenanceCommand from "../src/commands/utility/maintenance.js";
import { CommandRegistry } from "../src/commands/command.registry.js";
import {
  InteractionHandler,
  type InteractionHandlerDeps,
} from "../src/interactions/interaction.handler.js";
import {
  MAINTENANCE_TITLE,
  MaintenanceService,
  type MaintenanceServiceOptions,
} from "../src/services/maintenance/index.js";
import { PermissionClassStore } from "../src/services/authorization/index.js";
import {
  GOD_ACCESS_USER_ID,
  GUILD_A,
  GUILD_B,
  USER_ID,
  createV3Harness,
  v3Member,
  type V3Harness,
} from "./helpers/v3-harness.js";
import { testLogger } from "./helpers/logger.js";

const ACTOR = { id: USER_ID, kind: "user" as const };
const START = Date.parse("2026-01-01T12:00:00.000Z");

/** Builds the real service over the in-memory V3 harness. */
function createMaintenance(overrides: Partial<MaintenanceServiceOptions> = {}): {
  v3: V3Harness;
  maintenance: MaintenanceService;
} {
  const v3 = createV3Harness();
  const maintenance = new MaintenanceService({
    config: v3.config,
    permissions: v3.permissions,
    authorization: v3.authorization,
    logger: testLogger,
    ...overrides,
  });
  return { v3, maintenance };
}

/** A member the handler sees as a real discord.js `GuildMember`. */
function gatedMember(options: Parameters<typeof v3Member>[0]): GuildMember {
  const member = v3Member(options);
  // `v3Member` returns a structurally correct stub; the handler legitimately uses
  // `instanceof GuildMember` to decide whether it can trust `member`.
  Object.setPrototypeOf(member, GuildMember.prototype);
  return member;
}

describe("MaintenanceService", () => {
  it("starts inactive for a guild that has never enabled it", async () => {
    const { maintenance } = createMaintenance();
    const status = await maintenance.status(GUILD_A);

    expect(status.active).toBe(false);
    expect(status.expired).toBe(false);
    expect(status.state.enabled).toBe(false);
    expect(status.remainingMs).toBeNull();
  });

  it("persists who enabled it, why and since when", async () => {
    const { v3, maintenance } = createMaintenance({ now: () => START });

    const status = await maintenance.enable(GUILD_A, {
      minutes: 45,
      reason: "  Updating the bot  ",
      actor: ACTOR,
    });

    expect(status.active).toBe(true);
    expect(status.state.enabled).toBe(true);
    expect(status.state.reason).toBe("Updating the bot");
    expect(status.state.by).toBe(USER_ID);
    expect(status.state.since).toBe(new Date(START).toISOString());
    expect(status.state.until).toBe(new Date(START + 45 * 60_000).toISOString());
    expect(status.remainingMs).toBe(45 * 60_000);

    // A fresh read (what a restart does) sees the same state: it lives in config.
    expect((await maintenance.status(GUILD_A)).state.until).toBe(status.state.until);
    // The write is audited like every other configuration change.
    expect(
      v3.auditEvents.some(
        (event) =>
          event.action === "config.update" &&
          Array.isArray(event.details?.sections) &&
          event.details.sections.includes("maintenance"),
      ),
    ).toBe(true);
  });

  it("resumes by itself when the window elapses, without rewriting storage", async () => {
    let now = START;
    const { maintenance } = createMaintenance({ now: () => now });

    await maintenance.enable(GUILD_A, { minutes: 30, actor: ACTOR });
    expect(await maintenance.isActive(GUILD_A)).toBe(true);

    now = START + 30 * 60_000;
    const status = await maintenance.status(GUILD_A);

    expect(status.active).toBe(false);
    expect(status.expired).toBe(true);
    // The stored intent is left alone: expiry is a derived fact, not a write.
    expect(status.state.enabled).toBe(true);
    expect(status.remainingMs).toBe(0);
  });

  it("treats an omitted duration as 'until turned off'", async () => {
    const { maintenance } = createMaintenance({ now: () => START });

    const status = await maintenance.enable(GUILD_A, { actor: ACTOR });

    expect(status.state.until).toBeNull();
    expect(status.remainingMs).toBeNull();
    expect(status.active).toBe(true);
  });

  it("clears the window when disabled", async () => {
    const { maintenance } = createMaintenance({ now: () => START });

    await maintenance.enable(GUILD_A, {
      minutes: 60,
      reason: "Migration",
      actor: ACTOR,
    });
    const status = await maintenance.disable(GUILD_A, ACTOR);

    expect(status.active).toBe(false);
    expect(status.state).toEqual({
      enabled: false,
      reason: "",
      since: null,
      until: null,
      by: null,
    });
  });

  it("keeps maintenance isolated per guild", async () => {
    const { maintenance } = createMaintenance({ now: () => START });

    await maintenance.enable(GUILD_A, { actor: ACTOR });

    expect(await maintenance.isActive(GUILD_A)).toBe(true);
    expect(await maintenance.isActive(GUILD_B)).toBe(false);
  });
});

describe("MaintenanceService exemptions", () => {
  it("exempts God Access, the guild owner and Administrators", async () => {
    const { maintenance } = createMaintenance();

    await expect(
      maintenance.isExempt(gatedMember({ guildId: GUILD_A, userId: GOD_ACCESS_USER_ID })),
    ).resolves.toBe(true);
    await expect(
      maintenance.isExempt(gatedMember({ guildId: GUILD_A, userId: USER_ID, ownerId: USER_ID })),
    ).resolves.toBe(true);
    await expect(
      maintenance.isExempt(
        gatedMember({ guildId: GUILD_A, permissions: [PermissionFlagsBits.Administrator] }),
      ),
    ).resolves.toBe(true);
  });

  it("exempts a role bound to a class that grants server.settings", async () => {
    const { v3, maintenance } = createMaintenance();
    const roleId = "555555555555555555";

    // A plain member is not exempt until the role is bound to `bot-manager`.
    const member = gatedMember({ guildId: GUILD_A, roleIds: [roleId] });
    expect(await maintenance.isExempt(member)).toBe(false);

    await v3.classes.bindRole(GUILD_A, roleId, "bot-manager");
    expect(await maintenance.isExempt(member)).toBe(true);
  });

  it("does not exempt an ordinary member, and fails closed without a member", async () => {
    const { maintenance } = createMaintenance();
    await maintenance.enable(GUILD_A, { actor: ACTOR });

    const gate = await maintenance.inspect(GUILD_A, gatedMember({ guildId: GUILD_A }));

    expect(gate.status.active).toBe(true);
    expect(gate.exempt).toBe(false);
    // An unresolvable member must never be treated as exempt.
    expect((await maintenance.inspect(GUILD_A, null)).exempt).toBe(false);
  });

  it("exempts an operator while the guild is paused", async () => {
    const { maintenance } = createMaintenance();
    await maintenance.enable(GUILD_A, { actor: ACTOR });

    const member = gatedMember({
      guildId: GUILD_A,
      permissions: [PermissionFlagsBits.Administrator],
    });

    expect((await maintenance.inspect(GUILD_A, member)).exempt).toBe(true);
  });
});

/** Minimal handler wiring: only the gate and one stub command are exercised. */
function createHandler(
  v3: V3Harness,
  maintenance: MaintenanceService,
): { handler: InteractionHandler; executed: () => boolean } {
  const commands = new CommandRegistry();
  let executed = false;

  commands.register({
    kind: "slash",
    meta: { name: "ping", description: "Ping", category: "core" },
    name: "ping",
    description: "Ping",
    category: "core",
    permissions: {},
    guildOnly: true,
    deploy: true,
    data: { name: "ping" },
    execute: () => {
      executed = true;
      return Promise.resolve();
    },
  } as never);

  const handler = new InteractionHandler({
    logger: testLogger,
    commands,
    permissions: v3.permissions,
    authorization: v3.authorization,
    permissionClasses: new PermissionClassStore({ logger: testLogger, repository: v3.classes }),
    maintenance,
    config: v3.config,
    audit: v3.audit,
    startedAt: Date.now(),
    deployment: {},
    setupResources: [],
    createSetupContext: () => ({ definitions: [], resources: {}, permissionService: {} }),
    createModerationContext: () => ({ service: {}, members: {} }),
    createSecurityContext: () => ({ service: {}, actions: {} }),
    createAutomodContext: () => ({ service: {} }),
    createTicketContext: () => ({ service: {} }),
    createBackupService: () => ({}),
    client: {},
    appConfig: {},
    database: {},
    setup: {},
  } as unknown as InteractionHandlerDeps);

  return { handler, executed: () => executed };
}

/** A slash interaction carrying (or deliberately missing) a member. */
function fakeInteraction(
  member: GuildMember | null,
  replies: unknown[],
): import("discord.js").ChatInputCommandInteraction {
  return {
    id: "interaction-1",
    commandName: "ping",
    guildId: GUILD_A,
    guild: member?.guild ?? { id: GUILD_A, name: "Guild A", ownerId: "999999999999999999" },
    channelId: "channel-1",
    user: { id: member?.id ?? USER_ID, username: "tester" },
    member,
    inGuild: () => true,
    isChatInputCommand: () => true,
    isRepliable: () => true,
    deferred: false,
    replied: false,
    reply: (payload: unknown) => {
      replies.push(payload);
      return Promise.resolve();
    },
    followUp: (payload: unknown) => {
      replies.push(payload);
      return Promise.resolve();
    },
  } as unknown as import("discord.js").ChatInputCommandInteraction;
}

describe("maintenance gate in the interaction handler", () => {
  it("refuses a paused command before it executes", async () => {
    const { v3, maintenance } = createMaintenance();
    await maintenance.enable(GUILD_A, { actor: ACTOR, reason: "Update" });

    const { handler, executed } = createHandler(v3, maintenance);
    const replies: unknown[] = [];
    await handler.handle(fakeInteraction(gatedMember({ guildId: GUILD_A }), replies));

    expect(executed()).toBe(false);
    const payload = replies[0] as { embeds?: { data: { title?: string } }[] };
    expect(payload.embeds?.[0]?.data.title).toBe(MAINTENANCE_TITLE);
  });

  it("fails closed when the member cannot be resolved", async () => {
    const { v3, maintenance } = createMaintenance();
    await maintenance.enable(GUILD_A, { actor: ACTOR });

    const { handler, executed } = createHandler(v3, maintenance);
    const replies: unknown[] = [];
    await handler.handle(fakeInteraction(null, replies));

    expect(executed()).toBe(false);
    expect(replies).toHaveLength(1);
  });

  it("lets an exempt operator run the command while the guild is paused", async () => {
    const { v3, maintenance } = createMaintenance();
    await maintenance.enable(GUILD_A, { actor: ACTOR });

    const { handler, executed } = createHandler(v3, maintenance);
    const replies: unknown[] = [];
    await handler.handle(
      fakeInteraction(
        gatedMember({ guildId: GUILD_A, permissions: [PermissionFlagsBits.Administrator] }),
        replies,
      ),
    );

    expect(executed()).toBe(true);
    expect(replies).toEqual([]);
  });
});

describe("/maintenance command", () => {
  it("requires server.settings, the same set that bypasses a pause", () => {
    expect(maintenanceCommand.name).toBe("maintenance");
    expect(maintenanceCommand.category).toBe("utility");
    expect(maintenanceCommand.deploy).toBe(true);
    expect(maintenanceCommand.permissions.custom).toEqual(["server.settings"]);
    expect(maintenanceCommand.permissions.discord).toBeUndefined();
  });

  it("takes one required on/off/status action, plus an optional reason and window", () => {
    const json = maintenanceCommand.data.toJSON() as {
      options?: { name: string; required?: boolean; choices?: { value: string }[] }[];
    };
    const options = json.options ?? [];
    const action = options.find((option) => option.name === "action");

    // One command with an `action` parameter — not three subcommands.
    expect(options.map((option) => option.name)).toEqual(["action", "reason", "minutes"]);
    expect(action?.required).toBe(true);
    expect(action?.choices?.map((choice) => choice.value)).toEqual(["on", "off", "status"]);
  });
});
