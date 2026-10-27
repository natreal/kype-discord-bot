/**
 * `!g` — the `/github` panels, typed instead of clicked.
 *
 * A slash command needs Discord to have registered it, an ephemeral reply to be
 * dismissed, and a client that renders select menus; a message prefix needs none of
 * those. `!g` therefore exists so the same numbers are one short line away in a
 * channel where the command tree is still propagating, in a client that hides
 * components, or for a reader who would rather type than navigate Discord's UI.
 *
 * This file is the *parser* only: it turns text into the same request the command's
 * own options produce, so the two surfaces cannot drift into showing different
 * panels. Rendering is shared with `/github` (`buildGithubView`, `renderView`).
 *
 * Recognised forms, case-insensitively, with any whitespace between the parts:
 *
 *   `!g`                    → overview
 *   `!g libraries`          → that panel
 *   `!g graph bars`         → graph, bar style
 *   `!g report 4h`          → report over the last 4 hours
 *   `!g history 10`         → 10 stored snapshots
 *   `!g help`               → the list of forms
 *
 * Anything unrecognised answers with the help text rather than staying silent: a
 * typo that produces no reply is indistinguishable from a bot that is down.
 */
import { REPORT_RANGES, type ReportRangeId } from "./repository-report.analytics.js";
import type { ChartStyle } from "./repository-chart.js";
import type { GithubPanel } from "./github-view.js";

/** The prefix every invocation starts with. */
export const GITHUB_MESSAGE_PREFIX = "!g";

/** What a parsed `!g` invocation asks for. */
export type GithubMessageRequest =
  | { readonly kind: "panel"; readonly panel: GithubPanel; readonly style: ChartStyle }
  | { readonly kind: "report"; readonly range: ReportRangeId; readonly style: ChartStyle }
  | { readonly kind: "history"; readonly limit: number }
  | { readonly kind: "help" };

/** Rows `history` prints at most, mirroring what `/github history` allows. */
const HISTORY_LIMIT_MAX = 25;

/** The panels a short message may name, with the aliases people actually type. */
const PANEL_ALIASES: readonly { readonly words: readonly string[]; readonly panel: GithubPanel }[] =
  [
    { words: ["overview", "all", "status"], panel: "overview" },
    { words: ["libraries", "libs", "lib", "library"], panel: "libraries" },
    { words: ["timeline", "times", "table"], panel: "timeline" },
    { words: ["graph", "chart", "plot"], panel: "graph" },
    { words: ["why", "explain"], panel: "why" },
  ];

/**
 * @returns the request a message carries, or `null` when the message is not a `!g`
 * invocation at all.
 *
 * `null` is reserved for "this message is none of my business" — automod, the AI
 * agent and every other handler must keep seeing ordinary chat untouched. A message
 * that *is* addressed to `!g` but says something unrecognised resolves to `help`, so
 * the author gets an answer instead of silence.
 */
export function parseGithubMessage(content: string): GithubMessageRequest | null {
  const trimmed = content.trimStart();
  if (!trimmed.toLowerCase().startsWith(GITHUB_MESSAGE_PREFIX)) {
    return null;
  }
  // `!gx` is not `!g` with a typo, it is somebody else's prefix: the match must be the
  // whole word, or the bot would answer every command that happens to start `!g`.
  const rest = trimmed.slice(GITHUB_MESSAGE_PREFIX.length);
  if (rest.length > 0 && !/^\s/.test(rest)) {
    return null;
  }

  const words = rest
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return { kind: "panel", panel: "overview", style: "line" };
  }
  const first = words[0] ?? "";
  if (first === "help" || first === "?") {
    return { kind: "help" };
  }

  // The style may appear anywhere after the panel name: `!g graph bars` and
  // `!g bars graph` are the same request, and only one of them is worth refusing.
  const style: ChartStyle = words.includes("bars") ? "bars" : "line";
  // Dropped before the name is looked up, so the style word cannot be mistaken for it.
  const named = words.filter((word) => word !== "bars" && word !== "line");
  const firstNamed = named[0] ?? "";

  if (firstNamed === "report") {
    return { kind: "report", range: rangeFrom(named[1]), style };
  }
  if (firstNamed === "history" || firstNamed === "snapshots") {
    return { kind: "history", limit: limitFrom(named[1]) };
  }

  const panel = PANEL_ALIASES.find((entry) => entry.words.includes(firstNamed));
  return panel === undefined ? { kind: "help" } : { kind: "panel", panel: panel.panel, style };
}

/** @returns the report range a word names, defaulting to `1d` like the command. */
function rangeFrom(word: string | undefined): ReportRangeId {
  if (word === undefined) {
    return "1d";
  }
  return REPORT_RANGES.find((range) => range.id === word)?.id ?? "1d";
}

/** @returns the row count a word names, clamped to what `/github history` allows. */
function limitFrom(word: string | undefined): number {
  const parsed = Number.parseInt(word ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 12;
  }
  return Math.min(parsed, HISTORY_LIMIT_MAX);
}

/** @returns the help text a reader gets from `!g help`, or from a typo. */
export function githubMessageHelp(fullName: string): string {
  return [
    `**${GITHUB_MESSAGE_PREFIX}** — the /github panels, typed.`,
    "```",
    `${GITHUB_MESSAGE_PREFIX}                     the overview`,
    `${GITHUB_MESSAGE_PREFIX} libraries           every library, and how it moved`,
    `${GITHUB_MESSAGE_PREFIX} timeline            the last readings, newest first`,
    `${GITHUB_MESSAGE_PREFIX} graph               the trend as a text chart`,
    `${GITHUB_MESSAGE_PREFIX} graph bars          the same, on a labelled scale`,
    `${GITHUB_MESSAGE_PREFIX} why                 why the share moved`,
    `${GITHUB_MESSAGE_PREFIX} history 10          the last 10 stored snapshots`,
    `${GITHUB_MESSAGE_PREFIX} report              the last day at a glance`,
    `${GITHUB_MESSAGE_PREFIX} report 4h           4h, 12h, 1d, 3d or 7d`,
    "```",
    `-# ${fullName} · the same figures as \`/github\`, read from the project's progress.json`,
  ].join("\n");
}
