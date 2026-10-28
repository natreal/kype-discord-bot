/**
 * The feed's promises, which are the ones the window depends on to stay on screen.
 *
 * Three of them are worth a test file on their own:
 *
 *   1. **`poll()` never throws.** The window has to keep drawing the last good numbers
 *      through a GitHub outage, so every failure path is a value — a reason, a counted
 *      failure, and the previous reading intact.
 *   2. **Nothing is invented.** A read that failed does not become a zero, and a live
 *      half that was never asked for stays `undefined` instead of turning into `null`
 *      (which means "asked, and it did not answer").
 *   3. **The history is bounded.** The window runs for hours; samples and log lines are
 *      capped rings, and the newest thing is always the one kept.
 */
import { describe, expect, it } from "vitest";

import { MonitorFeed, type LiveSource } from "../../src/monitor/sources.js";
import type { GitHubLiveFacts } from "../../src/services/github/live-feed.js";

const START = new Date("2026-10-25T12:00:00.000Z");

/** @returns the instant `seconds` after {@link START}. */
function at(seconds: number): Date {
  return new Date(START.getTime() + seconds * 1_000);
}

/** @returns a `progress.json` body: `librariesDone` of 12,309 libraries done. */
function body(librariesDone: number, shadersDone = 1_166): string {
  return JSON.stringify({
    libraries: {
      done: librariesDone,
      total: 12_309,
      percent: (100 * librariesDone) / 12_309,
      groups: [{ name: "libSceAgc", label: "Agc", done: 1, todo: 1 }],
    },
    shaders: {
      done: shadersDone,
      total: 1_166,
      percent: (100 * shadersDone) / 1_166,
      groups: [],
    },
  });
}

/** @returns a JSON response, with any extra headers the test cares about. */
function json(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch stand-in whose answer the test can change between polls. */
function server(): {
  readonly fetchImpl: typeof fetch;
  readonly calls: readonly string[];
  serve(next: () => Response): void;
} {
  let respond = (): Response => json(body(6_000));
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(new Request(input, init).url);
    return Promise.resolve(respond());
  };
  return {
    fetchImpl: impl as typeof fetch,
    calls,
    serve(next: () => Response): void {
      respond = next;
    },
  };
}

/** @returns live facts, with `overrides` applied last. */
function facts(overrides: Partial<GitHubLiveFacts> = {}): GitHubLiveFacts {
  return {
    fullName: "boykopovar/AnyPS5",
    description: null,
    defaultBranch: "main",
    stars: 48_124,
    forks: 4_521,
    watchers: 418,
    openIssues: 1_614,
    pushedAt: START,
    archived: false,
    release: null,
    workflow: null,
    languages: [],
    rateLimitRemaining: 46,
    rateLimitResetAt: null,
    authenticated: true,
    fetchedAt: START,
    ...overrides,
  };
}

/** A live source the test can re-answer, the way the real feed's cache would. */
function liveSource(authenticated = true): {
  readonly source: LiveSource;
  readonly calls: () => number;
  answer: GitHubLiveFacts | null;
} {
  let calls = 0;
  const state = { answer: null as GitHubLiveFacts | null };
  const source: LiveSource = {
    get isAuthenticated(): boolean {
      return authenticated;
    },
    latest(): Promise<GitHubLiveFacts | null> {
      calls += 1;
      return Promise.resolve(state.answer);
    },
  };
  return {
    source,
    calls: () => calls,
    get answer(): GitHubLiveFacts | null {
      return state.answer;
    },
    set answer(next: GitHubLiveFacts | null) {
      state.answer = next;
    },
  };
}

/** A feed over `server`, with the clock frozen at {@link START}. */
function feedOver(
  answers: ReturnType<typeof server>,
  options: { readonly live?: LiveSource; readonly intervalMs?: number } = {},
): { readonly feed: MonitorFeed; readonly clock: { now: Date } } {
  const clock = { now: START };
  const feed = new MonitorFeed({
    repository: "boykopovar/AnyPS5",
    intervalMs: options.intervalMs ?? 15_000,
    now: () => clock.now,
    fetchImpl: answers.fetchImpl,
    live: options.live ?? null,
  });
  return { feed, clock };
}

describe("MonitorFeed", () => {
  describe("before the first poll", () => {
    it("holds nothing, and says so rather than guessing", () => {
      const { feed } = feedOver(server());
      const state = feed.state();

      expect(state.progress).toBeNull();
      expect(state.progressFailure).toBeNull();
      expect(state.live).toBeUndefined();
      expect(state.samples).toEqual([]);
      expect(state.events).toEqual([]);
      expect(state.pollCount).toBe(0);
      expect(state.nextPollAt).toEqual(START);
    });
  });

  describe("a successful poll", () => {
    it("keeps the reading, announces it, and schedules the next one from now", async () => {
      const { feed } = feedOver(server());

      const state = await feed.poll();

      expect(state.progress?.libraries.done).toBe(6_000);
      expect(state.samples).toHaveLength(1);
      expect(state.progressFailure).toBeNull();
      expect(state.failureCount).toBe(0);
      expect(state.pollCount).toBe(1);
      expect(state.events.at(0)?.text).toMatch(/^first reading:/);
      expect(state.nextPollAt).toEqual(at(15));
    });

    it("keeps an identical reading as a sample but does not headline it", async () => {
      const { feed } = feedOver(server());
      await feed.poll();

      const state = await feed.poll();

      expect(state.samples).toHaveLength(2);
      expect(state.events.at(-1)?.text).toBe("progress.json unchanged since the previous poll");
      expect(state.events.at(-1)?.level).toBe("info");
    });

    it("names both counters when both moved", async () => {
      const answers = server();
      answers.serve(() => json(body(6_000, 1_165)));
      const { feed, clock } = feedOver(answers);
      await feed.poll();
      answers.serve(() => json(body(6_002, 1_166)));
      clock.now = at(15);

      const state = await feed.poll();

      expect(state.events.at(-1)?.text).toBe(
        "+2 libraries and +1 shader since the last poll (15s)",
      );
      expect(state.events.at(-1)?.level).toBe("good");
    });

    it("keeps the rebuild header, so a refetched snapshot can be told from a rebuilt one", async () => {
      const answers = server();
      const { feed } = feedOver(answers);
      answers.serve(() => json(body(6_000), 200, { "x-anyps5-progress-commit": "9f3c1aab" }));

      expect((await feed.poll()).progressCommit).toBe("9f3c1aab");
    });
  });

  describe("failures", () => {
    it("keeps the last good numbers when a later read fails", async () => {
      const answers = server();
      const { feed } = feedOver(answers);
      await feed.poll();
      answers.serve(() => json("upstream is unwell", 503));

      const state = await feed.poll();

      expect(state.progress?.libraries.done).toBe(6_000);
      expect(state.samples).toHaveLength(1);
      expect(state.progressFailure).toBe("progress.json answered HTTP 503");
      expect(state.failureCount).toBe(1);
      expect(state.events.at(-1)?.level).toBe("warn");
    });

    it("reports a first read that failed as bad rather than as a zero", async () => {
      const answers = server();
      answers.serve(() => json("upstream is unwell", 503));
      const { feed } = feedOver(answers);

      const state = await feed.poll();

      expect(state.progress).toBeNull();
      expect(state.samples).toEqual([]);
      expect(state.events.at(-1)?.level).toBe("bad");
    });

    it("treats a body that is not a snapshot as a failed read", async () => {
      const answers = server();
      answers.serve(() => json(JSON.stringify({ hello: "world" })));
      const { feed } = feedOver(answers);

      expect((await feed.poll()).progressFailure).toMatch(/unexpected shape/);
    });

    it("treats an unreachable host as a failed read, not as an exception", async () => {
      const { feed } = feedOver({
        ...server(),
        fetchImpl: (() =>
          Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch,
      });

      const state = await feed.poll();

      expect(state.progressFailure).toMatch(/unreachable: getaddrinfo ENOTFOUND/);
      expect(state.failureCount).toBe(1);
    });

    it("does not read twice when the runner ticks during a read", async () => {
      const live = liveSource();
      const answers = server();
      const { feed } = feedOver(answers, { live: live.source });

      const [first, second] = await Promise.all([feed.poll(), feed.poll()]);

      expect(first.pollCount).toBe(1);
      expect(second.pollCount).toBe(1);
      expect(live.calls()).toBe(1);
    });
  });

  describe("the live half", () => {
    it("announces the first reading and then keeps quiet about a cached one", async () => {
      const live = liveSource();
      live.answer = facts();
      const { feed } = feedOver(server(), { live: live.source });

      await feed.poll();
      const state = await feed.poll();

      expect(state.live?.stars).toBe(48_124);
      expect(state.liveFailure).toBeNull();
      expect(state.events.filter((event) => event.text.startsWith("live read:"))).toHaveLength(1);
    });

    it("records a release and a failed run as they appear", async () => {
      const live = liveSource();
      live.answer = facts();
      const { feed } = feedOver(server(), { live: live.source });
      await feed.poll();

      live.answer = facts({
        fetchedAt: at(60),
        release: { tag: "v0.1.3", name: "v0.1.3", publishedAt: at(0), url: "https://example.test" },
        workflow: {
          name: "Build",
          branch: "main",
          status: "completed",
          conclusion: "failure",
          updatedAt: at(60),
          url: "https://example.test",
        },
      });
      const state = await feed.poll();

      expect(state.events.some((event) => event.text === "release v0.1.3 published")).toBe(true);
      expect(
        state.events.some((event) => event.text === "Build failure" && event.level === "bad"),
      ).toBe(true);
    });

    it("explains an anonymous failure in terms the reader can fix", async () => {
      const live = liveSource(false);
      const { feed } = feedOver(server(), { live: live.source });

      const state = await feed.poll();

      expect(state.live).toBeNull();
      expect(state.liveFailure).toMatch(/GITHUB_TOKEN/);
      expect(state.failureCount).toBe(1);
      expect(state.events.at(-1)?.text).toMatch(/^live read: /);
    });

    it("leaves the live half undefined when the window was never given one", async () => {
      const { feed } = feedOver(server());

      const state = await feed.poll();

      expect(state.live).toBeUndefined();
      expect(state.liveFailure).toBeNull();
      expect(state.events.some((event) => event.text.startsWith("live read:"))).toBe(false);
    });
  });

  describe("bounds", () => {
    it("keeps a day of readings, and drops the ones the hourly charts cannot reach", async () => {
      const { feed, clock } = feedOver(server());

      clock.now = at(0);
      await feed.poll();
      clock.now = at(23 * 3_600);
      await feed.poll();
      // Lower than the newest reading minus the day the charts look back over: there is
      // no column left to draw it in, and keeping it would only cost memory.
      clock.now = at(24 * 3_600 + 900);
      await feed.poll();

      const samples = feed.state().samples;

      expect(samples.map((sample) => sample.at)).toEqual([at(23 * 3_600), at(24 * 3_600 + 900)]);
      // The newest reading is never dropped, whatever the cutoff would say.
      expect(samples.at(-1)?.at).toEqual(feed.state().progress?.at);
    });

    it("keeps every reading of a fast run inside the day, and 200 log lines", async () => {
      const live = liveSource();
      live.answer = facts();
      const { feed, clock } = feedOver(server(), { live: live.source });

      for (let index = 0; index < 245; index += 1) {
        clock.now = at(index * 15);
        await feed.poll();
      }

      const state = feed.state();

      // Retention is a day, not a count: 245 polls is less than an hour, so all of them
      // are still history the charts can use. The log is the thing that is capped.
      expect(state.samples).toHaveLength(245);
      expect(state.samples.at(0)?.at).toEqual(at(0));
      expect(state.samples.at(-1)?.at).toEqual(at(244 * 15));
      expect(state.events).toHaveLength(200);
    });
  });

  describe("pausing", () => {
    it("resumes into a poll now, not into the countdown the pause interrupted", () => {
      const { feed, clock } = feedOver(server());
      clock.now = at(60);
      feed.setPaused(true);
      clock.now = at(600);
      feed.setPaused(false);

      expect(feed.state().paused).toBe(false);
      expect(feed.state().nextPollAt).toEqual(at(600));
    });
  });
});
