/**
 * The monitor's event loop: one window, one timer, three keys.
 *
 * The loop is deliberately dull. Every tick it asks the feed what it knows, asks the
 * terminal how big it is, and repaints; it polls only when the *state* says a read is
 * due. That last part is what keeps the three inputs from fighting: a pause, a manual
 * refresh and a slow read all move the next poll, and the state is the only thing that
 * knows where it moved to. A timer that counted to fifteen would have to be reset by
 * all three and would still be wrong after a suspend.
 *
 * The window owns the screen, so the loop's one non-negotiable duty is to give it back:
 * {@link Terminal.close} runs in a `finally`, whether the user pressed `q`, the feed
 * threw something it should not have, or the process was asked to stop.
 */
import { renderFrame } from "./frame.js";
import { buildModel } from "./model.js";
import type { MonitorFeed } from "./sources.js";
import type { Terminal } from "./tty.js";

/** What the runner needs: a feed, a terminal, and how often to redraw. */
export interface MonitorRunOptions {
  readonly feed: MonitorFeed;
  readonly terminal: Terminal;
  /** How often the countdown is redrawn. Defaults to one second. */
  readonly tickMs?: number;
  /** Whether the frame is coloured. Defaults to `true`. */
  readonly color?: boolean;
  /** Poll once, print one plain frame, exit: what a pipe or a test wants. */
  readonly once?: boolean;
}

/**
 * Runs the window until the user quits.
 *
 * @returns a promise that resolves on `q`, Ctrl-C or Escape, after the screen has been
 * handed back. Resolves rather than exits so a caller (a script, a test) keeps control
 * of the process.
 */
export async function runMonitor(options: MonitorRunOptions): Promise<void> {
  const { feed, terminal } = options;
  const color = options.color ?? true;
  const tickMs = Math.max(100, Math.floor(options.tickMs ?? 1_000));

  if (options.once === true) {
    // One poll, one frame, no escape sequences: `--once` is the mode a shell pipe,
    // a log or a test uses, and none of them want a cursor hidden in their output.
    const state = await feed.poll();
    terminal.paint(renderFrame(buildModel(state, new Date()), terminal.size, { color: false }));
    return;
  }

  terminal.open();
  try {
    await new Promise<void>((resolve) => {
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      let stopKeys = (): void => {};
      let stopResize = (): void => {};

      const draw = (): void => {
        const frame = renderFrame(buildModel(feed.state(), new Date()), terminal.size, { color });
        terminal.paint(frame);
      };

      const poll = (): void => {
        void feed.poll().then(() => {
          // A poll can land after the user quit; painting then would write a frame
          // over the shell the window has already given back.
          if (!stopped) {
            draw();
          }
        });
      };

      const stop = (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        stopKeys();
        stopResize();
        resolve();
      };

      const tick = (): void => {
        const state = feed.state();
        if (!state.paused && !state.polling && Date.now() >= state.nextPollAt.getTime()) {
          poll();
        }
        draw();
        timer = setTimeout(tick, tickMs);
      };

      stopKeys = terminal.onKey((key) => {
        if (key === "quit") {
          stop();
          return;
        }
        if (key === "pause") {
          const paused = !feed.state().paused;
          feed.setPaused(paused);
          // Resuming re-reads immediately rather than waiting out the old cadence:
          // the numbers on screen are as old as the pause was long.
          if (!paused) {
            poll();
          }
        } else {
          poll();
        }
        draw();
      });
      stopResize = terminal.onResize(() => draw());

      draw();
      poll();
      timer = setTimeout(tick, tickMs);
    });
  } finally {
    terminal.close();
  }
}
