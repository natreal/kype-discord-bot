/**
 * Permission service tests.
 *
 * Proves the two-layer design: Discord permissions are enforced today, and the
 * named bot permission catalog (`moderation.ban`, ...) already resolves to them.
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";

import {
  BOT_PERMISSIONS,
  PermissionService,
  botPermissionsForDiscord,
  isBotPermission,
} from "../../src/services/permissions/index.js";
import { PermissionError } from "../../src/utils/errors.js";
import { memberStub } from "../helpers/discord.js";

const ADMIN = PermissionFlagsBits.Administrator;
const BAN = PermissionFlagsBits.BanMembers;
const KICK = PermissionFlagsBits.KickMembers;

describe("bot permission catalog", () => {
  it("contains the documented long-term permissions", () => {
    expect(BOT_PERMISSIONS).toContain("moderation.warn");
    expect(BOT_PERMISSIONS).toContain("moderation.kick");
    expect(BOT_PERMISSIONS).toContain("moderation.ban");
    expect(BOT_PERMISSIONS).toContain("security.lockdown");
    expect(BOT_PERMISSIONS).toContain("security.configure");
    expect(BOT_PERMISSIONS).toContain("ai.configure");
    expect(BOT_PERMISSIONS).toContain("tickets.manage");
    expect(BOT_PERMISSIONS).toContain("analytics.view");
    expect(BOT_PERMISSIONS).toContain("automation.manage");
  });

  it("rejects unknown permission names", () => {
    expect(isBotPermission("moderation.ban")).toBe(true);
    expect(isBotPermission("moderation.explode")).toBe(false);
  });

  it("maps bot permissions onto Discord permissions", () => {
    expect(botPermissionsForDiscord(["moderation.ban"])).toEqual([BAN]);
    expect(botPermissionsForDiscord(["moderation.kick", "moderation.ban"])).toEqual([KICK, BAN]);
    expect(botPermissionsForDiscord(["core.use"])).toEqual([]);
  });
});

describe("PermissionService.can", () => {
  const service = new PermissionService();

  it("allows a member with the required Discord permission", () => {
    const member = memberStub({ permissions: [BAN] });

    expect(service.can(member, { discord: [BAN] })).toBe(true);
    expect(service.check(member, { discord: [BAN] }).missing).toEqual([]);
  });

  it("denies a member without the required permission and reports what is missing", () => {
    const member = memberStub({ permissions: [KICK] });
    const result = service.check(member, { discord: [BAN] });

    expect(result.allowed).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.reason).toContain("Discord permissions");
  });

  it("always allows administrators and the guild owner", () => {
    const owner = memberStub({ memberId: "owner", ownerId: "owner", permissions: [] });
    expect(service.can(owner, { discord: [BAN] })).toBe(true);

    const admin = memberStub({ permissions: [ADMIN] });
    expect(service.can(admin, { discord: [BAN, KICK] })).toBe(true);
  });

  it("honours ownerOnly requirements", () => {
    const member = memberStub({ permissions: [] });
    expect(service.can(member, { ownerOnly: true })).toBe(false);

    const owner = memberStub({ memberId: "owner", ownerId: "owner" });
    expect(service.can(owner, { ownerOnly: true })).toBe(true);
  });

  it("resolves bot permissions into Discord permission checks", () => {
    const allowed = memberStub({ permissions: [BAN] });
    const denied = memberStub({ permissions: [] });

    expect(service.can(allowed, { botPermissions: ["moderation.ban"] })).toBe(true);
    expect(service.can(denied, { botPermissions: ["moderation.ban"] })).toBe(false);
  });

  it("denies unknown bot permissions for regular members", () => {
    // An invalid catalog entry is a programming error and must not be trusted.
    const regular = memberStub({ permissions: [] });
    expect(service.check(regular, { botPermissions: ["moderation.nuke" as never] }).allowed).toBe(
      false,
    );
  });

  it("assert throws a PermissionError so handlers can respond safely", () => {
    const member = memberStub({ permissions: [] });

    expect(() => service.assert(member, { discord: [BAN] })).toThrow(PermissionError);

    try {
      service.assert(member, { discord: [BAN] }, "unit-test");
    } catch (error) {
      const permissionError = error as PermissionError;
      expect(permissionError.kind).toBe("permission");
      expect(permissionError.expected).toBe(true);
      expect(permissionError.metadata).toMatchObject({ context: "unit-test" });
    }
  });

  it("exposes the Discord permissions a requirement resolves to", () => {
    expect(service.requiredDiscordPermissions({ botPermissions: ["moderation.ban"] })).toEqual([
      BAN,
    ]);
    expect(service.requiredDiscordPermissions({ discord: [KICK] })).toEqual([KICK]);
    expect(service.requiredDiscordPermissions()).toEqual([]);
  });
});
