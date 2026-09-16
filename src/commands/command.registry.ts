/**
 * Command registry.
 *
 * Single source of truth for "which commands exist". The interaction handler and
 * the deploy script both read from here, so registration and runtime can never
 * drift apart.
 */
import type { Command } from "./command.types.js";
import type { BotClient } from "../client/client.types.js";

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  /** Registers a command. Duplicate names are a programming error. */
  public register(command: Command): void {
    if (this.commands.has(command.name)) {
      throw new Error(`Duplicate command name: ${command.name}`);
    }
    this.commands.set(command.name, command);
  }

  /** Registers many commands, validating the whole set first. */
  public registerAll(commands: readonly Command[]): void {
    for (const command of commands) {
      this.register(command);
    }
  }

  /** @returns the command with the given name, if registered. */
  public get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  public has(name: string): boolean {
    return this.commands.has(name);
  }

  public list(): Command[] {
    return [...this.commands.values()];
  }

  public get size(): number {
    return this.commands.size;
  }

  /**
   * Exposes this registry on the client.
   *
   * The registry object itself is shared (not copied) so commands, events and
   * tooling all observe the same set of loaded commands.
   */
  public applyToClient(client: BotClient): void {
    client.commands = this;
  }
}
