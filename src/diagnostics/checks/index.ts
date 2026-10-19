/**
 * Every built-in diagnostic.
 *
 * A future module adds its own check here (or in its own file and registers it
 * through the registry), and `/diagnostics` reports it without any change to the
 * command. That is the extension point the V3 brief asks for.
 */
import type { Diagnostic } from "../diagnostic.types.js";
import { CONFIGURATION_DIAGNOSTICS } from "./configuration.checks.js";
import { CORE_DIAGNOSTICS } from "./core.checks.js";
import { DEPLOYMENT_DIAGNOSTICS } from "./deployment.checks.js";
import { MODERATION_DIAGNOSTICS } from "./moderation.checks.js";
import { PERFORMANCE_DIAGNOSTICS } from "./performance.checks.js";
import { PERMISSION_DIAGNOSTICS } from "./permission.checks.js";
import { RESOURCE_DIAGNOSTICS } from "./resource.checks.js";
import { AUTOMOD_DIAGNOSTICS, SECURITY_DIAGNOSTICS } from "./security.checks.js";

export { CONFIGURATION_DIAGNOSTICS } from "./configuration.checks.js";
export { CORE_DIAGNOSTICS } from "./core.checks.js";
export { DEPLOYMENT_DIAGNOSTICS } from "./deployment.checks.js";
export { MODERATION_DIAGNOSTICS } from "./moderation.checks.js";
export { PERFORMANCE_DIAGNOSTICS } from "./performance.checks.js";
export { PERMISSION_DIAGNOSTICS } from "./permission.checks.js";
export { RESOURCE_DIAGNOSTICS } from "./resource.checks.js";
export { AUTOMOD_DIAGNOSTICS, SECURITY_DIAGNOSTICS } from "./security.checks.js";

/** All built-in diagnostics, grouped by the category order they are shown in. */
export const BUILT_IN_DIAGNOSTICS: readonly Diagnostic[] = [
  ...CORE_DIAGNOSTICS,
  ...DEPLOYMENT_DIAGNOSTICS,
  ...PERMISSION_DIAGNOSTICS,
  ...RESOURCE_DIAGNOSTICS,
  ...CONFIGURATION_DIAGNOSTICS,
  ...MODERATION_DIAGNOSTICS,
  ...AUTOMOD_DIAGNOSTICS,
  ...SECURITY_DIAGNOSTICS,
  ...PERFORMANCE_DIAGNOSTICS,
];
