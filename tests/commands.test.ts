/**
 * Command discovery tests.
 *
 * Discovery is the mechanism that lets hundreds of commands be added without
 * touching the bootstrap, so it is tested directly against fixture directories
 * and against the real `src/commands` tree.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCommands } from "../../src/commands/command.loader.js";
import { fromProjectRoot } from "../../src/utils/fs.js";
import { testLogger } from "../helpers/logger.js";

/**
 * Fixtures live inside the project so the loader's real dynamic `import()` can
 * resolve `discord.js` from the project's `node_modules`.
 */
const FIXTURE_ROOT = fromProjectRoot("tests", ".fixtures");

/** A minimal but complete command module. */
function commandSource(category: string, name: string): string {
  return `import { SlashCommandBuilder } from "discord.js";
import { defineSlashCommand } from "../../../src/commands/define.js";

export default defineSlashCommand({
  meta: { name: "${name}", description: "Fixture command.", category: "${category}" },
  data: new SlashCommandBuilder().setName("${name}").setDescription("Fixture command."),
  execute: async () => undefined,
});
`;
}

describe("command discovery", () => {
  beforeEach(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  async function writeFixture(relativePath: string, contents: string): Promise<void> {
    const target = path.join(FIXTURE_ROOT, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  it("discovers nested commands and assigns categories from folders", async () => {
    await writeFixture("core/fixture-one.ts", commandSource("core", "fixture-one"));
    await writeFixture("utility/deeply/fixture-two.ts", commandSource("utility", "fixture-two"));

    const report = await loadCommands({ directory: FIXTURE_ROOT, logger: testLogger });

    expect(report.failures).toEqual([]);
    expect(report.commands.map((command) => command.name).sort()).toEqual([
      "fixture-one",
      "fixture-two",
    ]);
    expect(report.commands.map((command) => command.category).sort()).toEqual(["core", "utility"]);
  });

  it("ignores infrastructure files, test files and non-modules", async () => {
    await writeFixture("utility/fixture.ts", commandSource("utility", "fixture"));
    await writeFixture("utility/_shared.ts", "export const helper = true;\n");
    await writeFixture("utility/fixture.test.ts", "export default {};\n");
    await writeFixture("README.md", "not a module\n");

    const report = await loadCommands({ directory: FIXTURE_ROOT, logger: testLogger });

    expect(report.failures).toEqual([]);
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]?.name).toBe("fixture");
  });

  it("fails when a file declares a category that does not match its folder", async () => {
    await writeFixture("core/mismatch.ts", commandSource("utility", "mismatch"));

    const report = await loadCommands({ directory: FIXTURE_ROOT, logger: testLogger });

    expect(report.commands).toHaveLength(0);
    expect(report.failures).toHaveLength(1);
  });

  it("reports an invalid module shape instead of registering it", async () => {
    await writeFixture("core/invalid.ts", "export default { name: 'invalid' };\n");

    const report = await loadCommands({ directory: FIXTURE_ROOT, logger: testLogger });

    expect(report.commands).toHaveLength(0);
    expect(report.failures).toHaveLength(1);
  });

  it("returns an empty report for a missing directory", async () => {
    const report = await loadCommands({
      directory: path.join(FIXTURE_ROOT, "does-not-exist"),
      logger: testLogger,
    });

    expect(report.commands).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});
