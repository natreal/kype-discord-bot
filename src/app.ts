/**
 * Application bootstrap.
 *
 * This file wires the foundation together and manages the process lifecycle:
 *
 *   1. load environment variables
 *   2. validate configuration with Zod
 *   3. initialise the logger
 *   4. create services (client, database, config, permissions, setup)
 *   5. discover and register commands
 *   6. discover and register events
 *   7. connect to Discord
 *   8. report successful startup
 *   9. handle startup failures
 *  10. handle SIGINT / SIGTERM and shut down gracefully
 *
 * `index.ts` only calls `main()`. All composition lives here.
 */
import { createConfig, redactConfig } from "./config/config.js";
import { DiscordClientFactory } from "./client/discord-client.js";
import type { BotClient } from "./client/client.types.js";
import type { IntentFeature } from "./client/intents.js";
import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type TextChannel,
} from "discord.js";
import { CommandRegistry } from "./commands/command.registry.js";
import { loadAndRegisterCommands } from "./commands/command.loader.js";
import { registerEvents } from "./events/event.loader.js";
import { ConfigService, readCachedLogging } from "./services/config/index.js";
import { ServiceContainer } from "./services/container.js";
import { DatabaseService } from "./services/database/index.js";
import { PermissionService } from "./services/permissions/index.js";
import {
  AuthorizationService,
  PermissionClassStore,
  PrismaPermissionClassRepository,
} from "./services/authorization/index.js";
import { AuditEventService, PrismaAuditEventRepository } from "./services/audit/index.js";
import { MaintenanceService } from "./services/maintenance/index.js";
import { ProcessControlService } from "./services/process/index.js";
import { GuildLeaveService } from "./services/guild/index.js";
import { BUILT_IN_DIAGNOSTICS, DiagnosticRegistry } from "./diagnostics/index.js";
import { createLogger, type Logger } from "./services/logger/index.js";
import { ConsoleSink } from "./services/logger/sinks.js";
import { watchStopRequest } from "./runtime/stop-request.js";
import {
  clearRestartRequest,
  isRestartRequested,
  RESTART_EXIT_CODE,
} from "./runtime/restart-request.js";
import { LoggerModerationLogPort } from "./modules/logging/moderation-log.port.js";
import {
  ModerationLogSink,
  setLogChannelConfigReader,
} from "./modules/logging/moderation-log.sink.js";
import { GuildLogPort } from "./modules/logging/guild-log.port.js";
import { GuildLogSink } from "./modules/logging/guild-log.sink.js";
import { DiscordMemberActions } from "./modules/moderation/discord-member-actions.js";
import { PrismaModerationCaseRepository } from "./modules/moderation/moderation-case.repository.js";
import { ModerationService } from "./modules/moderation/moderation.service.js";
import { ModerationSweeper } from "./modules/moderation/moderation.sweeper.js";
import { SchedulerService } from "./modules/scheduler/scheduler.service.js";
import { PrismaScheduledTaskRepository } from "./modules/scheduler/scheduler.repository.js";
import { TaskHandlerRegistry } from "./modules/scheduler/task-registry.js";
import {
  DiscordRoleActions,
  PrismaRoleGrantRepository,
  RoleService,
} from "./modules/roles/index.js";
import { ROLE_EXPIRE_TASK_KIND } from "./modules/roles/role.service.js";
import {
  DiscordMemberOnboardingActions,
  MemberOnboardingService,
} from "./modules/members/index.js";
import {
  createReminderTaskHandlers,
  DiscordReminderActions,
  ReminderService,
} from "./modules/reminders/index.js";
import { AutomodService } from "./modules/automod/automod.service.js";
import {
  DiscordSecurityActions,
  PrismaSecurityIncidentRepository,
  SecurityLogSink,
  SecurityService,
} from "./modules/security/index.js";
import {
  BackupService,
  DiscordBackupActions,
  PrismaBackupRepository,
} from "./modules/backup/index.js";
import {
  DiscordTicketActions,
  PrismaTicketRepository,
  TicketService,
} from "./modules/tickets/index.js";
import { botModules } from "./modules/registry.js";
import type { ModuleTicketContext } from "./modules/module.types.js";
import { SetupService } from "./modules/setup.service.js";
import { DiscordSetuper } from "./modules/setuper.js";
import {
  CommandDeploymentService,
  PrismaCommandDeploymentRepository,
} from "./services/deployment/index.js";
import {
  DEFAULT_RACE_WAIT_MS,
  SETUP_RESOURCES,
  GuildSetupDiscordAdapter,
  PrismaSetupResourceRepository,
  SetupPermissionService,
  SetupResourceService,
  createGuildSetupModuleFactory,
  type SetupResourceDefinition,
} from "./modules/setup/index.js";
import type {
  AutomodContextServices,
  ModerationContextServices,
  SecurityContextServices,
  SetupContextServices,
  TicketContextServices,
} from "./commands/context.js";
import { ValidationError } from "./utils/errors.js";
import { modulesDirectory } from "./utils/fs.js";
import { formatError } from "./utils/serialization.js";
import { OpenAiCompatibleClient } from "./services/ai/openai-compatible.client.js";
import { AiGateway } from "./services/ai/ai.gateway.js";
import {
  AiSettingsService,
  PrismaAiProviderSettingsRepository,
  envDefaultsFrom,
} from "./services/ai/ai-settings.service.js";
import {
  AI_TOOLS,
  AiAgentService,
  AiMemoryService,
  AiToolRegistry,
  DiscordAiActions,
  PrismaAiGuildMemoryRepository,
  TicketAiActions,
} from "./modules/ai/index.js";
import { GitHubClient } from "./services/github/client.js";
import { RepositoryProbe } from "./services/anyps5/repository.probe.js";
import {
  DiscordRepositoryReport,
  PrismaRepositoryMonitorRepository,
  RepositoryMonitorService,
  RepositoryRefresher,
} from "./modules/repository/index.js";

/**
 * Intents enabled by default.
 *
 * V5 turns on the intents automod and security require, so the feature ships
 * working instead of shipping as a switch nobody knows to flip:
 *
 * - `messageContent` (privileged) — automod cannot read a message without it;
 * - `guildModeration` — the audit log is the only source that attributes a channel
 *   deletion to an account, which is what anti-nuke needs;
 * - `guildMembers` is already in `BASE_INTENTS` — anti-raid counts joins with it.
 *
 * `messageContent` must also be enabled in the Discord developer portal
 * (Bot → Privileged Gateway Intents). `privilegedFeatures()` reports exactly which
 * intents need that, and `/diagnostics` warns when the intent is off but automod is
 * enabled — a silently inert automod is the worst outcome of all.
 */
export const ENABLED_INTENT_FEATURES: readonly IntentFeature[] = [
  "messageContent",
  "guildMessages",
  "guildModeration",
  "guildMembers",
];

export interface Application {
  readonly container: ServiceContainer;
  readonly client: BotClient;
  readonly logger: Logger;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}
/** Builds all services and returns the application handle. */
export async function createApplication(): Promise<Application> {
  const startedAt = Date.now();
  const config = createConfig();

  const logger = createLogger("app", {
    level: config.logging.level,
    sinks: [new ConsoleSink({ color: config.isDevelopment })],
  });

  logger.info("Application starting", { environment: config.environment, node: process.version });
  logger.debug("Configuration loaded", redactConfig(config));

  const client = new DiscordClientFactory(logger, {
    features: ENABLED_INTENT_FEATURES,
    debug: config.isDevelopment && config.logging.level === "debug",
  }).create();

  const registry = new CommandRegistry();
  /**
   * Registry of scheduled-task handlers.
   *
   * One registry, populated by the modules, and read by the scheduler. It is built
   * here so that every handler exists before `scheduler.start()` is called from
   * `clientReady`; a kind registered later would make an already-due task fail with
   * `UnknownTaskKindError` until the next restart.
   */
  const taskRegistry = new TaskHandlerRegistry();
  const database = new DatabaseService(config, logger);
  const audit = new AuditEventService(logger, new PrismaAuditEventRepository(database.prisma));
  const guildConfig = new ConfigService({ database, logger, audit });
  const permissions = new PermissionService();

  // V3: the central authorization layer owns Discord permissions, custom
  // permissions (role → class → permission) and the God Access bypass.
  const permissionClasses = new PermissionClassStore({
    logger,
    repository: new PrismaPermissionClassRepository(database.prisma),
  });
  const authorization = new AuthorizationService({ logger, classes: permissionClasses, audit });
  // One instance, shared by the interaction gate, the AI keyword path and the
  // command: a pause the dispatcher honours but the keyword agent does not would
  // be a half-measure, and the state must have a single writer.
  const maintenance = new MaintenanceService({
    config: guildConfig,
    permissions,
    authorization,
    logger,
  });

  // V3: diagnostics are registered, never hardcoded in the command.
  const diagnostics = new DiagnosticRegistry(logger);
  diagnostics.registerAll(BUILT_IN_DIAGNOSTICS);

  // V2: the automatic setup module is built per guild (it owns that guild's
  // identity table and Discord handles), while the V1 feature modules stay static.
  // Both flow through the same fixed orchestration pipeline.
  const setupModuleFactory = createGuildSetupModuleFactory({ database, logger });

  /**
   * Builds the guild-bound setup collaborators.
   *
   * One construction path shared by commands (`setupContext`) and the setup
   * service (`repair()` needs the identity table to decide what is actually
   * broken), so a repair can never disagree with a run about what exists.
   */
  const createSetupContext = (guild: Guild, scopeLogger: Logger): SetupContextServices => {
    const permissionsForGuild = new SetupPermissionService({ logger: scopeLogger });
    const setuper = new DiscordSetuper(guild, scopeLogger);

    const resources = new SetupResourceService({
      guild,
      repository: new PrismaSetupResourceRepository(database.prisma, guild.name),
      logger: scopeLogger,
      // Covers the window where a concurrent run has created the resource but not
      // yet stored its ID, so the loser adopts instead of duplicating.
      raceWaitMs: DEFAULT_RACE_WAIT_MS,
      discord: new GuildSetupDiscordAdapter({
        guild,
        findChannelById: (channelId) => channelTypeSafe(setuper.findChannelById(channelId)),
        findChannelByName: (name, parentId) => findTextChannelByName(setuper, name, parentId),
        createChannel: (definition, parentId) =>
          createChannelFromDefinition(setuper, definition, parentId),
        findRoleById: (roleId) => setuper.findRoleById(roleId),
        findRoleByName: (name) => setuper.findRoleByName(name),
        createRole: (definition) =>
          setuper
            .ensureRole({
              name: definition.name,
              permissions: definition.rolePermissions ?? [],
              hoist: false,
              mentionable: false,
              reason: DEFAULT_SETUP_REASON,
            })
            .then((result) => result.resource),
      }),
    });

    return {
      definitions: SETUP_RESOURCES,
      resources,
      permissionService: permissionsForGuild,
    };
  };

  const setup = new SetupService({
    database,
    config: guildConfig,
    permissions,
    authorization,
    audit,
    logger,
    modules: botModules,
    resolveModules: (guild, moduleLogger) => [setupModuleFactory(guild, moduleLogger)],
    resourceDefinitions: SETUP_RESOURCES,
    createSetuper: (guild, moduleLogger) => new DiscordSetuper(guild, moduleLogger),
    repairResourcesFor: (guild) => createSetupContext(guild, logger).resources,
    // The narrow ticket port, so the ticket module's "seed categories" action can
    // actually run: without this the setup run reports "ticket service unavailable"
    // and the panel is left with no buttons to click.
    ticketsFor: (guild) => ticketModuleContext(guild, logger),
  });

  // The log delivery port is created once and shared: a logger record emitted
  // through it is picked up by the Discord sink, which resolves the guild's
  // channel at delivery time.
  const moderationLog = new LoggerModerationLogPort(logger);

  /**
   * The Discord log sink.
   *
   * Registered on the platform logger so every moderation record it emits is
   * delivered to the guild's log channel. The sink re-reads no configuration on
   * the hot path: it resolves the channel by recorded ID and falls back to the
   * name `setup` created, which is correct even before the configuration is
   * written.
   *
   * The reader below is what makes `/settings logging` take effect: without it the
   * sink only ever searched for a channel *named* `server-logs`, so a guild that
   * pointed logging at its own channel — or created one under a different name —
   * saw nothing at all. The reader is synchronous because the logger's `write` is.
   */
  setLogChannelConfigReader((guildId) => readCachedLogging(guildId));
  logger.addSink(new ModerationLogSink({ client, logger }));

  /**
   * The security log sink.
   *
   * A separate sink, and a separate channel, from the moderation one: a raid alert
   * mixed into the moderation stream is a raid nobody reads. The sink resolves the
   * channel by recorded ID, then by the name `setup` created.
   */
  const securityLog = new SecurityLogSink({ client, logger });

  /**
   * The guild-event log port and its sink.
   *
   * Registered before the event handlers are loaded so a join arriving immediately
   * after startup is already logged. The port checks the guild's `logging.events`
   * toggle and the sink resolves the channel, which is the pair of steps that was
   * missing: the toggles existed and the channel existed, but nothing connected them.
   */
  const guildLog = new GuildLogPort(logger);
  logger.addSink(new GuildLogSink({ client, logger }));

  /**
   * Builds the guild-bound moderation collaborators.
   *
   * One construction path, like the setup context, so commands and any future
   * automated caller go through the same member-action adapter, the same case
   * repository and the same configuration reader.
   */
  const createModerationContext = (
    guild: Guild,
    scopeLogger: Logger,
  ): ModerationContextServices => {
    const members = new DiscordMemberActions(guild);
    const service = new ModerationService({
      logger: scopeLogger,
      audit,
      cases: new PrismaModerationCaseRepository(database.prisma),
      members,
      // Read per call, so `/settings moderation` takes effect immediately rather
      // than on the next restart.
      settings: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => config.moderation),
      log: moderationLog,
    });
    return { service, members };
  };

  /**
   * Builds the guild-bound automod collaborators.
   *
   * Automod is constructed with the *moderation* service, never with Discord: it
   * can only ever punish through the V4 module, which is the V5 constraint made
   * structural rather than documented.
   */
  const createAutomodContext = (guild: Guild, scopeLogger: Logger): AutomodContextServices => {
    const moderation = createModerationContext(guild, scopeLogger);
    const service = new AutomodService({
      logger: scopeLogger,
      audit,
      moderation: moderation.service,
      members: moderation.members,
      settings: (guildId) => guildConfig.get(guildId, guild.name).then((config) => config.automod),
      moderationEnabled: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => config.moderation.enabled),
      // A member who can configure security is staff, and punishing a moderator
      // explaining a rule is exactly the false positive that gets automod disabled.
      exemption: {
        holdsSecurityPermission: async (guildId, userId) => {
          const guild = client.guilds.cache.get(guildId);
          const member = guild?.members.cache.get(userId);
          if (!member) {
            return false;
          }
          return authorization.can(member, { custom: ["security.lockdown"] }, "automod");
        },
      },
    });
    return { service };
  };

  /**
   * Builds the guild-bound security collaborators.
   *
   * Like automod, security holds the moderation service and never Discord member
   * actions directly: containment is a moderation action, not a second sanction
   * implementation.
   */
  const createSecurityContext = (guild: Guild, scopeLogger: Logger): SecurityContextServices => {
    const moderation = createModerationContext(guild, scopeLogger);
    const actions = new DiscordSecurityActions(guild);
    const service = new SecurityService({
      logger: scopeLogger,
      audit,
      moderation: moderation.service,
      members: moderation.members,
      actions,
      settings: (guildId) => guildConfig.get(guildId, guild.name).then((config) => config.security),
      moderationEnabled: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => config.moderation.enabled),
      incidents: new PrismaSecurityIncidentRepository(database.prisma),
      log: securityLog,
    });
    return { service, actions };
  };

  /**
   * Builds the guild-bound backup service.
   *
   * Guild-bound like the other module contexts, because the Discord operations it
   * needs (`DiscordBackupActions`) are bound to one guild, and a restore must not be
   * able to address another server's channels even by accident. Storage itself is
   * shared and always queried by `guildId`.
   */
  const createBackupService = (guild: Guild, scopeLogger: Logger): BackupService =>
    new BackupService({
      logger: scopeLogger,
      audit,
      repository: new PrismaBackupRepository(database.prisma),
      actions: new DiscordBackupActions(guild),
      readConfig: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => ({
          language: config.language,
          logging: config.logging,
          moderation: config.moderation,
          automod: config.automod,
          security: config.security,
          members: config.members,
        })),
    });

  const createTicketService = (guild: Guild, scopeLogger: Logger): TicketService =>
    new TicketService({
      logger: scopeLogger,
      audit,
      repository: new PrismaTicketRepository(database.prisma),
      // One adapter per guild: the channel operations it exposes can only ever address
      // this server, which is what makes "tickets never leak between guilds" structural
      // rather than a rule someone has to remember.
      actions: new DiscordTicketActions(guild),
      // Read per call, so a `/settings set area:tickets setting:tickets-enabled`
      // change takes effect immediately.
      enabled: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => config.tickets.enabled),
      // Admins, the support class and the configured staff role get ticket access through
      // the role → class model, so a server does not have to grant Discord's
      // `Administrator` permission just to let its admin role read tickets.
      ticketAccessRoleIds: async (guildId) => {
        const [classRoleIds, config] = await Promise.all([
          permissionClasses.roleIdsGranting(guildId, ["tickets.view", "tickets.manage"]),
          guildConfig.get(guildId, guild.name),
        ]);
        const staffRoleId = config.tickets.staffRoleId;
        return staffRoleId === null || classRoleIds.includes(staffRoleId)
          ? classRoleIds
          : [...classRoleIds, staffRoleId];
      },
      // Read per call, so raising or lowering the ceiling applies to the next ticket.
      memberLimit: (guildId) =>
        guildConfig.get(guildId, guild.name).then((config) => config.tickets.memberTicketLimit),
    });

  const createTicketContext = (guild: Guild, scopeLogger: Logger): TicketContextServices => {
    const service = createTicketService(guild, scopeLogger);
    return { service, guildId: guild.id, actorId: "system:setup" };
  };

  // Hoisted so `SetupService` (constructed above) can seed ticket categories through
  // the same narrow port the ticket module expects: `findCategory` / `saveCategory`,
  // scoped to one guild and never the full service.
  function ticketModuleContext(guild: Guild, scopeLogger: Logger): ModuleTicketContext {
    const service = createTicketService(guild, scopeLogger);
    return {
      guildId: guild.id,
      actorId: "system:setup",
      findCategory: (guildId, key) => service.findCategory(guildId, key),
      saveCategory: (actorId, draft) => service.saveCategory(actorId, draft),
    };
  }

  /**
   * The automod service the message handlers use.
   *
   * Built lazily per guild and cached, so `messageCreate` neither rebuilds a
   * sliding window per message nor needs a guild object it does not have. The
   * service re-reads the guild's configuration on every observation, so the cache
   * holds *windows*, never settings.
   */
  const automodByGuild = new Map<string, AutomodService>();
  const securityByGuild = new Map<string, SecurityService>();
  const backupByGuild = new Map<string, BackupService>();

  const automodFor = (guild: Guild): AutomodService => {
    const cached = automodByGuild.get(guild.id);
    if (cached) {
      return cached;
    }
    const service = createAutomodContext(guild, logger).service;
    automodByGuild.set(guild.id, service);
    return service;
  };

  const securityFor = (guild: Guild): SecurityService => {
    const cached = securityByGuild.get(guild.id);
    if (cached) {
      return cached;
    }
    const service = createSecurityContext(guild, logger).service;
    securityByGuild.set(guild.id, service);
    return service;
  };

  /**
   * The unified scheduler, constructed once per process.
   *
   * One instance owns every deferred action: temporary roles expiring now, the
   * punishment sweeper, and (next) scheduled backups and automod delays. It is
   * deliberately not per guild — a scheduler per guild would be a timer per guild,
   * which is the design this module exists to replace.
   */
  const scheduler = new SchedulerService({
    repository: new PrismaScheduledTaskRepository(database.prisma),
    registry: taskRegistry,
    logger,
    audit,
  });

  /**
   * Guild-bound role collaborators, cached per guild like the other modules.
   *
   * A grant's Discord work happens on one guild, so one adapter per guild is both
   * cheaper and safer: `DiscordRoleActions` can never address another server.
   */
  const createRoleService = (guild: Guild, scopeLogger: Logger): RoleService =>
    new RoleService({
      scheduler,
      repository: new PrismaRoleGrantRepository(database.prisma),
      actions: new DiscordRoleActions(guild),
      logger: scopeLogger,
      audit,
    });

  const roleByGuild = new Map<string, RoleService>();
  const rolesFor = (guild: Guild): RoleService => {
    const cached = roleByGuild.get(guild.id);
    if (cached) {
      return cached;
    }
    const service = createRoleService(guild, logger);
    roleByGuild.set(guild.id, service);
    return service;
  };

  /**
   * Guild-bound member onboarding, cached per guild like the other modules.
   *
   * The welcome message and the auto-roles are both operations on one guild, so
   * one adapter per guild keeps a join from ever addressing another server. The
   * configuration is read live on every join rather than captured here, so a
   * `/settings` change applies to the very next member.
   */
  const createMemberOnboardingService = (
    guild: Guild,
    scopeLogger: Logger,
  ): MemberOnboardingService =>
    new MemberOnboardingService({
      logger: scopeLogger,
      actions: new DiscordMemberOnboardingActions(guild),
      settings: (guildId) => guildConfig.get(guildId, guild.name).then((config) => config.members),
      audit,
    });

  const memberByGuild = new Map<string, MemberOnboardingService>();
  const membersFor = (guild: Guild): MemberOnboardingService => {
    const cached = memberByGuild.get(guild.id);
    if (cached) {
      return cached;
    }
    const service = createMemberOnboardingService(guild, logger);
    memberByGuild.set(guild.id, service);
    return service;
  };

  /**
   * Guild-bound reminders, cached per guild like the other modules.
   *
   * One adapter per guild means a reminder can never be posted to another server, and
   * the bump settings are read at detection time (in `messageCreate`), so `/settings`
   * takes effect on the very next bump rather than at the next restart.
   */
  const createReminderService = (guild: Guild, scopeLogger: Logger): ReminderService =>
    new ReminderService({
      scheduler,
      actions: new DiscordReminderActions(guild),
      logger: scopeLogger,
    });

  const reminderByGuild = new Map<string, ReminderService>();
  const remindersFor = (guild: Guild): ReminderService => {
    const cached = reminderByGuild.get(guild.id);
    if (cached) {
      return cached;
    }
    const service = createReminderService(guild, logger);
    reminderByGuild.set(guild.id, service);
    return service;
  };

  /**
   * The `reminder.fire` and `reminder.bump` handlers.
   *
   * Resolved per task rather than once: the task names a guild, and a service built
   * from one guild object at startup would be wrong for every other guild. A guild the
   * client no longer knows about yields `null`, which the handler reports as skipped —
   * the bot was removed, so there is nobody left to remind.
   */
  for (const handler of createReminderTaskHandlers((guildId) => {
    const guild = client.guilds.cache.get(guildId);
    return guild ? remindersFor(guild) : null;
  })) {
    taskRegistry.register(handler);
  }

  /**
   * The `role.expire` handler.
   *
   * Resolved per task rather than once: the task names a guild, and a handler bound
   * to a single guild at startup would either be wrong for every other guild or
   * would have to be built from a guild object the handler does not have.
   */
  taskRegistry.register({
    kind: ROLE_EXPIRE_TASK_KIND,
    description: "Removes a temporary role when its grant expires.",
    run: async (context) => {
      const guild = client.guilds.cache.get(context.task.guildId);
      if (!guild) {
        return { outcome: "skipped", detail: "guild unavailable" };
      }
      return rolesFor(guild).handler().run(context);
    },
  });

  /**
   * Registers the expired-punishment sweeper and schedules it per guild.
   *
   * The sweeper re-enters the normal moderation pipeline, so an automatic unmute
   * writes the same case and audit event a human one would.
   */
  const moderationSweeper = new ModerationSweeper({
    scheduler,
    // Reuses the same guild-bound moderation service the commands use, so a swept
    // action and a typed one cannot diverge.
    resolve: (guildId) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? createModerationContext(guild, logger).service : null;
    },
    logger,
  });

  taskRegistry.register(moderationSweeper.handler());

  /**
   * The process-wide AI gateway and tool registry.
   *
   * One gateway per process because the daily token budget is global; one tool
   * registry because the AI tools are static. Both are constructed even when no
   * provider is configured — the gateway then reports `isConfigured === false`
   * and every request degrades to "IA non configurée", which is how the bot
   * stays fully functional without AI.
   *
   * The provider settings are editor at runtime (God Access): `.env` provides
   * the initial defaults, and `aiSettings` may override them from the database.
   */
  const aiSettings = new AiSettingsService({
    logger,
    repository: new PrismaAiProviderSettingsRepository(database.prisma),
    env: envDefaultsFrom(config),
  });

  const aiGateway = new AiGateway({
    logger,
    provider: new OpenAiCompatibleClient({
      baseUrl: config.ai.baseUrl ?? "",
      ...(config.ai.apiKey === undefined ? {} : { apiKey: config.ai.apiKey }),
      timeoutMs: config.ai.requestTimeoutMs,
    }),
    models: {
      ...(config.ai.modelFast === undefined ? {} : { fast: config.ai.modelFast }),
      ...(config.ai.modelSmart === undefined ? {} : { smart: config.ai.modelSmart }),
    },
    dailyTokenBudget: config.ai.dailyTokenBudget,
  });

  // Apply any runtime override persisted from a previous session, so a provider
  // configured from Discord is still in effect after a restart.
  const persistedAi = await aiSettings.get();
  aiGateway.reconfigure({
    baseUrl: persistedAi.baseUrl,
    ...(persistedAi.apiKey === undefined ? {} : { apiKey: persistedAi.apiKey }),
    ...(persistedAi.modelFast === undefined ? {} : { modelFast: persistedAi.modelFast }),
    ...(persistedAi.modelSmart === undefined ? {} : { modelSmart: persistedAi.modelSmart }),
    dailyTokenBudget: persistedAi.dailyTokenBudget,
    timeoutMs: persistedAi.requestTimeoutMs,
  });

  const aiRegistry = new AiToolRegistry(logger);
  for (const tool of AI_TOOLS) {
    aiRegistry.register(tool);
  }

  /**
   * Guild-scoped AI memory, gated per guild by `ai.memoryEnabled`. One service,
   * but every read/write checks the guild's live configuration, so a server that
   * toggles memory off stops being read or written immediately.
   */
  const aiMemory = new AiMemoryService({
    logger,
    repository: new PrismaAiGuildMemoryRepository(database.prisma),
    enabled: (guildId) => guildConfig.get(guildId).then((config) => config.ai.memoryEnabled),
  });

  /**
   * Builds the keyword agent for one guild invocation.
   *
   * The agent is guild-bound like every other module context: it holds the
   * guild's `DiscordAiActions` adapter (and through it, the guild's moderation
   * service), so an agent constructed for guild A can never act on guild B.
   */
  const createAiAgent = (guild: Guild, scopeLogger: Logger): AiAgentService => {
    const moderation = createModerationContext(guild, scopeLogger).service;
    // Ticket operations are wired through the same guild-bound factory the
    // `/ticket` command and the ticket buttons use, so the agent cannot claim,
    // close or delete a ticket through any rule of its own.
    const tickets = new TicketAiActions(createTicketService(guild, scopeLogger), guild.id);
    const actions = new DiscordAiActions(guild, moderation, tickets);
    return new AiAgentService({
      logger: scopeLogger,
      gateway: aiGateway,
      permissions,
      authorization,
      audit,
      actions,
      registry: aiRegistry,
    });
  };

  const container = new ServiceContainer();

  /**
   * Slash-command deployment.
   *
   * Constructed once and shared: the `clientReady` handler deploys on boot, the
   * `guildCreate` handler deploys into a new server, and `/admin deploy` can force
   * a deployment on demand. One service means one payload, one fingerprint and one
   * definition of "deployed", so the automatic path and the manual path can never
   * disagree about what a server should have.
   */
  const deployment = new CommandDeploymentService({
    token: config.discord.token,
    clientId: config.discord.clientId,
    devGuildId: config.discord.devGuildId,
    // The configured scope is authoritative; the development guild is only a
    // fallback. Without this, a developer guild left set in `.env` would confine
    // every deployment to that one server and no real server would ever receive
    // its commands.
    scope: config.discord.deployScope,
    registry,
    repository: new PrismaCommandDeploymentRepository(database),
    logger,
  });

  /**
   * Process control: the one way `/stop` and `/restart` can touch this process.
   *
   * It is created before the services object because the commands reach it through
   * that object, and it is wired to the *same* teardown the SIGTERM path uses, so a
   * command cannot invent a second shutdown that skips `client.destroy()`.
   *
   * `container` is referenced lazily inside the callbacks: the container exists by
   * construction above, but a process-control request can only arrive after
   * `container.set(services)`, which is what makes the late read safe rather than
   * clever.
   */
  const processControl = new ProcessControlService({
    logger,
    startedAt,
    shutdown: async (reason) => {
      logger.info("Shutting down", { reason });
      await shutdownResources({ client, container, logger });
    },
    exit: (code) => {
      process.exit(code);
    },
  });

  /**
   * V9: the repository monitor.
   *
   * Built once per process, because it watches a *deployment-wide* repository
   * rather than a guild's data. The probe is the only component that knows the
   * GitHub endpoints; the service owns the history and the event rules; the report
   * adapter owns Discord. Wiring them here — and not inside the module — keeps the
   * module free of the client and the container free of GitHub specifics.
   */
  const githubClient = new GitHubClient({
    ...(config.repository.token === undefined ? {} : { token: config.repository.token }),
  });
  const [repositoryOwner = "", repositoryName = ""] = config.repository.fullName.split("/");
  const repositoryProbe = new RepositoryProbe({
    client: githubClient,
    target: { owner: repositoryOwner, repo: repositoryName, branch: undefined },
  });

  const repositoryMonitor: RepositoryMonitorService = new RepositoryMonitorService({
    repository: new PrismaRepositoryMonitorRepository(database.prisma),
    probe: repositoryProbe,
    // A function, not the adapter: the adapter is built on the next line and reads
    // the monitor's own history. Calling through a closure keeps the two
    // constructions acyclic and the dependency visible at the call site.
    report: {
      publish: (reading, previous, events) =>
        repositoryReport.publish(reading, previous, events),
    },
    logger,
    // The cadence, so retention follows it. The count is fixed, so the *hours* it buys
    // depend on how often the monitor runs — at an hourly cadence the same count is
    // forty days, and at fifteen minutes it is ten. Passing the interval is what keeps
    // the kept history covering the report's longest range either way.
    intervalMinutes: config.repository.intervalMinutes,
  });

  const repositoryReport: DiscordRepositoryReport = new DiscordRepositoryReport({
    client,
    logger,
    channelId: config.repository.reportChannelId,
    history: () => repositoryMonitor.history(),
  });

  const repositoryRefresher = new RepositoryRefresher({
    scheduler,
    monitor: repositoryMonitor,
    intervalMinutes: config.repository.intervalMinutes,
    // `scheduled_tasks.guildId` is a foreign key, so the job is filed under a guild
    // the bot is actually in. The lowest guild ID is chosen, not "whichever is
    // first in the cache": cache order follows `GUILD_CREATE`, which is not stable
    // between restarts, and a different guild each boot would file a second row.
    resolveGuildId: () => [...client.guilds.cache.keys()].sort()[0] ?? null,
  });
  taskRegistry.register(repositoryRefresher.handler());

  /**
   * Schedules the refresh for a process-wide job.
   *
   * `scheduled_tasks.guildId` is a foreign key and the job belongs to no server, so
   * it is filed under the lowest guild the bot can see (see `resolveGuildId`).
   * With no guild there is no valid row: the monitor then keeps recording nothing
   * rather than registering a task the scheduler would reject.
   *
   * The first run is one minute out, not one interval out, so a restart does not
   * leave an hour-long hole in the history.
   */
  const startRepositoryMonitor = async (): Promise<void> => {
    if (client.guilds.cache.size === 0) {
      logger.warn("The repository monitor is idle: the bot is not in any guild yet", {
        repository: config.repository.fullName,
      });
      return;
    }
    if (!(await repositoryRefresher.ensureScheduled(60))) {
      logger.warn("The repository monitor was not scheduled: no guild to file the job under", {
        repository: config.repository.fullName,
      });
      return;
    }
    logger.info("Repository monitor scheduled", {
      repository: config.repository.fullName,
      intervalMinutes: config.repository.intervalMinutes,
      reportChannelId: config.repository.reportChannelId,
    });
  };

  const services = {
    config,
    logger,
    client,
    database,
    guildConfig,
    permissions,
    authorization,
    maintenance,
    permissionClasses,
    audit,
    diagnostics,
    setup,
    commands: registry,
    setupResources: SETUP_RESOURCES,
    // Built once above so commands and `SetupService.repair()` share one path.
    createSetupContext,
    // Built once as well: moderation commands all take the same construction path.
    createModerationContext,
    // V5 follows the same rule: one construction path per module, shared by the
    // commands, the event handlers and any future scheduler.
    createAutomodContext,
    createSecurityContext,
    createBackupService,
    // V6: tickets, built the same way — one path, per invocation, guild-bound.
    createTicketContext,
    /**
     * Guild-resolving accessors for the event handlers.
     *
     * The events receive a guild (a message, a member) but not a container slot per
     * guild, so these resolve and cache the guild-bound service. They return `null`
     * for a guild the bot has left, which the handlers treat as "nothing to judge".
     */
    automodForGuild: (guildId: string) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? automodFor(guild) : null;
    },
    securityForGuild: (guildId: string) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? securityFor(guild) : null;
    },
    backupForGuild: (guildId: string, scopeLogger: Logger) => {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        return null;
      }
      const cached = backupByGuild.get(guildId);
      if (cached) {
        return cached;
      }
      const service = createBackupService(guild, scopeLogger);
      backupByGuild.set(guildId, service);
      return service;
    },
    automodDeleteTriggers: async (guildId: string) => {
      const config = await guildConfig.get(guildId);
      return config.automod.enabled && config.automod.deleteTriggerMessages;
    },
    /** The security log sink, so a lockout can also announce itself in Discord. */
    securityLog,
    /** Records joins, leaves, deletes, edits, role and channel changes. */
    guildLog,
    /**
     * Slash-command deployment, shared by boot, `guildCreate` and `/admin deploy`.
     *
     * Exposed on the container so an event or command triggers a deployment
     * through the same service the script uses, rather than re-implementing the
     * REST call.
     */
    deployment,
    /**
     * The unified scheduler, so an event or command can enqueue deferred work
     * through the same engine the startup path uses.
     */
    scheduler,
    /** Resolves the guild-bound role service, for commands and the expiry handler. */
    rolesForGuild: (guildId: string) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? rolesFor(guild) : null;
    },
    /** Resolves the guild-bound member onboarding service, for `guildMemberAdd`. */
    membersForGuild: (guildId: string) => {
      const guild = client.guilds.cache.get(guildId);
      return guild ? membersFor(guild) : null;
    },
    /**
     * Resolves the guild-bound reminder service, for `/reminder` and the bump detector.
     * Takes the guild rather than an id because both callers already hold one.
     */
    remindersForGuild: (guild: Guild) =>
      client.guilds.cache.has(guild.id) ? remindersFor(guild) : null,
    /** The sweeper, so `guildCreate` can schedule it for a newly joined server. */
    moderationSweeper,
    /** V9: the GitHub repository monitor, shared by the task and `/github`. */
    repositoryMonitor,
    /** Schedules the hourly refresh once the scheduler is running. */
    startRepositoryMonitor,
    /** Process-wide AI gateway; unconfigured when no provider is set. */
    ai: aiGateway,
    /** Global provider settings, editable at runtime by the owner. */
    aiSettings,
    /** Guild-scoped AI memory service. */
    aiMemory,
    /** Builds the keyword agent for a guild invocation. */
    createAiAgent,
    /** The shared tool registry, for building the active menu in events. */
    aiRegistry,
    /** Process control for `/stop` and `/restart`. */
    process: processControl,
    /** Guild leaving for `/leave`, with the reply-flush grace period built in. */
    guildLeave: new GuildLeaveService({ logger }),
    startedAt,
  };
  container.set(services);

  // The registry is shared with the client *before* events are registered, so
  // handlers can read `client.commands` from the very first invocation. Without
  // this, `client.commands` is undefined at runtime (the type augmentation only
  // describes the shape, it does not create the property).
  registry.applyToClient(client);

  const stop = (reason: string): Promise<void> => {
    logger.info("Shutting down", { reason });
    return shutdownResources({ client, container, logger });
  };

  const application: Application = {
    container,
    client,
    logger,
    stop,
    start: async () => {
      const commandReport = await loadAndRegisterCommands(registry, {
        directory: modulesDirectory("commands"),
        logger,
      });
      logger.info(`Loaded ${commandReport.commands.length} command(s)`, {
        skipped: commandReport.skipped.length,
      });

      const eventReport = await registerEvents(client, {
        directory: modulesDirectory("events"),
        logger,
        services,
      });
      logger.info(`Loaded ${eventReport.events.length} event(s)`);

      // `ready` opens the database connection; login failures are fatal.
      await client.login(config.discord.token);
      logger.info("Discord login request accepted");
    },
  };

  return application;
}

/**
 * Releases Discord and database resources.
 *
 * Extracted so it can be reused by signal handling and startup-failure paths
 * without capturing a method reference.
 */
async function shutdownResources(resources: {
  client: BotClient;
  container: ServiceContainer;
  logger: Logger;
}): Promise<void> {
  const { client, container, logger } = resources;
  try {
    // The scheduler is stopped first: its interval would otherwise keep firing
    // during teardown, dispatching work against a database that is being closed.
    if (container.isInitialised) {
      container.get().scheduler.stop();
    }
    if (client.isReady()) {
      await client.destroy();
    }
    await container.shutdown();
    logger.info("Shutdown complete");
  } catch (error) {
    logger.error("Error during shutdown", error);
    process.exitCode = 1;
  }
}
/** Narrowing wrapper: V2 manages categories and text channels only. */
async function channelTypeSafe(
  lookup: Promise<GuildBasedChannel | null>,
): Promise<CategoryChannel | TextChannel | null> {
  const channel = await lookup;
  if (
    channel === null ||
    (channel.type !== ChannelType.GuildCategory && channel.type !== ChannelType.GuildText)
  ) {
    return null;
  }
  return channel;
}

/** Looks up a text channel by name inside the expected parent category. */
function findTextChannelByName(
  setuper: DiscordSetuper,
  name: string,
  parentId: string | null,
): Promise<TextChannel | null> {
  return setuper.findTextChannelByName(name, parentId);
}

/**
 * Creates the channel described by a registry entry through the Setuper.
 *
 * Keeps channel creation in one place (`DiscordSetuper`) so the resource service
 * only deals with identity, and so tests can substitute a fake setuper.
 */
function createChannelFromDefinition(
  setuper: DiscordSetuper,
  definition: SetupResourceDefinition,
  parentId: string | null,
): Promise<CategoryChannel | TextChannel> {
  if (definition.type === "CATEGORY") {
    return setuper
      .ensureCategory({ name: definition.name, reason: DEFAULT_SETUP_REASON })
      .then((result) => result.resource);
  }

  if (definition.type !== "TEXT_CHANNEL") {
    throw new ValidationError(`Unsupported setup channel type: ${definition.type}`, {
      key: definition.key,
    });
  }

  return setuper
    .ensureTextChannel({
      name: definition.name,
      parentId,
      ...(definition.topic === undefined ? {} : { topic: definition.topic }),
      reason: DEFAULT_SETUP_REASON,
    })
    .then((result) => result.resource);
}

const DEFAULT_SETUP_REASON = "Automatic server setup";

/** Entry point used by `src/index.ts` and by tests. */
export async function main(): Promise<void> {
  let application: Application;

  try {
    application = await createApplication();
  } catch (error) {
    // Configuration failures must be loud, actionable and secret-free.
    process.stderr.write(`[FATAL] Startup failed\n${formatError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const logger: Logger = application.logger;
  const shutdown = (reason: string): Promise<void> => {
    return application.stop(reason);
  };

  let stopping = false;

  const handleStop = (reason: string): void => {
    if (stopping) {
      logger.warn("Second shutdown request received; forcing exit", { reason });
      process.exit(1);
    }
    stopping = true;
    void shutdown(reason).then(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    handleStop("SIGINT");
  });
  process.on("SIGTERM", () => {
    handleStop("SIGTERM");
  });

  // Windows cannot deliver SIGTERM to a detached process, so the Windows
  // launcher and the deployment script request a graceful stop through a file.
  // Registered before `start()` so a stop during a slow boot is still orderly.
  watchStopRequest({ onStop: () => handleStop("stop-request") });

  // `/restart` writes this marker before it shuts down. Removing it here is what
  // keeps the *next* boot honest: a marker left behind would make the following
  // manual stop look like a restart request. The supervisor removes its own copy
  // too — whichever runs first wins, and both tolerate the file being gone.
  clearRestartRequest();

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error);
    // A deliberate `/restart` exits through the same teardown; if something throws
    // while it runs, this handler must not turn the restart into a plain crash with
    // a success exit code. The marker is authoritative: it says the process must
    // come back, so the exit code says so as well.
    const restarting = isRestartRequested();
    void shutdown("uncaughtException").then(() => {
      process.exit(restarting ? RESTART_EXIT_CODE : 1);
    });
  });

  try {
    await application.start();
  } catch (error) {
    logger.error("Failed to start the application", error);
    await shutdown("startupFailure");
    process.exitCode = 1;
  }
}
