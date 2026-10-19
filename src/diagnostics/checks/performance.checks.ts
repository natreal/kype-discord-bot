/**
 * Performance diagnostics.
 *
 * Reports measured values only. A metric that cannot be read is reported as such
 * rather than defaulted to a plausible-looking number: fabricated telemetry is
 * worse than no telemetry, because it is trusted.
 */
import type { Diagnostic, DiagnosticContext, DiagnosticResult } from "../diagnostic.types.js";

/** Threshold above which gateway latency is reported as a warning. */
const GATEWAY_WARN_MS = 500;

/** Threshold above which database latency is reported as a warning. */
const DATABASE_WARN_MS = 250;

/** Gateway (WebSocket) latency. */
export const gatewayLatencyDiagnostic: Diagnostic = {
  id: "performance.gateway",
  category: "performance",
  label: "Gateway latency",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const ping = context.client.ws.ping;

    if (!Number.isFinite(ping) || ping < 0) {
      return Promise.resolve({
        id: "performance.gateway",
        category: "performance",
        label: "Gateway latency",
        status: "warn",
        detail: "The gateway has not reported a heartbeat yet.",
      });
    }

    const latencyMs = Math.round(ping);
    return Promise.resolve({
      id: "performance.gateway",
      category: "performance",
      label: "Gateway latency",
      status: latencyMs > GATEWAY_WARN_MS ? "warn" : "pass",
      detail: `${latencyMs}ms.`,
      metrics: { latencyMs },
    });
  },
};

/** Database round-trip latency. */
export const databaseLatencyDiagnostic: Diagnostic = {
  id: "performance.database",
  category: "performance",
  label: "Database latency",
  run: async (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const health = await context.database.health();

    if (!health.ok) {
      return {
        id: "performance.database",
        category: "performance",
        label: "Database latency",
        status: "fail",
        detail: "No latency could be measured: the database is unreachable.",
      };
    }

    return {
      id: "performance.database",
      category: "performance",
      label: "Database latency",
      status: health.latencyMs > DATABASE_WARN_MS ? "warn" : "pass",
      detail: `${health.latencyMs}ms.`,
      metrics: { latencyMs: health.latencyMs },
    };
  },
};

/** Process uptime and memory, from the real process. */
export const processDiagnostic: Diagnostic = {
  id: "performance.process",
  category: "performance",
  label: "Process",
  run: (context: DiagnosticContext): Promise<DiagnosticResult> => {
    const memory = process.memoryUsage();
    const uptimeMs = context.uptimeMs;
    const seconds = Math.round(uptimeMs / 1_000);

    return Promise.resolve({
      id: "performance.process",
      category: "performance",
      label: "Process",
      status: "pass",
      detail: `Up ${formatSeconds(seconds)}, RSS ${formatMegabytes(memory.rss)}.`,
      metrics: {
        uptimeMs,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
    });
  },
};

/** Every performance check. */
export const PERFORMANCE_DIAGNOSTICS: readonly Diagnostic[] = [
  gatewayLatencyDiagnostic,
  databaseLatencyDiagnostic,
  processDiagnostic,
];

/** @returns a compact duration, e.g. `3d 4h 12m`. */
function formatSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [
    days > 0 ? `${days}d` : undefined,
    hours > 0 ? `${hours}h` : undefined,
    minutes > 0 ? `${minutes}m` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : `${seconds}s`;
}

/** @returns megabytes with one decimal. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}
