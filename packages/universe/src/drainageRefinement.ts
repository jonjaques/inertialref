import type { Meters } from '@inertialref/shared'
import { invariant } from '@inertialref/shared'
import { pcg4d, smoothstep, toUnit } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import {
  bedShape,
  DRAINAGE_SHAPE,
  toArc,
  valleyShape,
} from './drainageShape.ts'
import { directionToFace, regionDirection, regionNeighbor } from './regions.ts'

/*
 * The drainage below the lattice: Dendry's refinement, built per cell.
 *
 * The graph in `drainage.ts` is one node per lattice cell, and the finest
 * channel it can draw is one cell's catchment — 140 m wide on Earth, a
 * kilometer of floodplain. Below it the ground is the relief band's noise,
 * with no creek a walker could stand beside. This module adds the levels the
 * lattice cannot afford, the way Gaillard et al. 2019 (_Dendry_, I3D) builds
 * them: at each level a grid twice as fine, a jittered key point per cell,
 * and a creek from that point to the nearest stream already on the tree. The
 * tree that results is a function of position, built locally.
 *
 * **Every creek lies inside its parent cell, and joins a stream that passes
 * through it.** That is the one departure from the paper, and the cost is
 * why. Dendry joins a key point to the nearest stream in a 5 × 5 window of
 * every coarser level, which makes a cell depend on its neighbors' streams,
 * each of which depends on *its* neighbors' — a cone of dependencies nine
 * cells wide at every level. Built that way, one isolated sample asked for
 * 460 cells across six levels and cost 1.5 ms, and a coarse patch's samples
 * are each isolated at the fine levels. Confined to the parent, a creek's
 * candidates are the streams through that parent: the lattice's, and at each
 * refined level the creeks of the one ancestor that contains it. A cell
 * depends on its ancestors' families and on nothing beside them, so the
 * dependencies are a chain and not a cone. The joins are still the nearest,
 * so no creek crosses a stream it could have joined; what is lost is a creek
 * crossing its parent's edge, and a valley still does, by its reach.
 *
 * **What Dendry evaluates per point, this builds once per cell.** A family —
 * one parent's children — is built once, a creek's floors once when a list
 * first needs them, and the list of every creek whose valley reaches a cell
 * once. Each is kept in a cache keyed by (level, cell), and a sample pays a
 * map read and a distance to each entry of one list a level. The
 * construction is the cost, and ADR-0054 measures it.
 *
 * **Order independence is the design.** A family is a function of its
 * parent's address, the parent's key point and the families of the parent's
 * ancestors; a creek's floors of its control and the floors of the stream it
 * joins; a list of the four families whose creeks can reach the cell. None
 * reads what happened to be built first, so evicting a cell and building it
 * again gives the same records, to the bit — which is the whole answer to
 * "two caches disagree": nothing a cache holds could be rebuilt differently.
 *
 * **Every decision is taken on the CPU, in float64.** Which stream is
 * nearest, where the junction falls, whether a key point is under water —
 * each is a ranking, and a ranking taken in float32 on the GPU could land the
 * other way. The kernel samples the lists this builds and builds nothing. And
 * the field never reads the nearest: a list holds every creek whose valley
 * reaches any point of its cell, so both cells a float could name at a
 * boundary list everything within reach of it, and every profile reaches zero
 * before the reach.
 *
 * **The refined network lives in the lattice's lookup space**, where the
 * lattice's chords are straight; a creek joining a trunk joins the chord the
 * walk measures. The control — the ground a creek is cut into — is read at
 * the key point's preimage under the warp, which `drainage.ts` supplies.
 *
 * **The physics is the lattice's, passed in.** Floors, widths and the cut a
 * stream makes at its head come from `drainage.ts` through `RefinementHost`,
 * so a refined creek and a lattice trunk are the same law at two areas. The
 * host is an interface rather than an import because `drainage.ts` reads this
 * module from inside its carve, and a module that read `drainage.ts` back
 * would close a cycle `knip` refuses.
 */

/**
 * The numbers the refinement is built with. Exported for the reason
 * `DRAINAGE_SHAPE` is: the kernel and the tests read the same ones.
 */
export const REFINEMENT_SHAPE = {
  /**
   * The finest refined cell, meters: the levels continue until a cell is at
   * most this. The level cap per body, from the body's radius, so a creek is
   * the same few meters wide on Earth as on a generated world half its size.
   */
  finestCell: 2_500,
  /**
   * How far a key point sits from its cell's center, in cells per axis —
   * Dendry's `0.5 − ε` with `ε = 0.25`, the paper's own choice: the point is
   * in the middle half of its cell, so no two points of one level are closer
   * than half a cell and none sits on an edge.
   */
  jitter: 0.25,
  /**
   * The midpoint's displacement off the chord, as a fraction of its length:
   * Dendry's `Δ`, at the paper's ceiling of 0.08. Above it a creek can cross
   * its neighbor.
   */
  perturbation: 0.08,
  /**
   * How far inside its parent a junction must sit, in cells of the creek's
   * own level: a key point's own distance from its cell's edge, so a creek
   * is as far from its parent's edge at both ends.
   */
  margin: 0.25,
  /**
   * The longest the junction angle may slide a creek's mouth along the
   * stream it joins, in cells (Howard 1971 — see `#family`).
   */
  longest: 1.5,
  /**
   * The valley's half-width — where the carve reaches zero — in cells. Under
   * the lattice's 0.6 because a level's creeks run side by side about a cell
   * apart, where the lattice's segments meet end to end, and a valley that
   * reaches its neighbor's bed cuts that bed toward the neighbor's floor.
   * Measured as the median rise along a creek at the coarsest refined
   * level, 0.6 → 0.45 moved Earth 7.3 → 3.1 m and the test world 1.7 → 1.0
   * and Gliese 908 IV 3.8 → 5.4: not a clean win, and taken for the
   * narrower fill a creek lays over a hollow.
   */
  reach: 0.45,
  /**
   * A creek's upstream area at its head, as a fraction of its cell's: one of
   * the four children a cell divides into. At the junction it is the whole
   * cell, whose every finer creek drains through it.
   */
  headArea: 0.25,
  /** Families and lists a level keeps, each. */
  capacity: 16_384,
} as const

/**
 * Floats per record, refined or lattice:
 * `[ax ay az fA] [bx by bz fB] [wA wB hA hB] [standing · · ·]` — the
 * lattice's segment record, so the walk and the kernel read both with one
 * loop.
 */
export const RECORD_STRIDE = 16

/** The ground a level's creeks are cut into, and the water standing on it. */
export interface RefinementControl {
  /** Meters: the field before this level's carve and before any channel's notch. */
  readonly surface: Meters
  /** Meters, or NaN where nothing stands. */
  readonly water: Meters
}

/** What a channel draining an area is, by the lattice's laws. */
export interface RefinementChannel {
  /** Radians on the unit sphere. */
  readonly halfWidth: number
  readonly depth: Meters
  /** Flint's channel slope, rise over run. */
  readonly slope: number
  /** How far under the ground the channel's floor sits at its head. */
  readonly incision: Meters
}

/** The lattice, and the laws a refined creek shares with it. */
export interface RefinementHost {
  readonly level: number
  readonly cells: number
  readonly cellStart: Uint32Array
  readonly cellSegments: Uint32Array
  readonly segments: Float32Array
  readonly radius: Meters
  readonly seedLane: number
  /** Where the node of lattice cell (face, i, j) sits in it, cell units. */
  latticePoint(face: number, i: number, j: number): readonly [number, number]
  /** The ground at a lookup direction with every level coarser than `level` cut. */
  control(lookup: Vec3, level: number): RefinementControl
  /** The channel of `areaMeters` square meters cut into ground at `ground` meters. */
  channel(areaMeters: number, ground: Meters): RefinementChannel
}

/**
 * The finest region level the refinement descends to on a body with a
 * lattice at `latticeLevel`: the first whose cell is at most `finestCell`.
 */
export function refinementDepth(radius: Meters, latticeLevel: number): number {
  let level = latticeLevel
  while ((Math.PI * radius) / 2 / 2 ** level > REFINEMENT_SHAPE.finestCell) {
    level += 1
  }
  return level
}

/**
 * One cell's creek: its key point, its perturbed midpoint and its junction,
 * the stream the junction lies on, and — once a list has needed them — its
 * records with floors.
 */
interface Creek {
  readonly level: number
  /** `q`, `m`, `x`: three unit directions. */
  readonly path: Float64Array
  /** The stream joined: a lattice record, or a coarser creek's sub-segment. */
  readonly joined: Float32Array | Creek
  /** Where in `joined` — a record offset for the lattice, 0 or 1 for a creek. */
  readonly at: number
  readonly t: number
  /** Built on first use; null while unbuilt. */
  records: Float32Array | null
  /** Whether it is listed nowhere — see `#floors`; known with the records. */
  hidden: boolean
}

/** A cache entry and the tick it was last moved to the young end. */
interface Kept<T> {
  readonly value: T
  stamp: number
}

/**
 * One level's two caches: the families whose children are at this level,
 * keyed by the parent cell, and the lists of this level's cells.
 *
 * Least-recently-used by insertion order, refreshed lazily: a hit moves an
 * entry to the young end only once it has aged past half the capacity, so a
 * sample walking a hot cell pays a map read rather than a delete and an
 * insert. The bound is what is resident — a descent's patches touch a few
 * thousand cells a level near the camera — and an evicted cell is rebuilt to
 * the bit, so the bound costs time and never changes the ground.
 */
class LevelCache {
  readonly level: number
  readonly span: number
  /** A cell's edge, radians on the unit sphere at the face's center. */
  readonly cell: number
  readonly reach: number
  readonly families = new Map<number, Kept<readonly (Creek | null)[]>>()
  readonly lists = new Map<number, Kept<Float32Array>>()
  builtFamilies = 0
  builtLists = 0
  builtFloors = 0
  readonly hidden = { under: 0, water: 0 }

  constructor(level: number) {
    this.level = level
    this.span = 2 ** level
    this.cell = Math.PI / 2 / this.span
    this.reach = REFINEMENT_SHAPE.reach * this.cell
  }
}

const EMPTY = new Float32Array(0)

/** The nine marks a cell is tested at: the center first, then a corner. */
const MARKS: readonly (readonly [number, number])[] = [
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

/*
 * Each cube face's normal and its two in-face axes, so a point's face
 * coordinates are `(U·p / N·p, V·p / N·p)` — `faceToDirection` inverted for a
 * named face rather than the dominant one, which is what clipping a chord to
 * a cell needs: a chord crossing an edge stays on the cell's face's terms.
 */
const FACE_AXES: readonly (readonly number[])[] = [
  [1, 0, 0, 0, 0, -1, 0, 1, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 0, 0, 0, -1],
  [0, -1, 0, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, 0, -1, -1, 0, 0, 0, 1, 0],
]

/** The carve as the refined levels read and leave it: see `Refinement.carve`. */
export interface RefinedCarve {
  /** Meters: the ground with every valley cut and filled, before the notch. */
  surface: Meters
  /** Meters: the deepest channel notch over the sample, at any level. */
  notch: Meters
  /** The largest bed over the sample, 0..1. */
  channel: number
  /** The largest floodplain margin over the sample, 0..1. */
  corridor: number
  /** The sum of every bed over the sample, lattice and refined alike. */
  beds: number
  /** Meters: the sum of every bed over the sample times its water's level. */
  levels: number
}

/**
 * Each refined record in reach of a sample, as `Refinement.carve`'s second pass reads
 * it: floor, valley shape, bed, depth, standing water, corridor, the creek
 * it belongs to, and how much of its fill reaches past its end. One array for every carve on the thread, grown when a
 * list outgrows it.
 */
const REACHED = 8
let IN_REACH = new Float64Array(64 * REACHED)
/** Per creek of the list, the largest bed of its records in reach. */
let CREEK_BED = new Float64Array(64)

/**
 * A body's refinement: the levels below its lattice, built on demand and
 * kept within `capacity` families and lists a level.
 */
export class Refinement {
  /** The first refined level, one below the lattice. */
  readonly first: number
  /** The last, inclusive. */
  readonly last: number
  readonly #host: RefinementHost
  readonly #levels: LevelCache[] = []
  #tick = 0

  constructor(host: RefinementHost, last: number) {
    invariant(last >= host.level, 'a refinement ends at or below its lattice')
    this.#host = host
    this.first = host.level + 1
    this.last = last
    for (let level = this.first; level <= last; level += 1) {
      this.#levels.push(new LevelCache(level))
    }
  }

  /**
   * What each level has built — families, creeks' floors and lists — and of
   * the floors, how many creeks are hidden and why (`#floors`).
   */
  built(): readonly {
    level: number
    families: number
    floors: number
    lists: number
    hidden: { readonly under: number; readonly water: number }
  }[] {
    return this.#levels.map((cache) => ({
      level: cache.level,
      families: cache.builtFamilies,
      floors: cache.builtFloors,
      lists: cache.builtLists,
      hidden: { ...cache.hidden },
    }))
  }

  /**
   * The refined levels' carve at a lookup direction, coarsest first and
   * stopping after `last`, into the state the lattice's walk left —
   * `drainage.ts`'s `walk` hands it in and reads it back.
   *
   * **A refined level cuts into what the coarser ones left**, rather than
   * into the landform beside them in one maximum. Its floors were set against
   * that ground — the control `refinementHost` reads is the same walk, stopped
   * at the level — so a creek's cut is its own height over the hillside the
   * valleys above it made, and a maximum over the raw landform would measure
   * it against ground that is no longer there.
   *
   * **A refined level cuts and fills, as the lattice does.** Its floors are
   * set against the control, which stops at the level's own cell, and the
   * field under a creek does not: on Earth a level-9 creek near the summit
   * site crosses a hollow 260 m under its control in five kilometers. A
   * creek that only cut followed every such hollow down and up again: the
   * surface a walker stands on rose along the median creek by 13 to 37 m at
   * the two coarsest refined levels of the test world, and along one creek in
   * ten by 250 m at Earth's coarsest. Filled to its floor, the bed is the
   * floor line, and at level 8 and finer the median creek on Gliese 908 IV,
   * Earth and the far shore rises by a fifth of a meter at most. What the fill
   * costs is the hollow it lays alluvium over; ADR-0054 carries that figure.
   *
   * **A record fills nothing past its own downstream end, and a finer level
   * never fills a coarser level's channel.** A sample past a record's end
   * projects onto that end and reads its floor there, which is above the bed
   * that continues downstream of it: past a creek's bend, the head record held
   * the mouth record's bed four meters over its floor a hundred meters on, and
   * past a junction, an unguarded fill raises the trunk's banks into a dam. So
   * the fill fades out over the record's floodplain beyond its end, and is
   * weighted by what is not already a coarser channel, which leaves a trunk's
   * bed alone where a creek's record runs beside it. A fade toward the
   * junction along the creek's last record did this job worse: it scaled with
   * the record, and on a hundred-kilometer creek at the coarsest level it
   * thinned the fill over the last forty kilometers into a chain of dips. The
   * cut needs neither guard: upstream of a junction a creek pulls the bed
   * toward the junction's floor, which is lower, by a weight that grows toward
   * the junction — monotone — and downstream of it the creek's floor is the
   * higher, so it cuts nothing.
   *
   * **A bed holds its own floor against its neighbors.** The lattice's rule,
   * the deepest cut and the tallest fill each taken over every record and
   * added, lets a neighbor's fill cancel a creek's cut on the creek's own bed;
   * at the lattice's spacing a neighbor's valley rarely reaches a bed, and at
   * a refined level's it often does, because a level's creeks run side by
   * side a cell apart. So each record's cut and fill is weighted by one less
   * the largest bed of any other creek of its level at the sample — a maximum
   * of continuous terms, so no rank is read — and on a bed the creek is alone.
   * A creek is two records that share its bend, and they count as one, or
   * each would erase the other there. Measured as the rise along a creek at
   * the coarsest refined level, the ninetieth percentile on Earth went from
   * 24 m to 6.5 m.
   *
   * **A creek's own water stands no higher than the ground it runs on**,
   * which differs from its floor only where the record leaves part of a
   * hollow under the floor unfilled — a coarser channel refusing the fill,
   * another creek's bed, the record's own end. The level is the ground the
   * record leaves, which is the floor wherever it cuts and the floor less
   * the unfilled part of the hollow where it fills, so it is continuous
   * wherever the fill is. A lake or the sea
   * drowning the reach it joins stands at its own level, as it does over the
   * lattice's. Each record adds its level weighted by its bed to the sums
   * `riverLevel` reads, and a level is never chosen: see there.
   */
  carve(lookup: Vec3, state: RefinedCarve, last: number): void {
    const x = lookup.x
    const y = lookup.y
    const z = lookup.z
    let surface = state.surface
    let notch = state.notch
    let channel = state.channel
    let corridor = state.corridor
    let beds = state.beds
    let levels = state.levels
    let coarser = channel
    const final = Math.min(this.last, last)
    for (let level = this.first; level <= final; level += 1) {
      const records = this.list(level, lookup)
      const fine = this.reach(level)
      // First the records in reach, and the two largest beds among them.
      if (records.length / RECORD_STRIDE > CREEK_BED.length) {
        IN_REACH = new Float64Array((records.length / RECORD_STRIDE) * REACHED)
        CREEK_BED = new Float64Array(records.length / RECORD_STRIDE)
      }
      let reached = 0
      let creeks = -1
      for (let at = 0; at < records.length; at += RECORD_STRIDE) {
        const ax = records[at] as number
        const ay = records[at + 1] as number
        const az = records[at + 2] as number
        // A creek is two records sharing its bend, listed one after the other;
        // a record that starts where the one before it ended is the same creek.
        if (
          at === 0 ||
          ax !== records[at - RECORD_STRIDE + 4] ||
          ay !== records[at - RECORD_STRIDE + 5] ||
          az !== records[at - RECORD_STRIDE + 6]
        ) {
          creeks += 1
          CREEK_BED[creeks] = 0
        }
        const bx = (records[at + 4] as number) - ax
        const by = (records[at + 5] as number) - ay
        const bz = (records[at + 6] as number) - az
        const length = bx * bx + by * by + bz * bz
        const raw =
          length > 0
            ? ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / length
            : 0
        const t = Math.min(1, Math.max(0, raw))
        const d = toArc(x, y, z, ax, ay, az, bx, by, bz, t)
        if (d >= fine) continue
        const fA = records[at + 3] as number
        const fB = records[at + 7] as number
        const wA = records[at + 8] as number
        const wB = records[at + 9] as number
        const halfWidth = wA + (wB - wA) * t
        const hA = records[at + 10] as number
        const hB = records[at + 11] as number
        const plain = Math.min(
          DRAINAGE_SHAPE.floodplain * halfWidth,
          0.8 * fine,
        )
        const bed = bedShape(d, halfWidth)
        const beyond = raw > 1 ? (raw - 1) * Math.sqrt(length) : 0
        const o = reached * REACHED
        IN_REACH[o] = fA + (fB - fA) * t
        IN_REACH[o + 1] = valleyShape(d, halfWidth, plain, fine)
        IN_REACH[o + 2] = bed
        IN_REACH[o + 3] = hA + (hB - hA) * t
        IN_REACH[o + 4] = records[at + 12] as number
        IN_REACH[o + 5] = 1 - smoothstep(plain, Math.min(fine, plain * 2), d)
        IN_REACH[o + 6] = creeks
        IN_REACH[o + 7] = 1 - smoothstep(0, plain, beyond)
        reached += 1
        if (bed > (CREEK_BED[creeks] as number)) CREEK_BED[creeks] = bed
      }
      // The largest bed of any creek, and of any creek but that one.
      let firstCreek = -1
      let firstBed = 0
      let secondBed = 0
      for (let g = 0; g <= creeks; g += 1) {
        const bed = CREEK_BED[g] as number
        if (bed > firstBed) {
          secondBed = firstBed
          firstBed = bed
          firstCreek = g
        } else if (bed > secondBed) secondBed = bed
      }
      let levelCut = 0
      let levelFill = 0
      for (let k = 0; k < reached; k += 1) {
        const o = k * REACHED
        const floor = IN_REACH[o] as number
        const shape = IN_REACH[o + 1] as number
        const bed = IN_REACH[o + 2] as number
        const standing = IN_REACH[o + 4] as number
        const others =
          1 -
          ((IN_REACH[o + 6] as number) === firstCreek ? secondBed : firstBed)
        const valley = surface - floor
        // How much of a hollow under the floor this record fills.
        const filled =
          shape * others * (1 - coarser) * (IN_REACH[o + 7] as number)
        if (valley >= 0) {
          const here = valley * shape * others
          if (here > levelCut) levelCut = here
        } else {
          const here = -valley * filled
          if (here > levelFill) levelFill = here
        }
        const here = (IN_REACH[o + 3] as number) * bed
        if (here > notch) notch = here
        if (bed > channel) channel = bed
        const margin = IN_REACH[o + 5] as number
        if (margin > corridor) corridor = margin
        // The creek's own water, at its floor or the ground it leaves
        // there, whichever is lower; the lake or sea it joins where higher.
        const own = valley >= 0 ? floor : surface - valley * filled
        beds += bed
        levels += bed * (standing > own ? standing : own)
      }
      surface = surface - levelCut + levelFill
      coarser = channel
    }
    state.surface = surface
    state.notch = notch
    state.channel = channel
    state.corridor = corridor
    state.beds = beds
    state.levels = levels
  }

  /** The valley's half-width at a refined level, radians. */
  reach(level: number): number {
    return this.#cache(level).reach
  }

  /**
   * Every refined record whose valley reaches the cell `lookup` falls in at
   * `level`.
   *
   * The cell is taken in a float, exactly as `regionForDirection` takes it,
   * and that is allowed for the reason the lattice's own lookup gives: the
   * two cells a boundary sample could name both list everything within reach
   * of the boundary.
   */
  list(level: number, lookup: Vec3): Float32Array {
    const { face, u, v } = directionToFace(lookup)
    const span = 2 ** level
    const i = Math.min(span - 1, Math.max(0, Math.floor(((u + 1) / 2) * span)))
    const j = Math.min(span - 1, Math.max(0, Math.floor(((v + 1) / 2) * span)))
    return this.listAt(level, face, i, j)
  }

  /** The same list, for a cell named by its address. */
  listAt(level: number, face: number, i: number, j: number): Float32Array {
    const cache = this.#cache(level)
    const key = (face * cache.span + i) * cache.span + j
    const held = this.#read(cache.lists, key)
    if (held !== undefined) return held
    const built = this.#buildList(cache, face, i, j)
    this.#keep(cache.lists, key, built)
    cache.builtLists += 1
    return built
  }

  #cache(level: number): LevelCache {
    const cache = this.#levels[level - this.first]
    invariant(cache !== undefined, `level ${level} is not refined here`)
    return cache
  }

  #read<T>(map: Map<number, Kept<T>>, key: number): T | undefined {
    const kept = map.get(key)
    if (kept === undefined) return undefined
    if (this.#tick - kept.stamp > REFINEMENT_SHAPE.capacity / 2) {
      map.delete(key)
      kept.stamp = this.#tick
      map.set(key, kept)
    }
    return kept.value
  }

  #keep<T>(map: Map<number, Kept<T>>, key: number, value: T): void {
    this.#tick += 1
    map.set(key, { value, stamp: this.#tick })
    while (map.size > REFINEMENT_SHAPE.capacity) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /* --- a family: one parent's children ------------------------------------ */

  /** Where a refined cell's key point sits in it, cell units, from its hash. */
  #point(level: number, face: number, i: number, j: number): [number, number] {
    const hash = pcg4d(i ^ this.#host.seedLane, j, face | (level << 3), 1301)
    return [
      0.5 + (toUnit(hash.x) * 2 - 1) * REFINEMENT_SHAPE.jitter,
      0.5 + (toUnit(hash.y) * 2 - 1) * REFINEMENT_SHAPE.jitter,
    ]
  }

  /**
   * The creeks of the four children of parent cell (face, pi, pj), at
   * `level`; null for a child that has none.
   *
   * **A child inherits its parent's key point, and owns no creek.** Dendry
   * replicates each key point into the finer grid rather than drawing a fresh
   * one beside it: the parent's point is already on the tree, and a second
   * point in the same child would be a spur a few meters long joining the
   * tree where it already is. The child holding the parent's point is the one
   * the point's own coordinates fall in, which is exact — a child's
   * coordinates are its parent's, doubled.
   */
  #family(
    level: number,
    face: number,
    pi: number,
    pj: number,
  ): readonly (Creek | null)[] {
    const cache = this.#cache(level)
    const parentSpan = cache.span / 2
    const key = (face * parentSpan + pi) * parentSpan + pj
    const held = this.#read(cache.families, key)
    if (held !== undefined) return held
    const built = this.#buildFamily(cache, face, pi, pj)
    this.#keep(cache.families, key, built)
    cache.builtFamilies += 1
    return built
  }

  #buildFamily(
    cache: LevelCache,
    face: number,
    pi: number,
    pj: number,
  ): readonly (Creek | null)[] {
    const level = cache.level
    const host = this.#host
    const [ps, pt] =
      level - 1 === host.level
        ? host.latticePoint(face, pi, pj)
        : this.#point(level - 1, face, pi, pj)
    const heir = (ps >= 0.5 ? 1 : 0) + 2 * (pt >= 0.5 ? 1 : 0)

    /*
     * The streams through the parent: the lattice's segments listed in the
     * lattice cell that holds it, and at every refined level the creeks of
     * the one ancestor that holds it — a creek lies inside its own parent, so
     * no other family's creek can pass through this one. Every candidate is
     * clipped to the parent shrunk by `margin`, in the parent's face
     * coordinates, so the creek a child draws to it stays inside the parent.
     * Every family first, every clip after: a family not yet built builds its
     * own, and that must finish before this one reads anything.
     */
    const ancestors: (readonly (Creek | null)[])[] = []
    for (let coarser = this.first; coarser < level; coarser += 1) {
      const up = level - coarser
      ancestors.push(this.#family(coarser, face, pi >> up, pj >> up))
    }
    const parentSpan = cache.span / 2
    const unit = 2 / parentSpan
    const inset = (REFINEMENT_SHAPE.margin * unit) / 2
    const bounds = [
      (pi / parentSpan) * 2 - 1 + inset,
      ((pi + 1) / parentSpan) * 2 - 1 - inset,
      (pj / parentSpan) * 2 - 1 + inset,
      ((pj + 1) / parentSpan) * 2 - 1 - inset,
    ] as const
    const candidates: Candidate[] = []
    const shift = level - 1 - host.level
    const node =
      (face * host.cells + (pi >> shift)) * host.cells + (pj >> shift)
    const from = host.cellStart[node] as number
    const to = host.cellStart[node + 1] as number
    for (let k = from; k < to; k += 1) {
      const at = (host.cellSegments[k] as number) * RECORD_STRIDE
      const s = host.segments
      clipInto(
        candidates,
        face,
        bounds,
        s[at] as number,
        s[at + 1] as number,
        s[at + 2] as number,
        s[at + 4] as number,
        s[at + 5] as number,
        s[at + 6] as number,
        s,
        at,
        host.level,
      )
    }
    for (const family of ancestors) {
      for (const creek of family) {
        if (creek === null) continue
        const p = creek.path
        for (let sub = 0; sub < 2; sub += 1) {
          const o = sub * 3
          clipInto(
            candidates,
            face,
            bounds,
            p[o] as number,
            p[o + 1] as number,
            p[o + 2] as number,
            p[o + 3] as number,
            p[o + 4] as number,
            p[o + 5] as number,
            creek,
            sub,
            creek.level,
          )
        }
      }
    }

    const children: (Creek | null)[] = []
    for (let child = 0; child < 4; child += 1) {
      const i = pi * 2 + (child & 1)
      const j = pj * 2 + (child >> 1)
      children.push(
        child === heir || candidates.length === 0
          ? null
          : this.#creek(cache, face, i, j, candidates),
      )
    }
    return children
  }

  /**
   * One child's creek: from its key point to the nearest point of the
   * candidates, slid downstream for the junction angle, bent at the middle.
   */
  #creek(
    cache: LevelCache,
    face: number,
    i: number,
    j: number,
    candidates: readonly Candidate[],
  ): Creek {
    const level = cache.level
    const host = this.#host
    const [s, t] = this.#point(level, face, i, j)
    const q = regionDirection(regionAddress(face, level, i, j), s, t)

    // The nearest foot, measured to the foot lifted onto the sphere: a
    // lattice chord sags under the surface by its length squared over eight
    // — five hundred meters on Earth's longest — and a foot left under the
    // ground would rank a chord's middle behind its ends for nothing the map
    // shows. Strict, so the first of equals wins.
    let best = candidates[0] as Candidate
    let bestT = 0
    let bestD = Infinity
    for (const candidate of candidates) {
      const foot = nearestOn(candidate, q)
      if (foot.d < bestD) {
        bestD = foot.d
        bestT = foot.t
        best = candidate
      }
    }

    /*
     * The junction angle (Howard 1971): `cos α = S_m / S_n`, the trunk's
     * slope over the creek's, made by sliding the mouth downstream of the
     * foot by the perpendicular distance times `cot α`. The trunk's slope is
     * not known until its floors are, which is later and lazy; the angle is
     * geometry and has to be settled now, so it reads the slopes Flint's law
     * gives the two areas — the trunk's cell at its own level, the lattice's
     * one cell at least, against the creek's — which is the ratio the floors
     * have wherever the control does not bind. A creek joining a creek one
     * level up meets it at 58°, and one joining the lattice nearly square.
     * Bounded by `longest` and by the end of the candidate inside the
     * parent.
     */
    const area = cache.cell * cache.cell * host.radius * host.radius
    const ratio = Math.min(
      0.99,
      host.channel(area * 4 ** (level - best.level), 0).slope /
        host.channel(area, 0).slope,
    )
    const slide = (bestD * ratio) / Math.sqrt(1 - ratio * ratio)
    const lx = best.bx - best.ax
    const ly = best.by - best.ay
    const lz = best.bz - best.az
    const chord = Math.sqrt(lx * lx + ly * ly + lz * lz)
    let tj = bestT
    if (chord > 0) {
      const reachable = REFINEMENT_SHAPE.longest * cache.cell
      const allowed = Math.sqrt(
        Math.max(0, reachable * reachable - bestD * bestD),
      )
      tj = Math.min(best.t1, bestT + Math.min(slide, allowed) / chord)
    }
    let xx = best.ax + lx * tj
    let xy = best.ay + ly * tj
    let xz = best.az + lz * tj
    const lift = 1 / Math.sqrt(xx * xx + xy * xy + xz * xz)
    xx *= lift
    xy *= lift
    xz *= lift

    /*
     * The midpoint, off the chord by up to `perturbation` of its length:
     * Dendry's displacement, which turns spokes into creeks. Perpendicular to
     * the chord in the tangent plane, by the cell's own hash, so it is the
     * same creek from every patch — and at most an eighth of a cell, inside
     * the margin, so the creek stays inside its parent.
     */
    const hash = pcg4d(i ^ host.seedLane, j, face | (level << 3), 1303)
    const bend = (toUnit(hash.z) * 2 - 1) * REFINEMENT_SHAPE.perturbation
    const dx = xx - q.x
    const dy = xy - q.y
    const dz = xz - q.z
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
    let mx = (q.x + xx) / 2
    let my = (q.y + xy) / 2
    let mz = (q.z + xz) / 2
    const px = dy * mz - dz * my
    const py = dz * mx - dx * mz
    const pz = dx * my - dy * mx
    const across = Math.sqrt(px * px + py * py + pz * pz)
    if (across > 0) {
      const push = (bend * length) / across
      mx += px * push
      my += py * push
      mz += pz * push
    }
    const norm = 1 / Math.sqrt(mx * mx + my * my + mz * mz)
    mx *= norm
    my *= norm
    mz *= norm

    const path = new Float64Array([q.x, q.y, q.z, mx, my, mz, xx, xy, xz])
    return {
      level,
      path,
      joined: best.source,
      at: best.at,
      t: tj,
      records: null,
      hidden: false,
    }
  }

  /**
   * A creek's records, with floors: built the first time a list needs them.
   *
   * **The floors.** The joined stream's floor at the junction; at the bend
   * and then at the head, the lattice's rule — the lesser of the ground less
   * the vertex's cut and the Flint climb from the vertex below, floored at
   * that vertex's, so nothing runs uphill — and linear along each record
   * between. The ground is the control: the stack read down to this level's
   * cell, with every coarser cut already in it, so a creek follows the
   * hillside the coarser valleys left and not the noise below its own scale.
   * The cut at a vertex is the lattice's own law at the area draining
   * through it, a quarter cell at the head and the whole cell at the
   * junction: a share of the height over the junction was tried as a deeper
   * cut and moved the finest level's median creek by nothing measurable.
   *
   * **Two creeks keep their floors and are listed nowhere.** One whose head
   * stands under a lake or the sea: under standing water its fill would
   * raise the bed toward a floor the flood never reached. And one whose head
   * stands under the floor of the stream it joins: the join is the nearest
   * stream, not the lowest, and a key point in a hollow beside a river is
   * nearer that river than anything lower — floored at the junction, its
   * creek runs flat at the river's level over ground below it, and its fill
   * builds a causeway along it. The lattice cannot make that mistake,
   * because its flood hands every node a receiver it was reached from; a
   * refinement that joined by elevation would need every neighbor's floors
   * to build one creek, which is the cone again.
   *
   * A hidden creek keeps its floors so a creek joining it from above has a
   * floor to meet, and that creek is judged on its own head: it is drawn
   * running into the hollow the hidden one stands in, which is a closed
   * basin rather than a defect. Hiding the whole subtree under every hidden
   * creek was tried, and with a fifth of each level hidden for its own head
   * it left seven creeks in ten at the finest level hidden for an ancestor's.
   */
  #floors(creek: Creek): Float32Array {
    if (creek.records !== null) return creek.records
    const host = this.#host
    const cache = this.#cache(creek.level)
    const p = creek.path
    let fA: number
    let fB: number
    let standing: number
    if (creek.joined instanceof Float32Array) {
      const r = creek.joined
      fA = r[creek.at + 3] as number
      fB = r[creek.at + 7] as number
      standing = r[creek.at + 12] as number
    } else {
      const r = this.#floors(creek.joined)
      const o = creek.at * RECORD_STRIDE
      fA = r[o + 3] as number
      fB = r[o + 7] as number
      standing = r[o + 12] as number
    }
    const fX = fA + (fB - fA) * creek.t

    const first = Math.hypot(
      (p[3] as number) - (p[0] as number),
      (p[4] as number) - (p[1] as number),
      (p[5] as number) - (p[2] as number),
    )
    const second = Math.hypot(
      (p[6] as number) - (p[3] as number),
      (p[7] as number) - (p[4] as number),
      (p[8] as number) - (p[5] as number),
    )
    const along = first + second
    const share = along > 0 ? first / along : 0.5
    const cellArea = cache.cell * cache.cell * host.radius * host.radius
    const headArea = REFINEMENT_SHAPE.headArea * cellArea
    const midArea = headArea + (cellArea - headArea) * share

    /*
     * Up the creek from its junction, the lattice's rule at each vertex: the
     * lesser of the Flint climb from the floor below and the ground less the
     * vertex's cut, and never under the floor below. The ground is read at
     * the bend as well as at the head because a hillside is curved and a
     * floor is straight between its vertices: with the head alone, the line
     * from a head high on a concave flank to a junction at its foot rode
     * tens of meters over the ground at the middle, and the creek there was
     * either a causeway or not cut at all.
     */
    const m = { x: p[3] as number, y: p[4] as number, z: p[5] as number }
    const atM = host.control(m, creek.level)
    const mid = host.channel(midArea, atM.surface)
    const fM = Math.max(
      fX,
      Math.min(
        atM.surface - mid.incision,
        fX + mid.slope * second * host.radius,
      ),
    )
    const q = { x: p[0] as number, y: p[1] as number, z: p[2] as number }
    const atQ = host.control(q, creek.level)
    const head = host.channel(headArea, atQ.surface)
    const fQ = Math.max(
      fM,
      Math.min(
        atQ.surface - head.incision,
        fM + head.slope * first * host.radius,
      ),
    )
    const tail = host.channel(cellArea, atM.surface)

    const out = new Float32Array(2 * RECORD_STRIDE)
    out.set([p[0] as number, p[1] as number, p[2] as number, fQ])
    out.set([p[3] as number, p[4] as number, p[5] as number, fM], 4)
    out.set([head.halfWidth, mid.halfWidth, head.depth, mid.depth, standing], 8)
    out.set([p[3] as number, p[4] as number, p[5] as number, fM], 16)
    out.set([p[6] as number, p[7] as number, p[8] as number, fX], 20)
    out.set(
      [mid.halfWidth, tail.halfWidth, mid.depth, tail.depth, standing],
      24,
    )
    creek.records = out
    const under = atQ.surface < fX
    const drowned = !Number.isNaN(atQ.water) && atQ.water >= atQ.surface
    creek.hidden = under || drowned
    if (drowned) cache.hidden.water += 1
    else if (under) cache.hidden.under += 1
    cache.builtFloors += 1
    return out
  }

  /* --- one cell's list ----------------------------------------------------- */

  /**
   * Every creek of this level whose valley reaches the cell.
   *
   * A creek lies inside its parent, at least `margin` from the parent's edge
   * at both ends, so its valley reaches past the parent by `reach − margin`
   * at most — less than a cell. The families that can reach a cell are
   * therefore its own parent's and those of the three parents across the
   * cell's outer corner. Across a face edge they are found through
   * `regionNeighbor`, which wraps by direction and may name one twice at a
   * cube corner; each is read once.
   *
   * A record is listed when its valley reaches any of the cell's nine marks
   * within the reach plus half the cell's half-diagonal — no point of the
   * cell is farther than that from its nearest mark — which is the lattice
   * rasterizer's test, conservative by the same margin for the same reason.
   */
  #buildList(
    cache: LevelCache,
    face: number,
    i: number,
    j: number,
  ): Float32Array {
    const level = cache.level
    const region = regionAddress(face, level, i, j)
    const marks = new Float64Array(MARKS.length * 3)
    MARKS.forEach(([s, t], k) => {
      const mark = regionDirection(region, s, t)
      marks[k * 3] = mark.x
      marks[k * 3 + 1] = mark.y
      marks[k * 3 + 2] = mark.z
    })
    const kx = (marks[3] as number) - (marks[0] as number)
    const ky = (marks[4] as number) - (marks[1] as number)
    const kz = (marks[5] as number) - (marks[2] as number)
    const halfDiagonal = Math.sqrt(kx * kx + ky * ky + kz * kz)
    const near = cache.reach + halfDiagonal / 2
    const far = cache.reach + halfDiagonal

    const parent = regionAddress(face, level - 1, i >> 1, j >> 1)
    const di = (i & 1) === 0 ? -1 : 1
    const dj = (j & 1) === 0 ? -1 : 1
    const seen = new Set<number>()
    const found: Float32Array[] = []
    const parentSpan = cache.span / 2
    for (const [oi, oj] of [
      [0, 0],
      [di, 0],
      [0, dj],
      [di, dj],
    ] as const) {
      const other =
        oi === 0 && oj === 0 ? parent : regionNeighbor(parent, oi, oj)
      const key = (other.face * parentSpan + other.i) * parentSpan + other.j
      if (seen.has(key)) continue
      seen.add(key)
      for (const creek of this.#family(level, other.face, other.i, other.j)) {
        if (creek === null) continue
        const p = creek.path
        let listed = false
        for (let sub = 0; sub < 2 && !listed; sub += 1) {
          listed = reaches(p, sub * 3, marks, near, far)
        }
        if (!listed) continue
        const records = this.#floors(creek)
        if (creek.hidden) continue
        for (let sub = 0; sub < 2; sub += 1) {
          if (reaches(p, sub * 3, marks, near, far)) {
            found.push(
              records.subarray(sub * RECORD_STRIDE, (sub + 1) * RECORD_STRIDE),
            )
          }
        }
      }
    }
    if (found.length === 0) return EMPTY
    const out = new Float32Array(found.length * RECORD_STRIDE)
    found.forEach((record, k) => out.set(record, k * RECORD_STRIDE))
    return out
  }
}

/**
 * A stream through a parent cell, as a chord from `a` to `b` clipped to the
 * parameter interval `[t0, t1]` that lies inside the parent's inset square.
 */
interface Candidate {
  readonly ax: number
  readonly ay: number
  readonly az: number
  readonly bx: number
  readonly by: number
  readonly bz: number
  readonly t0: number
  readonly t1: number
  readonly source: Float32Array | Creek
  readonly at: number
  /** The level the stream belongs to: the lattice's for its segments. */
  readonly level: number
}

/**
 * Clip chord `a → b` to the square `bounds` = [u0, u1, v0, v1] of a face,
 * and keep it as a candidate if any of it is inside.
 *
 * Under the gnomonic map a chord's points have face coordinates
 * `(U·p / N·p, V·p / N·p)`, so each side of the square is one linear
 * inequality in the chord's parameter — exact, with no sampling — and the
 * interval inside is their intersection.
 */
function clipInto(
  out: Candidate[],
  face: number,
  bounds: readonly [number, number, number, number],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  source: Float32Array | Creek,
  at: number,
  level: number,
): void {
  const axes = FACE_AXES[face] as readonly number[]
  const dot = (o: number, x: number, y: number, z: number): number =>
    (axes[o] as number) * x +
    (axes[o + 1] as number) * y +
    (axes[o + 2] as number) * z
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const na = dot(0, ax, ay, az)
  const nd = dot(0, dx, dy, dz)
  const ua = dot(3, ax, ay, az)
  const ud = dot(3, dx, dy, dz)
  const va = dot(6, ax, ay, az)
  const vd = dot(6, dx, dy, dz)
  let t0 = 0
  let t1 = 1
  // Each constraint is `c0 + t·c1 >= 0`.
  const keep = (c0: number, c1: number): void => {
    if (c1 === 0) {
      if (c0 < 0) t1 = -1
      return
    }
    const root = -c0 / c1
    if (c1 > 0) {
      if (root > t0) t0 = root
    } else if (root < t1) t1 = root
  }
  keep(na, nd)
  keep(ua - bounds[0] * na, ud - bounds[0] * nd)
  keep(bounds[1] * na - ua, bounds[1] * nd - ud)
  keep(va - bounds[2] * na, vd - bounds[2] * nd)
  keep(bounds[3] * na - va, bounds[3] * nd - vd)
  if (t0 > t1) return
  out.push({ ax, ay, az, bx, by, bz, t0, t1, source, at, level })
}

/** The point of a candidate nearest `q`, and its distance to the lifted foot. */
function nearestOn(
  candidate: Candidate,
  q: Vec3,
): { readonly t: number; readonly d: number } {
  const lx = candidate.bx - candidate.ax
  const ly = candidate.by - candidate.ay
  const lz = candidate.bz - candidate.az
  const length = lx * lx + ly * ly + lz * lz
  const projected =
    length > 0
      ? ((q.x - candidate.ax) * lx +
          (q.y - candidate.ay) * ly +
          (q.z - candidate.az) * lz) /
        length
      : 0
  const t = Math.min(candidate.t1, Math.max(candidate.t0, projected))
  let fx = candidate.ax + lx * t
  let fy = candidate.ay + ly * t
  let fz = candidate.az + lz * t
  const lift = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz)
  fx = fx * lift - q.x
  fy = fy * lift - q.y
  fz = fz * lift - q.z
  return { t, d: Math.sqrt(fx * fx + fy * fy + fz * fz) }
}

/**
 * Whether a creek's sub-segment `path[o..o+5]` reaches a cell: any of its
 * nine marks within `near` of the chord, and the center alone rejecting a
 * cell wholly beyond `far` before the other eight are read.
 */
function reaches(
  path: Float64Array,
  o: number,
  marks: Float64Array,
  near: number,
  far: number,
): boolean {
  const ax = path[o] as number
  const ay = path[o + 1] as number
  const az = path[o + 2] as number
  const bx = (path[o + 3] as number) - ax
  const by = (path[o + 4] as number) - ay
  const bz = (path[o + 5] as number) - az
  const length = bx * bx + by * by + bz * bz
  // The walk measures to the arc over the chord, which a point on the ground
  // may be nearer than the chord by its sag, `length / 8` on the unit
  // sphere; widened by that, the chord's test still lists every creek the
  // walk can reach. `drainage.ts` § `toArc`.
  const sag = length / 8
  for (let k = 0; k < MARKS.length; k += 1) {
    const px = (marks[k * 3] as number) - ax
    const py = (marks[k * 3 + 1] as number) - ay
    const pz = (marks[k * 3 + 2] as number) - az
    const t =
      length > 0
        ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / length))
        : 0
    const ex = px - bx * t
    const ey = py - by * t
    const ez = pz - bz * t
    const d = Math.sqrt(ex * ex + ey * ey + ez * ez)
    if (d <= near + sag) return true
    if (k === 0 && d > far + sag) return false
  }
  return false
}
