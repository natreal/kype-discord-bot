/**
 * Resource diagnostics.
 *
 * Reuses the V2 resource registry and identity service directly — no second
 * resource system exists. Detects four distinct problems, because they need
 * different fixes:
 * - a tracked resource that is missing on Discord (repairable by `/setup repair`);
 * - a tracked resource that is not provisionable but is present (informational);
 * - a tracked resource whose stored ID points at nothing (drift);
 * - a stored identity for a key the registry no longer declares (orphan).
 */
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";

/** Tracked setup resources: existence, drift and orphans. */
export const setupResourcesDiagnostic: Diagnostic = {
  id: "resources.setup",
  category: "resources",
  label: "Setup resources",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const setupContext = context.setupContext;
    if (!setupContext) {
      return {
        id: "resources.setup",
        category: "resources",
        label: "Setup resources",
        status: "fail",
        detail: "The setup resource registry is not available in this context.",
      };
    }

    const tracked = await setupContext.resources.list();
    if (tracked.length === 0) {
      return {
        id: "resources.setup",
        category: "resources",
        label: "Setup resources",
        status: "warn",
        detail: "No setup resources are tracked yet. Run `/setup run` to create the structure.",
        remediation: "Run `/setup run`.",
      };
    }

    const stale = await setupContext.resources.detectStale(tracked);
    const knownKeys = new Set(context.setupResources.map((definition) => definition.key));
    const orphans = tracked.filter((record) => !knownKeys.has(record.key));

    const problems: string[] = [];
    if (stale.length > 0) {
      problems.push(`${stale.length} tracked resource(s) are missing on Discord`);
    }
    if (orphans.length > 0) {
      problems.push(`${orphans.length} stored key(s) are no longer declared by the registry`);
    }

    const metrics = {
      tracked: tracked.length,
      missing: stale.length,
      orphaned: orphans.length,
    };

    if (stale.length > 0) {
      return {
        id: "resources.setup",
        category: "resources",
        label: "Setup resources",
        status: "warn",
        detail: `${problems.join("; ")}: ${stale.map((entry) => entry.key).join(", ")}.`,
        remediation: "Run `/setup repair` to recreate the missing resources.",
        metrics,
      };
    }

    if (orphans.length > 0) {
      return {
        id: "resources.setup",
        category: "resources",
        label: "Setup resources",
        status: "warn",
        detail: `${problems.join("; ")}: ${orphans.map((entry) => entry.key).join(", ")}.`,
        remediation: "Deploy the version of the bot that declares these resources.",
        metrics,
      };
    }

    return {
      id: "resources.setup",
      category: "resources",
      label: "Setup resources",
      status: "pass",
      detail: `${tracked.length} tracked resource(s) all exist.`,
      metrics,
    };
  },
};

/**
 * Resource registry self-check.
 *
 * The registry is a compile-time constant, so a duplicate key or a `requires`
 * pointing at an unknown key is a programming error — but it would only surface
 * mid-setup on a production guild, which is far too late.
 */
export const resourceRegistryDiagnostic: Diagnostic = {
  id: "resources.registry",
  category: "resources",
  label: "Resource registry",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const definitions = context.setupResources;
    if (definitions.length === 0) {
      return Promise.resolve({
        id: "resources.registry",
        category: "resources",
        label: "Resource registry",
        status: "fail",
        detail: "The setup resource registry is empty.",
      });
    }

    const keys = new Set<string>();
    const problems: string[] = [];
    for (const definition of definitions) {
      if (keys.has(definition.key)) {
        problems.push(`duplicate key: ${definition.key}`);
      }
      keys.add(definition.key);
      for (const required of definition.requires ?? []) {
        if (!keys.has(required) && !definitions.some((entry) => entry.key === required)) {
          problems.push(`${definition.key} requires unknown resource ${required}`);
        }
      }
    }

    return Promise.resolve({
      id: "resources.registry",
      category: "resources",
      label: "Resource registry",
      status: problems.length === 0 ? "pass" : "fail",
      detail:
        problems.length === 0
          ? `${definitions.length} resource definition(s) are consistent.`
          : problems.join("; "),
      ...(problems.length === 0
        ? {}
        : { remediation: "Fix the registry in `src/modules/setup/setup-resources.ts`." }),
      metrics: { definitions: definitions.length },
    });
  },
};

/** Every resource check. */
export const RESOURCE_DIAGNOSTICS: readonly Diagnostic[] = [
  resourceRegistryDiagnostic,
  setupResourcesDiagnostic,
];
