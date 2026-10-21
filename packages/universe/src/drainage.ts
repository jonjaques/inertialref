import type { Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import { noise3, pcg4d, smoothstep, toUnit } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import { bareGround, type StageContext, stageOn } from './bandStack.ts'
import {
  along,
  bedShape,
  channelDepth,
  channelHalfWidth,
  DRAINAGE_SHAPE,
  toArc,
  valleyShape,
} from './drainageShape.ts'
import {
  RECORD_STRIDE,
  type RefinedCarve,
  Refinement,
  type RefinementChannel,
  type RefinementControl,
  refinementDepth,
} from './drainageRefinement.ts'
import { Heap } from './drainageHeap.ts'
import { fineRungMean, latticeLandform } from './latticeLandform.ts'
import { plateWeight, type TerrainSketch, terrainSketch } from './sketch.ts'
import { surfaceIdentity } from './surfaceIdentity.ts'
import type { SurfaceParameters } from './system.ts'
import {
  coastWidth,
  directionToFace,
  drainageDatum,
  regionDirection,
  regionForDirection,
  regionNeighbor,
  regionSize,
  seaDatumElevation,
} from './regions.ts'

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
 * Floats per segment record:
 * `[ax ay az fA] [bx by bz fB] [wA wB hA hB] [standing · · ·]`, where
 * `standing` is the level of the lake or sea the reach is drowned by, or
 * `NO_STANDING` where the bed is above every water it drains to. A refined
 * creek's records are the same record, so the walk and the kernel read both
 * with one loop.
 */
export const SEGMENT_STRIDE = RECORD_STRIDE
/** The `standing` lane of a reach nothing drowns: below any ground. */
export const NO_STANDING = -1e30

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
  /**
   * The standing water over the node — a lake's spill level, or the sea's
   * datum on a node the sea reaches — else NaN.
   */
  readonly lake: Float64Array
  /** Whether the node is under the sea. */
  readonly sea: Uint8Array
  /** The nodes in flood order, downstream first: a topological order. */
  readonly popOrder: Int32Array
  /**
   * Eight neighbor indices per node, −1 where a cube corner has seven. The
   * lattice's own table, shared by every body of this size; on the graph so
   * the kernel packer and the lake lookup read one.
   */
  readonly neighbors: Int32Array
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

/**
 * The ring's steps, `[di, dj]` per neighbor slot in the order `neighbors`
 * lists them. Exported because the kernel's lake block fades a neighbor by
 * which side of the sample's cell it lies on, and reads the side from here.
 */
export const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
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
          const [di, dj] = NEIGHBOR_OFFSETS[k] as readonly [number, number]
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
 * Where a lattice node sits in its cell, (s, t) in cell units: jittered so
 * the network is not a grid. The hash is the lattice's own, on a lane no
 * crater rung reaches, and the refinement reads it back to know which of a
 * cell's four children holds the node.
 */
function latticePoint(
  seedLane: number,
  face: number,
  i: number,
  j: number,
): [number, number] {
  const hash = pcg4d(i ^ seedLane, j, face, 977)
  return [
    0.5 + (toUnit(hash.x) * 2 - 1) * DRAINAGE_SHAPE.jitter,
    0.5 + (toUnit(hash.y) * 2 - 1) * DRAINAGE_SHAPE.jitter,
  ]
}

/** Chord between two unit directions held as flat arrays, radians to first order. */
function chord(positions: Float64Array, a: number, b: number): number {
  const dx = (positions[a * 3] as number) - (positions[b * 3] as number)
  const dy = (positions[a * 3 + 1] as number) - (positions[b * 3 + 1] as number)
  const dz = (positions[a * 3 + 2] as number) - (positions[b * 3 + 2] as number)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Whether a surface has a drainage graph at all — the one thing about the
 * graph that can be answered without building one.
 *
 * `build` is fifty to a hundred milliseconds, and the callers that only need
 * "is there one" run on the thread that draws: the streamer asks once a
 * patch whether the sheet comes from the field or from a datum. Asking
 * `drainageGraph` there is a frame of stall the first time a wet body is
 * streamed on a build that never otherwise needs the graph on this thread.
 */
export function drains(surface: SurfaceParameters): boolean {
  return !bareGround(surface) && surface.grammar.drainage > 0
}

function build(surface: SurfaceParameters): DrainageGraph | null {
  const grammar = surface.grammar
  if (!drains(surface)) return null
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
  const fineMean = stageOn('craters', stack)
    ? fineRungMean(sketch, surface, coarseRungs)
    : 0
  for (let face = 0; face < 6; face += 1) {
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        const node = (face * cells + i) * cells + j
        const [s, t] = latticePoint(seedLane, face, i, j)
        const direction = regionDirection(
          regionAddress(face, level, i, j),
          s,
          t,
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
          fineMean,
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
  /*
   * The sea is a lake at the datum on the nodes it reaches, and on no
   * other. The field reads standing water off these levels — the sea
   * where a sea node is within reach, a lake's spill where a lake node is
   * — so a crater floor a thousand kilometers inland that happens to sit
   * under the datum is dry ground rather than a sea the ocean never
   * reached, and a basin the flood filled stands at its own spill.
   */
  for (let n = 0; n < nodes; n += 1) {
    if (isSea[n] === 1) {
      lake[n] = sea as number
      continue
    }
    if ((filled[n] as number) - (elevation[n] as number) > lakeFloor) {
      lake[n] = filled[n] as number
    }
  }
  /*
   * A fill spanning fewer than `lakeNodes` adjacent nodes at one level is
   * a flat, not a lake: the river crosses it at the spill and the field
   * reads no level over it.
   */
  const component = new Int32Array(nodes).fill(-1)
  const pending: number[] = []
  for (let n = 0; n < nodes; n += 1) {
    if (isSea[n] === 1 || Number.isNaN(lake[n] as number)) continue
    if (component[n] !== -1) continue
    const level = lake[n] as number
    const members: number[] = []
    component[n] = n
    pending.push(n)
    while (pending.length > 0) {
      const m = pending.pop() as number
      members.push(m)
      for (let k = 0; k < 8; k += 1) {
        const o = neighbors[m * 8 + k] as number
        if (o < 0 || component[o] !== -1) continue
        if (isSea[o] === 1 || (lake[o] as number) !== level) continue
        component[o] = n
        pending.push(o)
      }
    }
    if (members.length < DRAINAGE_SHAPE.lakeNodes) {
      for (const m of members) lake[m] = Number.NaN
    }
  }
  /*
   * A lake's outlet keeps the lake. The rim node a lake spills over sits at
   * the lake's level exactly — the flood reached the lake through it — and
   * a cut below that would drain the lake into its own outlet: the level
   * read over the rim's cell stood two hundred meters over a channel cut
   * two hundred meters under it. So the floor of any node a lake drains
   * into directly is held at the lake's level, and the profile climbs from
   * there downstream as it would from any floor.
   */
  const outlet = new Float64Array(nodes).fill(Number.NEGATIVE_INFINITY)
  for (let n = 0; n < nodes; n += 1) {
    const level = lake[n] as number
    if (Number.isNaN(level) || isSea[n] === 1) continue
    const r = receiver[n] as number
    if (r < 0 || isSea[r] === 1 || !Number.isNaN(lake[r] as number)) continue
    if (level > (outlet[r] as number)) outlet[r] = level
  }
  for (let p = 0; p < nodes; p += 1) {
    const n = popOrder[p] as number
    const z = elevation[n] as number
    const spill = filled[n] as number
    if (isSea[n] === 1) {
      floor[n] = z
      base[n] = sea as number
      continue
    }
    if (!Number.isNaN(lake[n] as number)) {
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
    /*
     * Clamped to what it climbs from, which the cap alone cannot promise
     * once an outlet has been raised: a node just above a rim wants a cut
     * that reaches under the rim's floor, and the river there is the lake's
     * backwater at the lake's level instead.
     */
    floor[n] = Math.max(Math.min(spill - cut, climb), from, outlet[n] as number)
  }
  /*
   * The drowned reach. A river meets a lake or the sea at the ria depth
   * below its level, so the last of the bed lies under that water and the
   * water's surface there is the lake's, not the floor's: the level a
   * channel node stands under is its receiver's standing water where the
   * floor is below it, carried up the tree until the bed climbs out.
   */
  const drowned = new Float64Array(nodes).fill(NO_STANDING)
  for (let p = 0; p < nodes; p += 1) {
    const n = popOrder[p] as number
    const r = receiver[n] as number
    if (r < 0 || isSea[n] === 1 || !Number.isNaN(lake[n] as number)) continue
    const below = isSea[r] === 1 ? (sea as number) : (lake[r] as number)
    const standing = Number.isNaN(below) ? (drowned[r] as number) : below
    if ((floor[n] as number) < standing) drowned[n] = standing
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
    segments[at + 12] = drowned[n] as number
  }

  /*
   * A cell lists a segment when the valley reaches any of the cell's five
   * marks — its center and its four corners — or the chord passes closer to
   * the center than the cell's own half-diagonal, which is the case of a
   * segment crossing the cell between the marks. Counted first and filled
   * second, into two flat arrays, so the build allocates nothing per cell.
   */
  const stamp = new Int32Array(nodes).fill(-1)
  /*
   * The "seen in this gather" mark is a counter, not the segment's own node.
   * The two passes walk the same nodes in the same order over one `stamp`,
   * so a mark left by the *first* pass is a mark the second pass can mistake
   * for its own: a cell whose only gatherer is `n` still reads `n` when the
   * fill pass reaches `n`, and the cell is skipped. The count pass had
   * already counted it, so the slot stays at its zero and the cell lists
   * segment 0 instead of the one that reaches it — 106 cells of Earth's
   * 24,576. A counter that never repeats cannot collide with a residue.
   */
  let token = 0
  const candidates = new Int32Array(64)
  const counts = new Uint32Array(nodes)
  const gather = (n: number, r: number): number => {
    token += 1
    let count = 0
    stamp[n] = token
    candidates[count] = n
    count += 1
    if (stamp[r] !== token) {
      stamp[r] = token
      candidates[count] = r
      count += 1
    }
    const first = count
    for (let k = 0; k < first; k += 1) {
      const c = candidates[k] as number
      for (let m = 0; m < 8; m += 1) {
        const o = neighbors[c * 8 + m] as number
        if (o < 0 || stamp[o] === token) continue
        stamp[o] = token
        candidates[count] = o
        count += 1
      }
    }
    const second = count
    for (let k = first; k < second; k += 1) {
      const c = candidates[k] as number
      for (let m = 0; m < 8; m += 1) {
        const o = neighbors[c * 8 + m] as number
        if (o < 0 || stamp[o] === token) continue
        stamp[o] = token
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
    // Plus the chord's sag, `length / 8` on the unit sphere: the walk
    // measures to the arc over the chord, which is that much nearer a point
    // on the ground than the chord is (see `walk`), and a list built on the
    // chord alone would miss a segment the walk reaches.
    const sag = length / 8
    const slack = halfDiagonal / 2 + sag
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
      if (k === 0 && d > reach + halfDiagonal + sag) return false
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
    neighbors,
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
 * `WeakMap` because the field resolves the graph per sample. The string key
 * is the surface's whole identity (`surfaceIdentity`) rather than the fields
 * the build reads, because the build reads most of the grammar and a list of
 * them goes stale without a sound.
 */
const BY_SURFACE = new WeakMap<SurfaceParameters, DrainageGraph | null>()
const CACHE = new Map<string, DrainageGraph | null>()
/** Graphs kept by the string cache. A few megabytes each, so few. */
export const DRAINAGE_CACHE_LIMIT = 12

/** Graphs this thread has built, as against looked up or been handed. */
let builds = 0

/** The drainage graph of a surface, built once and kept; null where nothing drains. */
export function drainageGraph(
  surface: SurfaceParameters,
): DrainageGraph | null {
  const known = BY_SURFACE.get(surface)
  if (known !== undefined) return known
  const key = surfaceIdentity(surface)
  const hit = CACHE.get(key)
  if (hit !== undefined) {
    BY_SURFACE.set(surface, hit)
    return hit
  }
  builds += 1
  return keep(surface, key, build(surface))
}

/**
 * Hand this thread a graph another thread built for the same surface.
 *
 * The build is 57 to 103 ms in the browser, and every thread that samples the
 * field pays it once per body — on the draw thread, in whichever frame first
 * reads a wet body's ground: the site list on focusing one, the scatter field's
 * one sample a frame as the ground arrives, the GPU producer's first pack. A
 * worker preparing the surface builds it anyway, and the arrays survive a
 * structured clone, so what crosses back is the graph rather than the work.
 *
 * A graph this thread already holds is kept rather than replaced. Both are
 * the same arithmetic over the same key, and the field and the packed kernel
 * may already be holding the one that is here.
 */
export function seedDrainageGraph(
  surface: SurfaceParameters,
  graph: DrainageGraph | null,
): void {
  if (BY_SURFACE.has(surface)) return
  const key = surfaceIdentity(surface)
  const held = CACHE.get(key)
  if (held !== undefined) BY_SURFACE.set(surface, held)
  else keep(surface, key, graph)
}

/** How many graphs this thread has built: the instrument for the claim above. */
export const drainageBuilds = (): number => builds

function keep(
  surface: SurfaceParameters,
  key: string,
  graph: DrainageGraph | null,
): DrainageGraph | null {
  if (CACHE.size >= DRAINAGE_CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, graph)
  BY_SURFACE.set(surface, graph)
  if (graph !== null) SOURCES.set(graph, surface)
  return graph
}

/*
 * The surface each graph was built or handed for, which the refinement reads
 * its bands from. Beside the graph rather than on it: a graph crosses threads
 * by structured clone, and its refinement is this thread's cache of cells,
 * not data to post. Every surface that maps to one graph shares its key, so
 * the first one kept answers for all of them.
 */
const SOURCES = new WeakMap<DrainageGraph, SurfaceParameters>()
const REFINEMENTS = new WeakMap<DrainageGraph, Refinement>()

/**
 * The finest refined drainage level a reader asking about a region at
 * `level` resolves: one below the region's own. ADR-0054.
 */
export const regionDrainageLevel = (level: number): number => level + 1

/**
 * The refinement below a graph's lattice, made on first use and kept with
 * the graph. Exported for the tests and rigs that count its constructions;
 * the field reaches it through `carveDrainage`.
 */
export function drainageRefinement(graph: DrainageGraph): Refinement {
  const known = REFINEMENTS.get(graph)
  if (known !== undefined) return known
  const surface = SOURCES.get(graph)
  /*
   * A graph reaches the field only through `drainageGraph` or
   * `seedDrainageGraph`, and both record its surface. One that arrived some
   * other way — a clone read without being seeded — would carve without its
   * refinement and quietly be a different field, so it is refused instead.
   */
  invariant(
    surface !== undefined,
    'a drainage graph is carved only after drainageGraph or seedDrainageGraph has kept it',
  )
  const made = new Refinement(
    refinementHost(graph, surface),
    refinementDepth(surface.grammar.meanRadius, graph.level),
  )
  REFINEMENTS.set(graph, made)
  return made
}

/**
 * What the refinement needs from the lattice: its lists, its node jitter,
 * and the laws a channel of a given area obeys — width, depth and Flint's
 * slope as `build` spends them, and the cut a head makes, which is `build`'s
 * own cut at an area under one cell.
 *
 * The control — the ground a level's creeks are cut into — is the stack read
 * the way `latticeLandform` reads it, at that level's own cell size, then
 * carved by the lattice and every coarser refined level. It is read at the
 * key point's preimage under the lookup's warp, because the refined segments
 * live in lookup space with the lattice's, and the bands do not. The
 * preimage is a fixed point, found from the point itself: the warp's slope
 * is under a half, so each step halves the error at least, and the warp's
 * twelfth of a lattice cell comes down to a twentieth of a refined cell in
 * two more steps than the level is below the lattice. More would be time
 * spent placing a hillside more finely than the creek on it can see.
 */
function refinementHost(graph: DrainageGraph, surface: SurfaceParameters) {
  const grammar = surface.grammar
  const sketch = terrainSketch(surface)
  const stack: StageContext = {
    surface,
    sketch,
    sea: seaDatumElevation(surface),
    seabed: false,
  }
  const radius = grammar.meanRadius
  const budget = surface.maxElevation
  const datum = drainageDatum(surface)
  const latticeArea = (4 * Math.PI * radius * radius) / graph.nodes
  const deepest = DRAINAGE_SHAPE.depth * budget * grammar.drainage
  const slopeZero = (DRAINAGE_SHAPE.slopeGain * budget) / radius
  const craters = stageOn('craters', stack)
  const rungs = new Map<number, { coarse: number; mean: Meters }>()
  const ladderAt = (level: number): { coarse: number; mean: Meters } => {
    const known = rungs.get(level)
    if (known !== undefined) return known
    const cellMeters = regionSize(radius, level)
    let coarse = 0
    if (craters) {
      for (const rung of sketch.craterLevels) {
        if (rung.diameter < 2 * cellMeters) break
        coarse += 1
      }
    }
    const made = {
      coarse,
      mean: craters ? fineRungMean(sketch, surface, coarse) : 0,
    }
    rungs.set(level, made)
    return made
  }
  return {
    level: graph.level,
    cells: graph.cells,
    cellStart: graph.cellStart,
    cellSegments: graph.cellSegments,
    segments: graph.segments,
    radius,
    seedLane: sketch.latticeSeed,
    latticePoint: (face: number, i: number, j: number) =>
      latticePoint(sketch.latticeSeed, face, i, j),
    control(lookup: Vec3, level: number): RefinementControl {
      let x = lookup.x
      let y = lookup.y
      let z = lookup.z
      const steps = 2 + level - graph.level
      for (let step = 0; step < steps; step += 1) {
        const warped = drainageLookup(graph, sketch, { x, y, z })
        x += lookup.x - warped.x
        y += lookup.y - warped.y
        z += lookup.z - warped.z
        const norm = 1 / Math.sqrt(x * x + y * y + z * z)
        x *= norm
        y *= norm
        z *= norm
      }
      const ladder = ladderAt(level)
      const landform = latticeLandform(
        surface,
        sketch,
        stack,
        { x, y, z },
        regionSize(radius, level),
        ladder.coarse,
        ladder.mean,
      )
      const carved = walk(graph, lookup, landform, level)
      return { surface: carved.surface, water: carved.water }
    },
    channel(areaMeters: number, ground: Meters): RefinementChannel {
      const cells = areaMeters / latticeArea
      const above = Math.max(0, ground - datum)
      const gain = Math.min(
        1,
        (cells / DRAINAGE_SHAPE.cutArea) ** DRAINAGE_SHAPE.cutPower,
      )
      return {
        halfWidth: channelHalfWidth(areaMeters, radius),
        depth: channelDepth(areaMeters),
        slope: slopeZero * cells ** -DRAINAGE_SHAPE.concavity,
        incision:
          deepest *
          gain *
          (1 - Math.exp((-DRAINAGE_SHAPE.headGain * above) / deepest)),
      }
    },
  }
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
   * spill level over its floor, the sea's datum where the sea reaches.
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
 * The valleys, cut into a landform at one sample.
 *
 * Over every segment the sample's cell lists: the distance to the chord and
 * where along it, the floor, channel half-width and depth interpolated
 * there, and then the terms —
 *
 *   ground = landform − max cut + max fill − max notch
 *
 * where a segment's cut is the landform's height above the floor over the
 * valley's cross-section, its fill the floor's height above the landform
 * over the same cross-section, and its notch the channel's depth over the
 * bed. One segment alone gives `mix(landform, floor, shape) − depth · bed`:
 * the bed at the floor less the channel's depth whichever way the landform
 * went, the floodplain at the floor, the walls blending out to the landform
 * at the reach. Every term is a maximum of continuous terms that are zero
 * for a segment out of reach, so the set of segments a sample sees can
 * change without the ground noticing.
 *
 * The fill is the term the plan's `min(landform, floor + profile)` does not
 * have, and it is alluvium. The relief and the craters are not on the
 * lattice, so along a channel the landform dips under the floor wherever a
 * hollow of theirs falls on it, and a cut alone leaves the hollow — either
 * a pool in the bed or, with the water held at the floor, a channel of
 * water standing over the land beside it. The fill spans the valley's
 * cross-section rather than the bed alone, because a fill the bed's width
 * is a causeway with a cliff for a bank: a crater a cell wide dips hundreds
 * of meters under a floor, and that height over a bank of tens of meters
 * put the kernel four meters off the CPU at a float32 position. Over the
 * whole cross-section the same height is a fan a valley wide.
 *
 * Where two valleys overlap the deeper cut and the taller fill each win,
 * which at a confluence lays the tributary's floodplain over the trunk's as
 * a cone that thins downstream faster than the trunk's floor drops.
 *
 * The water is the floor over the bed, or the lake or sea that drowns the
 * reach where that stands higher, and the standing water `lakeLevelAt`
 * reads over the sample.
 *
 * Below the lattice, the refined levels (`drainageRefinement.ts`), finest
 * last, each cut into what the coarser ones left: see `walk`. `finest`
 * stops them at a level — a reader asking about a region stops at
 * `regionDrainageLevel`, and one measuring what a level does stops above it.
 */
export function carveDrainage(
  graph: DrainageGraph,
  lookup: Vec3,
  landform: Meters,
  finest: number = Number.POSITIVE_INFINITY,
): DrainageCarve {
  const carved = walk(graph, lookup, landform, finest + 1)
  return {
    ground: carved.surface - carved.notch,
    water: carved.water,
    channel: carved.channel,
    corridor: carved.corridor,
  }
}

/** A walk's result: the carve with the channels' notch held apart. */
interface Walked {
  /** The ground with every valley cut and filled, before the notch. */
  readonly surface: Meters
  readonly notch: Meters
  readonly water: Meters
  readonly channel: number
  readonly corridor: number
}

/**
 * The carve, through the levels coarser than `until`: the lattice's
 * segments as `carveDrainage` describes, then each refined level's list.
 *
 * **Below the lattice, the refined levels cut into what the coarser ones
 * left**, finest last: `Refinement.carve`, which says how they compose. A
 * creek's own water stands no higher than the ground it runs on, which
 * differs from its floor only where a coarser channel refused the fill; a
 * lake or the sea drowning the reach it joins stands at its own level, as it
 * does over the lattice's.
 *
 * **The notch is one maximum over every level**, taken last, so a creek
 * meeting a river does not deepen the river's channel by its own depth.
 */
function walk(
  graph: DrainageGraph,
  lookup: Vec3,
  landform: Meters,
  until: number,
): Walked {
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
    const t = along(x - ax, y - ay, z - az, bx, by, bz)
    const d = toArc(x, y, z, ax, ay, az, bx, by, bz, t)
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
    const standing = segments[at + 12] as number
    const plain = Math.min(DRAINAGE_SHAPE.floodplain * halfWidth, 0.8 * reach)
    const shape = valleyShape(d, halfWidth, plain, reach)
    const bed = bedShape(d, halfWidth)
    const valley = landform - floor
    if (valley >= 0) {
      const here = valley * shape
      if (here > cut) cut = here
    } else {
      const here = -valley * shape
      if (here > fill) fill = here
    }
    const here = depth * bed
    if (here > notch) notch = here
    if (bed > channel) channel = bed
    const margin = 1 - smoothstep(plain, Math.min(reach, plain * 2), d)
    if (margin > corridor) corridor = margin
    if (bed > 0) {
      // The water over the bed: the floor, or the lake or sea that drowns
      // this reach where that stands higher.
      const level = standing > floor ? standing : floor
      if (!(level <= river)) river = level
    }
  }

  const refined: RefinedCarve = {
    surface: landform - cut + fill,
    notch,
    channel,
    corridor,
    creek: Number.NaN,
    drowned: Number.NaN,
  }
  drainageRefinement(graph).carve(lookup, refined, until - 1)
  const surface = refined.surface
  let creek = refined.creek
  const drowned = refined.drowned
  // Where a coarser channel refused the fill the bed can sit under its
  // floor line, and a creek's own water stands no higher than the ground
  // there. A lake or the sea drowning the reach stands where it stands.
  if (!Number.isNaN(creek)) {
    if (creek > surface) creek = surface
    if (!(creek <= river)) river = creek
  }
  if (!Number.isNaN(drowned) && !(drowned <= river)) river = drowned

  const lake = lakeLevelAt(graph, cell, lookup)
  let water = river
  if (!Number.isNaN(lake) && !(lake <= water)) water = lake
  return {
    surface,
    notch: refined.notch,
    water,
    channel: refined.channel,
    corridor: refined.corridor,
  }
}

/*
 * Scratch for `lakeLevelAt`: the level and weight of each of the nine nodes
 * it reads, and the weight of the body each belongs to. The field is
 * synchronous and samples one direction at a time, so one set is enough.
 */
const LAKE_LEVELS = new Float64Array(9)
const LAKE_WEIGHTS = new Float64Array(9)
const LAKE_BODIES = new Float64Array(9)

/** Where a sample sits across its lattice cell along one face axis, 0..1. */
function cellFraction(coordinate: number, cells: number): number {
  const t = ((coordinate + 1) / 2) * cells
  return t - Math.min(cells - 1, Math.max(0, Math.floor(t)))
}

/**
 * The standing water over a sample, or NaN: the level of one body — the
 * lake, or the sea at its datum — read off the lake nodes within
 * `lakeReach` of it, the cell's own and its ring.
 *
 * **A lake is one level exactly.** Each node in reach weighs
 * `(1 − (d/reach)²)²`, the weights of the nodes at one level sum to that
 * body's, and a sample in reach of one body reads its level whatever the
 * weights are. Adjacent lake nodes share a level by the flood's
 * construction, so two bodies at different levels are never neighbors and
 * the level a sample reads is a choice between bodies, not between nodes.
 *
 * **Between two bodies it reads the heavier one.** A mean over both is a
 * level belonging to neither across the whole overlap — 2.4 cells wide
 * at most, 156 km a cell on Earth — so the sheet would tilt across the
 * gap and the clamp follow it. Read off the leader alone, it is a step where
 * the lead changes hands, and that is where the weights tie, not where the
 * ground stands above both levels: the lattice samples the landform once a
 * cell and the field's ground between two nodes is hundreds of meters from
 * it, so no ranking of nodes puts the step where neither sheet shows it.
 * So rule 11's margin: each body's say is `plateWeight` of how far its
 * share of the weight trails the leader's, which is the leader's level
 * exactly wherever it leads by `lakeMargin` and a continuous blend over the
 * sliver where it does not.
 *
 * **A node's weight reaches zero before it leaves the ring.** The ring is
 * the cell's eight neighbors, and a node two cells over can be inside the
 * reach — a cell near a face's edge is half the angle of one at its center
 * — so the sample crossing into the next cell would gain or lose it with
 * weight, and between two bodies that is a step of the levels' difference
 * times its share: 47 m on Earth, where the sea meets a lake at a face edge.
 * A neighbor's weight fades to zero over the half of the sample's cell
 * away from it, which is the edge it leaves the ring across, and the cell
 * decision is safe for the reason it is for the segments: the two cells a
 * boundary sample could name read the same weights there.
 */
export function lakeLevelAt(
  graph: DrainageGraph,
  cell: number,
  lookup: Vec3,
): number {
  const neighbors = graph.neighbors
  const reach = (DRAINAGE_SHAPE.lakeReach * Math.PI) / 2 / graph.cells
  const { u, v } = directionToFace(lookup)
  const across = cellFraction(u, graph.cells)
  const along = cellFraction(v, graph.cells)
  let count = 0
  let total = 0
  const consider = (n: number, di: number, dj: number): void => {
    const level = graph.lake[n] as number
    if (Number.isNaN(level)) return
    const dx = (graph.positions[n * 3] as number) - lookup.x
    const dy = (graph.positions[n * 3 + 1] as number) - lookup.y
    const dz = (graph.positions[n * 3 + 2] as number) - lookup.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / reach
    if (d >= 1) return
    const fade =
      (di === 0 ? 1 : smoothstep(0, 0.5, di > 0 ? across : 1 - across)) *
      (dj === 0 ? 1 : smoothstep(0, 0.5, dj > 0 ? along : 1 - along))
    const w = (1 - d * d) ** 2 * fade
    if (w <= 0) return
    LAKE_LEVELS[count] = level
    LAKE_WEIGHTS[count] = w
    count += 1
    total += w
  }
  consider(cell, 0, 0)
  for (let k = 0; k < 8; k += 1) {
    const n = neighbors[cell * 8 + k] as number
    const [di, dj] = NEIGHBOR_OFFSETS[k] as readonly [number, number]
    if (n >= 0) consider(n, di, dj)
  }
  if (count === 0) return Number.NaN
  let best = 0
  for (let i = 0; i < count; i += 1) {
    let body = 0
    for (let j = 0; j < count; j += 1) {
      if (LAKE_LEVELS[j] === LAKE_LEVELS[i]) body += LAKE_WEIGHTS[j] as number
    }
    LAKE_BODIES[i] = body
    if (body > best) best = body
  }
  // Each body once, at its first node; the sum is symmetric in the bodies,
  // so the order the ring lists them in cannot move it.
  let sum = 0
  let weight = 0
  for (let i = 0; i < count; i += 1) {
    let first = true
    for (let j = 0; j < i; j += 1) {
      if (LAKE_LEVELS[j] === LAKE_LEVELS[i]) first = false
    }
    if (!first) continue
    const say = plateWeight(
      (best - (LAKE_BODIES[i] as number)) / total,
      DRAINAGE_SHAPE.lakeMargin,
    )
    sum += say * (LAKE_LEVELS[i] as number)
    weight += say
  }
  return sum / weight
}
