/**
 * Configuration provenance and validation.
 *
 * V3 must be able to answer two questions that V2 could not:
 * - "is this value the default, or did an administrator set it?"
 * - "is this value valid *now*, even though we refuse to persist it?"
 *
 * `ConfigValidator` owns validation plus provenance: it reads stored sections,
 * merges them over `defaultGuildConfig()` and reports which sections and which
 * leaf paths came from the administrator.
 *
 * Validation is deliberately *tolerant on read, strict on write*: an invalid
 * stored value makes the guild fall back to defaults for that field (so one bad
 * section cannot break a whole guild) while `/settings set` refuses to write it
 * in the first place. `/diagnostics` surfaces the difference.
 */
import { z } from "zod";

import { ValidationError } from "../../utils/errors.js";
import { deepMerge, isPlainObject } from "./merge.js";
import { defaultGuildConfig, guildConfigSchema, type GuildConfig } from "./guild-config.schema.js";

/** Leaf path of a configured value, e.g. `logging.events.memberJoin`. */
export type ConfigPath = string;

/** Outcome of validating one guild's stored configuration. */
export interface ConfigValidationResult {
  /** Fully merged, schema-valid configuration. */
  readonly config: GuildConfig;
  /** Sections whose value came from storage rather than from defaults. */
  readonly configuredSections: readonly string[];
  /** Leaf paths explicitly set by an administrator (dot notation). */
  readonly overriddenPaths: readonly ConfigPath[];
  /** Problems found while reading, as `section: message` strings. */
  readonly issues: readonly string[];
  /** True when the stored configuration could be read without any issue. */
  readonly valid: boolean;
}

export class ConfigValidator {
  /**
   * Validates a candidate object against the schema.
   *
   * @throws ValidationError with a path-indexed issue list, so the command can
   * tell the administrator *which* option was rejected.
   */
  public validate(candidate: unknown, guildId = "unknown"): GuildConfig {
    const result = guildConfigSchema.safeParse(candidate);
    if (!result.success) {
      throw new ValidationError("Guild configuration failed validation", {
        guildId,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }

  /** Validates a single section value (used by `/settings set`). */
  public validateSection<K extends keyof GuildConfig>(
    section: K,
    value: unknown,
    guildId = "unknown",
  ): GuildConfig[K] {
    const parsed = this.validate({ [section]: value }, guildId);
    return parsed[section];
  }

  /**
   * Merges stored sections over the defaults.
   *
   * Invalid stored data never throws: the offending section is dropped, the
   * default is used, and the problem is recorded in `issues` so diagnostics and
   * the command layer can report it instead of silently hiding it.
   *
   * A section value is stored as arbitrary JSON. `language` is a scalar while
   * every other section is an object, so the merge is driven by *shape* rather
   * than by an assumption that everything is an object — getting that wrong would
   * silently discard a perfectly valid value.
   */
  public parse(
    stored: readonly { section: string; value: unknown }[],
    guildId = "unknown",
  ): ConfigValidationResult {
    const defaults = defaultGuildConfig();
    const known = new Set(Object.keys(defaults));
    const configuredSections: string[] = [];
    const overriddenPaths: ConfigPath[] = [];
    const issues: string[] = [];
    const accepted: { section: string; value: unknown }[] = [];

    for (const entry of stored) {
      if (!known.has(entry.section)) {
        issues.push(`${entry.section}: unknown configuration section`);
        continue;
      }
      // `undefined` would be a no-op in the merge anyway, but an explicit `null`
      // in an object section is meaningful and must survive.
      if (entry.value === undefined) {
        issues.push(`${entry.section}: stored value is missing`);
        continue;
      }
      if (entry.value === null && isPlainObject(defaults[entry.section as keyof GuildConfig])) {
        issues.push(`${entry.section}: stored value is not an object`);
        continue;
      }
      accepted.push(entry);
    }

    let merged: unknown = defaults;
    for (const entry of accepted) {
      merged = deepMerge(merged as Record<string, unknown>, { [entry.section]: entry.value });
      configuredSections.push(entry.section);
    }

    const config = this.mergeWithFallback(merged, accepted, issues, guildId);

    for (const entry of accepted) {
      overriddenPaths.push(...leafPaths(entry.value, entry.section));
    }

    return {
      config,
      configuredSections: [...new Set(configuredSections)],
      overriddenPaths: [...new Set(overriddenPaths)].sort(),
      issues,
      valid: issues.length === 0,
    };
  }

  /**
   * Repairs a whole-object validation failure section by section.
   *
   * One unusable section must not cost the administrator the rest of their
   * configuration: each section is validated on its own and only the failing one
   * falls back to its default, with the reason recorded in `issues`.
   */
  private mergeWithFallback(
    merged: unknown,
    accepted: readonly { section: string; value: unknown }[],
    issues: string[],
    guildId: string,
  ): GuildConfig {
    try {
      return this.validate(merged, guildId);
    } catch {
      const repaired: Record<string, unknown> = { ...defaultGuildConfig() };
      for (const entry of accepted) {
        try {
          const sectionSchema = guildConfigSchema.shape[entry.section as keyof GuildConfig];
          repaired[entry.section] = sectionSchema.parse(entry.value);
        } catch (error) {
          issues.push(`${entry.section}: ${firstIssueMessage(error)}`);
        }
      }
      return this.validate(repaired, guildId);
    }
  }

  /**
   * Compares two values and returns the changed leaf paths.
   *
   * Used by `/settings` to show a precise before/after preview and by the audit
   * trail to record *what* changed rather than a whole section blob.
   */
  public diff(before: unknown, after: unknown, prefix = ""): string[] {
    if (!isPlainObject(before) || !isPlainObject(after)) {
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || "value"];
    }

    const changed: string[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const path = prefix ? `${prefix}.${key}` : key;
      changed.push(...this.diff(before[key], after[key], path));
    }
    return changed;
  }
}

/** @returns the flattened leaf paths of a configured object. */
export function leafPaths(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) {
    return prefix ? [prefix] : [];
  }
  const paths: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(nested)) {
      paths.push(...leafPaths(nested, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** @returns the first issue of a Zod error, or any other error's message. */
function firstIssueMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const [issue] = error.issues;
    return issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid value";
  }
  return error instanceof Error ? error.message : String(error);
}
