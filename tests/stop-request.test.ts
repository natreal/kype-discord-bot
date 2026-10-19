import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearStopRequest,
  isStopRequested,
  stopRequestPath,
  watchStopRequest,
} from "../src/runtime/stop-request.js";

const roots: string[] = [];

/** Creates a throwaway project root containing a `.run` directory. */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kype-stop-request-"));
  roots.push(root);
  await mkdir(path.join(root, ".run"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stop requests", () => {
  it("resolves the marker inside .run", async () => {
    const root = await createRoot();
    expect(stopRequestPath(root)).toBe(path.join(root, ".run", "stop.request"));
  });

  it("reports a request only when the marker exists", async () => {
    const root = await createRoot();
    expect(isStopRequested(root)).toBe(false);

    await writeFile(stopRequestPath(root), "");
    expect(isStopRequested(root)).toBe(true);
  });

  it("clears a request without failing when it is already gone", async () => {
    const root = await createRoot();
    await writeFile(stopRequestPath(root), "");

    clearStopRequest(root);
    expect(isStopRequested(root)).toBe(false);

    // Idempotent: the launcher may clear it twice (stop and start).
    expect(() => {
      clearStopRequest(root);
    }).not.toThrow();
  });

  it("notifies once and leaves the marker for the supervisor", async () => {
    const root = await createRoot();
    const onStop = vi.fn();
    const watcher = watchStopRequest({ projectRoot: root, intervalMs: 5, onStop });

    try {
      await writeFile(stopRequestPath(root), "");
      await vi.waitFor(() => {
        expect(onStop).toHaveBeenCalledTimes(1);
      });

      // The supervisor distinguishes "crashed" from "asked to stop" by the marker,
      // so the bot must not remove it.
      expect(isStopRequested(root)).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it("stops polling when the watcher is stopped", async () => {
    const root = await createRoot();
    const onStop = vi.fn();
    const watcher = watchStopRequest({ projectRoot: root, intervalMs: 5, onStop });

    watcher.stop();
    await writeFile(stopRequestPath(root), "");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onStop).not.toHaveBeenCalled();
  });
});
