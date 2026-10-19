/**
 * Built-in permission classes.
 *
 * These are the *template* definitions for role → permission mapping. A guild
 * gets an effective set of classes from two sources:
 *
 *   1. these built-ins (always present, never deletable), and
 *   2. rows in `permission_classes` / `role_permission_classes` for that guild.
 *
 * A class only grants anything once a Discord role is bound to it, which keeps
 * the mechanism safe by default: installing the bot never silently grants
 * moderation powers to whoever happens to hold an `@everyone` role.
 *
 * The class list is a *foundation*: only the mechanism and the built-ins exist in
 * V3. Custom classes and a full role-management UI are later work.
 */
import type { Permission } from "./permissions.js";

/** Class key of a built-in class. */
export type BuiltInPermissionClassKey =
  | "owner"
  | "administrator"
  | "bot-manager"
  | "senior-moderator"
  | "moderator"
  | "helper"
  | "support";

export interface PermissionClassDefinition {
  /** Stable identifier within the guild, e.g. `senior-moderator`. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /** Built-in classes cannot be deleted or renamed through commands. */
  readonly builtIn: boolean;
  /** Higher wins when a member matches several classes. */
  readonly priority: number;
  /**
   * When true, the class is implied by Discord's own authorization rather than
   * by a role binding (guild owner, Administrator permission).
   */
  readonly implied?: boolean;
}

/** Shortest spelling of the permission constants, for readable definitions. */
const P = {
  setup: "server.setup",
  settings: "server.settings",
  diagnostics: "server.diagnostics",
  logsView: "logs.view",
  logsConfigure: "logs.configure",
  warn: "moderation.warn",
  mute: "moderation.mute",
  timeout: "moderation.timeout",
  kick: "moderation.kick",
  ban: "moderation.ban",
  unban: "moderation.unban",
  purge: "moderation.purge",
  moderationView: "moderation.view",
  securityView: "security.view",
  securityLockdown: "security.lockdown",
  securityConfigure: "security.configure",
  ticketsView: "tickets.view",
  ticketsManage: "tickets.manage",
  aiUse: "ai.use",
  aiConfigure: "ai.configure",
  analyticsView: "analytics.view",
  coreUse: "core.use",
} as const satisfies Record<string, Permission>;

/**
 * The built-in classes, ordered from most to least privileged.
 *
 * `owner` and `administrator` are `implied`: a guild owner and a member holding
 * Discord `Administrator` are treated as holding the class without a role
 * binding, because Discord itself already grants them that authority.
 */
export const BUILT_IN_PERMISSION_CLASSES: readonly PermissionClassDefinition[] = [
  {
    key: "owner",
    name: "Owner",
    description: "The guild owner. Implied by Discord, never bound to a role.",
    permissions: Object.values(P),
    builtIn: true,
    priority: 100,
    implied: true,
  },
  {
    key: "administrator",
    name: "Administrator",
    description: "Members holding Discord's Administrator permission. Implied.",
    permissions: Object.values(P),
    builtIn: true,
    priority: 90,
    implied: true,
  },
  {
    key: "bot-manager",
    name: "Bot Manager",
    description: "Manages the bot's own configuration: setup, settings, diagnostics.",
    permissions: [
      P.setup,
      P.settings,
      P.diagnostics,
      P.logsView,
      P.logsConfigure,
      P.securityView,
      P.securityConfigure,
      P.ticketsView,
      P.ticketsManage,
      P.aiUse,
      P.aiConfigure,
      P.analyticsView,
      P.coreUse,
    ],
    builtIn: true,
    priority: 70,
  },
  {
    key: "senior-moderator",
    name: "Senior Moderator",
    description: "Full moderation range, plus moderation configuration and security lockdown.",
    permissions: [
      P.coreUse,
      P.moderationView,
      P.warn,
      P.mute,
      P.timeout,
      P.kick,
      P.ban,
      P.unban,
      P.purge,
      P.logsView,
      P.securityView,
      P.securityLockdown,
      P.ticketsView,
      P.ticketsManage,
      P.aiUse,
    ],
    builtIn: true,
    priority: 60,
  },
  {
    key: "moderator",
    name: "Moderator",
    description: "Day-to-day moderation: warnings, mutes, timeouts, kicks, message cleanup.",
    permissions: [
      P.coreUse,
      P.moderationView,
      P.warn,
      P.mute,
      P.timeout,
      P.kick,
      P.purge,
      P.logsView,
      P.ticketsView,
      P.aiUse,
    ],
    builtIn: true,
    priority: 50,
  },
  {
    key: "helper",
    name: "Helper",
    description: "Light-touch moderation: warnings and message cleanup.",
    permissions: [P.coreUse, P.moderationView, P.warn, P.purge, P.logsView, P.aiUse],
    builtIn: true,
    priority: 30,
  },
  {
    key: "support",
    name: "Support",
    description: "Ticket handling without moderation powers.",
    permissions: [P.coreUse, P.ticketsView, P.ticketsManage, P.logsView, P.aiUse],
    builtIn: true,
    priority: 20,
  },
];

const CLASS_BY_KEY: ReadonlyMap<string, PermissionClassDefinition> = new Map(
  BUILT_IN_PERMISSION_CLASSES.map((definition) => [definition.key, definition]),
);

/** @returns the built-in class definition for `key`, or `undefined`. */
export function builtInPermissionClass(key: string): PermissionClassDefinition | undefined {
  return CLASS_BY_KEY.get(key);
}

/**
 * @returns every distinct permission any class grants.
 *
 * Used by diagnostics to report which permissions the deployment can actually
 * hand out, and to spot a class that grants a permission no module checks.
 */
export function permissionsGrantedByClasses(): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const definition of BUILT_IN_PERMISSION_CLASSES) {
    for (const permission of definition.permissions) {
      granted.add(permission);
    }
  }
  return [...granted].sort();
}
