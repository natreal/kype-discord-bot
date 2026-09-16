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
  permissionsForProfile,
  CRITICAL_PERMISSIONS,
} from "../../src/services/permissions/index.js";
import { buildInviteLink, profilePermissionValue } from "../../src/utils/invite.js";
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

  it("administrators bypass Discord checks but not application policy", () => {
    const admin = memberStub({ permissions: [ADMIN] });

    // Discord layer: bypassed, matching Discord's own semantics.
    expect(service.can(admin, { discord: [BAN] })).toBe(true);
    expect(service.bypassesDiscordChecks(admin)).toBe(true);

    // Bot-permission layer: still validated, so an Administrator install cannot
    // skip moderation/ticket policy that modules rely on.
    expect(service.check(admin, { botPermissions: ["moderation.nuke" as never] }).allowed).toBe(
      false,
    );
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

describe("installation profiles", () => {
  const service = new PermissionService();

  it("requests granular permissions in the recommended profile", () => {
    const permissions = permissionsForProfile("recommended");

    expect(permissions).not.toContain(PermissionFlagsBits.Administrator);
    // Audit log access is mandatory: anti-nuke cannot attribute actions without it.
    expect(permissions).toContain(PermissionFlagsBits.ViewAuditLog);
    expect(permissions).toContain(PermissionFlagsBits.ManageRoles);
    expect(permissions).toContain(PermissionFlagsBits.BanMembers);
  });

  it("requests Administrator only for the administrator profile", () => {
    expect(permissionsForProfile("administrator")).toEqual([PermissionFlagsBits.Administrator]);
  });

  it("reports nothing missing for an administrator bot", () => {
    const bot = memberStub({ permissions: [ADMIN] });
    expect(service.missingCriticalPermissions(bot)).toEqual([]);
    expect(service.isAdministrator(bot)).toBe(true);
  });

  it("reports the critical permissions a granular bot is missing", () => {
    const bot = memberStub({ permissions: [PermissionFlagsBits.ManageChannels] });
    const missing = service.missingCriticalPermissions(bot);

    expect(missing).not.toContain(PermissionFlagsBits.ManageChannels);
    expect(missing).toContain(PermissionFlagsBits.ViewAuditLog);
    expect(missing.length).toBe(CRITICAL_PERMISSIONS.length - 1);
  });

  it("builds a pre-configured invite link with both required scopes", () => {
    const link = new URL(
      buildInviteLink({ clientId: "1549796559346991134", profile: "recommended" }),
    );

    expect(link.origin + link.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(link.searchParams.get("client_id")).toBe("1549796559346991134");
    expect(link.searchParams.get("scope")).toBe("bot applications.commands");
    expect(link.searchParams.get("permissions")).toBe(profilePermissionValue("recommended"));
    expect(link.searchParams.get("guild_id")).toBeNull();
  });

  it("can pre-select a guild so Discord skips the server picker", () => {
    const link = new URL(
      buildInviteLink({
        clientId: "1549796559346991134",
        guildId: "1523780404337840290",
      }),
    );

    expect(link.searchParams.get("guild_id")).toBe("1523780404337840290");
    expect(link.searchParams.get("disable_guild_select")).toBe("true");
  });
});
