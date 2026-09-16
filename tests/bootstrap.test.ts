/**
 * Bootstrap wiring tests.
 *
 * These guard the specific regressions found during the first real run against
 * Discord: a type augmentation that promised a property the runtime never set,
 * and a deprecated event name.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fromProjectRoot } from "../../src/utils/fs.js";

describe("bootstrap wiring", () => {
  it("shares the command registry with the client before events are registered", async () => {
    const source = await readFile(fromProjectRoot("src", "app.ts"), "utf8");

    // `client.commands` is declared by a type augmentation, which describes the
    // shape but does not create the property. Without this call it is undefined
    // at runtime and every handler that reads it throws.
    expect(source).toContain("registry.applyToClient(client)");

    const applyIndex = source.indexOf("registry.applyToClient(client)");
    const registerEventsIndex = source.indexOf("registerEvents(client");
    expect(applyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(registerEventsIndex);
  });

  it("uses the non-deprecated ready event name", async () => {
    const source = await readFile(fromProjectRoot("src", "events", "ready.ts"), "utf8");

    // discord.js v14 deprecated `ready` in favour of `clientReady`; v15 removes
    // the old name entirely.
    expect(source).toContain('name: "clientReady"');
    expect(source).not.toContain('name: "ready"');
  });

  it("documents the ready file by its emitted event name", async () => {
    const files = await readFile(path.join(fromProjectRoot("src", "events"), "ready.ts"), "utf8");
    expect(files).toContain("clientReady");
  });
});
