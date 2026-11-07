import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { GRAVITATIONAL_CONSTANT, SECONDS_PER_DAY } from '@inertialref/shared'
import { derivePath, Rng, rootSeed } from '@inertialref/procedural'
import { orbitalPeriod } from '@inertialref/physics'
import {
  FrameGraph,
  Quaternion as Q,
  UV,
  Vec,
  type Vec3,
  vec3,
} from '@inertialref/spatial'
import {
  addressLabels,
  bodyAddress,
  formatAddress,
  satelliteOf,
  systemAddress,
  systemId,
} from './address.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import {
  bodyFrameId,
  installSystemFrames,
  parseStationFrameId,
  stationFixedFrameId,
  stationFrameId,
  uninstallSystemFrames,
} from './frames.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import { ISS, SOLAR_STATIONS } from './solar/stations.ts'
import { orbitalAsset } from './stations.ts'
import { findBody, generateSystem } from './system.ts'

const ROOT = rootSeed('inertialref')
const SOL = catalogStub(TEST_CATALOG.stars[0]!)
const sol = generateSystem(ROOT, MILKY_WAY, SOL)
const earth = findBody(sol, [2])!
const iss = sol.stations[0]!

/** The pose of each frame at `t`, and the station relative to Earth. */
function sample(graph: FrameGraph, t: number) {
  const origin = graph.pose(stationFrameId(iss.id), t)
  const fixed = graph.pose(stationFixedFrameId(iss.id), t)
  const planet = graph.pose(bodyFrameId(earth.address), t)
  return {
    origin,
    fixed,
    radial: UV.difference(origin.position, planet.position),
    relative: Vec.sub(origin.velocity, planet.velocity),
  }
}

const axis = (q: Parameters<typeof Q.rotate>[0], v: Vec3): Vec3 =>
  Q.rotate(q, v)

describe('the station record', () => {
  it('holds the ISS to its element set and to NASA’s mass', () => {
    // CelesTrak GP for NORAD 25544, epoch 2026-11-06 11:57:30 UTC.
    expect(ISS.meanMotion).toBe(15.49214228)
    expect(ISS.eccentricity).toBe(0.0007225)
    expect((ISS.inclination * 180) / Math.PI).toBeCloseTo(51.6322, 10)
    expect((ISS.argumentOfPeriapsis * 180) / Math.PI).toBeCloseTo(355.0594, 10)
    expect(ISS.designations).toEqual(['ISS', '1998-067A', '25544'])
    expect(ISS.mass).toBe(419_725)
    expect(iss.name).toBe('International Space Station')
    expect(iss.provenance).toBe('observed')
    expect(iss.attitude.kind).toBe('nadir')
    expect(iss.radius).toBe(orbitalAsset('iss')!.radius)
  })

  it('derives the semi-major axis whose period is one over the mean motion', () => {
    const mu = GRAVITATIONAL_CONSTANT * (earth.mass + iss.mass)
    const { semiMajorAxis: a, eccentricity: e } = iss.orbit.elements
    // 1440 / mean motion minutes: the derivation's round trip, which is the
    // element set's number rather than the real station's measured period.
    expect(orbitalPeriod(mu, a) / 60).toBeCloseTo(
      SECONDS_PER_DAY / 60 / 15.49214228,
      9,
    )
    // Kepler's third law against the game's Earth: 6,797.2 km, which puts
    // perigee 414.1 km and apogee 423.9 km over the equatorial radius.
    expect(a / 1_000).toBeCloseTo(6_797.16, 2)
    expect((a * (1 - e) - earth.radius) / 1_000).toBeCloseTo(414.11, 2)
    expect((a * (1 + e) - earth.radius) / 1_000).toBeCloseTo(423.93, 2)
  })

  it('is Earth’s first, addressed under it and identified by the address', () => {
    expect(formatAddress(iss.address!)).toBe('g:milky-way/s:SOL/b:2/a:0')
    expect(iss.id).toBe('@g:milky-way/s:SOL/b:2/a:0')
    expect(formatAddress(iss.parent)).toBe('g:milky-way/s:SOL/b:2')
    expect(sol.stations.length).toBe(SOLAR_STATIONS.length)
  })

  it('draws the node and the anomaly from the address below the system', () => {
    // The system seed with one label per address segment below it, and two
    // draws in order — the same chain every generator follows.
    const rng = new Rng(
      derivePath(sol.seed, addressLabels(iss.address!).slice(2)),
    )
    expect(iss.orbit.elements.longitudeOfAscendingNode).toBe(
      rng.range(0, 2 * Math.PI),
    )
    expect(iss.orbit.elements.meanAnomalyAtEpoch).toBe(
      rng.range(0, 2 * Math.PI),
    )
    expect(derivePath(sol.seed, ['b:2', 'a:0'])).toEqual(
      derivePath(ROOT, addressLabels(iss.address!)),
    )
  })

  it('puts no station round a generated star', () => {
    // Proxima Centauri, which every verification visits.
    const proxima = TEST_CATALOG.stars.find((star) =>
      star.designations.some((one) => one.text === 'Proxima Centauri'),
    )
    expect(proxima).toBeDefined()
    const system = generateSystem(ROOT, MILKY_WAY, catalogStub(proxima!))
    expect(system.stations).toEqual([])
  })
})

describe('station frames', () => {
  const graph = new FrameGraph()
  installSystemFrames(graph, sol)
  const period = orbitalPeriod(
    GRAVITATIONAL_CONSTANT * (earth.mass + iss.mass),
    iss.orbit.elements.semiMajorAxis,
  )
  const anyTime = fc.double({ min: 0, max: 3e7, noNaN: true })

  it('hangs the origin frame off Earth and the station axes off it', () => {
    expect(graph.get(stationFrameId(iss.id)).parent).toBe(
      bodyFrameId(earth.address),
    )
    expect(graph.get(stationFixedFrameId(iss.id)).parent).toBe(
      stationFrameId(iss.id),
    )
  })

  it('keeps its keel on Earth, its nose on the orbit and its truss across it (property)', () => {
    fc.assert(
      fc.property(anyTime, (t) => {
        const { fixed, radial, relative } = sample(graph, t)
        const up = axis(fixed.orientation, vec3(0, 1, 0))
        const right = axis(fixed.orientation, vec3(1, 0, 0))
        const forward = axis(fixed.orientation, vec3(0, 0, -1))
        // An orthonormal, right-handed basis.
        expect(
          Vec.dot(Vec.cross(right, up), axis(fixed.orientation, vec3(0, 0, 1))),
        ).toBeCloseTo(1, 12)
        // Zenith away from Earth's center.
        expect(Vec.dot(up, Vec.normalize(radial))).toBeCloseTo(1, 12)
        // Starboard against the orbit normal.
        const normal = Vec.normalize(Vec.cross(radial, relative))
        expect(Vec.dot(right, normal)).toBeCloseTo(-1, 12)
        // Forward along the motion, off it by the flight-path angle — under
        // the eccentricity in radians.
        expect(Vec.dot(forward, Vec.normalize(relative))).toBeGreaterThan(
          Math.cos(iss.orbit.elements.eccentricity * 1.01),
        )
      }),
    )
  })

  it('turns at the orbital rate, once a period (property)', () => {
    const e = iss.orbit.elements.eccentricity
    const mean = (2 * Math.PI) / period
    fc.assert(
      fc.property(anyTime, (t) => {
        const { fixed } = sample(graph, t)
        // h / r² swings about the mean motion by twice the eccentricity.
        const rate = Vec.length(fixed.angularVelocity)
        expect(rate).toBeGreaterThan(mean * (1 - 2.1 * e))
        expect(rate).toBeLessThan(mean * (1 + 2.1 * e))
        // And the axes actually turn that fast: a second apart, the angle
        // between the two orientations is the rate times the second.
        const later = sample(graph, t + 1).fixed
        const turned =
          2 *
          Math.acos(
            Math.min(
              1,
              Math.abs(
                Q.multiply(Q.conjugate(fixed.orientation), later.orientation).w,
              ),
            ),
          )
        expect(turned).toBeCloseTo(rate, 7)
      }),
    )
  })

  it('comes back to the same place and attitude one published period on (property)', () => {
    fc.assert(
      fc.property(anyTime, (t) => {
        const now = sample(graph, t)
        const next = sample(graph, t + period)
        // Earth has moved on; the station's place relative to it has not.
        expect(Vec.length(Vec.sub(next.radial, now.radial))).toBeLessThan(1e-3)
        const up = axis(now.fixed.orientation, vec3(0, 1, 0))
        const upNext = axis(next.fixed.orientation, vec3(0, 1, 0))
        expect(Vec.dot(up, upNext)).toBeCloseTo(1, 12)
      }),
    )
  })

  it('names its frames by its identity and reads them back (property)', () => {
    const satellites = fc
      .tuple(
        fc.array(fc.integer({ min: 0, max: 4095 }), { maxLength: 2 }),
        fc.integer({ min: 0, max: 4095 }),
      )
      .map(([path, index]) =>
        satelliteOf(
          path.length === 0
            ? systemAddress(MILKY_WAY, systemId('HIP71683'))
            : bodyAddress(MILKY_WAY, systemId('HIP71683'), path),
          index,
        ),
      )
    fc.assert(
      fc.property(satellites, (address) => {
        const id = `@${formatAddress(address)}` as typeof iss.id
        for (const [frame, fixed] of [
          [stationFrameId(id), false],
          [stationFixedFrameId(id), true],
        ] as const) {
          const parsed = parseStationFrameId(frame)
          expect(parsed?.station).toBe(id)
          expect(parsed?.fixed).toBe(fixed)
          expect(formatAddress(parsed!.address)).toBe(formatAddress(address))
        }
      }),
    )
    // Any other frame, and any other spelling, is not a station's.
    expect(parseStationFrameId(bodyFrameId(earth.address))).toBeNull()
    expect(
      parseStationFrameId(stationFrameId('#7' as typeof iss.id)),
    ).toBeNull()
    expect(
      parseStationFrameId(
        stationFrameId('@g:milky-way/s:SOL/b:2' as typeof iss.id),
      ),
    ).toBeNull()
  })

  it('comes out before its parent when the system leaves', () => {
    const fresh = new FrameGraph()
    installSystemFrames(fresh, sol)
    expect(fresh.has(stationFixedFrameId(iss.id))).toBe(true)
    uninstallSystemFrames(fresh, sol)
    expect(fresh.ids()).toEqual(['universe'])
  })
})
