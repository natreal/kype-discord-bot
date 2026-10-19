/**
 * Privilege-escalation regressions.
 *
 * The incident: a normal member could give themselves the `administrator` power
 * level through `/roles` and then run privileged commands (`/ai enable`) — and,
 * even without any role, could reach `/ai` because the dispatcher and the legacy
 * permission service both *dropped* granular (`custom`) requirements, which are
 * the only gate those commands declare.
 *
 * These tests pin every link of that chain:
 *   1. dispatch translates `custom` into the authorization request;
 *   2. the legacy permission service never silently allows an unresolved `custom`;
 *   3. a class can only be granted by somebody who already holds its permissions;
 *   4. AI tool calls resolve `ai.use` + the tool's business permission through the
 *      guild's role → class mapping.
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";

import { toRequest } from "../../src/interactions/interaction.handler.js";
import {
  AiToolRegistry,
  type AiTool,
  type AiToolActionsPort,
} from "../../src/modules/ai/ai.module.js";
import {
  AuthorizationService,
  BUILT_IN_PERMISSION_CLASSES,
} from "../../src/services/authorization/index.js";
import { PermissionService } from "../../src/services/permissions/index.js";
import { memberStub } from "../helpers/discord.js";
import { testLogger } from "../helpers/logger.js";
import { GUILD_A, createV3Harness, v3Member } from "../helpers/v3-harness.js";

const ADMIN = PermissionFlagsBits.Administrator;
const HELPER_ROLE = "777777777777777711";
const BOT_MANAGER_ROLE = "777777777777777722";

describe("dispatch: granular requirements reach the authorization layer", () => {
  it("carries `custom` through the command → request translation", () => {
    const request = toRequest({
      discord: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageGuild],
      custom: ["server.settings"],
    });

    // The regression: dropping this field turned `/roles` and `/ai` into
    // commands with no effective requirement at all.
    expect(request.custom).toEqual(["server.settings"]);
    expect(request.discord).toEqual([
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageGuild,
    ]);
  });

  it("omits `custom` only when the command declares none", () => {
    expect(toRequest({ discord: [] }).custom).toBeUndefined();
  });
});

describe("legacy permission service: unresolved granular requirements fail closed", () => {
  const service = new PermissionService();

  it("refuses a granular requirement instead of ignoring it", () => {
    const member = memberStub({ permissions: [] });
    const result = service.check(member, { custom: ["ai.configure"] });

    expect(result.allowed).toBe(false);
    expect(result.missing).toEqual(["ai.configure"]);
    expect(result.reason).toContain("authorization layer");
  });

  it("keeps letting administrators and the guild owner through", () => {
    expect(service.can(memberStub({ permissions: [ADMIN] }), { custom: ["ai.configure"] })).toBe(
      true,
    );
    expect(
      service.can(memberStub({ memberId: "owner", ownerId: "owner" }), {
        custom: ["ai.configure"],
      }),
    ).toBe(true);
  });
});

describe("role → class grants: no escalation through /roles", () => {
  it("refuses a helper granting administrator (or moderator) to a role", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, HELPER_ROLE, "helper");
    const helper = v3Member({ guildId: GUILD_A, roleIds: [HELPER_ROLE] });

    // The exact attack: bind a role — possibly the caller's own — to a power
    // level above the one held.
    expect(await authorization.canGrantClass(helper, "administrator")).toBe(false);
    expect(await authorization.canGrantClass(helper, "moderator")).toBe(false);
    // Delegating a class it fully holds stays allowed.
    expect(await authorization.canGrantClass(helper, "helper")).toBe(true);
  });

  it("lets a bot-manager manage bot-manager roles but not administrator ones", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, BOT_MANAGER_ROLE, "bot-manager");
    const manager = v3Member({ guildId: GUILD_A, roleIds: [BOT_MANAGER_ROLE] });

    expect(await authorization.canGrantClass(manager, "bot-manager")).toBe(true);
    expect(await authorization.canGrantClass(manager, "administrator")).toBe(false);
  });

  it("lets Discord administrators and God Access grant anything bindable", async () => {
    const { authorization } = createV3Harness();
    const admin = v3Member({ guildId: GUILD_A, permissions: [ADMIN] });

    expect(await authorization.canGrantClass(admin, "administrator")).toBe(true);
    // `owner` is implied by Discord; no role can ever carry it.
    expect(await authorization.canGrantClass(admin, "owner")).toBe(false);
  });

  it("denies unknown classes and an unwired class store", async () => {
    const { authorization } = createV3Harness();
    expect(
      await authorization.canGrantClass(v3Member({ guildId: GUILD_A }), "does-not-exist"),
    ).toBe(false);

    const withoutStore = new AuthorizationService({ logger: testLogger });
    expect(await withoutStore.canGrantClass(v3Member({ guildId: GUILD_A }), "helper")).toBe(false);
  });

  it("still denies /ai configure to a helper who tried to escalate", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, HELPER_ROLE, "helper");
    const helper = v3Member({ guildId: GUILD_A, roleIds: [HELPER_ROLE] });

    const decision = await authorization.decide(helper, { custom: ["ai.configure"] }, "ai.enable");

    expect(decision.outcome).toBe("DENY_CUSTOM_PERMISSION");
    expect(decision.missing).toEqual(["ai.configure"]);
  });
});

describe("AI tools: granular permissions resolved through role bindings", () => {
  const actions = {} as unknown as AiToolActionsPort;

  /** A tool with no business permission, gated only by `ai.use`. */
  const pingTool: AiTool<unknown, unknown> = {
    name: "ping",
    description: "no-op",
    category: "summary",
    validate: (input) => input,
    execute: async () => ({ ok: true }),
  };

  /** A moderation tool, gated by `ai.use` + `moderation.kick`. */
  const kickTool: AiTool<unknown, unknown> = {
    name: "kick_member",
    description: "kick",
    category: "moderation",
    requiredGranularPermissions: ["moderation.kick"],
    validate: (input) => input,
    execute: async () => ({ ok: true }),
  };

  function registry(): AiToolRegistry {
    const instance = new AiToolRegistry(testLogger);
    instance.register(pingTool);
    instance.register(kickTool);
    return instance;
  }

  function context(authorization: AuthorizationService, invoker: ReturnType<typeof v3Member>) {
    return {
      guildId: GUILD_A,
      invoker,
      permissions: new PermissionService(),
      authorization,
      logger: testLogger,
      actions,
    };
  }

  it("refuses a member with no class, even for a tool that only needs ai.use", async () => {
    const { authorization } = createV3Harness();
    const member = v3Member({ guildId: GUILD_A });

    const outcome = await registry().invoke("ping", {}, context(authorization, member));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("ai.use");
    // The refusal must blame the *member*, not the bot: the model relays this
    // reason verbatim, and "you don't have ..." used to be paraphrased back to
    // the member as "the bot lacks ai.use".
    expect(outcome.reason).toContain("the member who asked (NOT the bot)");
    expect(outcome.reason).not.toContain("you don't have");
  });

  it("allows ai.use but refuses a business permission the class lacks", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, HELPER_ROLE, "helper");
    const helper = v3Member({ guildId: GUILD_A, roleIds: [HELPER_ROLE] });
    const tools = registry();

    expect((await tools.invoke("ping", {}, context(authorization, helper))).ok).toBe(true);

    const kick = await tools.invoke("kick_member", {}, context(authorization, helper));
    expect(kick.ok).toBe(false);
    expect(kick.reason).toContain("moderation.kick");
    expect(kick.reason).toContain("the member who asked (NOT the bot)");
  });

  it("allows the business permission when the class grants it", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, BOT_MANAGER_ROLE, "moderator");
    const moderator = v3Member({ guildId: GUILD_A, roleIds: [BOT_MANAGER_ROLE] });

    const outcome = await registry().invoke("kick_member", {}, context(authorization, moderator));

    expect(outcome.ok).toBe(true);
  });

  it("does not let a role binding from another guild authorize the call", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole("333333333333333333", BOT_MANAGER_ROLE, "moderator");
    const member = v3Member({ guildId: GUILD_A, roleIds: [BOT_MANAGER_ROLE] });

    const outcome = await registry().invoke("kick_member", {}, context(authorization, member));

    expect(outcome.ok).toBe(false);
  });
});

describe("built-in classes: ai.use is reachable for staff, never implied for members", () => {
  it("grants ai.use to every non-implied staff class", () => {
    const staff = BUILT_IN_PERMISSION_CLASSES.filter((definition) => !definition.implied);

    for (const definition of staff) {
      expect(definition.permissions).toContain("ai.use");
    }
  });

  it("resolves ai.use for a member whose role is bound to a staff class", async () => {
    const { authorization, classes } = createV3Harness();
    await classes.bindRole(GUILD_A, HELPER_ROLE, "helper");
    const context = await authorization.contextFor(
      v3Member({ guildId: GUILD_A, roleIds: [HELPER_ROLE] }),
    );

    expect(context.classes).toContain("helper");
    expect(context.customPermissions).toContain("ai.use");
    // A staff class must not gain configuration rights by the same move.
    expect(context.customPermissions).not.toContain("ai.configure");
  });
});
