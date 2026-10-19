/**
 * Diagnostic registry.
 *
 * The extension point for V4+ modules: a new feature ships its own check and
 * registers it, and `/diagnostics` picks it up without being modified. That is
 * the whole reason this class exists rather than a list of checks inside the
 * command.
 *
 * Execution guarantees:
 * - a check that throws is converted into a `fail` result carrying the error
 *   message, so one broken check cannot take the report down with it;
 * - checks run sequentially: they share a database connection and may already be
 *   touching Discord, and the ordering makes latency numbers meaningful;
 * - results are returned sorted by category, in the canonical category order.
 */
import type {
  Diagnostic,
  DiagnosticCategory,
  DiagnosticContext,
  DiagnosticResult,
} from "./diagnostic.types.js";
import { DIAGNOSTIC_CATEGORIES } from "./diagnostic.types.js";

/** A diagnostic result plus how long the runner waited for it. */
export interface DiagnosticRun {
  readonly durationMs: number;
  readonly results: readonly DiagnosticResult[];
}

export class DiagnosticRegistry {
  private readonly diagnostics = new Map<string, Diagnostic>();
  private readonly logger: DiagnosticContext["logger"];

  public constructor(logger: DiagnosticContext["logger"]) {
    this.logger = logger.child("diagnostics");
  }

  /**
   * Registers a diagnostic.
   *
   * @throws Error when the id is already taken: two checks with the same id would
   * silently overwrite each other, which is a programming error worth failing on.
   */
  public register(diagnostic: Diagnostic): void {
    if (this.diagnostics.has(diagnostic.id)) {
      throw new Error(`Duplicate diagnostic id: ${diagnostic.id}`);
    }
    this.diagnostics.set(diagnostic.id, diagnostic);
  }

  /** Registers many diagnostics, validating the whole set first. */
  public registerAll(diagnostics: readonly Diagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.register(diagnostic);
    }
  }

  /** @returns every registered diagnostic, in registration order. */
  public list(): readonly Diagnostic[] {
    return [...this.diagnostics.values()];
  }

  /** @returns the diagnostics of one category, in registration order. */
  public listCategory(category: DiagnosticCategory): readonly Diagnostic[] {
    return this.list().filter((diagnostic) => diagnostic.category === category);
  }

  /** @returns the number of registered diagnostics. */
  public get size(): number {
    return this.diagnostics.size;
  }

  /** Runs every diagnostic. */
  public runAll(context: DiagnosticContext): Promise<DiagnosticRun> {
    return this.runDiagnostics(this.list(), context);
  }

  /** Runs the diagnostics of one category. */
  public runCategory(
    category: DiagnosticCategory,
    context: DiagnosticContext,
  ): Promise<DiagnosticRun> {
    return this.runDiagnostics(this.listCategory(category), context);
  }

  /** Runs a specific set of diagnostics, isolating failures. */
  private async runDiagnostics(
    diagnostics: readonly Diagnostic[],
    context: DiagnosticContext,
  ): Promise<DiagnosticRun> {
    const startedAt = performance.now();
    const results: DiagnosticResult[] = [];

    for (const diagnostic of diagnostics) {
      results.push(await this.runOne(diagnostic, context));
    }

    return {
      durationMs: Math.round(performance.now() - startedAt),
      results: sortResults(results),
    };
  }

  /** Runs one diagnostic, converting a thrown error into a `fail` result. */
  private async runOne(
    diagnostic: Diagnostic,
    context: DiagnosticContext,
  ): Promise<DiagnosticResult> {
    const startedAt = performance.now();
    try {
      const result = await diagnostic.run(context);
      return { ...result, durationMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Diagnostic check failed with an exception", {
        id: diagnostic.id,
        error: message,
      });
      return {
        id: diagnostic.id,
        category: diagnostic.category,
        label: diagnostic.label,
        status: "fail",
        detail: `The check could not complete: ${message}`,
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
  }
}

/** @returns results sorted by canonical category order, then by label. */
export function sortResults(results: readonly DiagnosticResult[]): DiagnosticResult[] {
  const order = new Map(DIAGNOSTIC_CATEGORIES.map((category, index) => [category, index]));
  return [...results].sort((left, right) => {
    const leftOrder = order.get(left.category) ?? DIAGNOSTIC_CATEGORIES.length;
    const rightOrder = order.get(right.category) ?? DIAGNOSTIC_CATEGORIES.length;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.label.localeCompare(right.label);
  });
}
