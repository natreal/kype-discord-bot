/**
 * The terminal the monitor draws into: an alternate screen, absolute addressing, and
 * three keys.
 *
 * `frame.ts` decides what the window *says*; this decides where it says it. The split
 * is what keeps the renderer testable — nothing here is needed to produce a frame, and
 * nothing there is needed to put one on the screen.
 *
 * Two details are Windows-specific rather than general taste:
 *
 * - **Absolute addressing.** Every line is written at its own row instead of being
 *   followed by a newline. On the last row of the alternate screen a newline scrolls,
 *   and a scrolled frame is off by one forever.
 * - **Autowrap off.** A frame is padded to the full width, last row included, so with
 *   wrapping on the final character can push the window up a line. Off, it cannot.
 *
 * The class takes plain structural streams rather than `process.stdout`: a test can
 * hand it two arrays and assert the exact sequence of writes, which is the only way to
 * check "the cursor was hidden before the screen was cleared" without a real terminal.
 */
import type { FrameSize } from "./frame.js";
import { cursorAt, TERMINAL } from "./theme.js";

/** The keys the window reacts to; everything else is passed over. */
export type MonitorKey = "quit" | "pause" | "refresh";

/** The part of a writable stream the window uses. */
export interface TerminalOutput {
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(chunk: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

/** The part of a readable stream the window uses. */
export interface TerminalInput {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(encoding: "utf8"): unknown;
  on?(event: "data", listener: (chunk: string) => void): unknown;
  off?(event: "data", listener: (chunk: string) => void): unknown;
}

/** What the terminal needs to know about the world it is in. */
export interface TerminalOptions {
  /** Defaults to `process.stdout`. */
  readonly output?: TerminalOutput;
  /** Defaults to `process.stdin`. */
  readonly input?: TerminalInput;
  /**
   * Whether escape sequences are allowed. Defaults to "both streams are a TTY", which
   * is exactly the condition under which a full-screen window is meaningful.
   */
  readonly interactive?: boolean;
}

/** What a terminal that never reported a size is assumed to be. */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

export class Terminal {
  private readonly output: TerminalOutput;
  private readonly input: TerminalInput;
  private readonly escape: boolean;
  private opened = false;

  public constructor(options: TerminalOptions = {}) {
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
    this.escape =
      options.interactive ?? (this.output.isTTY === true && this.input.isTTY === true);
  }

  /** Whether this terminal can host the window, or merely print a frame. */
  public get interactive(): boolean {
    return this.escape;
  }

  /** @returns the window in cells, falling back to a classic terminal size. */
  public get size(): FrameSize {
    return {
      columns: Math.max(1, this.output.columns ?? FALLBACK_COLUMNS),
      rows: Math.max(1, this.output.rows ?? FALLBACK_ROWS),
    };
  }

  /**
   * Takes the screen: alternate screen, no wrapping, no cursor, black background.
   *
   * The alternate screen is the whole reason the monitor is a window rather than a
   * scrolling log: on exit the user's shell and scrollback are exactly as they were,
   * even if the window was killed halfway through a frame.
   */
  public open(): void {
    if (!this.escape || this.opened) {
      return;
    }
    this.opened = true;
    this.write(
      [
        TERMINAL.alternateScreen,
        TERMINAL.wrapOff,
        TERMINAL.hideCursor,
        TERMINAL.clear,
        TERMINAL.background,
      ].join(""),
    );
    this.input.setEncoding?.("utf8");
    this.input.setRawMode?.(true);
    this.input.resume?.();
  }

  /** @returns the screen and the shell exactly as they were. */
  public close(): void {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    this.write(
      [TERMINAL.reset, TERMINAL.wrapOn, TERMINAL.showCursor, TERMINAL.normalScreen].join(""),
    );
    this.input.setRawMode?.(false);
    this.input.pause?.();
  }

  /**
   * Puts one frame on the screen.
   *
   * When the window does not own a screen — `--once`, a pipe, a non-TTY — the same
   * lines are written plainly with newlines, so redirecting the monitor to a file
   * produces the frame instead of a file full of escape codes.
   */
  public paint(lines: readonly string[]): void {
    if (!this.opened) {
      this.write(`${lines.join("\n")}\n`);
      return;
    }
    const parts: string[] = [TERMINAL.hideCursor];
    lines.forEach((line, index) => {
      parts.push(cursorAt(index + 1, 1), TERMINAL.background, line, TERMINAL.eraseLine);
    });
    this.write(parts.join(""));
  }

  /** @returns a function that stops listening. */
  public onKey(handler: (key: MonitorKey) => void): () => void {
    if (this.input.on === undefined) {
      return () => {};
    }
    const listener = (chunk: string): void => {
      for (const key of keysOf(chunk)) {
        handler(key);
      }
    };
    this.input.on("data", listener);
    return () => this.input.off?.("data", listener);
  }

  /** @returns a function that stops listening. */
  public onResize(handler: (size: FrameSize) => void): () => void {
    if (this.output.on === undefined) {
      return () => {};
    }
    const listener = (): void => handler(this.size);
    this.output.on("resize", listener);
    return () => this.output.off?.("resize", listener);
  }

  private write(chunk: string): void {
    this.output.write(chunk);
  }
}

/**
 * @returns the keys one chunk of input stands for.
 *
 * Escape is the awkward one: a lone `\u001B` is the key, but `\u001B[A` is the up
 * arrow, and quitting on an arrow press would make the window feel broken. So a bare
 * escape quits and a sequence is ignored, which is also what makes F11 safe — the
 * terminal handles that one itself.
 */
function keysOf(chunk: string): readonly MonitorKey[] {
  if (chunk === "\u001B") {
    return ["quit"];
  }
  const keys: MonitorKey[] = [];
  for (const char of chunk) {
    if (char === "\u001B") {
      break;
    }
    if (char === "q" || char === "Q" || char === "\u0003") {
      keys.push("quit");
    } else if (char === " ") {
      keys.push("pause");
    } else if (char === "r" || char === "R") {
      keys.push("refresh");
    }
  }
  return keys;
}
