import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import {
  carveDrainage,
  type DrainageGraph,
  drainageCell,
  drainageGraph,
  drainageLookup,
  drainageRefinement,
  lakeLevelAt,
  SEGMENT_STRIDE,
} from './drainage.ts'
import { REFINEMENT_SHAPE } from './drainageRefinement.ts'
import { geodeticDirection } from './frames.ts'
import { CANONICAL_AMPLITUDE_FLOOR, terrainSketch } from './sketch.ts'
import { surveySites } from './surveySites.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import { elevationAt, landformAt, waterLevelAt } from './terrain.ts'

/*
 * The refinement below the lattice, held to the four things the plan says
 * break a refinement and that no test of one cell can see: a creek that
 * depends on what was built first, a construction that grows with the
 * sample rather than the cell, a step where a list changes, and a creek
 * that runs uphill. And to the one thing it is for — a creek a walker can
 * stand beside.
 *
 * The generated world is the fixture catalog's first that drains, as in
 * `drainage.test.ts`; at this seed it has no sea, so its creeks run to
 * lakes and pits, and Earth stands in for a coast.
 */

const ROOT = rootSeed('inertialref')

const generated = ((): Body => {
  for (const star of TEST_CATALOG.stars.slice(1)) {
    const system = generateSystem(ROOT, MILKY_WAY, catalogStub(star))
    for (const body of walkBodies(system)) {
      if (
        body.surface.grammar.drainage > 0 &&
        body.surface.maxElevation > 0 &&
        body.radius > 1_000_000
      ) {
        return body
      }
    }
  }
  throw new Error('no generated world in the fixture catalog drains')
})()

const graphOf = (body: Body): DrainageGraph => {
  const graph = drainageGraph(body.surface)
  if (graph === null) throw new Error(`${body.name} has no drainage graph`)
  return graph
}

/** The site's direction: where the largest river starts, which is land. */
const siteOf = (body: Body, id: string): Vec3 => {
  const site = surveySites(body).find((one) => one.id === id)
  if (site === undefined) throw new Error(`${body.name} has no ${id}`)
  return geodeticDirection(site.latitude, site.longitude)
}

/** The sample direction whose lookup is `target`: the warp's fixed point. */
function unwarp(graph: DrainageGraph, body: Body, target: Vec3): Vec3 {
  const sketch = terrainSketch(body.surface)
  let guess = target
  for (let i = 0; i < 60; i += 1) {
    const warped = drainageLookup(graph, sketch, guess)
    guess = Vec.normalize(Vec.add(guess, Vec.sub(target, warped)))
  }
  return guess
}

/** `count` directions on a great-circle arc. */
const arc = (from: Vec3, to: Vec3, count: number): Vec3[] =>
  Array.from({ length: count }, (_, k) =>
    Vec.normalize(Vec.lerp(from, to, k / (count - 1))),
  )

/** A direction `meters` from `origin` along a fixed tangent. */
const offset = (
  origin: Vec3,
  radius: number,
  east: number,
  north: number,
): Vec3 => {
  const up = Vec.normalize(origin)
  const e = Vec.normalize(Vec.cross(vec3(0, 1, 0), up))
  const n = Vec.cross(up, e)
  return Vec.normalize(
    Vec.add(
      up,
      Vec.add(Vec.scale(e, east / radius), Vec.scale(n, north / radius)),
    ),
  )
}

describe('the refinement below the lattice', () => {
  it('is the same creek whatever was built first, and after a rebuild', async () => {
    /*
     * Two module instances are two threads' caches. One samples a cluster
     * around the headwater in one order; the other first builds cells across
     * the body, then the cluster in reverse. Every value, and every list the
     * two built in common, agrees to the bit — so nothing the cache holds
     * depends on what was built before it, and a cell evicted and built again
     * is the cell it was.
     */
    const body = generated
    const radius = body.surface.grammar.meanRadius
    const center = siteOf(body, 'headwater')
    const cluster: Vec3[] = []
    for (let a = -3; a <= 3; a += 1) {
      for (let b = -3; b <= 3; b += 1) {
        cluster.push(offset(center, radius, a * 1_300, b * 1_700))
      }
    }
    const elsewhere = Array.from({ length: 24 }, (_, k) => {
      const z = 1 - (2 * k + 1) / 24
      const ring = Math.sqrt(1 - z * z)
      return vec3(Math.cos(k * 2.4) * ring, z, Math.sin(k * 2.4) * ring)
    })
    const fresh = async () => {
      vi.resetModules()
      const field = await import('./terrain.ts')
      const lattice = await import('./drainage.ts')
      return { field, lattice }
    }

    const one = await fresh()
    const forward = cluster.map((d) => one.field.elevationAt(body.surface, d))
    const two = await fresh()
    for (const d of elsewhere) two.field.elevationAt(body.surface, d)
    const backward = [...cluster]
      .reverse()
      .map((d) => two.field.elevationAt(body.surface, d))
      .reverse()
    expect(backward).toEqual(forward)

    const first = one.lattice.drainageRefinement(
      one.lattice.drainageGraph(body.surface) as DrainageGraph,
    )
    const second = two.lattice.drainageRefinement(
      two.lattice.drainageGraph(body.surface) as DrainageGraph,
    )
    let compared = 0
    for (let level = first.first; level <= first.last; level += 1) {
      for (const d of cluster.slice(0, 12)) {
        const lookup = drainageLookup(
          graphOf(body),
          terrainSketch(body.surface),
          d,
        )
        expect([...second.list(level, lookup)]).toEqual([
          ...first.list(level, lookup),
        ])
        compared += 1
      }
    }
    expect(compared).toBeGreaterThan(40)
  })

  it('asks a bounded number of constructions of a sample and of a patch', async () => {
    /*
     * The construction is the cost, so it is held by count rather than by a
     * clock: the number of families, floors and lists one isolated sample
     * asks for, and how few a dense patch adds once its first sample has
     * built the chain. A dependency that grew a cone again — a cell reading
     * its neighbors' streams, each reading theirs — multiplies the first.
     */
    vi.resetModules()
    const field = await import('./terrain.ts')
    const lattice = await import('./drainage.ts')
    const body = generated
    const graph = lattice.drainageGraph(body.surface) as DrainageGraph
    const refinement = lattice.drainageRefinement(graph)
    const total = (): number =>
      refinement
        .built()
        .reduce((sum, one) => sum + one.families + one.floors + one.lists, 0)
    const center = siteOf(body, 'headwater')
    field.elevationAt(body.surface, center)
    const isolated = total()
    const radius = body.surface.grammar.meanRadius
    for (let a = 0; a < 40; a += 1) {
      for (let b = 0; b < 40; b += 1) {
        field.elevationAt(body.surface, offset(center, radius, a * 10, b * 10))
      }
    }
    const patch = total() - isolated
    const levels = refinement.last - refinement.first + 1
    expect(`${isolated} for one sample`).toBe(
      `${Math.min(isolated, 40 * levels)} for one sample`,
    )
    expect(`${patch} for 1,600 more within 400 m`).toBe(
      `${Math.min(patch, 20 * levels)} for 1,600 more within 400 m`,
    )
  })

  it('has no step across refined cells, a lattice corner or a face edge', () => {
    /*
     * The walk `geology.test.ts` makes for the craters, at the scale of the
     * finest creeks: sixteen of the largest jumps on each arc, each bisected
     * fifty times, and the gap that survives is the step. A list changing at
     * a cell edge, a family whose creeks end at a parent's edge, a lookup
     * crossing a face — each is a place a step could hide, and the bound is
     * a twentieth of the canonical amplitude floor against creeks cut meters
     * deep.
     */
    const body = generated
    const radius = body.surface.grammar.meanRadius
    const finest = REFINEMENT_SHAPE.finestCell
    const center = siteOf(body, 'headwater')
    const arcs: [Vec3, Vec3][] = [
      [
        offset(center, radius, -2 * finest, -finest),
        offset(center, radius, 2 * finest, finest),
      ],
      [
        offset(center, radius, finest, -2 * finest),
        offset(center, radius, -finest, 2 * finest),
      ],
      // Across the face edge between +x and +z, where the creeks' parents
      // are found through `regionNeighbor`.
      [
        Vec.normalize(vec3(1, 0.2, 0.999)),
        Vec.normalize(vec3(0.999, 0.2, 1.001)),
      ],
    ]
    const step = (from: Vec3, to: Vec3, samples: number): number => {
      const at = (t: number): Vec3 => Vec.normalize(Vec.lerp(from, to, t))
      const jumps: { t: number; jump: number }[] = []
      let previous = elevationAt(body.surface, at(0))
      for (let i = 1; i <= samples; i += 1) {
        const here = elevationAt(body.surface, at(i / samples))
        jumps.push({ t: i / samples, jump: Math.abs(here - previous) })
        previous = here
      }
      jumps.sort((a, b) => b.jump - a.jump)
      let survivor = 0
      for (const candidate of jumps.slice(0, 16)) {
        let lo = candidate.t - 1 / samples
        let hi = candidate.t
        const atLo = elevationAt(body.surface, at(lo))
        for (let i = 0; i < 50; i += 1) {
          const mid = (lo + hi) / 2
          if (mid === lo || mid === hi) break
          if (
            Math.abs(elevationAt(body.surface, at(mid)) - atLo) <
            candidate.jump / 2
          )
            lo = mid
          else hi = mid
        }
        const gap = Math.abs(
          elevationAt(body.surface, at(hi)) - elevationAt(body.surface, at(lo)),
        )
        if (gap > survivor) survivor = gap
      }
      return survivor
    }
    for (const [from, to] of arcs) {
      expect(step(from, to, 4_000)).toBeLessThan(CANONICAL_AMPLITUDE_FLOOR / 20)
    }
  })

  it('never gains height down a refined creek', () => {
    /*
     * At every refined level, along every creek listed at the body's survey
     * sites, the surface a walker stands or floats on — the ground or the
     * water over it — from the creek's head to its junction. Sampled on the
     * chord itself, through the lookup's preimage, so the warp, the craters,
     * the relief and every coarser valley are in the walk.
     *
     * A meter of tolerance, which is `drainage.test.ts`'s for the lattice
     * and for the same reason: a lake's level is a kernel mean read wherever
     * a lake node is in reach, and a creek bed under the lake's level reads
     * the jump at the edge of that reach. Held at two strengths. Where a
     * walker stands beside a creek — the two finest levels — none rises.
     * At the coarser levels the median creek does not, and the tail is the
     * coarsest level's: a creek tens of kilometers long whose last stretch
     * runs inside a lattice tributary's bed near a confluence, where the
     * tributary's floor is the higher — eight creeks of forty-one at the
     * coarsest level on this world rise by more than the meter.
     */
    const body = generated
    const graph = graphOf(body)
    const sketch = terrainSketch(body.surface)
    const refinement = drainageRefinement(graph)
    const rises = new Map<number, number[]>()
    for (const site of surveySites(body)) {
      const lookup = drainageLookup(
        graph,
        sketch,
        geodeticDirection(site.latitude, site.longitude),
      )
      for (let level = refinement.first; level <= refinement.last; level += 1) {
        const records = refinement.list(level, lookup)
        for (let at = 0; at < records.length; at += SEGMENT_STRIDE) {
          const a = vec3(
            records[at] as number,
            records[at + 1] as number,
            records[at + 2] as number,
          )
          const b = vec3(
            records[at + 4] as number,
            records[at + 5] as number,
            records[at + 6] as number,
          )
          let lowest = Infinity
          let rise = 0
          for (const point of arc(a, b, 13)) {
            const d = unwarp(graph, body, point)
            const water = waterLevelAt(body.surface, d)
            const surface = Math.max(
              elevationAt(body.surface, d),
              Number.isNaN(water) ? -Infinity : water,
            )
            if (surface - lowest > rise) rise = surface - lowest
            if (surface < lowest) lowest = surface
          }
          const held = rises.get(level) ?? []
          held.push(rise)
          rises.set(level, held)
        }
      }
    }
    const report: string[] = []
    let walked = 0
    for (const [level, held] of rises) {
      walked += held.length
      held.sort((x, y) => x - y)
      const median = held[Math.floor(held.length / 2)] as number
      const over = held.filter((rise) => rise > 1).length
      if (median > 1) report.push(`level ${level}: median rise ${median} m`)
      if (level >= refinement.last - 1 && over > 0) {
        report.push(`level ${level}: ${over} of ${held.length} rise over 1 m`)
      }
      if (over > held.length / 2) {
        report.push(`level ${level}: ${over} of ${held.length} over 1 m`)
      }
    }
    expect(walked).toBeGreaterThan(60)
    expect(report).toEqual([])
  })

  it('cuts a creek a walker stands beside at its finest level', () => {
    /*
     * The phase's whole claim: at the finest level a creek's bed is meters
     * wide — narrower than the lattice can draw by two orders, and resolved
     * only by a patch near level 17 — the field there is channel, which is
     * the cover's `wet`, and the level moves the ground under it by more
     * than the canonical amplitude floor, so the creek is on the mesh and
     * under the contact test rather than a texture.
     *
     * Every creek the finest level lists over five cells either way of each
     * survey site, at its midpoint: the carve with the finest level against
     * the carve stopped one above it, on the landform the field hands both.
     * Not every creek: one on gentle ground runs a few meters under its head
     * and moves little, and on this world that is near half of them — 63 of
     * 114 move the ground by more than the floor — so the bound is the
     * measured share less a margin.
     */
    const body = generated
    const graph = graphOf(body)
    const sketch = terrainSketch(body.surface)
    const refinement = drainageRefinement(graph)
    const radius = body.surface.grammar.meanRadius
    const level = refinement.last
    const cell = (Math.PI / 2 / 2 ** level) * radius
    const seen = new Set<string>()
    let creeks = 0
    let moved = 0
    for (const site of surveySites(body)) {
      const center = geodeticDirection(site.latitude, site.longitude)
      for (let a = -2; a <= 2; a += 1) {
        for (let b = -2; b <= 2; b += 1) {
          const records = refinement.list(
            level,
            drainageLookup(
              graph,
              sketch,
              offset(center, radius, a * cell, b * cell),
            ),
          )
          for (let at = 0; at < records.length; at += SEGMENT_STRIDE) {
            const key = `${records[at]} ${records[at + 1]} ${records[at + 4]}`
            if (seen.has(key)) continue
            seen.add(key)
            const middle = Vec.normalize(
              Vec.lerp(
                vec3(
                  records[at] as number,
                  records[at + 1] as number,
                  records[at + 2] as number,
                ),
                vec3(
                  records[at + 4] as number,
                  records[at + 5] as number,
                  records[at + 6] as number,
                ),
                0.5,
              ),
            )
            const width =
              (((records[at + 8] as number) + (records[at + 9] as number)) /
                2) *
              2 *
              radius
            expect(width).toBeGreaterThan(0.5)
            expect(width).toBeLessThan(10)
            const landform = landformAt(
              body.surface,
              unwarp(graph, body, middle),
            )
            const finest = carveDrainage(graph, middle, landform, level)
            const above = carveDrainage(graph, middle, landform, level - 1)
            expect(finest.channel).toBe(1)
            creeks += 1
            if (
              Math.abs(finest.ground - above.ground) > CANONICAL_AMPLITUDE_FLOOR
            )
              moved += 1
          }
        }
      }
    }
    expect(creeks).toBeGreaterThan(60)
    expect(moved / creeks).toBeGreaterThan(0.4)
  })

  it('leaves ground no valley reaches untouched to the bit', () => {
    /*
     * A sample no lattice segment and no creek reaches is carved by nothing:
     * the ground is the landform it was handed, exactly, which is what makes
     * a wet world's open seabed — and every dry world — the same ground at
     * this version as at the last.
     */
    const earth = (() => {
      const system = generateSystem(
        ROOT,
        MILKY_WAY,
        catalogStub(
          TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number],
        ),
      )
      for (const body of walkBodies(system))
        if (body.name === 'Earth') return body
      throw new Error('no Earth')
    })()
    const graph = graphOf(earth)
    let checked = 0
    for (let n = 0; n < graph.nodes && checked < 50; n += 97) {
      if (graph.sea[n] !== 1) continue
      if ((graph.cellStart[n + 1] as number) > (graph.cellStart[n] as number))
        continue
      const at = vec3(
        graph.positions[n * 3] as number,
        graph.positions[n * 3 + 1] as number,
        graph.positions[n * 3 + 2] as number,
      )
      const landform = -3_141.592653589793
      const carve = carveDrainage(graph, at, landform)
      expect(carve.ground).toBe(landform)
      expect(carve.channel).toBe(0)
      checked += 1
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('the water over a bed', () => {
  const sol = generateSystem(
    ROOT,
    MILKY_WAY,
    catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
  )
  const named = (name: string): Body => {
    for (const body of walkBodies(sol)) if (body.name === name) return body
    throw new Error(`no ${name} in Sol`)
  }

  /** The largest step a walk across a bank may keep, meters: see below. */
  const STEP = 1e-6

  /** A reach's two ends and half-width, as a segment or a record lays them. */
  interface Reach {
    readonly a: Vec3
    readonly b: Vec3
    readonly halfWidth: number
  }
  const reachOf = (records: ArrayLike<number>, at: number): Reach => ({
    a: vec3(records[at]!, records[at + 1]!, records[at + 2]!),
    b: vec3(records[at + 4]!, records[at + 5]!, records[at + 6]!),
    halfWidth: (records[at + 8]! + records[at + 9]!) / 2,
  })

  /** The lattice's segments and every refined level's records at the sites. */
  const reachesOf = (body: Body): Reach[] => {
    const graph = graphOf(body)
    const sketch = terrainSketch(body.surface)
    const refinement = drainageRefinement(graph)
    const reaches: Reach[] = []
    for (const site of surveySites(body)) {
      const lookup = drainageLookup(
        graph,
        sketch,
        geodeticDirection(site.latitude, site.longitude),
      )
      const cell = drainageCell(graph, lookup)
      const end = graph.cellStart[cell + 1] as number
      for (let k = graph.cellStart[cell] as number; k < end; k += 1) {
        const at = (graph.cellSegments[k] as number) * SEGMENT_STRIDE
        reaches.push(reachOf(graph.segments, at))
      }
      for (let level = refinement.first; level <= refinement.last; level += 1) {
        const records = refinement.list(level, lookup)
        for (let at = 0; at < records.length; at += SEGMENT_STRIDE) {
          reaches.push(reachOf(records, at))
        }
      }
    }
    return reaches
  }

  it.each([
    ['the generated world', () => generated],
    ['Earth', () => named('Earth')],
    ['Titan', () => named('Titan')],
  ])('meets the ground without a step at a bed’s edge, on %s', (_, find) => {
    /*
     * A path three half-widths long through a random point of a random reach
     * — a lattice segment or a refined record listed at a survey site — at a
     * random heading, so it crosses both banks, a bend and the reaches beside
     * it. Over a bed the path is read as the water level, under the ground
     * or over it, because the sheet's shoreline is where the level crosses
     * the ground between two vertices and two creeks' levels meet there.
     * Off every bed it is read as the ground, or a lake standing over it:
     * a lake under the ground is ground, and where it starts is
     * `lakeLevelAt`'s business, not this test's. The landform is the one at the path's
     * middle, held, so the walk is all that moves.
     *
     * Each of the eight largest jumps is bisected fifty times, and what
     * survives is the step: at most 9e-9 m on these three bodies, float64
     * arithmetic over an interval of 2⁻⁵⁰ of the path, and `STEP` is that
     * with a hundredfold margin. A level that joins at full height where its
     * bed starts leaves its height over the ground there: 181 m at a lattice
     * bank on Earth, 4.8 m on the generated world and 0.7 m on Titan. A
     * lake's own edge is the lake's reach, tens of kilometers out, and a
     * path that crosses one is not this test's.
     */
    const body = find()
    const graph = graphOf(body)
    const reaches = reachesOf(body)
    expect(reaches.length).toBeGreaterThan(40)
    let wet = 0
    let worst = 0
    fc.assert(
      fc.property(
        fc.nat({ max: reaches.length - 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: Math.PI, noNaN: true }),
        (index, t, heading) => {
          const reach = reaches[index] as Reach
          const middle = Vec.normalize(Vec.lerp(reach.a, reach.b, t))
          const east = Vec.normalize(
            Vec.cross(
              Math.abs(middle.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0),
              middle,
            ),
          )
          const north = Vec.cross(middle, east)
          const across = Vec.add(
            Vec.scale(east, Math.cos(heading)),
            Vec.scale(north, Math.sin(heading)),
          )
          const at = (s: number): Vec3 =>
            Vec.normalize(
              Vec.add(
                middle,
                Vec.scale(across, (s - 0.5) * 3 * reach.halfWidth),
              ),
            )
          const landform = landformAt(body.surface, unwarp(graph, body, middle))
          const lake = (s: number): boolean =>
            Number.isNaN(lakeLevelAt(graph, drainageCell(graph, at(s)), at(s)))
          if (lake(0) !== lake(0.5) || lake(0) !== lake(1)) return
          const read = (s: number): number => {
            const carve = carveDrainage(graph, at(s), landform)
            if (carve.channel > 0) return carve.water
            return Number.isNaN(carve.water)
              ? carve.ground
              : Math.max(carve.ground, carve.water)
          }
          const samples = 300
          const jumps: { s: number; jump: number }[] = []
          let previous = read(0)
          for (let i = 1; i <= samples; i += 1) {
            const here = read(i / samples)
            jumps.push({ s: i / samples, jump: Math.abs(here - previous) })
            previous = here
          }
          if (!Number.isNaN(carveDrainage(graph, middle, landform).water)) {
            wet += 1
          }
          jumps.sort((x, y) => y.jump - x.jump)
          for (const candidate of jumps.slice(0, 8)) {
            let lo = candidate.s - 1 / samples
            let hi = candidate.s
            const atLo = read(lo)
            for (let k = 0; k < 50; k += 1) {
              const mid = (lo + hi) / 2
              if (mid === lo || mid === hi) break
              if (Math.abs(read(mid) - atLo) < candidate.jump / 2) lo = mid
              else hi = mid
            }
            const gap = Math.abs(read(hi) - read(lo))
            if (gap > worst) worst = gap
            expect(gap).toBeLessThan(STEP)
          }
        },
      ),
      { numRuns: 120 },
    )
    // Most paths' middles are on a bed, so most walks cross water.
    // Every path's middle is on its reach's bed, so every walk but one
    // skipped for a lake's edge crosses water.
    expect(wet).toBeGreaterThan(100)
    expect(worst).toBeLessThan(STEP)
  })
})
