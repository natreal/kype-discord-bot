/**
 * The monitor's black-terminal palette, and the text primitives it draws with.
 *
 * A terminal is not an embed: there is no field to overflow, no component budget
 * and no client that reflows the content — there is a grid, and every frame has to
 * land in it exactly. So the primitives here all work in *visible* cells: colour is
 * written as SGR sequences that occupy zero cells, and {@link fit} pads or cuts a
 * line to the width the window actually has. A frame that respects that contract can
 * never wrap, and a frame that wraps is the one failure mode a monitor cannot have,
 * because one wrapped line shifts every line under it and the layout never recovers.
 *
 * The palette is deliberately dark: the window is black, the text is dim grey, and
 * colour is spent only on the numbers that moved. A monitor is glanced at, so warmth
 * belongs to movement, not to chrome.
 */
import { FULL_BAR } from "../modules/repository/repository-chart.js";

/** The empty half of a gauge, one cell per missing block. */
const EMPTY_BAR = "░";

/**
 * Control sequences the runner writes by hand.
 *
 * `alternateScreen` is what makes the monitor a *window* rather than a scrolling
 * log: the program paints on a second screen the terminal owns, and on exit the
 * user's shell and scrollback are exactly as they were.
 */
export const TERMINAL = {
  alternateScreen: "\u001B[?1049h",
  normalScreen: "\u001B[?1049l",
  hideCursor: "\u001B[?25l",
  showCursor: "\u001B[?25h",
  clear: "\u001B[2J",
  home: "\u001B[H",
  reset: "\u001B[0m",
  /** The window's black, re-applied wherever a reset would hand the cells back. */
  background: "\u001B[48;2;0;0;0m",
  /**
   * Autowrap off while the window owns the screen.
   *
   * Every line is padded to the full width, and the last row is the full width too:
   * with wrapping on, writing that row can scroll the whole frame up by one line and
   * the layout never recovers. Off, a full row is simply a full row.
   */
  wrapOff: "\u001B[?7l",
  wrapOn: "\u001B[?7h",
  /** Erases from the cursor to the end of the line, painting with the background. */
  eraseLine: "\u001B[K",
} as const;

/** Everything the frame can colour. `background` is the black the window is filled with. */
export type PaintRole =
  | "background"
  | "text"
  | "dim"
  | "faint"
  | "accent"
  | "good"
  | "warn"
  | "bad"
  | "heading"
  | "inverse";

/**
 * Truecolor SGR per role.
 *
 * Truecolor rather than the sixteen-colour palette: the sixteen are whatever the
 * user's scheme decides they are, and a "black window" built out of them is black
 * only on some machines. These are literal values, so the monitor looks the same in
 * Windows Terminal, conhost and anything else that speaks 24-bit colour.
 */
const CODES: Readonly<Record<PaintRole, string>> = {
  background: "\u001B[48;2;0;0;0m",
  text: "\u001B[38;2;226;232;240m",
  dim: "\u001B[38;2;126;136;148m",
  faint: "\u001B[38;2;74;82;92m",
  accent: "\u001B[38;2;97;175;239m",
  good: "\u001B[38;2;126;211;148m",
  warn: "\u001B[38;2;229;192;123m",
  bad: "\u001B[38;2;224;108;117m",
  heading: "\u001B[1;38;2;97;175;239m",
  inverse: "\u001B[48;2;97;175;239m\u001B[38;2;0;0;0m",
};

/** Colours `text`, or returns it untouched when colour is off. */
export type Painter = (text: string, role: PaintRole) => string;

/**
 * @returns a painter for one frame.
 *
 * `enabled: false` gives the identity function, which is not just a debug switch:
 * `--once` writes a plain frame that survives being redirected to a file, pasted
 * into a log, or read by a test that only cares about the characters.
 *
 * Every run ends by re-applying {@link TERMINAL.background} after the reset. Without
 * it a reset would hand the cells back to the terminal's *default* background — white
 * on a light scheme — and the frame would be black only where text happened to be.
 */
export function painter(enabled: boolean): Painter {
  if (!enabled) {
    return (text) => text;
  }
  return (text, role) => `${CODES[role]}${text}${TERMINAL.reset}${TERMINAL.background}`;
}

/**
 * @returns the sequence that puts the cursor at `row`/`column`, both one-based.
 *
 * Absolute addressing rather than newlines: the frame is repainted in place, and a
 * newline on the last row would scroll the window instead of overwriting it.
 */
export function cursorAt(row: number, column = 1): string {
  return `\u001B[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(column))}H`;
}

/**
 * Matches the SGR sequences {@link painter} writes, for measuring and stripping.
 *
 * The control-character rule is off for these two expressions and nowhere else: an SGR
 * sequence *is* `ESC [` by definition, so the escape is the thing being matched rather
 * than something that slipped in.
 */
/* eslint-disable no-control-regex */
const SGR = /\u001B\[[0-9;]*m/g;
/** The same sequence, anchored: used to step over escapes while walking a string. */
const SGR_AT_START = /^\u001B\[[0-9;]*m/;
/* eslint-enable no-control-regex */

/** @returns how many cells `text` occupies, colour sequences excluded. */
export function visibleWidth(text: string): number {
  return text.replace(SGR, "").length;
}

/**
 * @returns the first `width` visible cells of `text`, keeping the colour sequences
 * around them.
 *
 * Cutting a styled string with `slice` would eventually cut through an escape and
 * leak an unterminated colour into the rest of the frame; this walks the string,
 * copies escapes whole, counts only real characters, and re-terminates the style if
 * the cut left one open.
 */
export function sliceVisible(text: string, width: number): string {
  let out = "";
  let cells = 0;
  let styled = false;
  let index = 0;

  while (index < text.length) {
    const code = SGR_AT_START.exec(text.slice(index));
    if (code !== null) {
      out += code[0];
      styled = code[0] !== TERMINAL.reset;
      index += code[0].length;
      continue;
    }
    if (cells >= width) {
      break;
    }
    out += text[index] ?? "";
    cells += 1;
    index += 1;
  }

  return styled ? `${out}${TERMINAL.reset}` : out;
}

/**
 * @returns `text` in exactly `width` cells: cut when too long, spaces when short.
 *
 * Being exact matters twice. The frame is painted by absolute cursor position, so a
 * short line leaves whatever the previous frame drew still visible; and a long line
 * wraps, which moves every line under it.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const cut = visibleWidth(text) > width ? sliceVisible(text, width) : text;
  const padding = width - visibleWidth(cut);
  return padding > 0 ? `${cut}${" ".repeat(padding)}` : cut;
}

/**
 * @returns a gauge of `width` cells filled to `fraction`.
 *
 * Two painted runs rather than one: the filled and empty halves have to be different
 * colours, and painting the finished string would erase that boundary.
 */
export function blockBar(fraction: number, width: number, paint: Painter): string {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.max(0, Math.min(width, Math.round(safe * width)));
  const empty = Math.max(0, width - filled);
  return `${paint(FULL_BAR.repeat(filled), "good")}${paint(EMPTY_BAR.repeat(empty), "faint")}`;
}

/** @returns a full-width rule, the one piece of chrome the frame keeps. */
export function rule(width: number, paint: Painter): string {
  return paint("─".repeat(Math.max(0, width)), "faint");
}

/**
 * @returns `left` and `right` on one line, `right` flush with the last column.
 *
 * `left` is cut first: the right-hand value is a clock or a countdown, and losing the
 * seconds of "next poll in 00:07" is losing the only part that changes.
 */
export function spread(left: string, right: string, width: number, paint: Painter): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) {
    return fit(right, width);
  }
  const trimmed = sliceVisible(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - visibleWidth(trimmed) - rightWidth);
  return `${trimmed}${paint(" ".repeat(gap), "text")}${right}`;
}
