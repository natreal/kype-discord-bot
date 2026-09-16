/**
 * Gateway intents.
 *
 * Least privilege: only the intents the bot actually needs are requested, and
 * privileged intents can be enabled with a single environment switch once the
 * corresponding feature ships. Adding a feature therefore does not mean
 * rewriting the client configuration.
 */
import { GatewayIntentBits, Options, type ClientOptions } from "discord.js";

/** Intents that are always required by the foundation. */
export const BASE_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
];

/**
 * Privileged intents, enabled explicitly.
 *
 * `GuildMembers` and `MessageContent` must also be toggled in the Discord
 * developer portal (Bot -> Privileged Gateway Intents) before deployment.
 */
export const INTENT_FEATURES = {
  /** Needed for member join/leave events and member joins in the cache. */
  guildMembers: { intents: [GatewayIntentBits.GuildMembers], privileged: true },
  /** Needed for message-based AI moderation, anti-spam and automations. */
  messageContent: { intents: [GatewayIntentBits.MessageContent], privileged: true },
  /** Needed to track moderation activity / audit log driven features. */
  guildModeration: { intents: [GatewayIntentBits.GuildModeration], privileged: false },
  /** Needed for voice analytics and voice automations. */
  guildVoiceStates: { intents: [GatewayIntentBits.GuildVoiceStates], privileged: false },
  /** Needed for presence-driven notifications. */
  guildPresences: { intents: [GatewayIntentBits.GuildPresences], privileged: true },
} as const;

export type IntentFeature = keyof typeof INTENT_FEATURES;

/** @returns the intents for the requested features, de-duplicated. */
export function resolveIntents(features: readonly IntentFeature[] = []): GatewayIntentBits[] {
  const intents = new Set<GatewayIntentBits>(BASE_INTENTS);
  for (const feature of features) {
    for (const intent of INTENT_FEATURES[feature].intents) {
      intents.add(intent);
    }
  }
  return [...intents];
}

/** @returns the features that require enabling in the Discord developer portal. */
export function privilegedFeatures(features: readonly IntentFeature[]): IntentFeature[] {
  return features.filter((feature) => INTENT_FEATURES[feature].privileged);
}

/** Client options produced by {@link buildClientOptions}. */
export type ClientOptionsOverrides = Pick<ClientOptions, "intents" | "makeCache" | "sweepers">;

/** Builds the client options consumed by `DiscordClientFactory`. */
export function buildClientOptions(
  features: readonly IntentFeature[] = [],
): ClientOptionsOverrides {
  return {
    intents: resolveIntents(features),
    // Caching every message is unnecessary for a modular bot and is a memory
    // leak waiting to happen at scale; modules opt in to what they need.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 50,
      PresenceManager: 0,
      ReactionManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 600, lifetime: 1_800 },
    },
  };
}
