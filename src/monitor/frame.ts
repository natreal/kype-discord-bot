/**
 * The frame: a black full-screen terminal layout, built from a {@link MonitorModel}.
 *
 * Renderer only — no timers, no streams, no GitHub. It takes the model and the size
 * of the window and returns lines, which is what makes the layout testable: the
 * invariants that matter (exactly `rows` lines, each exactly `columns` cells, no
 * line ever wrapping) are asserted directly instead of being eyeballed in a terminal.
 *
 * The layout is budgeted rather than fixed. A terminal is whatever size the user
 * dragged it to, so every panel declares how many rows it needs to be worth drawing
 * and how many it can use, and {@link allocate} walks them in priority order. Shrink
 * the window and the least important panels leave first — the progress bars and the
 * live counters are still there at twelve rows, and a terminal that is too small for
 * those still gets a well-formed frame rather than a wrapped mess.
 */
import { formatSpan, relativeTime, untilTime } from "../modules/repository/github-view.js";
import { formatCount } from "../modules/repository/repository.events.js";
import { formatValue, renderSparkline } from "../modules/repository/repository-chart.js";
import type { GitHubLiveFacts } from "../services/github/live-feed.js";
import type {
  GroupReading,
  HourBucket,
  MonitorEvent,
  MonitorLevel,
  MonitorModel,
  MonitorPace,
  SectionReading,
} from "./model.js";
import {
  blockBar,
  fit,
  painter,
  rule,
  spread,
  visibleWidth,
  type Painter,
  type PaintRole,
} from "./theme.js";

/** Narrower than this and the numeric columns stop being readable; wider is a lie. */
const MIN_COLUMNS = 20;
/** Header and footer alone need five rows, so a frame is never drawn shorter. */
const MIN_ROWS = 6;
/** Columns a sparkline keeps for itself, however much its note wants: four is not a chart. */
const MIN_CHART = 12;
/** Characters of a commit hash worth showing: enough to find it, short enough to read. */
const SHORT_SHA = 7;

/** The window the frame is drawn into, in cells. */
export interface FrameSize {
  readonly columns: number;
  readonly rows: number;
}

/** How a frame is drawn. */
export interface FrameOptions {
  /** `false` returns plain text: for `--once`, redirected output and tests. */
  readonly color?: boolean;
}

/**
 * @returns one frame, as exactly `size.rows` lines of exactly `size.columns` cells.
 *
 * The caller paints these lines by absolute cursor position, so the shape of the
 * array is the contract: short lines would leave the previous frame showing through,
 * and long ones would wrap and shift every line under them.
 */
export function renderFrame(
  model: MonitorModel,
  size: FrameSize,
  options: FrameOptions = {},
): readonly string[] {
  const paint = painter(options.color !== false);
  const columns = Math.max(MIN_COLUMNS, Math.floor(size.columns));
  const rows = Math.max(MIN_ROWS, Math.floor(size.rows));
  const layout: Layout = { width: columns, paint };

  const header = headerLines(model, layout);
  const footer = footerLines(model, layout);
  const sections = panelSections(model, layout);
  const budget = Math.max(0, rows - header.length - footer.length);
  const body = allocate(sections, budget);
  // Panels hand back fewer lines than they were given when they have nothing to say (an
  // empty log, a chart with no reading yet). Those rows are padded inside the body, not
  // after the footer: the keys stay on the last row of the window, where the hand looks.
  const filled = [...body];
  while (filled.length < budget) {
    filled.push("");
  }

  const lines = [...header, ...filled.slice(0, budget), ...footer].slice(0, rows);
  while (lines.length < rows) {
    lines.push("");
  }
  return lines.map((line) => fit(line, columns));
}

/** What every panel builder needs: the width of the window and how to colour it. */
interface Layout {
  readonly width: number;
  readonly paint: Painter;
}

/**
 * One panel of the frame.
 *
 * `draw(limit)` must return no more than `limit` lines. `min` is the smallest
 * allocation that still shows something worth reading, `max` the rows the panel's
 * content can actually fill — a table of three groups reserves room for three, so the
 * leftover rows go to the log instead of to blank space under a short table.
 */
interface Panel {
  /** What to drop first when the window is short: the highest priority survives longest. */
  readonly priority: number;
  readonly min: number;
  readonly max: number;
  readonly draw: (limit: number) => readonly string[];
}

/**
 * @returns the body panels, in the order they are drawn, each with the rows it can
 * actually use.
 *
 * Priorities are about what is worth keeping when the window shrinks: the two
 * progress bars are the reason the window exists, the live GitHub read is the part
 * that changes second to second, and the log explains a poll that failed. The hourly
 * charts sit in the middle — they are what makes a full screen worth having, and what
 * a twelve-row window can do without, because the gauges already say where the project
 * is and "NOW" says which way it is going.
 */
function panelSections(model: MonitorModel, layout: Layout): readonly Panel[] {
  const progressMax = model.progressFailure === null ? 3 : 4;
  const liveMax = model.live === undefined ? 2 : model.live === null ? 3 : 5;
  const nowMax = model.progress === null ? 3 : 4;
  const hourlyMax = model.hourly.length === 0 ? 2 : 4;
  const groupMax = model.groups.length === 0 ? 2 : 2 + model.groups.length;
  const logMax = Math.max(2, Math.min(40, 2 + model.events.length));

  return [
    {
      priority: 100,
      min: Math.min(3, progressMax),
      max: progressMax,
      draw: () =>
        progressLines(
          "LIBRARIES",
          model.progress?.libraries ?? null,
          model.pace.libraries,
          model.progressFailure,
          layout,
        ),
    },
    {
      priority: 98,
      min: Math.min(3, progressMax),
      max: progressMax,
      draw: () =>
        progressLines(
          "SHADERS",
          model.progress?.shaders ?? null,
          model.pace.shaders,
          model.progressFailure,
          layout,
        ),
    },
    {
      priority: 99,
      min: Math.min(4, liveMax),
      max: liveMax,
      draw: (limit) => liveLines(model, layout, limit),
    },
    {
      priority: 97,
      min: Math.min(3, nowMax),
      max: nowMax,
      draw: (limit) => nowLines(model, layout, limit),
    },
    {
      priority: 78,
      min: Math.min(3, hourlyMax),
      max: hourlyMax,
      draw: (limit) => hourlyCoverageLines(model, layout, limit),
    },
    {
      priority: 74,
      min: Math.min(3, hourlyMax),
      max: hourlyMax,
      draw: (limit) => hourlyWorkLines(model, layout, limit),
    },
    {
      priority: 40,
      min: Math.min(3, groupMax),
      max: groupMax,
      draw: (limit) => groupLines(model, layout, limit),
    },
    {
      priority: 20,
      min: Math.min(3, logMax),
      max: logMax,
      draw: (limit) => logLines(model, layout, limit),
    },
  ];
}

/** @returns the two title lines and the rule under them. */
function headerLines(model: MonitorModel, layout: Layout): readonly string[] {
  const { paint, width } = layout;
  const brand = `${paint(" ANYPS5 ", "inverse")}${paint(" LIVE MONITOR", "heading")}`;
  const top = spread(brand, `${paint(model.repository, "accent")} `, width, paint);
  const dot = paint(" · ", "faint");
  // Tiers, not truncation: a fact is either there whole or not at all, because
  // "eve" on the end of a line reads as a bug rather than as a narrow window.
  const facts = [
    `${paint(clock(model.now), "text")} ${paint("UTC", "faint")}`,
    ...(width >= 34 ? [paint(`up ${uptime(model.uptimeMs)}`, "dim")] : []),
    ...(width >= 70 ? [paint(`every ${intervalLabel(model.intervalMs)}`, "dim")] : []),
    ...(width >= 46
      ? [model.authenticated ? paint("token", "good") : paint("anonymous · 60/h", "warn")]
      : []),
  ];
  const state = model.paused
    ? paint("PAUSED", "warn")
    : model.polling
      ? paint("reading…", "dim")
      : paint(`poll #${model.pollCount}`, "dim");
  const second = spread(` ${facts.join(dot)}`, state, width, paint);
  return [top, second, rule(width, paint)];
}

/** @returns the rule and the key legend at the bottom of the frame. */
function footerLines(model: MonitorModel, layout: Layout): readonly string[] {
  const { paint, width } = layout;
  const wait = model.paused
    ? paint("paused ", "warn")
    : `${paint(width >= 60 ? "next poll in " : "next ", "dim")}${countdown(model.nextPollAt.getTime() - model.now.getTime())}`;
  const failures =
    model.failureCount === 0
      ? ""
      : ` ${paint("·", "faint")} ${paint(`${model.failureCount} failed`, "warn")}`;
  return [rule(width, paint), spread(keyLegend(width, paint), `${wait}${failures} `, width, paint)];
}

/** @returns the key legend, shortened until it fits the window. */
function keyLegend(width: number, paint: Painter): string {
  const full = `${paint("[q]", "accent")} quit  ${paint("[space]", "accent")} pause  ${paint("[r]", "accent")} refresh  ${paint("F11", "accent")} full screen`;
  const medium = `${paint("[q]", "accent")} quit  ${paint("[space]", "accent")} pause  ${paint("[r]", "accent")} refresh`;
  const short = `${paint("[q]", "accent")} quit  ${paint("[space]", "accent")} pause`;
  if (width >= 86) {
    return ` ${full}`;
  }
  if (width >= 56) {
    return ` ${medium}`;
  }
  return width >= 34 ? ` ${short}` : ` ${paint("[q]", "accent")} quit`;
}

/**
 * @returns one section's three or four lines: a gauge, its pace, and the last
 * failure when there is one.
 *
 * The failure line is the reason this panel can be four rows instead of three: a
 * progress bar that keeps showing yesterday's number while `progress.json` is
 * unreachable is the sort of quiet staleness a monitor must not allow. Showing the
 * last good reading *and* the failure is the only combination that is both useful and
 * honest.
 */
function progressLines(
  title: string,
  reading: SectionReading | null,
  pace: MonitorPace,
  failure: string | null,
  layout: Layout,
): readonly string[] {
  const { paint, width } = layout;
  const label = paint(title.padEnd(10), "heading");

  if (reading === null) {
    return [
      "",
      `  ${label} ${paint("—", "faint")}  ${paint("no progress.json yet", "dim")}`,
      `  ${paint("the first successful poll fills this in", "faint")}`,
      ...(failure === null ? [] : [`  ${paint(`! ${failure}`, "bad")}`]),
    ];
  }

  const counts = `${formatCount(reading.done)} / ${formatCount(reading.total)}`;
  const percent = paint(`${formatValue(reading.percent, 2)} %`.padStart(7), "text");
  // 2 indent + 10 title + 1 + 7 percent + 1 + gap + bar + 1 + counts.
  const room = width - (2 + 10 + 1 + 7 + 1 + 1 + counts.length);
  const bar = room >= 10 ? ` ${blockBar(reading.percent / 100, Math.min(34, room), paint)}` : "";
  const main = `  ${label} ${percent}${bar} ${paint(counts, "dim")}`;

  return [
    "",
    main,
    `  ${paceDetail(pace, layout)}`,
    ...(failure === null ? [] : [`  ${paint(`! ${failure}`, "bad")}`]),
  ];
}

/**
 * @returns what moved since the last poll, what has moved this hour, and the commit the
 * snapshot came from.
 *
 * This is the panel that earns the window's refresh rate: the gauges above move slowly
 * enough that a quarter-hour would look the same, but at fifteen seconds the two counts
 * on the first line are the difference between "the port is running" and "the port is
 * stuck", and they change while you read them.
 */
function nowLines(model: MonitorModel, layout: Layout, limit: number): readonly string[] {
  const { paint, width } = layout;
  const dot = paint(" · ", "faint");
  const heading = `  ${paint("NOW", "heading")}`;
  const step = model.lastStep;
  const hour = model.thisHour;

  const sincePoll =
    step === null
      ? [paint("no second poll yet", "dim")]
      : [
          paint(`last poll ${uptime(step.seconds * 1_000)} ago`, "faint"),
          movedCount(step.librariesDone, "library", "libraries", paint),
          movedCount(step.shadersDone, "shader", "shaders", paint),
        ];
  const sinceHour =
    hour === null
      ? [paint("this hour: nothing read yet", "dim")]
      : [
          paint(
            `this hour from ${clock(hour.startsAt)} UTC, ${formatCount(hour.polls)} ${hour.polls === 1 ? "poll" : "polls"}`,
            "faint",
          ),
          movedCount(hour.librariesAdded, "library", "libraries", paint),
          movedCount(hour.shadersAdded, "shader", "shaders", paint),
        ];
  const commit = model.progressCommit;
  const source =
    commit === null
      ? paint("progress.json: no commit reported", "faint")
      : `${paint("progress.json from", "faint")} ${paint(commit.slice(0, SHORT_SHA), "accent")}`;

  return [
    "",
    `${heading}  ${trim(dot, sincePoll, width - visibleWidth(heading) - 3).join(dot)}`,
    `  ${trim(dot, sinceHour, width - 2).join(dot)}`,
    `  ${source}`,
  ].slice(0, Math.max(2, limit));
}

/**
 * @returns coverage per hour: the mean percentage each section stood at, hour by hour.
 *
 * One column per hour is the unit this window is read in. Fifteen-second readings drawn
 * raw are a wall of noise that answers "what happened in the last minute"; an hour is
 * where a port's progress is legible, and averaging means a single noisy poll cannot put
 * a spike on an otherwise flat line.
 */
function hourlyCoverageLines(
  model: MonitorModel,
  layout: Layout,
  limit: number,
): readonly string[] {
  const buckets = model.hourly;
  const first = buckets[0];

  if (first === undefined) {
    return [
      "",
      chartHeading(
        "HOURLY COVERAGE",
        ["1 column = 1h", "the chart opens with the first reading"],
        layout,
      ),
    ].slice(0, Math.max(1, limit));
  }

  const last = buckets.at(-1) ?? first;
  const lastPolls = `${formatCount(last.polls)} ${last.polls === 1 ? "poll" : "polls"}`;

  return [
    "",
    chartHeading(
      "HOURLY COVERAGE",
      [
        chartSpan(buckets),
        "1 column = 1h",
        `${formatCount(buckets.length)} ${buckets.length === 1 ? "hour" : "hours"} held`,
        `mean of ${lastPolls} so far`,
      ],
      layout,
    ),
    chartRow(
      "libraries",
      buckets,
      (bucket) => bucket.libraries,
      `${formatValue(first.libraries, 2)} → ${formatValue(last.libraries, 2)} %`,
      "good",
      layout,
    ),
    chartRow(
      "shaders",
      buckets,
      (bucket) => bucket.shaders,
      `${formatValue(first.shaders, 2)} → ${formatValue(last.shaders, 2)} %`,
      "accent",
      layout,
    ),
  ].slice(0, Math.max(2, limit));
}

/**
 * @returns what each hour finished: one bar per hour, one row per section.
 *
 * Coverage answers "where is the port"; this answers "is the port moving", which is the
 * question a monitor left open overnight is asking. A bar is the counters' last reading
 * in the hour minus their first, so it is work observed rather than work inferred, and
 * the hour still filling is drawn as what it has done so far rather than as a short hour.
 */
function hourlyWorkLines(model: MonitorModel, layout: Layout, limit: number): readonly string[] {
  const buckets = model.hourly;
  const first = buckets[0];

  if (first === undefined) {
    return [
      "",
      chartHeading(
        "HOURLY WORK",
        ["1 column = 1h", "the chart opens with the first reading"],
        layout,
      ),
    ].slice(0, Math.max(1, limit));
  }

  const busiest = busiestHour(buckets);
  const summary =
    busiest === null
      ? "nothing finished in the hours held"
      : `peak ${hourLabel(busiest.startsAt)} · ${formatCount(busiest.librariesAdded)} libraries`;
  const heading = chartHeading(
    "HOURLY WORK",
    [chartSpan(buckets), "1 column = 1h", summary],
    layout,
  );
  if (busiest === null) {
    // Every column would be blank: a heading that says so is the whole panel, and the
    // rows it does not use go to the log.
    return ["", heading].slice(0, Math.max(1, limit));
  }

  const hour = model.thisHour;
  const soFar = (pick: (bucket: HourBucket) => number): string =>
    hour === null ? "" : `${formatCount(pick(hour))} so far this hour`;

  return [
    "",
    heading,
    chartRow(
      "libraries",
      buckets,
      (bucket) => bucket.librariesAdded,
      soFar((bucket) => bucket.librariesAdded),
      "good",
      layout,
      true,
    ),
    chartRow(
      "shaders",
      buckets,
      (bucket) => bucket.shadersAdded,
      soFar((bucket) => bucket.shadersAdded),
      "accent",
      layout,
      true,
    ),
  ].slice(0, Math.max(2, limit));
}

/**
 * @returns one chart row: the section it is about, the sparkline, and its newest number.
 *
 * The note is a fact and is therefore kept whole or dropped whole — a row that reads
 * "48.93 →" is worse than one that shows only the shape. The chart gives up columns to
 * the note rather than the other way round, down to {@link MIN_CHART}, below which the
 * note goes instead: a chart four columns wide is not a chart.
 *
 * `zeroBased` is the difference between the two panels: coverage is drawn against its own
 * range, so a quiet day still shows its shape, while work is drawn from zero, because a
 * bar chart that floats turns thirty libraries an hour into a full-height bar and an hour
 * that did nothing into a bottom one at the same height.
 */
function chartRow(
  label: string,
  buckets: readonly HourBucket[],
  pick: (bucket: HourBucket) => number,
  note: string,
  role: PaintRole,
  layout: Layout,
  zeroBased = false,
): string {
  const { paint, width } = layout;
  const name = 12;
  const kept = width - (name + 2 + note.length) >= MIN_CHART + 2 ? note : "";
  const room = Math.max(MIN_CHART, width - name - (kept === "" ? 0 : 2 + kept.length));
  const values = buckets.slice(-room).map(pick);
  // An hour that did nothing gets a blank column rather than the sparkline's lowest
  // partial: on a zero-based bar chart `▁` and `█` are "some" and "a lot", and drawing
  // nothing at all is the only honest way to draw zero. The sparkline returns one cell
  // per value, so the columns line up with `values` index for index.
  const spark = [...renderSparkline(values, { zeroBased })].map((cell, index) =>
    zeroBased && values[index] === 0 ? " " : cell,
  );
  const tail = kept === "" ? "" : `  ${paint(kept, "dim")}`;
  return `  ${paint(column(label, name - 2), "faint")}${paint(spark.join(""), role)}${tail}`;
}

/**
 * @returns a chart's heading: what the panel is, then as many of its facts as fit.
 *
 * The span sits in the heading rather than in an axis row under the chart, because the
 * row budget is spent on charts first: a separate axis line was the first thing the
 * allocator dropped, which left the columns unlabelled exactly when the window was small.
 * Facts still go whole, so a narrow window shows fewer of them rather than half of one.
 */
function chartHeading(label: string, facts: readonly string[], layout: Layout): string {
  const { paint, width } = layout;
  const dot = paint(" · ", "faint");
  const head = `  ${paint(label, "heading")}  `;
  const room = Math.max(0, width - visibleWidth(head) - 1);
  const kept = trim(
    dot,
    facts.map((fact) => paint(fact, "faint")),
    room,
  );
  return `${head}${kept.join(dot)}`;
}

/** @returns the hours a chart spans, from its oldest column to the one being filled. */
function chartSpan(buckets: readonly HourBucket[]): string {
  const first = buckets[0];
  return first === undefined ? "now" : `${hourLabel(first.startsAt)} → now`;
}

/** @returns `at` as the whole hour it falls in, in UTC: `13:00`. */
function hourLabel(at: Date): string {
  return `${String(at.getUTCHours()).padStart(2, "0")}:00`;
}

/** @returns the hour that finished the most libraries, or `null` when none did. */
function busiestHour(buckets: readonly HourBucket[]): HourBucket | null {
  let best: HourBucket | null = null;
  for (const bucket of buckets) {
    if (
      bucket.librariesAdded > 0 &&
      (best === null || bucket.librariesAdded > best.librariesAdded)
    ) {
      best = bucket;
    }
  }
  return best;
}

/**
 * @returns `pieces` with the last ones dropped until they fit `room`.
 *
 * Facts go whole. A line cut by {@link fit} can end on a separator, and "· +208" with no
 * unit after it is worse than a shorter line that still says something true.
 */
function trim(separator: string, pieces: readonly string[], room: number): readonly string[] {
  const kept = [...pieces];
  while (kept.length > 1 && visibleWidth(kept.join(separator)) > room) {
    kept.pop();
  }
  return kept;
}

/** @returns a signed count of finished items, or "no libraries" when nothing moved. */
function movedCount(count: number, one: string, many: string, paint: Painter): string {
  if (count === 0) {
    return paint(`no ${many}`, "dim");
  }
  const noun = Math.abs(count) === 1 ? one : many;
  return paint(`${signed(count)} ${noun}`, count > 0 ? "good" : "bad");
}

/**
 * @returns the panels' lines, in display order, within `budget` rows.
 *
 * First pass: minimums in priority order, so a short window keeps the panels that
 * matter. Then one row at a time, in display order, to whoever can still use one: the
 * panels stay balanced instead of the first greedy one eating the window, and when
 * everything else is full the rows keep going to the log, the only panel whose
 * content grows with the space. `max` is each panel's real appetite, so a table of
 * three groups does not reserve room for twelve.
 */
function allocate(panels: readonly Panel[], budget: number): string[] {
  const ranked = panels
    .map((panel, index) => ({ panel, index }))
    .sort((first, second) => second.panel.priority - first.panel.priority);
  const limits = panels.map(() => 0);
  let left = budget;

  for (const { panel, index } of ranked) {
    if (left >= panel.min) {
      limits[index] = panel.min;
      left -= panel.min;
    }
  }

  let grew = true;
  while (left > 0 && grew) {
    grew = false;
    for (let index = 0; index < panels.length && left > 0; index += 1) {
      const panel = panels[index];
      if (panel === undefined) {
        continue;
      }
      const limit = limits[index] ?? 0;
      if (limit < panel.min || limit >= panel.max) {
        continue;
      }
      limits[index] = limit + 1;
      left -= 1;
      grew = true;
    }
  }

  return panels.flatMap((panel, index) => {
    const limit = limits[index] ?? 0;
    return limit < panel.min ? [] : panel.draw(limit);
  });
}

/**
 * @returns the per-library table, least-done first, with the groups that moved.
 *
 * Least-done rather than most: on a porting project the interesting list is what has
 * not started, because that is where the next months of work are. The movement column
 * is folded in rather than given its own panel — a group that moved is worth a
 * footnote next to its percentage, not a second table repeating the same names.
 */
function groupLines(model: MonitorModel, layout: Layout, limit: number): readonly string[] {
  const { paint } = layout;
  if (model.groups.length === 0) {
    return [
      "",
      `  ${paint("GROUPS", "heading")}  ${paint("no per-library table in this snapshot", "faint")}`,
    ];
  }
  const rows = Math.max(0, limit - 2);
  const moved = new Map(model.movers.map((mover) => [mover.name, mover.change]));
  const head = `  ${paint("GROUPS · LEAST COMPLETE", "heading")}${paint("   own coverage, lowest first", "faint")}`;
  const body = model.groups
    .slice(0, rows)
    .map((group) => groupRow(group, moved.get(group.name) ?? null, layout));
  return ["", head, ...body];
}

/** @returns one group line, with the bar when the window is wide enough to hold it. */
function groupRow(group: GroupReading, change: number | null, layout: Layout): string {
  const { paint, width } = layout;
  const name = column(group.label, Math.max(8, Math.min(22, width - 40)));
  const percent = paint(`${formatValue(group.percent, 2)} %`.padStart(7), "text");
  const delta = change === null ? "" : `  ${paint(`${signed(change)} pp`, "good")}`;
  if (width < 60) {
    const counts = paint(`(${formatCount(group.done)}/${formatCount(group.total)})`, "faint");
    return `  ${paint(name, "dim")} ${percent} ${counts}${delta}`;
  }
  const counts = paint(`${formatCount(group.done)} / ${formatCount(group.total)}`, "dim");
  return `  ${paint(name, "dim")} ${percent} ${blockBar(group.percent / 100, 12, paint)} ${counts}${delta}`;
}

/**
 * @returns the GitHub live panel, from the tri-state `live` field.
 *
 * `undefined` and `null` are drawn differently on purpose: "nobody asked" is not a
 * failure, and a monitor that showed the same grey line for both would hide the thing
 * it exists to reveal — that the live half of the picture stopped working.
 */
function liveLines(model: MonitorModel, layout: Layout, limit: number): readonly string[] {
  const { paint, width } = layout;
  const heading = `  ${paint("GITHUB LIVE", "heading")}`;

  if (model.live === undefined) {
    return ["", `${heading}  ${paint("not asked — no live read configured", "dim")}`];
  }
  if (model.live === null) {
    return [
      "",
      `${heading}  ${paint("GitHub did not answer", "bad")}`,
      `  ${paint(model.liveFailure ?? "the next poll retries", "dim")}`,
    ];
  }

  const facts = model.live;
  const now = model.now;
  const dot = paint("·", "faint");
  const gap = ` ${dot} `;
  // Trim whole facts rather than letting `fit` cut one in half: at forty columns
  // "watchers 41" is worth losing, "...wa" is not worth reading.
  const counters = [
    paint(`stars ${formatCount(facts.stars)}`, "text"),
    paint(`forks ${formatCount(facts.forks)}`, "text"),
    paint(`watchers ${formatCount(facts.watchers)}`, "text"),
    paint(`${formatCount(facts.openIssues)} open issues`, "text"),
    paint(`pushed ${facts.pushedAt === null ? "never" : relativeTime(facts.pushedAt, now)}`, "dim"),
  ];
  while (counters.length > 2 && visibleWidth(`  ${counters.join(gap)}`) > width) {
    counters.pop();
  }
  const release = releaseText(model, paint);
  const workflow = `${release} ${dot} ${workflowText(model, paint)}${facts.archived ? ` ${dot} ${paint("ARCHIVED", "bad")}` : ""}`;
  const lines = [
    "",
    `${heading}  ${paint(`read ${relativeTime(facts.fetchedAt, now)}`, "dim")} ${dot} ${quotaText(model, layout)}`,
    `  ${counters.join(gap)}`,
    visibleWidth(`  ${workflow}`) <= width ? `  ${workflow}` : `  ${release}`,
    `  ${paint("languages", "faint")}  ${paint(languageText(facts, width), "dim")}`,
  ];
  return lines.slice(0, Math.max(2, limit));
}

/** @returns the token and rate-limit state: the two facts that explain an empty read. */
function quotaText(model: MonitorModel, layout: Layout): string {
  const { paint, width } = layout;
  const facts = model.live;
  if (facts === null || facts === undefined) {
    return paint("no live read", "faint");
  }
  const parts = [facts.authenticated ? paint("token", "good") : paint("anonymous", "warn")];
  if (facts.rateLimitRemaining === null) {
    if (width >= 46) {
      parts.push(paint("quota unknown", "faint"));
    }
  } else if (width >= 46) {
    const low = facts.rateLimitRemaining < 200;
    parts.push(paint(`quota ${formatCount(facts.rateLimitRemaining)} left`, low ? "warn" : "dim"));
  }
  if (facts.rateLimitResetAt !== null && width >= 70) {
    parts.push(paint(`resets ${untilTime(facts.rateLimitResetAt, model.now)}`, "faint"));
  }
  return parts.join(paint(" · ", "faint"));
}

/** @returns the newest release, or a line saying there is none. */
function releaseText(model: MonitorModel, paint: Painter): string {
  const release = model.live?.release ?? null;
  if (release === null) {
    return paint("no release yet", "faint");
  }
  const when =
    release.publishedAt === null
      ? ""
      : ` ${paint(relativeTime(release.publishedAt, model.now), "faint")}`;
  return `${paint("release", "dim")} ${paint(release.tag, "text")}${when}`;
}

/** @returns the last CI run, coloured by its conclusion. */
function workflowText(model: MonitorModel, paint: Painter): string {
  const workflow = model.live?.workflow ?? null;
  if (workflow === null) {
    return paint("no CI runs", "faint");
  }
  const state = workflow.conclusion ?? workflow.status;
  const role: PaintRole =
    workflow.conclusion === "success" ? "good" : workflow.conclusion === null ? "warn" : "bad";
  const when =
    workflow.updatedAt === null
      ? ""
      : ` ${paint(relativeTime(workflow.updatedAt, model.now), "faint")}`;
  return `${paint("CI", "dim")} ${paint(`${workflow.name} ${state}`, role)}${when}`;
}

/** @returns the byte mix, best language first, as many as the width holds. */
function languageText(facts: GitHubLiveFacts, width: number): string {
  if (facts.languages.length === 0) {
    return "not reported";
  }
  const parts: string[] = [];
  let used = 0;
  for (const language of facts.languages) {
    const piece = `${language.name} ${formatValue(language.percent, 1)} %`;
    if (parts.length > 0 && used + piece.length > Math.max(12, width - 20)) {
      break;
    }
    parts.push(piece);
    used += piece.length + 3;
  }
  return parts.join(" · ");
}

/**
 * @returns the monitor's own history, newest at the bottom, filling whatever rows the
 * other panels left.
 *
 * Newest at the bottom because that is where the eye already is when the log grows
 * past the window: the last line is always the most recent poll, whether the panel is
 * three rows tall or thirty.
 */
function logLines(model: MonitorModel, layout: Layout, limit: number): readonly string[] {
  const { paint } = layout;
  const rows = Math.max(0, limit - 2);
  const shown = model.events.slice(rows === 0 ? 0 : -rows);
  const head = `  ${paint("LOG", "heading")}${paint(`   newest last · ${model.events.length} held`, "faint")}`;
  return ["", head, ...shown.map((event) => eventLine(event, paint))];
}

/** @returns one log line: the time it happened, and what happened. */
function eventLine(event: MonitorEvent, paint: Painter): string {
  return `  ${paint(stamp(event.at), "faint")}  ${paint(event.text, LEVEL_ROLE[event.level])}`;
}

/** How loudly each log level is drawn: `info` is the resting state of every poll. */
const LEVEL_ROLE: Readonly<Record<MonitorLevel, PaintRole>> = {
  info: "dim",
  good: "good",
  warn: "warn",
  bad: "bad",
};

/** @returns the pace line under a gauge: change, rate, and the estimate. */
function paceDetail(pace: MonitorPace, layout: Layout): string {
  const { paint, width } = layout;
  if (pace.change === null) {
    return paint("first reading — the pace appears after the next poll", "faint");
  }
  const role: PaintRole = pace.change > 0 ? "good" : pace.change < 0 ? "bad" : "dim";
  const arrow = pace.change > 0 ? "▲" : pace.change < 0 ? "▼" : "=";
  const dot = paint(" · ", "faint");
  const pieces = [
    paint(`${arrow} ${signed(pace.change)} pp since start`, role),
    pace.perHour === null
      ? paint("no rate yet", "faint")
      : paint(`${signed(pace.perHour)} pp/h`, pace.perHour > 0 ? "text" : "dim"),
    pace.etaDays === null
      ? paint("no finish line at this pace", "faint")
      : paint(`${formatSpan(pace.etaDays)} to 100 %`, "dim"),
  ];
  // Drop the estimate before the rate, and the rate before the change: the change is
  // the one number that says the port is still moving.
  while (pieces.length > 1 && visibleWidth(pieces.join(dot)) > width - 2) {
    pieces.pop();
  }
  return pieces.join(dot);
}

/** @returns `text` in exactly `width` cells, cut with an ellipsis when it is longer. */
function column(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** @returns `value` with its sign, at the precision the magnitude deserves. */
function signed(value: number): string {
  if (value === 0) {
    return "±0";
  }
  const magnitude = Math.abs(value);
  const text = formatValue(magnitude, magnitude >= 10 ? 0 : magnitude >= 1 ? 1 : 2);
  return `${value > 0 ? "+" : "-"}${text}`;
}

/** @returns the UTC wall clock, `HH:MM:SS` — one timezone, and the one GitHub reports in. */
function clock(date: Date): string {
  return date.toISOString().slice(11, 19);
}

/** @returns the same clock, for a log line. */
function stamp(date: Date): string {
  return clock(date);
}

/** @returns how long the monitor has been up, at the coarsest useful pair of units. */
function uptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

/** @returns a countdown as `mm:ss`, floored at zero and capped at 99:59. */
function countdown(ms: number): string {
  const seconds = Math.min(5_999, Math.max(0, Math.ceil(ms / 1_000)));
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** @returns the poll interval as it is passed on the command line. */
function intervalLabel(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
