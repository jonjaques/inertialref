import { describe, expect, it } from 'vitest'
import {
  type FrameId,
  UV,
  type UniverseVector,
  Vec,
} from '@inertialref/spatial'
import {
  type BodyKind,
  bodyFrameId,
  parseAddress,
  systemId,
  TEST_CATALOG,
} from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { openSession, type Session } from './session.ts'
import {
  orbitPaths,
  orbitScopeKey,
  type OrbitPath,
  visibleOrbits,
} from './orbitPaths.ts'

/*
 * Two claims, and both have a version that looks right in a screenshot and is
 * wrong: the trace has to pass through the body it belongs to, and it has to
 * close.
 */
function world(): Session {
  const registry = createTaskRegistry()
  return openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    catalog: TEST_CATALOG,
  })
}

/** Sol's traces, from a fresh session. Every test starts the same way. */
function traces(options?: Parameters<typeof orbitPaths>[2]): {
  session: Session
  paths: readonly OrbitPath[]
} {
  const session = world()
  const system = session.world.loadSystem(systemId('SOL'))
  return { session, paths: orbitPaths(session.world, system, options) }
}

/** A point that must exist. Keeps the assertions about geometry. */
function at(path: OrbitPath, index: number): UniverseVector {
  const point = path.points.at(index)
  if (point === undefined) throw new Error(`no sample ${index}`)
  return point
}

describe('orbit traces', () => {
  it('starts exactly where the body is now', () => {
    // Sampling from t = 0 or from an epoch gives a closed ellipse in the right
    // place whose first point is nowhere in particular — invisible until the
    // trace is drawn as a tail behind a body that is elsewhere on the curve.
    const { session, paths } = traces()
    expect(paths.length).toBeGreaterThan(3)

    for (const path of paths) {
      const address = parseAddress(path.address)
      if (address.kind !== 'body') throw new Error('not a body address')
      const actual = session.world.frames.pose(
        bodyFrameId(address),
        session.world.clock.time,
      ).position
      // A meter, against orbits of 1e11 m: this is the analytic solution
      // evaluated twice, so anything larger would mean the trace is a
      // different curve from the one the body is on.
      expect(UV.distance(at(path, 0), actual)).toBeLessThan(1)
    }
  })

  it('closes: a whole period later is where it began', () => {
    for (const path of traces().paths) {
      const span = UV.distance(at(path, 0), at(path, -1))
      const step = UV.distance(at(path, 0), at(path, 1))
      // Against the sample spacing rather than an absolute: a closed orbit's
      // wrap-around error should be far below one step of the trace, whatever
      // the orbit's size.
      expect(span).toBeLessThan(step * 0.05 + 1)
    }
  })

  it('traces a moon as an ellipse around its planet, not a corkscrew', () => {
    /*
     * The decision this file exists to record. Sampling a moon's *absolute*
     * position over one of its months also sweeps the planet through a twelfth
     * of its year, so the trace comes out open — it ends a planet-month away
     * from where it started. Relative-then-re-anchored closes it.
     */
    const moons = traces().paths.filter((path) => path.depth > 1)
    if (moons.length === 0) return // The fixture may have none; the rule stands.

    for (const moon of moons) {
      const centre = centroid(moon.points)
      const radii = moon.points.map((point) => UV.distance(point, centre))
      const min = Math.min(...radii)
      const max = Math.max(...radii)
      // A closed ellipse: every point is within a factor of a few of the mean
      // radius. A corkscrew's span is the *planet's* travel, which is orders
      // larger than the moon's own orbit.
      expect(max / Math.max(min, 1)).toBeLessThan(6)
    }
  })

  it('spans about twice the semi-major axis across the ellipse', () => {
    const { session, paths } = traces()
    const system = session.world.loadSystem(systemId('SOL'))
    const earth = paths.find((path) => path.name === 'Earth')
    const body = system.planets.find((planet) => planet.name === 'Earth')
    if (earth === undefined || body === undefined)
      throw new Error('the fixture has no Earth')

    let widest = 0
    for (const a of earth.points) {
      for (const b of earth.points) widest = Math.max(widest, UV.distance(a, b))
    }
    const major = 2 * body.elements.semiMajorAxis
    // Within a percent: the widest chord of an ellipse is its major axis, and
    // 96 samples resolve that to well under 1%.
    expect(Math.abs(widest / major - 1)).toBeLessThan(0.01)
  })

  it('honors the sample count and the period filter', () => {
    expect(traces({ samples: 12 }).paths[0]?.points).toHaveLength(13)
    // One Earth year. Everything outside Earth's orbit drops out, which is
    // what a "show the inner system" control does.
    const inner = traces({ maxPeriodSeconds: 3.2e7 }).paths
    expect(inner.length).toBeLessThan(traces().paths.length)
  })
})

/** The mean of a path, worked in offsets so the sector arithmetic stays exact. */
function centroid(points: readonly UniverseVector[]): UniverseVector {
  const first = points[0]
  if (first === undefined) throw new Error('empty path')
  let sum = Vec.ZERO
  for (const point of points) sum = Vec.add(sum, UV.difference(point, first))
  return UV.translate(first, Vec.scale(sum, 1 / points.length))
}

describe('which orbits are worth drawing', () => {
  /*
   * This lived inside `GameEngine.#maybeTraceOrbits`, reachable only through
   * the frame loop, so the one thing it does — turn a hundred and twenty-nine
   * lines into eight — had no test and neither did the key it is cached
   * against. Both failures are silent, which is the reason these exist.
   */
  const path = (
    address: string,
    parent: string,
    kind: BodyKind = 'rocky',
  ): OrbitPath =>
    ({ address, parent, kind, name: address }) as unknown as OrbitPath

  const SUN = 'f:s:SOL' as FrameId
  const MARS = 'f:s:SOL/b:3' as FrameId

  const mars = path('s:SOL/b:3', SUN)
  const earth = path('s:SOL/b:2', SUN)
  const phobos = path('s:SOL/b:3.0', MARS, 'moon')
  const bennu = path('s:SOL/b:44', SUN, 'asteroid')
  const pluto = path('s:SOL/b:60', SUN, 'dwarf')
  const all = [mars, earth, phobos, bennu, pluto]

  const onMars = {
    focus: MARS,
    grandparent: SUN,
    subject: 's:SOL/b:3',
    scope: 'context' as const,
  }

  it('keeps the subject’s siblings and whatever goes round it', () => {
    const kept = visibleOrbits(all, onMars).map((one) => one.address)
    expect(kept).toContain('s:SOL/b:2') // a sibling planet
    expect(kept).toContain('s:SOL/b:3.0') // a moon of the subject
  })

  it('leaves the rubble out, and keeps the dwarf planets', () => {
    /*
     * Measured by looking at Bennu: the asteroid was a dark shape inside a
     * wireframe cage of a hundred and twenty-nine lines. Pluto stays, because
     * "where does its orbit cross Neptune's" is the one trace a planetarium is
     * most often opened for.
     */
    const kept = visibleOrbits(all, onMars).map((one) => one.address)
    expect(kept).not.toContain('s:SOL/b:44')
    expect(kept).toContain('s:SOL/b:60')
  })

  it('draws a small body’s own orbit when it is the subject', () => {
    const onBennu = {
      ...onMars,
      focus: 'f:s:SOL/b:44' as FrameId,
      subject: 's:SOL/b:44',
    }
    expect(visibleOrbits(all, onBennu).map((one) => one.address)).toContain(
      's:SOL/b:44',
    )
  })

  it('draws everything on `all`, and everything when nothing is focused', () => {
    expect(visibleOrbits(all, { ...onMars, scope: 'all' })).toHaveLength(5)
    expect(visibleOrbits(all, { ...onMars, focus: null })).toHaveLength(5)
  })

  it('keys on the scope, or the switch looks dead', () => {
    /*
     * The regression that motivated the extraction. Drop the scope from the
     * key and flipping *Scope* in the View panel changes `engine.orbitScope`,
     * the rebuild early-returns on a matching key, and `this.orbits` stays
     * exactly as it was — a control that appears to do nothing until the reader
     * navigates away and back. Lint, typecheck and the suite stay green.
     */
    const systems = ['SOL']
    expect(orbitScopeKey(systems, onMars)).not.toBe(
      orbitScopeKey(systems, { ...onMars, scope: 'all' }),
    )
    // ...and on everything else the selection reads, for the same reason.
    expect(orbitScopeKey(systems, onMars)).not.toBe(
      orbitScopeKey(systems, { ...onMars, focus: SUN }),
    )
    expect(orbitScopeKey(systems, onMars)).not.toBe(
      orbitScopeKey(systems, { ...onMars, subject: 's:SOL/b:2' }),
    )
    expect(orbitScopeKey(systems, onMars)).not.toBe(
      orbitScopeKey([...systems, 'HIP71683'], onMars),
    )
    // Same inputs, same key — or it rebuilds every frame.
    expect(orbitScopeKey(systems, onMars)).toBe(orbitScopeKey(systems, onMars))
  })
})
