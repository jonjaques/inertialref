import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import { AU, EARTH_RADIUS, LIGHT_YEAR, SECONDS_PER_DAY, SECONDS_PER_YEAR } from '@inertialref/shared'
import {
  canonicalPosition,
  canonicalVelocity,
  FrameGraph,
  frameId,
  type LocalPose,
  localToUniverse,
  reframe,
  ROOT_FRAME,
  universeToLocal,
} from './frame.ts'
import * as Q from './quat.ts'
import * as UV from './universeVector.ts'
import * as V from './vec3.ts'
import { vec3 } from './vec3.ts'

const SYSTEM = frameId('system:test')
const PLANET = frameId('body:test/0')
const SURFACE = frameId('surface:test/0@equator')

/** Circular orbit in the XZ plane, evaluated analytically. */
function circularOrbit(radius: number, period: number) {
  const w = (2 * Math.PI) / period
  return (t: number): LocalPose => {
    const a = w * t
    return {
      position: vec3(radius * Math.cos(a), 0, radius * Math.sin(a)),
      orientation: Q.IDENTITY,
      velocity: vec3(-radius * w * Math.sin(a), 0, radius * w * Math.cos(a)),
      angularVelocity: V.ZERO,
    }
  }
}

/** A point on the equator of a body spinning about +Y, with the body-fixed axes. */
function equatorialSurface(radius: number, rotationPeriod: number) {
  const w = (2 * Math.PI) / rotationPeriod
  return (t: number): LocalPose => {
    const a = w * t
    return {
      position: vec3(radius * Math.cos(a), 0, -radius * Math.sin(a)),
      orientation: Q.fromAxisAngle(vec3(0, 1, 0), a),
      velocity: vec3(-radius * w * Math.sin(a), 0, -radius * w * Math.cos(a)),
      angularVelocity: vec3(0, w, 0),
    }
  }
}

// A system 4.2 ly out, an Earth-ish planet at 1 AU, a landing site on its equator.
const SYSTEM_POSITION = UV.fromMeters(4.2 * LIGHT_YEAR, 0.3 * LIGHT_YEAR, -1.1 * LIGHT_YEAR)

function buildGraph(): FrameGraph {
  const graph = new FrameGraph()
  graph.define({
    id: SYSTEM,
    parent: ROOT_FRAME,
    kind: 'system',
    anchor: { kind: 'fixed', position: SYSTEM_POSITION, orientation: Q.IDENTITY },
  })
  graph.define({
    id: PLANET,
    parent: SYSTEM,
    kind: 'body',
    anchor: { kind: 'dynamic', evaluate: circularOrbit(AU, SECONDS_PER_YEAR) },
  })
  graph.define({
    id: SURFACE,
    parent: PLANET,
    kind: 'surface',
    anchor: { kind: 'dynamic', evaluate: equatorialSurface(EARTH_RADIUS, SECONDS_PER_DAY) },
  })
  return graph
}

describe('FrameGraph', () => {
  let graph: FrameGraph

  beforeEach(() => {
    graph = buildGraph()
  })

  it('rejects cycles and dangling parents', () => {
    expect(() =>
      graph.define({
        id: frameId('orphan'),
        parent: frameId('nope'),
        kind: 'body',
        anchor: { kind: 'dynamic', evaluate: () => ({ ...circularOrbit(1, 1)(0) }) },
      }),
    ).toThrow(/unknown parent/)
    expect(() => graph.remove(SYSTEM)).toThrow(/still has child/)
  })

  it('reports the frame chain for devtools', () => {
    expect(graph.chain(SURFACE)).toEqual([ROOT_FRAME, SYSTEM, PLANET, SURFACE])
  })

  it('places a surface point at the planet radius from the planet centre', () => {
    const t = 12_345.678
    const surfacePose = graph.pose(SURFACE, t)
    const planetPose = graph.pose(PLANET, t)
    expect(UV.distance(surfacePose.position, planetPose.position)).toBeCloseTo(EARTH_RADIUS, 3)
    // ...and at ~1 AU from the star, wherever it is in its orbit.
    expect(UV.distance(planetPose.position, SYSTEM_POSITION) / AU).toBeCloseTo(1, 9)
  })

  it('gives a stationary surface point orbital plus rotational velocity', () => {
    const t = 0
    const standing = { frame: SURFACE, position: V.ZERO, orientation: Q.IDENTITY, velocity: V.ZERO, angularVelocity: V.ZERO }
    const v = canonicalVelocity(graph, standing, t)
    const orbital = (2 * Math.PI * AU) / SECONDS_PER_YEAR
    const spin = (2 * Math.PI * EARTH_RADIUS) / SECONDS_PER_DAY
    // Standing still on the equator is ~29.8 km/s of orbit plus ~465 m/s of spin.
    expect(orbital).toBeCloseTo(29_785, -1)
    expect(spin).toBeCloseTo(463.8, 0)
    expect(V.length(v)).toBeGreaterThan(orbital - spin - 1)
    expect(V.length(v)).toBeLessThan(orbital + spin + 1)
  })

  it('preserves canonical position through a frame transition', () => {
    const t = 987_654.321
    // A ship 500 km above the landing site, moving at 120 m/s relative to it.
    const inSurface = {
      frame: SURFACE,
      position: vec3(0, 500_000, 0),
      orientation: Q.fromAxisAngle(vec3(0, 0, 1), 0.4),
      velocity: vec3(120, 0, 0),
      angularVelocity: vec3(0, 0.01, 0),
    }
    const canonicalBefore = canonicalPosition(graph, inSurface, t)
    const velocityBefore = canonicalVelocity(graph, inSurface, t)

    const inSystem = reframe(graph, inSurface, SYSTEM, t)
    expect(inSystem.frame).toBe(SYSTEM)
    // The numbers it carries change completely...
    expect(V.length(inSystem.position)).toBeGreaterThan(AU * 0.9)
    // ...but where it actually is does not.
    expect(UV.distance(canonicalPosition(graph, inSystem, t), canonicalBefore)).toBeLessThan(1e-3)
    expect(V.distance(canonicalVelocity(graph, inSystem, t), velocityBefore)).toBeLessThan(1e-6)
  })

  it('round-trips any state through any frame in the same system (property)', () => {
    // Deliberately excludes ROOT: see the degradation test below for why a
    // frame-local Vec3 is only meaningful near its own frame.
    const frames = [SYSTEM, PLANET, SURFACE] as const
    fc.assert(
      fc.property(
        fc.constantFrom(...frames),
        fc.constantFrom(...frames),
        fc.double({ min: 0, max: 1e8, noNaN: true }),
        fc.double({ min: -1e7, max: 1e7, noNaN: true }),
        (from, to, t, coord) => {
          const state = {
            frame: from,
            position: vec3(coord, coord * 0.5, -coord),
            orientation: Q.fromAxisAngle(vec3(1, 2, 3), 0.7),
            velocity: vec3(10, -20, 30),
            angularVelocity: vec3(0.001, 0, -0.002),
          }
          const there = reframe(graph, state, to, t)
          const back = reframe(graph, there, from, t)
          expect(V.distance(back.position, state.position)).toBeLessThan(1e-3)
          expect(V.distance(back.velocity, state.velocity)).toBeLessThan(1e-4)
          expect(Q.approxEquals(back.orientation, state.orientation, 1e-9)).toBe(true)
          expect(V.distance(back.angularVelocity, state.angularVelocity)).toBeLessThan(1e-9)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('keeps inch-scale local coordinates 4 light-years from the origin', () => {
    const t = 5_000
    const pose = graph.pose(SURFACE, t)
    // A bolt an inch from the landing site's origin, on a planet 4.2 ly away.
    const bolt = localToUniverse(pose, vec3(0.0254, 0, 0))
    const recovered = universeToLocal(pose, bolt)
    // Bounded by the representation's quarter-millimetre, not by the 8 m ULP a
    // double has at 4 light-years: the subtraction happens in universe space.
    expect(Math.abs(recovered.x - 0.0254)).toBeLessThan(UV.POSITION_RESOLUTION * 2)
    expect(Math.abs(UV.distance(bolt, pose.position) - 0.0254)).toBeLessThan(
      UV.POSITION_RESOLUTION * 2,
    )
  })

  it('degrades predictably when a position is expressed in a far-away frame', () => {
    // The invariant this pins down: local coordinates are exact near their own
    // frame and lossy far from it, because a Vec3 is a double. That is *why*
    // canonical state is a UniverseVector and why an approaching ship is
    // re-framed into the system it is entering rather than left in the root
    // frame. If this ever stops being true, some caller has started treating a
    // frame-local vector as canonical.
    const t = 1_000
    const nearRoot = {
      frame: ROOT_FRAME,
      position: vec3(1e7, 0, 0),
      orientation: Q.IDENTITY,
      velocity: V.ZERO,
      angularVelocity: V.ZERO,
    }
    const inFarFrame = reframe(graph, nearRoot, SURFACE, t)
    // 4.2 ly away, so the local vector is ~4e16 m and a double's ULP there is metres.
    expect(V.length(inFarFrame.position)).toBeGreaterThan(3e16)
    const back = reframe(graph, inFarFrame, ROOT_FRAME, t)
    const error = V.distance(back.position, nearRoot.position)
    expect(error).toBeGreaterThan(UV.POSITION_RESOLUTION)
    expect(error).toBeLessThan(64)

    // Canonical position, by contrast, is preserved to the representation limit.
    expect(
      UV.distance(canonicalPosition(graph, inFarFrame, t), canonicalPosition(graph, nearRoot, t)),
    ).toBeLessThan(64)
  })

  it('caches poses per instant and re-resolves when time moves', () => {
    let calls = 0
    const counted = frameId('counted')
    graph.define({
      id: counted,
      parent: SYSTEM,
      kind: 'orbit',
      anchor: {
        kind: 'dynamic',
        evaluate: (t) => {
          calls += 1
          return circularOrbit(AU, SECONDS_PER_YEAR)(t)
        },
      },
    })
    graph.pose(counted, 10)
    graph.pose(counted, 10)
    expect(calls).toBe(1)
    graph.pose(counted, 11)
    expect(calls).toBe(2)
  })
})
