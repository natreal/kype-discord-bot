/**
 * Text charts drawn as block characters.
 *
 * Discord embeds have no plotting API, so a trend is drawn the way a terminal
 * draws one: each reading becomes a column of eighth-height blocks inside a fixed
 * grid of code blocks. The result is a real chart — an axis, a scale and a
 * legend — and it survives being copied out of Discord, which an image would not.
 *
 * Everything here is pure and monospaced. Monospace matters twice over: Discord
 * renders a fenced block in a monospaced font, and every glyph below is exactly
 * one character wide, so a column never drifts out of alignment. The glyphs also
 * carry their meaning when they are read as text: `▁` to `█` are low to high.
 */

/** The eighth-height blocks, gap first: `PARTIALS[0]` is "nothing". */
const PARTIALS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** A full-height bar, used for progress gauges. */
export const FULL_BAR = "█";
/** A gap in a series: no reading was taken. */
const GAP = "·";
/** Vertical steps in one text row: a full block is eight eighths. */
export const BLOCKS_PER_ROW = 8;

/** A drawn chart, plus the scale it was drawn at. */
export interface RenderedChart {
  /** Number of columns drawn (one per reading). */
  readonly points: number;
  /** Lowest and highest values drawn, or `null` when there was no reading. */
  readonly range: { readonly min: number; readonly max: number } | null;
  /** Column heights in vertical steps. */
  readonly blocks: readonly number[];
}

/** Options shared by every renderer. */
export interface ChartOptions {
  /** Steps a column may span; defaults to `rows * BLOCKS_PER_ROW`. */
  readonly rows: number;
  /** `false` spans the data, so a slow climb stays visible. */
  readonly zeroBased?: boolean;
  /** Bottom of a zero-based scale; defaults to 0. */
  readonly floor?: number;
}

/** The drawing styles `/github graph` offers. */
export type ChartStyle = "bars" | "line";

/** A chart ready to embed: fenced code, and at most `MAX_FIELD` characters. */
export interface ChartText {
  readonly text: string;
  readonly chart: RenderedChart;
}

/**
 * Scales a series onto a grid of block heights.
 *
 * The scale starts at zero unless `zeroBased` is false, in which case it spans the
 * data so a slow climb is still visible. Starting at zero is the honest default:
 * "0% to 1%" and "96% to 97%" look alike on a chart drawn from its minimum, and
 * only one of them is the same amount of work.
 */
export function scaleSeries(values: readonly number[], options: ChartOptions): RenderedChart {
  const maxBlocks = options.rows * BLOCKS_PER_ROW;
  const real = values.filter((value) => Number.isFinite(value));
  if (real.length === 0) {
    return { points: 0, range: null, blocks: [] };
  }

  const min = Math.min(...real);
  const max = Math.max(...real);
  const floor = options.zeroBased === false ? min : (options.floor ?? 0);
  // A flat series still needs a span, or every column would be zero-height.
  const span = Math.max(max - floor, 1e-9);

  const blocks = values.map((value) => {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const scaled = ((value - floor) / span) * maxBlocks;
    // Rounding down, not to nearest: a reading below the maximum must never be drawn
    // at full height, or 96% and 97% become the same bar and the chart overstates work
    // that has not been done. A reading that rounds to nothing still gets one step, so
    // the chart shows "there was a reading" instead of a gap it did not have.
    return Math.max(1, Math.min(maxBlocks, Math.floor(scaled)));
  });

  return { points: real.length, range: { min, max }, blocks };
}

/**
 * Draws block heights as rows of text.
 *
 * @param blocks column heights, one entry per column (0 is an empty column).
 * @param rows number of text rows.
 * @param gap indices drawn as `·` even when a height was supplied.
 */
export function drawColumns(
  blocks: readonly number[],
  rows: number,
  gap: (index: number) => boolean = () => false,
): readonly string[] {
  const lines: string[] = [];
  for (let row = rows - 1; row >= 0; row -= 1) {
    let line = "";
    for (let index = 0; index < blocks.length; index += 1) {
      const height = blocks[index] ?? 0;
      if (gap(index)) {
        line += GAP;
        continue;
      }
      const inRow = Math.min(BLOCKS_PER_ROW, Math.max(0, height - row * BLOCKS_PER_ROW));
      line += PARTIALS[inRow] ?? " ";
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draws a sparkline: one row, one glyph per reading, gaps kept as gaps.
 *
 * Every glyph is a bar, so the line reads horizontally as magnitudes and
 * vertically as a trend, in a single line of text that fits above a screenshot.
 */
export function renderSparkline(
  values: readonly number[],
  options: Omit<ChartOptions, "rows">,
): string {
  const real = values.filter((value) => Number.isFinite(value));
  if (real.length === 0) {
    return "";
  }
  const min = Math.min(...real);
  const max = Math.max(...real);
  const floor = options.zeroBased === false ? min : (options.floor ?? 0);
  const span = Math.max(max - floor, 1e-9);

  return values
    .map((value) => {
      if (!Number.isFinite(value)) {
        return GAP;
      }
      const step = Math.round(((value - floor) / span) * (PARTIALS.length - 1));
      return PARTIALS[Math.max(1, Math.min(PARTIALS.length - 1, step))] ?? FULL_BAR;
    })
    .join("");
}

/**
 * @returns the chart as a fenced block, in the style the reader asked for.
 *
 * `bars` adds a labelled gutter (`┫` at the top, middle and bottom of the scale);
 * `line` keeps the bare columns, because the legend beneath already carries the
 * numbers. Both are one drawing with one decoration, not two charts with two chances
 * to disagree — the drawing, and therefore the number of readings, is identical.
 */
export function fenceChart(
  style: ChartStyle,
  rows: readonly string[],
  scale: readonly [string, string, string] | null,
): string {
  if (style === "bars" && scale !== null) {
    return ["```", ...axisRows(scale, rows), "```"].join("\n");
  }
  return ["```", ...rows, "```"].join("\n");
}

/**
 * @returns the gutter rows of a bar chart: each label right-aligned beside a `┫`
 * spine, then the bottom axis on the last label's row.
 *
 * The gutter is *prepended* to the columns rather than carved out of them. Carving
 * would be wrong twice over: the columns are the data, and shrinking them by exactly
 * the gutter would make a `bars` chart draw five fewer readings than the same chart
 * in `line`; and a one-reading chart would lose almost all of its grid.
 *
 * The cost is a row `gutter` characters wider than the bare columns, so the graph is
 * sized from {@link MAX_ROW} minus that gutter. A fenced block scrolls rather than
 * wraps, so a row over the budget runs off the edge of a phone.
 */
function axisRows(scale: readonly [string, string, string], rows: readonly string[]): string[] {
  const [bottom = "", middle = "", top = ""] = scale;
  const width = Math.max(...rows.map((row) => row.length), 1);
  const gutter = gutterFor(scale);
  const spine = (text: string): string => text.padStart(gutter - 1, " ") + "┫";
  const tail = " ".repeat(width);
  return [spine(top) + tail, spine(middle) + tail, spine(bottom) + "_".repeat(width)];
}

/**
 * Characters a chart row may occupy before a phone scrolls it sideways.
 *
 * One number, used by the command and by {@link gutterFor}: the width the command
 * passes and the gutter a `bars` chart adds are chosen so the widest row either style
 * can produce stays inside it.
 */
export const MAX_ROW = 24;

/** @returns the gutter width a `bars` chart sized for these labels will add. */
export function gutterFor(scale: readonly [string, string, string] | null): number {
  if (scale === null) {
    return 1;
  }
  const [bottom = "", middle = "", top = ""] = scale;
  return Math.max(top.length, bottom.length, middle.length) + 1;
}

/**
 * The widest gutter a percentage chart can draw: `100.00%` — five characters of number
 * plus `%` — then the spine, then the single space that separates it from the first
 * column. Sizing a `bars` chart from the labels it happens to draw would make the same
 * command produce a narrower chart on a project at 34% than at 100%, so the budget uses
 * the worst case instead.
 */
export const BAR_GUTTER = "100.00%┫".length + 1;

/** @returns a progress gauge, `fraction` of `width` blocks. */
export function gauge(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${FULL_BAR.repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

/** @returns a number as text, with `decimals` places when any were asked for. */
export function formatValue(value: number, decimals = 0): string {
  return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
}
