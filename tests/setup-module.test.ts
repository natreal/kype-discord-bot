/**
 * Setup module and registry tests.
 *
 * Guards two things that are easy to break silently:
 *   - the resource registry (duplicate keys, dangling `requires`, naming rules);
 *   - the bot permission preflight, which must fail *loudly and early* when the bot
 *     cannot do its job, instead of creating half a structure.
 */
import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord.js";

import {
  SETUP_RESOURCES,
  SETUP_RESOURCE_KEYS,
  SETUP_RESOURCE_PROBLEMS,
  findSetupResource,
  provisionableResources,
  validateSetupResources,
} from "../../src/modules/setup/setup-resources.js";
import {
  getGuildSetupHarness,
  INSTALLED_BOT_PERMISSIONS,
} from "../helpers/setup-module-harness.js";

describe("setup resource registry", () => {
  it("is internally consistent", () => {
    expect(SETUP_RESOURCE_PROBLEMS).toEqual([]);
  });

  it("declares exactly the managed resources, and nothing for unbuilt modules", () => {
    expect(SETUP_RESOURCES.map((resource) => resource.key)).toEqual([
      SETUP_RESOURCE_KEYS.informationCategory,
      SETUP_RESOURCE_KEYS.welcomeChannel,
      SETUP_RESOURCE_KEYS.rulesChannel,
      SETUP_RESOURCE_KEYS.logsCategory,
      SETUP_RESOURCE_KEYS.serverLogsChannel,
      SETUP_RESOURCE_KEYS.mutedRole,
    ]);
    // The Muted role is the one role a shipped module actually consumes, so it is the
    // only `ROLE` resource. Ticket, security and AI resources stay undeclared: a
    // resource no feature reads is a channel or role nobody can use.
    expect(SETUP_RESOURCES.filter((resource) => resource.type === "ROLE").map((r) => r.key)).toEqual(
      [SETUP_RESOURCE_KEYS.mutedRole],
    );
    expect(SETUP_RESOURCES.map((resource) => resource.key).join(" ")).not.toMatch(/ticket|security|ai/);
  });

  it("declares the Muted role with the permissions that make a mute effective", () => {
    const muted = findSetupResource(SETUP_RESOURCE_KEYS.mutedRole);
    expect(muted?.type).toBe("ROLE");
    expect(muted?.name).toBe("muted");
    // A role's `permissions` field is its allow list, so the spec denies a permission
    // by *omitting* it from `rolePermissions`.
    expect(muted?.rolePermissions).toContain(PermissionFlagsBits.SendMessages);
    expect(muted?.rolePermissions).toContain(PermissionFlagsBits.SendMessagesInThreads);
    // It must never be provisioned as a channel overwrite: role permissions and
    // channel overwrites are different Discord APIs.
    expect(muted?.permissions).toBeUndefined();
  });

  it("provisions the log channel once logging is on, and tracks it otherwise", () => {
    // V4 changed this deliberately: the log channel was tracked but never created
    // while no delivery existed. Delivery now exists (the moderation log sink),
    // so the resource is provisionable, and `/setup validate` reports the
    // difference between "logging off" and "logging on without a channel".
    expect(findSetupResource(SETUP_RESOURCE_KEYS.serverLogsChannel)?.provisionable).toBe(true);
    expect(provisionableResources().map((resource) => resource.key)).toContain(
      SETUP_RESOURCE_KEYS.serverLogsChannel,
    );
  });

  it("never declares Administrator in any permission rule", () => {
    for (const resource of SETUP_RESOURCES) {
      for (const rule of resource.permissions ?? []) {
        expect(rule.allow ?? []).not.toContain(PermissionFlagsBits.Administrator);
      }
    }
  });

  it("detects duplicate keys and dangling dependencies", () => {
    const problems = validateSetupResources([
      { key: "a", type: "CATEGORY", name: "A", label: "A" },
      { key: "a", type: "CATEGORY", name: "A2", label: "A2" },
      { key: "b", type: "TEXT_CHANNEL", name: "b", label: "b", category: "A", requires: ["nope"] },
    ]);

    expect(problems).toContain("duplicate resource key: a");
    expect(problems.some((problem) => problem.includes("unknown resource"))).toBe(true);
  });
});

describe("bot permission preflight", () => {
  it("passes for a correctly installed bot and reports what it checked", async () => {
    const { service, guild } = getGuildSetupHarness();

    const report = await service.run(guild, "all");
    const preflight = report.results.find((entry) => entry.key === "setup.bot-permissions");

    expect(preflight?.status).toBe("reused");
    expect(preflight?.detail).toContain("resource(s) checked");
  });

  it("fails fast with an actionable reason when the bot lacks ManageChannels", async () => {
    const { service, guild, discord } = getGuildSetupHarness([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageRoles,
    ]);

    const report = await service.run(guild, "all");
    const preflight = report.results.find((entry) => entry.key === "setup.bot-permissions");

    expect(preflight?.status).toBe("failed");
    expect(preflight?.detail).toContain("Missing permissions");
    // The relevant operation stops safely: resources whose parent is unavailable are
    // skipped rather than created in a partially-permissioned state.
    expect(discord.created).toEqual([]);
    expect(report.results.some((entry) => entry.status === "skipped")).toBe(true);
  });

  it("does not block setup when the bot member is not cached yet", async () => {
    const harness = getGuildSetupHarness(INSTALLED_BOT_PERMISSIONS);
    // The preflight reads the guild from the setuper it was built with, so an
    // uncached bot member is simulated on that same object.
    const guild = harness.guild as unknown as { members: { me: unknown } };
    const original = guild.members.me;
    guild.members.me = null;

    try {
      const report = await harness.service.run(harness.guild, "all");
      const preflight = report.results.find((entry) => entry.key === "setup.bot-permissions");

      // Discord enforces the real permission at the API boundary, so setup proceeds
      // and reports the uncertainty rather than refusing to try.
      expect(preflight?.status).toBe("skipped");
      expect(preflight?.detail).toContain("not cached");
    } finally {
      guild.members.me = original;
    }
  });
});
