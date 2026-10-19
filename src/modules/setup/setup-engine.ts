/**
 * Setup planning, validation and repair (V3).
 *
 * The V2 engine *executes* setup. V3 adds three read-mostly capabilities on top
 * of the same services rather than beside them:
 *
 *   plan()     → what would a run do? (no Discord mutation)
 *   validate() → does the guild match the expected state? (no Discord mutation)
 *   repair()   → fix only what is actually broken (idempotent mutation)
 *
 * All three drive the *existing* `SetupService` and V2 resource services, so
 * identity/adoption semantics and idempotency are inherited rather than
 * reimplemented.
 */
import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";

import type { Logger } from "../../services/logger/index.js";
import type { SetupResourceDefinition } from "../setup.types.js";
import type { SetupResourceService, StaleResource } from "./setup-resource.service.js";

/** What the engine intends to do with a single resource. */
export const SETUP_PLAN_ACTIONS = ["CREATE", "REUSE", "REPAIR", "ADOPT", "SKIP", "ERROR"] as const;

export type SetupPlanAction = (typeof SETUP_PLAN_ACTIONS)[number];

/** One resource's planned outcome. */
export interface SetupPlanEntry {
  readonly key: string;
  readonly label: string;
  readonly type: SetupResourceDefinition["type"];
  readonly action: SetupPlanAction;
  /** Why the action was chosen, in administrator-readable terms. */
  readonly reason: string;
  /** Stored Discord ID, when one is known. */
  readonly storedId: string | null;
  /** Name expected on Discord (used for adoption). */
  readonly expectedName: string;
}

/** The deterministic plan for a guild, produced without mutating Discord. */
export interface SetupPlan {
  readonly guildId: string;
  readonly entries: readonly SetupPlanEntry[];
  readonly counts: Readonly<Record<SetupPlanAction, number>>;
  /** True when the plan contains no ERROR entries. */
  readonly ok: boolean;
}

/** Outcome of validating a guild against the expected setup state. */
export interface SetupValidationEntry {
  readonly key: string;
  readonly label: string;
  readonly type: SetupResourceDefinition["type"];
  /** `ok` when the resource matches the expectation, otherwise the problem. */
  readonly status: "ok" | "missing" | "drifted" | "orphaned" | "unexpected";
  readonly detail: string;
  readonly storedId: string | null;
}

export interface SetupValidation {
  readonly guildId: string;
  readonly entries: readonly SetupValidationEntry[];
  /** Resources that `/setup repair` can fix. */
  readonly repairable: readonly string[];
  readonly ok: boolean;
}

export interface SetupEngineOptions {
  readonly logger: Logger;
  /** Defensive bound on how many guild channels may be read while planning. */
  readonly maxChannels?: number;
}

/** Default cap on channels read while planning. */
const DEFAULT_MAX_CHANNELS = 500;

export class SetupEngine {
  private readonly logger: Logger;
  private readonly maxChannels: number;

  public constructor(options: SetupEngineOptions) {
    this.logger = options.logger.child("setup-engine");
    this.maxChannels = options.maxChannels ?? DEFAULT_MAX_CHANNELS;
  }

  /**
   * Builds the plan for a guild.
   *
   * Read-only by construction: it only *looks up* resources through the identity
   * service and the guild cache. Nothing here calls a create/edit/delete API, so
   * `/setup plan` is safe to run on a live guild.
   */
  public async plan(
    guild: Guild,
    resources: SetupResourceService,
    definitions: readonly SetupResourceDefinition[],
  ): Promise<SetupPlan> {
    const tracked = await resources.list();
    const byKey = new Map(tracked.map((record) => [record.key, record]));
    const stale = await staleKeys(resources, tracked);
    const knownKeys = new Set(definitions.map((definition) => definition.key));
    const entries: SetupPlanEntry[] = [];

    for (const definition of definitions) {
      const record = byKey.get(definition.key) ?? null;
      const storedId = record?.discordId ?? null;
      const base = {
        key: definition.key,
        label: definition.label,
        type: definition.type,
        storedId,
        expectedName: definition.name,
      };

      if (definition.provisionable === false) {
        entries.push({
          ...base,
          action: "SKIP",
          reason: "Tracked only: it is created when its module is enabled.",
        });
        continue;
      }

      if (storedId === null) {
        const present = await hasLookalike(guild, definition, this.maxChannels);
        entries.push(
          present
            ? {
                ...base,
                action: "ADOPT",
                reason: `A matching resource named "${definition.name}" already exists and will be adopted instead of duplicated.`,
              }
            : {
                ...base,
                action: "CREATE",
                reason: "Not tracked yet and not present on Discord.",
              },
        );
        continue;
      }

      if (stale.has(definition.key)) {
        const present = await hasLookalike(guild, definition, this.maxChannels);
        entries.push({
          ...base,
          action: "REPAIR",
          reason: present
            ? `The stored reference (${storedId}) is gone; a replacement named "${definition.name}" exists and will be adopted.`
            : `The stored reference (${storedId}) is gone and will be recreated.`,
        });
        continue;
      }

      entries.push({ ...base, action: "REUSE", reason: `Already managed (${storedId}).` });
    }

    // A tracked key the registry no longer declares means the database and the
    // code disagree. Reported rather than silently ignored.
    for (const record of tracked) {
      if (knownKeys.has(record.key)) {
        continue;
      }
      entries.push({
        key: record.key,
        label: record.key,
        type: record.type,
        action: "ERROR",
        reason: "Tracked in the database but no longer declared by the resource registry.",
        storedId: record.discordId,
        expectedName: record.name ?? record.key,
      });
    }

    const plan: SetupPlan = {
      guildId: guild.id,
      entries,
      counts: countActions(entries),
      ok: entries.every((entry) => entry.action !== "ERROR"),
    };

    this.logger.debug("Setup plan generated", {
      guildId: guild.id,
      resources: entries.length,
      create: plan.counts.CREATE,
      repair: plan.counts.REPAIR,
    });
    return plan;
  }

  /**
   * Validates the guild against the expected state.
   *
   * Never mutates. `repairable` lists the keys `/setup repair` would act on, so
   * the operator can see the scope before authorizing the repair.
   */
  public async validate(
    guild: Guild,
    resources: SetupResourceService,
    definitions: readonly SetupResourceDefinition[],
  ): Promise<SetupValidation> {
    const tracked = await resources.list();
    const byKey = new Map(tracked.map((record) => [record.key, record]));
    const stale = await staleKeys(resources, tracked);
    const knownKeys = new Set(definitions.map((definition) => definition.key));
    const entries: SetupValidationEntry[] = [];
    const repairable: string[] = [];

    for (const definition of definitions) {
      const record = byKey.get(definition.key) ?? null;
      const base = {
        key: definition.key,
        label: definition.label,
        type: definition.type,
        storedId: record?.discordId ?? null,
      };

      if (definition.provisionable === false) {
        entries.push({
          ...base,
          status: "ok",
          detail: "Tracked only; nothing to validate until its module is enabled.",
        });
        continue;
      }

      if (!record?.discordId) {
        entries.push({ ...base, status: "missing", detail: "Not created yet." });
        repairable.push(definition.key);
        continue;
      }

      if (stale.has(definition.key)) {
        entries.push({
          ...base,
          status: "drifted",
          detail: `Stored reference ${record.discordId} no longer exists on Discord.`,
        });
        repairable.push(definition.key);
        continue;
      }

      entries.push({ ...base, status: "ok", detail: `Exists (${record.discordId}).` });
    }

    for (const record of tracked) {
      if (knownKeys.has(record.key)) {
        continue;
      }
      entries.push({
        key: record.key,
        label: record.key,
        type: record.type,
        status: "orphaned",
        detail: "Tracked but not declared by the registry.",
        storedId: record.discordId,
      });
    }

    const validation: SetupValidation = {
      guildId: guild.id,
      entries,
      repairable,
      ok: entries.every((entry) => entry.status === "ok"),
    };

    this.logger.debug("Setup validation completed", {
      guildId: guild.id,
      repairable: repairable.length,
      ok: validation.ok,
    });
    return validation;
  }
}

/** @returns the keys whose stored Discord reference no longer resolves. */
async function staleKeys(
  resources: SetupResourceService,
  tracked: readonly { key: string }[],
): Promise<ReadonlySet<string>> {
  const stale: readonly StaleResource[] = await resources.detectStale(
    tracked as Parameters<SetupResourceService["detectStale"]>[0],
  );
  return new Set(stale.map((entry) => entry.key));
}

/**
 * @returns true when a resource with the expected name already exists.
 *
 * This is a *read* used only to distinguish ADOPT from CREATE in the plan. It
 * mirrors the adoption rule the resource service applies during a real run (name
 * match inside the expected parent), so the plan does not promise something the
 * run would not do.
 */
async function hasLookalike(
  guild: Guild,
  definition: SetupResourceDefinition,
  maxChannels: number,
): Promise<boolean> {
  try {
    if (definition.type === "CATEGORY") {
      return guild.channels.cache.some(
        (channel) =>
          channel.type === ChannelType.GuildCategory &&
          normalize(channel.name) === normalize(definition.name),
      );
    }
    if (definition.type === "ROLE") {
      return guild.roles.cache.some(
        (role) => !role.managed && normalize(role.name) === normalize(definition.name),
      );
    }
    const channels = guild.channels.cache.size > 0 ? [...guild.channels.cache.values()] : [];
    if (channels.length === 0) {
      // The cache is cold (a fresh process): fall back to a bounded fetch so the
      // plan stays accurate without scanning an unbounded guild.
      const fetched = await guild.channels.fetch();
      for (const channel of [...fetched.values()].slice(0, maxChannels)) {
        if (
          channel &&
          channel.type === ChannelType.GuildText &&
          normalize(channel.name) === normalize(definition.name)
        ) {
          return true;
        }
      }
      return false;
    }
    return channels.some(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        normalize(channel.name) === normalize(definition.name),
    );
  } catch {
    // A lookup failure must not turn a plan into a lie: report no lookalike, and
    // the plan then says CREATE, which is what the run would attempt anyway.
    return false;
  }
}

/** @returns the definition name normalized the way a plan comparison needs. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Counts plan entries per action, including zeroes for every action. */
function countActions(entries: readonly SetupPlanEntry[]): Record<SetupPlanAction, number> {
  const counts: Record<SetupPlanAction, number> = {
    CREATE: 0,
    REUSE: 0,
    REPAIR: 0,
    ADOPT: 0,
    SKIP: 0,
    ERROR: 0,
  };
  for (const entry of entries) {
    counts[entry.action] += 1;
  }
  return counts;
}
