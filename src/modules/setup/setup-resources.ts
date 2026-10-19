/**
 * The resources the automatic setup system owns.
 *
 * This is a *declarative* registry: the command, the services and the tests all
 * read from it, so "what setup creates" has exactly one definition.
 *
 * Scope discipline (V2): only resources the platform actually uses are declared.
 * There is no moderation channel, ticket category, quarantine role or AI channel
 * here, because those systems do not exist yet — inventing them would contradict
 * the explicit brief not to create channels for features that cannot work. The
 * registry makes adding them a one-entry change once their module ships.
 */
import { PermissionFlagsBits, type PermissionResolvable } from "discord.js";

import { MUTE_ROLE_DENIES, MUTE_ROLE_NAME } from "../moderation/mute-role.spec.js";
import type {
  SetupPermissionOverwrite,
  SetupResourceDefinition,
  SetupResourceType,
} from "../setup.types.js";

/** Permissions granted to the bot on everything setup creates. */
const BOT_MANAGE_PERMISSIONS: readonly PermissionResolvable[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
];

/**
 * Information channels: readable by members, writable only by the bot.
 *
 * Pin-style channels (`#welcome`, `#rules`) are deliberately read-only for
 * `@everyone`; announcing is the bot's job, and a writable `#rules` channel is
 * how servers get raided by spam.
 */
const INFORMATION_CHANNEL_PERMISSIONS: readonly SetupPermissionOverwrite[] = [
  {
    target: { kind: "everyone" },
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.AddReactions,
    ],
    deny: [PermissionFlagsBits.SendMessages],
    reason: "Information channels are read-only for members.",
  },
  {
    target: { kind: "bot" },
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ManageMessages,
    ],
    reason: "The bot must be able to publish and maintain the channel.",
  },
];

/** Log channel: invisible to members, writable by the bot. */
const LOG_CHANNEL_PERMISSIONS: readonly SetupPermissionOverwrite[] = [
  {
    target: { kind: "everyone" },
    deny: [PermissionFlagsBits.ViewChannel],
    reason: "Logs are not readable by regular members.",
  },
  {
    target: { kind: "bot" },
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    reason: "The bot writes the log stream here.",
  },
];

/**
 * Resource keys used across the codebase.
 *
 * Keys are the stable identity persisted in `setup_resources`; renaming one
 * requires a data migration that maps old keys to new ones.
 */
export const SETUP_RESOURCE_KEYS = {
  informationCategory: "information.category",
  welcomeChannel: "information.welcome",
  rulesChannel: "information.rules",
  logsCategory: "logs.category",
  serverLogsChannel: "logs.server-logs",
  mutedRole: "moderation.muted",
} as const;

export type SetupResourceKey = (typeof SETUP_RESOURCE_KEYS)[keyof typeof SETUP_RESOURCE_KEYS];

/**
 * Setup tracking of the log channel.
 *
 * `logging.enabled` defaults to `false`, and delivery is now implemented (the
 * moderation module posts to this channel through its log sink), so the resource
 * is provisioned as soon as logging is enabled and merely tracked before that.
 *
 * The condition is deliberately *not* a hardcoded `false` anymore: a guild that
 * turns logging on and runs `/setup run` gets the channel it asked for, while a
 * guild that leaves logging off keeps a server with no unused channel — and
 * `/setup validate` reports the drift in both directions.
 */
const PROVISION_LOG_CHANNEL = true;

/**
 * Everything setup manages for a guild, in dependency order.
 *
 * Order matters: categories resolve before the channels inside them. The same
 * relationship is also declared through `requires`, so the orchestration can mark
 * dependants as failed-and-explained instead of cascading into confusing errors.
 */
export const SETUP_RESOURCES: readonly SetupResourceDefinition[] = [
  {
    key: SETUP_RESOURCE_KEYS.informationCategory,
    type: "CATEGORY",
    name: "INFORMATION",
    label: "📁 INFORMATION",
    permissions: [
      {
        target: { kind: "bot" },
        allow: BOT_MANAGE_PERMISSIONS,
        reason: "The bot owns the category it created.",
      },
    ],
  },
  {
    key: SETUP_RESOURCE_KEYS.welcomeChannel,
    type: "TEXT_CHANNEL",
    name: "welcome",
    label: "📄 #welcome",
    category: "INFORMATION",
    topic: "Welcome! Start here to find your way around the server.",
    permissions: INFORMATION_CHANNEL_PERMISSIONS,
    requires: [SETUP_RESOURCE_KEYS.informationCategory],
  },
  {
    key: SETUP_RESOURCE_KEYS.rulesChannel,
    type: "TEXT_CHANNEL",
    name: "rules",
    label: "📄 #rules",
    category: "INFORMATION",
    topic: "Server rules. Breaking them may lead to moderation action.",
    permissions: INFORMATION_CHANNEL_PERMISSIONS,
    requires: [SETUP_RESOURCE_KEYS.informationCategory],
  },
  {
    key: SETUP_RESOURCE_KEYS.logsCategory,
    type: "CATEGORY",
    name: "LOGS",
    label: "📁 LOGS",
    permissions: [
      {
        // `@everyone` keeps the category visible but cannot post; the channels
        // inside it decide what is actually readable.
        target: { kind: "everyone" },
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages],
        reason: "The logs category is visible but read-only.",
      },
      {
        target: { kind: "bot" },
        allow: BOT_MANAGE_PERMISSIONS,
        reason: "The bot owns the category it created.",
      },
    ],
  },
  {
    key: SETUP_RESOURCE_KEYS.serverLogsChannel,
    type: "TEXT_CHANNEL",
    name: "server-logs",
    label: "📄 #server-logs",
    category: "LOGS",
    topic: "Automated server logs: members, messages, roles and channels.",
    permissions: LOG_CHANNEL_PERMISSIONS,
    requires: [SETUP_RESOURCE_KEYS.logsCategory],
    provisionable: PROVISION_LOG_CHANNEL,
  },
  {
    // The Muted role is a ROLE resource, so `rolePermissions` (not `permissions`)
    // carries its base permissions. Both channel helpers deliberately refuse a role,
    // and `setupPermissionsFromOptions` throws on one, which is what keeps a role
    // from ever reaching the channel overwrite path.
    key: SETUP_RESOURCE_KEYS.mutedRole,
    type: "ROLE",
    name: MUTE_ROLE_NAME,
    label: "🔇 @Muted",
    rolePermissions: MUTE_ROLE_DENIES,
    reason: "Members muted through the bot cannot send messages.",
  },
];

/** @returns the definitions that V2 actually provisions in a guild. */
export function provisionableResources(
  resources: readonly SetupResourceDefinition[] = SETUP_RESOURCES,
): readonly SetupResourceDefinition[] {
  return resources.filter((resource) => resource.provisionable !== false);
}

/** @returns the definition registered under `key`, if any. */
export function findSetupResource(
  key: string,
  resources: readonly SetupResourceDefinition[] = SETUP_RESOURCES,
): SetupResourceDefinition | undefined {
  return resources.find((resource) => resource.key === key);
}

/** @returns every definition of the given type. */
export function setupResourcesOfType(
  type: SetupResourceType,
  resources: readonly SetupResourceDefinition[] = SETUP_RESOURCES,
): readonly SetupResourceDefinition[] {
  return resources.filter((resource) => resource.type === type);
}

/**
 * Validates the registry itself.
 *
 * A duplicated key would collide with the database's `(guildId, key)` unique
 * constraint, and a `requires` pointing at an unknown key would create a resource
 * whose parent can never resolve. Both are programming errors, so they are
 * detected here instead of mid-setup on a production guild.
 *
 * The parent rule distinguishes channels from roles: a channel must name the category
 * it lives in, while a `ROLE` is a guild-level resource that has no parent and must
 * *not* declare one.
 */
export function validateSetupResources(
  resources: readonly SetupResourceDefinition[] = SETUP_RESOURCES,
): readonly string[] {
  const problems: string[] = [];
  const keys = new Set<string>();

  for (const resource of resources) {
    if (keys.has(resource.key)) {
      problems.push(`duplicate resource key: ${resource.key}`);
    }
    keys.add(resource.key);

    if (resource.type === "ROLE" && resource.category !== undefined) {
      problems.push(`role "${resource.key}" cannot declare a parent category`);
    }
    if (resource.type === "CATEGORY" && resource.category !== undefined) {
      problems.push(`category "${resource.key}" cannot declare a parent category`);
    }
    if (resource.type !== "CATEGORY" && resource.type !== "ROLE" && resource.category === undefined) {
      problems.push(`resource "${resource.key}" must declare the category it belongs to`);
    }
  }

  for (const resource of resources) {
    for (const required of resource.requires ?? []) {
      if (!keys.has(required)) {
        problems.push(`resource "${resource.key}" requires unknown resource "${required}"`);
      }
    }
  }

  return problems;
}

/**
 * Maps a section name (`INFORMATION`) to its category resource key and back.
 *
 * Keeps `SETUP_RESOURCES` the single source of truth: the module needs the key of
 * a category to resolve a parent ID, and the command needs the category of a
 * section to render grouped output.
 */
export const SETUP_SECTION_KEYS = {
  /** @returns the resource key of the category for a channel's parent name. */
  categoryKeyFor(categoryName: string | undefined): string | null {
    if (!categoryName) {
      return null;
    }
    const match = SETUP_RESOURCES.find(
      (resource) => resource.type === "CATEGORY" && resource.name === categoryName,
    );
    return match?.key ?? null;
  },
  /** @returns the resource key of a section's category, by section id. */
  keyForSection(section: "information" | "logs"): string {
    return section === "logs"
      ? SETUP_RESOURCE_KEYS.logsCategory
      : SETUP_RESOURCE_KEYS.informationCategory;
  },
} as const;

/** Snapshot of the registry problems; empty when the registry is valid. */
export const SETUP_RESOURCE_PROBLEMS: readonly string[] = validateSetupResources();
