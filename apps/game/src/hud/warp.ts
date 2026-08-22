/*
 * The time-warp detent ladder.
 *
 * Its own module because it is arithmetic with a boundary, and the boundary is
 * where it was wrong: an index step over a fixed array only behaves when the
 * current time scale is already one of its entries, and the clock is not only
 * driven from the dock. `ir.warp(3)` from the console, or a save written when
 * the ladder had different rungs, puts the scale between detents or past the
 * top one — and the old arithmetic answered a value above the ceiling by
 * falling back to index 0, so "slower" from 200,000× landed on 1× and "faster"
 * landed on 5×. A search has no such hole and needs no clamping.
 */

/** Powers of ten with a 5 and a 25 where the gaps are worst. */
export const WARP_STEPS = [1, 5, 25, 100, 1_000, 10_000, 100_000] as const

const FLOOR = WARP_STEPS[0]
const CEILING = WARP_STEPS[WARP_STEPS.length - 1] ?? FLOOR

/**
 * The next detent strictly above or below `current`.
 *
 * Strictly, so a value already sitting on a rung steps off it, and a value
 * between rungs snaps to the one it is heading toward rather than the one it
 * came from. Off the ladder in either direction, the nearest end.
 */
export function nextWarp(current: number, direction: number): number {
  if (!Number.isFinite(current)) return FLOOR
  const stepped =
    direction > 0
      ? WARP_STEPS.find((step) => step > current)
      : WARP_STEPS.findLast((step) => step < current)
  return stepped ?? (direction > 0 ? CEILING : FLOOR)
}
