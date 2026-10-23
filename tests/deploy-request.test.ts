/**
 * Deploy-request and build-stamp runtime tests.
 *
 * These pin the two facts that make a remote update trustworthy:
 *
 *   1. **`/admin update` only writes a marker.** It must never deploy, fetch or
 *      restart anything itself — the scheduled task owns that — so the marker's
 *      presence and contents are the entire contract.
 *   2. **The build stamp is readable and degrades safely.** "Which commit am I
 *      running?" must be answerable, and a missing or corrupt stamp must report
 *      `null` rather than crash startup.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deployRequestPath,
  isDeployRequested,
  readDeployRequest,
  requestDeploy,
} from "../src/runtime/deploy-request.js";
import { formatBuildInfo, readBuildInfo, writeBuildInfo } from "../src/runtime/build-info.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kype-deploy-"));
  roots.push(root);
  await mkdir(path.join(root, ".run"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deploy-request", () => {
  it("reports nothing pending for a fresh project", async () => {
    const root = await createRoot();
    expect(isDeployRequested(root)).toBe(false);
    expect(readDeployRequest(root)).toBeNull();
  });

  it("writes a marker carrying who asked and why", async () => {
    const root = await createRoot();
    const marker = requestDeploy({ requestedBy: "tester (1)", reason: "fix ai" }, root);

    expect(marker).toBe(deployRequestPath(root));
    expect(isDeployRequested(root)).toBe(true);
    const parsed = readDeployRequest(root);
    expect(parsed?.requestedBy).toBe("tester (1)");
    expect(parsed?.requestedAt).toBeTruthy();
  });

  it("records a missing reason as null rather than 'undefined'", async () => {
    const root = await createRoot();
    requestDeploy({ requestedBy: "tester (1)" }, root);
    const raw = JSON.parse(
      await (await import("node:fs/promises")).readFile(deployRequestPath(root), "utf8"),
    ) as { reason: unknown };
    expect(raw.reason).toBeNull();
  });

  it("survives a corrupt marker instead of throwing", async () => {
    const root = await createRoot();
    await writeFile(deployRequestPath(root), "{not json", "utf8");
    expect(readDeployRequest(root)).toBeNull();
    expect(isDeployRequested(root)).toBe(true);
  });
});

describe("build-info", () => {
  it("round-trips the stamp", async () => {
    const root = await createRoot();
    const file = path.join(root, "build-info.json");
    writeBuildInfo(
      { commit: "abcdef1234567890", subject: "fix: thing", builtAt: "2026-01-01T00:00:00.000Z", dirty: false },
      file,
    );

    const info = readBuildInfo(file);
    expect(info?.commit).toBe("abcdef1234567890");
    expect(info?.subject).toBe("fix: thing");
    expect(formatBuildInfo(info)).toBe("abcdef1 — fix: thing");
  });

  it("reports a dirty build so a local edit is never mistaken for a release", async () => {
    const root = await createRoot();
    const file = path.join(root, "build-info.json");
    writeBuildInfo({ commit: "abcdef1234567890", subject: "wip", builtAt: "", dirty: true }, file);
    expect(formatBuildInfo(readBuildInfo(file))).toContain("uncommitted changes");
  });

  it("returns null for a missing or corrupt stamp", async () => {
    const root = await createRoot();
    const missing = path.join(root, "absent.json");
    expect(readBuildInfo(missing)).toBeNull();
    expect(formatBuildInfo(null)).toContain("unknown");

    const corrupt = path.join(root, "corrupt.json");
    await writeFile(corrupt, "[]", "utf8");
    expect(readBuildInfo(corrupt)).toBeNull();
  });
});
