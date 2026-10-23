/**
 * What the bot reads from AnyPS5, and what it does with it.
 *
 * Every field here has a documented source. The point of the module is a
 * *historical* record of the project: the implementation statistics the project
 * publishes, the commits and pull requests that moved them, and a timestamped
 * snapshot of both so a trend can be drawn and a change announced.
 */
import type { AnyPs5Progress } from "./progress.js";

/** One commit, normalized from the GitHub payload. */
export interface RepositoryCommit {
  readonly sha: string;
  /** First line of the message. */
  readonly message: string;
  readonly author: string | null;
  /** When GitHub says the commit happened (not when it was pushed). */
  readonly committedAt: Date;
  readonly url: string;
}

/** One pull request, normalized from the GitHub payload. */
export interface RepositoryPullRequest {
  readonly number: number;
  readonly title: string;
  readonly author: string | null;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  /** `true` when `merged_at` is set: merged, as opposed to closed unmerged. */
  readonly merged: boolean;
  readonly createdAt: Date;
  readonly mergedAt: Date | null;
  readonly url: string;
}

/** Repository-level counters that only the repository endpoint reports. */
export interface RepositoryFacts {
  readonly fullName: string;
  /** The project's own one-line summary, shown at the top of a report. */
  readonly description: string | null;
  readonly defaultBranch: string;
  readonly stars: number;
  readonly forks: number;
  /** GitHub's count, which includes pull requests (a GitHub quirk, not a bug here). */
  readonly openIssues: number;
  readonly pushedAt: Date | null;
}

/** Everything one successful fresh refresh produced, before it is stored. */
export interface RepositoryReading {
  readonly facts: RepositoryFacts;
  /** `null` when the repository publishes no readable snapshot. */
  readonly progress: AnyPs5Progress | null;
  /** Why `progress` is `null`, when it is. Safe to display. */
  readonly progressUnavailable: string | null;
  /** The commit the published snapshot was taken at, when identifiable. */
  readonly progressCommit: string | null;
  /** Commits of the measured branch, newest first. */
  readonly commits: readonly RepositoryCommit[];
  /** Pull requests, newest first. */
  readonly pullRequests: readonly RepositoryPullRequest[];
  /** When the reading was taken. */
  readonly fetchedAt: Date;
}

/** The subset of a reading that is compared against the previous snapshot. */
export interface ReportedState {
  readonly stars: number;
  readonly forks: number;
  readonly openIssues: number;
  readonly libraryPercent: number | null;
  readonly librariesDone: number | null;
  readonly librariesTotal: number | null;
  readonly shaderPercent: number | null;
  readonly shadersDone: number | null;
  readonly shadersTotal: number | null;
}

/** A change worth announcing, already rendered as one line of text. */
export interface ProgressEvent {
  /** Stable key, used to deduplicate an announcement across overlapping runs. */
  readonly key: string;
  /** Short category, e.g. `commit`, `pull-request`, `libraries`. */
  readonly kind: string;
  /** One-line summary, ready for a Discord embed field value. */
  readonly text: string;
}

/** @returns the comparable state of one reading. */
export function toReportedState(reading: RepositoryReading): ReportedState {
  const { progress } = reading;
  return {
    stars: reading.facts.stars,
    forks: reading.facts.forks,
    openIssues: reading.facts.openIssues,
    libraryPercent: progress?.libraries.percent ?? null,
    librariesDone: progress?.libraries.done ?? null,
    librariesTotal: progress?.libraries.total ?? null,
    shaderPercent: progress?.shaders.percent ?? null,
    shadersDone: progress?.shaders.done ?? null,
    shadersTotal: progress?.shaders.total ?? null,
  };
}
