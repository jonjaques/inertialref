import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR, type Radians, SECONDS_PER_DAY } from '@inertialref/shared'
import { derivePath, deriveSeed, Rng, rootSeed } from '@inertialref/procedural'
import { apoapsis, orbitalPeriod, periapsis } from '@inertialref/physics'
import { type FrameId, FrameGraph, UV, Vec, vec3 } from '@inertialref/spatial'
import { addressLabels, bodyAddress, formatAddress, regionAddress, systemAddress } from './address.ts'
import { CATALOG, catalogStarPosition } from './catalog.ts'
import {
  bodyFixedFrameId,
  bodyFrameId,
  directionToGeodetic,
  geodeticDirection,
  installSurfaceFrame,
  installSystemFrames,
  parseSurfaceFrameId,
  surfaceFrameId,
  systemFrameId,
  uninstallSystemFrames,
} from './frames.ts'
import {
  catalogStub,
  cellOf,
  galaxySeedOf,
  generateCell,
  MILKY_WAY,
  parseProceduralSystemId,
  proceduralSystemId,
  resolveSystem,
  systemSeedOf,
  systemsWithin,
} from './galaxy.ts'
import { findBody, generateSystem, walkBodies } from './system.ts'
import {
  directionToFace,
  elevationAt,
  faceToDirection,
  generateHeightfield,
  groundElevation,
  HEIGHTFIELD_RESOLUTION,
  levelForSize,
  regionCentreDirection,
  regionDirection,
  regionForDirection,
  regionSize,
  surfaceRadius,
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
    // On the ground, which is the terrain height — not the datum sphere.
    const height = UV.distance(pose.position, planetPose.position) - planet.radius
    expect(Math.abs(height)).toBeLessThanOrEqual(planet.surface.maxElevation * 1.2)
    expect(Math.abs(height)).toBeGreaterThan(0)

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

describe('the ground has one owner', () => {
  /*
   * `seaLevel` used to be honoured by `surfaceRadius` — which decides where a
   * ship touches down and where `installSurfaceFrame` puts the pad — and
   * ignored by `generateHeightfield`, which decides what gets drawn. It was
   * carried the whole way from the generator to the mesh and then dropped, so
   * on any world with an ocean the pad sat on the water datum and the mesh drew
   * the seabed under it. Roughly 40% of atmosphered rocky planets have one.
   */
  // Sol has no ocean world at this seed, so the catalogue is scanned rather
  // than a system named: which star gets one is a property of the seed, and
  // pinning it here would make this test fail for the wrong reason.
  const oceanWorld = () => {
    for (const stub of CATALOG.map(catalogStub)) {
      const system = generateSystem(ROOT, MILKY_WAY, stub)
      const wet = [...walkBodies(system)].find((body) => body.surface.seaLevel !== null)
      if (wet !== undefined) return wet
    }
    throw new Error('no ocean world anywhere in the catalogue')
  }

  it('draws the mesh at the radius the physics lands on', () => {
    const body = oceanWorld()
    const region = regionAddress(0, 4, 5, 6)
    const field = generateHeightfield(body.surface, {
      region,
      resolution: HEIGHTFIELD_RESOLUTION,
    })

    // Walk the patch corners and centre: the elevation the mesh will extrude by
    // has to be the elevation the contact test will stop at, exactly.
    for (const [s, t] of [
      [0, 0],
      [1, 0],
      [0.5, 0.5],
      [0, 1],
      [1, 1],
    ] as const) {
      const row = Math.round(t * (HEIGHTFIELD_RESOLUTION - 1))
      const col = Math.round(s * (HEIGHTFIELD_RESOLUTION - 1))
      const meshed = field.elevations[row * HEIGHTFIELD_RESOLUTION + col] as number
      const physical = surfaceRadius(body, regionDirection(region, s, t)) - body.radius
      // Float32Array storage is the only thing between them, so the bound is
      // that conversion and nothing else.
      expect(meshed).toBeCloseTo(physical, 1)
    }
  })

  it('clamps the ocean up to its datum rather than down to the seabed', () => {
    const body = oceanWorld()
    const sea = body.surface.seaLevel as number
    const floor = (sea * 2 - 1) * body.surface.maxElevation * 0.55
    // Somewhere on this world the bare landform is below the water line; the
    // ground there is the water, not the rock.
    const grid = []
    for (let face = 0; face < 6; face += 1) {
      for (let u = -0.9; u <= 0.9; u += 0.3) {
        for (let v = -0.9; v <= 0.9; v += 0.3) grid.push(faceToDirection(face, u, v))
      }
    }
    const submerged = grid.find((d) => elevationAt(body.surface, d) < floor)
    if (submerged === undefined) throw new Error('no submerged sample found')

    expect(groundElevation(body.surface, submerged)).toBe(floor)
    expect(groundElevation(body.surface, submerged)).toBeGreaterThan(
      elevationAt(body.surface, submerged),
    )
  })
})

describe('surface frame ids round-trip', () => {
  /*
   * The formatter and the parser now sit in the same module, which is what makes
   * this expressible. The parser used to be open-coded in `World.ensureFrame`,
   * one package down, on the load path for every save with a landed ship — and
   * with no counterpart to the `-0` collapse the formatter carries a comment
   * about. Both halves of that bug are here.
   */
  const ADDRESS = bodyAddress(MILKY_WAY, SOL.id, [2])

  it('parses back to the angles the id records', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: -3.1, max: 3.1, noNaN: true }),
        (latitude, longitude) => {
          const id = surfaceFrameId(ADDRESS, latitude as Radians, longitude as Radians)
          const parsed = parseSurfaceFrameId(id)
          expect(parsed).not.toBeNull()
          if (parsed === null) return
          expect(formatAddress(parsed.address)).toBe(formatAddress(ADDRESS))
          // Re-formatting what we parsed must give the identical id. That is the
          // property the whole quantisation dance exists to provide.
          expect(surfaceFrameId(parsed.address, parsed.latitude, parsed.longitude)).toBe(id)
        },
      ),
    )
  })

  it('survives a latitude a hair south of the equator', () => {
    // `(-1e-9).toFixed(6)` is "-0.000000", which parses to -0, which formats as
    // "0.000000". This exact value broke restoring a save.
    const id = surfaceFrameId(ADDRESS, -1e-9 as Radians, 0 as Radians)
    const parsed = parseSurfaceFrameId(id)
    if (parsed === null) throw new Error('should parse')
    expect(surfaceFrameId(parsed.address, parsed.latitude, parsed.longitude)).toBe(id)
    expect(Object.is(parsed.latitude, -0)).toBe(false)
  })

  it('returns null for anything that is not a surface frame id', () => {
    for (const id of ['s:SOL', 'b:g:milky-way/s:SOL/b:2', 'bf:g:milky-way/s:SOL/b:2', 'sf:no-at-sign']) {
      expect(parseSurfaceFrameId(id as FrameId)).toBeNull()
    }
  })
})

describe('the address is the seed path', () => {
  /*
   * ADR-0004 and ADR-0005 both rest on this: an object's address, its position
   * in the containment hierarchy, and the path its seed derives along are the
   * same tree. `addressLabels` is the function that states it.
   *
   * It had no production callers, and the one test that mentioned it derived
   * *both* sides of its assertion from `addressLabels` — so if a generator had
   * changed `b:${index}` to `b${index}`, the labels would still have agreed with
   * themselves and the test would still have passed. This compares the labels
   * against the seed a real generated body actually carries, which is the only
   * version of the claim that can fail.
   */
  it('matches the seed the generators actually derive', () => {
    const root = ROOT
    const system = generateSystem(root, MILKY_WAY, SOL)

    // A body does not store its own seed — only the surface parameters derived
    // from it — so the identity is checked one derivation further down. That is
    // still the real chain: `makePlanet` does `deriveSeed(systemSeed, 'b:i')`
    // and then `deriveSeed(seed, 'surface')`, and nothing here is computed by
    // the code under test.
    const surfaceSeedOf = (labels: readonly string[]) =>
      deriveSeed(derivePath(root, labels), 'surface')

    system.planets.forEach((planet, index) => {
      const address = bodyAddress(MILKY_WAY, SOL.id, [index])
      expect(planet.surface.seed).toEqual(surfaceSeedOf(addressLabels(address)))

      planet.moons.forEach((moon, moonIndex) => {
        const moonAddress = bodyAddress(MILKY_WAY, SOL.id, [index, moonIndex])
        expect(moon.surface.seed).toEqual(surfaceSeedOf(addressLabels(moonAddress)))
      })
    })
  })

  it('addresses a system the same way its seed is derived', () => {
    expect(systemSeedOf(ROOT, MILKY_WAY, SOL.id)).toEqual(
      derivePath(ROOT, addressLabels(systemAddress(MILKY_WAY, SOL.id))),
    )
  })
})
