/**
 * The monitor's two sources: the published `progress.json`, and GitHub's live view.
 *
 * `frame.ts` is a pure function of a model, and {@link MonitorFeed} is the other half:
 * the only part of the monitor that touches the network, the clock and the history. It
 * is a class rather than a function because a window *accumulates* — every poll adds a
 * sample (the trend, the pace), a line (the log) and possibly a failure (the counter) —
 * and the frame is redrawn about fifteen times between polls from state that has to
 * outlive them.
 *
 * Three rules, all of them borrowed from `/github`, because a monitor is a view and a
 * view must not be able to break itself:
 *
 * - **A failure is a value.** {@link MonitorFeed.poll} never throws. A read that fails
 *   records its reason, counts a failure and leaves the last good numbers on screen,
 *   so the window keeps showing the last known state instead of a stack trace.
 * - **Nothing is invented.** A failed read does not become a zero: `progress` stays
 *   `null` until a snapshot is actually parsed, and a live read that did not answer is
 *   `null` rather than an object full of zeros.
 * - **Bounded.** Samples and log lines are capped. The window runs for hours, and an
 *   unbounded array of either is a memory leak with a nicer name.
 */
import { formatCount } from "../modules/repository/repository.events.js";
import {
  MAX_PROGRESS_BYTES,
  parseProgressSnapshot,
  type AnyPs5Progress,
} from "../services/anyps5/progress.js";
import { PROGRESS_URL } from "../services/anyps5/repository.probe.js";
import type { GitHubLiveFacts } from "../services/github/live-feed.js";
import { toError } from "../utils/errors.js";
import {
  sampleOf,
  type MonitorEvent,
  type MonitorLevel,
  type MonitorSample,
  type MonitorState,
} from "./model.js";

/** The window's cadence by default: often enough that the bars visibly move. */
export const DEFAULT_INTERVAL_MS = 15_000;

/**
 * How much history the window keeps: a day of polls.
 *
 * The cadence is still fifteen seconds, but a chart that showed those readings raw would
 * only ever be able to answer "the last few minutes". Keeping the day is what lets
 * {@link hourlyBuckets} draw a column per hour, and a day at this cadence is 5,760 small
 * immutable objects — cheaper than the terminal it is drawn on.
 */
const HISTORY_MS = 24 * 60 * 60_000;
/**
 * A ceiling on held readings, because the day is expressed in time and `--interval`
 * decides how many readings fit in it. At the default cadence the ceiling is never
 * reached; a one-second interval hits it after an hour and a half, and the window still
 * has hours to draw.
 */
const SAMPLE_LIMIT = 10_000;
/** Log lines kept: enough to explain the last few minutes, not a log file. */
const EVENT_LIMIT = 200;
/** A window poll must not hang behind a dead Pages host. */
const PROGRESS_TIMEOUT_MS = 15_000;
/** Characters of a commit hash that are worth a log line. */
const SHORT_SHA = 7;

/** What one `progress.json` read produced, success or failure. */
interface ProgressRead {
  readonly progress: AnyPs5Progress | null;
  readonly reason: string | null;
  readonly commit: string | null;
}

/**
 * The slice of the live feed the monitor uses.
 *
 * An interface rather than the live feed class itself: the class carries private
 * state, which makes its type nominal, and a monitor test that had to build a whole
 * `GitHubClient` to answer four hard-coded fields would be testing the client instead.
 * The real feed satisfies this shape structurally, so production wiring is unchanged.
 */
export interface LiveSource {
  readonly isAuthenticated: boolean;
  latest(): Promise<GitHubLiveFacts | null>;
}

/** What the feed needs: which project to watch, and how to reach it. */
export interface MonitorFeedOptions {
  /** `owner/name`, as the header shows it and as GitHub addresses it. */
  readonly repository: string;
  /** How often the runner intends to poll; the countdown is drawn from it. */
  readonly intervalMs?: number;
  /** Overridable so a test can serve a snapshot instead of reaching the network. */
  readonly progressUrl?: string;
  /**
   * The live half. `null` (or omitted) means this window shows progress only, which is
   * what `state.live === undefined` renders as: "not asked", not "failed".
   */
  readonly live?: LiveSource | null;
  /** Overridable so tests do not depend on the wall clock. */
  readonly now?: () => Date;
  /** Overridable so tests do not touch the network at all. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The monitor's state machine: poll, compare, record, repeat.
 *
 * Nothing here knows about terminals. The runner asks for a {@link MonitorState} and
 * the renderer turns it into lines; between them a poll can fail, a read can come back
 * cached, and the window can be paused without either of those noticing.
 */
export class MonitorFeed {
  private readonly repository: string;
  private readonly intervalMs: number;
  private readonly progressUrl: string;
  private readonly live: LiveSource | null;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly startedAt: Date;

  private paused = false;
  private polling = false;
  private pollCount = 0;
  private failureCount = 0;
  private nextPollAt: Date;
  private progress: MonitorSample | null = null;
  private progressFailure: string | null = null;
  private progressCommit: string | null = null;
  private samples: MonitorSample[] = [];
  private facts: GitHubLiveFacts | null | undefined = undefined;
  private liveFailure: string | null = null;
  private events: MonitorEvent[] = [];

  public constructor(options: MonitorFeedOptions) {
    this.repository = options.repository;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.progressUrl = options.progressUrl ?? PROGRESS_URL;
    this.live = options.live ?? null;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.startedAt = this.now();
    this.nextPollAt = this.startedAt;
  }

  /** @returns every fact the frame draws, as one immutable snapshot. */
  public state(): MonitorState {
    return {
      repository: this.repository,
      startedAt: this.startedAt,
      intervalMs: this.intervalMs,
      paused: this.paused,
      authenticated: this.live?.isAuthenticated ?? false,
      polling: this.polling,
      nextPollAt: this.nextPollAt,
      pollCount: this.pollCount,
      failureCount: this.failureCount,
      progress: this.progress,
      progressFailure: this.progressFailure,
      progressCommit: this.progressCommit,
      samples: [...this.samples],
      live: this.facts,
      liveFailure: this.liveFailure,
      events: [...this.events],
    };
  }

  /**
   * Pauses or resumes the feed.
   *
   * Resuming schedules a poll for *now* rather than for the instant the pause began:
   * the window was frozen for as long as the user was reading it, and resuming into a
   * countdown with minutes left on it would look like the monitor stayed broken.
   */
  public setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.nextPollAt = this.now();
    }
  }

  /**
   * @returns the state after one poll of both sources. Never throws.
   *
   * Both reads run in parallel and are applied in a fixed order — progress, then live —
   * so the log reads chronologically even though the calls race. A call made while one
   * is in flight is a no-op: the runner ticks every second and cannot be expected to
   * know a fifteen-second read is still going.
   */
  public async poll(): Promise<MonitorState> {
    if (this.polling) {
      return this.state();
    }
    this.polling = true;
    this.pollCount += 1;
    const at = this.now();
    try {
      const [progress, live] = await Promise.all([this.readProgress(), this.readLive()]);
      this.applyProgress(progress, at);
      this.applyLive(live);
    } finally {
      this.polling = false;
      // Scheduled from the *start* of the poll, so a slow read shortens the wait
      // instead of pushing it out: the cadence is a cadence, not a timeout.
      this.nextPollAt = new Date(at.getTime() + this.intervalMs);
    }
    return this.state();
  }

  /**
   * @returns the snapshot, or the reason it could not be read.
   *
   * The same checks the hourly probe makes, for the same reason: a Pages host can answer
   * 200 with an error page, and a snapshot that fails validation is a *failed read*, not
   * a zeroed reading. The commit header is kept because it is the only thing that says the
   * published numbers were rebuilt rather than merely refetched.
   */
  private async readProgress(): Promise<ProgressRead> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.progressUrl, {
        headers: { Accept: "application/json", "User-Agent": "kype-monitor" },
        signal: AbortSignal.timeout(PROGRESS_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        progress: null,
        reason: `progress.json unreachable: ${toError(error).message}`,
        commit: null,
      };
    }

    if (!response.ok) {
      return {
        progress: null,
        reason: `progress.json answered HTTP ${response.status}`,
        commit: null,
      };
    }

    const text = await response.text().catch(() => "");
    if (text.length > MAX_PROGRESS_BYTES) {
      return { progress: null, reason: "progress.json is larger than expected", commit: null };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return { progress: null, reason: "progress.json is not valid JSON", commit: null };
    }

    try {
      return {
        progress: parseProgressSnapshot(raw),
        reason: null,
        commit: response.headers.get("x-anyps5-progress-commit"),
      };
    } catch (error) {
      return { progress: null, reason: toError(error).message, commit: null };
    }
  }

  /**
   * Records one `progress.json` read.
   *
   * A reading identical to the previous one is still *kept*: the trend is a time series,
   * and a flat point is information — it is what makes "nothing moved for six minutes"
   * visible instead of being inferred from a gap in the line.
   */
  private applyProgress(read: ProgressRead, at: Date): void {
    if (read.progress === null) {
      this.progressFailure = read.reason ?? "progress.json could not be read";
      this.failureCount += 1;
      // A failure before the first success is the whole panel's problem; after one it is
      // a stale gauge, and the frame keeps drawing the last numbers under the message.
      this.record(this.progress === null ? "bad" : "warn", this.progressFailure);
      return;
    }

    const previous = this.progress;
    const sample = sampleOf(read.progress, at);
    this.progressFailure = null;
    this.progress = sample;
    this.push(sample);

    if (previous !== null && read.commit !== null && read.commit !== this.progressCommit) {
      this.record("info", `progress.json rebuilt from ${read.commit.slice(0, SHORT_SHA)}`);
    }
    this.progressCommit = read.commit ?? this.progressCommit;

    if (previous === null) {
      this.record(
        "good",
        `first reading: ${counts(sample.libraries)} libraries, ${counts(sample.shaders)} shaders`,
      );
      return;
    }

    const libraries = sample.libraries.done - previous.libraries.done;
    const shaders = sample.shaders.done - previous.shaders.done;
    if (libraries === 0 && shaders === 0) {
      this.record("info", "progress.json unchanged since the previous poll");
      return;
    }
    const moved = [
      describeMove(libraries, "library", "libraries"),
      describeMove(shaders, "shader", "shaders"),
    ].filter((piece) => piece.length > 0);
    // A falling counter is not good news: the upstream scan can lose files as well as
    // gain them, and a monitor that painted that green would be lying.
    this.record(
      libraries < 0 || shaders < 0 ? "warn" : "good",
      `${moved.join(" and ")} since the last poll (${elapsed(previous.at, at)})`,
    );
  }

  /** @returns the live half's reading, `null` if it failed, `undefined` if not asked. */
  private async readLive(): Promise<GitHubLiveFacts | null | undefined> {
    if (this.live === null) {
      return undefined;
    }
    return this.live.latest();
  }

  /**
   * Records one live read.
   *
   * `undefined` means this window was never given a live half and is left alone; `null`
   * means one was asked for and GitHub did not answer, which the frame draws as a missing
   * panel rather than a panel full of zeros. The transitions — a release appearing, CI
   * finishing, the repository being archived — are the reason a live feed is worth a panel:
   * they are the facts that change within a session.
   */
  private applyLive(facts: GitHubLiveFacts | null | undefined): void {
    if (facts === undefined) {
      return;
    }

    const before = this.facts;
    if (facts === null) {
      this.liveFailure = this.liveReason();
      this.facts = null;
      this.failureCount += 1;
      this.record(
        before === null || before === undefined ? "bad" : "warn",
        `live read: ${this.liveFailure}`,
      );
      return;
    }

    this.liveFailure = null;
    if (before !== null && before !== undefined && sameInstant(before.fetchedAt, facts.fetchedAt)) {
      // The same cached reading: a fifteen-second poll against a two-minute cache would
      // otherwise fill the log with identical lines.
      this.facts = facts;
      return;
    }
    this.facts = facts;

    if (before === null) {
      this.record("good", `live read is back: stars ${formatCount(facts.stars)}`);
      return;
    }
    if (before === undefined) {
      this.record("info", `live read: ${describeLive(facts)}`);
      return;
    }

    this.record("info", `live read: ${describeLive(facts)}`);
    if (facts.release !== null && facts.release.tag !== before.release?.tag) {
      this.record("good", `release ${facts.release.tag} published`);
    }
    const conclusion = facts.workflow?.conclusion ?? null;
    if (conclusion !== null && conclusion !== (before.workflow?.conclusion ?? null)) {
      const name = facts.workflow?.name ?? "CI";
      this.record(
        conclusion === "success" ? "good" : conclusion === "failure" ? "bad" : "info",
        `${name} ${conclusion}`,
      );
    }
    if (facts.archived && !before.archived) {
      this.record("bad", "the repository is archived");
    }
  }

  /** @returns why a live read failed, in terms the window's reader can act on. */
  private liveReason(): string {
    if (this.live !== null && !this.live.isAuthenticated) {
      return "no GITHUB_TOKEN — anonymous calls are limited to 60 an hour";
    }
    const spent =
      this.facts !== null && this.facts !== undefined && this.facts.rateLimitRemaining === 0;
    return spent
      ? "the hourly quota is spent — the window resets within the hour"
      : "GitHub did not answer";
  }

  /** Appends one line to the log, dropping the oldest beyond {@link EVENT_LIMIT}. */
  private record(level: MonitorLevel, text: string): void {
    this.events.push({ at: this.now(), level, text });
    if (this.events.length > EVENT_LIMIT) {
      this.events = this.events.slice(this.events.length - EVENT_LIMIT);
    }
  }

  /**
   * Keeps `sample`, dropping the readings older than {@link HISTORY_MS}.
   *
   * Time rather than a count, because the charts are drawn in hours: a count of 240 was
   * exactly one hour at the default cadence and half of one at `--interval 30`, which
   * would have made the same window show a different amount of history depending on how
   * it was started. The newest reading is always kept, whatever the cutoff says.
   */
  private push(sample: MonitorSample): void {
    this.samples.push(sample);
    const cutoff = sample.at.getTime() - HISTORY_MS;
    const fresh = this.samples.filter((held) => held.at.getTime() >= cutoff);
    this.samples = fresh.length > SAMPLE_LIMIT ? fresh.slice(fresh.length - SAMPLE_LIMIT) : fresh;
  }
}

/** @returns `count` as a move worth reporting — `+7 libraries`, or `""` for no change. */
function describeMove(count: number, one: string, many: string): string {
  if (count === 0) {
    return "";
  }
  const noun = Math.abs(count) === 1 ? one : many;
  return `${count > 0 ? "+" : "-"}${formatCount(Math.abs(count))} ${noun}`;
}

/** @returns `done / total`, the pair every progress line in the project prints. */
function counts(section: { readonly done: number; readonly total: number }): string {
  return `${formatCount(section.done)} / ${formatCount(section.total)}`;
}

/** @returns the live facts as one log line, in the order a reader cares about them. */
function describeLive(facts: GitHubLiveFacts): string {
  const parts = [
    `${formatCount(facts.stars)} stars`,
    `${formatCount(facts.forks)} forks`,
    `${formatCount(facts.openIssues)} open issues`,
    facts.rateLimitRemaining === null
      ? "quota unknown"
      : `quota ${formatCount(facts.rateLimitRemaining)}`,
  ];
  return parts.join(" · ");
}

/** @returns how long `to` is after `from`, in the shortest readable form. */
function elapsed(from: Date, to: Date): string {
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** @returns whether two dates name the same instant. */
function sameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}
