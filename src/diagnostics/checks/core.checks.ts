/**
 * Core diagnostics: Discord connection, command availability, database health.
 *
 * These are the checks whose failure means "nothing else on this list can be
 * trusted", so they report explicitly rather than degrading quietly.
 */
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";

/** Discord gateway connection and general client state. */
export const discordConnectionDiagnostic: Diagnostic = {
  id: "core.discord",
  category: "core",
  label: "Discord connection",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const { client } = context;
    const ready = client.isReady() && client.user !== null;

    if (!ready) {
      return Promise.resolve({
        id: "core.discord",
        category: "core",
        label: "Discord connection",
        status: "fail",
        detail: "The gateway connection is not ready.",
        remediation: "Check the bot token and network access; the bot retries automatically.",
      });
    }

    const guildCount = client.guilds.cache.size;
    return Promise.resolve({
      id: "core.discord",
      category: "core",
      label: "Discord connection",
      status: "pass",
      detail: `Connected as ${client.user.username}, serving ${guildCount} guild(s).`,
      metrics: { guilds: guildCount },
    });
  },
};

/** Command registration: are the commands this build declares actually loaded? */
export const commandSystemDiagnostic: Diagnostic = {
  id: "core.commands",
  category: "core",
  label: "Command system",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const registered = context.commands.list().map((command) => command.name);
    const expected = ["setup", "settings", "diagnostics"];
    const missing = expected.filter((name) => !context.commands.has(name));

    if (registered.length === 0) {
      return Promise.resolve({
        id: "core.commands",
        category: "core",
        label: "Command system",
        status: "fail",
        detail: "No commands are registered; the loader did not run or failed entirely.",
        remediation: "Check the startup log for command loading errors.",
      });
    }

    if (missing.length > 0) {
      return Promise.resolve({
        id: "core.commands",
        category: "core",
        label: "Command system",
        status: "warn",
        detail: `${registered.length} command(s) loaded; missing ${missing.join(", ")}.`,
        remediation: "Re-deploy the commands with `npm run deploy:commands`.",
        metrics: { loaded: registered.length },
      });
    }

    return Promise.resolve({
      id: "core.commands",
      category: "core",
      label: "Command system",
      status: "pass",
      detail: `${registered.length} command(s) loaded.`,
      metrics: { loaded: registered.length },
    });
  },
};

/** Database connectivity and latency, measured for real. */
export const databaseDiagnostic: Diagnostic = {
  id: "core.database",
  category: "core",
  label: "Database",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    try {
      const health = await context.database.health();
      if (!health.ok) {
        return {
          id: "core.database",
          category: "core",
          label: "Database",
          status: "fail",
          detail: "The database did not answer a liveness query.",
          remediation: "Verify `DATABASE_URL` and that PostgreSQL is reachable.",
          metrics: { latencyMs: health.latencyMs },
        };
      }
      return {
        id: "core.database",
        category: "core",
        label: "Database",
        status: "pass",
        detail: `Responded in ${health.latencyMs}ms.`,
        metrics: { latencyMs: health.latencyMs },
      };
    } catch (error) {
      return {
        id: "core.database",
        category: "core",
        label: "Database",
        status: "fail",
        detail: `The database is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Verify `DATABASE_URL` and that PostgreSQL is reachable.",
      };
    }
  },
};

/**
 * Prisma schema drift.
 *
 * A missing table is the classic "the code is newer than the database" failure,
 * and it produces confusing runtime errors when it is not reported explicitly.
 */
export const prismaHealthDiagnostic: Diagnostic = {
  id: "core.prisma",
  category: "core",
  label: "Prisma schema",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    try {
      // A cheap, real query against a V3 table: when the migration has not been
      // applied this throws, and the operator gets an actionable instruction.
      await context.database.prisma.auditEvent.count();
      return {
        id: "core.prisma",
        category: "core",
        label: "Prisma schema",
        status: "pass",
        detail: "The application tables are present.",
      };
    } catch (error) {
      return {
        id: "core.prisma",
        category: "core",
        label: "Prisma schema",
        status: "fail",
        detail: `A required table is missing: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Run `npm run db:migrate:deploy` to apply pending migrations.",
      };
    }
  },
};

/** Every core check, in the order they should run. */
export const CORE_DIAGNOSTICS: readonly Diagnostic[] = [
  discordConnectionDiagnostic,
  commandSystemDiagnostic,
  databaseDiagnostic,
  prismaHealthDiagnostic,
];
