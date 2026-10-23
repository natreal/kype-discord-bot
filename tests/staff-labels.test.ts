/**
 * Staff labels: the two overrides `/staff` reads to name its groups.
 *
 * The properties worth pinning are the ones a "just add a column" change would get
 * wrong:
 *
 *   1. a rename is presentation only — it must not touch a class's permissions;
 *   2. the resolution order is per-role label → server-wide rename → built-in name;
 *   3. an empty or whitespace override falls through instead of rendering blank;
 *   4. a role's label is written to *all* its bindings, so one role cannot show two
 *      names under two headings.
 */
import { describe, expect, it } from "vitest";

import {
  PermissionClassStore,
  classLabel,
  builtInPermissionClass,
} from "../src/services/authorization/index.js";
import { testLogger } from "./helpers/logger.js";
import { memoryPermissionClasses } from "./helpers/v3-harness.js";
import { readRename } from "../src/utils/presenters.js";

const GUILD = "111111111111111111";
const ROLE_A = "222222222222222222";
const ROLE_B = "333333333333333333";

/** A store over a fresh in-memory repository. */
function harness() {
  const repository = memoryPermissionClasses();
  const store = new PermissionClassStore({ logger: testLogger, repository });
  return { repository, store };
}

describe("classLabel", () => {
  it("prefers the per-role label over every other name", () => {
    const definition = builtInPermissionClass("administrator");
    expect(definition).toBeDefined();

    expect(classLabel({ ...definition!, displayName: "Server Leads" }, "Leads")).toBe("Leads");
  });

  it("falls back to the server-wide rename when there is no per-role label", () => {
    const definition = builtInPermissionClass("administrator");

    expect(classLabel({ ...definition!, displayName: "Server Leads" })).toBe("Server Leads");
    expect(classLabel({ ...definition!, displayName: "Server Leads" }, null)).toBe("Server Leads");
  });

  it("falls back to the built-in name when no override is set", () => {
    expect(classLabel({ name: "Administrator" })).toBe("Administrator");
    expect(classLabel({ name: "Administrator", displayName: undefined }, "")).toBe("Administrator");
  });

  it("ignores a blank override, so a stray space cannot blank a heading", () => {
    expect(classLabel({ name: "Moderator", displayName: "   " })).toBe("Moderator");
    expect(classLabel({ name: "Moderator", displayName: "Staff" }, "  ")).toBe("Staff");
  });
});

describe("staff labels through the permission class store", () => {
  it("renames a class without changing what it grants", async () => {
    const { store } = harness();
    const before = await store.list(GUILD);
    const administrator = before.find((definition) => definition.key === "administrator");
    expect(administrator).toBeDefined();

    await store.setClassDisplayName(GUILD, "administrator", "Server Leads");

    const after = await store.list(GUILD);
    const renamed = after.find((definition) => definition.key === "administrator");
    expect(renamed?.displayName).toBe("Server Leads");
    // The label is cosmetic: the permission set is byte-for-byte unchanged.
    expect(renamed?.permissions).toEqual(administrator?.permissions);
    expect(classLabel(renamed!)).toBe("Server Leads");
  });

  it("clears a rename back to the built-in name", async () => {
    const { store } = harness();
    await store.setClassDisplayName(GUILD, "moderator", "Mods");

    await store.setClassDisplayName(GUILD, "moderator", null);

    const moderator = (await store.list(GUILD)).find((entry) => entry.key === "moderator");
    expect(moderator?.displayName).toBeUndefined();
    expect(classLabel(moderator!)).toBe("Moderator");
  });

  it("keeps a rename scoped to its own guild", async () => {
    const { store } = harness();
    await store.setClassDisplayName(GUILD, "helper", "Helpers");

    const other = (await store.list("999999999999999999")).find((entry) => entry.key === "helper");

    expect(other?.displayName).toBeUndefined();
  });

  it("applies one label to every binding a role holds", async () => {
    const { store } = harness();
    await store.bindRole(GUILD, ROLE_A, "administrator");
    await store.bindRole(GUILD, ROLE_A, "moderator");

    await store.setBindingLabel(GUILD, ROLE_A, "Leads");

    const bindings = await store.listBindings(GUILD);
    expect(bindings).toHaveLength(2);
    expect(bindings.every((binding) => binding.label === "Leads")).toBe(true);
  });

  it("labels only the targeted role", async () => {
    const { store } = harness();
    await store.bindRole(GUILD, ROLE_A, "moderator");
    await store.bindRole(GUILD, ROLE_B, "moderator");

    await store.setBindingLabel(GUILD, ROLE_A, "Leads");

    const bindings = await store.listBindings(GUILD);
    const byRole = new Map(bindings.map((binding) => [binding.roleId, binding.label]));
    expect(byRole.get(ROLE_A)).toBe("Leads");
    expect(byRole.get(ROLE_B)).toBeNull();
  });

  it("clears a label with null", async () => {
    const { store } = harness();
    await store.bindRole(GUILD, ROLE_A, "support");
    await store.setBindingLabel(GUILD, ROLE_A, "Tickets");

    await store.setBindingLabel(GUILD, ROLE_A, null);

    const [binding] = await store.listBindings(GUILD);
    expect(binding?.label).toBeNull();
  });

  it("refuses to rename a class that does not exist", async () => {
    const { store } = harness();

    await expect(store.setClassDisplayName(GUILD, "not-a-class", "Oops")).rejects.toThrow(
      /Unknown power level/,
    );
  });
});

describe("readRename", () => {
  it("accepts a trimmed name", () => {
    expect(readRename("  Server Leads  ", false)).toEqual({ name: "Server Leads" });
  });

  it("treats the literal word reset as a reset", () => {
    expect(readRename("reset", false)).toEqual({ name: null });
    expect(readRename("RESET", false)).toEqual({ name: null });
  });

  it("treats the reset flag as a reset", () => {
    expect(readRename(null, true)).toEqual({ name: null });
  });

  it("rejects giving both a name and a reset, instead of silently picking one", () => {
    const result = readRename("Leads", true);
    expect("error" in result).toBe(true);
  });

  it("rejects neither", () => {
    expect("error" in readRename(null, false)).toBe(true);
    expect("error" in readRename("   ", false)).toBe(true);
  });

  it("rejects a mention and a line break", () => {
    expect("error" in readRename("@Leads", false)).toBe(true);
    expect("error" in readRename("Leads\nModerator", false)).toBe(true);
  });
});
