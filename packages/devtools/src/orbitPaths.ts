import type { Meters } from '@inertialref/shared'
import { type FrameId, UV, type UniverseVector } from '@inertialref/spatial'
import { solveKepler } from '@inertialref/physics'
import type { World } from '@inertialref/simulation'
import {
  type BodyKind,
  bodyFrameId,
  formatAddress,
  isDebris,
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
  /**
   * What is on this orbit, so a host can decide whether the trace is context.
   *
   * A planetarium draws a subject's siblings to show where it sits. That was
   * unambiguous while a star's children were eight planets; with fifty-nine
   * dwarf planets, asteroids and comets in Sol it is a cage of a hundred and
   * twenty-nine lines
   * across the frame, and Bennu is somewhere behind it. `kind` is what lets a
   * host draw the worlds and leave the rubble out.
   */
  readonly kind: BodyKind
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
    /*
     * Sampled uniformly in *eccentric anomaly*, not in time.
     *
     * Kepler's second law says a body on an eccentric orbit spends almost all
     * of its period near aphelion, so equal steps in time put almost all the
     * samples in the same place. At e = 0 the two are identical and nobody
     * noticed; then C/2020 F3 (NEOWISE) arrived at e = 0.99913 with a 6,600-year
     * period, and consecutive samples were sixty-nine years apart with the two
     * bracketing perihelion sitting at 38 AU on opposite sides. The drawn trace
     * was a flat-ended lens through the middle of the Sun, and whenever the
     * comet was near perihelion it was nowhere near its own orbit line.
     *
     * `M = E − e·sin E` is Kepler's equation run *forwards*, which needs no
     * solver, and `t = epoch + (M − M₀)/n` is the absolute instant with that
     * eccentric anomaly. Stepping E uniformly walks the ellipse at nearly
     * constant arc length instead — the same 96 samples, spread along the
     * curve rather than along the clock.
     */
    const { eccentricity, meanAnomalyAtEpoch, epoch } = body.elements
    /*
     * The sweep starts at the body's *own* eccentric anomaly, not at
     * periapsis, because the first sample has to be where the body is now —
     * the trace is drawn as a tail behind it, and a curve that is right but
     * phase-shifted is invisible until somebody looks at the tail. That is one
     * Kepler solve for the whole path against ninety-six evaluations of it.
     */
    const meanNow = meanAnomalyAtEpoch + (2 * Math.PI * (now - epoch)) / period
    const startAnomaly = solveKepler(meanNow, eccentricity)
    for (let i = 0; i <= samples; i += 1) {
      const eccentricAnomaly = startAnomaly + (2 * Math.PI * i) / samples
      const meanAnomaly =
        eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly)
      const t =
        epoch + ((meanAnomaly - meanAnomalyAtEpoch) * period) / (2 * Math.PI)
      const here = world.frames.pose(frame, t).position
      const primary = world.frames.pose(parent, t).position
      // The offset in universe axes, re-hung on where the primary is *now*.
      points.push(UV.translate(anchor, UV.difference(here, primary)))
    }

    paths.push({
      address: formatAddress(body.address),
      name: body.name,
      radius: body.radius,
      kind: body.kind,
      depth: body.address.kind === 'body' ? body.address.body.length : 1,
      points,
      parent,
      anchor,
    })
  }
  return paths
}

/* ------------------------------------------------------------------------- */
/* Which of them are worth drawing                                            */
/* ------------------------------------------------------------------------- */

/** What the host knows about the subject when it decides which traces to keep. */
export interface OrbitScopeContext {
  /** The frame the subject's own trace hangs off, or null for no subject. */
  readonly focus: FrameId | null
  /** The frame the *subject* orbits, so its siblings can be recognized. */
  readonly grandparent: FrameId | null
  /** The subject's address, so its own orbit survives whatever its class. */
  readonly subject: string | null
  /** `context` is the subject's neighbourhood; `all` is every trace loaded. */
  readonly scope: 'context' | 'all'
}

/**
 * Thin every trace in the loaded systems down to the ones that are context.
 *
 * A pure function, and that is the point rather than tidiness. It lived inside
 * `GameEngine.#maybeTraceOrbits`, reachable only through the frame loop, so the
 * one thing it does — turn a hundred and twenty-nine lines into eight — had no
 * test at all, and neither did the rebuild key that decides whether it is
 * re-run. Both failures are silent: drop the scope from the key and the View
 * panel's switch appears dead until the reader navigates away and back, and
 * lint, typecheck and the whole suite stay green.
 *
 * The rule itself: **a subject's siblings and the things going round it, and
 * rubble is not context.** That was unambiguous when a star's children were
 * eight planets. Sol has sixty-seven, fifty-nine of them asteroids and comets,
 * and drawn together they are a cage with the subject somewhere behind it —
 * measured by looking at Bennu, which was a dark shape inside a wireframe. So a
 * small body's orbit is drawn when it *is* the subject or goes round it, and not
 * merely because it shares a primary.
 *
 * The nine dwarf planets stay: `isDebris` is asteroids and comets only, and
 * hiding Pluto costs the one trace a planetarium is most often opened for —
 * with Neptune selected, where the two orbits cross.
 *
 * `scope: 'all'` is the deliberate way to ask for the cage. From outside a
 * system it is the picture, the whole architecture of the place at once; from
 * inside it is a fan of edge-on lines. Which is why it is a switch a reader
 * throws rather than the default.
 */
export function visibleOrbits(
  all: readonly OrbitPath[],
  context: OrbitScopeContext,
): readonly OrbitPath[] {
  if (context.focus === null || context.scope === 'all') return all
  return all.filter(
    (path) =>
      path.parent === context.focus ||
      (path.parent === context.grandparent &&
        (!isDebris(path.kind) || path.address === context.subject)),
  )
}

/**
 * What a host caches its last selection against.
 *
 * Every input `visibleOrbits` reads, plus the loaded systems that produced
 * `all`. A key that omitted the scope is the failure named above; naming the
 * key here rather than interpolating it at the call site is what keeps the two
 * from drifting apart.
 */
export const orbitScopeKey = (
  systems: readonly string[],
  context: OrbitScopeContext,
): string =>
  [
    systems.join(','),
    context.focus ?? '',
    context.subject ?? '',
    context.scope,
  ].join('|')
