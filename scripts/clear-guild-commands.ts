/**
 * Removes the guild-scoped copies of every command, in every guild.
 *
 * ## Why this exists
 *
 * Discord keeps commands in two independent scopes and treats a command name as
 * unique *within* a scope, not across scopes — the docs say an app "can have a
 * global and guild CHAT_INPUT command with the same name". Publishing the same
 * payload to both therefore lists **every command twice**, and the two copies are
 * separate objects: deleting the global ones does not touch the guild ones, and
 * `COMMANDS_DEPLOY_SCOPE=global` only stops *new* guild copies from being written.
 * Server settings can only delete one command at a time, by hand, per server.
 *
 * ## Why it does not use the bot's client
 *
 * The obvious implementation would reuse `CommandDeploymentService`, whose
 * `clearGuildScope()` already does the right `PUT` with an empty body. Getting there
 * through a gateway client, though, needs `DISCORD_DEV_GUILD_ID` (the setup script
 * resolves a target guild before it branches), privileged intents to populate the
 * guild cache, and a database connection for the deployment repository. None of those
 * are needed to clear a scope, and requiring them means the repair command fails
 * exactly when an operator is least able to fix the problem.
 *
 * So this script uses only what it genuinely needs: the token, the application ID,
 * and the REST API. It authenticates as the bot, enumerates the guilds the bot is in,
 * and clears each guild's command scope. The global scope is never touched, so the
 * commands stay usable throughout and there is no window where the bot has none.
 *
 * Usage:
 *   npm run deploy:clear-guilds                 # every guild
 *   npm run deploy:clear-guilds -- --yes        # skip the non-interactive guard
 *   npm run deploy:clear-guilds -- --guild <id> # only one guild
 *   npm run deploy:clear-guilds -- --dry-run    # report, change nothing
 */

import { createConfig } from "../src/config/config.js";
import { createLogger } from "../src/services/logger/index.js";
import { ConsoleSink } from "../src/services/logger/sinks.js";

interface CliOptions {
  readonly assumeYes: boolean;
  readonly dryRun: boolean;
  readonly guildId: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const guildIndex = argv.indexOf("--guild");
  return {
    assumeYes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    guildId: guildIndex >= 0 ? (argv[guildIndex + 1] ?? null) : null,
  };
}

const logger = createLogger("clear-commands", {
  level: "info",
  sinks: [new ConsoleSink({ color: false })],
});

const API = "https://discord.com/api/v10";

/** A minimal REST call that separates "the request worked" from "the body parsed". */
async function request(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "DiscordBot (command-deployment, 1.0)",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });

  // A 204 has no body, and the body of a 403 is the useful part of the error.
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

/** Turns a Discord error body into one readable clause. */
function describe(body: unknown, status: number): string {
  if (body && typeof body === "object" && "message" in body) {
    return String((body as { message: unknown }).message);
  }
  if (typeof body === "string" && body.length > 0) {
    return body.slice(0, 200);
  }
  return `HTTP ${status}`;
}

/** @returns the command names a guild currently holds in its guild scope. */
async function guildCommandNames(clientId: string, token: string, id: string): Promise<string[]> {
  const response = await request(`/applications/${clientId}/guilds/${id}/commands`, token);
  return Array.isArray(response.body)
    ? (response.body as { name: string }[]).map((command) => command.name)
    : [];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = createConfig();
  const { token, clientId } = config.discord;

  // What Discord currently holds, before anything is changed. This is the check that
  // matters: it confirms the duplication is real and lives in the guild scope, rather
  // than inferring it from the client's behaviour.
  const global = await request(`/applications/${clientId}/commands`, token);
  if (global.status !== 200) {
    throw new Error(
      `Could not read the global commands (${describe(global.body, global.status)}). ` +
        "Check DISCORD_TOKEN and DISCORD_CLIENT_ID.",
    );
  }
  const globalCommands = Array.isArray(global.body) ? global.body : [];
  logger.info("Global commands currently registered", { count: globalCommands.length });

  // `with_counts` is what makes the guild list complete: the plain endpoint omits
  // guilds under 100 members, which for a distributed bot is most of them.
  const guildsResponse = await request(`/users/@me/guilds?with_counts=true&limit=200`, token);
  if (guildsResponse.status !== 200) {
    throw new Error(
      `Could not list the bot's guilds (${describe(guildsResponse.body, guildsResponse.status)}).`,
    );
  }
  const guildList = (Array.isArray(guildsResponse.body) ? guildsResponse.body : []) as {
    id: string;
    name: string;
  }[];

  const targets = options.guildId
    ? guildList.filter((guild) => guild.id === options.guildId)
    : guildList;

  if (options.guildId && targets.length === 0) {
    throw new Error(`The bot is not in guild ${options.guildId}, so there is nothing to clear.`);
  }

  // Report each guild's current count *before* clearing, so the output shows cause and
  // effect and not just an assertion that something happened.
  const affected: { id: string; name: string; names: string[] }[] = [];
  for (const guild of targets) {
    const names = await guildCommandNames(clientId, token, guild.id);
    if (names.length > 0) {
      affected.push({ id: guild.id, name: guild.name, names });
    }
  }

  logger.info("Guild-scoped commands found", {
    guilds: targets.length,
    guildsWithGuildCommands: affected.length,
    totalGuildCommands: affected.reduce((sum, guild) => sum + guild.names.length, 0),
  });
  for (const guild of affected) {
    logger.info("  has guild copies", {
      name: guild.name,
      guildId: guild.id,
      commands: guild.names.length,
      sample: guild.names.slice(0, 5),
    });
  }

  if (affected.length === 0) {
    logger.info("Nothing to clear: no guild holds guild-scoped commands", {
      globalCommandsRemain: globalCommands.length,
    });
    return;
  }

  if (options.dryRun) {
    logger.info("Dry run: nothing was changed", { wouldClear: affected.length });
    return;
  }

  if (!options.assumeYes && !process.stdin.isTTY) {
    // Non-interactive without --yes would otherwise hang, so the refusal is explicit
    // and names the flag that means "go ahead".
    throw new Error("Refusing to clear without confirmation. Re-run with --yes to proceed.");
  }

  let cleared = 0;
  const failures: string[] = [];
  for (const guild of affected) {
    // The documented way to remove every command in a scope: a bulk overwrite with an
    // empty list. Deleting one by one would be one request per command.
    const result = await request(`/applications/${clientId}/guilds/${guild.id}/commands`, token, {
      method: "PUT",
      body: "[]",
    });
    if (result.status === 200 || result.status === 204) {
      cleared += 1;
      logger.info("Cleared", { name: guild.name, guildId: guild.id });
    } else {
      const reason = describe(result.body, result.status);
      failures.push(`${guild.name} (${guild.id}): ${reason}`);
      logger.warn("Could not clear", { guildId: guild.id, reason });
    }
  }

  // Verify rather than assume: a 200 on the PUT is not proof the commands are gone.
  let stillPresent = 0;
  for (const guild of affected) {
    const remaining = await guildCommandNames(clientId, token, guild.id);
    if (remaining.length > 0) {
      stillPresent += 1;
      logger.warn("Still holds guild commands", { guildId: guild.id, remaining: remaining.length });
    }
  }

  logger.info("Clear complete", {
    cleared,
    failed: failures.length,
    stillPresent,
    globalCommandsRemain: globalCommands.length,
  });

  for (const failure of failures) {
    process.stderr.write(`  failed: ${failure}\n`);
  }

  process.stdout.write(
    `\nRemoved the guild-scoped copies in ${cleared} guild(s).\n` +
      `${globalCommands.length} global command(s) remain, so the bot still works — ` +
      "only the duplicates are gone.\n" +
      "The client may keep showing the old list briefly: reload with Ctrl+R.\n",
  );

  process.exitCode = failures.length > 0 || stillPresent > 0 ? 1 : 0;
}

await main();
