/**
 * Diagnostic report.
 *
 * Transforms raw check results into the summary an administrator reads: grouped
 * by category, with an honest verdict. Nothing here invents data: a check that
 * could not measure something reports that, and the report shows it as `fail`.
 */
import type { DiagnosticCategory, DiagnosticResult, DiagnosticStatus } from "./diagnostic.types.js";
import { DIAGNOSTIC_CATEGORIES } from "./diagnostic.types.js";

/** Overall verdict of a diagnostic run. */
export type DiagnosticVerdict = "healthy" | "degraded" | "failing";

/** One category's worth of results. */
export interface DiagnosticCategoryReport {
  readonly category: DiagnosticCategory;
  readonly results: readonly DiagnosticResult[];
  readonly passed: number;
  readonly warnings: number;
  readonly failures: number;
}

/** The complete report handed to the command layer. */
export interface DiagnosticReport {
  readonly guildId: string | null;
  readonly verdict: DiagnosticVerdict;
  readonly categories: readonly DiagnosticCategoryReport[];
  readonly results: readonly DiagnosticResult[];
  readonly passed: number;
  readonly warnings: number;
  readonly failures: number;
  /** Number of distinct issues an administrator should look at. */
  readonly issues: number;
  readonly durationMs: number;
}

/** Builds a report from raw results. Pure and deterministic. */
export function buildDiagnosticReport(
  results: readonly DiagnosticResult[],
  options: { guildId?: string | null; durationMs?: number } = {},
): DiagnosticReport {
  const categories: DiagnosticCategoryReport[] = DIAGNOSTIC_CATEGORIES.map((category) => {
    const categoryResults = results.filter((result) => result.category === category);
    return {
      category,
      results: categoryResults,
      passed: count(categoryResults, "pass"),
      warnings: count(categoryResults, "warn"),
      failures: count(categoryResults, "fail"),
    };
  }).filter((category) => category.results.length > 0);

  const warnings = count(results, "warn");
  const failures = count(results, "fail");

  return {
    guildId: options.guildId ?? null,
    verdict: verdictFor(failures, warnings),
    categories,
    results,
    passed: count(results, "pass"),
    warnings,
    failures,
    issues: warnings + failures,
    durationMs: options.durationMs ?? 0,
  };
}

/** @returns the verdict implied by the failure and warning counts. */
export function verdictFor(failures: number, warnings: number): DiagnosticVerdict {
  if (failures > 0) {
    return "failing";
  }
  return warnings > 0 ? "degraded" : "healthy";
}

/** @returns a one-line summary of the verdict, for an embed description. */
export function describeVerdict(report: DiagnosticReport): string {
  if (report.issues === 0) {
    return `All ${report.passed} checks passed. Nothing needs attention.`;
  }
  const issues = `${report.issues} issue${report.issues === 1 ? "" : "s"} detected`;
  return report.failures > 0
    ? `${issues}: ${report.failures} failing, ${report.warnings} warning.`
    : `${issues}: ${report.warnings} warning.`;
}

/** @returns the symbol used for a status in the Discord output. */
export function statusSymbol(status: DiagnosticStatus): string {
  switch (status) {
    case "pass":
      return "✓";
    case "warn":
      return "⚠";
    default:
      return "✖";
  }
}

function count(results: readonly DiagnosticResult[], status: DiagnosticStatus): number {
  return results.filter((result) => result.status === status).length;
}
