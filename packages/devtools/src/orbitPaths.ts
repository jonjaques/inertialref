import type { Meters } from '@inertialref/shared'
import { type FrameId, UV, type UniverseVector } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  bodyFrameId,
  formatAddress,
  type StarSystem,
  walkBodies,
} from '@inertialref/universe'

/*
 * Orbit traces, for drawing.
 *
 * A planetarium without orbit lines shows you where everything is and none of
 * how it got there — and this engine can afford them exactly because ADR-0006
 * made orbits analytic: a body's position at any time is a closed-form query,
 * so a whole period is 96 evaluations rather than 96 integration steps that
 * would drift away from the body they belong to.
 *
 * Two decisions worth stating, because the naive version of each is wrong in a
 * way that only shows on screen:
 *
 * **The trace is relative to the primary, re-anchored to now.** Sampling a
 * moon's *absolute* position over one of its months also sweeps the planet
 * through a twelfth of its year, so the trace comes out as an open corkscrew
 * that starts at the moon and ends somewhere the moon has never been. The
 * relative offset is the ellipse; the parent's position *now* is where to hang
 * it.
 *
 * **The trace starts at the body.** Sampling from t = 0, or from some epoch,
 * produces a closed ellipse in the right place whose first point is nowhere in
 * particular — which is fine until it is drawn as a fading tail, and then the
 * tail is behind a body that is somewhere else on the curve.
 */

/** One body's path, in universe coordinates, starting at where it is now. */
export interface OrbitPath {
  readonly address: string
  readonly name: string
  /**
   * The body's radius, so a host can place each point the way it places the
   * body itself. It matters more than it looks: render compression keys off an
   * object's own radius, so a path placed as a radius-zero point is drawn at a
   * completely different depth from the planet it belongs to — six times
   * nearer, at Jupiter's range. See `placement.ts`.
   */
  readonly radius: Meters
  /** How deep in the moon hierarchy: 1 for a planet, 2 for a moon. */
  readonly depth: number
  /** Closed: the last point is one full period on, which is the first again. */
  readonly points: readonly UniverseVector[]
  /**
   * The primary's frame, and where it was when this trace was built.
   *
   * Together they are what lets a host keep a trace correct without rebuilding
   * it. The *shape* of the curve is fixed in the primary's frame; only the
   * anchor moves, so re-hanging it is one vector difference for the whole path
   * rather than a fresh period of Kepler solves. That matters: rebuilding every
   * trace in a system costs a few milliseconds, which is a visible hitch at
   * 60 Hz and would happen on every frame of time warp.
   */
  readonly parent: FrameId
  readonly anchor: UniverseVector
}

/** Enough for a smooth ellipse at any framing; 48 shows facets on a wide shot. */
export const DEFAULT_SAMPLES = 96

export interface OrbitPathOptions {
  readonly samples?: number
  /** Skip bodies whose period is longer than this. Omit for all of them. */
  readonly maxPeriodSeconds?: number
}

/**
 * Every orbit in a system, traced.
 *
 * Returned in the order `walkBodies` issues, which is issue order rather than
 * orbital order — see ADR-0009. A caller that wants them sorted for display
 * sorts them; this is not the place to bake in a display decision.
 */
export function orbitPaths(
  world: World,
  system: StarSystem,
  options: OrbitPathOptions = {},
): readonly OrbitPath[] {
  const samples = Math.max(8, Math.trunc(options.samples ?? DEFAULT_SAMPLES))
  const now = world.clock.time
  const paths: OrbitPath[] = []

  for (const body of walkBodies(system)) {
    const period = body.orbitalPeriod
    if (!Number.isFinite(period) || period <= 0) continue
    if (
      options.maxPeriodSeconds !== undefined &&
      period > options.maxPeriodSeconds
    )
      continue

    const frame = bodyFrameId(body.address)
    if (!world.frames.has(frame)) continue
    const parent = world.frames.get(frame).parent
    if (parent === null) continue

    const anchor = world.frames.pose(parent, now).position
    const points: UniverseVector[] = []
    for (let i = 0; i <= samples; i += 1) {
      const t = now + (period * i) / samples
      const here = world.frames.pose(frame, t).position
      const primary = world.frames.pose(parent, t).position
      // The offset in universe axes, re-hung on where the primary is *now*.
      points.push(UV.translate(anchor, UV.difference(here, primary)))
    }

    paths.push({
      address: formatAddress(body.address),
      name: body.name,
      radius: body.radius,
      depth: body.address.kind === 'body' ? body.address.body.length : 1,
      points,
      parent,
      anchor,
    })
  }
  return paths
}
