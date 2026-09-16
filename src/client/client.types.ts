/**
 * The bot's client type.
 *
 * `client.commands` itself is declared through module augmentation in
 * `src/types/discord.d.ts`, so every consumer gets the typed registry without
 * importing this file. This alias exists to express "a client that may or may not
 * be ready" in service signatures.
 */
import type { Client } from "discord.js";

export type BotClient<Ready extends boolean = boolean> = Client<Ready>;

