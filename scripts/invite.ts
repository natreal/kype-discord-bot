/**
 * Prints the pre-configured invite links for this bot.
 *
 * Usage:
 *   npx tsx scripts/invite.ts                     # recommended profile
 *   npx tsx scripts/invite.ts administrator       # administrator profile
 *   npx tsx scripts/invite.ts recommended --guild # pre-select the dev guild
 *
 * Reads `DISCORD_CLIENT_ID` and `DISCORD_DEV_GUILD_ID` from `.env`, so the links
 * always match the deployed configuration.
 */
import { createConfig } from "../src/config/config.js";
import { buildInviteLink, profilePermissionValue } from "../src/utils/invite.js";
import { INSTALL_PROFILES, type InstallProfile } from "../src/services/permissions/index.js";

const requested = process.argv[2];
const profile: InstallProfile =
  requested && INSTALL_PROFILES.includes(requested as InstallProfile)
    ? (requested as InstallProfile)
    : "recommended";

const preselectGuild = process.argv.includes("--guild");
const { discord } = createConfig();

const link = buildInviteLink({
  clientId: discord.clientId,
  profile,
  ...(preselectGuild && discord.devGuildId ? { guildId: discord.devGuildId } : {}),
});

process.stdout.write(
  [
    `Profile            : ${profile}`,
    `Permission value   : ${profilePermissionValue(profile)}`,
    `Pre-select guild   : ${preselectGuild && discord.devGuildId ? discord.devGuildId : "no"}`,
    "",
    "Invite link:",
    link,
    "",
  ].join("\n"),
);
