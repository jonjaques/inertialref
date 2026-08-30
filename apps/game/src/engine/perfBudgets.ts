/*
 * What "over budget" means, in one place.
 *
 * These were module constants inside `hud/PerfPanel.tsx`, which meant the only
 * thing that could act on them was the plot. A trace entry wants the same
 * definition — a frame over `DROPPED_FRAME_MS` should be drawn `error` on the
 * timeline for exactly the reason the plot draws its warning line there — and
 * `hud/` sits above `engine/`, so the sink cannot import the panel's module.
 * Beside `FrameMetrics` is where both can reach them.
 *
 * Not a Fast Refresh split. `perfFormat.ts` is that, and it applies to a `.tsx`
 * exporting functions; four numbers in a `.ts` sibling are simply somewhere a
 * non-component can import from.
 *
 * Budgets come from `docs/design/technical.md` § Performance budgets, and the
 * panel draws them on the plots rather than writing them next to them, because
 * the useful question is never "what is the budget" but "how close is this to
 * it".
 */

/** The frame budget, ms. 60 fps at 1920×1080 is the target machine's job. */
export const FRAME_BUDGET_MS = 16.6

/**
 * Where a frame period stops being jitter and starts being a dropped frame.
 *
 * The budget and the measurement are not the same quantity, and coloring on the
 * budget alone gets this wrong in the most misleading direction. The budget is
 * 16.6 ms of *work*; what the panel samples is the interval between animation
 * frames, and on a vsynced display that interval is pinned at 16.67 ms by the
 * display whether the frame took 2 ms or 16. Measured at a comfortable 60 fps,
 * the period's p95 is 17.8 ms — over budget, permanently, while nothing at all
 * is wrong.
 *
 * A frame that is genuinely late misses a vsync interval and lands near 33 ms.
 * 25 ms is between the two and cannot be reached by jitter.
 */
export const DROPPED_FRAME_MS = 25

/** `docs/design/technical.md`: simulation ticks 0.5 ms, snapshot + scene build 1.5 ms. */
export const ENGINE_BUDGET_MS = 2.0

/** The draw-call budget from the same table. */
export const DRAW_CALL_BUDGET = 1_200
