import type { Guild } from "discord.js";

import type { BotClient } from "../client/client.types.js";
import type { ConfigService } from "../services/config/index.js";
import type { DatabaseService } from "../services/database/index.js";
import type { Logger } from "../services/logger/index.js";
import type { PermissionService } from "../services/permissions/index.js";
import type { AuthorizationService } from "../services/authorization/index.js";
import type { CommandRegistry } from "../commands/command.registry.js";
import type { ModerationContextServices, SetupContextServices } from "../commands/context.js";
import type { SetupResourceDefinition } from "../modules/setup.types.js";
import type { CommandDeploymentService } from "../services/deployment/index.js";

/** Categories a diagnostic belongs to. */
export const DIAGNOSTIC_CATEGORIES = [
  "core",
  "permissions",
  "resources",
  "configuration",
  "moderation",
  "security",
  "performance",
] as const;

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];

/** Outcome of a single check. */
export type DiagnosticStatus = "pass" | "warn" | "fail";

/** Result of a single check. */
export interface DiagnosticResult {
  readonly id: string;
  readonly category: DiagnosticCategory;
  /** Short human-readable label, e.g. "Gateway latency". */
  readonly label: string;
  readonly status: DiagnosticStatus;
  /** One-line explanation, shown next to the label. */
  readonly detail: string;
  /** Actionable remediation when the status is not `pass`. */
  readonly remediation?: string;
  /** Measured values (latency, counts). Never fabricated: omit when unknown. */
  readonly metrics?: Readonly<Record<string, number>>;
  /** How long the check itself took. */
  readonly durationMs?: number;
}

/**
 * Everything a check may inspect.
 *
 * Everything here is guild-scoped: `guild` is the guild being diagnosed, and
 * there is deliberately no way to reach another guild's state, which makes
 * "diagnostics never inspect the wrong guild" structural rather than a convention.
 */
export interface DiagnosticContext {
  /** Guild under diagnosis; `null` for process-wide checks. */
  readonly guild: Guild | null;
  readonly client: BotClient;
  readonly database: DatabaseService;
  readonly config: ConfigService;
  readonly permissions: PermissionService;
  readonly authorization: AuthorizationService;
  /** Resource registry used by the setup system (V2's, not a copy). */
  readonly setupResources: readonly SetupResourceDefinition[];
  /** Guild-bound setup identity service; `null` outside a guild. */
  readonly setupContext: SetupContextServices | null;
  /**
   * Guild-bound moderation service, so a moderation check reports measured facts
   * (case counts, log delivery) instead of re-implementing the module's rules.
   * `null` in contexts that do not wire moderation.
   */
  readonly moderation?: ModerationContextServices | null;
  /**
   * Whether the client was constructed with the `MessageContent` intent.
   *
   * A *client* fact, not a guild fact, and precisely what the automod check needs:
   * without the intent, automod reads every message as empty and no rule can fire,
   * with no error anywhere.
   */
  readonly hasMessageContentIntent?: boolean;
  readonly logger: Logger;
  /** Milliseconds since process start. */
  readonly uptimeMs: number;
  /** Commands currently registered with the client. */
  readonly commands: CommandRegistry;
  /**
   * Slash-command deployment, so a check can ask Discord what a guild really has.
   *
   * Optional: a harness that does not wire deployment still gets a full report,
   * with the deployment checks degrading to a warning instead of throwing.
   */
  readonly deployment?: CommandDeploymentService;
}

/** A single independent check. */
export interface Diagnostic {
  readonly id: string;
  readonly category: DiagnosticCategory;
  readonly label: string;
  run(context: DiagnosticContext): Promise<DiagnosticResult>;
}
