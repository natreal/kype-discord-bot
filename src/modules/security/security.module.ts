/**
 * Security module (V5).
 *
 * Owns the two resources the security engine needs: the `#bot-security` channel the
 * security log posts to, and the `Quarantined` role raid containment applies.
 *
 * The channel is deliberately *not* the moderation log channel: a raid alert buried
 * between two warning notices is a raid nobody reacts to. `security-logs` (the
 * module's setup key) is provisioned only when the module is enabled, so a server
 * that never turns security on does not get an unused channel.
 */
import { ChannelType, PermissionFlagsBits } from "discord.js";

import type { BotModule, SetupAction } from "../module.types.js";

export const SECURITY_RESOURCES = {
  channel: "bot-security",
  quarantinedRole: "Quarantined",
} as const;

/** Channel name shared with the log sink, so both agree on where alerts go. */
const SECURITY_CHANNEL_NAME = "bot-security";

/** Role name shared with the moderation and security adapters. */
const QUARANTINE_ROLE_NAME = "Quarantined";

export const securityModule: BotModule = {
  name: "security",
  description: "Anti-raid, anti-nuke and lockdown foundations.",

  enabled(context): boolean {
    return context.config.security.enabled;
  },

  plan(planContext): SetupAction[] {
    const { security } = planContext.config;

    return [
      {
        key: "channel",
        description: `Create the "#${SECURITY_CHANNEL_NAME}" channel for security alerts.`,
        run: async (context) => {
          if (!security.enabled) {
            return { status: "skipped", detail: "security disabled" };
          }
          const category = await context.setuper.findCategoryByName("Bot");
          const { resource, created } = await context.setuper.ensureTextChannel({
            name: SECURITY_CHANNEL_NAME,
            parentId: category?.id ?? null,
            topic: "Security alerts: raid, nuke and lockdown events.",
            reason: "Security module setup",
          });
          // Staff-only by default: the security log names accounts and describes
          // what they did, which is not material for `@everyone`.
          const everyone = context.setuper.guild.roles.everyone;
          await resource.permissionOverwrites
            .edit(everyone, { ViewChannel: false }, { reason: "Security log is staff-only" })
            .catch(() => undefined);
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
      {
        key: "quarantined-role",
        description: `Create the "${QUARANTINE_ROLE_NAME}" role for raid containment.`,
        run: async (context) => {
          if (!security.enabled) {
            return { status: "skipped", detail: "security disabled" };
          }
          const { resource, created } = await context.setuper.ensureRole({
            name: QUARANTINE_ROLE_NAME,
            permissions: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.SendMessages,
            ],
            reason: "Security module setup",
          });
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
      {
        key: "lockdown-state",
        description: "Report channels whose lockdown state differs from the configuration.",
        run: async (context) => {
          const channels = await context.setuper.guild.channels.fetch();
          const textChannels = [...channels.values()].filter(
            (channel) => channel?.type === ChannelType.GuildText && channel.parentId !== null,
          );
          const mismatched = textChannels.filter(
            (channel) =>
              channel
                ?.permissionsFor(context.setuper.guild.roles.everyone)
                ?.has(PermissionFlagsBits.SendMessages) === security.lockdown,
          );

          if (mismatched.length === 0) {
            return { status: "skipped", detail: `lockdown=${security.lockdown}` };
          }
          return {
            status: "updated",
            detail: `${mismatched.length} channel(s) differ from the expected lockdown state`,
          };
        },
      },
    ];
  },
};
