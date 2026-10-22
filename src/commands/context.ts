/**
 * Execution context handed to every command handler.
 *
 * Services are injected here so command files never import singletons, which
 * keeps them testable and prevents circular dependencies.
 */
import type { BotClient } from "../client/client.types.js";
import type { CommandRegistry } from "./command.registry.js";
import type { Guild } from "discord.js";
import type { AppConfig } from "../config/config.js";
import type { ConfigService, GuildConfig } from "../services/config/index.js";
import type { DatabaseService } from "../services/database/index.js";
import type { Logger } from "../services/logger/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { AuditEventService } from "../services/audit/index.js";
import type { SetupService } from "../modules/setup.service.js";
import type { AuthorizationService } from "../services/authorization/index.js";
import type { PermissionClassStore } from "../services/authorization/index.js";
import type { MaintenanceService } from "../services/maintenance/index.js";
import type { ProcessControlService } from "../services/process/index.js";
import type { GuildLeaveService } from "../services/guild/index.js";
import type { DiagnosticRegistry } from "../diagnostics/index.js";
import type { ModerationService } from "../modules/moderation/moderation.service.js";
import type { GuildMemberActions } from "../modules/moderation/member-actions.js";
import type { AutomodService } from "../modules/automod/index.js";
import type { GuildSecurityActions, SecurityService } from "../modules/security/index.js";
import type { BackupService } from "../modules/backup/index.js";
import type { CommandDeploymentService } from "../services/deployment/index.js";
import type { AiGateway } from "../services/ai/ai.gateway.js";
import type { AiSettingsService } from "../services/ai/ai-settings.service.js";
import type { AiMemoryService } from "../modules/ai/ai-memory.service.js";
import type { TicketService } from "../modules/tickets/ticket.service.js";
import type { ReminderService } from "../modules/reminders/index.js";
import type {
  SetupPermissionService,
  SetupResourceDefinition,
  SetupResourceService,
} from "../modules/setup/index.js";

/** Guild-bound setup collaborators handed to commands that manage server structure. */
export interface SetupContextServices {
  /** Resource registry (`SETUP_RESOURCES`). */
  readonly definitions: readonly SetupResourceDefinition[];
  /** Resource identity + recovery API for the current guild. */
  readonly resources: SetupResourceService;
  /** Declarative permission configuration API. */
  readonly permissionService: SetupPermissionService;
}

/**
 * Guild-bound moderation collaborators.
 *
 * Exposed as a port rather than a service so a caller cannot reach past the
 * service to the Discord adapter, and so the tests can supply a fake one.
 */
export interface ModerationContextServices {
  readonly service: ModerationService;
  readonly members: GuildMemberActions;
}

/**
 * Guild-bound security collaborators.
 *
 * `actions` is a port for the same reason `members` is: a command may legitimately
 * need to ask "is there a `Quarantined` role?", but it must not be handed the guild
 * object and start locking channels on its own.
 */
export interface SecurityContextServices {
  readonly service: SecurityService;
  readonly actions: GuildSecurityActions;
}

/**
 * Guild-bound automod collaborators.
 *
 * A command has no business judging messages, so this exposes only what a report
 * needs: the service, for the configuration and the window reset, and the rule
 * table, for labels.
 */
export interface AutomodContextServices {
  readonly service: AutomodService;
}

/**
 * Guild-bound ticket collaborators.
 *
 * Exposed as a service plus the guild it is bound to, because two callers need two
 * different things: a command needs the service, and a setup action needs only to seed
 * categories. Both are scoped to the one guild the interaction came from, so neither can
 * reach another server's tickets.
 */
export interface TicketContextServices {
  readonly service: TicketService;
  /** The guild this context is bound to. */
  readonly guildId: string;
  /** Actor id recorded on categories seeded by setup. */
  readonly actorId: string;
}

export interface CommandExecutionContext {
  /** Discord client, for read-only metadata access. */
  readonly client: BotClient;
  /** Registry of loaded commands (used by `/help`). */
  readonly commands: CommandRegistry;
  /** Validated application configuration (environment, feature flags). */
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  /** Guild-scoped configuration service. */
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly permissions: PermissionService;
  /** Central V3 authorization layer (Discord + custom permissions + God Access). */
  readonly authorization: AuthorizationService;
  /**
   * Role → permission-class store.
   *
   * `/roles` reads and writes bindings here so "what a class grants" has one definition
   * (the store's), and a role bound through the command takes effect on the very next
   * authorization check rather than after a restart.
   */
  readonly permissionClasses: PermissionClassStore;
  /** Registry of diagnostic checks; extensible by feature modules. */
  readonly diagnostics: DiagnosticRegistry | null;
  /** Structured audit trail; modules record privileged actions through it. */
  readonly audit: AuditEventService;
  /** Setup resource registry (the V2 registry, reused as-is). */
  readonly setupResources: readonly SetupResourceDefinition[];
  readonly setup: SetupService;
  /** Guild-bound setup helpers; `null` outside a guild. */
  readonly setupContext: SetupContextServices | null;
  /** Guild-bound moderation; `null` outside a guild. */
  readonly moderation: ModerationContextServices;
  /** Guild-bound security (anti-raid, anti-nuke, lockdown); `null` outside a guild. */
  readonly security: SecurityContextServices | null;
  /** Guild-bound automod; `null` outside a guild. */
  readonly automod: AutomodContextServices | null;
  /** Guild-bound tickets; `null` outside a guild or when the module is unwired. */
  readonly tickets: TicketContextServices | null;
  /**
   * Guild-bound reminder service for `/reminder`.
   *
   * `null` when the process was not wired with one (a harness), and the command then
   * refuses rather than silently doing nothing.
   */
  readonly reminders: ReminderService | null;
  /** Backups of this guild's structure; `null` outside a guild. */
  readonly backup: BackupService | null;
  /**
   * Slash-command deployment.
   *
   * Exposed so `/admin deploy` can trigger an automatic deployment on demand
   * through the same service startup uses, which is what makes it possible to fix
   * a server that is missing commands without restarting the bot.
   */
  readonly deployment: CommandDeploymentService;
  /** Guild configuration. Only available for guild-only commands. */
  readonly guildConfig: GuildConfig | null;
  /**
   * Guild-scoped maintenance mode.
   *
   * `/maintenance` is the only consumer; `null` means the process was not wired
   * with one (a harness), and the command refuses rather than writing nothing.
   */
  readonly maintenance: MaintenanceService | null;
  /** Process-wide AI gateway (absent = unconfigured; graceful degradation). */
  readonly ai: AiGateway | null;
  /** Global provider settings, editable at runtime by the owner. */
  readonly aiSettings: AiSettingsService | null;
  /** Guild-scoped AI memory service (absent = no memory wired). */
  readonly aiMemory: AiMemoryService | null;
  /**
   * Process control, for `/stop` and `/restart`.
   *
   * `null` when the process was not wired with it (a harness), and the commands then
   * refuse: a stop is not something to simulate.
   */
  readonly process: ProcessControlService | null;
  /**
   * Leaving the current guild, for `/leave`.
   *
   * `null` when the process was not wired with it (a harness); the command then
   * refuses rather than reaching for the client's guild cache itself.
   */
  readonly guildLeave: GuildLeaveService | null;
  /** Milliseconds since the process started; used by `/ping`. */
  readonly uptimeMs: number;
}

/** Services required to build an execution context. */
export interface CommandContextServices {
  readonly client: BotClient;
  readonly commands: CommandRegistry;
  readonly appConfig: AppConfig;
  readonly logger: Logger;
  readonly config: ConfigService;
  readonly database: DatabaseService;
  readonly permissions: PermissionService;
  readonly authorization: AuthorizationService;
  readonly audit: AuditEventService;
  readonly diagnostics: DiagnosticRegistry | null;
  readonly setup: SetupService;
  readonly setupResources: readonly SetupResourceDefinition[];
  /** Builds the guild-bound moderation collaborators for an invocation. */
  readonly createModerationContext: (guild: Guild, logger: Logger) => ModerationContextServices;
  /** Builds the guild-bound security collaborators for an invocation. */
  readonly createSecurityContext: (guild: Guild, logger: Logger) => SecurityContextServices;
  /** Builds the guild-bound automod collaborators for an invocation. */
  readonly createAutomodContext: (guild: Guild, logger: Logger) => AutomodContextServices;
  /** Builds the guild-bound ticket collaborators for an invocation. */
  readonly createTicketContext: (guild: Guild, logger: Logger) => TicketContextServices;
  /** Builds the guild-bound reminder service for `/reminder`. */
  readonly remindersForGuild: ((guild: Guild, logger: Logger) => ReminderService | null) | null;
  /** Snapshot storage, shared by `/backup` and the periodic worker. */
  readonly backup: BackupService | null;
  /** Slash-command deployment, shared with startup and `guildCreate`. */
  readonly deployment: CommandDeploymentService;
  /** Process-wide AI gateway (absent = unconfigured; graceful degradation). */
  readonly ai: AiGateway | null;
  /** Global provider settings, editable at runtime by the owner. */
  readonly aiSettings: AiSettingsService | null;
  /** Guild-scoped AI memory service (absent = no memory wired). */
  readonly aiMemory: AiMemoryService | null;
  /** Guild-scoped maintenance mode (absent = the gate is not wired in this process). */
  readonly maintenance: MaintenanceService | null;
  /** Process control, for `/stop` and `/restart` (absent = not wired in this process). */
  readonly process: ProcessControlService | null;
  /** Guild leaving, for `/leave` (absent = not wired in this process). */
  readonly guildLeave: GuildLeaveService | null;
}
