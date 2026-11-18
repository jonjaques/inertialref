import { QUERY } from '../pages/paths.ts'

/*
 * A hold on the frame loop, for a measurement that submits its own frames,
 * and for a page that paces itself.
 *
 * `measureGpuFrameMs` times a batch of submissions across a drained queue,
 * and the figure is about that batch only if nothing else submits while the
 * queue drains. The loop does: the drain is an `await`, animation frames keep
 * firing under it, and every one presents a frame through the same chain — so
 * a batch of one frame recorded five to ten galaxy volume draws, and a batch
 * with the backdrop hidden recorded eight to ten more, because the frame
 * callback that hid it was outrun by the one that shows it. Neither number
 * was about the shader.
 *
 * The obvious lever is R3F's `setFrameloop('never')`, and it is not one this
 * module can rely on. `<Canvas>` runs `configure` on every render of the
 * shell, and `configure` writes the `frameloop` prop back, so whether `never`
 * survives a batch depends on nothing above the canvas re-rendering inside
 * it — a condition no rig can see from the page. The M5 rig that relied on
 * it recorded the counts above; a probe here held `never` for 1.5 s with
 * nothing submitted, and neither result is a property of the flag.
 *
 * So the hold is a flag every frame consumer reads for itself: `useTimedFrame`
 * returns before its callback, `EngineTick` skips the step, and R3F's loop
 * runs an update in which nothing renders and nothing moves. The counts are
 * then exact by construction — ten frames asked for, ten submissions, and
 * with the backdrop hidden none. The engine's clock does not see the wall
 * time a measurement's hold took: R3F takes each callback's `delta` afresh
 * from its own clock (`clock.getDelta()` in its `update`, 9.8.2), so a held
 * callback's interval reaches no later step, and a measurement's frames are
 * timed, not simulated. Counted rather than boolean, so two overlapping holds
 * release in either order without the first lifting the second.
 *
 * **The page's pace** (`?pace=60`, phase 1 design §7.5) is the same flag
 * read a second way: a callback that arrives before the next point of a
 * 60 Hz grid, taken from the host's clock, is held, so the loop draws on the
 * grid whatever the display's rate. It holds the rate of the frames drawn; it
 * does not make the compositor present them. A paced skip, unlike a
 * measurement's hold, is a frame the player never sees and the world still
 * lives through, so its `delta` is banked and handed to every consumer of the
 * next drawn frame (`frameDelta`): the simulation books its ticks by wall
 * time, and a skip neither drops nor doubles one.
 *
 * Without the key none of it exists: no clock is read, no grid kept, and
 * `framesHeld` is `holds > 0`, as it is on every page that does not ask.
 */
let holds = 0

/** Take the loop. Returns the release; releasing twice is a no-op. */
export function holdFrames(): () => void {
  holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
  }
}

/* ------------------------------------------------------------ the page's pace ---- */

/**
 * A grid's tolerance, as a share of its period: a callback this early is the
 * grid point's. Display callbacks jitter by a millisecond or so, and at
 * 120 Hz one lands on every other grid point exactly; with no tolerance a
 * callback 0.1 ms early waits a whole callback more, and 120 Hz draws at 40.
 * A quarter of a 60 Hz period, 4.2 ms, is under half of every display
 * interval from 144 Hz down, so no grid point takes two callbacks.
 */
export const PACE_SLACK = 0.25

/** A 60 Hz grid on the host's clock, and what it has done. */
export interface PaceGrid {
  readonly periodMs: number
  /** The next grid point, or null before the first callback. */
  next: number | null
  drawn: number
  skipped: number
  /**
   * Draws that found the grid a whole period behind them and restarted it:
   * callbacks slower than the grid, which no hold can speed up. Any here
   * says the hold was not reached.
   */
  behind: number
}

export const paceGrid = (hz: number): PaceGrid => ({
  periodMs: 1000 / hz,
  next: null,
  drawn: 0,
  skipped: 0,
  behind: 0,
})

/**
 * Whether a callback at `now` draws. The grid is anchored at the first
 * callback and advanced a period a draw, not reset to each draw's own time,
 * so its mean rate is the grid's however the callbacks fall. A draw that
 * leaves the grid behind it restarts the grid there, so a stall or a slow
 * display draws every callback rather than a burst to catch up.
 */
export function paceStep(grid: PaceGrid, now: number): boolean {
  if (grid.next === null) {
    grid.next = now + grid.periodMs
    grid.drawn += 1
    return true
  }
  if (now < grid.next - PACE_SLACK * grid.periodMs) {
    grid.skipped += 1
    return false
  }
  grid.next += grid.periodMs
  if (grid.next <= now) {
    grid.next = now + grid.periodMs
    grid.behind += 1
  }
  grid.drawn += 1
  return true
}

/**
 * The page's pace: the grid and the host's clock, or null for a page that did
 * not ask. Read from the URL once, on the first frame that asks: the query is
 * the page's for its lifetime, and reading it on every one of a frame's dozen
 * `framesHeld` calls would allocate in the frame loop.
 */
interface Pace {
  readonly grid: PaceGrid
  readonly now: () => number
}
let pace: Pace | null | undefined

function pacedHz(): number | null {
  try {
    const asked = new URLSearchParams(window.location.search).get(QUERY.pace)
    // `60` and nothing else: another rate is a measurement nobody has asked
    // for, and an unknown value is read as no pace rather than a guess.
    return asked === '60' ? 60 : null
  } catch {
    // No `location`: a test or a worker, never paced.
    return null
  }
}

/**
 * Sets the page's pace, for a test: a rate and a clock, none, or `undefined`
 * to read the URL again on the next ask.
 */
export function configurePace(
  hz: number | null | undefined,
  now: () => number = () => performance.now(),
): void {
  pace = hz == null ? hz : { grid: paceGrid(hz), now }
  frame = null
  banked = 0
}

/** The page's pace, read on the first ask: null for a page that did not ask. */
function current(): Pace | null {
  if (pace === undefined)
    pace =
      pacedHz() === null
        ? null
        : { grid: paceGrid(60), now: () => performance.now() }
  return pace
}

/** The page's grid as it stands, for a reader that wants its counts; null unpaced. */
export const paceReport = (): Readonly<PaceGrid> | null =>
  current()?.grid ?? null

/**
 * This callback's decision and what it banked or carries. Every consumer of
 * one callback runs in the same task, R3F calling them in turn, so the first
 * to ask decides for all of them and a microtask forgets it after.
 */
interface Frame {
  readonly held: boolean
  banked: boolean
  carry: number | null
}
let frame: Frame | null = null
/** Seconds of skipped callbacks the next drawn frame owes the world. */
let banked = 0

function paced(p: Pace): Frame {
  if (frame !== null) return frame
  const decided: Frame = {
    held: !paceStep(p.grid, p.now()),
    banked: false,
    carry: null,
  }
  frame = decided
  queueMicrotask(() => {
    if (frame === decided) frame = null
  })
  return decided
}

/** Whether a frame consumer should do nothing this frame. */
export function framesHeld(): boolean {
  if (holds > 0) return true
  const p = current()
  return p !== null && paced(p).held
}

/**
 * This callback's `delta` for a frame consumer, or null when it is held. Held
 * by a measurement, nothing is banked, as before. Held by the pace, the
 * callback's `delta` is banked once; on the next drawn frame every consumer
 * is handed its own `delta` with the bank added, and the bank is spent.
 * Unpaced and unheld, it is `delta`.
 */
export function frameDelta(delta: number): number | null {
  if (holds > 0) return null
  const p = current()
  if (p === null) return delta
  const f = paced(p)
  if (f.held) {
    if (!f.banked) {
      banked += delta
      f.banked = true
    }
    return null
  }
  if (f.carry === null) {
    f.carry = banked
    banked = 0
  }
  return delta + f.carry
}
