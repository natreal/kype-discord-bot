/**
 * V3 diagnostics tests.
 *
 * The framework must be honest: healthy servers report healthy, a real problem is
 * detected and named, several problems are all reported, and a check that throws
 * does not take the report down with it. No metric is asserted that production
 * code does not actually measure.
 */
import { describe, expect, it } from "vitest";
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from "discord.js";

import {
  BUILT_IN_DIAGNOSTICS,
  DiagnosticRegistry,
  buildDiagnosticReport,
  describeVerdict,
  type Diagnostic,
  type DiagnosticContext,
} from "../../src/diagnostics/index.js";
import { RECOMMENDED_PERMISSIONS } from "../../src/services/permissions/index.js";
import { SETUP_RESOURCES } from "../../src/modules/setup/setup-resources.js";
import { SetupResourceService } from "../../src/modules/setup/setup-resource.service.js";
import { ModerationService } from "../../src/modules/moderation/moderation.service.js";
import { desiredMuteRoleBitfield } from "../../src/modules/moderation/mute-role.spec.js";
import { moderationMuteRoleDiagnostic } from "../../src/diagnostics/checks/moderation.checks.js";
import { CommandRegistry } from "../../src/commands/command.registry.js";
import {
  CommandDeploymentService,
  MemoryCommandDeploymentRepository,
} from "../../src/services/deployment/index.js";
import { fakeDiscord } from "../helpers/fake-guild.js";
import {
  fakeMemberActions,
  memoryCaseRepository,
  type FakeMuteRole,
} from "../helpers/moderation.js";
import { memoryResourceRepository } from "../helpers/setup-resources.js";
import { testLogger } from "../helpers/logger.js";
import {
  GUILD_A,
  GUILD_B,
  createV3Harness,
  v3Guild,
  type V3Harness,
} from "../helpers/v3-harness.js";

const INSTALLED = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

/** Discord ID of the log channel present in every test guild. */
const LOG_CHANNEL_ID = "900000000000000001";
/** The security channel, beside the log one: a healthy V5 server has both. */
const SECURITY_CHANNEL_ID = "900000000000000002";
/** The Muted role a healthy server carries, already matching the specification. */
const MUTE_ROLE_ID = "role-muted";

/** Builds a diagnostic context backed by the V3 harness and a fake guild. */
async function contextFor(
  harness: V3Harness,
  options: {
    guildId?: string;
    botPermissions?: readonly bigint[];
    resources?: SetupResourceService | null;
    /** Moderation collaborators; omitted means "not wired in this context". */
    moderation?: DiagnosticContext["moderation"];
    /**
     * Slash-command deployment; omitted means "not wired in this context".
     *
     * Defaults to a fake that reports every command as present, so the existing
     * "a healthy server is healthy" test keeps asserting exactly that instead of
     * failing on a check that cannot be satisfied without a Discord connection.
     */
    deployment?: DiagnosticContext["deployment"];
  } = {},
): Promise<DiagnosticContext> {
  const guildId = options.guildId ?? GUILD_A;
  const guild = v3Guild({
    guildId,
    botPermissions: options.botPermissions ?? INSTALLED,
    // A guild always has a log channel in these tests: the resource checks read
    // it through the same cache the moderation delivery check uses. The security
    // channel is seeded for the same reason: a healthy V5 server has one.
    channels: [
      { id: LOG_CHANNEL_ID, name: "server-logs", type: ChannelType.GuildText, parentId: null },
      {
        id: SECURITY_CHANNEL_ID,
        name: "bot-security",
        type: ChannelType.GuildText,
        parentId: null,
      },
    ],
    // The `Muted` role must exist for the moderation checks to pass, and its
    // position must be below the bot's, which the stub reports as 50. The
    // `Quarantined` role is the security module's equivalent.
    //
    // Its permissions are the correct specification, not zero: a role that still
    // allowed Send Messages would leave a moderator's mute looking successful while
    // the member kept posting, and the check now reports exactly that. `INSTALLED`
    // covers every bit the spec needs the bot to be able to write.
    roles: [
      {
        id: MUTE_ROLE_ID,
        name: "Muted",
        position: 2,
        permissions: desiredMuteRoleBitfield(0n),
      },
      { id: "role-quarantined", name: "Quarantined", position: 1 },
    ],
  });

  for (const name of ["setup", "settings", "diagnostics"]) {
    harness.registerCommand(name);
  }

  const resources = options.resources ?? null;

  return {
    guild,
    client: {
      isReady: () => true,
      user: { username: "test-bot" },
      guilds: { cache: new Map([[guildId, guild]]) },
      ws: { ping: 42 },
      commands: harness.commands,
    } as unknown as DiagnosticContext["client"],
    database: {
      health: () => Promise.resolve({ ok: true, latencyMs: 8 }),
      prisma: { auditEvent: { count: () => Promise.resolve(0) } },
    } as unknown as DiagnosticContext["database"],
    config: harness.config,
    permissions: harness.permissions,
    authorization: harness.authorization,
    setupResources: SETUP_RESOURCES,
    setupContext: resources
      ? {
          definitions: SETUP_RESOURCES,
          resources,
          permissionService: { missingBotPermissions: () => [] } as never,
        }
      : null,
    moderation: options.moderation ?? null,
    deployment: options.deployment ?? healthyDeployment(),
    logger: testLogger,
    uptimeMs: 12_345,
    // A healthy V5 deployment has the `MessageContent` intent, which is what the
    // automod check looks for.
    hasMessageContentIntent: true,
    commands: harness.commands,
  };
}

/**
 * A deployment service that behaves like a correctly deployed server.
 *
 * Built from the real service so the checks exercise their actual logic (including
 * the fingerprint comparison the coverage check relies on) against a fake REST
 * client instead of a stubbed answer. `GET` returns the expected command names, so
 * `deployment.guild` legitimately passes.
 */
function healthyDeployment(): NonNullable<DiagnosticContext["deployment"]> {
  const registry = new CommandRegistry();
  registry.register({
    kind: "slash",
    name: "ping",
    description: "Ping",
    category: "core",
    meta: { name: "ping", description: "Ping", category: "core" },
    permissions: {},
    guildOnly: true,
    deploy: true,
    data: { toJSON: () => ({ name: "ping", description: "Ping" }) },
    execute: () => Promise.resolve(),
  } as never);

  const repository = new MemoryCommandDeploymentRepository();
  const service = new CommandDeploymentService({
    token: "test-token",
    clientId: "123456789012345678",
    registry,
    repository,
    logger: testLogger,
    rest: {
      put: () => Promise.resolve(undefined),
      get: async () => [{ name: "ping" }],
    },
  });

  // Seed the record from the service's *own* fingerprint, so the fixture cannot
  // drift from the payload the checks compare against: this context describes a
  // server that has already been deployed to.
  for (const guildId of [GUILD_A, GUILD_B]) {
    void repository.save({
      guildId,
      fingerprint: service.fingerprint(),
      commandCount: service.globalBody().length,
      source: "startup",
    });
  }

  return service;
}

/**
 * Builds a moderation context over the in-memory harness.
 *
 * The service is the real one, backed by an in-memory case repository and a fake
 * member adapter, so a moderation check reports what the module would actually
 * do rather than a stubbed answer.
 */
function moderationContext(
  harness: V3Harness,
  options: { muteRole?: FakeMuteRole | null } = {},
): NonNullable<DiagnosticContext["moderation"]> {
  const members = fakeMemberActions({ muteRole: options.muteRole ?? null });
  const service = new ModerationService({
    logger: testLogger,
    audit: harness.audit,
    cases: memoryCaseRepository(),
    members,
    settings: (guildId) => harness.config.get(guildId).then((config) => config.moderation),
  });
  return { service, members };
}

/** Builds a setup resource service over the fake Discord adapter. */
function resourceService(guildId = GUILD_A): {
  service: SetupResourceService;
  discord: ReturnType<typeof fakeDiscord>;
  repository: ReturnType<typeof memoryResourceRepository>;
} {
  const discord = fakeDiscord();
  const repository = memoryResourceRepository();
  const service = new SetupResourceService({
    guild: v3Guild({ guildId }),
    repository,
    discord,
    logger: testLogger,
  });
  return { service, discord, repository };
}

/** @returns a registry with every built-in check plus any extras. */
function registryWith(extras: readonly Diagnostic[] = []): DiagnosticRegistry {
  const registry = new DiagnosticRegistry(testLogger);
  registry.registerAll(BUILT_IN_DIAGNOSTICS);
  if (extras.length > 0) {
    registry.registerAll(extras);
  }
  return registry;
}

describe("V3 diagnostics registry", () => {
  it("runs every registered check and reports the count", async () => {
    const harness = createV3Harness();
    const registry = registryWith();

    const run = await registry.runAll(await contextFor(harness));

    expect(run.results.length).toBe(BUILT_IN_DIAGNOSTICS.length);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs only one category on demand", async () => {
    const harness = createV3Harness();
    const registry = registryWith();

    const run = await registry.runCategory("performance", await contextFor(harness));

    expect(run.results.length).toBeGreaterThan(0);
    expect(run.results.every((result) => result.category === "performance")).toBe(true);
  });

  it("rejects a duplicate diagnostic id", () => {
    const registry = new DiagnosticRegistry(testLogger);
    const check: Diagnostic = {
      id: "duplicate",
      category: "core",
      label: "Duplicate",
      run: () =>
        Promise.resolve({
          id: "duplicate",
          category: "core",
          label: "D",
          status: "pass",
          detail: "ok",
        }),
    };

    registry.register(check);
    expect(() => registry.register(check)).toThrow(/Duplicate diagnostic id/);
  });

  it("converts a throwing check into a failure instead of propagating", async () => {
    const harness = createV3Harness();
    const registry = registryWith([
      {
        id: "core.explodes",
        category: "core",
        label: "Exploding check",
        run: () => Promise.reject(new Error("boom")),
      },
    ]);

    const run = await registry.runAll(await contextFor(harness));
    const failed = run.results.find((result) => result.id === "core.explodes");

    expect(failed?.status).toBe("fail");
    expect(failed?.detail).toMatch(/boom/);
  });

  it("lets a future module add a check without touching the command", async () => {
    const harness = createV3Harness();
    const registry = registryWith([
      {
        id: "tickets.module",
        category: "resources",
        label: "Ticket system",
        run: () =>
          Promise.resolve({
            id: "tickets.module",
            category: "resources",
            label: "Ticket system",
            status: "pass",
            detail: "Registered by a future module.",
          }),
      },
    ]);

    const run = await registry.runAll(await contextFor(harness));

    expect(run.results.some((result) => result.id === "tickets.module")).toBe(true);
  });
});

describe("Muted role permission verification", () => {
  it("fails when the role allows Send Messages, and names the permission", async () => {
    // The bug this check exists for: a `Muted` role that permits Send Messages makes
    // `/mute` report success while the member keeps posting.
    const harness = createV3Harness();
    const guild = v3Guild({
      guildId: GUILD_A,
      botPermissions: INSTALLED,
      roles: [
        {
          id: MUTE_ROLE_ID,
          name: "Muted",
          position: 2,
          permissions: PermissionFlagsBits.SendMessages,
        },
      ],
    });

    const result = await moderationMuteRoleDiagnostic.run({
      guild,
      client: null,
      config: harness.config,
    } as unknown as DiagnosticContext);

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("SendMessages");
    expect(result.detail).toContain("can still post");
    // The operator is told which command corrects it, not left to guess.
    expect(result.remediation).toMatch(/\/setup run/);
  });

  it("passes a role that matches the specification", async () => {
    const harness = createV3Harness();
    const guild = v3Guild({
      guildId: GUILD_A,
      botPermissions: INSTALLED,
      roles: [
        {
          id: MUTE_ROLE_ID,
          name: "Muted",
          position: 2,
          permissions: desiredMuteRoleBitfield(0n),
        },
      ],
    });

    const result = await moderationMuteRoleDiagnostic.run({
      guild,
      client: null,
      config: harness.config,
    } as unknown as DiagnosticContext);

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("denies the permissions a mute needs");
  });

  it("warns rather than fails when the role is simply absent", async () => {
    // A server that only uses timeouts is healthy, so a missing role must not be a
    // red failure on every fresh installation.
    const harness = createV3Harness();
    const guild = v3Guild({ guildId: GUILD_A, botPermissions: INSTALLED, roles: [] });

    const result = await moderationMuteRoleDiagnostic.run({
      guild,
      client: null,
      config: harness.config,
    } as unknown as DiagnosticContext);

    expect(result.status).toBe("warn");
    expect(result.remediation).toMatch(/\/setup run/);
  });

  it("tells the operator to grant the bot a permission it cannot write", async () => {
    // `Administrator` is never held by the bot in this fixture, so it cannot be
    // cleared from the role, and the check must say so instead of promising a repair
    // that `/setup run` could not deliver.
    const harness = createV3Harness();
    const guild = v3Guild({
      guildId: GUILD_A,
      botPermissions: INSTALLED,
      roles: [
        {
          id: MUTE_ROLE_ID,
          name: "Muted",
          position: 2,
          permissions: desiredMuteRoleBitfield(0n) | PermissionFlagsBits.Administrator,
        },
      ],
    });

    const result = await moderationMuteRoleDiagnostic.run({
      guild,
      client: null,
      config: harness.config,
    } as unknown as DiagnosticContext);

    expect(result.status).not.toBe("pass");
    expect(result.remediation).toMatch(/[Gg]rant the bot/);
  });

  it("fails when the bot's role is not above the Muted role", async () => {
    const harness = createV3Harness();
    const guild = v3Guild({
      guildId: GUILD_A,
      botPermissions: INSTALLED,
      roles: [
        {
          id: MUTE_ROLE_ID,
          name: "Muted",
          // Above the stub bot's highest role, which is 50.
          position: 99,
          permissions: desiredMuteRoleBitfield(0n),
        },
      ],
    });

    const result = await moderationMuteRoleDiagnostic.run({
      guild,
      client: null,
      config: harness.config,
    } as unknown as DiagnosticContext);

    expect(result.status).not.toBe("pass");
    expect(result.metrics?.botPosition).toBe(50);
  });
});

describe("V3 diagnostics report", () => {
  it("reports a healthy server as healthy", async () => {
    const harness = createV3Harness();
    const registry = registryWith();
    // A fully provisioned server: every tracked resource exists on Discord.
    const { service, discord, repository } = resourceService();
    await repository.remember({
      guildId: GUILD_A,
      key: "information.category",
      type: "CATEGORY",
      discordId: "chan-1",
      name: "INFORMATION",
      config: {},
    });
    discord.seedChannel("INFORMATION", ChannelType.GuildCategory, null, "chan-1");

    // Logging is enabled and the log channel exists, so moderation log delivery
    // is genuinely configured on this "healthy" server rather than failing a
    // check that the test never set up.
    //
    // Security is enabled the same way, and for the same reason: V5 adds a check
    // that warns when the module is off, so a "healthy server" must actually have
    // it on — the check is right and the fixture was incomplete.
    await harness.config.update(
      GUILD_A,
      {
        logging: {
          enabled: true,
          channelId: LOG_CHANNEL_ID,
          securityChannelId: SECURITY_CHANNEL_ID,
        },
        security: {
          enabled: true,
          antiRaid: { enabled: true },
          antiNuke: { enabled: true, stripPermissions: true },
        },
        automod: { enabled: true },
      },
      { id: "tester", kind: "user" },
    );

    const run = await registry.runAll(
      await contextFor(harness, {
        // A correctly installed bot: the whole recommended profile is granted.
        botPermissions: RECOMMENDED_PERMISSIONS.map((permission) =>
          PermissionsBitField.resolve(permission),
        ),
        resources: service,
        moderation: moderationContext(harness, {
          muteRole: { id: "role-muted", name: "Muted", position: 2 },
        }),
      }),
    );
    const report = buildDiagnosticReport(run.results, {
      guildId: GUILD_A,
      durationMs: run.durationMs,
    });

    expect(
      report.results
        .filter((result) => result.status !== "pass")
        .map((result) => `${result.id}: ${result.detail}`),
    ).toEqual([]);
    expect(report.failures).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.verdict).toBe("healthy");
    expect(describeVerdict(report)).toMatch(/passed/);
  });

  it("detects a missing Discord permission and names it", async () => {
    const harness = createV3Harness();
    const registry = registryWith();

    // Manage Roles missing, everything else granted.
    const run = await registry.runAll(
      await contextFor(harness, {
        botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
      }),
    );
    const permissions = run.results.filter((result) => result.category === "permissions");

    expect(permissions.some((result) => result.status !== "pass")).toBe(true);
    expect(permissions.map((result) => result.detail).join(" ")).toMatch(/Manage Roles/);
  });

  it("reports a healthy administrator installation as passing", async () => {
    const harness = createV3Harness();
    const registry = registryWith();

    const run = await registry.runAll(
      await contextFor(harness, { botPermissions: [PermissionFlagsBits.Administrator] }),
    );
    const permissions = run.results.filter((result) => result.category === "permissions");

    expect(permissions.every((result) => result.status === "pass")).toBe(true);
  });

  it("detects a missing setup resource and offers a repair", async () => {
    const harness = createV3Harness();
    const registry = registryWith();
    const { service, discord, repository } = resourceService();

    // A resource is tracked in the database but gone from Discord.
    await repository.remember({
      guildId: GUILD_A,
      key: "information.welcome",
      type: "TEXT_CHANNEL",
      discordId: "chan-gone",
      name: "welcome",
      config: {},
    });
    discord.deleteChannel("chan-gone");

    const run = await registry.runAll(await contextFor(harness, { resources: service }));
    const resources = run.results.find((result) => result.id === "resources.setup");

    expect(resources?.status).toBe("warn");
    expect(resources?.detail).toMatch(/information\.welcome/);
    expect(resources?.remediation).toMatch(/setup repair/);
    expect(resources?.metrics?.["missing"]).toBe(1);
  });

  it("detects invalid guild configuration", async () => {
    const harness = createV3Harness();
    const registry = registryWith();
    await harness.database.configRepository.save(
      GUILD_A,
      "moderation",
      { warnThreshold: "nonsense" },
      null,
    );

    const run = await registry.runAll(await contextFor(harness));
    const configuration = run.results.find((result) => result.id === "configuration.guild");

    expect(configuration?.status).toBe("warn");
    expect(configuration?.detail).toMatch(/required repair/);
  });

  it("reports a database failure instead of inventing a latency", async () => {
    const harness = createV3Harness();
    const registry = registryWith();
    const context = await contextFor(harness);
    const broken: DiagnosticContext = {
      ...context,
      database: {
        health: () => Promise.resolve({ ok: false, latencyMs: 0 }),
        prisma: { auditEvent: { count: () => Promise.reject(new Error("relation missing")) } },
      } as unknown as DiagnosticContext["database"],
    };

    const run = await registry.runAll(broken);
    const database = run.results.find((result) => result.id === "core.database");
    const prisma = run.results.find((result) => result.id === "core.prisma");
    const latency = run.results.find((result) => result.id === "performance.database");

    expect(database?.status).toBe("fail");
    expect(prisma?.status).toBe("fail");
    expect(prisma?.remediation).toMatch(/db:migrate:deploy/);
    // The latency check fails rather than reporting a fabricated number.
    expect(latency?.status).toBe("fail");
    expect(latency?.metrics).toBeUndefined();
  });

  it("reports several simultaneous failures together", async () => {
    const harness = createV3Harness();
    const registry = registryWith();
    const context = await contextFor(harness, { botPermissions: [] });
    const degraded: DiagnosticContext = {
      ...context,
      database: {
        health: () => Promise.resolve({ ok: false, latencyMs: 0 }),
        prisma: { auditEvent: { count: () => Promise.reject(new Error("relation missing")) } },
      } as unknown as DiagnosticContext["database"],
    };

    const run = await registry.runAll(degraded);
    const report = buildDiagnosticReport(run.results, { guildId: GUILD_A });

    expect(report.verdict).toBe("failing");
    expect(report.failures).toBeGreaterThan(1);
    expect(report.issues).toBeGreaterThan(1);
    // Every failure carries a reason, which is what makes the report actionable.
    expect(
      report.results
        .filter((result) => result.status === "fail")
        .every((result) => result.detail.length > 0),
    ).toBe(true);
  });

  it("keeps diagnostics scoped to the guild under test", async () => {
    const harness = createV3Harness();
    const registry = registryWith();

    // Only guild B has broken configuration.
    await harness.database.configRepository.save(
      GUILD_B,
      "moderation",
      { warnThreshold: "bad" },
      null,
    );

    const forA = await registry.runAll(await contextFor(harness, { guildId: GUILD_A }));
    const configurationA = forA.results.find((result) => result.id === "configuration.guild");

    expect(configurationA?.status).toBe("pass");
  });
});
