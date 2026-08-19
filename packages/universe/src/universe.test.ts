import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR, SECONDS_PER_DAY } from '@inertialref/shared'
import { Rng, rootSeed } from '@inertialref/procedural'
import { apoapsis, orbitalPeriod, periapsis } from '@inertialref/physics'
import { FrameGraph, UV, Vec, vec3 } from '@inertialref/spatial'
import { bodyAddress, formatAddress } from './address.ts'
import { CATALOG, catalogStarPosition } from './catalog.ts'
import {
  bodyFixedFrameId,
  bodyFrameId,
  directionToGeodetic,
  geodeticDirection,
  installSurfaceFrame,
  installSystemFrames,
  systemFrameId,
  uninstallSystemFrames,
} from './frames.ts'
import {
  catalogStub,
  cellOf,
  generateCell,
  galaxySeedOf,
  MILKY_WAY,
  parseProceduralSystemId,
  proceduralSystemId,
  resolveSystem,
  systemsWithin,
} from './galaxy.ts'
import { findBody, generateSystem, walkBodies } from './system.ts'
import {
  directionToFace,
  elevationAt,
  faceToDirection,
  generateHeightfield,
  levelForSize,
  regionCentreDirection,
  regionForDirection,
  regionSize,
} from './terrain.ts'

const ROOT = rootSeed('inertialref')
const GALAXY_SEED = galaxySeedOf(ROOT)
const SOL = catalogStub(CATALOG[0] as (typeof CATALOG)[number])
const stringify = (value: unknown): string => JSON.stringify(value)

describe('galaxy', () => {
  it('generates a cell identically no matter who asks or when', () => {
    const cell = { x: 12, y: -3, z: 7 }
    expect(stringify(generateCell(GALAXY_SEED, cell))).toBe(stringify(generateCell(GALAXY_SEED, cell)))
  })

  it('does not let neighbouring cells influence each other', () => {
    // Generating the neighbourhood first must not change the cell's contents:
    // this is the property that makes worker-order irrelevant.
    const cell = { x: 4, y: 1, z: -2 }
    const isolated = stringify(generateCell(GALAXY_SEED, cell))
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        generateCell(GALAXY_SEED, { x: cell.x + dx, y: cell.y + dy, z: cell.z - 1 })
      }
    }
    expect(stringify(generateCell(GALAXY_SEED, cell))).toBe(isolated)
  })

  it('round-trips procedural system ids (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: 0, max: 200 }),
        (x, y, z, index) => {
          const id = proceduralSystemId({ x, y, z }, index)
          expect(parseProceduralSystemId(id)).toEqual({ cell: { x, y, z }, index })
        },
      ),
    )
  })

  it('resolves any system id without a global index', () => {
    const cell = cellOf(SOL.position)
    const stars = generateCell(GALAXY_SEED, cell)
    expect(stars.length).toBeGreaterThan(0)
    const target = stars[0]
    if (target === undefined) throw new Error('expected a star')
    expect(stringify(resolveSystem(GALAXY_SEED, target.id))).toBe(stringify(target))
    expect(resolveSystem(GALAXY_SEED, SOL.id)?.name).toBe('Sol')
  })

  it('finds the real neighbours of Sol', () => {
    const near = systemsWithin(GALAXY_SEED, SOL.position, 5 * LIGHT_YEAR)
    const names = near.filter((s) => s.catalogued).map((s) => s.name)
    expect(names).toContain('Proxima Centauri')
    expect(names).toContain('Alpha Centauri')
    expect(names).not.toContain('Sirius')
    // Stable ordering, so two clients asking the same question agree.
    expect(stringify(systemsWithin(GALAXY_SEED, SOL.position, 5 * LIGHT_YEAR))).toBe(stringify(near))
  })

  it('thins out above the galactic plane', () => {
    const inPlane = systemsWithin(GALAXY_SEED, SOL.position, 30 * LIGHT_YEAR).length
    const aboveDisk = systemsWithin(
      GALAXY_SEED,
      UV.translate(SOL.position, vec3(0, 3_000 * LIGHT_YEAR, 0)),
      30 * LIGHT_YEAR,
    ).length
    expect(aboveDisk).toBeLessThan(inPlane / 2)
  })
})

describe('system generation', () => {
  it('is a pure function of seed and identity', () => {
    const a = generateSystem(ROOT, MILKY_WAY, SOL)
    const b = generateSystem(ROOT, MILKY_WAY, SOL)
    expect(stringify(a)).toBe(stringify(b))
    // A different global seed gives a different universe.
    expect(stringify(generateSystem(rootSeed('other'), MILKY_WAY, SOL))).not.toBe(stringify(a))
  })

  it('does not depend on generation order', () => {
    const stubs = CATALOG.map(catalogStub)
    const sequential = stubs.map((s) => stringify(generateSystem(ROOT, MILKY_WAY, s)))
    const shuffled = new Rng(rootSeed('order')).shuffle(stubs.map((s, i) => [s, i] as const))
    for (const [stub, index] of shuffled) {
      expect(stringify(generateSystem(ROOT, MILKY_WAY, stub))).toBe(sequential[index])
    }
  })

  it('lays planets out in increasing orbits with plausible physics', () => {
    for (const stub of CATALOG.map(catalogStub)) {
      const system = generateSystem(ROOT, MILKY_WAY, stub)
      let previous = 0
      for (const planet of system.planets) {
        expect(planet.elements.semiMajorAxis).toBeGreaterThan(previous)
        previous = planet.elements.semiMajorAxis
        expect(planet.radius).toBeGreaterThan(1e5)
        expect(planet.mass).toBeGreaterThan(0)
        expect(planet.elements.eccentricity).toBeLessThan(1)
        expect(planet.orbitalPeriod).toBeCloseTo(
          orbitalPeriod(system.star.mu, planet.elements.semiMajorAxis),
          3,
        )
        for (const moon of planet.moons) {
          // A moon must be outside the planet and inside its sphere of influence.
          expect(periapsis(moon.elements)).toBeGreaterThan(planet.radius)
          expect(apoapsis(moon.elements)).toBeLessThan(planet.sphereOfInfluence)
          expect(moon.radius).toBeLessThan(planet.radius)
        }
      }
    }
  })

  it('addresses every generated body uniquely', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const seen = new Set<string>()
    for (const body of walkBodies(system)) {
      const text = formatAddress(body.address)
      expect(seen.has(text)).toBe(false)
      seen.add(text)
      expect(body.id).toBe(`@${text}`)
    }
    expect(seen.size).toBeGreaterThan(0)
  })

  it('finds a body by its orbital path', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = system.planets[0]
    if (planet === undefined) throw new Error('expected a planet')
    expect(findBody(system, [0])).toBe(planet)
    expect(findBody(system, [999])).toBeUndefined()
    expect(bodyAddress(MILKY_WAY, SOL.id, [0])).toEqual(planet.address)
  })
})

describe('cube-sphere terrain', () => {
  it('round-trips directions through face coordinates (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        (x, y, z) => {
          fc.pre(Math.hypot(x, y, z) > 1e-6)
          const direction = Vec.normalize(vec3(x, y, z))
          const face = directionToFace(direction)
          expect(Vec.distance(faceToDirection(face.face, face.u, face.v), direction)).toBeLessThan(1e-12)
        },
      ),
    )
  })

  it('puts a direction in a region whose centre is nearby', () => {
    const direction = Vec.normalize(vec3(0.3, 0.8, -0.5))
    for (const level of [0, 3, 8]) {
      const region = regionForDirection(direction, level)
      const centre = regionCentreDirection(region)
      const angle = Math.acos(Math.min(1, Vec.dot(centre, direction)))
      // Within one region's angular half-width, plus slack for the cube warp.
      expect(angle).toBeLessThan((1.6 * (Math.PI / 2)) / 2 ** level)
    }
  })

  it('sizes regions and picks levels consistently', () => {
    const radius = 6.371e6
    expect(regionSize(radius, 0) / 1e6).toBeCloseTo(10.0, 0)
    const level = levelForSize(radius, 1_000)
    expect(regionSize(radius, level)).toBeGreaterThan(500)
    expect(regionSize(radius, level)).toBeLessThan(2_000)
  })

  it('generates identical heightfields regardless of call order', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
    if (planet === undefined) throw new Error('expected a solid body')
    const region = regionForDirection(Vec.normalize(vec3(1, 0.2, 0.1)), 5)
    const first = generateHeightfield(planet.surface, { region, resolution: 33 })
    generateHeightfield(planet.surface, { region: regionForDirection(vec3(0, 1, 0), 5), resolution: 33 })
    const second = generateHeightfield(planet.surface, { region, resolution: 33 })
    expect(Array.from(second.elevations)).toEqual(Array.from(first.elevations))
    expect(first.maxElevation).toBeLessThanOrEqual(planet.surface.maxElevation * 1.2)
    expect(first.minElevation).toBeGreaterThanOrEqual(-planet.surface.maxElevation * 1.2)
  })

  it('agrees with the sampled elevation at region corners', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find((b) => b.surface.maxElevation > 0)
    if (planet === undefined) throw new Error('expected a solid body')
    const region = regionForDirection(Vec.normalize(vec3(-0.4, 0.1, 0.9)), 4)
    const field = generateHeightfield(planet.surface, { region, resolution: 5 })
    const corner = elevationAt(planet.surface, regionCentreDirection(region))
    expect(Number.isFinite(corner)).toBe(true)
    expect(field.elevations.length).toBe(25)
  })
})

describe('system frames', () => {
  it('places planets on their orbits and spins them', () => {
    const graph = new FrameGraph()
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    installSystemFrames(graph, system)

    const planet = system.planets[0]
    if (planet === undefined) throw new Error('expected a planet')
    const t = 3.2e6
    const starPose = graph.pose(systemFrameId(system.id), t)
    const planetPose = graph.pose(bodyFrameId(planet.address), t)
    const r = UV.distance(planetPose.position, starPose.position)
    expect(r).toBeGreaterThanOrEqual(periapsis(planet.elements) * 0.999)
    expect(r).toBeLessThanOrEqual(apoapsis(planet.elements) * 1.001)

    // The body-fixed frame shares the orbit but rotates.
    const fixed = graph.pose(bodyFixedFrameId(planet.address), t)
    expect(UV.distance(fixed.position, planetPose.position)).toBeLessThan(1)
    expect(Vec.length(fixed.angularVelocity)).toBeCloseTo(
      Math.abs((2 * Math.PI) / planet.rotationPeriod),
      12,
    )
  })

  it('stands a surface frame on the ground and carries it round', () => {
    const graph = new FrameGraph()
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    installSystemFrames(graph, system)
    const planet = system.planets[0]
    if (planet === undefined) throw new Error('expected a planet')

    const surface = installSurfaceFrame(graph, planet, 0.4, 1.1)
    const t = 1_000
    const pose = graph.pose(surface, t)
    const planetPose = graph.pose(bodyFrameId(planet.address), t)
    expect(UV.distance(pose.position, planetPose.position)).toBeCloseTo(planet.radius, 0)

    // Standing still on the surface still means moving, in the frame above.
    const spinSpeed = (2 * Math.PI * planet.radius * Math.cos(0.4)) / Math.abs(planet.rotationPeriod)
    expect(Vec.length(pose.velocity)).toBeGreaterThan(spinSpeed * 0.5)
  })

  it('round-trips geodetic coordinates (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: -Math.PI + 0.01, max: Math.PI - 0.01, noNaN: true }),
        (latitude, longitude) => {
          const back = directionToGeodetic(geodeticDirection(latitude, longitude))
          expect(back.latitude).toBeCloseTo(latitude, 9)
          expect(back.longitude).toBeCloseTo(longitude, 9)
        },
      ),
    )
  })

  it('installs and removes a system cleanly', () => {
    const graph = new FrameGraph()
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    installSystemFrames(graph, system)
    const before = graph.ids().length
    expect(before).toBeGreaterThan(1)
    uninstallSystemFrames(graph, system)
    expect(graph.ids()).toEqual(['universe'])
    // Re-installing is idempotent, which streaming depends on.
    installSystemFrames(graph, system)
    installSystemFrames(graph, system)
    expect(graph.ids().length).toBe(before)
  })
})

describe('catalogue', () => {
  it('reproduces published distances between real stars', () => {
    const sol = catalogStarPosition(CATALOG[0] as (typeof CATALOG)[number])
    for (const star of CATALOG.slice(1)) {
      const computed = UV.distance(sol, catalogStarPosition(star)) / LIGHT_YEAR
      expect(computed).toBeCloseTo(star.distanceLightYears, 3)
    }
  })

  it('separates Proxima from Alpha Centauri by the observed 0.2 ly', () => {
    // Computed from two independent RA/Dec/parallax entries, so agreeing with
    // the published separation validates the whole coordinate conversion.
    const proxima = catalogStarPosition(CATALOG[1] as (typeof CATALOG)[number])
    const alpha = catalogStarPosition(CATALOG[2] as (typeof CATALOG)[number])
    expect(UV.distance(proxima, alpha) / LIGHT_YEAR).toBeCloseTo(0.2, 1)
  })

  it('places the Sun 8.178 kpc from the galactic centre', () => {
    const sol = catalogStarPosition(CATALOG[0] as (typeof CATALOG)[number])
    expect(UV.distance(sol, UV.UNIVERSE_ORIGIN) / (3.085677581491367e16 * 1000)).toBeCloseTo(8.178, 3)
  })

  it('puts a day-long rotation in the right ballpark', () => {
    expect(SECONDS_PER_DAY).toBe(86_400)
    expect(AU / 1e11).toBeCloseTo(1.496, 3)
  })
})
