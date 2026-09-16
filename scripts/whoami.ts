/**
 * Identity check.
 *
 * Calls Discord's `/users/@me` to confirm the token is valid, report which bot it
 * belongs to, and list the guilds the bot is currently in. Useful when command
 * deployment returns `Missing Access` (50001), which means the bot has not been
 * invited to the target guild yet.
 *
 * Usage: node --env-file-if-exists=.env scripts/whoami.mjs
 */
import { config } from "dotenv";

config({ quiet: true });

const token = process.env.DISCORD_TOKEN ?? "";
const clientId = process.env.DISCORD_CLIENT_ID ?? "";

const auth = { Authorization: `Bot ${token}` };

const me = await fetch("https://discord.com/api/v10/users/@me", { headers: auth });
const meData = await me.json();

console.log("HTTP status    :", me.status);

if (!me.ok) {
  console.log("error          :", meData.message, `(${meData.code})`);
  process.exit(1);
}

console.log("bot username   :", `${meData.username}#${meData.discriminator}`);
console.log("bot id         :", meData.id);
console.log("is a bot       :", meData.bot);
console.log("matches CLIENT_ID:", meData.id === clientId);

const guildsResponse = await fetch("https://discord.com/api/v10/users/@me/guilds", {
  headers: auth,
});
const guilds = await guildsResponse.json();

if (Array.isArray(guilds)) {
  console.log("guild count    :", guilds.length);
  for (const guild of guilds) {
    console.log(`  - ${guild.name} (${guild.id})`);
  }
  const devGuildId = process.env.DISCORD_DEV_GUILD_ID;
  if (devGuildId) {
    const present = guilds.some((guild) => guild.id === devGuildId);
    console.log(`in DEV_GUILD  : ${present ? "yes" : "NO - invite the bot first"}`);
  }
} else {
  console.log("guild list     :", guilds.message, `(${guilds.code})`);
}
