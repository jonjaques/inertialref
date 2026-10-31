import {
  type AirHeights,
  airHeights,
  airTopRatio,
} from '@inertialref/rendering'
import type { StarSystem } from '@inertialref/universe'
import { walkBodies } from '@inertialref/universe'

/*
 * What the boot preloader must warm, computed from nothing but data.
 *
 * Split from `preload.ts` because that file touches `three/webgpu` and this
 * one deliberately does not: the enumeration is arithmetic over the loaded
 * systems, so it can be tested in Node — including the one claim that matters,
 * that the parameters computed here are *identical* to the ones `Bodies.tsx`
 * asks `scatteringFor` for at draw time. A prebake with a key that differs by
 * one rounding step is a cache miss wearing a cache's clothes: the boot cost is
 * paid, and the 50 ms bake happens on first sight anyway.
 */

/**
 * The shape both `HazeLayer` (universe) and `HazeAuthoring` (rendering)
 * satisfy — exactly the fields the bake and its key read. No `height`: it
 * only enters through `topRatio`, and requiring it here would stop a
 * `HazeAuthoring` from being keyed at all.
 */
export interface HazeLike {
  readonly color: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  readonly limb: { readonly r: number; readonly g: number; readonly b: number }
  readonly thickness: number
  readonly aerosolAngstrom: number
  readonly ozone: number
}

export interface ScatteringBake {
  readonly haze: HazeLike
  readonly topRatio: number
  readonly heights: AirHeights
}

/**
 * The cache key `atmosphereLuts.ts` stores a bake under. One definition,
 * imported there — two copies of this string format is exactly the drift the
 * header warns about.
 */
export function scatteringKey(
  haze: HazeLike,
  topRatio: number,
  heights: AirHeights,
): string {
  const { color, limb, thickness, aerosolAngstrom, ozone } = haze
  return [
    color.r,
    color.g,
    color.b,
    limb.r,
    limb.g,
    limb.b,
    thickness,
    aerosolAngstrom,
    ozone,
    topRatio.toFixed(6),
    heights.rayleigh.toPrecision(6),
    heights.aerosol.toPrecision(6),
  ].join(':')
}

/**
 * Every distinct atmosphere bake the loaded systems can ask for.
 *
 * `topRatio` and `heights` are `buildScene`'s own `airTop` and `airHeights`,
 * from `@inertialref/rendering`'s `datum.ts` rather than recomputed here, so
 * the two agree by construction. The gas's scale height is assigned from
 * `atmosphere` in `snapshot.ts`, which is the hop these calls make explicit.
 */
export function scatteringBakes(
  systems: readonly StarSystem[],
): readonly ScatteringBake[] {
  const out = new Map<string, ScatteringBake>()
  for (const system of systems) {
    for (const body of walkBodies(system)) {
      const haze = body.appearance.haze
      if (haze === null) continue
      const topRatio = airTopRatio(body.radius, haze.height)
      const heights = airHeights(
        body.radius,
        haze.height,
        body.atmosphere?.scaleHeight ?? 0,
        haze.aerosolHeight,
      )
      const key = scatteringKey(haze, topRatio, heights)
      if (!out.has(key)) out.set(key, { haze, topRatio, heights })
    }
  }
  return [...out.values()]
}
