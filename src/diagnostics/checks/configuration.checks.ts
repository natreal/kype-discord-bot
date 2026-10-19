/**
 * Configuration diagnostics.
 *
 * Validates what is actually stored, not what the schema allows: stored sections
 * that had to fall back to defaults, and a guild whose row is missing entirely.
 */
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";

/** Guild configuration validity and provenance. */
export const guildConfigurationDiagnostic: Diagnostic = {
  id: "configuration.guild",
  category: "configuration",
  label: "Guild configuration",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const guild = context.guild;
    if (!guild) {
      return {
        id: "configuration.guild",
        category: "configuration",
        label: "Guild configuration",
        status: "fail",
        detail: "Guild configuration can only be checked inside a server.",
      };
    }

    try {
      const result = await context.config.read(guild.id, guild.name);

      if (!result.valid) {
        return {
          id: "configuration.guild",
          category: "configuration",
          label: "Guild configuration",
          status: "warn",
          detail: `Stored configuration required repair: ${result.issues.join("; ")}.`,
          remediation: "Re-set the affected sections with `/settings set`.",
          metrics: { issues: result.issues.length },
        };
      }

      const sections = result.configuredSections;
      return {
        id: "configuration.guild",
        category: "configuration",
        label: "Guild configuration",
        status: "pass",
        detail:
          sections.length === 0
            ? "No explicit configuration; every section uses a valid default."
            : `${sections.length} section(s) configured explicitly, all valid.`,
        metrics: { configuredSections: sections.length },
      };
    } catch (error) {
      return {
        id: "configuration.guild",
        category: "configuration",
        label: "Guild configuration",
        status: "fail",
        detail: `The configuration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/** Defaults must themselves be valid, or every guild inherits the problem. */
export const defaultConfigurationDiagnostic: Diagnostic = {
  id: "configuration.defaults",
  category: "configuration",
  label: "Defaults",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    try {
      const defaults = context.config.validate({}, "defaults");
      const sections = Object.keys(defaults).length;
      return Promise.resolve({
        id: "configuration.defaults",
        category: "configuration",
        label: "Defaults",
        status: "pass",
        detail: `The default configuration is valid (${sections} section(s)).`,
        metrics: { sections },
      });
    } catch (error) {
      return Promise.resolve({
        id: "configuration.defaults",
        category: "configuration",
        label: "Defaults",
        status: "fail",
        detail: `The default configuration failed validation: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          "This is a code defect: the schema and defaults in `guild-config.schema.ts` disagree.",
      });
    }
  },
};

/** Every configuration check. */
export const CONFIGURATION_DIAGNOSTICS: readonly Diagnostic[] = [
  defaultConfigurationDiagnostic,
  guildConfigurationDiagnostic,
];
