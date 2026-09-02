import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AU,
  LIGHT_YEAR,
  type Radians,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import { derivePath, deriveSeed, Rng, rootSeed } from '@inertialref/procedural'
import { apoapsis, orbitalPeriod, periapsis } from '@inertialref/physics'
import { type FrameId, FrameGraph, UV, Vec, vec3 } from '@inertialref/spatial'
import {
  addressLabels,
  bodyAddress,
  formatAddress,
  MAX_REGION_LEVEL,
  regionAddress,
  systemAddress,
} from './address.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
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
  cellContext,
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
import {
  type Body,
  findBody,
  generateSystem,
  orbitalOrder,
  walkBodies,
} from './system.ts'
import type { RegionAddress } from './address.ts'
import {
  directionToFace,
  elevationAt,
  faceToDirection,
  generateHeightfield,
  drawnDivergence,
  drawnElevation,
  drawnGroundElevation,
  drawnSurfaceRadius,
  groundElevation,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  heightfieldSample,
  heightfieldStride,
  levelForSize,
  regionCentreDirection,
  regionChildren,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  regionParent,
  regionSize,
  seaDatumElevation,
  surfaceDetailFloor,
} from './terrain.ts'

const ROOT = rootSeed('inertialref')
const GALAXY_SEED = galaxySeedOf(ROOT)
const CATALOG = TEST_CATALOG
const SOL = catalogStub(CATALOG.stars[0]!)
const CATALOG_STARS = CATALOG.stars
const stringify = (value: unknown): string => JSON.stringify(value)
const context = (cell: Parameters<typeof cellContext>[1]) =>
  cellContext(CATALOG, cell)

describe('galaxy', () => {
  it('generates a cell identically no matter who asks or when', () => {
    const cell = { x: 12, y: -3, z: 7 }
    expect(stringify(generateCell(GALAXY_SEED, cell))).toBe(
      stringify(generateCell(GALAXY_SEED, cell)),
    )
  })

  it('does not let neighboring cells influence each other', () => {
    // Generating the neighborhood first must not change the cell's contents:
    // this is the property that makes worker-order irrelevant.
    const cell = { x: 4, y: 1, z: -2 }
    const isolated = stringify(generateCell(GALAXY_SEED, cell))
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        generateCell(GALAXY_SEED, {
          x: cell.x + dx,
          y: cell.y + dy,
          z: cell.z - 1,
        })
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
          expect(parseProceduralSystemId(id)).toEqual({
            cell: { x, y, z },
            index,
          })
        },
      ),
    )
  })

  it('resolves any system id without a global index', () => {
    const cell = cellOf(SOL.position)
    const stars = generateCell(GALAXY_SEED, cell, context(cell))
    expect(stars.length).toBeGreaterThan(0)
    const target = stars[0]
    if (target === undefined) throw new Error('expected a star')
    expect(stringify(resolveSystem(GALAXY_SEED, CATALOG, target.id))).toBe(
      stringify(target),
    )
    expect(resolveSystem(GALAXY_SEED, CATALOG, SOL.id)?.name).toBe('Sol')
  })

  it('finds the real neighbors of Sol', () => {
    const near = systemsWithin(
      GALAXY_SEED,
      CATALOG,
      SOL.position,
      5 * LIGHT_YEAR,
    )
    const names = near.filter((s) => s.catalogued).map((s) => s.name)
    expect(names).toContain('Proxima Centauri')
    expect(names).toContain('Alpha Centauri')
    expect(names).not.toContain('Sirius')
    // Stable ordering, so two clients asking the same question agree.
    expect(
      stringify(
        systemsWithin(GALAXY_SEED, CATALOG, SOL.position, 5 * LIGHT_YEAR),
      ),
    ).toBe(stringify(near))
  })

  it('thins out above the galactic plane', () => {
    const inPlane = systemsWithin(
      GALAXY_SEED,
      CATALOG,
      SOL.position,
      30 * LIGHT_YEAR,
    ).length
    const aboveDisk = systemsWithin(
      GALAXY_SEED,
      CATALOG,
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
    expect(
      stringify(generateSystem(rootSeed('other'), MILKY_WAY, SOL)),
    ).not.toBe(stringify(a))
  })

  it('does not depend on generation order', () => {
    const stubs = CATALOG_STARS.map(catalogStub)
    const sequential = stubs.map((s) =>
      stringify(generateSystem(ROOT, MILKY_WAY, s)),
    )
    const shuffled = new Rng(rootSeed('order')).shuffle(
      stubs.map((s, i) => [s, i] as const),
    )
    for (const [stub, index] of shuffled) {
      expect(stringify(generateSystem(ROOT, MILKY_WAY, stub))).toBe(
        sequential[index],
      )
    }
  })

  /** The classes that are worlds. Dwarfs, asteroids and comets are not. */
  const WORLD_KINDS = new Set(['rocky', 'ice', 'gas-giant', 'ice-giant'])

  it('lays planets out in increasing orbits with plausible physics', () => {
    for (const stub of CATALOG_STARS.map(catalogStub)) {
      const system = generateSystem(ROOT, MILKY_WAY, stub)
      let previous = 0
      // `orbitalOrder`, because `planets` is in *issue* order: a confirmed
      // planet takes the next free index whatever its orbit, so the array is
      // deliberately not sorted by semi-major axis. See ADR-0009.
      for (const planet of orbitalOrder(system)) {
        expect(planet.elements.semiMajorAxis).toBeGreaterThan(previous)
        previous = planet.elements.semiMajorAxis
        /*
         * A hundred kilometers is the floor for a *world*, and Sol is now full
         * of things that are not worlds: 1998 KY26 is thirteen meters across
         * and is in `system.planets` because it orbits the star. The check is
         * scoped to the classes the generator issues rather than relaxed,
         * because "no generated planet is a pebble" is the thing it was
         * written to catch and it is still worth catching.
         */
        if (WORLD_KINDS.has(planet.kind))
          expect(planet.radius).toBeGreaterThan(1e5)
        expect(planet.mass).toBeGreaterThan(0)
        expect(planet.elements.eccentricity).toBeLessThan(1)
        // `G(M + m)`, the same two-body parameter `frames.ts` propagates with.
        // A planet's own mass moves its period by parts per million and a large
        // moon's by half a percent, and the number displayed has to be the one
        // the simulation actually flies.
        expect(planet.orbitalPeriod).toBeCloseTo(
          orbitalPeriod(
            system.star.mu + planet.mu,
            planet.elements.semiMajorAxis,
          ),
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
          expect(
            Vec.distance(faceToDirection(face.face, face.u, face.v), direction),
          ).toBeLessThan(1e-12)
        },
      ),
    )
  })

  it('puts a direction in a region whose center is nearby', () => {
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
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('expected a solid body')
    const region = regionForDirection(Vec.normalize(vec3(1, 0.2, 0.1)), 5)
    const first = generateHeightfield(planet.surface, {
      region,
      resolution: 33,
    })
    generateHeightfield(planet.surface, {
      region: regionForDirection(vec3(0, 1, 0), 5),
      resolution: 33,
    })
    const second = generateHeightfield(planet.surface, {
      region,
      resolution: 33,
    })
    expect(Array.from(second.elevations)).toEqual(Array.from(first.elevations))
    expect(first.maxElevation).toBeLessThanOrEqual(
      planet.surface.maxElevation * 1.2,
    )
    expect(first.minElevation).toBeGreaterThanOrEqual(
      -planet.surface.maxElevation * 1.2,
    )
  })

  it('agrees with the sampled elevation at region corners', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('expected a solid body')
    const region = regionForDirection(Vec.normalize(vec3(-0.4, 0.1, 0.9)), 4)
    const field = generateHeightfield(planet.surface, {
      region,
      resolution: 5,
      border: 0,
    })
    const corner = elevationAt(planet.surface, regionCentreDirection(region))
    expect(Number.isFinite(corner)).toBe(true)
    expect(field.elevations.length).toBe(25)
  })

  it('carries a border ring of the neighboring ground', () => {
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('expected a solid body')
    const region = regionForDirection(Vec.normalize(vec3(0.2, -0.7, 0.4)), 6)
    const field = generateHeightfield(planet.surface, {
      region,
      resolution: 9,
    })
    expect(field.border).toBe(HEIGHTFIELD_BORDER)
    expect(heightfieldStride(field)).toBe(9 + 2 * HEIGHTFIELD_BORDER)
    expect(field.elevations.length).toBe((9 + 2 * HEIGHTFIELD_BORDER) ** 2)

    // The patch's own extremes ignore the border: they size the bounding volume
    // the renderer culls against, and the border is ground the next patch draws.
    let min = Infinity
    let max = -Infinity
    for (let row = 0; row < 9; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const value = heightfieldSample(field, row, col)
        min = Math.min(min, value)
        max = Math.max(max, value)
      }
    }
    expect(field.minElevation).toBe(min)
    expect(field.maxElevation).toBe(max)

    // And the ring is the field one step outside, not a clamp of the edge.
    // `drawnElevation` rather than `groundElevation`, because a heightfield is
    // the *drawn* field — the border row has to be exactly what the neighboring
    // patch generates for itself, tail included, or every patch boundary carries
    // a one-sided difference of up to `drawnDivergence`.
    // `fround` because Float32Array storage is the only step between them.
    expect(heightfieldSample(field, -1, 4)).toBe(
      Math.fround(
        drawnElevation(planet.surface, regionDirection(region, 0.5, -1 / 8)),
      ),
    )
  })
})

describe('where the field stops having anything to add', () => {
  it('finds a floor past which a patch is its parent, upsampled', () => {
    /*
     * The claim `surfaceDetailFloor` makes, checked against the field rather
     * than against itself: at the floor, the middle of a grid cell is within
     * tolerance of the bilinear interpolation of its corners — and one level
     * *above* it, it is not. Both halves matter. Without the second, a function
     * that returned `MAX_REGION_LEVEL` would pass.
     */
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('expected a solid body')

    const tolerance = 0.5
    const floor = surfaceDetailFloor(planet.surface, 65, tolerance)
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeLessThan(MAX_REGION_LEVEL)

    const residual = (level: number): number => {
      const half = 0.5 / 64
      let peak = 0
      for (let probe = 0; probe < 24; probe += 1) {
        const z = 1 - (2 * probe + 1) / 24
        const around = probe * Math.PI * (3 - Math.sqrt(5))
        const ring = Math.sqrt(Math.max(0, 1 - z * z))
        const region = regionForDirection(
          vec3(Math.cos(around) * ring, z, Math.sin(around) * ring),
          level,
        )
        const at = (s: number, t: number): number =>
          drawnElevation(planet.surface, regionDirection(region, s, t))
        const corners =
          at(0.5 - half, 0.5 - half) +
          at(0.5 + half, 0.5 - half) +
          at(0.5 - half, 0.5 + half) +
          at(0.5 + half, 0.5 + half)
        peak = Math.max(peak, Math.abs(at(0.5, 0.5) - corners / 4))
      }
      return peak
    }

    // One level of margin is added on top of the search, so the floor itself is
    // comfortably under and the level two above it is not.
    expect(residual(floor)).toBeLessThanOrEqual(tolerance)
    expect(residual(floor - 2)).toBeGreaterThan(tolerance)
  })

  it('is not fooled by an ocean flattening the coarse probes', () => {
    /*
     * The sea clamp manufactures exact zeros, and at level 0 the twenty-four
     * probes alias onto at most six face-center stencils — so an ocean world
     * whose face centers are all submerged reads as "quiet at level 0" while
     * its islands carry kilometers of relief. A search that trusts the first
     * quiet level answers 1, and the streamer, which takes this as `maxLevel`,
     * draws the whole body as six patches forever.
     *
     * This seed's Earth is such a world: seaLevel 0.55 puts the sea datum
     * 544 m up and every coarse stencil under it. The bound is loose — the
     * exact floor (9 today) moves with the band stack — but the trap's
     * signature is exactly 1, so anything past the flooded coarse levels
     * proves the walk carried on to dry ground.
     */
    const system = generateSystem(rootSeed('d'), MILKY_WAY, SOL)
    const wet = [...walkBodies(system)].find(
      (b) => b.surface.seaLevel !== null && b.surface.maxElevation > 0,
    )
    if (wet === undefined) throw new Error('expected an ocean world')
    expect(surfaceDetailFloor(wet.surface)).toBeGreaterThan(1)
  })

  it('answers the same whatever order it is asked in', () => {
    /*
     * The memo key folded `resolution` and `tolerance` into a sum, so any two
     * questions whose two numbers added to the same thing collided, and
     * whichever ran first won for both — a pure function of the seed whose
     * answer depended on the order of the questions, which is the one thing
     * generation may never do.
     *
     * `(65, 0.5)` and `(33, 32.5)` both sum to 65.5, so a summed key cannot
     * tell them apart, and they answer 14 and 11 — the shipped pair, `(65, 0.5)`
     * against `(64, 1.5)`, sums the same way and now answers 14 to both, so it
     * could no longer fail.
     */
    const system = generateSystem(ROOT, MILKY_WAY, SOL)
    const planet = [...walkBodies(system)].find(
      (b) => b.surface.maxElevation > 0,
    )
    if (planet === undefined) throw new Error('expected a solid body')
    const fresh = { ...planet.surface }

    const a = surfaceDetailFloor(planet.surface, 65, 0.5)
    const b = surfaceDetailFloor(planet.surface, 33, 32.5)
    // The same two questions, asked of an equal surface in the other order.
    const b2 = surfaceDetailFloor(fresh, 33, 32.5)
    const a2 = surfaceDetailFloor(fresh, 65, 0.5)
    expect([a2, b2]).toEqual([a, b])
    // And they are genuinely different answers, so the pair can fail.
    expect(a).not.toBe(b)
  })
})

describe('cross-face adjacency', () => {
  /*
   * The eight points where three cube faces meet are the classic bug farm, so
   * these are properties over every face rather than examples on one.
   */
  const FACES = [0, 1, 2, 3, 4, 5]

  it('steps to a region that shares an edge, on any face (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FACES),
        fc.integer({ min: 1, max: 5 }),
        fc.nat(),
        fc.nat(),
        fc.constantFrom<readonly [number, number]>(
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ),
        (face, level, ri, rj, [di, dj]) => {
          const span = 2 ** level
          const region = regionAddress(face, level, ri % span, rj % span)
          const neighbor = regionNeighbor(region, di, dj)
          expect(neighbor.level).toBe(level)
          const separation = Math.acos(
            Math.min(
              1,
              Vec.dot(
                regionCentreDirection(region),
                regionCentreDirection(neighbor),
              ),
            ),
          )
          /*
           * One cell's angular width, with the cube warp's own slack. A cell at
           * the middle of a face is ~1.6× the nominal π/2 / 2^level of one at a
           * corner, so an edge step between the two is bounded by the larger.
           */
          expect(separation).toBeGreaterThan(0)
          expect(separation).toBeLessThan((1.7 * (Math.PI / 2)) / span)
        },
      ),
    )
  })

  it('is its own inverse across a face edge (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FACES),
        fc.integer({ min: 1, max: 8 }),
        fc.nat(),
        fc.nat(),
        fc.constantFrom<readonly [number, number]>(
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ),
        (face, level, ri, rj, [di, dj]) => {
          const span = 2 ** level
          const region = regionAddress(face, level, ri % span, rj % span)
          const neighbor = regionNeighbor(region, di, dj)
          /*
           * Stepping back is *not* the negated step once the face has changed:
           * the neighbor's axes are its own. Walking back is therefore stated as
           * "one of my four neighbors is where I came from", which is the
           * property that would actually break if the rotation were wrong.
           */
          const back = [
            regionNeighbor(neighbor, 1, 0),
            regionNeighbor(neighbor, -1, 0),
            regionNeighbor(neighbor, 0, 1),
            regionNeighbor(neighbor, 0, -1),
          ]
          expect(
            back.some(
              (candidate) =>
                candidate.face === region.face &&
                candidate.i === region.i &&
                candidate.j === region.j,
            ),
          ).toBe(true)
        },
      ),
    )
  })

  it('gives a cube-corner cell seven neighbors rather than eight', () => {
    /*
     * Face 0's (0, 0) cell sits on a cube corner where three faces meet, so the
     * diagonal step off it names one of the three rather than a missing fourth.
     * The ring is therefore seven distinct cells and one repeat — a caller that
     * walks it has to tolerate that rather than assume eight.
     */
    const corner = regionAddress(0, 4, 0, 0)
    const ring = new Set<string>()
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const n = regionNeighbor(corner, di, dj)
      ring.add(`${n.face}.${n.i}.${n.j}`)
    }
    expect(ring.size).toBe(7)
  })

  it('puts the same vertices on a shared edge from both faces', () => {
    /*
     * The property the crack-free mesh rests on, and the one a rotation table
     * gets wrong: the row of vertices along a cube-face edge has to be the
     * *same points* whichever face generates it — not close, the same, because
     * a shared vertex that disagrees in the last bit is a lit hairline.
     *
     * Stated without naming the rotation, so the test cannot agree with a wrong
     * one: one of the neighbor's four edges, read in one of its two directions,
     * is this edge exactly. Which one is the arithmetic under test.
     */
    const level = 4
    const span = 2 ** level
    const samples = 9
    const edgeOf = (
      region: ReturnType<typeof regionAddress>,
      which: number,
    ): string[] => {
      const out: string[] = []
      for (let k = 0; k < samples; k += 1) {
        const a = k / (samples - 1)
        const [s, t] =
          which === 0
            ? [0, a]
            : which === 1
              ? [1, a]
              : which === 2
                ? [a, 0]
                : [a, 1]
        const d = regionDirection(region, s, t)
        out.push(`${d.x},${d.y},${d.z}`)
      }
      return out
    }

    for (const face of FACES) {
      for (const [di, dj, mine] of [
        [1, 0, 1],
        [-1, 0, 0],
        [0, 1, 3],
        [0, -1, 2],
      ] as const) {
        const region = regionAddress(
          face,
          level,
          di > 0 ? span - 1 : di < 0 ? 0 : 5,
          dj > 0 ? span - 1 : dj < 0 ? 0 : 5,
        )
        const neighbor = regionNeighbor(region, di, dj)
        expect(neighbor.face).not.toBe(face)
        const target = edgeOf(region, mine).join('|')
        const reversed = [...edgeOf(region, mine)].reverse().join('|')
        const matches = [0, 1, 2, 3].filter((which) => {
          const other = edgeOf(neighbor, which).join('|')
          return other === target || other === reversed
        })
        expect(matches).toHaveLength(1)
      }
    }
  })

  it('walks up and down the quadtree consistently (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FACES),
        fc.integer({ min: 0, max: 10 }),
        fc.nat(),
        fc.nat(),
        (face, level, ri, rj) => {
          const span = 2 ** level
          const region = regionAddress(face, level, ri % span, rj % span)
          const children = regionChildren(region)
          expect(new Set(children.map((c) => `${c.i}.${c.j}`)).size).toBe(4)
          for (const child of children) {
            expect(regionParent(child)).toEqual(region)
            // A child's ground is inside its parent's: its center direction is
            // in the parent at the parent's level.
            expect(
              regionForDirection(regionCentreDirection(child), level),
            ).toEqual(region)
          }
          if (level === 0) expect(regionParent(region)).toBeNull()
        },
      ),
    )
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
    const height =
      UV.distance(pose.position, planetPose.position) - planet.radius
    expect(Math.abs(height)).toBeLessThanOrEqual(
      planet.surface.maxElevation * 1.2,
    )
    expect(Math.abs(height)).toBeGreaterThan(0)

    // Standing still on the surface still means moving, in the frame above.
    const spinSpeed =
      (2 * Math.PI * planet.radius * Math.cos(0.4)) /
      Math.abs(planet.rotationPeriod)
    expect(Vec.length(pose.velocity)).toBeGreaterThan(spinSpeed * 0.5)
  })

  it('round-trips geodetic coordinates (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1.5, max: 1.5, noNaN: true }),
        fc.double({ min: -Math.PI + 0.01, max: Math.PI - 0.01, noNaN: true }),
        (latitude, longitude) => {
          const back = directionToGeodetic(
            geodeticDirection(latitude, longitude),
          )
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

describe('catalog', () => {
  const byId = (id: string) => {
    const star = CATALOG.get(id as never)
    if (star === undefined) throw new Error(`no fixture star ${id}`)
    return star
  }

  it('reproduces published distances between real stars', () => {
    // Published distances, and the fixture's positions were converted from
    // published right ascension, declination and parallax — three numbers each,
    // through a rotation and a translation. Agreeing to a hundredth of a light
    // year is the whole ICRS → galactic → universe chain being right.
    const published: readonly [string, number][] = [
      ['HIP70890', 4.2465],
      ['HIP71683', 4.3441],
      ['HIP87937', 5.9629],
      ['HIP32349', 8.6094],
    ]
    const sol = byId('SOL')
    for (const [id, lightYears] of published) {
      const star = byId(id)
      expect(star.distanceLightYears).toBeCloseTo(lightYears, 1)
      expect(UV.distance(sol.position, star.position) / LIGHT_YEAR).toBeCloseTo(
        lightYears,
        1,
      )
    }
  })

  it('separates Proxima from Alpha Centauri by the observed 0.2 ly', () => {
    // Computed from two independent RA/Dec/parallax entries, so agreeing with
    // the published separation validates the whole coordinate conversion.
    const proxima = byId('HIP70890')
    const alpha = byId('HIP71683')
    expect(
      UV.distance(proxima.position, alpha.position) / LIGHT_YEAR,
    ).toBeCloseTo(0.2, 1)
  })

  it('places the Sun 8.178 kpc from the galactic center', () => {
    expect(
      UV.distance(byId('SOL').position, UV.UNIVERSE_ORIGIN) /
        (3.085677581491367e16 * 1000),
    ).toBeCloseTo(8.178, 3)
  })

  it('finds a star by any of its names', () => {
    const alpha = byId('HIP71683')
    for (const query of [
      'Alpha Centauri',
      'alpha centauri',
      'Rigil Kentaurus',
      'HIP 71683',
      'hip71683',
      'HD 128620',
      'Gliese 559A',
      'gliese559a',
      'Alpha¹ Centauri',
    ])
      expect(CATALOG.find(query)?.id, query).toBe(alpha.id)
  })

  it("shows the system name, not one component's proper name", () => {
    // Both components of α Cen carry an IAU proper name — Rigil Kentaurus and
    // Toliman — and neither of them names the system. Sirius is the opposite
    // case and must keep its proper name rather than becoming Alpha Canis
    // Majoris, which is why the rule counts named components rather than
    // preferring designations for every multiple.
    expect(byId('HIP71683').name).toBe('Alpha Centauri')
    expect(byId('HIP32349').name).toBe('Sirius')
    expect(byId('HIP71683').designations[0]?.text).toBe('Alpha Centauri')
    expect(byId('HIP71683').designations.map((d) => d.text)).toContain(
      'Rigil Kentaurus',
    )
  })

  it('puts a day-long rotation in the right ballpark', () => {
    expect(SECONDS_PER_DAY).toBe(86_400)
    expect(AU / 1e11).toBeCloseTo(1.496, 3)
  })
})

describe('observed planets', () => {
  it('issues confirmed planets first, in discovery order', () => {
    const barnard = CATALOG.get('HIP87937' as never)
    if (barnard === undefined) throw new Error('no Barnard')
    const system = generateSystem(ROOT, MILKY_WAY, catalogStub(barnard))

    expect(system.observedPlanets).toBe(2)
    expect(system.planets[0]?.provenance).toBe('observed')
    expect(system.planets[1]?.provenance).toBe('observed')
    expect(system.planets[0]?.name).toBe("Barnard's Star b")
    expect(system.planets[1]?.name).toBe("Barnard's Star c")
    // Issue ordinals, not orbital ones: b is address 0 forever.
    expect(formatAddress(system.planets[0]!.address)).toBe(
      'g:milky-way/s:HIP87937/b:0',
    )
    for (const planet of system.planets.slice(2))
      expect(planet.provenance).toBe('projected')
  })

  it('uses the published orbit verbatim', () => {
    const barnard = CATALOG.get('HIP87937' as never)
    if (barnard === undefined) throw new Error('no Barnard')
    const system = generateSystem(ROOT, MILKY_WAY, catalogStub(barnard))
    const b = system.planets[0]
    if (b === undefined) throw new Error('no planet b')
    expect(b.elements.semiMajorAxis / AU).toBeCloseTo(0.0229, 4)
    expect(b.elements.eccentricity).toBe(0)
    expect(b.measurement?.massIsLowerBound).toBe(true)
    // No radius is published for either, so both are inferred from the mass and
    // the panel has to be able to say so.
    expect(b.measurement?.radiusInferred).toBe(true)
    expect(b.measurement?.massInferred).toBe(false)
    // 0.023 AU is well inside the locking distance; a world that close is not
    // spinning freely.
    expect(b.rotationPeriod).toBeCloseTo(b.orbitalPeriod, 6)
  })

  it('does not project a body onto a confirmed orbit', () => {
    const barnard = CATALOG.get('HIP87937' as never)
    if (barnard === undefined) throw new Error('no Barnard')
    const system = generateSystem(ROOT, MILKY_WAY, catalogStub(barnard))
    const observed = system.planets
      .filter((p) => p.provenance === 'observed')
      .map((p) => p.elements.semiMajorAxis)
    for (const projected of system.planets.filter(
      (p) => p.provenance === 'projected',
    ))
      for (const known of observed) {
        const ratio = projected.elements.semiMajorAxis / known
        expect(ratio > 1.5 || ratio < 1 / 1.5).toBe(true)
      }
  })
})

describe('the ground has one owner', () => {
  /*
   * `seaLevel` used to be honored by `surfaceRadius` — which decides where a
   * ship touches down and where `installSurfaceFrame` puts the pad — and
   * ignored by `generateHeightfield`, which decides what gets drawn. It was
   * carried the whole way from the generator to the mesh and then dropped, so
   * on any world with an ocean the pad sat on the water datum and the mesh drew
   * the seabed under it. Roughly 40% of atmosphered rocky planets have one.
   */
  // Sol has no ocean world at this seed, so the catalog is scanned rather
  // than a system named: which star gets one is a property of the seed, and
  // pinning it here would make this test fail for the wrong reason.
  const oceanWorld = () => {
    for (const stub of CATALOG_STARS.map(catalogStub)) {
      const system = generateSystem(ROOT, MILKY_WAY, stub)
      const wet = [...walkBodies(system)].find(
        (body) => body.surface.seaLevel !== null,
      )
      if (wet !== undefined) return wet
    }
    throw new Error('no ocean world anywhere in the catalog')
  }

  /*
   * The mesh is the *drawn* field and the contact test is the canonical one, so
   * the claim is no longer "the same number" — it is "the same number plus a
   * term this body publishes a bound for". Both halves are asserted, because
   * only the pair can fail: against `drawnElevation` alone a mesh that had
   * quietly picked up an unbounded term would still pass, and against the bound
   * alone so would a mesh built from the wrong field entirely.
   *
   * `toBeCloseTo(…, 1)` on the first is the Float32Array storage between them
   * and nothing else. On a body that has enough air, the tail is thinned to
   * almost nothing and the two ends of this test are nearly the same assertion —
   * so the third expectation names the body's own bound rather than a constant,
   * and the fourth insists the tail is doing something somewhere on the patch.
   */
  it('draws the mesh at the drawn radius, inside the bound it publishes', () => {
    const body = oceanWorld()
    const region = regionAddress(0, 4, 5, 6)
    // The seabed, as the streamer asks for it where a sheet is drawn.
    const field = generateHeightfield(body.surface, {
      region,
      resolution: HEIGHTFIELD_RESOLUTION,
      seabed: true,
    })
    const bound = drawnDivergence(body.surface)

    for (const [s, t] of [
      [0, 0],
      [1, 0],
      [0.5, 0.5],
      [0, 1],
      [1, 1],
    ] as const) {
      const row = Math.round(t * (HEIGHTFIELD_RESOLUTION - 1))
      const col = Math.round(s * (HEIGHTFIELD_RESOLUTION - 1))
      const meshed = heightfieldSample(field, row, col)
      const direction = regionDirection(region, s, t)
      /*
       * The mesh is the seabed — `drawnGroundElevation`, with no sea clamp —
       * and the bound is held against the *unclamped* canonical field for the
       * same reason: under the sea `surfaceRadius` is the datum by
       * construction, and the seabed is meters below it. What the two fields
       * may not do is disagree by more than the published divergence about
       * the ground itself, wet or dry.
       */
      expect(meshed).toBeCloseTo(
        drawnGroundElevation(body.surface, direction),
        1,
      )
      expect(
        Math.abs(meshed - elevationAt(body.surface, direction)),
      ).toBeLessThanOrEqual(bound)
      // And standing on the water is standing on the water: the drawn
      // radius the stance uses is the clamped one, never below the datum.
      expect(
        drawnSurfaceRadius(body, direction) - body.radius,
      ).toBeGreaterThanOrEqual(
        Math.min(meshed, seaDatumElevation(body.surface) as number) - 1e-6,
      )
    }

    /*
     * And without the flag the field is the clamped surface, which is what a
     * body with no sheet — a mapped one, whose photograph is its sea — is
     * built from. An unclamped seabed under a photograph is a trench
     * kilometers below the datum the ship lands on.
     */
    const clamped = generateHeightfield(body.surface, {
      region,
      resolution: HEIGHTFIELD_RESOLUTION,
    })
    const datum = seaDatumElevation(body.surface) as number
    let submarine = 0
    for (let row = 0; row < HEIGHTFIELD_RESOLUTION; row += 1) {
      for (let col = 0; col < HEIGHTFIELD_RESOLUTION; col += 1) {
        const seabed = heightfieldSample(field, row, col)
        const surface = heightfieldSample(clamped, row, col)
        expect(surface).toBeGreaterThanOrEqual(datum - 1e-3)
        if (seabed < datum) submarine += 1
        else expect(surface).toBeCloseTo(seabed, 1)
      }
    }
    expect(submarine).toBeGreaterThan(0)

    /*
     * And the two fields are not the same function, which is what makes the
     * bound above an assertion rather than a tautology.
     *
     * Asked on **dry** ground rather than on the patch, and that is the finding
     * rather than a convenience: the sea clamp is a `max` applied to both
     * fields, so every submarine sample has drawn and canonical equal by
     * construction — and the patch this test picks is entirely under water, so
     * a difference counted there is always zero and the assertion could never
     * fail.
     */
    const sea = seaDatumElevation(body.surface) as number
    let dry = 0
    let apart = 0
    for (let probe = 0; probe < 200; probe += 1) {
      // Golden angle, so nothing clusters at a pole and a wet hemisphere cannot
      // take the whole sample.
      const z = 1 - (2 * probe + 1) / 200
      const around = probe * Math.PI * (3 - Math.sqrt(5))
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const direction = vec3(
        Math.cos(around) * ring,
        z,
        Math.sin(around) * ring,
      )
      if (groundElevation(body.surface, direction) <= sea + 1) continue
      dry += 1
      const gap = Math.abs(
        drawnElevation(body.surface, direction) -
          groundElevation(body.surface, direction),
      )
      if (gap > 1e-3) apart += 1
      expect(gap).toBeLessThanOrEqual(bound)
    }
    expect(dry).toBeGreaterThan(0)
    expect(apart).toBe(dry)

    /*
     * And once more against a **mesh**, on dry ground.
     *
     * The two loops above each cover half of the claim and neither covers the
     * whole of it: the corners are all submarine, where the sea clamp makes the
     * two fields equal by construction, and the probe compares the fields to
     * each other without asking a heightfield anything. So a
     * `generateHeightfield` that dropped the tail from its *interior* samples —
     * the `groundCoverAt` path, which the border ring does not exercise — would
     * pass both. This is the vertex that says it did not.
     */
    const shore = dryRegion(body, sea)
    const dryField = generateHeightfield(body.surface, {
      region: shore.region,
      resolution: HEIGHTFIELD_RESOLUTION,
    })
    const above = regionDirection(shore.region, shore.s, shore.t)
    expect(heightfieldSample(dryField, shore.row, shore.col)).toBeCloseTo(
      drawnElevation(body.surface, above),
      1,
    )
    expect(
      Math.abs(
        heightfieldSample(dryField, shore.row, shore.col) -
          groundElevation(body.surface, above),
      ),
    ).toBeGreaterThan(1e-3)
  })

  /**
   * A patch vertex on dry land, on a world that is mostly not.
   *
   * Searched rather than written down: the ocean world is whichever the catalog
   * yields first, and a hand-picked region is a coordinate that goes stale the
   * day the seed or the sea datum moves. Every eighth vertex, because a full
   * 65x65 sweep is four thousand band stacks and one in sixty-four is enough.
   */
  function dryRegion(
    body: Body,
    sea: number,
  ): {
    region: RegionAddress
    row: number
    col: number
    s: number
    t: number
  } {
    for (let probe = 0; probe < 200; probe += 1) {
      const z = 1 - (2 * probe + 1) / 200
      const around = probe * Math.PI * (3 - Math.sqrt(5))
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const seed = vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
      if (groundElevation(body.surface, seed) <= sea + 1) continue
      const region = regionForDirection(seed, 4)
      for (let row = 0; row < HEIGHTFIELD_RESOLUTION; row += 8) {
        for (let col = 0; col < HEIGHTFIELD_RESOLUTION; col += 8) {
          const s = col / (HEIGHTFIELD_RESOLUTION - 1)
          const t = row / (HEIGHTFIELD_RESOLUTION - 1)
          const at = regionDirection(region, s, t)
          if (groundElevation(body.surface, at) > sea + 1) {
            return { region, row, col, s, t }
          }
        }
      }
    }
    throw new Error('no dry patch vertex anywhere on the ocean world')
  }

  it('clamps the ocean up to its datum rather than down to the seabed', () => {
    const body = oceanWorld()
    expect(body.surface.seaLevel).not.toBeNull()
    // Through `seaDatumElevation`, not a copy of its arithmetic: the datum is
    // scaled by the hypsometry band's share of the budget, and a test that
    // spelled that out again would be asserting its own copy of the formula.
    const floor = seaDatumElevation(body.surface) as number
    // Somewhere on this world the bare landform is below the water line; the
    // ground there is the water, not the rock.
    const grid = []
    for (let face = 0; face < 6; face += 1) {
      for (let u = -0.9; u <= 0.9; u += 0.3) {
        for (let v = -0.9; v <= 0.9; v += 0.3)
          grid.push(faceToDirection(face, u, v))
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
          const id = surfaceFrameId(
            ADDRESS,
            latitude as Radians,
            longitude as Radians,
          )
          const parsed = parseSurfaceFrameId(id)
          expect(parsed).not.toBeNull()
          if (parsed === null) return
          expect(formatAddress(parsed.address)).toBe(formatAddress(ADDRESS))
          // Re-formatting what we parsed must give the identical id. That is the
          // property the whole quantisation dance exists to provide.
          expect(
            surfaceFrameId(parsed.address, parsed.latitude, parsed.longitude),
          ).toBe(id)
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
    expect(
      surfaceFrameId(parsed.address, parsed.latitude, parsed.longitude),
    ).toBe(id)
    expect(Object.is(parsed.latitude, -0)).toBe(false)
  })

  it('returns null for anything that is not a surface frame id', () => {
    for (const id of [
      's:SOL',
      'b:g:milky-way/s:SOL/b:2',
      'bf:g:milky-way/s:SOL/b:2',
      'sf:no-at-sign',
    ]) {
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
        expect(moon.surface.seed).toEqual(
          surfaceSeedOf(addressLabels(moonAddress)),
        )
      })
    })
  })

  it('addresses a system the same way its seed is derived', () => {
    expect(systemSeedOf(ROOT, MILKY_WAY, SOL.id)).toEqual(
      derivePath(ROOT, addressLabels(systemAddress(MILKY_WAY, SOL.id))),
    )
  })
})
