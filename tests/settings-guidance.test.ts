/**
 * Settings guidance tests.
 *
 * The bot's own messages tell administrators how to change a setting, and those
 * messages are the only documentation a server owner reads. They historically
 * drifted: security and automod settings once lived in their own subcommand groups
 * (`/settings security set`, `/settings automod set`), but `/settings` was
 * reworked to one category-driven shape — `/settings set area:<category>
 * setting:<name> value:<value>` — and the guidance must match that, or a quoted
 * command autocompletes to nothing and the setting looks like a missing feature.
 *
 * These tests assert every quoted invocation against the real command definition,
 * so a message cannot advertise a subcommand, area or setting that does not exist.
 */
import { describe, expect, it } from "vitest";

import settingsCommand, { SETTINGS } from "../src/commands/utility/settings.js";
import { readFileSync } from "node:fs";

type OptionNode = {
  name: string;
  type: number;
  options?: OptionNode[];
  choices?: { name: string; value: string }[];
};

/** The `/settings` builder as plain JSON. */
function settingsJson(): { options?: OptionNode[] } {
  return settingsCommand.data.toJSON() as { options?: OptionNode[] };
}

/** The registered `/settings` subcommand paths (there are no groups anymore). */
function registeredPaths(): Set<string> {
  const paths = new Set<string>();
  // type 1 is SUBCOMMAND, type 2 is SUBCOMMAND_GROUP.
  for (const option of settingsJson().options ?? []) {
    if (option.type === 1) {
      paths.add(`settings ${option.name}`);
    }
  }
  return paths;
}

/** Every choice offered for the `area` option of the `set` subcommand. */
function areaChoices(): Set<string> {
  const found = new Set<string>();
  const set = (settingsJson().options ?? []).find((option) => option.name === "set");
  for (const option of set?.options ?? []) {
    if (option.name === "area") {
      for (const choice of option.choices ?? []) {
        found.add(choice.value);
      }
    }
  }
  return found;
}

/** Extracts every `/settings ...` invocation quoted in a source file. */
function quotedInvocations(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  // Guidance is what the user is told to type. A reference inside a code comment
  // is documentation for the next reader, not an instruction, so strip comments
  // before scanning.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  return [...withoutComments.matchAll(/`\/settings ([^`]+)`/g)].map((match) =>
    (match[1] ?? "").trim(),
  );
}

describe("settings guidance", () => {
  it("registers one category-driven set command, not per-area groups", () => {
    const paths = registeredPaths();

    expect(paths.has("settings set")).toBe(true);
    expect(paths.has("settings view")).toBe(true);
    expect(paths.has("settings reset")).toBe(true);
    // The old per-area subcommand groups are gone: everything is reached through
    // `/settings set area:<area>` now.
    expect(paths.has("settings security set")).toBe(false);
    expect(paths.has("settings automod set")).toBe(false);
    expect(paths.has("settings moderation")).toBe(false);
  });

  it("offers every area as a category on the set subcommand", () => {
    const areas = areaChoices();
    for (const area of [
      "security",
      "automod",
      "moderation",
      "logging",
      "members",
      "language",
      "tickets",
    ]) {
      expect(areas.has(area)).toBe(true);
    }
  });

  it("exposes the per-member ticket limit under the tickets area", () => {
    const setting = SETTINGS.find((candidate) => candidate.name === "tickets-member-limit");

    expect(setting?.area).toBe("tickets");
  });

  /**
   * The regression: every command the bot tells an administrator to run must be one
   * the bot actually registers, with an area and a setting that exist.
   */
  it("only quotes /settings invocations that exist", () => {
    const files = [
      "../src/commands/security/security.handlers.ts",
      "../src/commands/utility/settings-security.ts",
      "../src/commands/utility/settings-automod.ts",
      "../src/diagnostics/checks/security.checks.ts",
    ];

    const registered = registeredPaths();
    const areas = areaChoices();
    const settingNames = new Set(SETTINGS.map((setting) => setting.name));
    const offenders: string[] = [];

    for (const file of files) {
      for (const invocation of quotedInvocations(file)) {
        // `/settings view area:security` — no setting to check, only the area.
        const areaMatch = /area:([a-z-]+)/.exec(invocation)?.[1];
        const setting = /setting:([a-z-]+)/.exec(invocation)?.[1];

        const subcommand = invocation.split(" ")[0] ?? "";
        const path = `settings ${subcommand}`;

        if (!registered.has(path)) {
          offenders.push(`${file}: /settings ${invocation} (no such subcommand)`);
          continue;
        }

        if (areaMatch && !areas.has(areaMatch)) {
          offenders.push(`${file}: /settings ${invocation} (no such area)`);
          continue;
        }

        if (setting && !settingNames.has(setting)) {
          offenders.push(`${file}: /settings ${invocation} (no such setting)`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
