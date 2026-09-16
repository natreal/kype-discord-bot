/**
 * Command contracts.
 *
 * A command is a thin interface: it declares metadata (used for registration and
 * `/help`) and an `execute` that delegates to a module or service. Business logic
 * never lives in a command file.
 *
 * Supports slash commands, user context menus and message context menus through
 * the same `defineCommand` helper.
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  MessageContextMenuCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  UserContextMenuCommandInteraction,
} from "discord.js";

import type { CommandCategory } from "../config/constants.js";
import type { BotPermission } from "../services/permissions/index.js";
import type { PermissionRequirement } from "../services/permissions/index.js";
import type { CommandExecutionContext } from "./context.js";

/** Anything discord.js accepts as slash-command data. */
export type SlashCommandData =
  SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

/** Anything discord.js accepts as context-menu data. */
export type ContextMenuData = ContextMenuCommandBuilder;

/** Interaction types a command can handle. */
export type CommandInteraction =
  | ChatInputCommandInteraction
  | UserContextMenuCommandInteraction
  | MessageContextMenuCommandInteraction;

/** Metadata every command must declare. */
export interface CommandMeta {
  /** Command name as registered with Discord (lowercase, no spaces). */
  readonly name: string;
  /** Short description shown by `/help` and the Discord command picker. */
  readonly description: string;
  /** Category folder the command lives in; used for grouping and permissions. */
  readonly category: CommandCategory;
  /** Optional usage hint shown by `/help`, e.g. "/ban <user> [reason]". */
  readonly usage?: string | undefined;
  /** Optional examples shown by `/help`. */
  readonly examples?: readonly string[] | undefined;
}

/** Fields shared by every registered command. */
export interface CommandBase extends CommandMeta {
  /** Original metadata block from the definition file. */
  readonly meta: CommandMeta;
  /** Authorization requirement evaluated by the interaction handler. */
  readonly permissions: PermissionRequirement;
  /** Guild-only commands receive a guaranteed non-null guild context. */
  readonly guildOnly: boolean;
}

/** A slash command. */
export interface SlashCommand extends CommandBase {
  readonly kind: "slash";
  readonly data: SlashCommandData;
  execute(
    interaction: ChatInputCommandInteraction,
    context: CommandExecutionContext,
  ): Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

/** A user or message context-menu command. */
export interface ContextMenuCommand extends CommandBase {
  readonly kind: "context-menu";
  readonly data: ContextMenuData;
  execute(interaction: CommandInteraction, context: CommandExecutionContext): Promise<void>;
}

/** Union of every command shape supported by the loader. */
export type Command = SlashCommand | ContextMenuCommand;

/**
 * A slash command definition file.
 *
 * `meta` is the source of truth for name/description/category; the loader copies
 * it onto the flat fields it exposes, so both shapes stay in sync automatically.
 */
export interface SlashCommandDefinition extends CommonCommandDefinition {
  readonly data: SlashCommandData;
  readonly execute: SlashCommand["execute"];
  readonly autocomplete?: SlashCommand["autocomplete"];
}

/** A context-menu command definition file. */
export interface ContextMenuCommandDefinition extends CommonCommandDefinition {
  readonly data: ContextMenuData;
  readonly execute: ContextMenuCommand["execute"];
}

/** Options shared by every command definition file. */
export interface CommonCommandDefinition {
  /** Metadata used for registration, `/help` and permission grouping. */
  readonly meta: CommandMeta;
  /** Explicit Discord/bot permission requirement (overrides botPermissions). */
  readonly permissions?: PermissionRequirement;
  /** Guild-only commands are the default; set false for DM-capable commands. */
  readonly guildOnly?: boolean;
  /** Named bot permissions, mapped onto Discord permissions. */
  readonly botPermissions?: readonly BotPermission[];
}

/** Keys that are valid inside a command definition file. */
export interface CommandDefinition {
  readonly meta: CommandMeta;
  readonly permissions?: PermissionRequirement;
  readonly guildOnly?: boolean;
  /** Named bot permissions; resolved to Discord permissions when omitted. */
  readonly botPermissions?: readonly BotPermission[];
}
