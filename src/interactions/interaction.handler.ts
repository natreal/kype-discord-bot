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
  EmbedBuilder,
  GuildMember,
  MessageFlags,
  RESTJSONErrorCodes,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
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
import type { PermissionRequirement } from "../services/permissions/index.js";
import {
  MAINTENANCE_TITLE,
  maintenanceMessage,
  type MaintenanceService,
  type MaintenanceStatus,
} from "../services/maintenance/index.js";
import type {
  AuthorizationDecision,
  AuthorizationService,
  PermissionClassStore,
  PermissionRequest,
} from "../services/authorization/index.js";
import type { AuditEventService } from "../services/audit/index.js";
import type { DiagnosticRegistry } from "../diagnostics/index.js";
import type { SetupService } from "../modules/setup.service.js";
import type { SetupResourceDefinition } from "../modules/setup.types.js";
import type { CommandRegistry } from "../commands/index.js";
import type { BackupService } from "../modules/backup/index.js";
import type { CommandDeploymentService } from "../services/deployment/index.js";
import type { AiGateway } from "../services/ai/ai.gateway.js";
import type { AiSettingsService } from "../services/ai/ai-settings.service.js";
import type { AiMemoryService } from "../modules/ai/ai-memory.service.js";
import type { ProcessControlService } from "../services/process/index.js";
import type { GuildLeaveService } from "../services/guild/index.js";
import type {
  AutomodContextServices,
  CommandExecutionContext,
  ModerationContextServices,
  SecurityContextServices,
  SetupContextServices,
  TicketContextServices,
} from "../commands/context.js";
import { COPY } from "../config/constants.js";
import { isAppError, NotFoundError, toError, userFacingMessage } from "../utils/errors.js";
import { errorEmbed } from "../utils/presenters.js";
import { TICKET_IDS } from "../modules/tickets/index.js";
import type { TicketService } from "../modules/tickets/ticket.service.js";
import type { ReminderService } from "../modules/reminders/index.js";
import type { RepositoryMonitorService } from "../modules/repository/index.js";
import {
  buildGithubView,
  isGithubComponent,
  parsePanelCustomId,
  renderView,
} from "../modules/repository/index.js";

/**
 * Snapshots read per `/github` render, matching the command's own window.
 *
 * The storage window, not a display limit: each panel trims what it draws, and the
 * trend and decomposition want as much history as the monitor keeps.
 */
const GITHUB_HISTORY_ROWS = 72;

/**
 * Interactions that carry a guild member and can therefore be gated.
 *
 * `AutocompleteInteraction` is included because it also exposes `member`, but it
 * is answered with an empty list rather than an embed — see `handleAutocomplete`.
 */
type GuildInteractionWithMember =
  | ChatInputCommandInteraction
  | AutocompleteInteraction
  | ButtonInteraction
  | StringSelectMenuInteraction;

/** @returns true when a component id belongs to the ticket panel namespace. */
function isTicketComponent(customId: string): boolean {
  return Object.values(TICKET_IDS).some((prefix) => customId.startsWith(prefix));
}

/**
 * What a ticket clicker may handle.
 *
 * `allCategories` covers `tickets.view` holders, the configured staff role, guild owners
 * and Administrators. `categoryIds` covers helpers named by one category's
 * `staffRoleIds`, who must not see or act on another category's tickets.
 */
interface TicketStaffScope {
  readonly allCategories: boolean;
  readonly categoryIds: readonly string[];
}

export interface InteractionHandlerDeps {
  readonly client: BotClient;
  /** Validated application configuration. */
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  readonly commands: CommandRegistry;
  readonly permissions: PermissionService;
  /**
   * Central authorization layer.
   *
   * When supplied, command authorization goes through it so the decision is
   * structured, testable and God-Access-aware in exactly one place.
   */
  readonly authorization?: AuthorizationService;
  /**
   * Guild-scoped maintenance mode.
   *
   * Optional so a minimal harness compiles; the bootstrap always supplies it. When
   * it is absent the gate is inert, because this process holds no pause state to
   * honour.
   */
  readonly maintenance?: MaintenanceService;
  /**
   * Role → permission-class store.
   *
   * Required for `/roles`: it is the only surface that binds a Discord role to a power
   * level. Optional so a minimal harness compiles, but the command refuses cleanly when
   * it is absent rather than reaching for a singleton.
   */
  readonly permissionClasses?: PermissionClassStore;
  readonly diagnostics?: DiagnosticRegistry | null;
  /** Guild configuration service (per-guild config access). */
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly setup: SetupService;
  /** Resource registry owned by the automatic setup system. */
  readonly setupResources: readonly SetupResourceDefinition[];
  /**
   * Builds the guild-bound setup collaborators for a command context.
   *
   * Supplied by the bootstrap so the handler stays free of construction logic and
   * every caller (commands, tests) gets the same wiring.
   */
  readonly createSetupContext: (guild: Guild, logger: Logger) => SetupContextServices;
  /** Builds the guild-bound moderation collaborators for a command context. */
  readonly createModerationContext: (guild: Guild, logger: Logger) => ModerationContextServices;
  /** Builds the guild-bound security collaborators (anti-raid, anti-nuke). */
  readonly createSecurityContext: (guild: Guild, logger: Logger) => SecurityContextServices;
  /** Builds the guild-bound automod collaborators. */
  readonly createAutomodContext: (guild: Guild, logger: Logger) => AutomodContextServices;
  /** Builds the guild-bound ticket collaborators. */
  readonly createTicketContext: (guild: Guild, logger: Logger) => TicketContextServices;
  /**
   * Builds the guild-bound reminder service for `/reminder`.
   *
   * Optional: a harness that never runs `/reminder` need not wire it, and the command
   * then reports "unavailable" instead of throwing at construction.
   */
  readonly remindersForGuild?: (guild: Guild, logger: Logger) => ReminderService | null;
  /**
   * The process-wide repository monitor, for `/github`.
   *
   * Optional for the same reason as the reminder service: a harness that never runs
   * the command need not wire it, and the command then says so instead of throwing
   * at construction.
   */
  readonly repositoryMonitor?: RepositoryMonitorService | null;
  /** Builds the guild-bound backup service. */
  readonly createBackupService: (guild: Guild, logger: Logger) => BackupService;
  /**
   * Slash-command deployment.
   *
   * Optional so a harness can construct the handler without one; a command that
   * needs it (`/admin deploy`) treats its absence as "deployment is not wired up
   * here" rather than reaching for a singleton.
   */
  readonly deployment?: CommandDeploymentService;
  /** Structured audit trail, exposed to commands that record privileged actions. */
  readonly audit: AuditEventService;
  readonly startedAt: number;
  /** Process-wide AI gateway; optional so a minimal harness compiles. */
  readonly ai?: AiGateway;
  /** Global provider settings; optional so a minimal harness compiles. */
  readonly aiSettings?: AiSettingsService;
  /** Guild-scoped AI memory service; optional so a minimal harness compiles. */
  readonly aiMemory?: AiMemoryService;
  /** Process control for `/stop` and `/restart`; optional so a minimal harness compiles. */
  readonly process?: ProcessControlService;
  /** Guild leaving for `/leave`; optional so a minimal harness compiles. */
  readonly guildLeave?: GuildLeaveService;
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

    // Maintenance is checked before authorization: a paused server answers
    // "maintenance", never "you are missing a permission", and a gate placed after
    // dispatch would let a command perform half its work before refusing.
    const refusal = await this.maintenanceRefusal(interaction);
    if (refusal !== null) {
      logScope.warn("Command refused during maintenance", {
        command: command.name,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      await this.replyWithMaintenance(interaction, refusal);
      return;
    }

    if (interaction.inGuild() && interaction.member) {
      const member = interaction.member;
      if (!(member instanceof GuildMember)) {
        this.logger.warn("Interaction member could not be resolved from cache", {
          guildId: interaction.guildId,
        });
      } else {
        const decision = await this.decideFor(member, command.permissions, command.name);

        if (!decision.allowed) {
          logScope.warn("Permission denied", { command: command.name, missing: decision.missing });
          await this.safeReply(interaction, decision.reason ?? COPY.permissionDeniedMessage, true);
          return;
        }

        // God Access holders bypass every check by design; the bypass is logged
        // (and audited by the authorization service) because it is a
        // privileged event, not routine traffic.
        if (decision.godAccess) {
          logScope.warn("Command authorized by God Access", {
            command: command.name,
            userId: member.id,
            guildId: interaction.guildId,
            outcome: decision.outcome,
          });
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

  /**
   * @returns the maintenance status when this interaction must be refused, or
   * `null` when it may proceed.
   *
   * Only members that keep the bot operable are exempt (God Access, owner,
   * Administrator, `server.settings`); everyone else is paused, staff included.
   */
  private async maintenanceRefusal(
    interaction: GuildInteractionWithMember,
  ): Promise<MaintenanceStatus | null> {
    const maintenance = this.deps.maintenance;
    const guildId = interaction.guildId;
    if (!maintenance || !guildId) {
      return null;
    }

    // An unresolvable member is passed as `null`, which the service treats as *not*
    // exempt: "I cannot tell who this is" must never mean "let them in".
    const member = interaction.member instanceof GuildMember ? interaction.member : null;
    const gate = await maintenance.inspect(guildId, member);
    return gate.status.active && !gate.exempt ? gate.status : null;
  }

  /** Explains a pause to the user, without ever throwing. */
  private async replyWithMaintenance(
    interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
    status: MaintenanceStatus,
  ): Promise<void> {
    const embed = errorEmbed(MAINTENANCE_TITLE, maintenanceMessage(status));
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      this.logger.warn("Failed to deliver the maintenance notice", {
        interactionId: interaction.id,
        reason: toError(error).message,
      });
    }
  }

  /**
   * Authorizes a command invocation.
   *
   * Uses the central authorization service when it is available, so the decision
   * (and the God Access bypass) has one implementation. The legacy
   * `PermissionService` path is retained for harnesses that construct the handler
   * without one.
   */
  private decideFor(
    member: GuildMember,
    requirement: PermissionRequirement,
    commandName: string,
  ): Promise<AuthorizationDecision> {
    const authorization = this.deps.authorization;
    if (authorization) {
      return authorization.authorize(member, toRequest(requirement), commandName);
    }

    const check = this.deps.permissions.check(member, requirement);
    return Promise.resolve({
      outcome: check.allowed ? "ALLOW" : "DENY_DISCORD_PERMISSION",
      allowed: check.allowed,
      missing: check.missing,
      deniedBy: check.allowed ? null : "discord",
      godAccess: this.deps.permissions.isGodAccess(member),
      ...(check.reason === undefined ? {} : { reason: check.reason }),
    });
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    // Autocomplete is answered with an empty list rather than an embed: the client
    // expects `respond()`, and offering choices that the command will refuse would
    // be a worse experience than offering none.
    if ((await this.maintenanceRefusal(interaction)) !== null) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    const command = this.deps.commands.get(interaction.commandName);
    if (!command || command.kind !== "slash" || !command.autocomplete) {
      await interaction.respond([]).catch(() => undefined);
      return;
    }

    try {
      await command.autocomplete(interaction, await this.buildContext(interaction));
    } catch (error) {
      this.logger.error("Autocomplete failed", error, { command: command.name });
      await interaction.respond([]).catch(() => undefined);
    }
  }

  /**
   * Routes a button or select-menu interaction.
   *
   * Custom IDs are namespaced: `ticket:<action>[:<argument>]` (see `TICKET_IDS`) for
   * the ticket panel, and `github:<kind>:...` for the `/github` panels. Each family
   * matches its prefix and hands off to its own handler; anything else is ignored,
   * because a reply to an id nobody owns would be noise.
   */
  private async handleComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    const customId = interaction.customId;

    // Ticket panels are user-facing actions: pause them with the rest of the bot.
    // Unknown components stay ignored (a reply to an id nobody owns would be noise).
    if (isTicketComponent(customId)) {
      const refusal = await this.maintenanceRefusal(interaction);
      if (refusal !== null) {
        await this.replyWithMaintenance(interaction, refusal);
        return;
      }
    }

    if (customId.startsWith(TICKET_IDS.open)) {
      const key = customId.slice(TICKET_IDS.open.length);
      await this.handleTicketOpen(interaction as ButtonInteraction, key);
      return;
    }
    if (customId.startsWith(TICKET_IDS.claim)) {
      const id = customId.slice(TICKET_IDS.claim.length);
      await this.handleTicketClaim(interaction as ButtonInteraction, id);
      return;
    }
    if (customId.startsWith(TICKET_IDS.close)) {
      const id = customId.slice(TICKET_IDS.close.length);
      await this.handleTicketClose(interaction as ButtonInteraction, id);
      return;
    }
    if (customId.startsWith(TICKET_IDS.transcript)) {
      const id = customId.slice(TICKET_IDS.transcript.length);
      await this.handleTicketTranscript(interaction as ButtonInteraction, id);
      return;
    }
    if (customId.startsWith(TICKET_IDS.delete)) {
      const id = customId.slice(TICKET_IDS.delete.length);
      await this.handleTicketDelete(interaction as ButtonInteraction, id);
      return;
    }
    if (isGithubComponent(customId)) {
      await this.handleGithubPanel(interaction);
      return;
    }

    this.logger.debug("Component interaction received with no registered handler", { customId });
  }

  /**
   * `github:panel:<panel>:<style>:<width>` and `github:select` — redraw a `/github`
   * message on the panel that was clicked.
   *
   * The reply is edited in place rather than answered ephemerally: the panels are
   * public project statistics, and a channel that accrues one reply per click would
   * bury the conversation. The custom ID is the whole state — panel, chart style and
   * width — so no session has to be tracked, and an old message keeps working after
   * a restart.
   */
  private async handleGithubPanel(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    // A button names its panel in its own custom ID; the selector carries the panel
    // in the chosen option's value, so both routes are parsed the same way.
    const targetId = interaction.isStringSelectMenu()
      ? (interaction.values[0] ?? "")
      : interaction.customId;
    const request = parsePanelCustomId(targetId);

    const monitor = this.deps.repositoryMonitor;
    if (!monitor) {
      await this.safeReply(interaction, "The repository monitor is not running in this process.");
      return;
    }
    if (request === null) {
      // A stale message from an older build: answering "out of date" is honest, and
      // silently ignoring the click would look like a broken button.
      await this.safeReply(interaction, "This panel is out of date. Run `/github` again.");
      return;
    }

    await interaction.deferUpdate();
    try {
      const history = await monitor.history(GITHUB_HISTORY_ROWS);
      const payload = renderView(
        buildGithubView({
          fullName: monitor.fullName,
          repoUrl: `https://github.com/${monitor.fullName}`,
          history,
          latest: history.at(-1) ?? null,
          panel: request.panel,
          style: request.style,
          width: request.width,
          ownerId: interaction.user.id,
        }),
      );
      await interaction.editReply({
        components: payload.components,
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      this.logger.error("Failed to render a /github panel", error, {
        customId: interaction.customId,
      });
      await this.safeReply(interaction, "That panel could not be loaded. Try `/github` again.");
    }
  }

  /** Resolves the ticket service for a button, or replies "unavailable" and returns `null`. */
  private ticketServiceFor(
    interaction: ButtonInteraction,
  ): { service: TicketService; guildId: string } | null {
    if (!interaction.guild) {
      void this.safeReply(interaction, "Tickets are only available inside a server.");
      return null;
    }
    const guildId = interaction.guild.id;
    const service = this.deps.createTicketContext(interaction.guild, this.logger).service;
    return { service, guildId };
  }

  /**
   * Resolves what a ticket button clicker may handle.
   *
   * The authorization layer answers first (God Access, owner, Administrator and the
   * permission classes); the service's role list then covers the configured staff role
   * and the per-category staff roles, which are the same roles that can see the ticket
   * channel.
   */
  private async ticketStaffScopeFor(
    interaction: ButtonInteraction,
    service: TicketService,
    guildId: string,
  ): Promise<TicketStaffScope> {
    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      return { allCategories: false, categoryIds: [] };
    }

    const authorization = this.deps.authorization;
    const decision = authorization
      ? await authorization.decide(member, { custom: ["tickets.view"] }, "ticket access")
      : await this.decideFor(member, { custom: ["tickets.view"] }, "ticket access");
    if (decision.allowed) {
      return { allCategories: true, categoryIds: [] };
    }

    const roleIds = [...member.roles.cache.keys()];
    if (await service.isTicketStaff(guildId, roleIds)) {
      return { allCategories: true, categoryIds: [] };
    }
    return {
      allCategories: false,
      categoryIds: await service.staffCategoryIds(guildId, roleIds),
    };
  }

  /** @returns true when the clicker handles the ticket's category. */
  private async canHandleTicketCategory(
    interaction: ButtonInteraction,
    service: TicketService,
    guildId: string,
    categoryId: string,
  ): Promise<boolean> {
    const scope = await this.ticketStaffScopeFor(interaction, service, guildId);
    return scope.allCategories || scope.categoryIds.includes(categoryId);
  }

  /** `ticket:open:<categoryKey>` — create the channel and point the member at it. */
  private async handleTicketOpen(
    interaction: ButtonInteraction,
    categoryKey: string,
  ): Promise<void> {
    const resolved = this.ticketServiceFor(interaction);
    if (!resolved) {
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const member = interaction.member;
    const openerName =
      member && "displayName" in member
        ? (member.displayName ?? interaction.user.username)
        : interaction.user.username;

    const outcome = await resolved.service.open(resolved.guildId, {
      categoryKey,
      openerId: interaction.user.id,
      openerName,
      subject: null,
    });

    if (!outcome.ok || !outcome.ticket) {
      const embed = errorEmbed("Ticket not opened", outcome.detail);
      if (outcome.ticket) {
        embed.addFields({ name: "Existing", value: `<#${outcome.ticket.channelId}>` });
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const ticket = outcome.ticket;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Ticket #${ticket.number} opened`)
          .setDescription(
            `Your ticket is private: only you and the staff team can see <#${ticket.channelId}>.`,
          ),
      ],
    });
  }

  /** `ticket:claim:<ticketId>` — assign the ticket to the clicker. */
  private async handleTicketClaim(interaction: ButtonInteraction, ticketId: string): Promise<void> {
    const resolved = this.ticketServiceFor(interaction);
    if (!resolved) {
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ticket = await resolved.service.find(resolved.guildId, ticketId);
    if (!ticket) {
      await interaction.editReply({
        embeds: [errorEmbed("Ticket", "That ticket no longer exists.")],
      });
      return;
    }
    if (
      !(await this.canHandleTicketCategory(
        interaction,
        resolved.service,
        resolved.guildId,
        ticket.categoryId,
      ))
    ) {
      await interaction.editReply({
        embeds: [errorEmbed("Ticket", "Only the support team can claim tickets.")],
      });
      return;
    }

    const outcome = await resolved.service.claim(resolved.guildId, ticketId, interaction.user.id);
    if (!outcome.ok) {
      await interaction.editReply({ embeds: [errorEmbed("Ticket", outcome.detail)] });
      return;
    }
    await interaction.editReply({ content: "You are now handling this ticket." });
  }

  /** `ticket:close:<ticketId>` — store the transcript, then lock the channel. */
  private async handleTicketClose(interaction: ButtonInteraction, ticketId: string): Promise<void> {
    const resolved = this.ticketServiceFor(interaction);
    if (!resolved) {
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ticket = await resolved.service.find(resolved.guildId, ticketId);
    if (!ticket) {
      await interaction.editReply({
        embeds: [errorEmbed("Ticket", "That ticket no longer exists.")],
      });
      return;
    }

    // Closing ends the conversation and locks the channel, so it follows the same
    // staff boundary as Claim and Transcript. Being the opener is not a staff role:
    // otherwise a member can open a ticket and immediately close it, freeing their
    // member-limit slot and turning the panel into a create/close loop.
    if (
      !(await this.canHandleTicketCategory(
        interaction,
        resolved.service,
        resolved.guildId,
        ticket.categoryId,
      ))
    ) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            "Ticket",
            "Only the support team can close this ticket. Ask a staff member to close it for you.",
          ),
        ],
      });
      return;
    }

    const outcome = await resolved.service.close(
      resolved.guildId,
      ticketId,
      interaction.user.id,
      "Closed from the ticket panel",
    );
    if (!outcome.ok) {
      await interaction.editReply({ embeds: [errorEmbed("Ticket", outcome.detail)] });
      return;
    }
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Ticket closed")
          .setDescription(outcome.detail)
          .addFields({
            name: "Transcript",
            value: outcome.transcriptSaved ? "stored" : "could not be stored — see the logs",
          }),
      ],
    });
  }

  /** `ticket:transcript:<ticketId>` — deliver the stored transcript as a file. */
  private async handleTicketTranscript(
    interaction: ButtonInteraction,
    ticketId: string,
  ): Promise<void> {
    const resolved = this.ticketServiceFor(interaction);
    if (!resolved) {
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ticket = await resolved.service.find(resolved.guildId, ticketId);
    if (!ticket) {
      await interaction.editReply({
        embeds: [errorEmbed("Ticket", "That ticket no longer exists.")],
      });
      return;
    }
    if (
      !(await this.canHandleTicketCategory(
        interaction,
        resolved.service,
        resolved.guildId,
        ticket.categoryId,
      ))
    ) {
      await interaction.editReply({
        embeds: [errorEmbed("Ticket", "Only the support team can read a ticket transcript.")],
      });
      return;
    }

    const transcript = await resolved.service.transcript(ticketId);
    if (!transcript) {
      await interaction.editReply({
        embeds: [errorEmbed("No transcript", "This ticket has no stored transcript yet.")],
      });
      return;
    }
    const extension = transcript.format === "html" ? "html" : "md";
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Ticket transcript")
          .setDescription(`Stored ${transcript.messageCount} messages.`),
      ],
      files: [
        {
          name: `ticket-transcript.${extension}`,
          attachment: Buffer.from(transcript.content, "utf8"),
        },
      ],
    });
  }

  /**
   * `ticket:delete:<ticketId>` — store the transcript, delete the channel, forget
   * the ticket.
   *
   * The only ticket control that needs its own check: claim, close and transcript
   * are offered to anyone who can already see the ticket channel, but deleting one
   * cannot be undone, so the clicker must hold `tickets.manage` (the same permission
   * the staff ticket actions use). A refusal names the missing permission instead of
   * failing silently, which is what makes the disabled-looking button defensible.
   */
  private async handleTicketDelete(
    interaction: ButtonInteraction,
    ticketId: string,
  ): Promise<void> {
    const resolved = this.ticketServiceFor(interaction);
    if (!resolved) {
      return;
    }

    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await this.safeReply(
        interaction,
        "I could not verify your permissions here, so I will not delete the ticket.",
        true,
      );
      return;
    }
    const decision = await this.decideFor(member, { custom: ["tickets.manage"] }, "ticket delete");
    if (!decision.allowed) {
      await this.safeReply(
        interaction,
        decision.reason ?? "Deleting a ticket needs the `tickets.manage` permission.",
        true,
      );
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const outcome = await resolved.service.remove(resolved.guildId, ticketId, interaction.user.id);
    if (!outcome.ok) {
      await interaction.editReply({ embeds: [errorEmbed("Ticket", outcome.detail)] });
      return;
    }
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("Ticket deleted").setDescription(outcome.detail)],
    });
  }

  /** Extension point for modals (implemented in a later phase). */
  private handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    this.logger.debug("Modal submission received with no registered handler", {
      customId: interaction.customId,
    });
    return Promise.resolve();
  }

  /**
   * @returns the permission-class store, or throws when the process was not wired
   * with one.
   *
   * `/roles` is the only consumer, and it must fail loudly rather than silently do
   * nothing: a harness that omits the store is a wiring bug, and a command that
   * "succeeds" without persisting a binding would be worse than an error.
   */
  private requirePermissionClasses(): PermissionClassStore {
    const store = this.deps.permissionClasses;
    if (!store) {
      throw new NotFoundError("Role management is not available in this process.");
    }
    return store;
  }

  private async buildContext(
    interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  ): Promise<CommandExecutionContext> {
    const guildConfig = interaction.guild
      ? await this.deps.config.get(interaction.guild.id, interaction.guild.name)
      : null;

    const logger = this.logger.withContext({
      guildId: interaction.guildId ?? undefined,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });

    // Guild-bound setup helpers are built per invocation: they capture the guild,
    // its identity table and its permission rules, and are never shared across
    // guilds or interactions.
    const setupContext = interaction.guild
      ? this.deps.createSetupContext(interaction.guild, logger)
      : null;

    // Moderation helpers follow the same rule: one construction path, per
    // invocation, bound to the guild the interaction came from. Guild-only
    // commands cannot reach a DM, so a DM context is a refusal rather than a
    // fabricated guild.
    if (!interaction.guild) {
      throw new NotFoundError("Moderation is not available outside a server.");
    }
    const moderation = this.deps.createModerationContext(interaction.guild, logger);
    // V5 modules follow the same rule. Security keeps its own guild-bound actions
    // port (lockdown, quarantine role) so a command cannot reach the guild object.
    const security = this.deps.createSecurityContext(interaction.guild, logger);
    const automod = this.deps.createAutomodContext(interaction.guild, logger);
    const backup = this.deps.createBackupService(interaction.guild, logger);
    const deployment = this.deps.deployment;
    if (!deployment) {
      // A command that needs deployment must fail loudly rather than silently do
      // nothing; the one place this is reachable is a harness that did not wire it.
      throw new NotFoundError("Command deployment is not available in this process.");
    }

    return {
      client: this.deps.client,
      commands: this.deps.commands,
      appConfig: this.deps.appConfig,
      logger,
      config: this.deps.config,
      database: this.deps.database,
      permissions: this.deps.permissions,
      // The handler only needs the authorization layer when it was supplied; the
      // legacy path is used otherwise, and this context field mirrors that.
      authorization: this.deps.authorization as AuthorizationService,
      permissionClasses: this.requirePermissionClasses(),
      diagnostics: this.deps.diagnostics ?? null,
      audit: this.deps.audit,
      setupResources: this.deps.setupResources,
      setup: this.deps.setup,
      setupContext,
      moderation,
      security,
      automod,
      tickets: this.deps.createTicketContext(interaction.guild, logger),
      // Only built when the interaction is in a guild and the process was wired with a
      // reminder service; `/reminder` is guild-only, so `null` is the honest answer.
      reminders: this.deps.remindersForGuild?.(interaction.guild, logger) ?? null,
      backup,
      // V9: process-wide, so it is forwarded as-is rather than built per guild.
      repositoryMonitor: this.deps.repositoryMonitor ?? null,
      deployment,
      guildConfig,
      maintenance: this.deps.maintenance ?? null,
      ai: this.deps.ai ?? null,
      aiSettings: this.deps.aiSettings ?? null,
      aiMemory: this.deps.aiMemory ?? null,
      process: this.deps.process ?? null,
      guildLeave: this.deps.guildLeave ?? null,
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

/**
 * Translates the command-level requirement into an authorization request.
 *
 * The command declares its requirement once (via `defineSlashCommand`); this is
 * the single place that interpretation happens, so no command has to know how the
 * authorization layer is shaped.
 *
 * `custom` is carried through deliberately: it is the *only* gate on commands
 * such as `/ai` and `/roles` (a granular permission resolved through the role →
 * class mapping). Dropping it here turned every custom-only requirement into a
 * no-op, which let any member invoke those commands — the escalation this
 * function must never reintroduce. Exported so a regression test can assert the
 * translation rather than the whole dispatch path.
 */
export function toRequest(requirement: PermissionRequirement): PermissionRequest {
  return {
    ...(requirement.discord === undefined ? {} : { discord: requirement.discord }),
    ...(requirement.custom === undefined ? {} : { custom: requirement.custom }),
    ...(requirement.botPermissions === undefined
      ? {}
      : { botPermissions: requirement.botPermissions }),
    ...(requirement.ownerOnly === undefined ? {} : { ownerOnly: requirement.ownerOnly }),
  };
}
