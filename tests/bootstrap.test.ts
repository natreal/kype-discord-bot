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

  it("deploys commands from the ready handler without blocking startup", async () => {
    const source = await readFile(fromProjectRoot("src", "events", "ready.ts"), "utf8");

    // A Discord outage at boot must not stop the bot from coming online: the
    // deployment is started, never awaited, and reports through the logger.
    expect(source).toContain("void deployCommands(services)");
    expect(source).not.toContain("await deployCommands(services)");
  });

  it("deploys into a guild that just joined, before running setup", async () => {
    const source = await readFile(fromProjectRoot("src", "events", "guild-create.ts"), "utf8");

    // Ordering matters: a server that just installed the bot looks broken while it
    // has no commands, and setup is the slower, more failure-prone half.
    const deployIndex = source.indexOf("await deployToNewGuild(");
    const setupIndex = source.indexOf('await services.setup.run(guild, "all")');
    expect(deployIndex).toBeGreaterThan(-1);
    expect(setupIndex).toBeGreaterThan(-1);
    expect(deployIndex).toBeLessThan(setupIndex);
  });

  it("shares one deployment service between startup, guildCreate and commands", async () => {
    const app = await readFile(fromProjectRoot("src", "app.ts"), "utf8");
    const guildCreate = await readFile(fromProjectRoot("src", "events", "guild-create.ts"), "utf8");
    const interaction = await readFile(
      fromProjectRoot("src", "interactions", "interaction.handler.ts"),
      "utf8",
    );

    // One instance: a second construction could compare a guild against a
    // different payload and wrongly report it as already deployed.
    expect(app).toContain("new CommandDeploymentService(");
    expect(app).toContain("deployment,");
    expect(guildCreate).toContain("services.deployment.deployToGuild");
    expect(interaction).toContain("const deployment = this.deps.deployment;");
    expect(interaction).toContain("deployment,");
  });

  it("never registers commands from the command-deployment script directly", async () => {
    const source = await readFile(fromProjectRoot("scripts", "deploy-commands.ts"), "utf8");

    // The script must go through the service: two implementations of "register the
    // commands" would eventually disagree about which commands exist.
    expect(source).toContain("new CommandDeploymentService(");
    expect(source).not.toContain("rest.put(");
  });

  it("routes /stop and /restart through the bootstrap's own teardown", async () => {
    const app = await readFile(fromProjectRoot("src", "app.ts"), "utf8");
    const interactionCreate = await readFile(
      fromProjectRoot("src", "events", "interaction-create.ts"),
      "utf8",
    );

    // One construction, one teardown: the command must not be able to close the
    // process in a way the signal path does not know about, and it must not call
    // `process.exit` itself.
    expect(app).toContain("new ProcessControlService(");
    expect(app).toContain("process: processControl,");
    expect(app).toContain("await shutdownResources({ client, container, logger })");
    expect(interactionCreate).toContain("process: services.process,");
  });

  it("answers a reply to the bot, not only a keyword message", async () => {
    const source = await readFile(fromProjectRoot("src", "events", "message-create.ts"), "utf8");

    // The reply is its own trigger: a member who answers a bot message has already
    // named it, and requiring the keyword there is the bug this guards.
    expect(source).toContain("message.mentions.repliedUser?.id === message.client.user?.id");
    expect(source).toContain("replyRequest(content, { repliedToBot, trigger })");
  });

  it("declares every CLI flag it reads", async () => {
    const source = await readFile(fromProjectRoot("scripts", "deploy-commands.ts"), "utf8");

    // A flag read from `options` but never declared is not a compile error when the
    // read happens through an index signature or a stale field, and a stale field
    // like the old `options.guilds` reaches `resolveScope` as `undefined` — silently
    // disabling the branch it guards. `tsc --build` does catch it today, but only
    // because `scripts/` is inside the program; asserting it here keeps the guarantee
    // independent of that setting.
    const interfaceBody = source.slice(
      source.indexOf("interface CliOptions {") + "interface CliOptions {".length,
      source.indexOf("}", source.indexOf("interface CliOptions {")),
    );
    const declared = new Set(
      [...interfaceBody.matchAll(/readonly\s+(\w+)/g)].map((match) => match[1]),
    );
    const read = new Set([...source.matchAll(/options\.(\w+)/g)].map((match) => match[1]));

    const undeclared = [...read].filter((key) => !declared.has(key));
    expect(undeclared).toEqual([]);

    // And the reverse: every flag that is documented in the header is actually
    // parseable, so the usage block cannot drift from the code.
    for (const flag of ["--dry-run", "--verbose", "--global-only", "--guilds", "--clear-guild"]) {
      expect(source).toContain(`"${flag}"`);
    }
  });
});
