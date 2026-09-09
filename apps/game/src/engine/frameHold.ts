/*
 * A hold on the frame loop, for a measurement that submits its own frames.
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
 * with the backdrop hidden none. The engine's clock still sees the wall time
 * the hold took, carried in the next step's `delta`, which is the honest
 * account of a measurement that stalled the loop. Counted rather than
 * boolean, so two overlapping holds release in either order without the
 * first lifting the second.
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

/** Whether a frame consumer should do nothing this frame. */
export const framesHeld = (): boolean => holds > 0
