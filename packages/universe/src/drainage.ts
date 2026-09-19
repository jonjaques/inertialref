import type { Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import {
  formatSeed,
  noise3,
  pcg4d,
  smoothstep,
  toUnit,
} from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import {
  beltBand,
  hypsometryBand,
  iceBand,
  plateContext,
  reliefBand,
  volcanicBand,
} from './bands.ts'
import { bareGround, type StageContext, stageOn } from './bandStack.ts'
import { ladderField, softLimit } from './craters.ts'
import { type TerrainSketch, terrainSketch } from './sketch.ts'
import type { SurfaceParameters } from './system.ts'
import {
  coastWidth,
  drainageDatum,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  seaDatumElevation,
} from './terrain.ts'

/*
 * The drainage graph: where a body's rivers run, and which way is downhill.
 *
 * Every band in the stack is a pure function of a direction, and that is the
 * one thing a river cannot be. A valley drawn as the zero strip of a noise
 * branches and meanders and never ends on a plain, but its floor is the
 * landform minus a fraction, so along its own length it runs uphill and
 * downhill and reads, from the ground, as a chain of ponds in a trench. A
 * river's floor is a datum *along the channel*, monotone to the sea, and the
 * ground is cut to it. That needs a structure with a direction in it, built
 * once per body: this one.
 *
 * **It is built on the CPU, in float64, once per body, in bounded time, and
 * the field samples it.** A node per cell of a cube-sphere lattice, each with
 * the macro landform under it; a priority flood from the sea that gives every
 * node a receiver and a spill level, so nothing drains into a pit; the
 * upstream area by one pass down the receiver tree; and the channel floor by
 * one pass up it — a steady-state stream-power profile in closed form, capped
 * so it never cuts further below the landform than the budget allows. A
 * droplet or pipe-model simulation would accumulate through unordered
 * writes and its result would be a schedule; this is a fixed sequence over a
 * fixed lattice and the same graph comes out on every worker.
 *
 * **What the field reads is segments in cells.** A node and its receiver are
 * a segment carrying a floor at each end that never rises downstream, a
 * channel width and depth from the upstream area, and every cell lists the
 * segments whose valley reaches into it. A sample finds its cell, walks that
 * list, and takes the deepest cut — the crater rule restated: every profile
 * reaches zero before the list's reach bound, so a segment leaving the set is
 * not a step, and the cell decision can be taken in a float because both
 * candidate cells at a boundary list every segment within reach of it.
 *
 * **Memoized beside the sketch and not on it.** `sketch.ts` is imported by
 * `bands.ts` at module load — `HYPSOMETRY_MARGIN` is `PLATE_MARGIN` — and
 * this module reads the bands, so a graph derived inside `derive` would be a
 * cycle that trips at import time. The two memos have the same shape and the
 * same reason: a worker rebuilds `SurfaceParameters` from its payload per
 * task, so the object key alone would rebuild the graph per patch.
 */

/**
 * The numbers the graph is built and read with. Exported for the reason
 * `bands.ts` gives: the TSL port in `apps/game/src/render/terrainKernel.ts`
 * reads the same constants and a tolerance test holds the two together.
 */
export const DRAINAGE_SHAPE = {
  /**
   * Cells per face edge of the lattice — 6 × 64², 24,576 nodes. A cell is
   * 156 km on Earth and 43 km on Luna, and the build across the zoo is what
   * sets it: the macro bands at every node are most of the cost, and the
   * flood is `n log n` over them. The plan's 128 is four times the nodes
   * and measured at four times the time; the lattice size is the CPU's
   * budget, and this is where it lands today.
   */
  lattice: 64,
  /** How far a node sits from its cell's center, in cells, per axis. */
  jitter: 0.25,
  /** The valley's half-width — where the carve reaches zero — in cells. */
  reach: 0.6,
  /** The deepest cut at full drainage, as a fraction of the relief budget. */
  depth: 0.13,
  /** How much of the ground's height above base a channel may take. */
  headGain: 0.85,
  /** Upstream area, in cells, at which a channel earns its full cut. */
  cutArea: 64,
  cutPower: 0.35,
  /**
   * Flint's law: the channel slope is `S₀ · A^(−θ)` with `A` in cells and
   * `S₀ = slopeGain · budget / R` — the landform's own characteristic slope
   * times a gain, so a one-cell headwater climbs steeply and a thousand-cell
   * trunk climbs at a twentieth of that.
   */
  slopeGain: 40,
  concavity: 0.45,
  /**
   * Hydraulic geometry (Leopold & Maddock 1953): channel width
   * `w = a · Q^0.5`, depth `h = c · Q^0.4`, discharge `Q = p · A`. `widthGain`
   * is the full width in meters per √(m²) of area at a meter a year of rain;
   * a 10⁶ km² catchment comes out 900 m wide and 25 m deep, which is the
   * Mississippi's order.
   */
  widthGain: 9e-4,
  depthGain: 0.4,
  depthPower: 0.4,
  /** A meter a year, in meters a second. */
  precipitation: 3.2e-8,
  /** The floodplain's half-width, in channel widths: the meander belt. */
  floodplain: 9,
  /** Where the bank starts, as a fraction of the channel half-width. */
  bank: 0.6,
  /**
   * How far below its base level a river reaches the sea or a lake, as a
   * fraction of the coast width: the valley is cut before the water rose
   * into it, and the sea floods the last of it — a ria.
   */
  ria: 0.5,
  /**
   * A fill shallower than this fraction of the relief budget is a flat the
   * river crosses at its spill level and not a lake: a noise pit filled by
   * a few meters is a plain, and on a dry world with one outlet every pit
   * fills, so without the floor a fifth of Titan stood under a film.
   */
  lakeFloor: 0.0025,
  /** How far a lake node's level reaches, in cells. */
  lakeReach: 1.2,
  /**
   * A warp under the lookup, so a segment between two nodes is a meander
   * rather than a chord: cycles per cell and amplitude in cells. Small
   * enough that the map stays one to one, which is what keeps a monotone
   * floor monotone along the warped channel.
   */
  warpCycles: 3,
  warpAmount: 0.12,
} as const

/** Floats per segment record: `[ax ay az fA] [bx by bz fB] [wA wB hA hB]`. */
export const SEGMENT_STRIDE = 12

/** The graph, as the arrays the field and the tests read. */
export interface DrainageGraph {
  /** Cells per face edge. */
  readonly cells: number
  /** The region level the lattice cells are addressed at: `log2(cells)`. */
  readonly level: number
  /** `6 · cells²`. */
  readonly nodes: number
  /** Unit direction per node, jittered inside its cell, three per node. */
  readonly positions: Float64Array
  /** The macro landform at the node, meters. */
  readonly elevation: Float64Array
  /** The spill level: the landform or the water standing over it. */
  readonly filled: Float64Array
  /** The node each drains to, or −1 at a sink. */
  readonly receiver: Int32Array
  /** Upstream area, in cells, the node's own included. */
  readonly area: Float64Array
  /** Strahler order, one at a headwater. */
  readonly order: Uint8Array
  /** The channel floor at the node, meters. */
  readonly floor: Float64Array
  /** The lake level where the node is under standing water, else NaN. */
  readonly lake: Float64Array
  /** Whether the node is under the sea. */
  readonly sea: Uint8Array
  /** The nodes in flood order, downstream first: a topological order. */
  readonly popOrder: Int32Array
  /** Mean cell size on the ground, meters. */
  readonly cellMeters: Meters
  /** The valley half-width every segment carves over, radians. */
  readonly reach: number
  readonly segments: Float32Array
  readonly segmentCount: number
  /** `nodes + 1` offsets into `cellSegments`. */
  readonly cellStart: Uint32Array
  readonly cellSegments: Uint32Array
}

/*
 * The lattice's topology, once per lattice size and shared by every body.
 *
 * Eight neighbors per node through `regionNeighbor`, which wraps onto the
 * adjacent face by direction rather than by a rotation table. At a cube
 * corner three faces meet and a cell has seven neighbors rather than eight:
 * the diagonal step off the corner repeats one of the three, and the repeat
 * is written as −1 so a walk visits nothing twice.
 */
interface Topology {
  readonly level: number
  readonly neighbors: Int32Array
  /**
   * Nine unit directions per cell — the center, the four edge midpoints and
   * the four corners, three floats each — for the rasterizer, which asks
   * whether a segment's valley reaches a cell by the cell's own extent
   * rather than by a bound on it.
   */
  readonly extent: Float64Array
}

const TOPOLOGIES = new Map<number, Topology>()

const OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
]

function topology(cells: number): Topology {
  const known = TOPOLOGIES.get(cells)
  if (known !== undefined) return known
  const level = Math.log2(cells)
  invariant(Number.isInteger(level), `The lattice must be a power of two`)
  const nodes = 6 * cells * cells
  const neighbors = new Int32Array(nodes * 8).fill(-1)
  const extent = new Float64Array(nodes * MARKS * 3)
  for (let face = 0; face < 6; face += 1) {
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        const node = (face * cells + i) * cells + j
        const region = regionAddress(face, level, i, j)
        CORNERS.forEach(([s, t], k) => {
          const direction = regionDirection(region, s, t)
          extent[(node * MARKS + k) * 3] = direction.x
          extent[(node * MARKS + k) * 3 + 1] = direction.y
          extent[(node * MARKS + k) * 3 + 2] = direction.z
        })
        for (let k = 0; k < 8; k += 1) {
          const [di, dj] = OFFSETS[k] as readonly [number, number]
          const other = regionNeighbor(region, di, dj)
          const index = (other.face * cells + other.i) * cells + other.j
          if (index === node) continue
          let seen = false
          for (let m = 0; m < k; m += 1) {
            if (neighbors[node * 8 + m] === index) seen = true
          }
          if (!seen) neighbors[node * 8 + k] = index
        }
      }
    }
  }
  const built = { level, neighbors, extent }
  TOPOLOGIES.set(cells, built)
  return built
}

/** The center first, then a corner, then the rest; `reaches` reads them so. */
const CORNERS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [0.5, 0],
  [0.5, 1],
  [0, 0.5],
  [1, 0.5],
]
const MARKS = CORNERS.length

/**
 * The macro landform at a lattice node: every stage of the stack before the
 * drainage, read at the lattice's own wavelength floor, plus the crater
 * rungs coarse enough to hold a lake.
 *
 * The same expression `evaluate` sums and in the same order, with two
 * differences a lattice node earns. An octave finer than a cell is relief
 * the flow routing cannot see and would pay for at every node, so each band
 * stops at the cell size. And the crater ladder is walked only over the
 * rungs whose craters span two cells or more: those are the basins that
 * flood — a below-datum floor a thousand kilometers inland is a lake at its
 * own spill and not at the sea's — and the finer rungs are a hundred cell
 * tests a node for craters no node can resolve.
 */
function latticeLandform(
  surface: SurfaceParameters,
  sketch: TerrainSketch,
  stack: StageContext,
  direction: Vec3,
  floor: Meters,
  coarseRungs: number,
): Meters {
  const grammar = surface.grammar
  const budget = surface.maxElevation
  const bands = grammar.bands
  const plates = plateContext(sketch, direction)
  let height =
    bands.hypsometry *
      hypsometryBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.hypsometry * budget,
        floor,
      ) +
    bands.belts *
      beltBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.belts * budget,
        floor,
      ) +
    bands.volcanism *
      volcanicBand(
        sketch,
        grammar,
        plates,
        direction,
        bands.volcanism * budget,
        floor,
      ) +
    bands.relief *
      reliefBand(
        sketch,
        grammar,
        surface.roughness,
        direction,
        bands.relief * budget,
        floor,
      )
  if (stageOn('ice', stack)) {
    height +=
      bands.ice * iceBand(sketch, grammar, direction, bands.ice * budget, floor)
  }
  let elevation = height * budget
  if (coarseRungs > 0) {
    elevation += softLimit(
      ladderField(
        sketch.latticeSeed,
        sketch.craterLevels.slice(0, coarseRungs),
        0,
        grammar,
        direction,
        0,
      ),
      bands.craters * budget,
    )
  }
  return elevation
}

/*
 * A binary heap of (level, node), lowest first, ties by node index.
 *
 * The tie-break is the determinism: two nodes at one level are popped in
 * index order whatever order they were pushed in, so the receiver a flat
 * hands its neighbors is a property of the lattice and not of the walk.
 */
class Heap {
  readonly #level: Float64Array
  readonly #node: Int32Array
  #size = 0

  constructor(capacity: number) {
    this.#level = new Float64Array(capacity)
    this.#node = new Int32Array(capacity)
  }

  get size(): number {
    return this.#size
  }

  #less(a: number, b: number): boolean {
    const la = this.#level[a] as number
    const lb = this.#level[b] as number
    if (la !== lb) return la < lb
    return (this.#node[a] as number) < (this.#node[b] as number)
  }

  #swap(a: number, b: number): void {
    const level = this.#level[a] as number
    const node = this.#node[a] as number
    this.#level[a] = this.#level[b] as number
    this.#node[a] = this.#node[b] as number
    this.#level[b] = level
    this.#node[b] = node
  }

  push(level: number, node: number): void {
    let at = this.#size
    this.#size += 1
    this.#level[at] = level
    this.#node[at] = node
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!this.#less(at, parent)) break
      this.#swap(at, parent)
      at = parent
    }
  }

  /** Removes the top and returns its node; the level is read by `topLevel` first. */
  topLevel(): number {
    return this.#level[0] as number
  }

  pop(): number {
    const node = this.#node[0] as number
    this.#size -= 1
    if (this.#size > 0) {
      this.#level[0] = this.#level[this.#size] as number
      this.#node[0] = this.#node[this.#size] as number
      let at = 0
      for (;;) {
        const left = at * 2 + 1
        const right = left + 1
        let best = at
        if (left < this.#size && this.#less(left, best)) best = left
        if (right < this.#size && this.#less(right, best)) best = right
        if (best === at) break
        this.#swap(at, best)
        at = best
      }
    }
    return node
  }
}

/** Chord between two unit directions held as flat arrays, radians to first order. */
function chord(positions: Float64Array, a: number, b: number): number {
  const dx = (positions[a * 3] as number) - (positions[b * 3] as number)
  const dy = (positions[a * 3 + 1] as number) - (positions[b * 3 + 1] as number)
  const dz = (positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * The channel's half-width at an upstream area, radians on the unit sphere.
 *
 * `w = a·Q^0.5` with `Q = p·A`: the root of the area times a gain, halved
 * for the half-width and divided by the radius for an angle.
 */
export function channelHalfWidth(areaMeters: number, radius: Meters): number {
  return (0.5 * DRAINAGE_SHAPE.widthGain * Math.sqrt(areaMeters)) / radius
}

/** The channel's depth at an upstream area, meters: `h = c·Q^0.4`. */
export function channelDepth(areaMeters: number): Meters {
  return (
    DRAINAGE_SHAPE.depthGain *
    (DRAINAGE_SHAPE.precipitation * areaMeters) ** DRAINAGE_SHAPE.depthPower
  )
}

function build(surface: SurfaceParameters): DrainageGraph | null {
  const grammar = surface.grammar
  if (bareGround(surface) || grammar.drainage <= 0) return null
  const sketch = terrainSketch(surface)
  const cells = DRAINAGE_SHAPE.lattice
  const { level, neighbors, extent } = topology(cells)
  const nodes = 6 * cells * cells
  const radius = grammar.meanRadius
  const budget = surface.maxElevation
  const cellAngle = Math.PI / 2 / cells
  const cellMeters = radius * cellAngle
  const cellArea = (4 * Math.PI * radius * radius) / nodes
  const sea = seaDatumElevation(surface)
  const stack: StageContext = { surface, sketch, sea, seabed: false }

  /* --- the lattice --------------------------------------------------------- */

  const positions = new Float64Array(nodes * 3)
  const elevation = new Float64Array(nodes)
  const seedLane = sketch.latticeSeed
  let coarseRungs = 0
  if (stageOn('craters', stack)) {
    for (const rung of sketch.craterLevels) {
      if (rung.diameter < 2 * cellMeters) break
      coarseRungs += 1
    }
  }
  for (let face = 0; face < 6; face += 1) {
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        const node = (face * cells + i) * cells + j
        // Jittered inside its cell so the network is not a grid. The hash is
        // the lattice's own, on a lane no crater rung reaches.
        const hash = pcg4d(i ^ seedLane, j, face, 977)
        const jx = (toUnit(hash.x) * 2 - 1) * DRAINAGE_SHAPE.jitter
        const jy = (toUnit(hash.y) * 2 - 1) * DRAINAGE_SHAPE.jitter
        const direction = regionDirection(
          regionAddress(face, level, i, j),
          0.5 + jx,
          0.5 + jy,
        )
        positions[node * 3] = direction.x
        positions[node * 3 + 1] = direction.y
        positions[node * 3 + 2] = direction.z
        elevation[node] = latticeLandform(
          surface,
          sketch,
          stack,
          direction,
          cellMeters,
          coarseRungs,
        )
      }
    }
  }

  /* --- the flood ----------------------------------------------------------- */

  /*
   * Priority-flood from the base level (Barnes, Lehman & Mullins 2014). The
   * sea's nodes are the seeds on a wet world; on a dry one the pits at or
   * below the drainage datum are, and a world with none of those drains to
   * its single lowest node. Every other node is reached from a lower one, so
   * every node has a receiver and a spill level, and a node under its spill
   * level is a lake floor. A stream-power scheme without this step traps its
   * water in every pit of the landform and erodes only at the first cliff.
   */
  const filled = new Float64Array(nodes)
  const receiver = new Int32Array(nodes).fill(-1)
  const isSea = new Uint8Array(nodes)
  const queued = new Uint8Array(nodes)
  const heap = new Heap(nodes)
  const datum = drainageDatum(surface)
  if (sea !== null) {
    for (let n = 0; n < nodes; n += 1) {
      if ((elevation[n] as number) <= sea) {
        isSea[n] = 1
        queued[n] = 1
        heap.push(sea, n)
      }
    }
  }
  if (heap.size === 0) {
    let lowest = 0
    for (let n = 0; n < nodes; n += 1) {
      if ((elevation[n] as number) < (elevation[lowest] as number)) lowest = n
      if ((elevation[n] as number) > datum) continue
      let pit = true
      for (let k = 0; k < 8; k += 1) {
        const m = neighbors[n * 8 + k] as number
        if (m >= 0 && (elevation[m] as number) < (elevation[n] as number)) {
          pit = false
          break
        }
      }
      if (pit) {
        queued[n] = 1
        heap.push(elevation[n] as number, n)
      }
    }
    if (heap.size === 0) {
      queued[lowest] = 1
      heap.push(elevation[lowest] as number, lowest)
    }
  }
  const popOrder = new Int32Array(nodes)
  const done = new Uint8Array(nodes)
  let popped = 0
  while (heap.size > 0) {
    const level = heap.topLevel()
    const n = heap.pop()
    done[n] = 1
    filled[n] = level
    popOrder[popped] = n
    popped += 1
    for (let k = 0; k < 8; k += 1) {
      const m = neighbors[n * 8 + k] as number
      if (m < 0 || queued[m] === 1) continue
      queued[m] = 1
      receiver[m] = n
      heap.push(Math.max(elevation[m] as number, level), m)
    }
  }
  invariant(popped === nodes, `the flood left ${nodes - popped} nodes dry`)

  /*
   * The receiver, re-chosen as the steepest descent over the filled surface
   * where one exists. The flood's receiver is the neighbor a node was first
   * reached from, which is a path out and not the steepest one; steepest
   * descent is what makes a network branch like a river's rather than like a
   * flood front. A node with no strictly lower neighbor — a lake floor, a
   * flat — keeps the flood's, which is the only receiver that is guaranteed
   * to lead somewhere. Both kinds point at a node popped earlier, so the pop
   * order stays a topological order of the tree.
   */
  for (let n = 0; n < nodes; n += 1) {
    if (receiver[n] === -1) continue
    const here = filled[n] as number
    let best = -1
    let steepest = 0
    for (let k = 0; k < 8; k += 1) {
      const m = neighbors[n * 8 + k] as number
      if (m < 0) continue
      const drop = here - (filled[m] as number)
      if (drop <= 0) continue
      const slope = drop / chord(positions, n, m)
      if (slope > steepest) {
        steepest = slope
        best = m
      }
    }
    if (best >= 0) receiver[n] = best
  }

  /* --- accumulation -------------------------------------------------------- */

  const area = new Float64Array(nodes).fill(1)
  const order = new Uint8Array(nodes).fill(1)
  const highest = new Uint8Array(nodes)
  const highestCount = new Uint8Array(nodes)
  for (let p = nodes - 1; p >= 0; p -= 1) {
    const n = popOrder[p] as number
    // Strahler: the order of the largest tributary, plus one where two of
    // them tie. `highest` and `highestCount` are the running maximum over
    // the children that have already been folded in.
    const own = highest[n] as number
    if (own > 0) {
      order[n] = (highestCount[n] as number) >= 2 ? own + 1 : own
    }
    const r = receiver[n] as number
    if (r < 0) continue
    area[r] = (area[r] as number) + (area[n] as number)
    const mine = order[n] as number
    if (mine > (highest[r] as number)) {
      highest[r] = mine
      highestCount[r] = 1
    } else if (mine === (highest[r] as number)) {
      highestCount[r] = (highestCount[r] as number) + 1
    }
  }

  /* --- incision ------------------------------------------------------------ */

  /*
   * The floor, up the tree from its outlets. At a node it is the lesser of
   * two things: the Flint climb from the receiver's floor, `S(A)·ds` with
   * `S = S₀·A^(−θ)`, and the landform less a cut that grows with the area
   * and shallows to nothing at the node's own base level. The first is the
   * steady-state profile — a trunk with a thousand cells behind it climbs
   * slowly and cuts a canyon through ground that climbs faster — and the
   * second is what stops a headwater with a steep Flint slope from cutting
   * to the budget everywhere. Each term is at least the receiver's floor:
   * the climb by construction, the cap because the cut's slope in the
   * height above base is under one. So the floor never rises downstream.
   *
   * A node under standing water keeps the landform as its floor and the
   * profile climbs from the water's level less a ria depth instead — a river
   * reaches a lake at the lake's level and not at its bed.
   */
  const floor = new Float64Array(nodes)
  const lake = new Float64Array(nodes).fill(Number.NaN)
  const base = new Float64Array(nodes)
  const deepest = DRAINAGE_SHAPE.depth * budget * grammar.drainage
  const slopeZero = (DRAINAGE_SHAPE.slopeGain * budget) / radius
  const ria = DRAINAGE_SHAPE.ria * coastWidth(surface)
  const lakeFloor = Math.max(1, DRAINAGE_SHAPE.lakeFloor * budget)
  for (let p = 0; p < nodes; p += 1) {
    const n = popOrder[p] as number
    const z = elevation[n] as number
    const spill = filled[n] as number
    if (isSea[n] === 1) {
      floor[n] = z
      base[n] = sea as number
      continue
    }
    if (spill - z > lakeFloor) {
      lake[n] = spill
      floor[n] = z
      base[n] = spill
      continue
    }
    const r = receiver[n] as number
    if (r < 0) {
      floor[n] = z
      base[n] = z
      continue
    }
    base[n] = base[r] as number
    const standing = isSea[r] === 1 ? (sea as number) : (lake[r] as number)
    const from = Number.isNaN(standing)
      ? (floor[r] as number)
      : Math.max(floor[r] as number, standing - ria)
    const cellsUpstream = area[n] as number
    const slope = slopeZero * cellsUpstream ** -DRAINAGE_SHAPE.concavity
    const climb = from + slope * chord(positions, n, r) * radius
    const above = Math.max(0, spill - (base[n] as number))
    const gain = Math.min(
      1,
      (cellsUpstream / DRAINAGE_SHAPE.cutArea) ** DRAINAGE_SHAPE.cutPower,
    )
    const cut =
      deepest *
      gain *
      (1 - Math.exp((-DRAINAGE_SHAPE.headGain * above) / deepest))
    floor[n] = Math.min(spill - cut, climb)
  }

  /* --- segments in cells --------------------------------------------------- */

  /*
   * One segment per node that drains overland: the node to its receiver,
   * with the floor, channel half-width and depth at each end. Sea and lake
   * nodes make none — the sheet covers them — and a node's segment into a
   * lake or the sea ends at the ria depth rather than at the seabed, so a
   * river meets the water it drains to and does not cut a submarine canyon
   * to the abyssal node it was routed through.
   *
   * Each segment is then listed in every cell its valley can reach: the
   * cells within two steps of either end whose node sits within the reach
   * plus a cell's own half-diagonal plus the jitter of the segment's chord.
   * Conservative by that margin on purpose — a sample takes its cell in a
   * float, and the two cells it could name at a boundary must both list
   * everything within reach of that boundary.
   */
  const reach = DRAINAGE_SHAPE.reach * cellAngle
  const halfWidth = new Float64Array(nodes)
  const depth = new Float64Array(nodes)
  for (let n = 0; n < nodes; n += 1) {
    const meters = (area[n] as number) * cellArea
    halfWidth[n] = channelHalfWidth(meters, radius)
    depth[n] = channelDepth(meters)
  }
  const segmentOf = new Int32Array(nodes).fill(-1)
  let segmentCount = 0
  for (let n = 0; n < nodes; n += 1) {
    if (isSea[n] === 1 || !Number.isNaN(lake[n] as number)) continue
    if ((receiver[n] as number) < 0) continue
    segmentOf[n] = segmentCount
    segmentCount += 1
  }
  const segments = new Float32Array(segmentCount * SEGMENT_STRIDE)
  for (let n = 0; n < nodes; n += 1) {
    const s = segmentOf[n] as number
    if (s < 0) continue
    const r = receiver[n] as number
    const standing = isSea[r] === 1 ? (sea as number) : (lake[r] as number)
    const fB = Number.isNaN(standing)
      ? (floor[r] as number)
      : Math.max(floor[r] as number, standing - ria)
    const at = s * SEGMENT_STRIDE
    segments[at] = positions[n * 3] as number
    segments[at + 1] = positions[n * 3 + 1] as number
    segments[at + 2] = positions[n * 3 + 2] as number
    segments[at + 3] = floor[n] as number
    segments[at + 4] = positions[r * 3] as number
    segments[at + 5] = positions[r * 3 + 1] as number
    segments[at + 6] = positions[r * 3 + 2] as number
    segments[at + 7] = fB
    segments[at + 8] = halfWidth[n] as number
    segments[at + 9] = halfWidth[r] as number
    segments[at + 10] = depth[n] as number
    segments[at + 11] = depth[r] as number
  }

  /*
   * A cell lists a segment when the valley reaches any of the cell's five
   * marks — its center and its four corners — or the chord passes closer to
   * the center than the cell's own half-diagonal, which is the case of a
   * segment crossing the cell between the marks. Counted first and filled
   * second, into two flat arrays, so the build allocates nothing per cell.
   */
  const stamp = new Int32Array(nodes).fill(-1)
  const candidates = new Int32Array(64)
  const counts = new Uint32Array(nodes)
  const gather = (n: number, r: number): number => {
    let count = 0
    stamp[n] = n
    candidates[count] = n
    count += 1
    if (stamp[r] !== n) {
      stamp[r] = n
      candidates[count] = r
      count += 1
    }
    const first = count
    for (let k = 0; k < first; k += 1) {
      const c = candidates[k] as number
      for (let m = 0; m < 8; m += 1) {
        const o = neighbors[c * 8 + m] as number
        if (o < 0 || stamp[o] === n) continue
        stamp[o] = n
        candidates[count] = o
        count += 1
      }
    }
    const second = count
    for (let k = first; k < second; k += 1) {
      const c = candidates[k] as number
      for (let m = 0; m < 8; m += 1) {
        const o = neighbors[c * 8 + m] as number
        if (o < 0 || stamp[o] === n) continue
        stamp[o] = n
        candidates[count] = o
        count += 1
      }
    }
    return count
  }
  const reaches = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    length: number,
    c: number,
  ): boolean => {
    const base = c * MARKS * 3
    const cx = extent[base] as number
    const cy = extent[base + 1] as number
    const cz = extent[base + 2] as number
    // The cell's half-diagonal, from the first corner.
    const kx = (extent[base + 3] as number) - cx
    const ky = (extent[base + 4] as number) - cy
    const kz = (extent[base + 5] as number) - cz
    const halfDiagonal = Math.sqrt(kx * kx + ky * ky + kz * kz)
    // Nine marks on a three-by-three grid over the cell: no point of it is
    // farther than half the half-diagonal from the nearest mark, so a mark
    // within the reach plus that is the conservative test — and the center
    // alone rejects a cell wholly out of range before the eight are read.
    const slack = halfDiagonal / 2
    for (let k = 0; k < MARKS; k += 1) {
      const px = (extent[base + k * 3] as number) - ax
      const py = (extent[base + k * 3 + 1] as number) - ay
      const pz = (extent[base + k * 3 + 2] as number) - az
      const t =
        length > 0
          ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / length))
          : 0
      const ex = px - bx * t
      const ey = py - by * t
      const ez = pz - bz * t
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
      if (d <= reach + slack) return true
      if (k === 0 && d > reach + halfDiagonal) return false
    }
    return false
  }
  const rasterize = (
    fill: Uint32Array | null,
    starts: Uint32Array | null,
  ): void => {
    for (let n = 0; n < nodes; n += 1) {
      const s = segmentOf[n] as number
      if (s < 0) continue
      const r = receiver[n] as number
      const count = gather(n, r)
      const ax = positions[n * 3] as number
      const ay = positions[n * 3 + 1] as number
      const az = positions[n * 3 + 2] as number
      const bx = (positions[r * 3] as number) - ax
      const by = (positions[r * 3 + 1] as number) - ay
      const bz = (positions[r * 3 + 2] as number) - az
      const length = bx * bx + by * by + bz * bz
      for (let k = 0; k < count; k += 1) {
        const c = candidates[k] as number
        if (!reaches(ax, ay, az, bx, by, bz, length, c)) continue
        if (fill === null || starts === null) {
          counts[c] = (counts[c] as number) + 1
        } else {
          fill[starts[c] as number] = s
          starts[c] = (starts[c] as number) + 1
        }
      }
    }
  }
  rasterize(null, null)
  const cellStart = new Uint32Array(nodes + 1)
  for (let c = 0; c < nodes; c += 1) {
    cellStart[c + 1] = (cellStart[c] as number) + (counts[c] as number)
  }
  const cellSegments = new Uint32Array(cellStart[nodes] as number)
  rasterize(cellSegments, cellStart.slice(0, nodes))

  return {
    cells,
    level,
    nodes,
    positions,
    elevation,
    filled,
    receiver,
    area,
    order,
    floor,
    lake,
    sea: isSea,
    popOrder,
    cellMeters,
    reach,
    segments,
    segmentCount,
    cellStart,
    cellSegments,
  }
}

/*
 * Memoized twice over, as the sketch is and for the same two reasons: the
 * string cache because a worker rebuilds `SurfaceParameters` per task, the
 * `WeakMap` because the field resolves the graph per sample. The key is
 * everything the build reads, and the grammar goes in whole for the reason
 * `surveySites` gives — the build reads most of it.
 */
const BY_SURFACE = new WeakMap<SurfaceParameters, DrainageGraph | null>()
const CACHE = new Map<string, DrainageGraph | null>()
/** Graphs kept by the string cache. A few megabytes each, so few. */
export const DRAINAGE_CACHE_LIMIT = 12

const cacheKey = (surface: SurfaceParameters): string =>
  [
    formatSeed(surface.seed),
    surface.maxElevation,
    surface.roughness,
    surface.seaLevel ?? 'dry',
    JSON.stringify(surface.grammar),
  ].join('|')

/** The drainage graph of a surface, built once and kept; null where nothing drains. */
export function drainageGraph(
  surface: SurfaceParameters,
): DrainageGraph | null {
  const known = BY_SURFACE.get(surface)
  if (known !== undefined) return known
  const key = cacheKey(surface)
  const hit = CACHE.get(key)
  if (hit !== undefined) {
    BY_SURFACE.set(surface, hit)
    return hit
  }
  const graph = build(surface)
  if (CACHE.size >= DRAINAGE_CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, graph)
  BY_SURFACE.set(surface, graph)
  return graph
}

/* ---------------------------------------------------------------------------
 * Reading the graph at a sample
 * ------------------------------------------------------------------------- */

/** What the drainage does to one sample of the field. */
export interface DrainageCarve {
  /** The ground once the valleys are cut into `landform`, meters. */
  readonly ground: Meters
  /**
   * The level of standing or running water over the sample, meters, or NaN
   * where there is none: a river's surface inside its channel, a lake's
   * spill level over its floor. The sea is not in it — the sea is one datum
   * per body and the sheet draws it everywhere the ground is under it.
   */
  readonly water: Meters
  /** How much of the sample is channel bed, 0..1. */
  readonly channel: number
  /** How much is floodplain and the valley's margin, 0..1. */
  readonly corridor: number
}

/** A sample no channel reaches. */
export const NO_CARVE = (landform: Meters): DrainageCarve => ({
  ground: landform,
  water: Number.NaN,
  channel: 0,
  corridor: 0,
})

/**
 * The lattice cell a direction falls in, as a node index.
 *
 * A decision taken in a float, and the module header says why that is
 * allowed here: the two cells a boundary sample could name both list every
 * segment within reach of the boundary, and every profile is zero at the
 * reach, so the value the two walks return is the same value.
 */
export function drainageCell(graph: DrainageGraph, direction: Vec3): number {
  const region = regionForDirection(direction, graph.level)
  return (region.face * graph.cells + region.i) * graph.cells + region.j
}

/**
 * The direction a sample is looked up at: the sample's own, bent by a warp
 * of a fraction of a cell, so the chords between nodes read as meanders.
 * The same three noise reads the strip field spent on its warp, and the
 * drainage seed is theirs.
 */
export function drainageLookup(
  graph: DrainageGraph,
  sketch: TerrainSketch,
  direction: Vec3,
): Vec3 {
  const cycles = DRAINAGE_SHAPE.warpCycles * graph.cells * (2 / Math.PI) * 2
  const amount = (DRAINAGE_SHAPE.warpAmount * Math.PI) / 2 / graph.cells
  const seed = sketch.seeds.drainage
  const wx = noise3(
    seed,
    direction.x * cycles + 37.1,
    direction.y * cycles,
    direction.z * cycles,
  )
  const wy = noise3(
    seed,
    direction.x * cycles + 71.3,
    direction.y * cycles,
    direction.z * cycles,
  )
  const wz = noise3(
    seed,
    direction.x * cycles + 113.7,
    direction.y * cycles,
    direction.z * cycles,
  )
  const x = direction.x + wx * amount
  const y = direction.y + wy * amount
  const z = direction.z + wz * amount
  const inverse = 1 / Math.sqrt(x * x + y * y + z * z)
  return { x: x * inverse, y: y * inverse, z: z * inverse }
}

/**
 * The valley's cross-section: one over the floodplain, falling to zero at
 * the reach. `d` is the distance to the channel, `plain` the floodplain's
 * half-width and `reach` the valley's, all in the same units.
 */
export function valleyShape(d: number, plain: number, reach: number): number {
  if (d <= plain) return 1
  if (d >= reach) return 0
  return 1 - smoothstep(0, 1, (d - plain) / (reach - plain))
}

/** The channel's own notch: one over the bed, zero past the bank. */
export function bedShape(d: number, halfWidth: number): number {
  return 1 - smoothstep(DRAINAGE_SHAPE.bank * halfWidth, halfWidth, d)
}

/**
 * The valleys, cut into a landform at one sample.
 *
 * Over every segment the sample's cell lists: the distance to the chord and
 * where along it, the floor, channel half-width and depth interpolated
 * there, and then the terms —
 *
 *   ground = landform − max cut + max fill − max notch
 *
 * where a segment's cut is the landform's height above the floor over the
 * valley's cross-section, its fill is the floor's height above the landform
 * over the bed alone, and its notch is the channel's depth over the bed. On
 * the bed of any one segment that is the floor less the depth, whichever
 * branch applied, so the bed follows the floor and the floor never rises
 * downstream. Off the bed a fill is nothing, a cut fades to nothing at the
 * reach, and every term is a maximum of continuous terms that are zero for
 * a segment out of reach — so the set of segments a sample sees can change
 * without the ground noticing.
 *
 * The fill is the term the plan's `min(landform, floor + profile)` does not
 * have, and it is what makes the bed monotone: the relief and the craters
 * are not on the lattice, so along a channel the landform dips below the
 * floor wherever a hollow of theirs falls on it, and a `min` alone would
 * leave a pond there. Alluvium is the honest name for the fill.
 *
 * The water is the floor over the bed — the bed sits a channel depth under
 * it — and a lake's spill level over its floor, read as a kernel-weighted
 * mean over the lake nodes within reach so one lake is one level exactly.
 */
export function carveDrainage(
  graph: DrainageGraph,
  lookup: Vec3,
  landform: Meters,
): DrainageCarve {
  const cell = drainageCell(graph, lookup)
  const start = graph.cellStart[cell] as number
  const end = graph.cellStart[cell + 1] as number
  const segments = graph.segments
  const reach = graph.reach
  const x = lookup.x
  const y = lookup.y
  const z = lookup.z
  let cut = 0
  let fill = 0
  let notch = 0
  let channel = 0
  let corridor = 0
  let river = Number.NaN
  for (let k = start; k < end; k += 1) {
    const at = (graph.cellSegments[k] as number) * SEGMENT_STRIDE
    const ax = segments[at] as number
    const ay = segments[at + 1] as number
    const az = segments[at + 2] as number
    const bx = (segments[at + 4] as number) - ax
    const by = (segments[at + 5] as number) - ay
    const bz = (segments[at + 6] as number) - az
    const px = x - ax
    const py = y - ay
    const pz = z - az
    const length = bx * bx + by * by + bz * bz
    const t =
      length > 0
        ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / length))
        : 0
    const ex = px - bx * t
    const ey = py - by * t
    const ez = pz - bz * t
    const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
    if (d >= reach) continue
    const fA = segments[at + 3] as number
    const fB = segments[at + 7] as number
    const floor = fA + (fB - fA) * t
    const wA = segments[at + 8] as number
    const wB = segments[at + 9] as number
    const halfWidth = wA + (wB - wA) * t
    const hA = segments[at + 10] as number
    const hB = segments[at + 11] as number
    const depth = hA + (hB - hA) * t
    const plain = Math.min(DRAINAGE_SHAPE.floodplain * halfWidth, 0.8 * reach)
    const shape = valleyShape(d, plain, reach)
    const bed = bedShape(d, halfWidth)
    const valley = landform - floor
    if (valley >= 0) {
      const here = valley * shape
      if (here > cut) cut = here
    } else {
      const here = -valley * bed
      if (here > fill) fill = here
    }
    const here = depth * bed
    if (here > notch) notch = here
    if (bed > channel) channel = bed
    const margin = 1 - smoothstep(plain, Math.min(reach, plain * 2), d)
    if (margin > corridor) corridor = margin
    if (bed > 0 && !(floor <= river)) river = floor
  }
  const lake = lakeLevelAt(graph, cell, lookup)
  let water = river
  if (!Number.isNaN(lake) && !(lake <= water)) water = lake
  return { ground: landform - cut + fill - notch, water, channel, corridor }
}

/**
 * The lake level over a sample, or NaN: a kernel-weighted mean over the
 * lake nodes within `lakeReach` of it, the cell's own and its ring.
 */
function lakeLevelAt(graph: DrainageGraph, cell: number, lookup: Vec3): number {
  const { neighbors } = topology(graph.cells)
  const reach = (DRAINAGE_SHAPE.lakeReach * Math.PI) / 2 / graph.cells
  let total = 0
  let weight = 0
  const consider = (n: number): void => {
    const level = graph.lake[n] as number
    if (Number.isNaN(level)) return
    const dx = (graph.positions[n * 3] as number) - lookup.x
    const dy = (graph.positions[n * 3 + 1] as number) - lookup.y
    const dz = (graph.positions[n * 3 + 2] as number) - lookup.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / reach
    if (d >= 1) return
    const w = (1 - d * d) ** 2
    total += w * level
    weight += w
  }
  consider(cell)
  for (let k = 0; k < 8; k += 1) {
    const n = neighbors[cell * 8 + k] as number
    if (n >= 0) consider(n)
  }
  return weight > 0 ? total / weight : Number.NaN
}
