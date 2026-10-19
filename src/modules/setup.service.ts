/**
 * Setup service.
 *
 * Orchestrates feature modules to configure a guild idempotently:
 *
 *   SetupService -> LoggingModule.setup() -> SecurityModule.setup() -> ...
 *
 * Guarantees:
 * - idempotent: existing resources are detected and reused, never duplicated;
 * - permission-aware: the caller's Discord permissions gate every run;
 * - guild-specific: all state is stored per guild;
 * - recoverable: a failing action is recorded and does not abort other modules;
 * - auditable: every run is persisted in `setup_runs` and, when a caller is
 *   known, recorded as a structured audit event.
 *
 * V3 adds `repair()` on top: the same pipeline, restricted to the resources that
 * are actually missing, so an operator can fix drift without re-running (or
 * re-creating) anything that is already correct.
 */
import type { Guild, GuildMember } from "discord.js";

import type { Logger } from "../services/logger/index.js";
import type { ConfigService, GuildConfig } from "../services/config/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { DatabaseService } from "../services/database/index.js";
import type { AuditEventService } from "../services/audit/index.js";
import type { AuthorizationService } from "../services/authorization/index.js";
import { SETUP_SECTIONS } from "../services/config/index.js";
import { NotFoundError, PermissionError } from "../utils/errors.js";
import type { SetupResourceService } from "./setup/setup-resource.service.js";
import type {
  ModuleContext,
  ModuleTicketContext,
  BotModule,
  SetupAction,
  SetupActionResult,
} from "./module.types.js";
import type {
  SetupActionResultEntry,
  SetupReport,
  SetupResourceDefinition,
  SetupResourceIdentity,
  Setuper,
} from "./setup.types.js";

/** Module name used to attribute resource identities to the setup module. */
export const SETUP_MODULE_NAME = "setup";

/**
 * Scope of a setup run.
 *
 * `all` runs every module; any other value is either a module name (`logging`) or
 * a setup section/resource key (`information`, `logs.server-logs`). Kept as
 * `string` so the command can pass whatever Discord gives it and the service
 * validates it against the registry instead of duplicating the list here.
 */
export type SetupScope = string;

export type SetuperFactory = (guild: Guild, logger: Logger) => Setuper;

/**
 * Builds the modules to run for one guild.
 *
 * V2 needs this indirection because the automatic setup module is guild-bound: it
 * holds the identity service and the tracked setuper for the guild being
 * configured. Future modules join the same list, so the orchestration stays a
 * fixed pipeline of `BotModule`s.
 */
export type SetupModuleResolver = (guild: Guild, logger: Logger) => readonly BotModule[];

export interface SetupServiceOptions {
  readonly database: DatabaseService;
  readonly config: ConfigService;
  readonly permissions: PermissionService;
  readonly logger: Logger;
  /** Static modules, used as-is when no resolver is supplied. */
  readonly modules?: readonly BotModule[];
  /** Guild-bound modules, resolved per run and prepended to the static list. */
  readonly resolveModules?: SetupModuleResolver;
  /** Builds the idempotent resource helpers for a guild. */
  readonly createSetuper: SetuperFactory;
  /**
   * Resource definitions the automatic setup module owns.
   *
   * Used only to describe the run (dry-run listing and completion tracking); the
   * module itself resolves them through the identity service.
   */
  readonly resourceDefinitions?: readonly SetupResourceDefinition[];
  /**
   * Optional audit trail. When supplied, every run records a structured event
   * alongside the `setup_runs` row (V2 behaviour, unchanged).
   */
  readonly audit?: AuditEventService;
  /**
   * Optional central authorization service.
   *
   * When supplied, the caller is authorized through the V3 pipeline (which owns
   * the God Access bypass) instead of the legacy direct `PermissionService` call.
   * Omitted in the lightweight V2 harnesses, where the legacy path still applies.
   */
  readonly authorization?: AuthorizationService;
  /**
   * Resolves the guild-bound resource identity service.
   *
   * Used by `repair()` to decide which resources are actually broken. Supplied by
   * the per-guild factory, which already builds this service for the setup module.
   */
  readonly repairResourcesFor?: (guild: Guild) => SetupResourceService;
  /**
   * Resolves the guild-bound ticket access for setup actions that seed categories.
   *
   * Omitted by default (the lightweight V2 harnesses and any process without a
   * ticket module) — the ticket module then reports "ticket service unavailable"
   * rather than failing. When supplied, the setup action receives the narrow
   * `ModuleTicketContext` port, not the full service.
   */
  readonly ticketsFor?: (guild: Guild) => ModuleTicketContext;
}

export class SetupService {
  private readonly logger: Logger;
  private readonly options: SetupServiceOptions;
  private readonly staticModules: readonly BotModule[];

  public constructor(options: SetupServiceOptions) {
    this.options = options;
    this.logger = options.logger.child("setup");
    this.staticModules = options.modules ?? [];
  }

  /** @returns the static modules, in registration order. */
  public get modules(): readonly BotModule[] {
    return this.staticModules;
  }

  /** @returns the sections that can be configured. */
  public sections(): readonly string[] {
    return SETUP_SECTIONS;
  }

  /**
   * @returns the modules to execute for a guild: guild-bound modules first, then
   * the static ones, so the structural setup runs before feature modules that
   * depend on those categories and channels.
   */
  public modulesFor(guild: Guild): readonly BotModule[] {
    const resolved = this.options.resolveModules?.(guild, this.logger) ?? [];
    return [...resolved, ...this.staticModules];
  }

  /** @returns the resource definitions setup owns, when provided. */
  public resourceDefinitions(): readonly SetupResourceDefinition[] {
    return this.options.resourceDefinitions ?? [];
  }

  /**
   * Previews what a setup run would do, without touching Discord.
   *
   * This is the foundation for `/setup` confirmation prompts and dry runs.
   */
  public async plan(guild: Guild, scope: SetupScope = "all"): Promise<SetupAction[]> {
    const config = await this.options.config.get(guild.id, guild.name);
    return this.actionsFor(scope, this.buildContext(guild, config), this.modulesFor(guild));
  }

  /**
   * Runs setup for a guild.
   *
   * @param member Caller, checked against `setup.run`; omit for automatic runs
   *               triggered by the bot itself (e.g. `guildCreate`).
   */
  public async run(
    guild: Guild,
    scope: SetupScope = "all",
    member?: GuildMember,
  ): Promise<SetupReport> {
    // Authorization goes through the central V3 service when it is available, so
    // the God Access bypass has exactly one implementation. The legacy path is
    // kept for the lightweight V2 harnesses that do not construct an
    // AuthorizationService.
    const godAccess = await this.authorizeSetup(member, `setup:${scope}`);

    const startedAt = performance.now();
    const config = await this.options.config.get(guild.id, guild.name);
    const context = this.buildContext(guild, config);
    const actions = this.actionsFor(scope, context, this.modulesFor(guild));
    const entries: SetupActionResultEntry[] = [];
    const resources: { key: string; resourceId: string; created: boolean }[] = [];
    const setupResources: SetupResourceIdentity[] = [];

    this.logger.info("Setup run started", {
      guildId: guild.id,
      scope,
      actions: actions.length,
      godAccess,
    });

    for (const action of actions) {
      const entry = await this.runAction(action, context);
      entries.push(entry);
      if (entry.resourceId) {
        const key = `${entry.module}.${entry.key}`;
        resources.push({
          key,
          resourceId: entry.resourceId,
          created: entry.status === "created",
        });
        // Only the automatic setup module owns tracked resource identities; the
        // V1 feature modules keep using their own configuration keys.
        if (entry.module === SETUP_MODULE_NAME) {
          setupResources.push({
            // The bare resource key, as stored in `setup_resources`: the module
            // prefix is an orchestration detail and must not leak into identity.
            key: stripModule(entry.key),
            resourceId: entry.resourceId,
            created: entry.status === "created",
            recovered: entry.status === "updated",
          });
        }
      }
    }

    const report = this.buildReport(
      guild,
      scope,
      entries,
      resources,
      setupResources,
      performance.now() - startedAt,
    );
    await this.persistRun(config, report);
    this.logger.info("Setup run finished", {
      guildId: guild.id,
      scope,
      status: report.status,
      created: report.created,
      reused: report.reused,
      failed: report.failed,
    });
    await this.recordAudit(guild, "setup.run", report, member);

    return report;
  }

  /**
   * Repairs the resources that are missing or broken.
   *
   * Reuses the V2 recovery/adoption behavior instead of recreating everything:
   * the run is scoped to resources whose identity is known to be stale, and
   * anything already correct is left completely untouched (no `updated` entry, no
   * permission rewrite). Idempotent: a second repair with nothing missing is a
   * no-op.
   *
   * @param keys Restrict the repair to these resource keys. When omitted, the
   *             identity table is read and only the repairable keys are used.
   */
  public async repair(
    guild: Guild,
    keys?: readonly string[],
    member?: GuildMember,
  ): Promise<SetupReport> {
    const godAccess = await this.authorizeSetup(member, "repair");
    const targets = keys && keys.length > 0 ? [...keys] : await this.repairableKeys(guild);

    this.logger.info("Setup repair started", {
      guildId: guild.id,
      resources: targets.length,
      godAccess,
    });

    const startedAt = performance.now();
    const config = await this.options.config.get(guild.id, guild.name);
    const context = this.buildContext(guild, config);

    // A repair is a run restricted to the offending resources, so the pipeline,
    // identity rules and idempotency are exactly V2's.
    const scope = targets.length === 1 ? (targets[0] ?? "all") : "all";
    const actions = this.actionsFor(scope, context, this.modulesFor(guild)).filter((action) =>
      isActionForAny(action.key, targets),
    );

    const entries: SetupActionResultEntry[] = [];
    const resources: { key: string; resourceId: string; created: boolean }[] = [];
    const setupResources: SetupResourceIdentity[] = [];

    for (const action of actions) {
      const entry = await this.runAction(action, context);
      entries.push(entry);
      if (entry.resourceId) {
        resources.push({
          key: `${entry.module}.${entry.key}`,
          resourceId: entry.resourceId,
          created: entry.status === "created",
        });
        if (entry.module === SETUP_MODULE_NAME) {
          setupResources.push({
            key: stripModule(entry.key),
            resourceId: entry.resourceId,
            created: entry.status === "created",
            recovered: entry.status === "updated",
          });
        }
      }
    }

    const report = this.buildReport(
      guild,
      "repair",
      entries,
      resources,
      setupResources,
      performance.now() - startedAt,
    );
    await this.persistRun(config, report);

    this.logger.info("Setup repair finished", {
      guildId: guild.id,
      status: report.status,
      created: report.created,
      repaired: report.updated,
      failed: report.failed,
    });
    await this.recordAudit(guild, "setup.repair", report, member);

    return report;
  }

  /**
   * @returns the resource keys a repair would act on.
   *
   * Derived from the setup module's own identity table, so the decision is made by
   * the same code that performs the resolution.
   */
  private async repairableKeys(guild: Guild): Promise<string[]> {
    const resources = this.options.repairResourcesFor?.(guild) ?? null;
    if (!resources) {
      // Without the guild-bound identity service there is nothing to inspect, and
      // repairing "everything" would defeat the point, so nothing is repaired.
      return [];
    }

    const tracked = await resources.list();
    const stale = await resources.detectStale(tracked);
    const keys = new Set<string>(stale.map((entry) => entry.key));
    for (const record of tracked) {
      if (!record.discordId) {
        keys.add(record.key);
      }
    }
    return [...keys];
  }

  /**
   * Authorizes a setup action.
   *
   * @returns true when God Access was used, so the run is logged as privileged.
   */
  private async authorizeSetup(member: GuildMember | undefined, action: string): Promise<boolean> {
    if (!member) {
      return false;
    }

    const authorization = this.options.authorization;
    if (authorization) {
      const decision = await authorization.authorize(
        member,
        { custom: ["server.setup"] },
        `setup:${action}`,
      );
      if (!decision.allowed) {
        throw new PermissionError(decision.missing.join(", ") || "server.setup", {
          context: action,
          missing: decision.missing,
          outcome: decision.outcome,
        });
      }
      return decision.godAccess;
    }

    // Legacy path: V2 semantics, kept for harnesses that build a bare service.
    const godAccess = this.options.permissions.isGodAccess(member);
    if (godAccess) {
      this.logger.warn("Setup authorized by God Access", {
        guildId: member.guild.id,
        action,
        userId: member.id,
      });
      return true;
    }
    this.options.permissions.assert(member, { botPermissions: ["setup.run"] }, action);
    return false;
  }

  /** Records a structured audit event for a run. Best-effort. */
  private async recordAudit(
    guild: Guild,
    action: string,
    report: SetupReport,
    member: GuildMember | undefined,
  ): Promise<void> {
    if (!this.options.audit) {
      return;
    }
    const godAccess = member ? this.options.permissions.isGodAccess(member) : false;
    const severity = godAccess ? "privileged" : report.failed > 0 ? "warn" : "info";

    await this.options.audit.record({
      guildId: guild.id,
      action,
      category: "setup",
      severity,
      actorId: member?.id ?? null,
      actorKind: godAccess ? "god" : member ? "user" : "system",
      targetType: "guild",
      targetId: guild.id,
      outcome: report.status === "failed" ? "failure" : "success",
      details: {
        scope: report.scope,
        status: report.status,
        created: report.created,
        reused: report.reused,
        updated: report.updated,
        skipped: report.skipped,
        failed: report.failed,
        durationMs: report.durationMs,
        resources: report.setupResources.map((resource) => ({
          key: resource.key,
          id: resource.resourceId,
          created: resource.created,
          recovered: resource.recovered,
        })),
      },
    });
  }

  /**
   * Executes one planned action.
   *
   * The module name is carried on the action itself (`<module>.<key>`) so that
   * results are attributable even when the action throws.
   */
  private async runAction(
    action: SetupAction,
    context: ModuleContext,
  ): Promise<SetupActionResultEntry> {
    const [module = "unknown"] = action.key.split(".");
    const base = { module, key: action.key, description: action.description };

    try {
      const result: SetupActionResult = await action.run(context);
      return {
        ...base,
        status: result.status,
        ...(result.resourceId === undefined ? {} : { resourceId: result.resourceId }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    } catch (error) {
      return {
        ...base,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Collects the setup actions for a scope.
   *
   * Action keys are namespaced with the module name so that a single flat list
   * can be persisted as an audit trail.
   */
  private actionsFor(
    scope: SetupScope,
    context: ModuleContext,
    modules: readonly BotModule[],
  ): SetupAction[] {
    return this.modulesForScope(scope, modules).flatMap((module) =>
      (module.plan?.(context) ?? []).map((action) => ({
        ...action,
        key: `${module.name}.${action.key}`,
        description: `[${module.name}] ${action.description}`,
      })),
    );
  }

  /**
   * @returns the modules selected by `scope`.
   *
   * A named scope must resolve to a module; the automatic setup module also
   * accepts its own resource keys and section names (`information`, `logs`) so
   * `/setup information` works without a second command tree.
   */
  private modulesForScope(scope: SetupScope, modules: readonly BotModule[]): readonly BotModule[] {
    if (scope === "all") {
      return modules;
    }

    const module = modules.find((candidate) => candidate.name === scope);
    if (module) {
      return [module];
    }

    const definition = this.options.resourceDefinitions?.find(
      (candidate) => candidate.key === scope || sectionNameOf(candidate) === scope,
    );
    if (definition) {
      const setupModule = modules.find((candidate) => candidate.name === SETUP_MODULE_NAME);
      if (setupModule) {
        return [setupModule];
      }
    }

    throw new NotFoundError(`No setup module registered for section "${scope}"`, { scope });
  }

  private buildContext(guild: Guild, config: GuildConfig): ModuleContext {
    return {
      config,
      logger: this.logger.child(guild.id),
      setuper: this.options.createSetuper(guild, this.logger),
      ...(this.options.ticketsFor ? { tickets: this.options.ticketsFor(guild) } : {}),
    };
  }

  private buildReport(
    guild: Guild,
    scope: SetupScope,
    results: readonly SetupActionResultEntry[],
    resources: readonly { key: string; resourceId: string; created: boolean }[],
    setupResources: readonly SetupResourceIdentity[],
    durationMs: number,
  ): SetupReport {
    const count = (status: SetupActionResultEntry["status"]): number =>
      results.filter((entry) => entry.status === status).length;

    const failed = count("failed");
    const status = failed === 0 ? "completed" : failed === results.length ? "failed" : "partial";

    return {
      guildId: guild.id,
      scope,
      status,
      created: count("created"),
      reused: count("reused"),
      updated: count("updated"),
      skipped: count("skipped"),
      failed,
      durationMs: Math.round(durationMs),
      results,
      resources,
      setupResources,
    };
  }

  /**
   * Persists the run: configuration state first, then the audit row.
   *
   * The authoritative resource identity already lives in `setup_resources` (written
   * by the resource service as each resource resolves); the configuration map below
   * exists so operators and the dashboard can read the current structure without a
   * join, and so V1's `setup.resources` contract keeps working.
   */
  private async persistRun(config: GuildConfig, report: SetupReport): Promise<void> {
    const resourceMap: Record<string, string> = { ...config.setup.resources };
    for (const resource of report.setupResources) {
      if (resource.created || resource.recovered) {
        resourceMap[resource.key] = resource.resourceId;
      }
    }

    const knownKeys = new Set([
      ...config.setup.grantedResourceKeys,
      ...report.setupResources.map((resource) => resource.key),
    ]);

    const completedSections = new Set(config.setup.completedSections);
    for (const module of report.scope === "all"
      ? [...this.sections(), SETUP_MODULE_NAME]
      : [report.scope]) {
      completedSections.add(module);
    }

    await this.options.config.update(report.guildId, {
      setup: {
        completedSections: [...completedSections],
        resources: resourceMap,
        grantedResourceKeys: [...knownKeys],
        lastRunAt: new Date().toISOString(),
      },
    });

    try {
      await this.options.database.prisma.setupRun.create({
        data: {
          guildId: report.guildId,
          scope: report.scope,
          status: report.status,
          created: report.created,
          reused: report.reused,
          updated: report.updated,
          skipped: report.skipped,
          failed: report.failed,
          details: report.results.map((entry) => ({ ...entry })),
          finishedAt: new Date(),
          durationMs: report.durationMs,
        },
      });
    } catch (error) {
      // Auditing must never invalidate an otherwise successful run.
      this.logger.warn("Failed to persist setup run", {
        guildId: report.guildId,
        error: String(error),
      });
    }
  }
}

/** @returns the section (`information`, `logs`, ...) a definition belongs to. */
function sectionNameOf(definition: SetupResourceDefinition): string {
  const segment = definition.key.split(".")[0];
  return segment ?? definition.key;
}

/**
 * @returns true when an action (namespaced as `<module>.<key>`) targets one of
 * the given resource keys.
 *
 * Action keys carry the module prefix while resource keys do not, so both the
 * prefixed and the bare form are compared. That keeps `repair()` working with
 * keys supplied by an operator (`information.welcome`) as well as keys read back
 * from a setup report (`setup.information.welcome`).
 */
function isActionForAny(actionKey: string, resourceKeys: readonly string[]): boolean {
  return resourceKeys.some(
    (resourceKey) => actionKey === resourceKey || actionKey.endsWith(`.${resourceKey}`),
  );
}

/** @returns the resource key without its module prefix. */
function stripModule(actionKey: string): string {
  const [module, ...rest] = actionKey.split(".");
  return module === SETUP_MODULE_NAME && rest.length > 0 ? rest.join(".") : actionKey;
}
