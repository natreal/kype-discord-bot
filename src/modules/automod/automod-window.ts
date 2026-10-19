/**
 * Automod sliding windows.
 *
 * One small class, `SlidingWindow`, backs every rate-based rule. It stores
 * `(timestamp, channelId, content)` per author and answers the questions the rules
 * actually ask: how many, across how many channels, and how many identical in a
 * row. Keeping it separate from the evaluator has two payoffs:
 *
 * - the evaluator stays pure, so `observe()` is a unit test;
 * - the window is the *only* mutable state in automod, so memory growth is one
 *   bounded list per author rather than a growing map nobody prunes.
 *
 * Bounding is explicit: `record()` prunes anything older than the window, and the
 * service caps the number of tracked authors, so a raid cannot turn automod into a
 * memory leak.
 */
import type { AutomodObservation } from "./automod.types.js";

/** One recorded event. */
interface WindowEntry {
  readonly at: number;
  readonly channelId: string;
  /** Normalized content, used by `anti-repeated-messages`. */
  readonly content: string;
}

/** What the window reports back to a rule. */
export interface WindowSnapshot {
  /** Events inside the window, oldest first. */
  readonly count: number;
  /** Distinct channels touched inside the window. */
  readonly channels: number;
  /** Longest run of identical trailing content inside the window. */
  readonly identicalRun: number;
}

export class SlidingWindow {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, WindowEntry[]>();

  public constructor(options: { readonly windowMs: number; readonly maxEntries?: number }) {
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? 100;
  }

  /** Records one event and @returns the window as it looks right after. */
  public record(observation: AutomodObservation): WindowSnapshot {
    const key = observation.authorId;
    const at = observation.timestampMs;
    const content =
      observation.kind === "message"
        ? normalizeContent(observation.content)
        : `reaction:${observation.emoji}`;

    const kept = (this.entries.get(key) ?? []).filter((entry) => at - entry.at < this.windowMs);
    kept.push({ at, channelId: observation.channelId, content });
    // A flood of messages must not grow one author's list without bound: the
    // newest entries are the only ones a rule can still act on.
    while (kept.length > this.maxEntries) {
      kept.shift();
    }
    this.entries.set(key, kept);

    return this.snapshot(kept);
  }

  /** @returns the current window of an author without recording anything. */
  public peek(authorId: string, nowMs: number): WindowSnapshot {
    const kept = (this.entries.get(authorId) ?? []).filter(
      (entry) => nowMs - entry.at < this.windowMs,
    );
    return this.snapshot(kept);
  }

  /** Forgets one author, so a punished member starts from a clean slate. */
  public reset(authorId: string): void {
    this.entries.delete(authorId);
  }

  /** @returns how many authors are tracked, for the memory cap in the service. */
  public get size(): number {
    return this.entries.size;
  }

  /** Forgets the least recently active author, when the cap is reached. */
  public evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entries] of this.entries) {
      const last = entries[entries.length - 1]?.at ?? 0;
      if (last < oldestAt) {
        oldestAt = last;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.entries.delete(oldestKey);
    }
  }

  private snapshot(entries: readonly WindowEntry[]): WindowSnapshot {
    const channels = new Set(entries.map((entry) => entry.channelId));
    let identicalRun = 0;
    const last = entries[entries.length - 1];
    if (last !== undefined) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.content !== last.content) {
          break;
        }
        identicalRun += 1;
      }
    }
    return { count: entries.length, channels: channels.size, identicalRun };
  }
}

/** Normalizes content so `hello` and `Héllo!` are recognised as the same spam. */
export function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}
