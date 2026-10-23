/**
 * Repository monitor tests.
 *
 * The suite asserts the promises an hourly notification makes, which are also the
 * ones a naive implementation breaks:
 *
 *   1. **the first refresh is a baseline.** Watching a repository must not dump its
 *      entire history into the channel.
 *   2. **a commit is announced once**, and an unchanged refresh announces nothing:
 *      an hourly "still 47.39%" trains the channel to ignore the bot.
 *   3. **a merge is a transition**, not a state: a pull request merged before the
 *      watch existed is never announced, and one merged while watching is announced
 *      once.
 *   4. **a statistic that moved is reported as a delta**, downwards included.
 *   5. **a failed source degrades to NULL, never to 0%**, and the snapshot is still
 *      stored, so the history records the gap.
 *   6. **an unpublished number is not invented**: with no `progress.json`, nothing
 *      claims a percentage.
 */
import { describe, expect, it, vi } from "vitest";
import { GuildMember, type ChatInputCommandInteraction } from "discord.js";

import type {
  GitHubClient,
  GitHubRequest,
  GitHubResult,
} from "../../src/services/github/client.js";
import {
  EMPTY_CACHE,
  RepositoryProbe,
  type RepositoryCache,
} from "../../src/services/anyps5/repository.probe.js";
import { RepositoryMonitorService } from "../../src/modules/repository/repository.service.js";
import { deriveEvents } from "../../src/modules/repository/repository.events.js";
import { buildReportContent } from "../../src/modules/repository/repository-report.content.js";
import type { ProgressEvent } from "../../src/services/anyps5/repository.types.js";
import type { SnapshotRecord } from "../../src/modules/repository/repository.types.js";
import { testLogger } from "../helpers/logger.js";
import { memoryMonitorRepository } from "../helpers/repository.js";
import githubCommand, { explainRefreshFailure } from "../../src/commands/utility/github.js";
import type { CommandExecutionContext } from "../../src/commands/context.js";

const NOW = new Date("2026-10-23T12:00:00.000Z");

/** A `progress.json` body with the two sections the project publishes. */
function progressBody(librariesDone: number, libraryPercent: number): unknown {
  return {
    libraries: {
      done: librariesDone,
      total: 11_697,
      percent: libraryPercent,
      groups: [
        {
          name: "libSceAgc",
          label: "Agc",
          done: 225,
          todo: 14,
          done_names: [],
          todo_names: [],
          inert_names: [],
        },
      ],
    },
    shaders: { done: 1_166, total: 1_166, percent: 100, groups: [] },
  };
}

/** A commit payload in GitHub's shape. */
function commitPayload(sha: string, message: string): unknown {
  return {
    sha,
    html_url: `https://github.com/boykopovar/AnyPS5/commit/${sha}`,
    commit: {
      message: `${message}\n\nbody`,
      author: { name: "Retr0G28", date: "2026-10-23T11:30:00.000Z" },
    },
  };
}

/** A pull-request payload in GitHub's shape. */
function pullPayload(number: number, options: { merged?: boolean } = {}): unknown {
  return {
    number,
    title: `Refactor #${number}`,
    state: options.merged === true ? "closed" : "open",
    draft: false,
    created_at: "2026-10-23T10:00:00.000Z",
    merged_at: options.merged === true ? "2026-10-23T11:00:00.000Z" : null,
    html_url: `https://github.com/boykopovar/AnyPS5/pull/${number}`,
    user: { login: "Retr0G28" },
  };
}

/** A GitHub client stand-in: each path answers from a queue of payloads. */
function fakeClient(responses: {
  repository?: unknown;
  commits?: unknown[][];
  pulls?: unknown[][];
  /** When true, every list endpoint answers `304 Not Modified`. */
  notModified?: boolean;
}): GitHubClient & { readonly calls: string[]; readonly requests: GitHubRequest[] } {
  const calls: string[] = [];
  const requests: GitHubRequest[] = [];
  const commits = [...(responses.commits ?? [])];
  const pulls = [...(responses.pulls ?? [])];
  const etag = (path: string): string => `etag-${path.split("/").at(-1) ?? path}`;
  const ok = (body: unknown, path: string): GitHubResult => ({
    ok: true,
    response: {
      status: 200,
      notModified: false,
      etag: etag(path),
      body,
      rateLimitRemaining: 4_999,
      rateLimitResetAt: 1_800_000_000,
    },
  });

  return {
    calls,
    requests,
    isAuthenticated: true,
    request: (request) => {
      calls.push(request.path);
      requests.push(request);
      if (responses.notModified === true && /\/pulls$|\/commits$/.test(request.path)) {
        return Promise.resolve({
          ok: true,
          response: {
            status: 304,
            notModified: true,
            etag: request.etag ?? null,
            body: undefined,
            rateLimitRemaining: 4_999,
            rateLimitResetAt: 1_800_000_000,
          },
        } satisfies GitHubResult);
      }
      if (request.path.endsWith("/commits")) {
        // The last queued page repeats, so a third reading sees an unchanged tree
        // rather than an empty one.
        const page = commits.length > 1 ? commits.shift() : commits[0];
        return Promise.resolve(ok(page ?? [], request.path));
      }
      if (request.path.endsWith("/pulls")) {
        const page = pulls.length > 1 ? pulls.shift() : pulls[0];
        return Promise.resolve(ok(page ?? [], request.path));
      }
      return Promise.resolve(
        ok(
          responses.repository ?? {
            full_name: "boykopovar/AnyPS5",
            description: "Tool for automatic PS5 executables porting to Linux and Windows",
            default_branch: "main",
            stargazers_count: 47_118,
            forks_count: 4_370,
            open_issues_count: 1_493,
            pushed_at: "2026-10-23T11:40:00.000Z",
          },
          request.path,
        ),
      );
    },
    download: () => Promise.reject(new Error("not used in these tests")),
  } as unknown as GitHubClient & { readonly calls: string[]; readonly requests: GitHubRequest[] };
}

/** A `fetch` stand-in serving one `progress.json` per call, then repeating the last. */
function fakeFetchQueue(bodies: unknown[], status: number): typeof fetch {
  let served = 0;
  return () => {
    const body = bodies[Math.min(served, bodies.length - 1)] ?? progressBody(5_543, 47.39);
    served += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-anyps5-progress-commit": "abc1234def" },
      }),
    );
  };
}

/** Builds the monitor over in-memory storage and fake network ports. */
function harness(options: {
  readonly progress?: unknown[];
  readonly commits?: unknown[][];
  readonly pulls?: unknown[][];
  readonly progressStatus?: number;
}) {
  const repository = memoryMonitorRepository();
  const probe = new RepositoryProbe({
    client: fakeClient({
      ...(options.commits === undefined ? {} : { commits: options.commits }),
      ...(options.pulls === undefined ? {} : { pulls: options.pulls }),
    }),
    target: { owner: "boykopovar", repo: "AnyPS5", branch: "main" },
    fetchImpl: fakeFetchQueue(
      options.progress ?? [progressBody(5_543, 47.39)],
      options.progressStatus ?? 200,
    ),
  });
  // Records what was published, including the events, so a test can assert the
  // message and the snapshot agree.
  const published: { readonly events: readonly ProgressEvent[] }[] = [];
  const report = {
    published,
    publish: vi.fn((_reading: unknown, _previous: unknown, events: readonly ProgressEvent[]) => {
      published.push({ events });
      return Promise.resolve(true);
    }),
  };
  const monitor = new RepositoryMonitorService({
    repository,
    probe,
    report,
    logger: testLogger,
    now: () => NOW,
  });
  return { repository, monitor, report };
}

/** Builds a stored snapshot for the pure tests. */
function snapshot(overrides: Partial<SnapshotRecord["state"]> = {}): SnapshotRecord {
  return {
    id: "snapshot-1",
    capturedAt: NOW,
    state: {
      stars: 47_100,
      forks: 4_300,
      openIssues: 1_500,
      libraryPercent: 47.39,
      librariesDone: 5_543,
      librariesTotal: 11_697,
      shaderPercent: 99.5,
      shadersDone: 1_160,
      shadersTotal: 1_166,
      ...overrides,
    },
    progressCommit: "abc1234",
    commitCount: 50,
    pullCount: 30,
    failures: [],
  };
}

describe("refreshing", () => {
  it("records a baseline and announces nothing on the first refresh", async () => {
    const { monitor, repository, report } = harness({
      commits: [[commitPayload("aaa111", "feat: first")]],
      pulls: [[pullPayload(1, { merged: true })]],
    });

    const result = await monitor.refresh();

    expect(result.baseline).toBe(true);
    expect(result.announced).toBe(0);
    // The pull request was already merged when the watch began: not news.
    expect(report.publish).not.toHaveBeenCalled();
    expect(repository.snapshots).toHaveLength(1);
    expect(repository.snapshots[0]?.state.libraryPercent).toBe(47.39);
    expect(repository.snapshots[0]?.progressCommit).toBe("abc1234def");
  });
  it("announces a newly implemented batch once, with the delta", async () => {
    const { monitor, repository, report } = harness({
      progress: [progressBody(5_543, 47.39), progressBody(5_555, 47.49)],
      commits: [
        [commitPayload("aaa111", "feat(prx): implement sceAc3EncEncode")],
        [
          // Newest first, exactly as GitHub returns a window of commits.
          commitPayload("bbb222", "feat(prx): implement sceAc3EncWaitEncode"),
          commitPayload("aaa111", "feat(prx): implement sceAc3EncEncode"),
        ],
      ],
      pulls: [[], []],
    });

    await monitor.refresh();
    const second = await monitor.refresh();

    expect(second.baseline).toBe(false);
    expect(second.announced).toBe(2);
    expect(repository.events.map((event) => event.kind)).toEqual(["libraries", "commits"]);

    // The delta is in percentage points *and* in functions, both derived from the
    // published totals rather than guessed.
    const progressText = repository.events[0]?.text ?? "";
    expect(progressText).toContain("47.39% → 47.49%");
    expect(progressText).toContain("+12 functions");
    expect(progressText).toContain("5555/11697");
    // Only the new commit is quoted.
    const commitText = repository.events[1]?.text ?? "";
    expect(commitText).toContain("implement sceAc3EncWaitEncode");
    expect(commitText.split("\n")).toHaveLength(1);
    expect(report.published).toHaveLength(1);
  });

  it("says nothing at all when an unchanged repository is refreshed again", async () => {
    const { monitor, repository, report } = harness({
      commits: [[commitPayload("aaa111", "feat: first")], [commitPayload("aaa111", "feat: first")]],
      pulls: [[], []],
    });

    await monitor.refresh();
    const second = await monitor.refresh();

    expect(second.announced).toBe(0);
    expect(report.publish).not.toHaveBeenCalled();
    // The snapshot is still recorded: a gap in the series must mean "the bot was
    // down", never "nothing happened".
    expect(repository.snapshots).toHaveLength(2);
  });

  it("announces a merge once, and only as a transition", async () => {
    const { monitor, repository } = harness({
      commits: [[], []],
      pulls: [[pullPayload(7)], [pullPayload(7, { merged: true })]],
    });

    await monitor.refresh();
    await monitor.refresh();

    const merged = repository.events.filter((event) => event.key === "pull-request:7:merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toContain("**Merged** PR #7");
  });

  it("stores a null percentage when progress.json is unavailable", async () => {
    const { monitor, repository } = harness({ progressStatus: 503, commits: [[], []] });

    const result = await monitor.refresh();

    expect(result.librariesPercent).toBeNull();
    expect(repository.snapshots[0]?.state.libraryPercent).toBeNull();
    // The gap is recorded as a failed source, not silently smoothed over.
    expect(repository.snapshots[0]?.failures).toContain("progress");
  });

  it("prunes snapshots older than the retention window", async () => {
    const { monitor, repository } = harness({ commits: [[], []] });

    await monitor.refresh();
    // Age the first snapshot past the window (100 hours at hourly cadence).
    const first = repository.snapshots[0];
    if (first !== undefined) {
      (first as { capturedAt: Date }).capturedAt = new Date(NOW.getTime() - 200 * 3_600_000);
    }
    await monitor.refresh();

    expect(repository.snapshots).toHaveLength(1);
  });
});

describe("event derivation", () => {
  /** A reading at the published 47.39% / 100% state. */
  const reading = {
    facts: {
      fullName: "boykopovar/AnyPS5",
      description: "Tool",
      defaultBranch: "main",
      stars: 47_118,
      forks: 4_370,
      openIssues: 1_493,
      pushedAt: null,
    },
    progress: {
      libraries: { done: 5_543, total: 11_697, percent: 47.39, groups: [] },
      shaders: { done: 1_166, total: 1_166, percent: 100, groups: [], extra: [] },
    },
    progressUnavailable: null,
    progressCommit: null,
    commits: [
      {
        sha: "ccc333",
        message: "fix(agc): correct packet history",
        author: "Retr0G28",
        committedAt: NOW,
        url: "",
      },
    ],
    pullRequests: [],
    fetchedAt: NOW,
  };

  it("reports a regression as a decrease instead of hiding it", () => {
    const events = deriveEvents(
      reading,
      snapshot({ libraryPercent: 47.49, shaderPercent: 100 }),
      [],
      {
        created: [],
        merged: [],
      },
    );

    expect(events[0]?.text).toContain("📉");
    expect(events[0]?.text).toContain("47.49% → 47.39%");
  });

  it("reports a star change but not an unchanged counter", () => {
    const events = deriveEvents(
      { ...reading, facts: { ...reading.facts, stars: 47_120 } },
      snapshot({ libraryPercent: 47.39, shaderPercent: 100, forks: 4_370 }),
      [],
      { created: [], merged: [] },
    );

    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("stars");
    expect(kinds).not.toContain("forks");
  });

  it("summarizes a burst of commits with three subjects and a count", () => {
    const commits = Array.from({ length: 5 }, (_, index) => ({
      sha: `sha${index}`,
      message: `feat: change ${index}`,
      author: null,
      committedAt: NOW,
      url: "",
    }));
    const events = deriveEvents(
      { ...reading, commits },
      snapshot({ libraryPercent: 47.39, shaderPercent: 100 }),
      commits.map((commit) => commit.sha),
      { created: [], merged: [] },
    );

    const text = events.find((event) => event.kind === "commits")?.text ?? "";
    expect(text.split("\n").filter((line) => line.startsWith("`"))).toHaveLength(3);
    expect(text).toContain("…and 2 more");
  });

  it("produces nothing when nothing moved", () => {
    const events = deriveEvents(
      reading,
      snapshot({ libraryPercent: 47.39, shaderPercent: 100, stars: 47_118, forks: 4_370 }),
      [],
      { created: [], merged: [] },
    );

    expect(events).toEqual([]);
  });
});

describe("report content", () => {
  it("marks an unavailable statistic instead of printing 0%", () => {
    const content = buildReportContent(
      {
        facts: {
          fullName: "boykopovar/AnyPS5",
          description: null,
          defaultBranch: "main",
          stars: 10,
          forks: 2,
          openIssues: 3,
          pushedAt: null,
        },
        progress: null,
        progressUnavailable: "progress.json answered HTTP 503",
        progressCommit: null,
        commits: [],
        pullRequests: [],
        fetchedAt: NOW,
      },
      null,
      [],
    );

    const value = content.metrics[0]?.value ?? "";
    expect(value).toContain("Unavailable");
    expect(value).not.toContain("0%");
  });

  it("shows the trend over the stored snapshots", () => {
    const content = buildReportContent(
      {
        facts: {
          fullName: "boykopovar/AnyPS5",
          description: null,
          defaultBranch: "main",
          stars: 10,
          forks: 2,
          openIssues: 3,
          pushedAt: null,
        },
        progress: {
          libraries: { done: 5_555, total: 11_697, percent: 47.49, groups: [] },
          shaders: { done: 1_166, total: 1_166, percent: 100, groups: [], extra: [] },
        },
        progressUnavailable: null,
        progressCommit: "abc1234def",
        commits: [],
        pullRequests: [],
        fetchedAt: NOW,
      },
      snapshot({ libraryPercent: 47.3 }),
      [],
      [snapshot({ libraryPercent: 47.3 }), snapshot({ libraryPercent: 47.49 })],
    );

    expect(content.footer).toContain("Statistics at abc1234");
    expect(content.footer).toContain("▲ 0.19 pp over 2 snapshots");
  });
});

describe("conditional requests", () => {
  /** A probe over a GitHub client whose list endpoints are scripted. */
  function probeWith(client: GitHubClient, progress: unknown[] = []): RepositoryProbe {
    return new RepositoryProbe({
      client,
      target: { owner: "boykopovar", repo: "AnyPS5", branch: "main" },
      fetchImpl: fakeFetchQueue(progress, 200),
    });
  }

  it("sends the stored ETags on the next reading, and an unchanged endpoint adds no events", async () => {
    const client = fakeClient({
      commits: [[commitPayload("aaa111", "feat(prx): implement sceAc3EncEncode")]],
    });
    const probe = probeWith(client);

    const first = await probe.read(EMPTY_CACHE);
    // The fake mints an ETag per endpoint, so both are cached independently.
    expect(first.cache).toEqual({ commitsEtag: "etag-commits", pullRequestsEtag: "etag-pulls" });
    expect(first.reading.commits.map((commit) => commit.sha)).toEqual(["aaa111"]);

    // Now the repository is unchanged, so both list endpoints answer 304. The probe
    // reports them as empty; what must not happen is an invented event.
    const unchangedClient = fakeClient({ notModified: true });
    const unchanged = probeWith(unchangedClient);
    const second = await unchanged.read(first.cache);
    const events = deriveEvents(
      second.reading,
      // Compared with a snapshot of the same reading: an unchanged endpoint must not
      // add an event.
      snapshot({ libraryPercent: 47.39, shaderPercent: 100, stars: 47_118, forks: 4_370 }),
      [],
      { created: [], merged: [] },
    );

    const conditional = unchangedClient.requests.filter((request) => request.etag !== undefined);
    expect(conditional.map((request) => request.etag)).toEqual([
      first.cache.commitsEtag,
      first.cache.pullRequestsEtag,
    ]);
    expect(conditional).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it("keeps the previous ETag when an endpoint answers 304", async () => {
    const probe = probeWith(fakeClient({ notModified: true }));
    const cache: RepositoryCache = {
      commitsEtag: "etag-old-commits",
      pullRequestsEtag: "etag-old-pulls",
    };

    const result = await probe.read(cache);

    expect(result.cache).toEqual(cache);
    // Unreachable list endpoints are still reported: the snapshot says which
    // sources it could not read, rather than pretending the repository is empty.
    expect(result.failures).toEqual(["commits", "pull-requests"]);
    expect(result.reading.commits).toEqual([]);
  });

  it("does not claim any other endpoint failed when only progress.json is down", async () => {
    const result = await new RepositoryProbe({
      client: fakeClient({}),
      target: { owner: "boykopovar", repo: "AnyPS5", branch: "main" },
      fetchImpl: () => Promise.resolve(new Response("gone", { status: 503 })),
    }).read();

    expect(result.failures).toEqual(["progress"]);
    expect(result.reading.progress).toBeNull();
    // An unreachable endpoint never invents an ETag to send back, and the ones that
    // did answer keep theirs.
    expect(result.cache).toEqual({ commitsEtag: "etag-commits", pullRequestsEtag: "etag-pulls" });
  });
});

/**
 * `/github refresh` used to answer "contact the team" for a deployment problem,
 * which is the one thing an operator cannot act on. These are the two causes a
 * deployment actually hits, plus the rule that anything else is still described.
 */
describe("explainRefreshFailure", () => {
  it("names the missing migration when the tables are absent", () => {
    const message = explainRefreshFailure(
      new Error("The table `public.repository_snapshots` does not exist in the current database."),
    );
    expect(message).toContain("prisma migrate deploy");
    expect(message).toContain("V9 tables");
  });

  it("names the schema/client mismatch", () => {
    const message = explainRefreshFailure(
      new Error("The column `monitored_repositories.id` does not exist in the current database."),
    );
    expect(message).toContain("migrate deploy");
    expect(message).toContain("build");
  });

  it("names an unreachable database", () => {
    expect(
      explainRefreshFailure(new Error("Can't reach database server at localhost:5432")),
    ).toContain("DATABASE_URL");
  });

  it("falls back to the error message, truncated to fit an embed", () => {
    const message = explainRefreshFailure(new Error(`something odd: ${"x".repeat(500)}`));
    expect(message).toHaveLength(300);
    expect(message.endsWith("...")).toBe(true);
  });

  it("accepts a non-Error throw without losing the text", () => {
    expect(explainRefreshFailure("boom")).toBe("boom");
  });
});

/**
 * `/github` never acknowledged its interaction: every subcommand answered with
 * `editReply`, which discord.js rejects with `InteractionNotReplied` unless the
 * interaction was deferred first. The user was told "The application did not
 * respond" and the log filled with stack traces. This stub enforces the same
 * rule discord.js does, so a missing acknowledgement fails here rather than in
 * production.
 */
describe("/github interaction acknowledgement", () => {
  const monitor = {
    fullName: "boykopovar/AnyPS5",
    history: () => Promise.resolve<SnapshotRecord[]>([]),
    refresh: () => Promise.reject(new Error("refresh requires server.settings")),
  } as unknown as RepositoryMonitorService;

  const context = { repositoryMonitor: monitor } as unknown as CommandExecutionContext;

  /** A chat-input interaction that refuses `editReply` until it is deferred. */
  function interactionFor(subcommand: string): ChatInputCommandInteraction {
    let deferred = false;
    return {
      options: {
        getSubcommand: () => subcommand,
        getInteger: () => null,
      },
      member: null,
      replied: false,
      get deferred() {
        return deferred;
      },
      deferReply: () => {
        deferred = true;
        return Promise.resolve();
      },
      editReply: () =>
        deferred
          ? Promise.resolve()
          : Promise.reject(new Error("DiscordjsError [InteractionNotReplied]")),
    } as unknown as ChatInputCommandInteraction;
  }

  it.each(["status", "history", "refresh"])(
    "acknowledges `/github %s` before replying",
    async (subcommand) => {
      await expect(
        githubCommand.execute(interactionFor(subcommand), context),
      ).resolves.toBeUndefined();
    },
  );
});

/**
 * The command's permission surface. `/github status` and `/github history` only read
 * stored snapshots, so any member may run them; `/github refresh` writes a snapshot and
 * can post to the report channel, so it asks for `server.settings` itself. Declaring
 * `core.use` at the command level — what the command used to do — quietly turned the two
 * read-only subcommands into staff-only commands, because `core.use` is only granted
 * through a role bound to a permission class.
 */
describe("/github permission surface", () => {
  /** A `GuildMember` that passes the handler's `instanceof` check but needs no client. */
  function member(id = "1533346203268419659"): GuildMember {
    const stub = { id } as unknown as GuildMember;
    // `id` afterwards would hit GuildMember's getter-only accessor instead.
    Object.setPrototypeOf(stub, GuildMember.prototype);
    return stub;
  }

  /** An interaction that records the payloads handed to `editReply`. */
  function interactionFor(
    subcommand: string,
    guildMember: GuildMember | null,
  ): { interaction: ChatInputCommandInteraction; replies: unknown[] } {
    const replies: unknown[] = [];
    const stub = {
      options: {
        getSubcommand: () => subcommand,
        getInteger: () => null,
      },
      member: guildMember,
      replied: false,
      deferred: false,
      deferReply: () => {
        stub.deferred = true;
        return Promise.resolve();
      },
      editReply: (payload: unknown) => {
        replies.push(payload);
        return Promise.resolve();
      },
    };
    return { interaction: stub as unknown as ChatInputCommandInteraction, replies };
  }

  it("declares no command-level permission, so status and history stay open to members", () => {
    expect(githubCommand.permissions).toEqual({});
  });

  it("refuses `refresh` without `server.settings` and leaves the monitor untouched", async () => {
    const refresh = vi.fn();
    const context = {
      repositoryMonitor: {
        fullName: "boykopovar/AnyPS5",
        history: () => Promise.resolve<SnapshotRecord[]>([]),
        refresh,
      },
      authorization: { can: () => Promise.resolve(false) },
    } as unknown as CommandExecutionContext;

    const { interaction, replies } = interactionFor("refresh", member());

    await githubCommand.execute(interaction, context);

    expect(refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(replies)).toContain("server.settings");
  });

  it("takes the snapshot when the member holds `server.settings`", async () => {
    const refresh = vi.fn(() =>
      Promise.resolve({
        baseline: false,
        announced: 2,
        librariesPercent: 57,
        shaderPercent: 63,
        failures: [],
      }),
    );
    const can = vi.fn(() => Promise.resolve(true));
    const context = {
      repositoryMonitor: {
        fullName: "boykopovar/AnyPS5",
        history: () => Promise.resolve<SnapshotRecord[]>([]),
        refresh,
      },
      authorization: { can },
    } as unknown as CommandExecutionContext;

    const author = member();
    const { interaction, replies } = interactionFor("refresh", author);

    await githubCommand.execute(interaction, context);

    expect(can).toHaveBeenCalledWith(author, { custom: ["server.settings"] }, "github.refresh");
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(replies)).toContain("refreshed");
  });
});

/**
 * `/github history` prints at most 25 snapshots. The monitor records one an hour, so 25
 * is a day of history plus one; the cap exists because an embed that grows with the
 * archive eventually becomes a message Discord refuses. Both layers are asserted: the
 * range Discord offers the caller, and the window the handler is willing to read.
 */
describe("/github history window", () => {
  /** A stored snapshot, minimal but shaped like the record the monitor writes. */
  function snapshot(index: number): SnapshotRecord {
    return {
      id: `snapshot-${index}`,
      capturedAt: new Date(NOW.getTime() - index * 3_600_000),
      state: {
        stars: 1_000,
        forks: 100,
        openIssues: 10,
        libraryPercent: 57,
        librariesDone: 6_000,
        librariesTotal: 11_697,
        shaderPercent: 63,
        shadersDone: 300,
        shadersTotal: 476,
      },
      progressCommit: null,
      commitCount: 0,
      pullCount: 0,
      failures: [],
    };
  }

  /** The description of the first embed in a recorded `editReply` payload. */
  function descriptionOf(payload: unknown): string {
    const embed = (payload as { embeds?: { data?: { description?: string } }[] }).embeds?.[0];
    return embed?.data?.description ?? "";
  }

  /** An interaction running `/github history` with `limit` already parsed. */
  function interactionFor(limit: number | null): {
    interaction: ChatInputCommandInteraction;
    replies: unknown[];
  } {
    const replies: unknown[] = [];
    const stub = {
      options: {
        getSubcommand: () => "history",
        getInteger: () => limit,
      },
      member: null,
      replied: false,
      deferred: false,
      deferReply: () => {
        stub.deferred = true;
        return Promise.resolve();
      },
      editReply: (payload: unknown) => {
        replies.push(payload);
        return Promise.resolve();
      },
    };
    return { interaction: stub as unknown as ChatInputCommandInteraction, replies };
  }

  /** A context whose monitor always returns `count` snapshots, oldest first. */
  function contextWith(count: number): {
    context: CommandExecutionContext;
    history: ReturnType<typeof vi.fn>;
  } {
    const history = vi.fn(() =>
      Promise.resolve(Array.from({ length: count }, (_, index) => snapshot(index))),
    );
    const context = {
      repositoryMonitor: { fullName: "boykopovar/AnyPS5", history },
    } as unknown as CommandExecutionContext;
    return { context, history };
  }

  it("offers 25 as the highest limit Discord will accept", () => {
    const json = githubCommand.data.toJSON() as unknown as {
      options?: {
        name: string;
        options?: { name: string; description?: string; max_value?: number }[];
      }[];
    };
    const subcommand = json.options?.find((option) => option.name === "history");
    const limit = subcommand?.options?.find((option) => option.name === "limit");

    expect(limit?.max_value).toBe(25);
    expect(limit?.description).toContain("1-25");
  });

  it("prints 12 rows by default and never reads more than 25 snapshots", async () => {
    const { context, history } = contextWith(40);
    const { interaction, replies } = interactionFor(null);

    await githubCommand.execute(interaction, context);

    expect(history).toHaveBeenCalledWith(25);
    expect(descriptionOf(replies.at(-1)).split("\n")).toHaveLength(12);
  });

  it("prints at most 25 rows when a caller asks for more", async () => {
    const { context, history } = contextWith(40);
    const { interaction, replies } = interactionFor(500);

    await githubCommand.execute(interaction, context);

    expect(history).toHaveBeenCalledWith(25);
    expect(descriptionOf(replies.at(-1)).split("\n")).toHaveLength(25);
  });
});
