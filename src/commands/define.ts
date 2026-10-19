/**
 * Helpers used by command definition files.
 *
 * `defineSlashCommand` and `defineContextMenuCommand` provide full type
 * inference and apply defaults (guild-only by default, permissions derived from
 * the bot permission catalog) without hiding anything a command may need.
 *
 * Defining a command file looks like this:
 *
 * ```ts
 * export default defineSlashCommand({
 *   meta: { name: "ping", description: "…", category: "core" },
 *   data: new SlashCommandBuilder().setName("ping").setDescription("…"),
 *   botPermissions: ["core.use"],
 *   execute: async (interaction, context) => { … },
 * });
 * ```
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
} from "discord.js";

import { botPermissionsForDiscord } from "../services/permissions/index.js";
import type { BotPermission, PermissionRequirement } from "../services/permissions/index.js";
import type {
  CommonCommandDefinition,
  ContextMenuCommand,
  ContextMenuCommandDefinition,
  SlashCommand,
  SlashCommandDefinition,
} from "./command.types.js";

/**
 * Derives the authorization requirement.
 *
 * Explicit `permissions` always win. Otherwise named bot permissions are mapped
 * onto Discord permissions so the check is enforced today while remaining
 * extensible to custom role overrides later.
 */
export function buildRequirement(definition: CommonCommandDefinition): PermissionRequirement {
  const { permissions, botPermissions } = definition;
  if (permissions) {
    return permissions;
  }
  if (botPermissions && botPermissions.length > 0) {
    return { discord: botPermissionsForDiscord(botPermissions), botPermissions };
  }
  return {};
}

/** Defines a slash command with inferred types. */
export function defineSlashCommand(definition: SlashCommandDefinition): SlashCommand {
  const { meta } = definition;
  const command: SlashCommand = {
    kind: "slash",
    meta,
    name: meta.name,
    description: meta.description,
    category: meta.category,
    data: definition.data,
    execute: definition.execute,
    permissions: buildRequirement(definition),
    guildOnly: definition.guildOnly ?? true,
    // Commands are deployed unless a module says otherwise: a new command must
    // reach servers by default, and opting out has to be a deliberate act.
    deploy: definition.deploy ?? true,
  };

  return definition.autocomplete === undefined
    ? command
    : { ...command, autocomplete: definition.autocomplete };
}

/** Defines a context-menu command (user or message) with inferred types. */
export function defineContextMenuCommand(
  definition: ContextMenuCommandDefinition,
): ContextMenuCommand {
  const { meta } = definition;
  return {
    kind: "context-menu",
    meta,
    name: meta.name,
    description: meta.description,
    category: meta.category,
    data: definition.data,
    execute: definition.execute,
    permissions: buildRequirement(definition),
    guildOnly: definition.guildOnly ?? true,
    deploy: definition.deploy ?? true,
  };
}

export type { AutocompleteInteraction, ChatInputCommandInteraction, ContextMenuCommandBuilder };
export type { BotPermission };
