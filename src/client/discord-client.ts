/**
 * Discord client factory.
 *
 * The client is created in exactly one place so that intents, cache limits,
 * sweepers and REST options are configured consistently. Additional intents are
 * added by extending `INTENT_FEATURES`, not by editing the bootstrap.
 */
import { Client, type ClientOptions } from "discord.js";

import { buildClientOptions, type IntentFeature } from "./intents.js";
import type { BotClient } from "./client.types.js";
import type { Logger } from "../services/logger/index.js";

export interface DiscordClientFactoryOptions {
  /** Optional feature flags that pull in additional intents. */
  readonly features?: readonly IntentFeature[];
  /** Enables discord.js internal debug logging (development only). */
  readonly debug?: boolean;
}

export class DiscordClientFactory {
  private readonly options: DiscordClientFactoryOptions;
  private readonly logger: Logger;

  public constructor(logger: Logger, options: DiscordClientFactoryOptions = {}) {
    this.logger = logger.child("client");
    this.options = options;
  }

  /** Creates a client with the minimal intents for the enabled features. */
  public create(): BotClient {
    const overrides = buildClientOptions(this.options.features ?? []);
    const clientOptions: ClientOptions = {
      ...overrides,
      ...(this.options.debug ? { rest: { timeout: 20_000, retries: 3 } } : {}),
    };

    // `commands` is populated by the bootstrap through the registry. Declaring it
    // here keeps every consumer strongly typed without per-call-site casts.
    const client = new Client(clientOptions) as BotClient;

    this.logger.debug("Discord client created", {
      intents: clientOptions.intents,
      features: this.options.features ?? [],
    });

    if (this.options.debug) {
      client.on("debug", (message) => {
        this.logger.debug(`discord.js: ${message}`);
      });
      client.on("warn", (message) => {
        this.logger.warn(`discord.js: ${message}`);
      });
    }

    return client;
  }
}
