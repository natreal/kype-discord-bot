/**
 * Event contracts.
 *
 * An event file exports `defineEvent(...)` as its default export. Events are
 * discovered automatically, so adding behaviour means creating a file — never
 * editing the bootstrap.
 */
import type { ClientEvents } from "discord.js";

import type { AppServices } from "../services/container.js";

/** Everything handlers receive, in addition to the Discord.js arguments. */
export interface EventContext {
  readonly services: AppServices;
}

/** Shared options for every event definition. */
export interface EventOptions<K extends keyof ClientEvents> {
  /** Discord event name, e.g. `guildCreate`. */
  readonly name: K;
  /** When true the handler runs at most once (e.g. `ready`). */
  readonly once?: boolean;
  readonly execute: (...args: [...ClientEvents[K], EventContext]) => Promise<void> | void;
}

/** A discovered event with its handler bound to the service container. */
export interface EventDefinition<K extends keyof ClientEvents = keyof ClientEvents> {
  readonly name: K;
  readonly once: boolean;
  readonly execute: (...args: [...ClientEvents[K], EventContext]) => Promise<void> | void;
}

/** Union type used by the loader and the dispatcher. */
export type AnyEventDefinition = EventDefinition<keyof ClientEvents>;

/** Identity helper providing inference for `name` -> `args`. */
export function defineEvent<K extends keyof ClientEvents>(
  options: EventOptions<K>,
): EventDefinition<K> {
  return {
    name: options.name,
    once: options.once ?? false,
    execute: options.execute,
  };
}
