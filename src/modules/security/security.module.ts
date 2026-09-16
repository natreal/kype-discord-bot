/**
 * Security module (foundation only).
 *
 * Anti-raid / anti-nuke detection and the lockdown workflow are implemented in a
 * later phase. This module owns the resources the security engine will use and
 * exposes a lockdown helper that the future `/security lockdown` command will
 * call through the permission service.
 */
import { ChannelType, PermissionFlagsBits } from "discord.js";

import type { BotModule, SetupAction } from "../module.types.js";

export const SECURITY_RESOURCES = {
  channel: "bot-security",
  quarantinedRole: "Quarantined",
} as const;

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
        description: `Create the "#${SECURITY_RESOURCES.channel}" channel for security alerts.`,
        run: async (context) => {
          if (!security.enabled) {
            return { status: "skipped", detail: "security disabled" };
          }
          const category = await context.setuper.findCategoryByName("Bot");
          const { resource, created } = await context.setuper.ensureTextChannel({
            name: SECURITY_RESOURCES.channel,
            parentId: category?.id ?? null,
            topic: "Security alerts: raid, nuke and lockdown events.",
            reason: "Foundation setup",
          });
          return { status: created ? "created" : "reused", resourceId: resource.id };
        },
      },
      {
        key: "quarantined-role",
        description: `Create the "${SECURITY_RESOURCES.quarantinedRole}" role for raid containment.`,
        run: async (context) => {
          if (!security.enabled) {
            return { status: "skipped", detail: "security disabled" };
          }
          const { resource, created } = await context.setuper.ensureRole({
            name: SECURITY_RESOURCES.quarantinedRole,
            permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            reason: "Foundation setup",
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
