/**
 * Service container.
 *
 * Dependency injection happens exactly once, in the bootstrap. Services and
 * event handlers receive this object; nothing imports module-level singletons,
 * which keeps the architecture testable and free of circular dependencies.
 */
import type { BotClient } from "../client/client.types.js";
import type { Guild } from "discord.js";

import type { AppConfig } from "../config/config.js";
import type { Logger } from "./logger/index.js";
import type { DatabaseService } from "./database/index.js";
import type { ConfigService } from "./config/index.js";
import type { PermissionService } from "./permissions/index.js";
import type { AuthorizationService } from "./authorization/index.js";
import type { PermissionClassStore } from "./authorization/index.js";
import type { MaintenanceService } from "./maintenance/index.js";
import type { AuditEventService } from "./audit/index.js";
import type { SetupService } from "../modules/setup.service.js";
import type { CommandRegistry } from "../commands/command.registry.js";
import type { DiagnosticRegistry } from "../diagnostics/index.js";
import type { SetupResourceDefinition } from "../modules/setup.types.js";
import type { AutomodService } from "../modules/automod/index.js";
import type { SecurityLogSink, SecurityService } from "../modules/security/index.js";
import type { GuildLogPort } from "../modules/logging/guild-log.port.js";
import type { BackupService } from "../modules/backup/index.js";
import type { SchedulerService } from "../modules/scheduler/scheduler.service.js";
import type { RoleService } from "../modules/roles/index.js";
import type { MemberOnboardingService } from "../modules/members/index.js";
import type { ReminderService } from "../modules/reminders/index.js";
import type { ModerationSweeper } from "../modules/moderation/moderation.sweeper.js";
import type { CommandDeploymentService } from "./deployment/index.js";
import type { AiGateway } from "./ai/ai.gateway.js";
import type { AiSettingsService } from "./ai/ai-settings.service.js";
import type { AiMemoryService } from "../modules/ai/ai-memory.service.js";
import type { AiAgentService } from "../modules/ai/ai-agent.service.js";
import type { AiToolRegistry } from "../modules/ai/ai.module.js";
import type {
  AutomodContextServices,
  ModerationContextServices,
  SecurityContextServices,
  SetupContextServices,
  TicketContextServices,
} from "../commands/context.js";

export interface AppServices {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly client: BotClient;
  readonly database: DatabaseService;
  /** Guild-scoped configuration service (`config.get(guildId)`). */
  readonly guildConfig: ConfigService;
  readonly permissions: PermissionService;
  /** Central authorization layer: Discord + custom permissions + God Access. */
  readonly authorization: AuthorizationService;
  /**
   * Guild-scoped maintenance mode.
   *
   * Exposed so the interaction handler, the AI keyword path and `/maintenance` all
   * read and write the same state: a pause that one surface honours and another
   * ignores would be worse than no pause at all.
   */
  readonly maintenance: MaintenanceService;
  /**
   * Role → permission-class store.
   *
   * Exposed so `/roles` can bind a Discord role to a power level (and list what is
   * bound) through the same store the authorization layer resolves — one definition of
   * "what a class grants", never a second copy in a command.
   */
  readonly permissionClasses: PermissionClassStore;
  /** Structured audit trail for privileged and configuration-changing actions. */
  readonly audit: AuditEventService;
  /** Extensible registry of diagnostic checks. */
  readonly diagnostics: DiagnosticRegistry;
  /** Setup resource registry (`SETUP_RESOURCES`). */
  readonly setupResources: readonly SetupResourceDefinition[];
  readonly setup: SetupService;
  readonly commands: CommandRegistry;
  /**
   * Builds the guild-bound setup collaborators for a command invocation.
   *
   * Exposed on the container so the interaction handler stays a pure dispatcher
   * and every consumer shares one construction path.
   */
  readonly createSetupContext: (guild: Guild, logger: Logger) => SetupContextServices;
  /** Builds the guild-bound moderation collaborators for a command invocation. */
  readonly createModerationContext: (guild: Guild, logger: Logger) => ModerationContextServices;
  /** Builds the guild-bound security collaborators for a command invocation. */
  readonly createSecurityContext: (guild: Guild, logger: Logger) => SecurityContextServices;
  /** Builds the guild-bound automod collaborators for a command invocation. */
  readonly createAutomodContext: (guild: Guild, logger: Logger) => AutomodContextServices;
  /** Builds the guild-bound ticket collaborators for a command invocation. */
  readonly createTicketContext: (guild: Guild, logger: Logger) => TicketContextServices;
  /** Builds the guild-bound backup service for a command invocation. */
  readonly createBackupService: (guild: Guild, logger: Logger) => BackupService;
  /**
   * Resolves the guild-bound automod service for an event handler.
   *
   * `null` when the bot is not in that guild, which the handlers treat as "nothing
   * to judge" — the safe default on a hot path, since a guild the bot has left has
   * nothing to moderate.
   */
  readonly automodForGuild: (guildId: string) => AutomodService | null;
  /** Resolves the guild-bound anti-raid / anti-nuke service for an event handler. */
  readonly securityForGuild: (guildId: string) => SecurityService | null;
  /** Resolves the guild-bound backup service, for the periodic snapshot worker. */
  readonly backupForGuild: (guildId: string, logger: Logger) => BackupService | null;
  /** Whether a trigger should delete the offending message, from guild config. */
  readonly automodDeleteTriggers: (guildId: string) => Promise<boolean>;
  /** The security log sink, so a command can announce a lockdown in Discord. */
  readonly securityLog: SecurityLogSink;
  /**
   * Records gateway events — joins, leaves, deletes, edits, role and channel
   * changes — into the guild's log channel.
   *
   * Exposed on the container because the handlers that observe these events are
   * discovered by filename and cannot import the bootstrap: the port is how they
   * reach configuration and the logger without a second construction path.
   */
  readonly guildLog: GuildLogPort;
  /**
   * Slash-command deployment, shared by startup, `guildCreate` and `/admin deploy`.
   *
   * Deliberately one instance: the fingerprint a guild is compared against must be
   * the payload the registry currently holds, so a second construction could
   * report a guild as "already deployed" against a different payload.
   */
  readonly deployment: CommandDeploymentService;
  /**
   * The unified scheduler: the single owner of all deferred work.
   *
   * Exposed so `clientReady` starts it and a command can enqueue a task without
   * constructing a second engine.
   */
  readonly scheduler: SchedulerService;
  /** Guild-bound role service, for `/role` commands and the expiry handler. */
  readonly rolesForGuild: (guildId: string) => RoleService | null;
  /**
   * Guild-bound member onboarding, for the `guildMemberAdd` handler.
   *
   * Resolved per join because the welcome channel and the roles it grants are
   * guild-bound Discord operations; the service reads the guild's live `members`
   * configuration on every call, so `/settings` takes effect immediately.
   */
  readonly membersForGuild: (guildId: string) => MemberOnboardingService | null;
  /**
   * Guild-bound reminder service, for `/reminder` and the Disboard bump detector.
   *
   * Resolved per guild because delivering a reminder is a Discord operation on a
   * specific guild, and the bump settings are read from that guild's configuration.
   * `null` when the bot is not in the guild.
   */
  readonly remindersForGuild: (guild: Guild, logger: Logger) => ReminderService | null;
  /** The expired-punishment sweeper, so `guildCreate` schedules it per guild. */
  readonly moderationSweeper: ModerationSweeper;
  /** Epoch milliseconds of process start, used for uptime reporting. */
  readonly startedAt: number;
  /** Process-wide AI gateway: model levels, retry, budget and cost logging. */
  readonly ai: AiGateway;
  /** Global provider settings, editable at runtime by the owner. */
  readonly aiSettings: AiSettingsService;
  /** Guild-scoped AI memory (remember / recall / forget); gated per guild. */
  readonly aiMemory: AiMemoryService;
  /** Builds the keyword agent for a guild invocation. */
  readonly createAiAgent: (guild: Guild, logger: Logger) => AiAgentService;
  /** The tool registry (shared), so events can build the active menu. */
  readonly aiRegistry: AiToolRegistry;
}

/**
 * Container with lifecycle helpers.
 *
 * The container is immutable: services are added while it is being built and are
 * then read-only for the lifetime of the process.
 */
export class ServiceContainer {
  private services: AppServices | null = null;

  public set(services: AppServices): void {
    if (this.services) {
      throw new Error("Service container has already been initialised");
    }
    this.services = services;
  }

  public get(): AppServices {
    if (!this.services) {
      throw new Error("Service container has not been initialised yet");
    }
    return this.services;
  }

  public get isInitialised(): boolean {
    return this.services !== null;
  }

  /** Releases every resource in reverse dependency order. */
  public async shutdown(): Promise<void> {
    const services = this.services;
    if (!services) {
      return;
    }
    await services.database.disconnect();
    services.logger.info("Services shut down");
    this.services = null;
  }
}
