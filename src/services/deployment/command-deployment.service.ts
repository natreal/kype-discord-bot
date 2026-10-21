/**
 * Slash-command deployment.
 *
 * This is the single implementation of "publish the command payload to Discord".
 * It exists because deployment used to live in `scripts/deploy-commands.ts`, which
 * is correct for one server and wrong for a bot distributed to many: a server
 * that installs the bot never got its commands unless somebody remembered to run
 * a script, and nothing told anyone when a server was missing them.
 *
 * The rule the service follows is that a deployment must be *safe to repeat*:
 *
 * - **Idempotent.** A guild is only redeployed when the payload fingerprint it
 *   last received differs from the one being published, so booting a bot in a
 *   thousand servers does not produce a thousand pointless API calls.
 * - **Self-healing.** On startup it asks Discord which guilds actually have the
 *   commands and fills in whatever is missing, so a deployment that failed while
 *   the bot was offline — or a server the bot was added to while it was down — is
 *   repaired without an operator doing anything.
 * - **Non-fatal.** Every failure is logged and recorded, never thrown: a Discord
 *   outage must not stop the bot from starting, and one failing guild must not
 *   stop the others. The report tells the truth about what happened.
 * - **Bounded.** Deployments run with limited concurrency and retry only what
 *   Discord says is retryable (rate limits, transient 5xx). A guild that keeps
 *   failing is reported, not retried forever.
 *
 * The service holds no guild and no client: it is constructed once and receives
 * the guilds it should act on, which keeps the same `AppServices` container and
 * the same testability rules as the rest of the project.
 */
import { createHash } from "node:crypto";

import { REST, Routes, type RESTPutAPIApplicationCommandsJSONBody } from "discord.js";

import type { Logger } from "../logger/index.js";
import type { CommandRegistry } from "../../commands/command.registry.js";
import type { Command } from "../../commands/command.types.js";
import type {
  CommandDeploymentRecord,
  CommandDeploymentRepository,
  DeploymentSource,
} from "./command-deploy.repository.js";
import { AppError } from "../../utils/errors.js";

/** Scopes a deployment can target. Mirrors `DEPLOY_SCOPES` in the env schema. */
export type DeployScope = "global" | "global+guilds" | "dev-guild";

/** A guild a deployment can address, as seen by the client cache. */
export interface DeployableGuild {
  readonly id: string;
  readonly name: string;
}

export interface CommandDeploymentOptions {
  readonly token: string;
  readonly clientId: string;
  readonly devGuildId?: string | undefined;
  /**
   * The scope to publish to when no scope is passed to `deploy()`.
   *
   * Supplied by the bootstrap from `COMMANDS_DEPLOY_SCOPE`, which makes the
   * operator's configured value authoritative. When omitted (scripted callers,
   * tests) the scope falls back to the development guild, if one is set.
   */
  readonly scope?: DeployScope | undefined;
  readonly registry: CommandRegistry;
  readonly repository: CommandDeploymentRepository;
  readonly logger: Logger;
  /** How many guilds are deployed to at the same time. Defaults to 4. */
  readonly concurrency?: number;
  /** Retry attempts after a retryable failure. Defaults to 2 retries. */
  readonly maxRetries?: number;
  /** Base backoff in milliseconds; doubled per attempt. Defaults to 500. */
  readonly retryBaseMs?: number;
  /**
   * Injected for tests. Defaults to a real `REST` client built from the token,
   * so the service can never be accidentally constructed without one.
   */
  readonly rest?: DeploymentRest | undefined;
}

/** The narrow slice of `REST` the service needs, so tests can supply a fake. */
export interface DeploymentRest {
  put(route: string, options: { body: RESTPutAPIApplicationCommandsJSONBody }): Promise<unknown>;
}

/** Outcome of a single guild deployment. */
export interface GuildDeploymentResult {
  readonly guildId: string;
  readonly guildName: string;
  /** True when the guild already held this payload and no API call was needed. */
  readonly skipped: boolean;
  readonly ok: boolean;
  readonly commands: number;
  readonly attempts: number;
  readonly reason?: string;
}

/** Outcome of a whole deployment run. */
export interface DeploymentReport {
  /** `null` when the run did not include the global scope. */
  readonly global: { ok: boolean; commands: number; reason?: string } | null;
  readonly guilds: readonly GuildDeploymentResult[];
  /** Guilds that were already up to date. */
  readonly skipped: number;
  readonly deployed: number;
  readonly failed: GuildDeploymentResult[];
  readonly durationMs: number;
  /** The fingerprint of the payload this run published. */
  readonly fingerprint: string;
  readonly commands: number;
}

/** Reasons a deployment did not complete; `null` on success. */
export interface VerifyResult {
  readonly missing: readonly string[];
  readonly failed: readonly string[];
}

/**
 * What a manual deployment of one guild actually did.
 *
 * A manual `/admin deploy` is not a single API call any more: the outcome depends
 * on the scope, and on whether the guild still held copies from an earlier
 * `global+guilds` deployment. The operator-facing reply is built from this, so it
 * can state what changed instead of assuming "a PUT returned 200, therefore this
 * server is correct" — the assumption that left every command listed twice.
 */
export interface ManualDeploymentOutcome {
  /** The scope the deployment targeted. */
  readonly scope: DeployScope;
  /**
   * `register` — the guild received the payload in its own scope.
   * `global` — the payload was published application-wide instead, and the guild
   * scope is empty by design.
   * `none` — nothing was needed.
   */
  readonly action: "register" | "global" | "none";
  /** True when Discord was written to (the guild scope, or the global scope). */
  readonly ok: boolean;
  /** Number of commands published in this run. */
  readonly commands: number;
  /** True when the guild already held the payload and nothing was written. */
  readonly skipped: boolean;
  /** Guild-scoped copies removed because a global deployment must not have any. */
  readonly cleared: number;
  /** Why the deployment failed, when it did. */
  readonly reason?: string;
}

/**
 * @returns the scopes a manual deployment of one guild has to clean up.
 *
 * Whatever scope the operator configured, a guild scope that still holds a copy
 * of commands the bot also publishes globally is a duplicate in the picker, and a
 * manual deployment is exactly the moment an operator asks for that to be fixed.
 * `global` publishes application-wide, and `global+guilds` is the scope that
 * *creates* the doubling in the first place — both are cleaned. Only `dev-guild`
 * is left alone: it must never touch a guild other than the development one.
 */
export function guildScopesToClear(scope: DeployScope): DeployScope[] {
  return scope === "dev-guild" ? [] : ["global"];
}

export class CommandDeploymentService {
  private readonly options: Required<
    Pick<CommandDeploymentOptions, "concurrency" | "maxRetries" | "retryBaseMs">
  > &
    CommandDeploymentOptions;
  private readonly logger: Logger;
  private readonly rest: DeploymentRest;

  public constructor(options: CommandDeploymentOptions) {
    this.options = {
      ...options,
      concurrency: options.concurrency ?? 4,
      maxRetries: options.maxRetries ?? 2,
      retryBaseMs: options.retryBaseMs ?? 500,
    };
    this.logger = options.logger.child("deploy");
    this.rest = options.rest ?? createRest(options.token);
  }

  /**
   * @returns the payload to publish: every loaded slash command, minus the ones a
   * module explicitly held back, sorted by name so the fingerprint is stable.
   *
   * Sorting matters: two runs with the same commands must produce the same
   * fingerprint regardless of discovery order, otherwise a deployment would look
   * "changed" on every boot and redeploy every guild for nothing.
   */
  public globalBody(): RESTPutAPIApplicationCommandsJSONBody {
    return this.deployableCommands().map((command) => command.data.toJSON());
  }

  /** @returns the commands that are eligible for deployment, in a stable order. */
  public deployableCommands(): Command[] {
    return this.options.registry
      .list()
      .filter((command) => command.kind === "slash" && command.deploy)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** @returns the payload fingerprint, which is what decides a redeploy. */
  public fingerprint(): string {
    return fingerprintOf(this.globalBody());
  }

  /**
   * @returns the scope this service publishes to when none is passed explicitly.
   *
   * An explicit `scope` option always wins: `COMMANDS_DEPLOY_SCOPE` is the
   * operator's instruction and nothing may silently override it. Only when the
   * caller supplies no scope does a development guild imply `dev-guild`.
   *
   * The final fallback is `global`, not `global+guilds`. Discord treats command
   * names as unique within a scope rather than across scopes, so publishing to
   * both means every command is listed twice in every server. A default that
   * duplicates the menu is not a safe default, so only the operator may choose it.
   */
  public get scope(): DeployScope {
    if (this.options.scope) {
      return this.options.scope;
    }
    return this.options.devGuildId ? "dev-guild" : "global";
  }

  /**
   * Registers the commands application-wide.
   *
   * Global registration is the baseline every server shares: once it has
   * propagated, a server gets the commands even if nothing else in this service
   * ever reaches it. Guild registration is layered on top for speed, never as a
   * replacement, so a server can never be worse off than the global default.
   */
  public async deployGlobally(): Promise<{ ok: boolean; commands: number; reason?: string }> {
    const body = this.globalBody();
    try {
      await this.rest.put(Routes.applicationCommands(this.options.clientId), { body });
      this.logger.info("Registered global commands", { count: body.length });
      return { ok: true, commands: body.length };
    } catch (error) {
      const reason = describeError(error);
      this.logger.error("Global command registration failed", error, { reason });
      return { ok: false, commands: body.length, reason };
    }
  }

  /**
   * Deploys to one guild, unless it already holds this exact payload.
   *
   * @param force Skips the fingerprint check. Used when Discord reported the
   * commands as missing, which means the stored fingerprint cannot be trusted.
   */
  public async deployToGuild(
    guild: DeployableGuild,
    source: DeploymentSource,
    options: { force?: boolean } = {},
  ): Promise<GuildDeploymentResult> {
    const fingerprint = this.fingerprint();
    const body = this.globalBody();

    if (options.force !== true) {
      const record = await this.readRecord(guild.id);
      if (record?.fingerprint === fingerprint) {
        this.logger.debug("Guild already holds the current command payload", {
          guildId: guild.id,
          commands: record.commandCount,
        });
        return {
          guildId: guild.id,
          guildName: guild.name,
          skipped: true,
          ok: true,
          commands: record.commandCount,
          attempts: 0,
        };
      }
    }

    try {
      const attempts = await this.putWithRetry(
        Routes.applicationGuildCommands(this.options.clientId, guild.id),
        body,
      );
      await this.record(guild.id, fingerprint, body.length, source);
      this.logger.info("Registered commands in guild", {
        guildId: guild.id,
        name: guild.name,
        count: body.length,
        attempts,
      });
      return {
        guildId: guild.id,
        guildName: guild.name,
        skipped: false,
        ok: true,
        commands: body.length,
        attempts,
      };
    } catch (error) {
      const reason = describeError(error);
      // Deliberately not recorded as deployed: the next run must retry this
      // guild, and a stored fingerprint would make it look like it succeeded.
      this.logger.warn("Failed to register commands in guild", {
        guildId: guild.id,
        name: guild.name,
        reason,
      });
      return {
        guildId: guild.id,
        guildName: guild.name,
        skipped: false,
        ok: false,
        commands: 0,
        attempts: this.options.maxRetries + 1,
        reason,
      };
    }
  }

  /**
   * Deploys the configured scope for a single guild, on request.
   *
   * This is what `/admin deploy` calls, and it exists because the old behaviour —
   * "PUT the payload into this guild's scope, whatever the scope is configured to
   * be" — was wrong in the most visible way possible: under `global` the commands
   * are already published application-wide, so the extra guild-scoped copy made
   * Discord list every command twice in that server. A manual deployment now
   * honours the configured scope exactly like startup does, and repairs the
   * leftovers of the old behaviour as part of the same action.
   *
   * - `global` — publishes application-wide, then clears the guild scope.
   * - `global+guilds` — publishes to the guild *and* removes the guild copy, because
   *   that combination is the one that produces duplicates (see `scope`).
   * - `dev-guild` — publishes in the development guild only.
   */
  public async deployForGuild(
    guild: DeployableGuild,
    source: DeploymentSource,
    options: { force?: boolean } = {},
  ): Promise<ManualDeploymentOutcome> {
    const scope = this.scope;
    const cleared = await this.clearStaleGuildCopies(guild, guildScopesToClear(scope));

    if (scope === "global") {
      const global = await this.deployGlobally();
      return {
        scope,
        action: "global",
        ok: global.ok,
        commands: global.ok ? this.globalBody().length : 0,
        // "Skipped" means nothing was written *for this guild*, which is the truth
        // under a global scope: the registration that serves it is application-wide.
        skipped: true,
        cleared,
        ...(global.reason === undefined ? {} : { reason: global.reason }),
      };
    }

    const target =
      scope === "dev-guild" && this.options.devGuildId ? this.options.devGuildId : guild.id;
    const result = await this.deployToGuild({ id: target, name: guild.name }, source, options);
    return {
      scope,
      action: result.ok ? "register" : "none",
      ok: result.ok,
      commands: result.commands,
      skipped: result.skipped,
      cleared,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  /**
   * Clears a guild's command scope when a deployment scope says it must be empty.
   *
   * Bounded and honest: a guild that is already clean costs one GET, and a clear
   * that fails is reported (`"skipped"`) rather than retried, because the reason is
   * almost always a permission problem the operator needs to see.
   */
  private async clearStaleGuildCopies(
    guild: DeployableGuild,
    scopes: readonly DeployScope[],
  ): Promise<number> {
    if (!scopes.includes("global")) {
      return 0;
    }
    try {
      const existing = await this.fetchGuildCommands(guild.id);
      if (existing.length === 0) {
        return 0;
      }
      this.logger.warn("Clearing guild-scoped command copies that duplicate the global scope", {
        guildId: guild.id,
        name: guild.name,
        count: existing.length,
        impact: "These copies made every command appear twice in this server.",
      });
      const result = await this.clearGuildScope(guild.id);
      return result.ok ? existing.length : 0;
    } catch (error) {
      this.logger.warn("Could not inspect the guild command scope", {
        guildId: guild.id,
        reason: describeError(error),
      });
      return 0;
    }
  }

  /**
   * Deploys to every supplied guild.
   *
   * Concurrency is bounded on purpose: Discord rate limits per route, and a burst
   * of simultaneous PUTs to a thousand guilds is a rate limit waiting to happen.
   * Results are always returned — never thrown — so a caller can log the truth and
   * carry on.
   */
  public async deployToGuilds(
    guilds: readonly DeployableGuild[],
    source: DeploymentSource,
    options: { force?: boolean } = {},
  ): Promise<GuildDeploymentResult[]> {
    const startedAt = performance.now();
    const results: GuildDeploymentResult[] = [];
    const queue = [...guilds];

    const workers = Array.from({ length: Math.min(this.options.concurrency, queue.length) }, () =>
      this.drain(queue, results, source, options),
    );
    await Promise.all(workers);

    const failed = results.filter((result) => !result.ok).length;
    this.logger.info("Guild command deployment finished", {
      guilds: results.length,
      deployed: results.filter((result) => !result.skipped && result.ok).length,
      skipped: results.filter((result) => result.skipped).length,
      failed,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return results;
  }

  /**
   * Deploys to every guild the bot can see on the given scope.
   *
   * `global` deploys application-wide only; every other scope keeps the global
   * registration *and* fills in each guild, because a server that just installed
   * the bot must not wait up to an hour for the global scope to propagate.
   */
  public async deploy(
    guilds: readonly DeployableGuild[],
    scope: DeployScope,
    source: DeploymentSource,
  ): Promise<DeploymentReport> {
    const startedAt = performance.now();
    const fingerprint = this.fingerprint();
    const commands = this.globalBody().length;

    if (scope === "dev-guild") {
      return this.deployDevGuild(guilds, source, fingerprint, commands, startedAt);
    }

    const global = await this.deployGlobally();

    // The global registration just changed what every guild *should* have. Marking
    // the stale records dirty here is what keeps the next run honest: it re-checks
    // rather than trusting a fingerprint recorded before the global change.
    if (global.ok && scope === "global") {
      const pruned = await this.pruneRecords(guilds);
      if (pruned > 0) {
        this.logger.debug("Marked guild deployment records for refresh", { pruned });
      }
    }

    const guildResults = scope === "global" ? [] : await this.deployToGuilds(guilds, source);
    return this.buildReport(global, guildResults, fingerprint, commands, startedAt);
  }

  /**
   * Removes guild-scoped commands from every guild for a global-only deployment.
   *
   * `global` means the guild scope must be *empty*, and an empty scope is an
   * invariant that has to be enforced rather than assumed. Discord keeps the two
   * scopes independent and never deduplicates them, so any guild that still holds
   * a copy lists every command twice; a deployment that merely stops *writing*
   * guild copies (as switching the scope to `global` does) leaves every existing
   * one in place, and a repair pass that reads the guild scope will even recreate
   * them. Reconciling keeps the two consistent with each other instead of trusting
   * that older state has already been cleaned up.
   *
   * Clearing is scoped to this application's own commands, and a guild that is
   * already clean is skipped without a write.
   *
   * @returns the number of guilds whose stale guild scope was cleared, and the
   * guilds where the attempt failed.
   */
  public async reconcileGlobalScope(
    guilds: readonly DeployableGuild[],
  ): Promise<{ cleared: number; failed: readonly string[] }> {
    const startedAt = performance.now();
    const failed: string[] = [];
    let cleared = 0;

    for (const guild of guilds) {
      try {
        const existing = await this.fetchGuildCommands(guild.id);
        if (existing.length === 0) {
          continue;
        }
        this.logger.warn(
          "Guild holds guild-scoped commands; clearing them for a global deployment",
          {
            guildId: guild.id,
            name: guild.name,
            count: existing.length,
            impact:
              "Guild and global scopes are not deduplicated, so these commands were listed twice in this server.",
          },
        );
        const result = await this.clearGuildScope(guild.id);
        if (result.ok) {
          cleared += 1;
        } else {
          failed.push(`${guild.name} (${guild.id}): ${result.reason ?? "clear failed"}`);
        }
      } catch (error) {
        failed.push(`${guild.name} (${guild.id}): ${describeError(error)}`);
      }
    }

    if (cleared > 0 || failed.length > 0) {
      this.logger.info("Reconciled guild command scopes against the global scope", {
        cleared,
        failed: failed.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }

    return { cleared, failed };
  }

  /** Registers commands in the development guild only. */
  private async deployDevGuild(
    guilds: readonly DeployableGuild[],
    source: DeploymentSource,
    fingerprint: string,
    commands: number,
    startedAt: number,
  ): Promise<DeploymentReport> {
    const devGuildId = this.options.devGuildId;
    if (!devGuildId) {
      this.logger.warn("Deployment scope is dev-guild but DISCORD_DEV_GUILD_ID is not set");
      return this.buildReport(null, [], fingerprint, commands, startedAt);
    }

    const target = guilds.find((guild) => guild.id === devGuildId) ?? {
      id: devGuildId,
      name: devGuildId,
    };
    const results = await this.deployToGuilds([target], source);
    return this.buildReport(null, results, fingerprint, commands, startedAt);
  }

  /**
   * Asks Discord what a guild actually has, and reports what is missing.
   *
   * A stored fingerprint only says what *we* did, not what Discord currently
   * holds: a command removed by hand in server settings, a deployment that was
   * rolled back, or a guild the bot was re-invited to all leave the record
   * looking healthy. Verification is therefore a real read of the live scope, and
   * it is the piece that makes "automatic" trustworthy rather than merely
   * frequent.
   */
  public async verifyGuild(guildId: string): Promise<VerifyResult> {
    const expected = new Set(this.globalBody().map((command) => command.name));
    try {
      const existing = await this.fetchGuildCommands(guildId);
      const present = new Set(existing.map((command) => command.name));
      const missing = [...expected].filter((name) => !present.has(name));
      return { missing: missing.sort(), failed: [] };
    } catch (error) {
      return { missing: [], failed: [describeError(error)] };
    }
  }

  /**
   * Verifies several guilds and repairs the ones that are behind.
   *
   * The scope decides *which* scope the guilds are checked against, and this is
   * not cosmetic: under `global` the guild scope is supposed to be empty, so
   * checking it would report every command as missing on every healthy server and
   * then "repair" it by writing the global payload back into each guild — which
   * recreates the guild-scoped copies and makes the command picker list everything
   * twice again. Repair therefore follows the same scope as deployment, and a
   * global deployment is verified globally, once, instead of per guild.
   *
   * @returns the guilds that were still incomplete after the repair attempt, so
   * the caller can tell the operator exactly which servers need attention instead
   * of hoping the deployment worked.
   */
  public async verifyAndRepair(
    guilds: readonly DeployableGuild[],
    scope: DeployScope = "global+guilds",
  ): Promise<{ repaired: number; incomplete: readonly string[] }> {
    const startedAt = performance.now();
    const incomplete: string[] = [];
    let repaired = 0;

    // Under `global` the guild scope must stay empty: there is nothing per-guild
    // to verify or repair, and the global registration is checked instead.
    if (scope === "global") {
      const globalCheck = await this.verifyGlobal();
      if (globalCheck.failed.length > 0) {
        incomplete.push(`global scope: ${globalCheck.failed.join(", ")}`);
      } else if (globalCheck.missing.length > 0) {
        incomplete.push(`global scope: missing ${globalCheck.missing.join(", ")}`);
      }
      this.logger.debug("Verified global command scope", {
        checked: globalCheck.missing.length === 0 && globalCheck.failed.length === 0,
        commands: this.globalBody().length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { repaired, incomplete };
    }

    for (const guild of guilds) {
      const verification = await this.verifyGuild(guild.id);
      if (verification.failed.length > 0) {
        incomplete.push(`${guild.name} (${guild.id}): ${verification.failed.join(", ")}`);
        continue;
      }
      if (verification.missing.length === 0) {
        continue;
      }

      this.logger.warn("Guild is missing commands; repairing", {
        guildId: guild.id,
        name: guild.name,
        missing: verification.missing,
      });

      // `force` is required: Discord disagrees with the stored fingerprint, which
      // is precisely the situation the fingerprint check would otherwise skip.
      const result = await this.deployToGuild(guild, "startup", { force: true });
      if (!result.ok) {
        incomplete.push(`${guild.name} (${guild.id}): ${result.reason ?? "deployment failed"}`);
        continue;
      }

      const after = await this.verifyGuild(guild.id);
      if (after.missing.length > 0) {
        incomplete.push(`${guild.name} (${guild.id}): missing ${after.missing.join(", ")}`);
        continue;
      }
      repaired += 1;
    }

    if (repaired > 0 || incomplete.length > 0) {
      this.logger.info("Command verification finished", {
        checked: guilds.length,
        repaired,
        incomplete: incomplete.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }

    return { repaired, incomplete };
  }

  /**
   * Asks Discord what the *global* scope actually holds, and reports what is missing.
   *
   * The counterpart to `verifyGuild` for a global-only deployment, where the guild
   * scope is deliberately empty and therefore says nothing about whether the
   * commands the bot serves are registered.
   */
  public async verifyGlobal(): Promise<VerifyResult> {
    const expected = new Set(this.globalBody().map((command) => command.name));
    try {
      const data = await this.restGet(Routes.applicationCommands(this.options.clientId));
      if (!Array.isArray(data)) {
        return { missing: [], failed: [] };
      }
      const present = new Set(
        data
          .filter(
            (entry): entry is { name: string } =>
              typeof entry === "object" &&
              entry !== null &&
              typeof (entry as { name?: unknown }).name === "string",
          )
          .map((entry) => entry.name),
      );
      const missing = [...expected].filter((name) => !present.has(name));
      return { missing: missing.sort(), failed: [] };
    } catch (error) {
      return { missing: [], failed: [describeError(error)] };
    }
  }

  /** @returns the commands Discord currently holds for a guild. */
  public fetchGuildCommands(guildId: string): Promise<{ name: string }[]> {
    return this.fetchGuildCommandsRaw(guildId);
  }

  /**
   * Clears the guild-scoped commands of one guild.
   *
   * Needed when switching a deployment from per-guild to global-only: the guild
   * and global scopes are independent and Discord does not deduplicate them, so
   * leftover guild commands would otherwise list every command a second time
   * alongside the global ones.
   */
  public async clearGuildScope(guildId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.rest.put(Routes.applicationGuildCommands(this.options.clientId, guildId), {
        body: [],
      });
      await this.removeRecord(guildId);
      this.logger.info("Cleared guild-scoped commands", { guildId });
      return { ok: true };
    } catch (error) {
      const reason = describeError(error);
      this.logger.warn("Failed to clear guild-scoped commands", { guildId, reason });
      return { ok: false, reason };
    }
  }

  /** @returns how many guilds are behind the current payload, without deploying. */
  public async guildsMissingCommands(
    guilds: readonly DeployableGuild[],
  ): Promise<readonly DeployableGuild[]> {
    const fingerprint = this.fingerprint();
    const missing: DeployableGuild[] = [];
    for (const guild of guilds) {
      const record = await this.readRecord(guild.id);
      if (record?.fingerprint !== fingerprint) {
        missing.push(guild);
      }
    }
    return missing;
  }

  /** Discards every stored deployment record (used by tooling and tests). */
  public async resetRecords(guildIds: readonly string[]): Promise<number> {
    let removed = 0;
    for (const guildId of guildIds) {
      await this.removeRecord(guildId);
      removed += 1;
    }
    return removed;
  }

  /** Pulls entries off a shared queue until it is empty. */
  private async drain(
    queue: DeployableGuild[],
    results: GuildDeploymentResult[],
    source: DeploymentSource,
    options: { force?: boolean },
  ): Promise<void> {
    for (;;) {
      const guild = queue.shift();
      if (!guild) {
        return;
      }
      results.push(await this.deployToGuild(guild, source, options));
    }
  }

  /**
   * PUTs a payload, retrying only what is worth retrying.
   *
   * Discord answers 429 with a retry window and 5xx during an incident; both are
   * worth another attempt. A 400/401/403 will fail identically forever, so
   * retrying it would only delay the report an operator needs to see.
   *
   * @returns the number of attempts made.
   */
  private async putWithRetry(
    route: string,
    body: RESTPutAPIApplicationCommandsJSONBody,
  ): Promise<number> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await this.rest.put(route, { body });
        return attempt;
      } catch (error) {
        if (attempt > this.options.maxRetries || !isRetryable(error)) {
          throw error;
        }
        const delay = this.options.retryBaseMs * 2 ** (attempt - 1);
        this.logger.debug("Retrying a command deployment", {
          route,
          attempt,
          delayMs: delay,
          reason: describeError(error),
        });
        await sleep(delay);
      }
    }
  }

  /** Reads a stored record, tolerating a database that is not reachable. */
  private async readRecord(guildId: string): Promise<CommandDeploymentRecord | null> {
    try {
      return await this.options.repository.find(guildId);
    } catch (error) {
      // Never skip a deployment because storage is unhappy: deploying twice is
      // harmless (a PUT is idempotent), while deploying never is the failure this
      // whole service exists to prevent.
      this.logger.warn("Could not read the command deployment record", {
        guildId,
        reason: describeError(error),
      });
      return null;
    }
  }

  /** Writes a record, tolerating a database that is not reachable. */
  private async record(
    guildId: string,
    fingerprint: string,
    commandCount: number,
    source: DeploymentSource,
  ): Promise<void> {
    try {
      await this.options.repository.save({ guildId, fingerprint, commandCount, source });
    } catch (error) {
      this.logger.warn("Could not store the command deployment record", {
        guildId,
        reason: describeError(error),
      });
    }
  }

  private async removeRecord(guildId: string): Promise<void> {
    try {
      await this.options.repository.remove(guildId);
    } catch (error) {
      this.logger.warn("Could not remove the command deployment record", {
        guildId,
        reason: describeError(error),
      });
    }
  }

  private async pruneRecords(guilds: readonly DeployableGuild[]): Promise<number> {
    try {
      return await this.options.repository.pruneExcept(guilds.map((guild) => guild.id));
    } catch (error) {
      this.logger.warn("Could not prune command deployment records", {
        reason: describeError(error),
      });
      return 0;
    }
  }

  /** @returns the command names Discord currently holds for a guild. */
  private async fetchGuildCommandsRaw(guildId: string): Promise<{ name: string }[]> {
    const response = await this.restGet(
      Routes.applicationGuildCommands(this.options.clientId, guildId),
    );
    if (!Array.isArray(response)) {
      return [];
    }
    return response
      .filter(
        (entry): entry is { name: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { name?: unknown }).name === "string",
      )
      .map((entry) => ({ name: entry.name }));
  }

  /** GET support, kept separate so `DeploymentRest` stays a one-method port. */
  private async restGet(route: string): Promise<unknown> {
    const getter = this.rest as DeploymentRest & {
      get?: (route: string) => Promise<unknown>;
    };
    if (typeof getter.get !== "function") {
      throw new AppError("This REST client cannot read guild commands", {
        code: "DEPLOYMENT_REST_READ_UNSUPPORTED",
      });
    }
    return getter.get(route);
  }

  /** Assembles the run report from the two halves of a deployment. */
  private buildReport(
    global: { ok: boolean; commands: number; reason?: string } | null,
    guilds: readonly GuildDeploymentResult[],
    fingerprint: string,
    commands: number,
    startedAt: number,
  ): DeploymentReport {
    const skipped = guilds.filter((result) => result.skipped).length;
    const failed = guilds.filter((result) => !result.ok);
    return {
      global,
      guilds,
      skipped,
      deployed: guilds.length - skipped - failed.length,
      failed,
      durationMs: Math.round(performance.now() - startedAt),
      fingerprint,
      commands,
    };
  }
}

/** Builds the production REST client. */
function createRest(token: string): DeploymentRest {
  const rest = new REST({ version: "10" }).setToken(token);
  return {
    put: (route, options) => rest.put(route as `/${string}`, options),
    get: (route: string) => rest.get(route as `/${string}`),
  } as DeploymentRest;
}

/**
 * @returns a stable hash of a command payload.
 *
 * SHA-256 over the canonical JSON of the payload as it is *sent*: keys sorted, so
 * a reordering of the same options is not mistaken for a change, while any real
 * edit — a description, an option name, a required flag — produces a different
 * fingerprint and therefore a redeployment.
 */
export function fingerprintOf(body: RESTPutAPIApplicationCommandsJSONBody): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex").slice(0, 32);
}

/** JSON with object keys sorted, so equal payloads hash equally. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @returns true when a failure is worth another attempt.
 *
 * Only rate limits and server-side failures qualify. Anything else — a bad token,
 * a malformed payload, a missing permission — will fail identically on the next
 * attempt, and retrying it just delays the error an operator needs to read.
 */
export function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined) {
    // A network-level failure (DNS, socket) is transient far more often than not.
    return true;
  }
  return status === 429 || status >= 500;
}

/** @returns the HTTP status carried by a Discord/REST error, when there is one. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const candidate = error as { status?: unknown; httpStatus?: unknown };
  const value = candidate.status ?? candidate.httpStatus;
  return typeof value === "number" ? value : undefined;
}

/** @returns a short, secret-free description of a failure. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = statusOf(error);
    return status === undefined ? error.message : `${error.message} (HTTP ${status})`;
  }
  return String(error);
}

/** @returns a promise resolved after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
