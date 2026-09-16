/**
 * Centralized interaction handler.
 *
 * Responsibilities:
 * 1. detect the interaction type;
 * 2. locate the appropriate handler (command, component, modal, autocomplete);
 * 3. execute it;
 * 4. catch errors;
 * 5. send a safe user-facing response;
 * 6. log the internal error.
 *
 * Only slash commands and autocomplete are implemented for V1. Buttons, select
 * menus and modals are routed to clearly marked extension points so future
 * components do not require changes to the dispatch logic.
 */
import {
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  RESTJSONErrorCodes,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { BotClient } from "../client/client.types.js";
import type { AppConfig } from "../config/config.js";
import type { Logger } from "../services/logger/index.js";
import type { ConfigService } from "../services/config/index.js";
import type { DatabaseService } from "../services/database/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { SetupService } from "../modules/setup.service.js";
import type { CommandRegistry } from "../commands/index.js";
import type { CommandExecutionContext } from "../commands/context.js";
import { COPY } from "../config/constants.js";
import { isAppError, toError, userFacingMessage } from "../utils/errors.js";
import { errorEmbed } from "../utils/presenters.js";

export interface InteractionHandlerDeps {
  readonly client: BotClient;
  /** Validated application configuration. */
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  readonly commands: CommandRegistry;
  readonly permissions: PermissionService;
  /** Guild configuration service (per-guild config access). */
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly setup: SetupService;
  readonly startedAt: number;
}

export class InteractionHandler {
  private readonly deps: InteractionHandlerDeps;
  private readonly logger: Logger;

  public constructor(deps: InteractionHandlerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child("interactions");
  }

  /** Dispatches an interaction to the correct handler, never throwing. */
  public async handle(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleChatInput(interaction);
        return;
      }
      if (interaction.isAutocomplete()) {
        await this.handleAutocomplete(interaction);
        return;
      }
      // Extension points: implemented in later phases.
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await this.handleComponent(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        await this.handleModal(interaction);
        return;
      }
      this.logger.debug("Unhandled interaction type", { type: interaction.type });
    } catch (error) {
      await this.replyWithError(interaction, error);
    }
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = this.deps.commands.get(interaction.commandName);
    if (!command || command.kind !== "slash") {
      this.logger.warn("Received unknown slash command", { command: interaction.commandName });
      await this.safeReply(interaction, "This command is no longer available. Try `/help`.");
      return;
    }

    const logScope = this.logger.withContext({
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });

    if (command.guildOnly && !interaction.inGuild()) {
      await this.safeReply(interaction, COPY.guildOnlyMessage);
      return;
    }

    if (interaction.inGuild() && interaction.member) {
      const member = interaction.member;
      if (!(member instanceof GuildMember)) {
        this.logger.warn("Interaction member could not be resolved from cache", {
          guildId: interaction.guildId,
        });
      } else {
        const check = this.deps.permissions.check(member, command.permissions);
        if (!check.allowed) {
          logScope.warn("Permission denied", { command: command.name, missing: check.missing });
          await this.safeReply(interaction, check.reason ?? COPY.permissionDeniedMessage, true);
          return;
        }

        const botCheck = this.deps.permissions.checkBotPermissions(
          interaction,
          command.permissions,
        );
        if (!botCheck.allowed) {
          logScope.error("Bot lacks required permissions", undefined, {
            command: command.name,
            missing: botCheck.missing,
          });
          await this.safeReply(
            interaction,
            "I am missing permissions required to run this command.",
          );
          return;
        }
      }
    }

    const startedAt = performance.now();
    try {
      await command.execute(interaction, await this.buildContext(interaction));
      logScope.debug("Command executed", {
        command: command.name,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logScope.error(`Command "/${command.name}" failed`, error, {
        command: command.name,
        userId: interaction.user.id,
      });
      await this.replyWithError(interaction, error);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const command = this.deps.commands.get(interaction.commandName);
    if (!command || command.kind !== "slash" || !command.autocomplete) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    try {
      await command.autocomplete(interaction);
    } catch (error) {
      this.logger.error("Autocomplete failed", error, { command: command.name });
      await interaction.respond([]).catch(() => undefined);
    }
  }

  /** Extension point for buttons and select menus (implemented in a later phase). */
  private handleComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    this.logger.debug("Component interaction received with no registered handler", {
      customId: interaction.customId,
    });
    return Promise.resolve();
  }

  /** Extension point for modals (implemented in a later phase). */
  private handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    this.logger.debug("Modal submission received with no registered handler", {
      customId: interaction.customId,
    });
    return Promise.resolve();
  }

  private async buildContext(
    interaction: ChatInputCommandInteraction,
  ): Promise<CommandExecutionContext> {
    const guildConfig = interaction.guild
      ? await this.deps.config.get(interaction.guild.id, interaction.guild.name)
      : null;

    return {
      client: this.deps.client,
      commands: this.deps.commands,
      appConfig: this.deps.appConfig,
      logger: this.logger.withContext({
        guildId: interaction.guildId ?? undefined,
        userId: interaction.user.id,
        channelId: interaction.channelId,
      }),
      config: this.deps.config,
      database: this.deps.database,
      permissions: this.deps.permissions,
      setup: this.deps.setup,
      guildConfig,
      uptimeMs: Date.now() - this.deps.startedAt,
    };
  }

  /** Sends a user-facing error, translating technical failures safely. */
  private async replyWithError(interaction: Interaction, error: unknown): Promise<void> {
    const expected = isAppError(error) && error.expected;
    const message = this.safeMessageFor(error);

    if (!expected) {
      this.logger.error("Unhandled interaction error", error, {
        interactionId: interaction.id,
        type: interaction.type,
      });
    }

    if (interaction.isRepliable()) {
      await this.safeReply(interaction, message, expected);
    }
  }

  /** Maps an error to a message that is safe to show to a Discord user. */
  private safeMessageFor(error: unknown): string {
    const expected = userFacingMessage(error);
    if (expected) {
      return expected;
    }
    if (error instanceof DiscordAPIError) {
      return error.code === RESTJSONErrorCodes.RequestEntityTooLarge
        ? "That response was too large to send."
        : "Discord rejected the request. Please try again in a moment.";
    }
    return COPY.genericErrorMessage;
  }

  /** Replies without ever throwing (the interaction may already be answered). */
  private async safeReply(
    interaction: Interaction,
    message: string,
    expected = false,
  ): Promise<void> {
    if (!interaction.isRepliable()) {
      return;
    }

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [errorEmbed(COPY.genericErrorTitle, message)] });
      } else {
        await interaction.reply({
          embeds: [
            errorEmbed(
              // Expected (user) errors get a permission-style heading; internal
              // failures always get the generic heading.
              expected ? COPY.permissionDeniedTitle : COPY.genericErrorTitle,
              message,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (error) {
      this.logger.warn("Failed to deliver an error response to the user", {
        interactionId: interaction.id,
        reason: toError(error).message,
      });
    }
  }
}
