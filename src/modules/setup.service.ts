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
 * - auditable: every run is persisted in `setup_runs`.
 */
import type { Guild, GuildMember } from "discord.js";

import type { Logger } from "../services/logger/index.js";
import type { ConfigService, GuildConfig } from "../services/config/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { DatabaseService } from "../services/database/index.js";
import { SETUP_SECTIONS, type SetupSection } from "../services/config/index.js";
import { NotFoundError } from "../utils/errors.js";
import type { ModuleContext, BotModule, SetupAction, SetupActionResult } from "./module.types.js";
import type { SetupActionResultEntry, SetupReport, Setuper } from "./setup.types.js";

export type SetupScope = "all" | SetupSection;

export type SetuperFactory = (guild: Guild, logger: Logger) => Setuper;

export interface SetupServiceOptions {
  readonly database: DatabaseService;
  readonly config: ConfigService;
  readonly permissions: PermissionService;
  readonly logger: Logger;
  readonly modules: readonly BotModule[];
  /** Builds the idempotent resource helpers for a guild. */
  readonly createSetuper: SetuperFactory;
}

export class SetupService {
  private readonly logger: Logger;
  private readonly options: SetupServiceOptions;
  private readonly byName: ReadonlyMap<string, BotModule>;

  public constructor(options: SetupServiceOptions) {
    this.options = options;
    this.logger = options.logger.child("setup");
    this.byName = new Map(options.modules.map((module) => [module.name, module]));
  }

  /** @returns the registered modules, in registration order. */
  public get modules(): readonly BotModule[] {
    return this.options.modules;
  }

  /** Lists the sections that can be configured. */
  public sections(): readonly SetupSection[] {
    return SETUP_SECTIONS;
  }

  /**
   * Previews what a setup run would do, without touching Discord.
   *
   * This is the foundation for `/setup` confirmation prompts and dry runs.
   */
  public async plan(guild: Guild, scope: SetupScope = "all"): Promise<SetupAction[]> {
    const config = await this.options.config.get(guild.id, guild.name);
    return this.actionsFor(scope, this.buildContext(guild, config));
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
    if (member) {
      this.options.permissions.assert(member, { botPermissions: ["setup.run"] }, `setup:${scope}`);
    }

    const startedAt = performance.now();
    const config = await this.options.config.get(guild.id, guild.name);
    const context = this.buildContext(guild, config);
    const actions = this.actionsFor(scope, context);
    const entries: SetupActionResultEntry[] = [];
    const resources: { key: string; resourceId: string; created: boolean }[] = [];

    this.logger.info("Setup run started", { guildId: guild.id, scope, actions: actions.length });

    for (const action of actions) {
      const entry = await this.runAction(action, context);
      entries.push(entry);
      if (entry.resourceId) {
        resources.push({
          key: `${entry.module}.${entry.key}`,
          resourceId: entry.resourceId,
          created: entry.status === "created",
        });
      }
    }

    const report = this.buildReport(
      guild,
      scope,
      entries,
      resources,
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

    return report;
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
  private actionsFor(scope: SetupScope, context: ModuleContext): SetupAction[] {
    return this.modulesForScope(scope).flatMap((module) =>
      (module.plan?.(context) ?? []).map((action) => ({
        ...action,
        key: `${module.name}.${action.key}`,
        description: `[${module.name}] ${action.description}`,
      })),
    );
  }

  private modulesForScope(scope: SetupScope): readonly BotModule[] {
    if (scope === "all") {
      return this.options.modules;
    }
    const module = this.byName.get(scope);
    if (!module) {
      throw new NotFoundError(`No setup module registered for section "${scope}"`, { scope });
    }
    return [module];
  }

  private buildContext(guild: Guild, config: GuildConfig): ModuleContext {
    return {
      config,
      logger: this.logger.child(guild.id),
      setuper: this.options.createSetuper(guild, this.logger),
    };
  }

  private buildReport(
    guild: Guild,
    scope: SetupScope,
    results: readonly SetupActionResultEntry[],
    resources: readonly { key: string; resourceId: string; created: boolean }[],
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
    };
  }

  private async persistRun(config: GuildConfig, report: SetupReport): Promise<void> {
    const resourceMap: Record<string, string> = { ...config.setup.resources };
    for (const resource of report.resources) {
      if (resource.created) {
        resourceMap[resource.key] = resource.resourceId;
      }
    }

    const completedSections = new Set(config.setup.completedSections);
    for (const section of report.scope === "all" ? this.sections() : [report.scope]) {
      completedSections.add(section);
    }

    await this.options.config.update(report.guildId, {
      setup: {
        completedSections: [...completedSections],
        resources: resourceMap,
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
