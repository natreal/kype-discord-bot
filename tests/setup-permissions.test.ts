/**
 * Setup permission tests.
 *
 * Covers the three permission questions V2 has to answer correctly:
 *
 *   1. may this *user* run setup? (Discord layer + God Access)
 *   2. may the *bot* perform the operations? (preflight + structured failure)
 *   3. what may setup grant? (never Administrator, never overly broad)
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";

import { GOD_ACCESS_USER_ID, SetupPermissionService } from "../../src/modules/setup/index.js";
import { filterGodAccounts, isGodAccess } from "../../src/modules/setup/setup-module.js";
import { PermissionService, hasGodAccess } from "../../src/services/permissions/index.js";
import { memberStub } from "../helpers/discord.js";
import { setupGuildStub } from "../helpers/fake-guild.js";
import { testLogger } from "../helpers/logger.js";

const MANAGE_CHANNELS = PermissionFlagsBits.ManageChannels;
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles;
const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
const ADMIN = PermissionFlagsBits.Administrator;
const SEND_MESSAGES = PermissionFlagsBits.SendMessages;
const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;

const permissionService = new PermissionService();

describe("setup authorization", () => {
  it("allows an administrator", () => {
    const member = memberStub({ permissions: [ADMIN] });
    expect(permissionService.can(member, { botPermissions: ["setup.run"] })).toBe(true);
  });

  it("allows a member holding the mapped Discord permissions", () => {
    const member = memberStub({
      permissions: [MANAGE_GUILD, MANAGE_CHANNELS, MANAGE_ROLES, VIEW_CHANNEL, SEND_MESSAGES],
    });
    const result = permissionService.check(member, { botPermissions: ["setup.run"] });

    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("denies a regular member and reports what is missing", () => {
    const member = memberStub({ permissions: [] });
    const result = permissionService.check(member, { botPermissions: ["setup.run"] });

    expect(result.allowed).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.reason).toContain("Discord permissions");
  });

  it("requires every permission setup actually needs, not just ManageGuild", () => {
    const member = memberStub({ permissions: [MANAGE_GUILD] });
    const result = permissionService.check(member, { botPermissions: ["setup.run"] });

    // ManageGuild alone is insufficient: setup creates channels and overwrites.
    expect(result.allowed).toBe(false);
    expect(result.missing.map(String)).toContain(String(MANAGE_CHANNELS));
    expect(
      permissionService.requiredDiscordPermissions({ botPermissions: ["setup.run"] }),
    ).toContain(MANAGE_CHANNELS);
  });
});

describe("God Access", () => {
  it("recognises the configured user ID and nothing else", () => {
    expect(isGodAccess(GOD_ACCESS_USER_ID)).toBe(true);
    expect(hasGodAccess(GOD_ACCESS_USER_ID)).toBe(true);
    expect(isGodAccess("111111111111111111")).toBe(false);
    expect(isGodAccess(null)).toBe(false);
    expect(isGodAccess(undefined)).toBe(false);
  });

  it("grants every permission regardless of the Discord permissions held", () => {
    const member = memberStub({ memberId: GOD_ACCESS_USER_ID, permissions: [] });

    expect(permissionService.can(member, { botPermissions: ["moderation.ban"] })).toBe(true);
    expect(permissionService.can(member, { discord: [ADMIN] })).toBe(true);
    // Even a requirement the catalog does not know about is satisfied.
    expect(
      permissionService.check(member, { botPermissions: ["nonsense.permission" as never] }),
    ).toMatchObject({ allowed: true });
    expect(permissionService.bypassesDiscordChecks(member)).toBe(true);
    expect(permissionService.isGodAccess(member)).toBe(true);
  });

  it("does not leak to other members", () => {
    const member = memberStub({ memberId: "222222222222222222", permissions: [] });

    expect(permissionService.isGodAccess(member)).toBe(false);
    expect(permissionService.can(member, { discord: [ADMIN] })).toBe(false);
  });

  it("keeps God Access out of member lists used by future automated actions", () => {
    const members = [{ id: GOD_ACCESS_USER_ID }, { id: "333333333333333333" }];

    expect(filterGodAccounts(members)).toEqual([{ id: "333333333333333333" }]);
  });
});

describe("bot permission preflight", () => {
  const service = new SetupPermissionService({ logger: testLogger });

  it("reports nothing missing for an administrator bot", () => {
    const guild = setupGuildStub("111111111111111111", [ADMIN]);
    expect(service.missingBotPermissions(guild)).toEqual([]);
  });

  it("names the permissions a granular bot lacks", () => {
    const guild = setupGuildStub("111111111111111111", [VIEW_CHANNEL]);
    const missing = service.missingBotPermissions(guild);

    expect(missing).toContain(MANAGE_CHANNELS);
    expect(missing).toContain(MANAGE_ROLES);
    expect(missing).not.toContain(VIEW_CHANNEL);
    expect(service.describeMissing(missing)).toContain("Missing permissions:");
  });

  it("treats an unresolvable bot member as fully unpermissioned", () => {
    const guild = setupGuildStub("111111111111111111");
    const withoutBot = { ...guild, members: { me: null } };
    expect(service.missingBotPermissions(withoutBot as never).length).toBeGreaterThan(0);
  });
});

describe("declarative overwrite planning", () => {
  const service = new SetupPermissionService({ logger: testLogger });

  it("resolves @everyone and the bot into concrete overwrites", async () => {
    const guild = setupGuildStub("111111111111111111");
    const plans = await service.planOverwrites(guild, [
      {
        target: { kind: "everyone" },
        deny: [SEND_MESSAGES],
        allow: [VIEW_CHANNEL],
        reason: "read-only",
      },
      { target: { kind: "bot" }, allow: [SEND_MESSAGES] },
    ]);

    expect(plans).toHaveLength(2);
    expect(plans[0]?.overwriteId).toBe(guild.id);
    expect(plans[0]?.options["SendMessages"]).toBe(false);
    expect(plans[0]?.options["ViewChannel"]).toBe(true);
    expect(plans[1]?.overwriteId).toBe("bot-user-id");
  });

  it("never grants Administrator, whatever a rule asks for", async () => {
    const guild = setupGuildStub("111111111111111111");
    const plans = await service.planOverwrites(guild, [
      { target: { kind: "everyone" }, allow: [ADMIN, VIEW_CHANNEL] },
    ]);

    expect(plans[0]?.options["Administrator"]).toBeUndefined();
    expect(plans[0]?.options["ViewChannel"]).toBe(true);
  });

  it("skips an unresolvable role instead of guessing a target", async () => {
    const guild = setupGuildStub("111111111111111111");
    const plans = await service.planOverwrites(guild, [
      { target: { kind: "roleName", name: "Support Team" }, allow: [VIEW_CHANNEL] },
    ]);

    // No `Support Team` role exists, so nothing is planned — setup must never widen
    // access to @everyone as a fallback.
    expect(plans).toEqual([]);
  });
});
