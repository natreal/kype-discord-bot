/**
 * V3 authorization tests.
 *
 * Covers the pipeline the brief specifies: Discord permission check → custom
 * permission check → God Access bypass, with structured outcomes and guild
 * isolation.
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";

import {
  PermissionClassStore,
  toPermission,
  toBotPermission,
  unknownPermissions,
} from "../../src/services/authorization/index.js";
import {
  GOD_ACCESS_USER_ID,
  GUILD_A,
  GUILD_B,
  OTHER_USER_ID,
  USER_ID,
  createV3Harness,
  memoryPermissionClasses,
  v3Member,
} from "../helpers/v3-harness.js";
import { testLogger } from "../helpers/logger.js";

const MODERATOR_ROLE = "777777777777777777";
const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;

describe("V3 authorization: Discord permissions", () => {
  it("allows a member holding the required Discord permission", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A, permissions: [MANAGE_GUILD] });

    const decision = await authorization.authorize(member, { discord: [MANAGE_GUILD] }, "settings");

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.allowed).toBe(true);
  });

  it("denies a member missing the required Discord permission", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A, permissions: [] });

    const decision = await authorization.authorize(member, { discord: [MANAGE_GUILD] }, "settings");

    expect(decision.outcome).toBe("DENY_DISCORD_PERMISSION");
    expect(decision.deniedBy).toBe("discord");
    // The missing list carries the permission's resolvable form (Discord's own
    // representation), which the denial message shows to the administrator.
    expect(decision.missing).toHaveLength(1);
    expect(decision.missing[0]).toBe(String(MANAGE_GUILD));
  });

  it("lets the guild owner through without the Discord permission", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A, userId: USER_ID, ownerId: USER_ID });

    const decision = await authorization.authorize(member, { discord: [MANAGE_GUILD] });

    expect(decision.allowed).toBe(true);
    expect(decision.godAccess).toBe(false);
  });

  it("enforces ownerOnly even for an administrator", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({
      guildId: GUILD_A,
      permissions: [PermissionFlagsBits.Administrator],
    });

    const decision = await authorization.authorize(member, { ownerOnly: true });

    expect(decision.outcome).toBe("DENY_OWNER_ONLY");
  });
});

describe("V3 authorization: custom permissions", () => {
  it("allows a member whose role is bound to a class granting the permission", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, MODERATOR_ROLE, "moderator");
    const member = v3Member({ guildId: GUILD_A, roleIds: [MODERATOR_ROLE] });

    const decision = await authorization.authorize(member, { custom: ["moderation.kick"] });

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.godAccess).toBe(false);
  });

  it("denies a custom permission the member's class does not grant", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, MODERATOR_ROLE, "helper");
    const member = v3Member({ guildId: GUILD_A, roleIds: [MODERATOR_ROLE] });

    const decision = await authorization.authorize(member, { custom: ["moderation.ban"] });

    expect(decision.outcome).toBe("DENY_CUSTOM_PERMISSION");
    expect(decision.deniedBy).toBe("custom");
    expect(decision.missing).toEqual(["moderation.ban"]);
  });

  it("does not let a role binding in another guild grant permission here", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_B, MODERATOR_ROLE, "moderator");
    const member = v3Member({ guildId: GUILD_A, roleIds: [MODERATOR_ROLE] });

    const decision = await authorization.authorize(member, { custom: ["moderation.kick"] });

    expect(decision.outcome).toBe("DENY_CUSTOM_PERMISSION");
  });

  it("denies an unknown permission identifier rather than allowing it", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A });

    const decision = await authorization.authorize(member, {
      custom: ["moderation.nonsense" as never],
    });

    expect(decision.outcome).toBe("DENY_UNKNOWN_PERMISSION");
  });
});

describe("V3 authorization: God Access", () => {
  it("allows the owner account to do everything, even with no Discord permissions", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A, userId: GOD_ACCESS_USER_ID, permissions: [] });

    const decision = await authorization.authorize(member, {
      discord: [MANAGE_GUILD],
      custom: ["moderation.ban", "security.configure"],
    });

    expect(decision.outcome).toBe("ALLOW");
    expect(decision.godAccess).toBe(true);
    expect(decision.deniedBy).toBe("god");
  });

  it("records the bypass as a privileged audit event", async () => {
    const { authorization, auditEvents } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A, userId: GOD_ACCESS_USER_ID });

    await authorization.authorize(member, { custom: ["server.settings"] }, "settings");

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "authorization.godAccess",
      severity: "privileged",
      actorKind: "god",
      guildId: GUILD_A,
      actorId: GOD_ACCESS_USER_ID,
    });
  });

  it("is guild-scoped: the bypass applies in every guild, and is recorded per guild", async () => {
    const { authorization, auditEvents } = createV3Harness();

    await authorization.authorize(v3Member({ guildId: GUILD_A, userId: GOD_ACCESS_USER_ID }), {
      custom: ["server.setup"],
    });
    await authorization.authorize(v3Member({ guildId: GUILD_B, userId: GOD_ACCESS_USER_ID }), {
      custom: ["server.setup"],
    });

    expect(auditEvents.map((event) => event.guildId)).toEqual([GUILD_A, GUILD_B]);
  });

  it("does not grant God Access to another user with the same permissions", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({
      guildId: GUILD_A,
      userId: OTHER_USER_ID,
      permissions: [PermissionFlagsBits.Administrator],
    });

    const decision = await authorization.authorize(member, { custom: ["moderation.ban"] });

    // An Administrator holds every built-in class, but is not God Access.
    expect(decision.allowed).toBe(true);
    expect(decision.godAccess).toBe(false);
  });

  /**
   * The admin power level is bindable: a role that does *not* hold Discord's
   * `Administrator` can be bound to the `administrator` class from `/roles bind`,
   * and every member holding that role then gets the full bot permission set —
   * without the role ever being granted a Discord permission bit.
   */
  it("grants the admin power level to a member whose role is bound to `administrator`", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, MODERATOR_ROLE, "administrator");

    const member = v3Member({
      guildId: GUILD_A,
      userId: OTHER_USER_ID,
      roleIds: [MODERATOR_ROLE],
      // No Discord permissions at all: the role is what grants the power level.
      permissions: [],
    });

    const context = await authorization.contextFor(member);

    expect(context.isAdministrator).toBe(false);
    expect(context.classes).toContain("administrator");
    // Every permission the catalog knows is granted by the `administrator` class.
    expect(context.customPermissions).toContain("moderation.ban");
    expect(context.customPermissions).toContain("server.settings");
    expect(context.customPermissions).toContain("security.configure");
    expect(context.customPermissions).toContain("ai.configure");
  });
});

describe("V3 authorization context", () => {
  it("describes the actor's Discord permissions, classes and guild", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, MODERATOR_ROLE, "moderator");
    const member = v3Member({
      guildId: GUILD_A,
      roleIds: [MODERATOR_ROLE],
      permissions: [MANAGE_GUILD],
    });

    const context = await authorization.contextFor(member);

    expect(context.guildId).toBe(GUILD_A);
    expect(context.isGod).toBe(false);
    expect(context.classes).toContain("moderator");
    expect(context.customPermissions).toContain("moderation.kick");
    expect(context.discordPermissions).toContain("ManageGuild");
  });

  it("never reports another guild's classes", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_B, MODERATOR_ROLE, "moderator");
    const member = v3Member({ guildId: GUILD_A, roleIds: [MODERATOR_ROLE] });

    const context = await authorization.contextFor(member);

    expect(context.classes).not.toContain("moderator");
    expect(context.customPermissions).toEqual([]);
  });
});

describe("V3 permission identifiers", () => {
  it("bridges legacy bot permissions onto granular identifiers", () => {
    expect(toPermission("setup.run")).toBe("server.setup");
    expect(toPermission("moderation.ban")).toBe("moderation.ban");
    expect(toPermission("core.settings")).toBe("server.settings");
    expect(toPermission("not.a.permission")).toBeNull();
  });

  it("maps granular identifiers back onto the legacy catalog", () => {
    expect(toBotPermission("server.setup")).toBe("setup.run");
    expect(toBotPermission("moderation.kick")).toBe("moderation.kick");
  });

  it("reports unknown identifiers instead of ignoring them", () => {
    expect(unknownPermissions(["moderation.ban", "nope.nope"])).toEqual(["nope.nope"]);
  });
});

/**
 * `roleIdsGranting` is how the ticket module opens ticket channels to admins without
 * requiring the Discord `Administrator` permission: a role bound to a class that grants
 * `tickets.view` / `tickets.manage` is returned, so the channel overwrite can name it.
 */
describe("V3 authorization: role IDs granting permissions", () => {
  it("returns roles bound to a class that grants the permission", async () => {
    const repository = memoryPermissionClasses();
    const store = new PermissionClassStore({ logger: testLogger, repository });

    await repository.bindRole(GUILD_A, MODERATOR_ROLE, "administrator");

    const roleIds = await store.roleIdsGranting(GUILD_A, ["tickets.view"]);

    expect(roleIds).toContain(MODERATOR_ROLE);
  });

  it("returns nothing for a class that does not grant the permission", async () => {
    const repository = memoryPermissionClasses();
    const store = new PermissionClassStore({ logger: testLogger, repository });

    await repository.bindRole(GUILD_A, MODERATOR_ROLE, "helper");

    // `helper` grants moderation permissions, not tickets.
    const roleIds = await store.roleIdsGranting(GUILD_A, ["tickets.manage"]);

    expect(roleIds).toEqual([]);
  });

  it("does not leak a role binding from another guild", async () => {
    const repository = memoryPermissionClasses();
    const store = new PermissionClassStore({ logger: testLogger, repository });

    await repository.bindRole(GUILD_B, MODERATOR_ROLE, "administrator");

    const roleIds = await store.roleIdsGranting(GUILD_A, ["tickets.view"]);

    expect(roleIds).toEqual([]);
  });

  /**
   * The exact round-trip `/roles bind` and `/roles unbind` perform: write through the
   * store (not the repository directly), then read back through the same methods the
   * command and the authorization layer use. This is what makes a role bound in Discord
   * take effect on the next command with no restart.
   */
  it("round-trips a binding through the store the command uses", async () => {
    const repository = memoryPermissionClasses();
    const store = new PermissionClassStore({ logger: testLogger, repository });

    await store.bindRole(GUILD_A, MODERATOR_ROLE, "support");

    // Bound: the role now shows up in the store's own listing and grants tickets.
    const bindings = await store.listBindings(GUILD_A);
    expect(bindings).toEqual([
      { guildId: GUILD_A, roleId: MODERATOR_ROLE, classKey: "support", label: null },
    ]);
    expect(await store.roleIdsGranting(GUILD_A, ["tickets.manage"])).toEqual([MODERATOR_ROLE]);

    await store.unbindRole(GUILD_A, MODERATOR_ROLE, "support");

    // Unbound: the binding is gone and the role no longer grants anything.
    expect(await store.listBindings(GUILD_A)).toEqual([]);
    expect(await store.roleIdsGranting(GUILD_A, ["tickets.manage"])).toEqual([]);
  });
});
