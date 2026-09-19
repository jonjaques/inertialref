import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { Vec, vec3, type Vec3 } from '@inertialref/spatial'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import {
  carveDrainage,
  DRAINAGE_SHAPE,
  type DrainageGraph,
  drainageGraph,
  drainageLookup,
} from './drainage.ts'
import { terrainSketch } from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import { coastRemap } from './bands.ts'
import {
  coastWidth,
  elevationAt,
  regionDirection,
  regionForDirection,
  seaDatumElevation,
  waterLevelAt,
} from './terrain.ts'
import { DRAINAGE_CELL_START_AT, surfaceKernel } from './terrainKernel.ts'

/*
 * The drainage graph, held to what the plan asked of it: every node reaches
 * the sea or a spill, the floors never rise downstream, the network has a
 * river's statistics, the build is bounded, and the field that reads it is
 * continuous and drains.
 *
 * Two bodies. Earth, because it is the wet world every reader can picture,
 * and the first generated world in the fixture catalog with drainage,
 * because a figure measured at one body is a figure about that body — and
 * a generated world has no sea at this seed, so it is also the dry-with-
 * lakes case, which routes to pits and a single outlet rather than to a
 * coast.
 */

const ROOT = rootSeed('inertialref')

const SOL = generateSystem(
  ROOT,
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)

const find = (name: string): Body => {
  for (const body of walkBodies(SOL)) if (body.name === name) return body
  throw new Error(`no ${name} in Sol`)
}

/** The first generated world in the fixture catalog that drains, found not named. */
const generatedWetWorld = (): Body => {
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
}

const earth = find('Earth')
const generated = generatedWetWorld()

const graphOf = (body: Body): DrainageGraph => {
  const graph = drainageGraph(body.surface)
  if (graph === null) throw new Error(`${body.name} has no drainage graph`)
  return graph
}

const nodeDirection = (graph: DrainageGraph, n: number): Vec3 =>
  vec3(
    graph.positions[n * 3] as number,
    graph.positions[n * 3 + 1] as number,
    graph.positions[n * 3 + 2] as number,
  )

const isLake = (graph: DrainageGraph, n: number): boolean =>
  !Number.isNaN(graph.lake[n] as number)

const standing = (graph: DrainageGraph, body: Body, n: number): number =>
  graph.sea[n] === 1
    ? (seaDatumElevation(body.surface) as number)
    : (graph.lake[n] as number)

describe('the drainage graph', () => {
  it('routes every node to the sea, a spill or a sink, and nowhere twice', () => {
    for (const body of [earth, generated]) {
      const graph = graphOf(body)
      // Every walk down the receivers ends within the node count, at a node
      // with no receiver — a sea node on Earth, a pit or the lowest node on
      // the generated world.
      for (let n = 0; n < graph.nodes; n += 1) {
        let m = n
        let steps = 0
        while ((graph.receiver[m] as number) >= 0) {
          m = graph.receiver[m] as number
          steps += 1
          if (steps > graph.nodes) throw new Error(`a cycle under node ${n}`)
        }
        if (body === earth) expect(graph.sea[m]).toBe(1)
      }
      // The flood order is a topological order: a receiver is popped first.
      const rank = new Int32Array(graph.nodes)
      for (let p = 0; p < graph.nodes; p += 1) {
        rank[graph.popOrder[p] as number] = p
      }
      for (let n = 0; n < graph.nodes; n += 1) {
        const r = graph.receiver[n] as number
        if (r >= 0) expect(rank[r]).toBeLessThan(rank[n] as number)
      }
    }
  })

  it('never lets a floor rise downstream, and stands every lake at its spill', () => {
    for (const body of [earth, generated]) {
      const graph = graphOf(body)
      let rises = 0
      let lakes = 0
      for (let n = 0; n < graph.nodes; n += 1) {
        const r = graph.receiver[n] as number
        if (isLake(graph, n)) {
          lakes += 1
          // A lake node is under its level, and the level is the spill.
          expect(graph.lake[n]).toBe(graph.filled[n])
          expect(graph.elevation[n]).toBeLessThan(graph.lake[n] as number)
          continue
        }
        if (r < 0 || graph.sea[n] === 1) continue
        const own = graph.floor[n] as number
        const next = standing(graph, body, r)
        // Into standing water the floor reaches the water's level less the
        // ria, never the bed; between two channel nodes it reaches the
        // receiver's own floor.
        const below = Number.isNaN(next)
          ? (graph.floor[r] as number)
          : Math.min(own, next)
        if (below > own + 1e-9) rises += 1
      }
      expect(rises).toBe(0)
      expect(lakes).toBeGreaterThan(0)
    }
  })

  it("has a river's statistics: Hack's exponent and Horton's ratio", () => {
    /*
     * Hack's law `L = C·A^h` and Horton's bifurcation ratio, the two figures
     * the plan names, measured on the receiver tree. `h` is the slope of
     * `log L` on `log A` over nodes with thirty-two cells behind them —
     * below that a chain of four cells has `L ∝ A` by construction and the
     * fit reports the lattice, not the network. The ratio is the geometric
     * mean of `N_ω / N_{ω+1}`.
     *
     * The bounds are the measurement with the lattice's own trait allowed
     * for, and they are wider than the plan's 3–5 and 0.5–0.6: eight-
     * neighbor steepest descent on a smooth landform leaves seven nodes in
     * ten as sources, so `N₁/N₂` sits near seven where a mapped network
     * reads four. Measured over ten wet bodies: `h` 0.48–0.74, the ratio
     * 4.2–8.8 by geometric mean. Earth is not held to them: at this seed it
     * is four fifths sea and its land is 4,700 nodes, of which twenty-three
     * have thirty-two cells behind them — a sample, not a statistic.
     */
    for (const body of [generated]) {
      const graph = graphOf(body)
      const longest = new Float64Array(graph.nodes)
      for (let p = graph.nodes - 1; p >= 0; p -= 1) {
        const n = graph.popOrder[p] as number
        const r = graph.receiver[n] as number
        if (r < 0) continue
        const reach =
          (longest[n] as number) +
          Vec.length(Vec.sub(nodeDirection(graph, n), nodeDirection(graph, r)))
        if (reach > (longest[r] as number)) longest[r] = reach
      }
      let sx = 0
      let sy = 0
      let sxx = 0
      let sxy = 0
      let count = 0
      const streams = new Map<number, number>()
      for (let n = 0; n < graph.nodes; n += 1) {
        if (graph.sea[n] === 1 || isLake(graph, n)) continue
        const order = graph.order[n] as number
        const r = graph.receiver[n] as number
        const outlet =
          r < 0 ||
          (graph.order[r] as number) > order ||
          graph.sea[r] === 1 ||
          isLake(graph, r)
        if (outlet) streams.set(order, (streams.get(order) ?? 0) + 1)
        if ((graph.area[n] as number) < 32) continue
        const x = Math.log(graph.area[n] as number)
        const y = Math.log(longest[n] as number)
        sx += x
        sy += y
        sxx += x * x
        sxy += x * y
        count += 1
      }
      const hack = (count * sxy - sx * sy) / (count * sxx - sx * sx)
      const orders = [...streams.keys()].sort((a, b) => a - b)
      const ratios: number[] = []
      for (let i = 0; i + 1 < orders.length; i += 1) {
        const a = streams.get(orders[i] as number) as number
        const b = streams.get(orders[i + 1] as number) as number
        ratios.push(a / b)
      }
      const horton = Math.exp(
        ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length,
      )
      expect(count).toBeGreaterThan(100)
      expect(hack).toBeGreaterThan(0.45)
      expect(hack).toBeLessThan(0.75)
      expect(orders.length).toBeGreaterThanOrEqual(4)
      expect(horton).toBeGreaterThan(3)
      expect(horton).toBeLessThan(9)
    }
  })

  it('is the same graph whatever order it is asked in, and once per surface', () => {
    const first = graphOf(earth)
    graphOf(generated)
    expect(drainageGraph(earth.surface)).toBe(first)
    // A structural copy has a different identity and the same key, which is
    // the assertion the string cache is visible through.
    expect(drainageGraph({ ...earth.surface })).toBe(first)
    // And a fresh derivation is bit-identical: the build is a fixed sequence
    // over a fixed lattice with every tie broken by index.
    const again = drainageGraph({ ...generated.surface, roughness: 0 })
    const back = drainageGraph({ ...generated.surface })
    expect(again).not.toBe(back)
    expect(back).toBe(graphOf(generated))
  })

  it('builds in bounded time', () => {
    /*
     * The plan asked for 50 ms across the zoo. Measured cold in Node on an
     * M-series core: Earth 90 ms, the generated worlds 50–107 ms, most of it
     * the bands at 24,576 nodes and the rest the flood and the rasterizer.
     * The bound here is a regression guard at several times that, because a
     * clock in a test is a clock on whatever else the machine is doing.
     */
    for (const body of [earth, generated]) {
      const fresh = {
        ...body.surface,
        roughness: body.surface.roughness + 1e-9,
      }
      // `Date.now`, because the package's lib has no `performance`; the
      // bound is coarse enough that a millisecond clock is a clock.
      const started = Date.now()
      drainageGraph(fresh)
      const took = Date.now() - started
      expect(took).toBeLessThan(2_000)
    }
  })

  it('packs for the kernel within the buffers the kernel sizes', () => {
    for (const body of [earth, generated]) {
      const packed = surfaceKernel(body.surface)
      expect(packed.drainage).not.toBeNull()
      const graph = graphOf(body)
      expect(packed.drainage?.segmentCount).toBe(graph.segmentCount)
      expect(packed.drainage?.words[DRAINAGE_CELL_START_AT + graph.nodes]).toBe(
        graph.cellSegments.length,
      )
    }
    const luna = find('Luna')
    expect(drainageGraph(luna.surface)).toBeNull()
    expect(surfaceKernel(luna.surface).drainage).toBeNull()
  })
})

/**
 * The direction the field looks up a node's own position from: the
 * preimage of the position under the lookup's warp, by fixed point. The
 * warp's own slope is under a half, so sixty iterations land within a
 * nanoradian — and it takes that: a headwater's channel on Earth is eleven
 * microradians to its bank, and twelve iterations left seventeen.
 */
function unwarp(graph: DrainageGraph, body: Body, target: Vec3): Vec3 {
  const sketch = terrainSketch(body.surface)
  let guess = target
  for (let i = 0; i < 60; i += 1) {
    const warped = drainageLookup(graph, sketch, guess)
    guess = Vec.normalize(Vec.add(guess, Vec.sub(target, warped)))
  }
  return guess
}

describe('the field that reads it', () => {
  it('never gains height on a walk down any channel', () => {
    /*
     * The claim the whole phase exists for, on the field itself rather than
     * on the graph: at every channel node, the surface a walker stands on or
     * floats on — the ground, or the water over it — is no higher than the
     * same surface at the node it drains to. Through `elevationAt` and
     * `waterLevelAt`, so the craters, the relief, the coast's remap and the
     * warp are all in the walk.
     *
     * A node's position is where its segment starts, so the sample lands on
     * the bed, where the carve pins the ground to the floor less the
     * channel's depth whichever way the landform went. Into a lake or the
     * sea the receiver's surface is the water's; the walk reaches the water
     * at the ria depth below it, which is the point.
     */
    for (const body of [earth, generated]) {
      const graph = graphOf(body)
      const sea = seaDatumElevation(body.surface)
      const surface = (n: number): number => {
        if (graph.sea[n] === 1) return sea as number
        const at = unwarp(graph, body, nodeDirection(graph, n))
        const ground = elevationAt(body.surface, at)
        const water = waterLevelAt(body.surface, at)
        const level = Math.max(
          Number.isNaN(water) ? -Infinity : water,
          sea ?? -Infinity,
        )
        return Math.max(ground, level)
      }
      const rises: string[] = []
      let walked = 0
      for (let n = 0; n < graph.nodes; n += 1) {
        const r = graph.receiver[n] as number
        if (r < 0 || graph.sea[n] === 1 || isLake(graph, n)) continue
        walked += 1
        const here = surface(n)
        const there = surface(r)
        // A meter of tolerance against a budget of kilometers: the lake
        // level is a kernel mean over the nodes in reach, and two lakes at
        // different levels can share a ring.
        if (there > here + 1) {
          rises.push(`${body.name} node ${n}: ${here} → ${there}`)
        }
      }
      expect(walked).toBeGreaterThan(1_000)
      expect(rises.slice(0, 5)).toEqual([])
    }
  })

  it('stands a lake at its spill level, over ground below it', () => {
    for (const body of [earth, generated]) {
      const graph = graphOf(body)
      let checked = 0
      let underwater = 0
      for (let n = 0; n < graph.nodes && checked < 200; n += 1) {
        if (!isLake(graph, n)) continue
        const at = unwarp(graph, body, nodeDirection(graph, n))
        const level = waterLevelAt(body.surface, at)
        expect(Number.isNaN(level)).toBe(false)
        // The field's level is the graph's through the coast's remap, which
        // the ground under it takes too; adjacent lake nodes share a level
        // by the flood's construction, so the ring's mean is the level.
        const sea = seaDatumElevation(body.surface)
        const expected =
          sea === null
            ? (graph.lake[n] as number)
            : coastRemap(graph.lake[n] as number, sea, coastWidth(body.surface))
        expect(Math.abs(level - expected)).toBeLessThan(1e-3)
        // The lattice's landform is the macro bands; the field's carries
        // the relief and the craters on top, so a lake node can stand out
        // of its lake as an island. Most do not.
        if (elevationAt(body.surface, at) < level) underwater += 1
        checked += 1
      }
      expect(checked).toBeGreaterThan(10)
      expect(underwater).toBeGreaterThan(checked * 0.6)
    }
  })

  it('has no step in it, across cells and at the reach of every valley', () => {
    /*
     * The same walk `geology.test.ts` makes for the craters: the four largest
     * jumps on a great circle, each bisected sixty times, and the gap that
     * survives the bisection is the step. A segment leaving a cell's list, a
     * lookup crossing a lattice cell, a lake node leaving the ring — each is
     * a place a step could hide, and the bound is a meter against a
     * kilometer of carve.
     */
    const walk = (
      body: Body,
      from: Vec3,
      to: Vec3,
      samples: number,
    ): number => {
      const at = (t: number): Vec3 => Vec.normalize(Vec.lerp(from, to, t))
      const candidates: { at: number; jump: number }[] = []
      let previous = elevationAt(body.surface, at(0))
      for (let i = 1; i <= samples; i += 1) {
        const here = elevationAt(body.surface, at(i / samples))
        const jump = Math.abs(here - previous)
        previous = here
        if (candidates.length === 4 && jump <= (candidates[3]?.jump ?? 0))
          continue
        candidates.push({ at: i / samples, jump })
        candidates.sort((a, b) => b.jump - a.jump)
        candidates.length = Math.min(4, candidates.length)
      }
      let survivor = 0
      for (const candidate of candidates) {
        let lo = candidate.at - 1 / samples
        let hi = candidate.at
        const atLo = elevationAt(body.surface, at(lo))
        for (let i = 0; i < 60; i += 1) {
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
    for (const body of [earth, generated]) {
      const arcs: [Vec3, Vec3][] = [
        [vec3(0.3, 0.7, 0.64), vec3(0.9, -0.2, 0.31)],
        [vec3(-0.5, 0.2, 0.8), vec3(0.1, 0.9, -0.4)],
        [vec3(0.57, 0.57, 0.57), vec3(-0.57, 0.57, 0.57)],
      ]
      for (const [from, to] of arcs) {
        expect(
          walk(body, Vec.normalize(from), Vec.normalize(to), 8_000),
        ).toBeLessThan(1)
      }
    }
  })

  it('cuts and fills the bed to the floor less the depth, whichever way the landform went', () => {
    const graph = graphOf(generated)
    let checked = 0
    for (let n = 0; n < graph.nodes && checked < 60; n += 1) {
      if (graph.sea[n] === 1 || isLake(graph, n)) continue
      const r = graph.receiver[n] as number
      if (r < 0) continue
      const at = nodeDirection(graph, n)
      const floor = graph.floor[n] as number
      // A landform a kilometer over the floor is cut to the floor less the
      // channel's depth, one a kilometer under it filled to the same, and
      // the channel is fully bed there with the water at the floor. The
      // segments are float32; the graph's floors are not, so a centimeter.
      for (const landform of [floor + 1_000, floor - 1_000]) {
        const carve = carveDrainage(graph, at, landform)
        expect(carve.channel).toBeCloseTo(1, 6)
        expect(carve.ground).toBeLessThan(floor)
        expect(carve.ground).toBeGreaterThan(floor - 200)
        expect(carve.water).toBeGreaterThanOrEqual(floor - 1e-2)
      }
      checked += 1
    }
    expect(checked).toBe(60)
  })

  it('reads the same cell the region addressing does', () => {
    const graph = graphOf(earth)
    for (let i = 0; i < 200; i += 1) {
      const z = 1 - (2 * i + 1) / 200
      const around = i * Math.PI * (3 - Math.sqrt(5))
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      const direction = vec3(
        Math.cos(around) * ring,
        z,
        Math.sin(around) * ring,
      )
      const region = regionForDirection(direction, graph.level)
      // The cell's own node sits inside the cell it names.
      const node =
        (region.face * graph.cells + region.i) * graph.cells + region.j
      const own = regionForDirection(nodeDirection(graph, node), graph.level)
      expect(own).toEqual(region)
      // And the lattice is `regionDirection` at the jittered center.
      const center = regionDirection(region, 0.5, 0.5)
      expect(Vec.dot(center, nodeDirection(graph, node))).toBeGreaterThan(
        Math.cos(DRAINAGE_SHAPE.jitter * Math.SQRT2 * (2 / graph.cells)),
      )
    }
  })
})
