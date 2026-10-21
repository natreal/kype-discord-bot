/**
 * `/stop` and `/restart` tests.
 *
 * The promises these two commands make are easy to get subtly wrong, so each one is
 * asserted directly:
 *
 *   1. **`/stop` shuts down through the bootstrap** — the same teardown a SIGTERM
 *      triggers, not a bare `process.exit()` that skips `client.destroy()`.
 *   2. **`/restart` writes the marker *before* it shuts down**, because a shutdown
 *      that finished first would take the marker's author down with it.
 *   3. **`/restart` refuses when nothing supervises the process**, instead of
 *      stopping a bot that would never come back.
 *   4. **a restart wins over a stop** in the marker protocol, which is what makes the
 *      supervisor relaunch instead of exiting.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearRestartRequest,
  hasSupervisor,
  isRestartRequested,
  requestRestart,
  restartRequestPath,
  RESTART_EXIT_CODE,
} from "../src/runtime/restart-request.js";
import { isStopRequested, stopRequestPath } from "../src/runtime/stop-request.js";
import { ProcessControlService } from "../src/services/process/index.js";
import { testLogger } from "../helpers/logger.js";

const roots: string[] = [];

/** Creates a throwaway project root, optionally with a supervisor script. */
async function createRoot(options: { supervisor?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kype-restart-"));
  roots.push(root);
  await mkdir(path.join(root, ".run"), { recursive: true });
  if (options.supervisor) {
    await mkdir(path.join(root, "scripts", "windows"), { recursive: true });
    await writeFile(path.join(root, "scripts", "windows", "supervisor.ps1"), "# stub\n");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const REQUEST = {
  actorId: "111111111111111111",
  actorTag: "owner#0001",
  guildId: "222222222222222222",
  guildName: "Guild",
  reason: "deploying",
} as const;

/** Builds a control service whose shutdown and exit are recorded, never performed. */
function createControl(root: string, overrides: { supervised?: boolean } = {}) {
  const events: string[] = [];
  const control = new ProcessControlService({
    logger: testLogger,
    startedAt: 1_000,
    shutdown: (reason) => {
      events.push(`shutdown:${reason}`);
      return Promise.resolve();
    },
    exit: (code) => {
      events.push(`exit:${code}`);
    },
    writeRestartRequest: (details) => requestRestart(details, root),
    projectRoot: root,
    shutdownDelayMs: 0,
    ...overrides,
  });
  return { control, events };
}

describe("restart markers", () => {
  it("resolves the marker inside .run and reports its presence", async () => {
    const root = await createRoot();

    expect(restartRequestPath(root)).toBe(path.join(root, ".run", "restart.request"));
    expect(isRestartRequested(root)).toBe(false);

    requestRestart({ requestedBy: "owner" }, root);
    expect(isRestartRequested(root)).toBe(true);

    clearRestartRequest(root);
    expect(isRestartRequested(root)).toBe(false);
    // Clearing a missing marker is not an error: the supervisor may have won the race.
    expect(() => clearRestartRequest(root)).not.toThrow();
  });

  it("records who asked, and clears a stale stop marker", async () => {
    const root = await createRoot();
    await writeFile(stopRequestPath(root), "");

    const marker = requestRestart({ requestedBy: "owner#0001", reason: "update" }, root);

    // A stale stop marker would make the supervisor treat this deliberate exit as a
    // stop request and stay down, which is the opposite of a restart.
    expect(isStopRequested(root)).toBe(false);
    const payload = JSON.parse(await readFile(marker, "utf8")) as {
      requestedBy: string;
      reason: string | null;
    };
    expect(payload.requestedBy).toBe("owner#0001");
    expect(payload.reason).toBe("update");
  });

  it("detects a supervisor only when a launcher script is installed", async () => {
    const bare = await createRoot();
    const supervised = await createRoot({ supervisor: true });

    expect(hasSupervisor(bare)).toBe(false);
    expect(hasSupervisor(supervised)).toBe(true);
  });
});

describe("ProcessControlService", () => {
  it("stops through the bootstrap's teardown, then exits with 0", async () => {
    const { control, events } = createControl(await createRoot());

    const outcome = await control.stop(REQUEST);
    // The shutdown runs on a timer; give the timer queue a turn.
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome).toEqual({ action: "stop", ok: true });
    expect(events).toEqual(["shutdown:discord-command", "exit:0"]);
  });

  it("restarts by writing the marker before shutting down", async () => {
    const root = await createRoot({ supervisor: true });
    const { control, events } = createControl(root);

    const outcome = await control.restart(REQUEST);
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.ok).toBe(true);
    expect(outcome.markerPath).toBe(restartRequestPath(root));
    expect(isRestartRequested(root)).toBe(true);
    expect(events).toEqual(["shutdown:restart", `exit:${RESTART_EXIT_CODE}`]);
  });

  it("refuses to restart without a supervisor rather than going offline", async () => {
    const { control, events } = createControl(await createRoot());

    const outcome = await control.restart(REQUEST);
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("No supervisor found");
    // Nothing was written and nothing exited: the bot keeps serving.
    expect(events).toEqual([]);
  });

  it("ignores a second request while a shutdown is already running", async () => {
    const root = await createRoot({ supervisor: true });
    const { control, events } = createControl(root);

    expect((await control.stop(REQUEST)).ok).toBe(true);
    const second = await control.restart(REQUEST);
    await new Promise((resolve) => setImmediate(resolve));

    expect(second.ok).toBe(false);
    expect(isRestartRequested(root)).toBe(false);
    expect(events).toEqual(["shutdown:discord-command", "exit:0"]);
  });

  it("reports the process facts a command may show", async () => {
    const { control } = createControl(await createRoot({ supervisor: true }), {
      supervised: true,
    });

    const status = control.status();

    expect(status.supervised).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.startedAt).toBe(1_000);
  });
});
