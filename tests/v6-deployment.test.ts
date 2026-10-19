/**
 * V6 deployment tests.
 *
 * The feature is "a server that adds the bot gets its commands, without an
 * operator running anything". That promise has four failure modes worth testing,
 * and each one is covered here:
 *
 * 1. the payload is wrong (a withheld command deployed anyway, discovery order
 *    changing the fingerprint);
 * 2. deployment is not idempotent (every boot re-registers every guild);
 * 3. a failure is silent or fatal (one bad guild stops the others, an outage stops
 *    startup, a rate limit aborts the run);
 * 4. "deployed" is claimed without checking (a guild whose commands were deleted
 *    by hand is never noticed).
 */
import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../../src/commands/command.registry.js";
import { defineSlashCommand } from "../../src/commands/define.js";
import {
  CommandDeploymentService,
  MemoryCommandDeploymentRepository,
  canonicalize,
  describeError,
  fingerprintOf,
  isRetryable,
  statusOf,
  type DeployableGuild,
  type DeployScope,
} from "../../src/services/deployment/index.js";
import { SlashCommandBuilder } from "discord.js";
import { testLogger } from "../helpers/logger.js";
import { shouldDeployGuildCommandsOnJoin } from "../../src/events/guild-create.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";

/** A slash command, so the service sees realistic data. */
function slashCommand(name: string, options: { deploy?: boolean } = {}) {
  return defineSlashCommand({
    meta: { name, description: `${name} command`, category: "core" },
    data: new SlashCommandBuilder().setName(name).setDescription(`${name} command`),
    ...(options.deploy === undefined ? {} : { deploy: options.deploy }),
    execute: () => Promise.resolve(),
  });
}

/** Builds a registry with the given command names. */
function registryWith(names: readonly string[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const name of names) {
    registry.register(slashCommand(name));
  }
  return registry;
}

interface Harness {
  readonly service: CommandDeploymentService;
  readonly repository: MemoryCommandDeploymentRepository;
  readonly puts: { route: string; body: unknown }[];
  /**
   * Guilds whose next PUT should fail with the given error.
   */
  readonly failures: Map<string, unknown>;
  /**
   * Explicit `GET` responses, keyed by guild ID.
   *
   * When a guild has no entry the fake answers with whatever was last PUT to it,
   * which is what a real deployment produces. That default is deliberate: without
   * it every test would have to describe the *echo* as well as the deployment, and
   * a mistake there would look like a verification bug rather than a fixture bug.
   * Tests that model a manual deletion (or a failed deploy) override it.
   */
  readonly getResponses: Map<string, unknown>;
  /** @returns true when the fake should keep an override despite a PUT. */
  readonly sticky: Set<string>;
}

/** Builds a deployment service over a fake REST client. */
function harness(
  options: {
    commands?: readonly string[];
    devGuildId?: string;
    scope?: DeployScope;
    maxRetries?: number;
    retryBaseMs?: number;
    /** Guilds whose explicit `GET` override must survive a PUT. */
    sticky?: readonly string[];
  } = {},
): Harness {
  const registry = registryWith(options.commands ?? ["ping", "ban"]);
  const repository = new MemoryCommandDeploymentRepository();
  const puts: { route: string; body: unknown }[] = [];
  const failures = new Map<string, unknown>();
  const getResponses = new Map<string, unknown>();
  const sticky = new Set(options.sticky ?? []);
  /** What Discord currently holds per guild, mirroring a real PUT. */
  const published = new Map<string, unknown>();
  /** What the *global* scope holds, mirroring a real global PUT. */
  let publishedGlobally: unknown = [];

  const service = new CommandDeploymentService({
    token: "test-token",
    clientId: "123456789012345678",
    ...(options.devGuildId === undefined ? {} : { devGuildId: options.devGuildId }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    registry,
    repository,
    logger: testLogger,
    concurrency: 2,
    maxRetries: options.maxRetries ?? 0,
    retryBaseMs: options.retryBaseMs ?? 1,
    rest: {
      put: (route, restOptions) => {
        for (const [guildId, error] of failures) {
          if (route.includes(guildId)) {
            return Promise.reject(error);
          }
        }
        puts.push({ route, body: restOptions.body });
        const guildId = guildIdOf(route);
        if (guildId) {
          published.set(guildId, restOptions.body);
          // A real PUT replaces whatever Discord held, so an override describing a
          // deleted command must not survive it — unless a test is modelling a
          // server where the command never appears, which `sticky` expresses.
          if (!sticky.has(guildId)) {
            getResponses.delete(guildId);
          }
        } else {
          publishedGlobally = restOptions.body;
        }
        return Promise.resolve(undefined);
      },
      get: (route: string) => {
        const guildId = guildIdOf(route);
        if (guildId && getResponses.has(guildId)) {
          return Promise.resolve(getResponses.get(guildId));
        }
        if (guildId && published.has(guildId)) {
          return Promise.resolve(published.get(guildId));
        }
        // A global route has no guild ID; answer with the global payload so
        // `verifyGlobal` sees what the fake was actually given.
        if (!guildId && route.includes("/commands")) {
          return Promise.resolve(publishedGlobally);
        }
        return Promise.resolve([]);
      },
    },
  });

  return { service, repository, puts, failures, getResponses, sticky };
}

/**
 * @returns the guild ID inside a guild-scoped route, or `null` for a global one.
 *
 * Parsing the route is what keeps the fake honest: it answers for whichever guild
 * the service actually addressed, so a bug that PUTs to the wrong guild cannot be
 * hidden by a fixture that answers regardless.
 */
function guildIdOf(route: string): string | null {
  const match = /\/guilds\/(\d+)/.exec(route);
  return match?.[1] ?? null;
}

const guildA: DeployableGuild = { id: GUILD_A, name: "Guild A" };
const guildB: DeployableGuild = { id: GUILD_B, name: "Guild B" };

describe("V6 deployment > payload", () => {
  it("deploys every slash command, sorted by name", () => {
    const { service } = harness({ commands: ["ping", "ban", "warn"] });

    expect(service.globalBody().map((command) => command.name)).toEqual(["ban", "ping", "warn"]);
  });

  it("withholds a command that declares deploy: false", () => {
    const registry = new CommandRegistry();
    registry.register(slashCommand("ping"));
    registry.register(slashCommand("secret", { deploy: false }));

    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      rest: { put: () => Promise.resolve(undefined) },
    });

    expect(service.globalBody().map((command) => command.name)).toEqual(["ping"]);
    expect(service.deployableCommands().map((command) => command.name)).toEqual(["ping"]);
  });

  it("defaults a command to deployed when the flag is omitted", () => {
    const command = slashCommand("ping");

    // A new command must reach servers by default; opting out has to be explicit.
    expect(command.deploy).toBe(true);
  });

  it("is not a context-menu command: those are never deployed", () => {
    const registry = new CommandRegistry();
    registry.register(slashCommand("ping"));
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      rest: { put: () => Promise.resolve(undefined) },
    });

    expect(service.deployableCommands().every((command) => command.kind === "slash")).toBe(true);
  });
});

describe("V6 deployment > idempotency", () => {
  it("skips a guild that already holds the current payload", async () => {
    const { service, puts } = harness();

    const first = await service.deployToGuild(guildA, "startup");
    const second = await service.deployToGuild(guildA, "startup");

    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(true);
    // The whole point: the second boot must not call Discord again.
    expect(puts).toHaveLength(1);
  });

  it("redeploys when the payload changes", async () => {
    const registry = registryWith(["ping"]);
    const repository = new MemoryCommandDeploymentRepository();
    const puts: unknown[] = [];
    const rest = {
      put: (_route: string, options: { body: unknown }) => {
        puts.push(options.body);
        return Promise.resolve(undefined);
      },
    };

    const first = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository,
      logger: testLogger,
      rest,
    });
    await first.deployToGuild(guildA, "startup");

    // A new command appears: the same guild must be deployed to again.
    registry.register(slashCommand("ban"));
    const second = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository,
      logger: testLogger,
      rest,
    });
    const result = await second.deployToGuild(guildA, "startup");

    expect(result.skipped).toBe(false);
    expect(result.commands).toBe(2);
    expect(puts).toHaveLength(2);
  });

  it("deploys anyway when forced", async () => {
    const { service, puts } = harness();

    await service.deployToGuild(guildA, "startup");
    const forced = await service.deployToGuild(guildA, "manual", { force: true });

    expect(forced.skipped).toBe(false);
    expect(puts).toHaveLength(2);
  });

  it("reports every guild that is behind without deploying to any", async () => {
    const { service, puts } = harness();

    await service.deployToGuild(guildA, "startup");
    const behind = await service.guildsMissingCommands([guildA, guildB]);

    expect(behind.map((guild) => guild.id)).toEqual([GUILD_B]);
    // An inspection must not have side effects.
    expect(puts).toHaveLength(1);
  });
});

describe("V6 deployment > failure handling", () => {
  it("does not record a failed guild as deployed", async () => {
    const { service, repository, failures } = harness();
    failures.set(GUILD_A, new Error("Discord is down"));

    const result = await service.deployToGuild(guildA, "startup");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Discord is down");
    // The recovery path depends on this: a stored fingerprint would make the next
    // run skip a guild that never actually received its commands.
    expect(await repository.find(GUILD_A)).toBeNull();
  });

  it("keeps deploying to other guilds when one fails", async () => {
    const { service, failures, puts } = harness();
    failures.set(GUILD_A, new Error("boom"));

    const results = await service.deployToGuilds([guildA, guildB], "startup");

    expect(results.find((entry) => entry.guildId === GUILD_A)?.ok).toBe(false);
    expect(results.find((entry) => entry.guildId === GUILD_B)?.ok).toBe(true);
    expect(puts.some((entry) => entry.route.includes(GUILD_B))).toBe(true);
  });

  it("never throws, whatever Discord answers", async () => {
    const { service, failures } = harness();
    failures.set(GUILD_A, new Error("fatal"));

    // A deployment must be safe to call from an event handler: a rejection here
    // would surface as an unhandled rejection at startup.
    await expect(service.deployToGuilds([guildA], "startup")).resolves.toBeDefined();
  });

  it("reports a global registration failure instead of throwing", async () => {
    const registry = registryWith(["ping"]);
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      // A permanent failure: the default backoff would only slow the suite down
      // without testing anything the retry-policy block does not already cover.
      retryBaseMs: 1,
      rest: { put: () => Promise.reject(new Error("401 Unauthorized")) },
    });

    const report = await service.deploy([guildA], "global+guilds", "startup");

    expect(report.global?.ok).toBe(false);
    expect(report.global?.reason).toContain("401");
    // Guild deployment still ran: a global failure must not block the per-guild
    // recovery path, which is what actually makes a server work quickly.
    expect(report.guilds).toHaveLength(1);
  });
});

describe("V6 deployment > fingerprint", () => {
  it("is stable for the same payload regardless of key order", () => {
    const left = fingerprintOf([{ name: "a", description: "x", options: [] }]);
    const right = fingerprintOf([{ options: [], description: "x", name: "a" }]);

    expect(left).toBe(right);
  });

  it("changes when a description changes", () => {
    const before = fingerprintOf([{ name: "a", description: "old" }]);
    const after = fingerprintOf([{ name: "a", description: "new" }]);

    expect(before).not.toBe(after);
  });

  it("changes when an option is added, which a command count would miss", () => {
    const before = fingerprintOf([{ name: "a", description: "x" }]);
    const after = fingerprintOf([
      { name: "a", description: "x", options: [{ name: "user", type: 6, required: true }] },
    ]);

    expect(before).not.toBe(after);
  });

  it("ignores undefined values", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });
});

describe("V6 deployment > verification and repair", () => {
  it("reports commands Discord does not have", async () => {
    const { service, getResponses } = harness({ commands: ["ping", "ban"] });
    getResponses.set(GUILD_A, [{ name: "ping" }]);

    const verification = await service.verifyGuild(GUILD_A);

    expect(verification.missing).toEqual(["ban"]);
    expect(verification.failed).toEqual([]);
  });

  it("passes when every command is present", async () => {
    const { service, getResponses } = harness({ commands: ["ping", "ban"] });
    getResponses.set(GUILD_A, [{ name: "ban" }, { name: "ping" }]);

    expect((await service.verifyGuild(GUILD_A)).missing).toEqual([]);
  });

  it("reports a query failure instead of pretending the guild is fine", async () => {
    const registry = registryWith(["ping"]);
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      // No `get` at all: a REST client that cannot read must say so, not report
      // "nothing is missing", which would be a silent lie.
      rest: { put: () => Promise.resolve(undefined) },
    });

    const verification = await service.verifyGuild(GUILD_A);

    expect(verification.failed).toHaveLength(1);
    expect(verification.failed[0]).toContain("cannot read guild commands");
  });

  it("repairs a guild whose commands vanished, even though its record looks current", async () => {
    const { service, puts, getResponses } = harness({ commands: ["ping", "ban"] });
    // The record claims the guild is up to date...
    await service.deployToGuild(guildA, "startup");
    expect(puts).toHaveLength(1);

    // ...but Discord only has one command, which is what a manual deletion in
    // server settings looks like.
    getResponses.set(GUILD_A, [{ name: "ping" }]);
    const putsBeforeRepair = puts.length;

    const result = await service.verifyAndRepair([guildA]);

    expect(result.repaired).toBe(1);
    expect(result.incomplete).toEqual([]);
    // A second PUT happened *despite* the matching fingerprint: verification beats
    // the stored record, which is the entire reason verification exists.
    expect(puts.length).toBe(putsBeforeRepair + 1);
  });

  it("names the guilds that are still incomplete after a repair", async () => {
    // `sticky` models a server where the command never appears even after a
    // successful PUT — a permission problem, for instance. The point of the check
    // is that the operator is told the server's name instead of assuming success.
    const { service, getResponses } = harness({ commands: ["ping", "ban"], sticky: [GUILD_A] });
    getResponses.set(GUILD_A, [{ name: "ping" }]);

    const result = await service.verifyAndRepair([guildA]);

    expect(result.repaired).toBe(0);
    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0]).toContain("Guild A");
    expect(result.incomplete[0]).toContain(GUILD_A);
  });

  it("leaves a healthy guild alone", async () => {
    const { service, puts } = harness({ commands: ["ping"] });
    await service.deployToGuild(guildA, "startup");
    const putsBefore = puts.length;

    const result = await service.verifyAndRepair([guildA]);

    expect(result.repaired).toBe(0);
    expect(result.incomplete).toEqual([]);
    // Verifying a healthy guild must not cause a redeployment.
    expect(puts).toHaveLength(putsBefore);
  });
});

describe("V6 deployment > scopes", () => {
  it("deploys globally and per guild on the combined scope", async () => {
    const { service, puts } = harness();

    const report = await service.deploy([guildA, guildB], "global+guilds", "startup");

    expect(report.global?.ok).toBe(true);
    expect(report.deployed).toBe(2);
    expect(puts.some((entry) => entry.route.includes(GUILD_A))).toBe(true);
    expect(puts.some((entry) => entry.route.includes(GUILD_B))).toBe(true);
  });

  it("does not touch individual guilds on the global-only scope", async () => {
    const { service, puts } = harness();

    const report = await service.deploy([guildA, guildB], "global", "startup");

    expect(report.global?.ok).toBe(true);
    expect(report.guilds).toEqual([]);
    expect(puts.every((entry) => !entry.route.includes(GUILD_A))).toBe(true);
  });

  it("deploys only to the development guild on the dev-guild scope", async () => {
    const { service, puts } = harness({ devGuildId: GUILD_B });

    const report = await service.deploy([guildA, guildB], "dev-guild", "startup");

    expect(report.global).toBeNull();
    expect(report.guilds.map((entry) => entry.guildId)).toEqual([GUILD_B]);
    expect(puts.every((entry) => entry.route.includes(GUILD_B))).toBe(true);
  });

  it("clears a guild's command scope and forgets its record", async () => {
    const { service, puts, getResponses } = harness({ commands: ["ping"] });
    await service.deployToGuild(guildA, "startup");
    getResponses.set(GUILD_A, [{ name: "ping" }]);

    const cleared = await service.clearGuildScope(GUILD_A);

    expect(cleared.ok).toBe(true);
    expect(puts).toHaveLength(2);
    // The empty body is what actually removes the commands.
    expect(puts[1]?.body).toEqual([]);
    // The record is gone, so the next deployment treats the guild as "never
    // deployed" — which is correct after clearing it.
    expect(await service.guildsMissingCommands([guildA])).toHaveLength(1);
  });

  it("derives its default scope from the development guild setting", () => {
    expect(harness({ devGuildId: GUILD_A }).service.scope).toBe("dev-guild");
    // The final fallback is `global`, never `global+guilds`: publishing to both
    // scopes makes Discord list every command twice.
    expect(harness().service.scope).toBe("global");
  });

  /**
   * Regression: Discord treats command names as unique *within a scope*, not across
   * scopes, so the same command registered globally and per guild is listed twice in
   * every server. `global+guilds` therefore duplicates the whole command picker.
   */
  it("shows why global+guilds duplicates every command in a server", async () => {
    const registry = registryWith(["ping", "ban"]);
    const globalNames = new Set<string>();
    const guildNames = new Map<string, Set<string>>();

    const service = new CommandDeploymentService({
      token: "test-token",
      clientId: "123456789012345678",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      maxRetries: 0,
      rest: {
        put: (route, restOptions) => {
          const names = (restOptions.body as { name: string }[]).map((command) => command.name);
          const guildId = /\/guilds\/(\d+)/.exec(route)?.[1];
          if (guildId) {
            guildNames.set(guildId, new Set(names));
          } else {
            for (const name of names) {
              globalNames.add(name);
            }
          }
          return Promise.resolve(undefined);
        },
        get: () => Promise.resolve([]),
      },
    });

    await service.deploy([guildA], "global+guilds", "startup");

    // Both scopes hold the same names, and Discord does not deduplicate them.
    const inGuild = guildNames.get(GUILD_A) ?? new Set<string>();
    expect([...globalNames].sort()).toEqual(["ban", "ping"]);
    expect([...inGuild].sort()).toEqual(["ban", "ping"]);
    expect([...globalNames].filter((name) => inGuild.has(name))).toHaveLength(2);
  });

  it("registers each command in exactly one scope on the default scope", async () => {
    const { service, puts } = harness();

    const report = await service.deploy([guildA, guildB], service.scope, "startup");

    expect(report.global?.ok).toBe(true);
    expect(report.guilds).toEqual([]);
    // No guild PUT at all, which is what prevents the duplicate menu entries.
    expect(puts).toHaveLength(1);
    expect(puts.every((entry) => !entry.route.includes(GUILD_A))).toBe(true);
  });

  /**
   * Regression: `DISCORD_DEV_GUILD_ID` is routinely left set in `.env` while the
   * operator has explicitly configured `COMMANDS_DEPLOY_SCOPE=global+guilds`. The
   * development guild used to win outright, which silently confined every
   * deployment to that one server and left every real server without commands.
   */
  it("lets an explicitly configured scope win over the development guild", () => {
    const { service } = harness({ devGuildId: GUILD_A, scope: "global+guilds" });

    expect(service.scope).toBe("global+guilds");
  });

  it("honours a global-only configured scope when a development guild is set", () => {
    expect(harness({ devGuildId: GUILD_A, scope: "global" }).service.scope).toBe("global");
  });

  it("still allows dev-guild to be configured explicitly", () => {
    expect(harness({ devGuildId: GUILD_A, scope: "dev-guild" }).service.scope).toBe("dev-guild");
  });

  it("deploys to real guilds even when a development guild is configured", async () => {
    const { service, puts } = harness({ devGuildId: GUILD_A, scope: "global+guilds" });

    const report = await service.deploy([guildA, guildB], service.scope, "startup");

    expect(report.deployed).toBe(2);
    expect(puts.some((entry) => entry.route.includes(GUILD_A))).toBe(true);
    expect(puts.some((entry) => entry.route.includes(GUILD_B))).toBe(true);
  });
});

/**
 * Regression suite for the bug where clearing the guild scopes did not survive a
 * restart.
 *
 * With `COMMANDS_DEPLOY_SCOPE=global` the guild scope is *supposed* to be empty, but
 * the verification pass read that empty scope, compared it against the global
 * payload, concluded that all 24 commands were missing on every healthy server, and
 * then "repaired" them by writing the whole global payload back into each guild.
 * Every restart recreated the duplicates, so the picker listed each command twice no
 * matter how many times the guild scopes were cleared.
 */
describe("V6 deployment > global scope is not undone by verification", () => {
  it("does not verify a global deployment against each guild's empty scope", async () => {
    const { service, puts, getResponses } = harness({ commands: ["ping", "ban"] });

    await service.deploy([guildA, guildB], "global", "startup");
    const putsAfterDeploy = puts.length;

    // Both guilds have an empty guild scope, which is correct for `global`.
    getResponses.set(GUILD_A, []);
    getResponses.set(GUILD_B, []);

    const result = await service.verifyAndRepair([guildA, guildB], "global");

    expect(result.incomplete).toEqual([]);
    // The bug: this reported 24 "missing" commands per guild and PUT them back.
    expect(puts).toHaveLength(putsAfterDeploy);
  });

  it("reports nothing missing when the global scope holds the whole payload", async () => {
    const { service } = harness({ commands: ["ping", "ban"] });
    await service.deployGlobally();

    const verification = await service.verifyGlobal();

    expect(verification.missing).toEqual([]);
    expect(verification.failed).toEqual([]);
  });

  it("reports a global command Discord does not have", async () => {
    const registry = registryWith(["ping", "ban"]);
    const service = new CommandDeploymentService({
      token: "test-token",
      clientId: "123456789012345678",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      rest: {
        put: () => Promise.resolve(undefined),
        get: () => Promise.resolve([{ name: "ping" }]),
      },
    });

    expect((await service.verifyGlobal()).missing).toEqual(["ban"]);
  });

  it("names the global scope as incomplete when a global command is missing", async () => {
    const registry = registryWith(["ping", "ban"]);
    const service = new CommandDeploymentService({
      token: "test-token",
      clientId: "123456789012345678",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      rest: {
        put: () => Promise.resolve(undefined),
        get: () => Promise.resolve([{ name: "ping" }]),
      },
    });

    const result = await service.verifyAndRepair([guildA], "global");

    expect(result.repaired).toBe(0);
    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0]).toContain("global scope");
    expect(result.incomplete[0]).toContain("ban");
  });

  it("still verifies and repairs each guild on the per-guild scopes", async () => {
    const { service, puts, getResponses } = harness({ commands: ["ping", "ban"] });
    await service.deployToGuild(guildA, "startup");
    getResponses.set(GUILD_A, [{ name: "ping" }]);
    const putsBefore = puts.length;

    const result = await service.verifyAndRepair([guildA], "global+guilds");

    expect(result.repaired).toBe(1);
    expect(puts.length).toBe(putsBefore + 1);
  });

  it("clears leftover guild-scoped commands when reconciling a global deployment", async () => {
    const { service, puts, getResponses } = harness({ commands: ["ping", "ban"] });
    // A guild still holding a full guild-scoped copy, as left behind by an earlier
    // `global+guilds` deployment.
    getResponses.set(GUILD_A, [{ name: "ping" }, { name: "ban" }]);

    const result = await service.reconcileGlobalScope([guildA, guildB]);

    expect(result.cleared).toBe(1);
    expect(result.failed).toEqual([]);
    const clearPut = puts.find((entry) => entry.route.includes(GUILD_A));
    expect(clearPut?.body).toEqual([]);
    // The clean guild is left untouched: reconciling must not write needlessly.
    expect(puts.some((entry) => entry.route.includes(GUILD_B))).toBe(false);
  });

  it("leaves an already-global deployment alone when reconciling", async () => {
    const { service, puts } = harness({ commands: ["ping", "ban"] });

    const result = await service.reconcileGlobalScope([guildA, guildB]);

    expect(result.cleared).toBe(0);
    expect(result.failed).toEqual([]);
    expect(puts).toHaveLength(0);
  });
});

describe("V6 deployment > retry policy", () => {
  it("retries a rate limit and succeeds", async () => {
    const registry = registryWith(["ping"]);
    let attempts = 0;
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      maxRetries: 2,
      retryBaseMs: 1,
      rest: {
        put: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(Object.assign(new Error("rate limited"), { status: 429 }))
            : Promise.resolve(undefined);
        },
      },
    });

    const result = await service.deployToGuild(guildA, "startup");

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("does not retry a permanent failure", async () => {
    const registry = registryWith(["ping"]);
    let attempts = 0;
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      maxRetries: 3,
      retryBaseMs: 1,
      rest: {
        put: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error("forbidden"), { status: 403 }));
        },
      },
    });

    const result = await service.deployToGuild(guildA, "startup");

    expect(result.ok).toBe(false);
    // Retrying a 403 would only delay the report an operator needs to read.
    expect(attempts).toBe(1);
  });

  it("gives up after the configured number of retries", async () => {
    const registry = registryWith(["ping"]);
    let attempts = 0;
    const service = new CommandDeploymentService({
      token: "t",
      clientId: "1",
      registry,
      repository: new MemoryCommandDeploymentRepository(),
      logger: testLogger,
      maxRetries: 2,
      retryBaseMs: 1,
      rest: {
        put: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error("server error"), { status: 500 }));
        },
      },
    });

    const result = await service.deployToGuild(guildA, "startup");

    expect(result.ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it("classifies failures the way the retry policy expects", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    // A network-level failure has no status and is usually transient.
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(statusOf({ httpStatus: 502 })).toBe(502);
    expect(statusOf(new Error("x"))).toBeUndefined();
  });

  it("describes a failure without leaking internals", () => {
    expect(describeError(Object.assign(new Error("nope"), { status: 401 }))).toBe(
      "nope (HTTP 401)",
    );
    expect(describeError("plain string")).toBe("plain string");
  });
});

/**
 * Regression suite for `guildCreate` deciding whether a newly joined server gets an
 * immediate guild-scoped deployment.
 *
 * The bug this guards: `guildCreate` used to deploy a guild-scoped copy
 * unconditionally, regardless of scope. Under `global` that copy looked correct —
 * commands appeared instantly — and then vanished on the next boot when
 * `reconcileGlobalScope` cleared it, leaving the new server to wait on the global
 * propagation (up to an hour). The decision must be a single, scope-aware boolean so
 * a server ends up with its commands exactly once, in the scope its configuration
 * promises.
 */
describe("V6 deployment > guild create honours the scope", () => {
  it("deploys an instant guild copy only on the combined scope", () => {
    expect(shouldDeployGuildCommandsOnJoin("global+guilds")).toBe(true);
  });

  it("does not write a guild copy on the global-only scope", () => {
    // Writing it would be cleared by `reconcileGlobalScope` on the next boot.
    expect(shouldDeployGuildCommandsOnJoin("global")).toBe(false);
  });

  it("does not leak a dev payload into an innocent new server", () => {
    expect(shouldDeployGuildCommandsOnJoin("dev-guild")).toBe(false);
  });
});
