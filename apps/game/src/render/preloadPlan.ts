import { atmosphereShellRatio } from '@inertialref/rendering'
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
  readonly colour: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  readonly limb: { readonly r: number; readonly g: number; readonly b: number }
  readonly thickness: number
}

export interface ScatteringBake {
  readonly haze: HazeLike
  readonly topRatio: number
}

/**
 * The cache key `atmosphereLuts.ts` stores a bake under. One definition,
 * imported there — two copies of this string format is exactly the drift the
 * header warns about.
 */
export function scatteringKey(haze: HazeLike, topRatio: number): string {
  const { colour, limb, thickness } = haze
  return [
    colour.r,
    colour.g,
    colour.b,
    limb.r,
    limb.g,
    limb.b,
    thickness,
    topRatio.toFixed(6),
  ].join(':')
}

/**
 * Every distinct atmosphere bake the loaded systems can ask for.
 *
 * `topRatio` is `buildScene`'s own `atmosphereScale`, from
 * `@inertialref/rendering`'s `datum.ts` rather than recomputed here. It used to
 * be recomputed, and the two agreed only through a three-hop identity nothing
 * asserted — `relief` is assigned from `surface.maxElevation` in
 * `snapshot.ts`, which is the hop this call now makes explicit.
 */
export function scatteringBakes(
  systems: readonly StarSystem[],
): readonly ScatteringBake[] {
  const out = new Map<string, ScatteringBake>()
  for (const system of systems) {
    for (const body of walkBodies(system)) {
      const haze = body.appearance.haze
      if (haze === null) continue
      const topRatio = atmosphereShellRatio(
        body.radius,
        body.surface.maxElevation,
        haze.height,
      )
      const key = scatteringKey(haze, topRatio)
      if (!out.has(key)) out.set(key, { haze, topRatio })
    }
  }
  return [...out.values()]
}
