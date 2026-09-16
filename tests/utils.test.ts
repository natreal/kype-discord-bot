/**
 * Utility tests: filesystem discovery helpers, async helpers and custom IDs.
 *
 * These helpers are the cross-platform foundation of module discovery, so they
 * are tested for path handling, filtering and deterministic ordering.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCustomId, parseCustomId } from "../../src/interactions/interaction.router.js";
import { chunk, groupBy, nonEmpty, retry, sleep } from "../../src/utils/async.js";
import {
  collectModuleFiles,
  fromProjectRoot,
  isLoadableModuleFile,
  moduleId,
  projectRoot,
  toPosixPath,
} from "../../src/utils/fs.js";
import { formatBytes, formatDuration } from "../../src/utils/presenters.js";
import { ValidationError } from "../../src/utils/errors.js";

const FIXTURE_ROOT = fromProjectRoot("tests", ".fs-fixtures");

describe("filesystem helpers", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("resolves paths from the project root without OS-specific strings", () => {
    expect(path.isAbsolute(projectRoot())).toBe(true);
    expect(fromProjectRoot("src", "commands")).toBe(path.join(projectRoot(), "src", "commands"));
  });

  it("normalizes separators for logs", () => {
    expect(toPosixPath(path.join("a", "b", "c"))).toBe("a/b/c");
  });

  it("decides which files can be loaded as modules", () => {
    expect(isLoadableModuleFile("ping.ts")).toBe(true);
    expect(isLoadableModuleFile("ping.js")).toBe(true);
    expect(isLoadableModuleFile("_shared.ts")).toBe(false);
    expect(isLoadableModuleFile(".hidden.ts")).toBe(false);
    expect(isLoadableModuleFile("ping.test.ts")).toBe(false);
    expect(isLoadableModuleFile("types.d.ts")).toBe(false);
    expect(isLoadableModuleFile("README.md")).toBe(false);
  });

  it("collects module files recursively in deterministic order", async () => {
    await mkdir(path.join(FIXTURE_ROOT, "core", "deep"), { recursive: true });
    await writeFile(path.join(FIXTURE_ROOT, "core", "a.ts"), "export {};\n");
    await writeFile(path.join(FIXTURE_ROOT, "core", "deep", "b.ts"), "export {};\n");
    await writeFile(path.join(FIXTURE_ROOT, "core", "notes.md"), "# notes\n");

    const files = await collectModuleFiles(FIXTURE_ROOT);

    expect(files.map((file) => path.basename(file))).toEqual(["a.ts", "b.ts"]);
    expect(files).toEqual([...files].sort((left, right) => left.localeCompare(right)));
  });

  it("returns an empty list for a missing directory instead of throwing", async () => {
    await expect(collectModuleFiles(path.join(FIXTURE_ROOT, "missing"))).resolves.toEqual([]);
  });

  it("derives stable module identifiers", () => {
    const file = fromProjectRoot("src", "commands", "core", "ping.ts");
    expect(moduleId(file, fromProjectRoot("src", "commands"))).toBe("core/ping");
  });
});

describe("async helpers", () => {
  it("chunks arrays and rejects invalid sizes", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it("groups items by a derived key", () => {
    expect(groupBy(["a1", "a2", "b1"], (item) => item[0] as string)).toEqual({
      a: ["a1", "a2"],
      b: ["b1"],
    });
  });

  it("treats blank strings as absent", () => {
    expect(nonEmpty("  ")).toBeUndefined();
    expect(nonEmpty("value")).toBe("value");
    expect(nonEmpty(undefined)).toBeUndefined();
  });

  it("retries a failing operation and eventually succeeds", async () => {
    let attempts = 0;
    const result = await retry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(new Error("transient"));
        }
        return Promise.resolve("ok");
      },
      { retries: 3, baseDelayMs: 1 },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops retrying when shouldRetry says so", async () => {
    let attempts = 0;
    await expect(
      retry(
        () => {
          attempts += 1;
          return Promise.reject(new Error("permanent"));
        },
        { retries: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow("permanent");

    expect(attempts).toBe(1);
  });

  it("sleep resolves", async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});

describe("custom id routing", () => {
  it("builds and parses namespaced custom IDs", () => {
    const customId = buildCustomId("ticket", "close", 1234);

    expect(customId).toBe("ticket:close:1234");
    expect(parseCustomId(customId)).toEqual({ namespace: "ticket", args: ["close", "1234"] });
  });

  it("rejects custom IDs beyond Discord's 100 character limit", () => {
    expect(() => buildCustomId("namespace", "x".repeat(200))).toThrow(ValidationError);
  });
});

describe("presenters", () => {
  it("formats durations", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });

  it("formats byte counts", () => {
    expect(formatBytes(1_024 * 1_024)).toBe("1.0 MB");
    expect(formatBytes(2 * 1_024 * 1_024 * 1_024)).toBe("2.00 GB");
  });
});
