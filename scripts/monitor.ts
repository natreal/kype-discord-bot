/**
 * `npm run monitor` — a live, full-screen window on anyPS5.
 *
 * The window is the same data `/github` answers with, at a cadence a terminal can show
 * rather than a channel can afford: `progress.json` polled every fifteen seconds and
 * GitHub's live facts behind it, drawn as a frame that rewrites itself in place.
 *
 * Usage:
 *
 *     npm run monitor                  the window, until you press q
 *     npm run monitor -- --once        one plain frame, then exit (pipe- and log-friendly)
 *     npm run monitor -- --interval 5  poll every five seconds
 *     npm run monitor -- --no-color    keep the layout, drop the colour
 *     npm run monitor -- --inline      print frames instead of taking the screen
 *     npm run monitor -- --repo owner/name
 *
 * The repository defaults to `GITHUB_REPOSITORY`, then to the project the bot already
 * watches, so the usual case is no arguments at all. `GITHUB_TOKEN` is optional and
 * worth setting: a token raises the live half from sixty calls an hour to five thousand,
 * which is the difference between a panel that refreshes and one that mostly says
 * "quota spent".
 */
import { config as loadEnv } from "dotenv";

import { DEFAULT_REPOSITORY } from "../src/config/config.js";
import { runMonitor } from "../src/monitor/index.js";
import { DEFAULT_INTERVAL_MS, MonitorFeed } from "../src/monitor/sources.js";
import { Terminal } from "../src/monitor/tty.js";
import { GitHubClient } from "../src/services/github/client.js";
import { GitHubLiveFeed } from "../src/services/github/live-feed.js";
import { toError } from "../src/utils/errors.js";

const USAGE = `kype monitor — a live window on anyPS5

  npm run monitor                  the window, until you press q
  npm run monitor -- --once        one plain frame, then exit
  npm run monitor -- --interval 5  poll every five seconds (default 15)
  npm run monitor -- --no-color    keep the layout, drop the colour
  npm run monitor -- --inline      print frames instead of taking the screen
  npm run monitor -- --repo owner/name

The window: [q] quit  [space] pause  [r] refresh  F11 full screen
GITHUB_TOKEN raises the live panel from 60 calls an hour to 5,000.`;

/** The command line, once it has been read. */
interface MonitorArgs {
  readonly once: boolean;
  readonly inline: boolean;
  readonly color: boolean;
  readonly intervalMs: number;
  readonly repository: string;
  readonly help: boolean;
}

/**
 * @returns the parsed command line.
 * @throws Error naming the argument it did not understand or the value it could not read.
 */
function parseArgs(argv: readonly string[]): MonitorArgs {
  let once = false;
  let inline = false;
  let color = true;
  let help = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let repository = process.env["GITHUB_REPOSITORY"] ?? DEFAULT_REPOSITORY;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--once") {
      once = true;
    } else if (arg === "--inline") {
      inline = true;
    } else if (arg === "--fullscreen") {
      // The default; accepted because the help text and muscle memory both offer it.
      inline = false;
    } else if (arg === "--no-color") {
      color = false;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--interval") {
      index += 1;
      intervalMs = seconds(argv[index]);
    } else if (arg.startsWith("--interval=")) {
      intervalMs = seconds(arg.slice("--interval=".length));
    } else if (arg === "--repo") {
      index += 1;
      repository = argv[index] ?? repository;
    } else if (arg.startsWith("--repo=")) {
      repository = arg.slice("--repo=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { once, inline, color, intervalMs, repository, help };
}

/**
 * @returns `value` as a poll interval in milliseconds.
 * @throws Error when it is not a positive number of seconds.
 */
function seconds(value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--interval expects a positive number of seconds, got ${value ?? "nothing"}`);
  }
  return Math.round(parsed * 1_000);
}

/** Builds the feed and runs the window; resolves once the screen has been handed back. */
async function main(): Promise<void> {
  loadEnv({ quiet: true });

  let args: MonitorArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(toError(error).message);
    console.error(`\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const [owner, repo] = args.repository.split("/");
  if (owner === undefined || repo === undefined || owner === "" || repo === "") {
    console.error(`--repo expects owner/name, got "${args.repository}"`);
    process.exitCode = 1;
    return;
  }

  const isTty = process.stdout.isTTY === true;
  if (!args.once && !args.inline && !isTty) {
    console.error("This is not a terminal. Use --once for one frame, or --inline to print frames.");
    process.exitCode = 1;
    return;
  }

  const token = process.env["GITHUB_TOKEN"];
  const client = new GitHubClient({
    token: token === undefined || token === "" ? undefined : token,
    userAgent: "kype-monitor",
  });

  // The live half is optional by construction: without a token it still answers, just
  // rarely, and the window's header says "anonymous" instead of "token" so the reason
  // a panel is stale is on the screen rather than in the reader's head.
  const live = new GitHubLiveFeed({ client, target: { owner, repo } });
  const feed = new MonitorFeed({
    repository: args.repository,
    intervalMs: args.intervalMs,
    live,
  });
  const terminal = new Terminal({
    interactive: !args.once && !args.inline && isTty,
  });

  await runMonitor({
    feed,
    terminal,
    once: args.once,
    color: args.color && isTty,
  });
}

await main();
