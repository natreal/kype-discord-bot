/**
 * Command registry tests.
 *
 * The registry is the single source of truth shared by the interaction handler
 * and the deployment script, so registration and lookup behavior are tested
 * directly.
 */
import { describe, expect, it } from "vitest";

import { CommandRegistry } from "../../src/commands/command.registry.js";
import { loadAndRegisterCommands } from "../../src/commands/command.loader.js";
import { fromProjectRoot } from "../../src/utils/fs.js";
import { testLogger } from "../helpers/logger.js";

describe("CommandRegistry", () => {
  it("rejects duplicate command names", () => {
    const registry = new CommandRegistry();
    const command = { name: "ping", kind: "slash" } as never;

    registry.register(command);
    expect(() => registry.register(command)).toThrow(/Duplicate command name/);
  });

  it("looks commands up by name", () => {
    const registry = new CommandRegistry();
    registry.register({ name: "ping" } as never);

    expect(registry.has("ping")).toBe(true);
    expect(registry.get("ping")).toBeDefined();
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it("registers the real foundation commands from src/commands", async () => {
    const registry = new CommandRegistry();
    const report = await loadAndRegisterCommands(registry, {
      directory: fromProjectRoot("src", "commands"),
      logger: testLogger,
    });

    expect(report.failures).toEqual([]);
    expect(
      registry
        .list()
        .map((command) => command.name)
        .sort(),
    ).toEqual(["about", "help", "ping", "serverinfo"]);
  });

  it("exposes the registry on the client", async () => {
    const registry = new CommandRegistry();
    await loadAndRegisterCommands(registry, {
      directory: fromProjectRoot("src", "commands"),
      logger: testLogger,
    });

    const client = {} as { commands: CommandRegistry };
    registry.applyToClient(client as never);

    expect(client.commands).toBe(registry);
    expect(client.commands.size).toBe(registry.size);
  });
});
