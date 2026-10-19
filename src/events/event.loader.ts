/**
 * Automatic event loader.
 *
 * Discovers `src/events/**` and binds every `defineEvent` export to the Discord
 * client. Handlers are wrapped so that a thrown error is logged and can never
 * crash the process or stop other handlers from running.
 */
import type { Client, ClientEvents } from "discord.js";

import type { Logger } from "../services/logger/index.js";
import type { AppServices } from "../services/container.js";
import { ValidationError } from "../utils/errors.js";
import { collectModuleFiles, importModule, moduleId } from "../utils/fs.js";
import { defineEvent, type EventContext } from "./event.types.js";

/** Result of a load pass. */
export interface EventLoadReport {
  readonly events: readonly RegisteredEvent[];
  readonly failures: { moduleId: string; error: unknown }[];
}

/**
 * Event modules that are infrastructure, not handlers.
 *
 * Everything else without a valid event export is treated as infrastructure too,
 * so this list only needs the files in the events root that must never load.
 */
const INFRASTRUCTURE_FILES = [
  "index",
  "event.loader",
  "event.types",
  // Shared formatting for the guild-log handlers. It exports helpers, not an event,
  // so it must be skipped explicitly — the loader already tolerates a missing event
  // export, but that would log a warning for a file that is behaving correctly.
  "guild-log.helpers",
];

function isInfrastructureFile(id: string): boolean {
  return INFRASTRUCTURE_FILES.includes(id);
}

/** An event definition that has been bound to the client. */
export interface RegisteredEvent {
  readonly name: keyof ClientEvents;
  readonly once: boolean;
  readonly moduleId: string;
}

export interface EventLoaderOptions {
  /** Absolute path to the events directory. Defaults to `<cwd>/src/events`. */
  readonly directory: string;
  readonly logger: Logger;
  readonly services: AppServices;
}

/**
 * Loads every event module and attaches its handler to the client.
 *
 * The `EventContext` is appended as the final argument, so handlers can use the
 * service container without importing singletons.
 */
export async function registerEvents(
  client: Client,
  options: EventLoaderOptions,
): Promise<EventLoadReport> {
  const logger = options.logger.child("loader:events");
  const files = await collectModuleFiles(options.directory);
  const events: RegisteredEvent[] = [];
  const failures: { moduleId: string; error: unknown }[] = [];
  const context: EventContext = { services: options.services };

  for (const file of files) {
    const id = moduleId(file, options.directory);

    if (isInfrastructureFile(id)) {
      continue;
    }

    try {
      const moduleExports = await importModule<Record<string, unknown>>(file);
      const definition = moduleExports["default"];

      if (definition === undefined) {
        // Shared helpers in the events folder are not handlers.
        logger.debug("Skipped event module without a default export", { moduleId: id });
        continue;
      }

      const { name, once, execute } = definition as {
        name?: unknown;
        once?: unknown;
        execute?: unknown;
      };

      if (typeof name !== "string" || typeof execute !== "function") {
        throw new ValidationError(`Event module ${id} is not a valid event definition`);
      }

      const handler = async (...args: unknown[]): Promise<void> => {
        try {
          await (execute as (...innerArgs: unknown[]) => Promise<void> | void)(...args, context);
        } catch (error) {
          logger.error(`Unhandled error in event "${name}" (${id})`, error);
        }
      };

      // discord.js accepts void-returning listeners; the async handler never
      // rejects because every failure is caught and logged above.
      const listener = (...args: unknown[]): void => {
        void handler(...args);
      };

      if (once === true) {
        client.once(name as keyof ClientEvents, listener);
      } else {
        client.on(name as keyof ClientEvents, listener);
      }

      events.push({ name: name as keyof ClientEvents, once: once === true, moduleId: id });
      logger.debug("Registered event", { event: name, once: once === true, moduleId: id });
    } catch (error) {
      failures.push({ moduleId: id, error });
      logger.error(`Failed to register event from ${id}`, error);
    }
  }

  ensureUniqueOnceEvents(events);

  if (failures.length > 0) {
    const failed = failures.map((failure) => failure.moduleId).join(", ");
    throw new ValidationError(`Some event modules failed to load: ${failed}`);
  }

  return { events, failures };
}

/** Two `once` handlers for the same event would silently drop one. */
function ensureUniqueOnceEvents(events: readonly RegisteredEvent[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (!event.once) {
      continue;
    }
    const key = String(event.name);
    if (seen.has(key)) {
      throw new ValidationError(`Duplicate once-event handler for "${key}"`);
    }
    seen.add(key);
  }
}

export { defineEvent };
