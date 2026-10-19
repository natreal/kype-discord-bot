/**
 * Member onboarding tests.
 *
 * The suite covers the gap this module closes: the `members` configuration
 * section existed since V3 with `welcomeEnabled`, `welcomeChannelId`,
 * `welcomeMessage` and `autoRoleIds`, but nothing read them, so a join performed
 * no onboarding at all. Each test proves one guarantee the fix must keep:
 *
 *   1. **auto-roles are applied** — every configured, manageable role is granted;
 *   2. **one bad role does not sink the others** — an unmanageable or failing role
 *      is skipped and reported, and the rest still apply;
 *   3. **the welcome is posted only when fully configured** — a half-configured
 *      account posts nothing rather than nowhere;
 *   4. **placeholders render** — `{user}`, `{guild}`, `{count}`;
 *   5. **a join never throws** — a misconfiguration or a Discord failure is
 *      captured in the outcome, because anti-raid and logging still have to run;
 *   6. **the module is registered** so the inventory lists it.
 */
import { describe, expect, it } from "vitest";

import { MemberOnboardingService, renderWelcome } from "../../src/modules/members/index.js";
import { AuditEventService } from "../../src/services/audit/index.js";
import { membersModule } from "../../src/modules/members/members.module.js";
import { botModules } from "../../src/modules/registry.js";
import type { ModuleContext } from "../../src/modules/module.types.js";
import { testLogger } from "../helpers/logger.js";
import { fakeMemberActions, membersConfig } from "../helpers/members.js";

const GUILD = "111111111111111111";
const USER = "222222222222222222";
const ROLE_A = "333333333333333333";
const ROLE_B = "444444444444444444";

/** Builds a service over fresh fakes, with a configurable `members` section. */
function harness(config = membersConfig()) {
  const actions = fakeMemberActions();
  const auditActions: string[] = [];

  const audit = new AuditEventService(testLogger, {
    append(event) {
      auditActions.push(event.action);
    },
    list: () => Promise.resolve([]),
  });

  const service = new MemberOnboardingService({
    logger: testLogger,
    actions,
    settings: () => Promise.resolve(config),
    audit,
  });

  return { actions, service, auditActions, config };
}

/** The join request every test uses unless it needs different facts. */
function request(overrides: Partial<{ memberCount: number; guildName: string }> = {}) {
  return {
    guildId: GUILD,
    guildName: overrides.guildName ?? "Test Guild",
    userId: USER,
    userTag: "newcomer#0001",
    memberCount: overrides.memberCount ?? 42,
  };
}

describe("MemberOnboardingService auto-roles", () => {
  it("applies every configured role the bot can manage", async () => {
    const { actions, service } = harness(membersConfig({ autoRoleIds: [ROLE_A, ROLE_B] }));
    actions.setManageable([ROLE_A, ROLE_B]);

    const outcome = await service.onboard(request());

    expect(outcome.rolesApplied).toEqual([ROLE_A, ROLE_B]);
    expect(outcome.rolesSkipped).toEqual([]);
    expect(actions.granted.get(USER)).toEqual([ROLE_A, ROLE_B]);
    expect(outcome.welcomed).toBe(false);
  });

  it("does nothing when no role is configured", async () => {
    const { actions, service } = harness();

    const outcome = await service.onboard(request());

    expect(outcome.rolesApplied).toEqual([]);
    expect(actions.granted.size).toBe(0);
    expect(actions.attempts).toEqual([]);
  });

  it("skips a role the bot cannot manage and still applies the others", async () => {
    const { actions, service } = harness(membersConfig({ autoRoleIds: [ROLE_A, ROLE_B] }));
    // Only ROLE_A is manageable; ROLE_B is above the bot or integration-owned.
    actions.setManageable([ROLE_A]);

    const outcome = await service.onboard(request());

    expect(outcome.rolesApplied).toEqual([ROLE_A]);
    expect(outcome.rolesSkipped).toEqual([
      { roleId: ROLE_B, detail: "role is not manageable by the bot" },
    ]);
    // The unmanageable role was never attempted: no point calling Discord.
    expect(actions.attempts).toEqual([{ userId: USER, roleId: ROLE_A }]);
  });

  it("reports a role that fails to apply without aborting the rest", async () => {
    const { actions, service } = harness(membersConfig({ autoRoleIds: [ROLE_A, ROLE_B] }));
    actions.setManageable([ROLE_A, ROLE_B]);
    actions.failRole(ROLE_B, "I am missing the required permission");

    const outcome = await service.onboard(request());

    expect(outcome.rolesApplied).toEqual([ROLE_A]);
    expect(outcome.rolesSkipped).toEqual([
      { roleId: ROLE_B, detail: "I am missing the required permission" },
    ]);
  });
});

describe("MemberOnboardingService welcome", () => {
  it("posts the welcome when enabled and a channel is set", async () => {
    const { actions, service, config } = harness(
      membersConfig({
        welcomeEnabled: true,
        welcomeChannelId: "555555555555555555",
        welcomeMessage: "Welcome {user} to {guild} — member #{count}!",
      }),
    );

    const outcome = await service.onboard(request({ memberCount: 7 }));

    expect(outcome.welcomed).toBe(true);
    expect(actions.welcomes).toHaveLength(1);
    expect(actions.welcomes[0]?.channelId).toBe(config.welcomeChannelId);
    expect(actions.welcomes[0]?.content).toBe(`Welcome <@${USER}> to Test Guild — member #7!`);
  });

  it("does not post when the toggle is off, even with a channel set", async () => {
    const { actions, service } = harness(
      membersConfig({ welcomeEnabled: false, welcomeChannelId: "555555555555555555" }),
    );

    const outcome = await service.onboard(request());

    expect(outcome.welcomed).toBe(false);
    expect(actions.welcomes).toEqual([]);
  });

  it("does not post when enabled but no channel is set", async () => {
    // The classic half-configured state: turning the welcome on before choosing a
    // channel must not post anywhere.
    const { actions, service } = harness(
      membersConfig({ welcomeEnabled: true, welcomeChannelId: null }),
    );

    const outcome = await service.onboard(request());

    expect(outcome.welcomed).toBe(false);
    expect(actions.welcomes).toEqual([]);
  });

  it("records a welcome failure without throwing", async () => {
    const channel = "555555555555555555";
    const { actions, service } = harness(
      membersConfig({ welcomeEnabled: true, welcomeChannelId: channel }),
    );
    actions.failChannel(channel, "it no longer exists");

    const outcome = await service.onboard(request());

    expect(outcome.welcomed).toBe(false);
    expect(actions.welcomes).toEqual([]);
  });

  it("still applies roles when the welcome channel is broken", async () => {
    const channel = "555555555555555555";
    const { actions, service } = harness(
      membersConfig({ welcomeEnabled: true, welcomeChannelId: channel, autoRoleIds: [ROLE_A] }),
    );
    actions.setManageable([ROLE_A]);
    actions.failChannel(channel);

    const outcome = await service.onboard(request());

    expect(outcome.rolesApplied).toEqual([ROLE_A]);
    expect(outcome.welcomed).toBe(false);
  });
});

describe("MemberOnboardingService resilience", () => {
  it("returns an empty outcome when configuration cannot be read", async () => {
    const actions = fakeMemberActions();
    const service = new MemberOnboardingService({
      logger: testLogger,
      actions,
      settings: () => Promise.reject(new Error("database down")),
    });

    const outcome = await service.onboard(request());

    expect(outcome).toEqual({ rolesApplied: [], rolesSkipped: [], welcomed: false });
    expect(actions.attempts).toEqual([]);
  });
});

describe("renderWelcome", () => {
  it("substitutes the three supported placeholders", () => {
    const rendered = renderWelcome("{user} joined {guild} (#{count})", request({ memberCount: 3 }));
    expect(rendered).toBe(`<@${USER}> joined Test Guild (#3)`);
  });

  it("replaces repeated placeholders", () => {
    expect(renderWelcome("{user} {user}", request())).toBe(`<@${USER}> <@${USER}>`);
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderWelcome("Hello {not-a-thing}", request())).toBe("Hello {not-a-thing}");
  });
});

describe("members module registration", () => {
  it("is listed in the module registry", () => {
    expect(botModules.map((module) => module.name)).toContain("members");
    expect(membersModule.name).toBe("members");
  });

  it("reports enabled only when something is configured", () => {
    const context = (config: ReturnType<typeof membersConfig>) =>
      ({ config: { members: config } }) as unknown as ModuleContext;

    expect(membersModule.enabled(context(membersConfig()))).toBe(false);
    expect(membersModule.enabled(context(membersConfig({ welcomeEnabled: true })))).toBe(true);
    expect(membersModule.enabled(context(membersConfig({ autoRoleIds: [ROLE_A] })))).toBe(true);
  });
});
