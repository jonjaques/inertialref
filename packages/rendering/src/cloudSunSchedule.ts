/*
 * The sun grid's schedule as arithmetic: which slices a frame bakes, whether
 * its source is trusted, and how far the grid's depth replaces the layers'
 * own statistics, from what each slice holds and the frame's cap. In this
 * package so Node holds it by a property; `render/cloudSunGrid.ts` calls it
 * and keeps the GPU's side.
 *
 * A slice that holds nothing of this field is baked first, as many as the
 * cap allows; with none missing, the oldest are redrawn, four a frame and
 * six while any slice stands at a window the grid has left. The source is
 * always trusted: a slice bakes from whatever the volume holds, and where a
 * level of it is not whole the volume answers from the field. The weight
 * steps: one when every slice holds the field and zero until then, which
 * reads an unwhole grid as no cloud past the taps.
 */

/** One slice of the grid as the schedule sees it. */
export interface SunSlice {
  /** The window's low corner the slice was baked at, cells; null when it holds nothing of this field. */
  readonly origin: readonly [number, number] | null
  /** The frame it was baked on. */
  readonly frame: number
}

export interface SunScheduleInput {
  readonly slices: readonly SunSlice[]
  /** The grid's window this frame: its low corner, cells. */
  readonly origin: readonly [number, number]
  /** Slices this frame may bake: `CloudBudget.sunSlices`. */
  readonly cap: number
}

export interface SunSchedule {
  /** The slices to bake this frame, in order. */
  readonly bake: readonly number[]
  /** Every level of the grid's source holds this field: a slice may bake from it. */
  readonly sourceTrusted: boolean
  /** The rebuild's share of the grid's weight after this frame's bakes, 0..1. */
  readonly weight: number
}

/** Slices a frame redraws of a whole grid at rest, and of one whose window moved. */
export const SUN_SLICES_STEADY = 4
export const SUN_SLICES_MOVING = 6

const sameOrigin = (
  a: readonly [number, number],
  b: readonly [number, number],
): boolean => a[0] === b[0] && a[1] === b[1]

export function sunSchedule(input: SunScheduleInput): SunSchedule {
  const { slices, origin, cap } = input
  const fits = Math.max(0, Math.floor(cap))
  const missing = slices.flatMap((slice, k) =>
    slice.origin === null ? [k] : [],
  )
  if (missing.length > 0) {
    const bake = missing.slice(0, fits)
    return {
      bake,
      sourceTrusted: true,
      weight: bake.length === missing.length ? 1 : 0,
    }
  }
  const moved = slices.some(
    (slice) => slice.origin !== null && !sameOrigin(slice.origin, origin),
  )
  const bake = slices
    .map((slice, k) => ({ k, at: slice.frame }))
    .sort((a, b) => a.at - b.at || a.k - b.k)
    .slice(0, Math.min(fits, moved ? SUN_SLICES_MOVING : SUN_SLICES_STEADY))
    .map(({ k }) => k)
  return { bake, sourceTrusted: true, weight: 1 }
}

/**
 * The wake's share of the grid's weight, from the eye's height over the
 * union's top and the height the grid idles above, meters: one under it and
 * zero over it, as the grid wakes on the frame the eye comes down through it.
 */
export function sunWakeWeight(eyeOverTop: number, idleOver: number): number {
  return eyeOverTop > idleOver ? 0 : 1
}
