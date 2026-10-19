/**
 * Permission diagnostics.
 *
 * Reports the bot's own Discord permissions, naming the missing ones explicitly:
 * "⚠ Manage Roles" is actionable, "permission error" is not. Administrator is
 * treated as satisfying everything, matching Discord's semantics.
 */
import { PermissionFlagsBits, PermissionsBitField, type PermissionResolvable } from "discord.js";

import { CRITICAL_PERMISSIONS, RECOMMENDED_PERMISSIONS } from "../../services/permissions/index.js";
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";

/** Critical + recommended permissions the bot should hold. */
const EXPECTED_PERMISSIONS: readonly PermissionResolvable[] = [
  ...CRITICAL_PERMISSIONS,
  ...RECOMMENDED_PERMISSIONS,
];

/**
 * @returns human-readable names for a set of permission bitfields.
 *
 * Discord's `PermissionFlagsBits` are `bigint`s, so `${permission}` yields `32`
 * — useless in a report an administrator has to act on. `PermissionsBitField`
 * knows the canonical names (`ManageRoles`); the report shows the spaced form
 * (`Manage Roles`) that Discord itself displays.
 */
function permissionNames(permissions: readonly PermissionResolvable[]): string[] {
  return permissions.map((permission) => {
    const names = new PermissionsBitField(PermissionsBitField.resolve(permission)).toArray();
    return names.length > 0 ? names.map(spaced).join(", ") : String(permission);
  });
}

/** @returns `ManageRoles` as `Manage Roles`. */
function spaced(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Bot permission coverage for the guild under diagnosis. */
export const botPermissionsDiagnostic: Diagnostic = {
  id: "permissions.bot",
  category: "permissions",
  label: "Bot permissions",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    const me = guild?.members.me ?? null;

    if (!guild || !me) {
      return Promise.resolve({
        id: "permissions.bot",
        category: "permissions",
        label: "Bot permissions",
        status: "fail",
        detail: "The bot member could not be resolved for this server.",
        remediation: "Run `/diagnostics` inside the server, not in a DM.",
      });
    }

    if (me.permissions.has(PermissionFlagsBits.Administrator)) {
      return Promise.resolve({
        id: "permissions.bot",
        category: "permissions",
        label: "Bot permissions",
        status: "pass",
        detail: "The bot holds Administrator, which satisfies every requirement.",
      });
    }

    const missingPermissions = EXPECTED_PERMISSIONS.filter(
      (permission) => !me.permissions.has(permission),
    );
    if (missingPermissions.length === 0) {
      return Promise.resolve({
        id: "permissions.bot",
        category: "permissions",
        label: "Bot permissions",
        status: "pass",
        detail: `All ${EXPECTED_PERMISSIONS.length} expected permissions are granted.`,
      });
    }

    // Comparison stays on the *bitfields*: the human-readable names are for the
    // report only, and feeding a formatted name back into Discord's resolver
    // would be a bug waiting to happen.
    const missingCritical = missingPermissions.some((permission) =>
      CRITICAL_PERMISSIONS.some((critical) => critical === permission),
    );

    return Promise.resolve({
      id: "permissions.bot",
      category: "permissions",
      label: "Bot permissions",
      status: missingCritical ? "fail" : "warn",
      detail: `Missing ${permissionNames(missingPermissions).join(", ")}.`,
      remediation: "Re-invite the bot with the recommended profile (see `/admin invite`).",
      metrics: { missing: missingPermissions.length },
    });
  },
};

/** Whether the bot can actually manage the resources setup owns. */
export const setupPermissionsDiagnostic: Diagnostic = {
  id: "permissions.setup",
  category: "permissions",
  label: "Setup permissions",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return Promise.resolve({
        id: "permissions.setup",
        category: "permissions",
        label: "Setup permissions",
        status: "fail",
        detail: "Setup permissions can only be checked inside a server.",
      });
    }

    const me = guild.members.me ?? null;
    if (!me) {
      return Promise.resolve({
        id: "permissions.setup",
        category: "permissions",
        label: "Setup permissions",
        status: "fail",
        detail: "The bot member could not be resolved for this server.",
      });
    }

    if (me.permissions.has(PermissionFlagsBits.Administrator)) {
      return Promise.resolve({
        id: "permissions.setup",
        category: "permissions",
        label: "Setup permissions",
        status: "pass",
        detail: "Administrator covers every setup requirement.",
      });
    }

    const missing = context.setupContext
      ? context.setupContext.permissionService.missingBotPermissions(guild)
      : [];

    if (missing.length > 0) {
      return Promise.resolve({
        id: "permissions.setup",
        category: "permissions",
        label: "Setup permissions",
        status: "fail",
        detail: `Setup cannot run: missing ${permissionNames(missing).join(", ")}.`,
        remediation: "Grant Manage Channels and Manage Roles, or re-invite with `/admin invite`.",
        metrics: { missing: missing.length },
      });
    }

    return Promise.resolve({
      id: "permissions.setup",
      category: "permissions",
      label: "Setup permissions",
      status: "pass",
      detail: "The bot can create and configure channels and roles.",
    });
  },
};

/** Every permission check. */
export const PERMISSION_DIAGNOSTICS: readonly Diagnostic[] = [
  botPermissionsDiagnostic,
  setupPermissionsDiagnostic,
];
