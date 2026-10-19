/**
 * Module framework.
 *
 * A "module" holds the feature logic for one area of the bot (moderation,
 * security, logging, ...). Commands are thin interfaces that delegate to module
 * services; the setup system orchestrates modules through this same contract.
 *
 * Lifecycle:
 *   enabled()  -> should this module act in the guild?
 *   plan()     -> which resources would setup create or reuse? (no writes)
 *   setup()    -> idempotently create missing resources and persist config
 */
import type { Guild } from "discord.js";

import type { GuildConfig } from "../services/config/index.js";
import type { Logger } from "../services/logger/index.js";
import type { Setuper } from "./setup.types.js";

/**
 * Guild-bound ticket access granted to modules that need it at setup time.
 *
 * A narrow port rather than the `TicketService`: setup needs to seed categories, and
 * nothing else. Handing it the whole service would let a setup action close a ticket,
 * which is not a thing setup should ever do. `null` when the running process has no
 * ticket service (a harness, or a guild whose module was not wired).
 */
export interface ModuleTicketContext {
  readonly guildId: string;
  /** Actor recorded on the audit events the seeding writes. */
  readonly actorId: string;
  findCategory(guildId: string, key: string): Promise<{ id: string } | null>;
  saveCategory(
    actorId: string,
    draft: {
      guildId: string;
      key: string;
      label: string;
      emoji?: string | null;
      description?: string | null;
      parentId?: string | null;
      staffRoleIds?: readonly string[];
      pingRoleIds?: readonly string[];
      prompt?: string | null;
      enabled?: boolean;
      position?: number;
    },
  ): Promise<{ id: string }>;
}

/** Services granted to every module. No module may create its own clients. */
export interface ModuleContext {
  readonly config: GuildConfig;
  readonly logger: Logger;
  /** Idempotent Discord resource helpers. */
  readonly setuper: Setuper;
  /** Ticket access for setup actions that seed categories, when available. */
  readonly tickets?: ModuleTicketContext;
}

/**
 * A setup action declared by a module.
 *
 * Actions are declarative so that `plan()` can report them without performing
 * any Discord writes, and `setup()` can execute them idempotently.
 */
export interface SetupAction {
  /** Stable key persisted in the guild configuration (`logging.channel`, ...). */
  readonly key: string;
  /** Human-readable description used by setup logs and the future wizard. */
  readonly description: string;
  readonly run: (context: ModuleContext) => Promise<SetupActionResult>;
}

/** Result of executing a single setup action. */
export interface SetupActionResult {
  /** Outcome of the action. `skipped` means "not required right now". */
  readonly status: "created" | "reused" | "updated" | "skipped" | "failed";
  /** Discord resource ID created or reused, if any. */
  readonly resourceId?: string;
  /** Extra detail for the setup audit log. */
  readonly detail?: string;
  /** Set when `status` is `failed`. */
  readonly error?: unknown;
}

/** Contract implemented by every feature module. */
export interface BotModule {
  /** Unique module name, e.g. `logging`. */
  readonly name: string;
  /** Short summary used by `/help` and setup output. */
  readonly description: string;
  /** Whether the module is active for this guild (from guild config). */
  enabled(context: ModuleContext): boolean;
  /** Optional: declare the setup actions for this module. */
  plan?(context: ModuleContext): SetupAction[];
  /** Optional: run module-specific startup logic after Discord is ready. */
  onReady?(guild: Guild, context: ModuleContext): Promise<void>;
}

/** Type guard for module implementations. */
export function isBotModule(value: unknown): value is BotModule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BotModule>;
  return typeof candidate.name === "string" && typeof candidate.enabled === "function";
}
