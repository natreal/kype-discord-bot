/**
 * `messageCreate` — the automod hot path.
 *
 * This handler does one thing: turn a Discord message into an
 * {@link AutomodMessageObservation} and hand it to `AutomodService`. It contains no
 * rule logic and no sanction logic, because both live elsewhere and are tested
 * there — automod's job here is to be *faithful* about what it observed, and the
 * service's job is to decide.
 *
 * Facts the handler must get right, because a rule is only as good as its input:
 * - `mentionCount` counts *mentions*, and Discord reports them for users, roles and
 *   `@everyone` separately, so all three are summed.
 * - the timestamp comes from the message, not from `Date.now()`, so a backfilled or
 *   replayed message is judged against the window it actually belongs to.
 * - the bot's own messages, webhooks and DMs are skipped here rather than in the
 *   evaluator: they never deserve a Discord API round trip.
 */
import { PermissionFlagsBits } from "discord.js";
import type { Message } from "discord.js";

import { defineEvent } from "./event.types.js";
import type { AutomodMessageObservation } from "../modules/automod/index.js";
import type { AppServices } from "../services/container.js";
import { AiAgentService } from "../modules/ai/ai-agent.service.js";
import {
  intentNote,
  resolveIntent,
  resolveTrigger,
  startsWithKeyword,
} from "../modules/ai/keyword.js";

/**
 * Per-guild hourly rate-limit window for the keyword agent.
 *
 * Kept in memory because the window is ephemeral: `maxRequestsPerHour` is a
 * guard against one server hammering the provider, not a durable fact. A restart
 * resets the window, which is acceptable for a cost guard (the daily token
 * budget is the real backstop, and it is process-wide and cumulative).
 */
const aiRateWindows = new Map<string, { readonly start: number; count: number }>();

export default defineEvent({
  name: "messageCreate",
  execute: async (message, { services }) => {
    if (!message.inGuild() || message.author.bot || message.system) {
      return;
    }
    // A message that is only a partial payload cannot be judged reliably (the
    // `MessageContent` intent is off), so it is skipped rather than guessed at.
    if (!message.content && message.mentions.users.size === 0) {
      return;
    }

    const automod = services.automodForGuild(message.guild.id);
    if (!automod) {
      return;
    }

    const observation: AutomodMessageObservation = {
      kind: "message",
      guildId: message.guild.id,
      channelId: message.channelId,
      channelName: "name" in message.channel ? message.channel.name : message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      authorTag: message.author.tag,
      authorIsOwner: message.guild.ownerId === message.author.id,
      authorIsAdministrator:
        message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
      botAuthor: message.author.bot,
      content: message.content,
      mentionCount:
        message.mentions.users.size +
        message.mentions.roles.size +
        (message.mentions.everyone ? 1 : 0),
      emojiCount: 0,
      timestampMs: message.createdTimestamp,
    };

    const outcome = await automod.observe(observation);
    if (outcome.verdict !== "triggered") {
      await maybeInvokeAi(message, services);
      return;
    }

    // The trigger message is removed when the guild asked for it, and the removal
    // is best-effort: losing the delete must not lose the case that was recorded.
    if (await services.automodDeleteTriggers(message.guild.id)) {
      await message.delete().catch(() => undefined);
    }
  },
});

/**
 * Wakes the keyword agent when a message is addressed to it.
 *
 * Runs only when AI is enabled, the message starts with the resolved keyword and
 * the budget/rate limits allow it. Everything here reflects reality: a refusal or
 * an "IA non configurée" is replied as-is, never a fabricated success.
 */
async function maybeInvokeAi(message: Message<true>, services: AppServices): Promise<void> {
  if (!services.ai?.isConfigured) {
    return;
  }
  if (!message.content) {
    return;
  }

  // Maintenance pauses conversation, not protection: automod and security already
  // ran (this function is only reached when automod did not trigger), but the
  // assistant stays silent. Replying here would cost provider tokens and invite the
  // server to keep talking to a bot that is not being served.
  if (await services.maintenance.isActive(message.guild.id)) {
    return;
  }

  const config = await services.guildConfig.get(message.guild.id);
  if (!config.ai.enabled) {
    return;
  }

  const trigger = resolveTrigger(config.ai.trigger, services.config.ai.defaultTrigger);
  const content = message.content;

  // Keyword must be a whole word at the very start of the message. This avoids
  // false positives like "kype…" or a message that merely contains "kype" mid
  // sentence — the agent wakes only for an explicit address.
  const remainder = startsWithKeyword(content, trigger);
  if (remainder === null) {
    return;
  }

  if (!withinRateLimit(message.guild.id, config.ai.maxRequestsPerHour)) {
    await message.reply("Hourly limit hit — try again later.").catch(() => undefined);
    return;
  }

  // A colloquial verb is resolved deterministically *before* the model is asked
  // anything: "obliterate" becomes the ban tool, and a term that could mean two
  // different actions ("nuke") gets one clarifying question instead of a guess.
  const request = remainder || content;
  const intent = resolveIntent(request);
  if (intent && !intent.confident) {
    await message.reply(intent.clarification ?? "Which action do you want?").catch(() => undefined);
    return;
  }
  const note = intent === null ? null : intentNote(intent);

  const member = message.member;
  if (!member) {
    return;
  }

  const agent = services.createAiAgent(message.guild, services.logger);
  const menu = AiAgentService.menu(
    services.aiRegistry,
    config.ai.mode,
    config.ai.enabledCategories,
  );

  const persona = await services.aiSettings
    .get()
    .then((settings) => settings.persona)
    .catch(() => undefined);

  const report = await agent.run({
    guildId: message.guild.id,
    invoker: member,
    content: note === null ? request : `${request}\n\n${note}`,
    mode: config.ai.mode,
    enabledCategories: config.ai.enabledCategories,
    trigger,
    tools: menu,
    ...(persona ? { persona } : {}),
  });

  await message.reply(report.text).catch(() => undefined);
}

/** @returns true when the guild is still under its hourly request ceiling. */
function withinRateLimit(guildId: string, maxPerHour: number): boolean {
  if (maxPerHour <= 0) {
    return true;
  }
  const now = Date.now();
  const window = aiRateWindows.get(guildId);
  if (!window || now - window.start >= 60 * 60 * 1000) {
    aiRateWindows.set(guildId, { start: now, count: 1 });
    return true;
  }
  if (window.count >= maxPerHour) {
    return false;
  }
  aiRateWindows.set(guildId, { start: window.start, count: window.count + 1 });
  return true;
}
