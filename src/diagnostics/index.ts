/**
 * Diagnostics framework.
 *
 * Public surface: the registry (extension point), the report builder (purely
 * presentational transformation) and the built-in checks. Import from here rather
 * than reaching into `checks/`.
 */
export { DiagnosticRegistry, sortResults, type DiagnosticRun } from "./diagnostic.registry.js";
export {
  buildDiagnosticReport,
  describeVerdict,
  statusSymbol,
  verdictFor,
  type DiagnosticCategoryReport,
  type DiagnosticReport,
  type DiagnosticVerdict,
} from "./diagnostic.report.js";
export {
  DIAGNOSTIC_CATEGORIES,
  type Diagnostic,
  type DiagnosticCategory,
  type DiagnosticContext,
  type DiagnosticResult,
  type DiagnosticStatus,
} from "./diagnostic.types.js";
export { BUILT_IN_DIAGNOSTICS } from "./checks/index.js";
