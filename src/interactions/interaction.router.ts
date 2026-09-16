/**
 * Component and modal routing.
 *
 * Custom IDs follow a namespaced convention so that routing stays flat and
 * collision-free as the bot grows:
 *
 *   <namespace>:<action>[:<argument>...]
 *   ticket:close:1234
 *   setup:run:logging
 *
 * Handlers are registered per namespace; the router picks the longest matching
 * namespace, so `ticket:close` can override the generic `ticket` handler.
 */
import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";

import { ValidationError } from "../utils/errors.js";

/** Context handed to component/modal handlers. */
export interface ComponentHandlerContext {
  /** Parsed custom ID segments, excluding the namespace. */
  readonly args: readonly string[];
  /** Full, raw custom ID. */
  readonly customId: string;
}

export type ComponentHandler = (
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  context: ComponentHandlerContext,
) => Promise<void>;

export type ModalHandler = (
  interaction: ModalSubmitInteraction,
  context: ComponentHandlerContext,
) => Promise<void>;

const MAX_CUSTOM_ID_LENGTH = 100;

/** Builds a custom ID, validating Discord's 100 character limit. */
export function buildCustomId(namespace: string, ...parts: readonly (string | number)[]): string {
  const customId = [namespace, ...parts].join(":");
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new ValidationError(
      `Custom ID exceeds Discord's ${MAX_CUSTOM_ID_LENGTH} character limit: ${customId}`,
      { customId },
    );
  }
  return customId;
}

/** Splits a custom ID into namespace and arguments. */
export function parseCustomId(customId: string): { namespace: string; args: string[] } {
  const [namespace = "", ...args] = customId.split(":");
  return { namespace, args };
}

export class InteractionRouter {
  private readonly components = new Map<string, ComponentHandler>();
  private readonly modals = new Map<string, ModalHandler>();

  public registerComponent(namespace: string, handler: ComponentHandler): void {
    this.components.set(namespace, handler);
  }

  public registerModal(namespace: string, handler: ModalHandler): void {
    this.modals.set(namespace, handler);
  }

  /** @returns the handler for the longest registered namespace prefix. */
  public resolveComponent(
    customId: string,
  ): { handler: ComponentHandler; context: ComponentHandlerContext } | null {
    const handler = this.resolve(this.components, customId);
    if (!handler) {
      return null;
    }
    const { args } = parseCustomId(customId);
    const namespace = handler.namespaceFor(customId);
    return {
      handler: handler.handler,
      context: { args: args.slice(namespace.split(":").length - 1), customId },
    };
  }

  public resolveModal(
    customId: string,
  ): { handler: ModalHandler; context: ComponentHandlerContext } | null {
    const handler = this.resolve(this.modals, customId);
    if (!handler) {
      return null;
    }
    const { args } = parseCustomId(customId);
    const namespace = handler.namespaceFor(customId);
    return {
      handler: handler.handler,
      context: { args: args.slice(namespace.split(":").length - 1), customId },
    };
  }

  private resolve<T>(
    registry: ReadonlyMap<string, T>,
    customId: string,
  ): { handler: T; namespaceFor: (customId: string) => string } | null {
    const { namespace } = parseCustomId(customId);
    const candidates = [...registry.keys()]
      .filter((key) => matches(namespace, key))
      .sort((left, right) => right.length - left.length);

    const best = candidates[0];
    if (best === undefined) {
      return null;
    }
    const handler = registry.get(best);
    if (handler === undefined) {
      return null;
    }
    return { handler, namespaceFor: () => best };
  }
}

function matches(namespace: string, registered: string): boolean {
  return namespace === registered || namespace.startsWith(`${registered}:`);
}
