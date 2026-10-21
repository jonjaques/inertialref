import { invariant } from '@inertialref/shared'
import { DEFAULT_FBM } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { RegionAddress } from './address.ts'
import { type StageId, stageOf } from './bandStack.ts'
import {
  ARC_SHAPE,
  BELT_SHAPE,
  CHAOS_SHAPE,
  DUNE_SHAPE,
  HYPSOMETRY_SHAPE,
  octavesFor,
  RELIEF_SHAPE,
  STRIPE_SHAPE,
  stripeChord,
  SULCI_SHAPE,
} from './bands.ts'
import { COVER_CHANNELS } from './cover.ts'
import { MAX_RAY_CRATERS, RAY_HARMONICS } from './craters.ts'
import {
  type DrainageGraph,
  drainageGraph,
  drainageLookup,
  drainageRefinement,
  NO_STANDING,
  regionDrainageLevel,
  SEGMENT_STRIDE,
} from './drainage.ts'
import { DRAINAGE_SHAPE, DRAINAGE_WARP_OFFSETS } from './drainageShape.ts'
import {
  GRIT_OCTAVES,
  gritCycles,
  gritRelief,
  MICRO_CRATER_CEILING,
} from './micro.ts'
import { directionToFace, faceToDirection } from './regions.ts'
import {
  type CraterLevel,
  MAX_CRATER_LEVELS,
  type TerrainSketch,
  terrainSketch,
} from './sketch.ts'
import type { SurfaceParameters } from './system.ts'
import {
  coastWidth,
  drainageDatum,
  heightfieldStride,
  regionDirection,
  seaDatumElevation,
} from './terrain.ts'

/*
 * The band stack as data: what a port of `drawnElevation` needs from a body
 * and from a region, in numbers a GPU can be handed.
 *
 * `elevationAt` is one function of a direction, and everything it reads that
 * is *not* the direction — the grammar's scalars, the sketch's plates and
 * hotspots and crater ladder, the octave counts `octavesFor` settles per band
 * — is a property of the body. This module flattens that into two fixed-layout
 * arrays, one of floats and one of unsigned words, so that a kernel evaluating
 * the same stack on another processor reads exactly what this one does. The
 * kernel is `apps/game/src/render/terrainKernel.ts`; the layout below is the
 * contract between them, and `terrainProducer.gpu.test.ts` holds the two
 * evaluations to a stated tolerance.
 *
 * **A tile carries a frame, and the frame is why this file exists at all.** A
 * one-meter crater on a 1,700 km body subtends 3 × 10⁻⁷ of a radian, and a
 * float32 unit vector resolves 6 × 10⁻⁸ — a fifth of that crater, and the
 * whole of the grit's finest octave. Evaluating `direction · cells` in float32
 * from an absolute direction therefore quantizes every fine rung out of
 * existence, and it does so differently on either side of every patch edge,
 * which is a seam. So the kernel never evaluates a fine lattice coordinate
 * from an absolute direction: `writeTileFrame` computes, in float64, the
 * lattice cell the patch's *center* falls in at every rung — an integer, exact
 * in float32 up to 2²⁴ — and the fraction beside it, and the kernel adds only
 * the sample's *offset* from that center, which it derives from the exact
 * face coordinates and which stays under 2⁻¹⁶ of a radian at the levels where
 * the fine rungs are resolved. The coarse bands read an absolute float32
 * direction, because at their scales the same 6 × 10⁻⁸ is under a thousandth
 * of a cell.
 */

/*
 * The most of each list a body can carry, and where the number comes from.
 *
 * Plates: `surfaceGrammar` rounds `mix(8, 30, …)`, so thirty. Hotspots:
 * `rng.int(6, 6 + round(8 · mobility))` with mobility clamped to one, so
 * fourteen. Stripes: four, written into `derive`. Levels: `MAX_CRATER_LEVELS`
 * canonical rungs and the tail from eight meters to one, which is four more.
 * Rays: `MAX_RAY_CRATERS`. Each is checked at pack time, so a grammar that
 * grew past one fails here rather than overrunning a buffer on the GPU.
 */
export const MAX_KERNEL_PLATES = 30
export const MAX_KERNEL_HOTSPOTS = 14
export const MAX_KERNEL_STRIPES = 4
export const MAX_KERNEL_LEVELS = MAX_CRATER_LEVELS + 4
export const MAX_KERNEL_RAYS = MAX_RAY_CRATERS
/**
 * The deepest region level a tile frame is exact at. A face coordinate at
 * level `n` is a multiple of `2⁻ⁿ`, and `writeTileFrame` carries the corner
 * and the sample step as float32 fractions of the cell; past 23 the step is
 * below the mantissa and the frame would round. A source that produces tiles
 * from the kernel says so through `HeightfieldSource.maxLevel`, and the
 * streamer sends anything deeper to the pool.
 */
export const MAX_TILE_LEVEL = 23

/*
 * The float records, in `vec4` slots. Every list is a run of fixed-size
 * records at a fixed offset, so the kernel indexes it with arithmetic.
 *
 *   plate    [ax ay az continental] [mx my mz base] [step · · ·]
 *   hotspot  [ax ay az radius] [strength caldera · ·]
 *   stripe   [px py pz halfWidth] [offset end taper ·] [cx cy cz ·]
 *   level    [cells diameter density rung]
 *   ray      [ax ay az angularRadius] [tx ty tz age] [bx by bz cosReach]
 *            [phase0 phase1 phase2 phase3] [phase4 phase5 · ·]
 */
export const PLATE_STRIDE = 3
export const HOTSPOT_STRIDE = 2
export const STRIPE_STRIDE = 3
export const LEVEL_STRIDE = 1
export const RAY_STRIDE = 5

/** The scalars, as flat float indices into the head of the records. */
export const SCALAR = {
  BUDGET: 0,
  ROUGHNESS: 1,
  SEA_DATUM: 2,
  /** One where the field is clamped up to the datum; zero for the seabed. */
  SEA_CLAMP: 3,
  SHARE_HYPSOMETRY: 4,
  SHARE_BELTS: 5,
  SHARE_VOLCANISM: 6,
  SHARE_CRATERS: 7,
  SHARE_ICE: 8,
  SHARE_RELIEF: 9,
  MEAN_RADIUS: 10,
  EROSION: 11,
  DUNES: 12,
  CHAOS: 13,
  SULCI: 14,
  STRIPES: 15,
  RELAXATION: 16,
  COMPLEX_DIAMETER: 17,
  AIR: 18,
  ICY: 19,
  AIR_MASS: 20,
  GROUND_TEMPERATURE: 21,
  CRATER_LIMIT: 22,
  GRIT_RELIEF: 23,
  GRIT_CYCLES: 24,
  MICRO_CEILING: 25,
  MARE_AXIS_X: 26,
  MARE_AXIS_Y: 27,
  MARE_AXIS_Z: 28,
  RELIEF_CYCLES: 29,
  WARP_CYCLES: 30,
  WARP_AMOUNT: 31,
  DUNE_CYCLES: 32,
  CHAOS_CELLS: 33,
  LIQUID: 35,
  BIOTA: 36,
  DRAINAGE_DATUM: 37,
  COAST_WIDTH: 38,
  /** The valley half-width every segment carves over, radians. */
  DRAINAGE_REACH: 39,
} as const

/**
 * `vec4` slots the scalar block occupies. Forty-eight floats; thirty-nine are
 * spent, and index 34 is free.
 */
const SCALAR_SLOTS = 12

export const SCALARS_AT = 0
export const PLATES_AT = SCALARS_AT + SCALAR_SLOTS
export const HOTSPOTS_AT = PLATES_AT + MAX_KERNEL_PLATES * PLATE_STRIDE
export const STRIPES_AT = HOTSPOTS_AT + MAX_KERNEL_HOTSPOTS * HOTSPOT_STRIDE
export const LEVELS_AT = STRIPES_AT + MAX_KERNEL_STRIPES * STRIPE_STRIDE
export const RAYS_AT = LEVELS_AT + MAX_KERNEL_LEVELS * LEVEL_STRIDE
/** `vec4` slots in a body's float records. */
export const KERNEL_RECORDS = RAYS_AT + MAX_KERNEL_RAYS * RAY_STRIDE

/**
 * The unsigned words: counts, the lattice seed, one 32-bit lane per band
 * seed, the octave count per band, and one flag.
 *
 * Seeds travel as words because they are `uint32` and a float holds 24 bits;
 * `noise3` reads `seed.a` alone, and only the chaos lattice reads a second
 * lane, which is why `SEED_CHAOS_B` is the one exception.
 */
export const WORD = {
  PLATES: 0,
  HOTSPOTS: 1,
  STRIPES: 2,
  CRATER_LEVELS: 3,
  MICRO_LEVELS: 4,
  RAYS: 5,
  LATTICE_SEED: 6,
  MICRO_RUNG: 7,
  SEED_HYPSOMETRY: 8,
  SEED_BELTS: 9,
  SEED_RELIEF: 10,
  SEED_DUNES: 11,
  SEED_SULCI: 12,
  SEED_CHAOS_A: 13,
  SEED_CHAOS_B: 14,
  SEED_WARP_X: 15,
  SEED_WARP_Y: 16,
  SEED_WARP_Z: 17,
  SEED_MARE: 18,
  SEED_MINERAL: 19,
  SEED_FROST: 20,
  SEED_GRIT: 21,
  OCTAVES_HYPSOMETRY: 22,
  OCTAVES_BELTS: 23,
  OCTAVES_ARC: 24,
  OCTAVES_SULCI: 25,
  OCTAVES_RELIEF: 26,
  OCTAVES_DUNES: 27,
  OCTAVES_GRIT: 28,
  /** 1 where the relief and belt bands read the analytic-derivative form. */
  ERODED: 29,
  SEED_DRAINAGE: 30,
  SEED_RAIN: 31,
  /**
   * Cells per face edge of the drainage lattice; zero where no graph. The
   * drainage stage's gate in `BAND_STACK`, and the only one: every reader of
   * the drainage buffer tests it.
   */
  DRAINAGE_CELLS: 32,
  /**
   * The refinement's first and last levels (`Refinement.first`, `.last`):
   * a tile carves the ones between that its own resolution reaches
   * (`regionDrainageLevel`). Zero where no graph.
   */
  REFINED_FIRST: 33,
  REFINED_LAST: 34,
} as const

/*
 * The drainage graph, in one buffer of words read through the offset table
 * below, sized once for the lattice every body uses.
 *
 * One buffer rather than one per list, because a compute stage may bind
 * eight storage buffers on the baseline device and the stack spends six of
 * them: its records, its words, its tiles and its three outputs. Nothing
 * requests a raised limit — not the renderer, not the producer, not the Dawn
 * harness — and a raised one would make the kernel build on one adapter and
 * not on the next. Packing the graph into a buffer the stack already binds
 * would only move the wall. So the graph is one binding however many lists
 * it grows: a list is a row in this table, not a binding in the kernel, and
 * `terrainKernel.gpu.test.ts` counts the kernel's bindings against the
 * baseline's eight.
 *
 * Words throughout, because a buffer has one element type. The node and
 * segment records are floats stored by their bits — written through a
 * `Float32Array` over the same memory, read back with `bitcast` — which is
 * the value a `vec4<f32>` buffer would have held, to the last bit, and the
 * graph's words keep their integers exact. The other way round would carry
 * `0xffffffff`, a neighbor that is not there, as a NaN.
 *
 *   nodes        [x y z lake] × MAX_NODES, four words each
 *   segments     [SEGMENT_STRIDE floats] × MAX_NODES
 *   neighbors    eight a node, 0xffffffff where none
 *   cell starts  MAX_NODES + 1
 *   cell lists   MAX_LISTS
 *
 * A node per cell and at most a segment per node; the cell lists are the
 * rasterizer's, measured at a mean of two to nine entries a cell and a peak
 * near thirty, so sixteen a cell over the whole lattice holds every body
 * seen with room, and the packer checks. A body over it fails at pack time
 * rather than overrunning a buffer, and the producer sends that body — and
 * only that body — to the pool.
 */
export const MAX_KERNEL_DRAINAGE_NODES = 6 * DRAINAGE_SHAPE.lattice ** 2
export const MAX_KERNEL_DRAINAGE_LISTS = 16 * MAX_KERNEL_DRAINAGE_NODES
/** `vec4` slots per segment: `SEGMENT_STRIDE / 4`. */
export const DRAINAGE_SEGMENT_STRIDE = SEGMENT_STRIDE / 4
/** Words, like every offset below. */
export const DRAINAGE_NODES_AT = 0
export const DRAINAGE_SEGMENTS_AT =
  DRAINAGE_NODES_AT + 4 * MAX_KERNEL_DRAINAGE_NODES
export const DRAINAGE_NEIGHBORS_AT =
  DRAINAGE_SEGMENTS_AT + SEGMENT_STRIDE * MAX_KERNEL_DRAINAGE_NODES
export const DRAINAGE_CELL_START_AT =
  DRAINAGE_NEIGHBORS_AT + 8 * MAX_KERNEL_DRAINAGE_NODES
export const DRAINAGE_CELL_LISTS_AT =
  DRAINAGE_CELL_START_AT + MAX_KERNEL_DRAINAGE_NODES + 1
/*
 * The refinement below the lattice, per batch: the lists each tile's samples
 * can name at every refined level it resolves, rows in the same buffer
 * rather than a binding of their own, written for each dispatch and uploaded
 * as one range (`TerrainKernel.drainage`'s update range).
 *
 * The drainage buffer and not the tiles buffer, though the rows are per tile,
 * because they are the graph's: the lattice's lists are read through this
 * buffer's offset table, and a refined list is the same record in the same
 * loop. The cost is the one range a batch writes rather than nothing.
 *
 *   per tile    [ox oy oz ·] [rx ry rz ·], the origin and its rounding,
 *               then a [start count] pair a refined level
 *   entries     [key recordStart recordCount] per cell of a level
 *   records     `SEGMENT_STRIDE` floats each, positions less the tile's origin
 *
 * **A record's positions are its tile's.** A creek at the finest level is a
 * meter or two wide and a float32 unit vector resolves six parts in 10⁸ of
 * a radian — 0.4 m on Earth — so a creek's bed read off absolute directions
 * would land a bank away on one processor from where it lies on the other.
 * Packed less the tile's origin, a record is a small vector float32 holds to
 * a fraction of a millimeter, and the kernel measures the sample against it
 * the same way (`TerrainKernel`'s refined walk).
 */
/** Refined levels a tile can carve: the most any body in the catalog refines. */
export const MAX_REFINED_LEVELS = 10
/** Words of one tile's header in the refined rows. */
export const REFINED_TILE_WORDS = 8 + 2 * MAX_REFINED_LEVELS
/** Tiles one dispatch may carry refined rows for. */
export const MAX_REFINED_TILES = 64
/** Words per cell entry: `[key recordStart recordCount]`. */
export const REFINED_ENTRY_WORDS = 3
/** Where the refined rows begin. */
export const DRAINAGE_REFINED_AT =
  DRAINAGE_CELL_LISTS_AT + MAX_KERNEL_DRAINAGE_LISTS
/** Words the refined rows may fill in one dispatch. */
export const MAX_REFINED_WORDS = 1 << 20
/** Words in the drainage buffer. */
export const DRAINAGE_WORDS = DRAINAGE_REFINED_AT + MAX_REFINED_WORDS

/** The graph as the kernel reads it, in the layout above; packed once per graph. */
export interface KernelDrainage {
  /**
   * The buffer up to the refined rows: the floats by their bits, the
   * integers as themselves.
   */
  readonly words: Uint32Array
  readonly segmentCount: number
}

/**
 * Where each rung's existence threshold sits in the words, one `u32` per rung
 * in walk order, on a `uvec4` boundary past `WORD`.
 *
 * `levelContribution` places a crater where `toUnit(hash.x) < density`, and
 * `toUnit` is `hash / 2³²` exactly in float64 — so the test is `hash <
 * density · 2³²` in real arithmetic, which for an integer `hash` is
 * `hash <= ceil(density · 2³²) − 1`. That last number is what is stored, and
 * the kernel compares integers. Taken in float32 instead, a hash within one
 * part in ten million of the line lands on a different side of it than the
 * CPU put it, and that is a crater that exists on one processor and not the
 * other.
 */
export const LEVEL_DRAW_AT = 36

/**
 * Where each rung's sphere-intersection limits sit, four words per rung in
 * walk order: `floor(cells²)` and `ceil(cells²)`, each as a high and a low
 * `u32` of a 48-bit integer.
 *
 * `levelContribution` rejects a lattice cell that misses the unit sphere with
 * `Σ (m/cells)² > 1` over the cell's nearest corner and `< 1` over its
 * farthest, and that is a *decision*: a cell holds a crater or it does not.
 * The corner coordinates are integers over one float, so successive cells'
 * values sit `1/cells²` apart — 2 × 10⁻⁷ at a rung of 2,300 cells and 10⁻¹²
 * across the tail — and a float32 evaluation of the same test lands on the
 * wrong side of it wherever that spacing is under its own resolution, which
 * is a whole crater present on one processor and absent on the other.
 * `Σ m² > cells²` in exact integers is the same decision, so the kernel
 * compares 48-bit sums against these. Real arithmetic and the CPU's float64
 * can still disagree on a cell whose sum is within a part in 10¹⁵ of the
 * limit; across the tail's rungs that is a cell in about 10¹³.
 *
 * The first `uvec4` boundary past the draw thresholds, derived rather than
 * written, because the thresholds are one word a rung from `LEVEL_DRAW_AT`
 * and a longer ladder would otherwise write its last thresholds over the
 * first rung's limits — silently, with nothing between the two blocks but
 * the arithmetic. Fifty-six today, with two words to spare.
 */
export const SLAB_AT = Math.ceil((LEVEL_DRAW_AT + MAX_KERNEL_LEVELS) / 4) * 4

/** Words in a body's record, padded to whole `uvec4`s. */
export const KERNEL_WORDS = SLAB_AT + 4 * MAX_KERNEL_LEVELS + 4

/**
 * Words of cover the kernel writes per interior sample: `COVER_CHANNELS`
 * bytes, four to a word. Two, and the producer slices its readback by it.
 */
export const COVER_WORDS = COVER_CHANNELS / 4

/**
 * Where the tail's grit octaves start in a tile's rung frames. An offset, not
 * an alias: it equals `MAX_KERNEL_LEVELS` because the crater frames come first.
 */
export const GRIT_FRAMES_AT = MAX_KERNEL_LEVELS
/**
 * Where the drainage warp's three lookups start in a tile's frames, one
 * frame for each of `DRAINAGE_WARP_OFFSETS`.
 *
 * The warp is a noise read at the direction times a hundred and sixty
 * cycles, and read off the sample's own float32 direction it is a hundred
 * and sixty times that direction's rounding — half a meter of lookup on
 * Earth, which is a lattice river's bank moved enough to turn a cover byte
 * by six and a refined creek's bed moved most of its own width. Read from
 * the tile's frame plus `delta`, as the grit is, it is exact to float32's
 * fraction.
 */
export const WARP_FRAMES_AT = GRIT_FRAMES_AT + GRIT_OCTAVES
/** Frames a tile carries: every crater level, every grit octave, the warp. */
export const TILE_FRAMES = WARP_FRAMES_AT + DRAINAGE_WARP_OFFSETS.length
/**
 * `vec4` slots per tile: `[face level i j]`, then per frame `[c0]` and `[f0]`.
 *
 * `c0` is the cell the patch center falls in along each axis — an integer
 * carried as a float, exact because no rung's `cells` exceeds 2²⁴ on any body
 * in scope (Earth's one-meter rung is 6.4 × 10⁶) — and `f0` is where in that
 * cell the center sits.
 */
export const TILE_STRIDE = 1 + 2 * TILE_FRAMES

/** Everything a kernel reads about one body, packed. */
export interface KernelSurface {
  readonly records: Float32Array
  readonly words: Uint32Array
  /** The drainage graph's buffers, or null where nothing drains. */
  readonly drainage: KernelDrainage | null
  /**
   * The rungs in walk order — every canonical level, then every level of the
   * tail — each with the cells per unit the frame is taken against.
   */
  readonly rungs: readonly CraterLevel[]
  /** The grit's per-octave frequencies, in the same units. */
  readonly gritFrequencies: readonly number[]
}

/** One record per surface and per side of the sea clamp. */
const packed = new WeakMap<
  SurfaceParameters,
  { clamped?: KernelSurface; seabed?: KernelSurface }
>()

/**
 * The kernel's view of a surface. Packed once per `SurfaceParameters` and
 * per `seabed`, which is `HeightfieldRequest.seabed`: the same flag
 * `generateHeightfield` takes, so a tile from either producer is the seabed
 * exactly where the renderer lays a sheet over it.
 */
export function surfaceKernel(
  surface: SurfaceParameters,
  seabed = false,
): KernelSurface {
  const slot = seabed ? 'seabed' : 'clamped'
  let held = packed.get(surface)
  if (held === undefined) {
    held = {}
    packed.set(surface, held)
  }
  const known = held[slot]
  if (known !== undefined) return known
  const built = pack(surface, seabed)
  held[slot] = built
  return built
}

/**
 * Whether a stage's gate holds in a packed record, read exactly as the kernel
 * reads it: the slot `BAND_STACK` names, against the threshold beside it.
 *
 * What `bandStack.test.ts` holds `pack` to. The packer encodes each gate by
 * zeroing a slot where the body's own gate is closed — a coast width of zero
 * is a remap that returns its argument — and this is the one place that
 * decoding is written, so a slot the kernel gates on and the packer forgot to
 * zero is a failing Node test rather than a drift only the tolerance test on
 * the adapter could notice.
 */
export function packedStageOn(pack: KernelSurface, id: StageId): boolean {
  const packed = stageOf(id).packed
  if (packed === null) return true
  if ('word' in packed) return pack.words[WORD[packed.word]]! > 0
  return pack.records[SCALARS_AT * 4 + SCALAR[packed.scalar]]! > packed.above
}

function pack(surface: SurfaceParameters, seabed: boolean): KernelSurface {
  const grammar = surface.grammar
  const sketch = terrainSketch(surface)
  const records = new Float32Array(KERNEL_RECORDS * 4)
  const words = new Uint32Array(KERNEL_WORDS)

  invariant(
    sketch.plates.length <= MAX_KERNEL_PLATES,
    `${sketch.plates.length} plates exceed the kernel's ${MAX_KERNEL_PLATES}`,
  )
  invariant(
    sketch.hotspots.length <= MAX_KERNEL_HOTSPOTS,
    `${sketch.hotspots.length} hotspots exceed the kernel's ${MAX_KERNEL_HOTSPOTS}`,
  )
  invariant(
    sketch.stripes.length <= MAX_KERNEL_STRIPES,
    `${sketch.stripes.length} stripes exceed the kernel's ${MAX_KERNEL_STRIPES}`,
  )
  invariant(
    sketch.craterLevels.length + sketch.microLevels.length <= MAX_KERNEL_LEVELS,
    `${sketch.craterLevels.length + sketch.microLevels.length} crater rungs exceed the kernel's ${MAX_KERNEL_LEVELS}`,
  )
  invariant(
    sketch.rayCraters.length <= MAX_KERNEL_RAYS,
    `${sketch.rayCraters.length} ray craters exceed the kernel's ${MAX_KERNEL_RAYS}`,
  )

  /*
   * The scalars, each the same expression `elevationAt` and the bands spend.
   * `budget` is `surface.maxElevation`; a body with none evaluates to zero and
   * bare cover, and the kernel takes that branch on `BUDGET <= 0` exactly as
   * `evaluate` does.
   */
  const budget = surface.maxElevation
  const bands = grammar.bands
  const sea = seaDatumElevation(surface)
  const reliefCycles =
    Math.max(RELIEF_SHAPE.roughnessFloor, surface.roughness) *
    RELIEF_SHAPE.cyclesPerRoughness
  const scalar = (index: number, value: number): void => {
    records[SCALARS_AT * 4 + index] = value
  }
  scalar(SCALAR.BUDGET, budget)
  scalar(SCALAR.ROUGHNESS, surface.roughness)
  scalar(SCALAR.SEA_DATUM, sea ?? 0)
  scalar(SCALAR.SEA_CLAMP, sea === null || seabed ? 0 : 1)
  scalar(SCALAR.SHARE_HYPSOMETRY, bands.hypsometry)
  scalar(SCALAR.SHARE_BELTS, bands.belts)
  scalar(SCALAR.SHARE_VOLCANISM, bands.volcanism)
  scalar(SCALAR.SHARE_CRATERS, bands.craters)
  scalar(SCALAR.SHARE_ICE, bands.ice)
  scalar(SCALAR.SHARE_RELIEF, bands.relief)
  scalar(SCALAR.MEAN_RADIUS, grammar.meanRadius)
  scalar(SCALAR.EROSION, grammar.erosion)
  scalar(SCALAR.DUNES, grammar.dunes)
  scalar(SCALAR.CHAOS, grammar.chaos)
  scalar(SCALAR.SULCI, grammar.sulci)
  scalar(SCALAR.STRIPES, grammar.stripes)
  scalar(SCALAR.RELAXATION, grammar.relaxation)
  scalar(SCALAR.COMPLEX_DIAMETER, grammar.complexDiameter)
  scalar(SCALAR.AIR, grammar.air)
  scalar(SCALAR.ICY, grammar.icy)
  scalar(SCALAR.AIR_MASS, grammar.airMass)
  scalar(SCALAR.GROUND_TEMPERATURE, grammar.groundTemperature)
  scalar(SCALAR.CRATER_LIMIT, bands.craters * budget)
  scalar(SCALAR.GRIT_RELIEF, budget > 0 ? gritRelief(grammar) : 0)
  scalar(SCALAR.GRIT_CYCLES, gritCycles(grammar))
  scalar(
    SCALAR.MICRO_CEILING,
    budget > 0 && sketch.microLevels.length > 0 ? MICRO_CRATER_CEILING : 0,
  )
  scalar(SCALAR.MARE_AXIS_X, sketch.mareAxis.x)
  scalar(SCALAR.MARE_AXIS_Y, sketch.mareAxis.y)
  scalar(SCALAR.MARE_AXIS_Z, sketch.mareAxis.z)
  scalar(SCALAR.RELIEF_CYCLES, reliefCycles)
  scalar(SCALAR.WARP_CYCLES, reliefCycles * RELIEF_SHAPE.warpCycles)
  scalar(SCALAR.WARP_AMOUNT, RELIEF_SHAPE.warpAmount / reliefCycles)
  scalar(SCALAR.DUNE_CYCLES, reliefCycles * DUNE_SHAPE.cycles)
  scalar(SCALAR.CHAOS_CELLS, grammar.meanRadius / CHAOS_SHAPE.blockMeters)
  /*
   * Null on a bare body and on one the grammar gives no drainage. Its
   * existence is the drainage stage's gate, and the gate is one word —
   * `WORD.DRAINAGE_CELLS`, below — because the kernel's drainage buffer
   * outlives the body that filled it.
   */
  const graph = drainageGraph(surface)
  scalar(SCALAR.DRAINAGE_REACH, graph === null ? 0 : graph.reach)
  scalar(SCALAR.LIQUID, grammar.liquid)
  scalar(SCALAR.BIOTA, grammar.biota)
  scalar(SCALAR.DRAINAGE_DATUM, drainageDatum(surface))
  // Zero where there is no sea or no liquid, which is the coast stage's gate
  // in `BAND_STACK` — a width of zero is a remap that returns its argument,
  // so the kernel needs no second flag for it. `packedStageOn` reads it back.
  scalar(
    SCALAR.COAST_WIDTH,
    sea !== null && grammar.liquid > 0 ? coastWidth(surface) : 0,
  )

  const slot = (index: number): number => index * 4
  const put = (at: number, x: number, y = 0, z = 0, w = 0): void => {
    records[at] = x
    records[at + 1] = y
    records[at + 2] = z
    records[at + 3] = w
  }
  sketch.plates.forEach((plate, i) => {
    const at = slot(PLATES_AT + i * PLATE_STRIDE)
    put(at, plate.axis.x, plate.axis.y, plate.axis.z, plate.continental ? 1 : 0)
    put(at + 4, plate.motion.x, plate.motion.y, plate.motion.z, plate.base)
    put(at + 8, plate.step)
  })
  sketch.hotspots.forEach((hotspot, i) => {
    const at = slot(HOTSPOTS_AT + i * HOTSPOT_STRIDE)
    put(at, hotspot.axis.x, hotspot.axis.y, hotspot.axis.z, hotspot.radius)
    put(at + 4, hotspot.strength, hotspot.caldera)
  })
  /*
   * A stripe's extent travels as the two chords `stripeProfile` compares
   * against, the end and where the taper starts, taken here in float64 so
   * the kernel reads the same arc the CPU does rather than a sine of a
   * float32 angle.
   */
  sketch.stripes.forEach((stripe, i) => {
    const at = slot(STRIPES_AT + i * STRIPE_STRIDE)
    put(at, stripe.pole.x, stripe.pole.y, stripe.pole.z, stripe.halfWidth)
    put(
      at + 4,
      stripe.offset,
      stripeChord(stripe.halfLength),
      stripeChord(stripe.halfLength * (1 - STRIPE_SHAPE.taper)),
    )
    put(at + 8, stripe.center.x, stripe.center.y, stripe.center.z)
  })
  /*
   * Every rung, canonical then tail, each carrying the rung number its hashes
   * are drawn against — position in the canonical ladder, or
   * `microFirstRung` onward. `ladderField` passes the same number as
   * `firstIndex + rung`.
   */
  const rungs: CraterLevel[] = [...sketch.craterLevels, ...sketch.microLevels]
  rungs.forEach((level, i) => {
    const rung =
      i < sketch.craterLevels.length
        ? i
        : sketch.microFirstRung + (i - sketch.craterLevels.length)
    put(
      slot(LEVELS_AT + i * LEVEL_STRIDE),
      level.cells,
      level.diameter,
      level.density,
      rung,
    )
    // A ladder never carries a zero density — `craterLadder` and
    // `microLadder` both return nothing rather than a rung nothing lands on —
    // so the ceiling is at least one and the threshold at least zero.
    invariant(level.density > 0, `rung ${i} has no density`)
    words[LEVEL_DRAW_AT + i] = Math.min(
      2 ** 32 - 1,
      Math.ceil(level.density * 2 ** 32) - 1,
    )
    /*
     * The sphere test's limits, exact: `cells²` is under 2⁴⁶ on every body in
     * scope and float64 holds integers to 2⁵³, so the split into two words
     * loses nothing.
     */
    const squared = level.cells * level.cells
    invariant(squared < 2 ** 48, `rung ${i} at ${level.cells} cells overflows`)
    const split = (value: number, at: number): void => {
      const high = Math.floor(value / 2 ** 32)
      words[at] = high
      words[at + 1] = value - high * 2 ** 32
    }
    split(Math.floor(squared), SLAB_AT + i * 4)
    split(Math.ceil(squared), SLAB_AT + i * 4 + 2)
  })
  sketch.rayCraters.forEach((crater, i) => {
    const at = slot(RAYS_AT + i * RAY_STRIDE)
    put(at, crater.axis.x, crater.axis.y, crater.axis.z, crater.angularRadius)
    put(
      at + 4,
      crater.tangent.x,
      crater.tangent.y,
      crater.tangent.z,
      crater.age,
    )
    put(
      at + 8,
      crater.bitangent.x,
      crater.bitangent.y,
      crater.bitangent.z,
      crater.cosReach,
    )
    const phase = (k: number): number => crater.phases[k] ?? 0
    put(at + 12, phase(0), phase(1), phase(2), phase(3))
    put(at + 16, phase(4), phase(5))
  })
  invariant(
    RAY_HARMONICS.length === 6,
    `the ray record holds six phases and RAY_HARMONICS has ${RAY_HARMONICS.length}`,
  )

  words[WORD.PLATES] = sketch.plates.length
  words[WORD.HOTSPOTS] = sketch.hotspots.length
  words[WORD.STRIPES] = sketch.stripes.length
  words[WORD.CRATER_LEVELS] = sketch.craterLevels.length
  words[WORD.MICRO_LEVELS] = sketch.microLevels.length
  words[WORD.RAYS] = sketch.rayCraters.length
  words[WORD.LATTICE_SEED] = sketch.latticeSeed >>> 0
  words[WORD.MICRO_RUNG] = sketch.microFirstRung
  const seeds = sketch.seeds
  words[WORD.SEED_HYPSOMETRY] = seeds.hypsometry.a >>> 0
  words[WORD.SEED_BELTS] = seeds.belts.a >>> 0
  words[WORD.SEED_RELIEF] = seeds.relief.a >>> 0
  words[WORD.SEED_DUNES] = seeds.dunes.a >>> 0
  words[WORD.SEED_SULCI] = seeds.sulci.a >>> 0
  words[WORD.SEED_CHAOS_A] = seeds.chaos.a >>> 0
  words[WORD.SEED_CHAOS_B] = seeds.chaos.b >>> 0
  words[WORD.SEED_WARP_X] = seeds.warpX.a >>> 0
  words[WORD.SEED_WARP_Y] = seeds.warpY.a >>> 0
  words[WORD.SEED_WARP_Z] = seeds.warpZ.a >>> 0
  words[WORD.SEED_MARE] = seeds.mare.a >>> 0
  words[WORD.SEED_MINERAL] = seeds.mineral.a >>> 0
  words[WORD.SEED_FROST] = seeds.frost.a >>> 0
  words[WORD.SEED_GRIT] = seeds.grit.a >>> 0
  words[WORD.SEED_DRAINAGE] = seeds.drainage.a >>> 0
  words[WORD.SEED_RAIN] = seeds.rain.a >>> 0
  words[WORD.DRAINAGE_CELLS] = graph === null ? 0 : graph.cells
  const refinement = graph === null ? null : drainageRefinement(graph)
  invariant(
    refinement === null ||
      refinement.last - refinement.first + 1 <= MAX_REFINED_LEVELS,
    `${surface.grammar.meanRadius} m refines past the kernel's ${MAX_REFINED_LEVELS} levels`,
  )
  words[WORD.REFINED_FIRST] = refinement?.first ?? 0
  words[WORD.REFINED_LAST] = refinement?.last ?? 0

  /*
   * The octave counts, from the same calls the bands make with the same
   * arguments — a band's peak is its share of the budget, and the hypsometric
   * swell counts against its own share of that. Written here rather than
   * re-derived in the kernel because `octavesFor` is a property of the body
   * and a loop bound the kernel would otherwise have to compute per sample.
   */
  const radius = grammar.meanRadius
  words[WORD.OCTAVES_HYPSOMETRY] = octavesFor(
    radius,
    HYPSOMETRY_SHAPE.cycles,
    HYPSOMETRY_SHAPE.octaves,
    bands.hypsometry * budget * HYPSOMETRY_SHAPE.swell,
  )
  words[WORD.OCTAVES_BELTS] = octavesFor(
    radius,
    BELT_SHAPE.cycles,
    BELT_SHAPE.octaves,
    bands.belts * budget,
  )
  words[WORD.OCTAVES_ARC] = octavesFor(
    radius,
    ARC_SHAPE.cycles,
    ARC_SHAPE.octaves,
    bands.volcanism * budget,
  )
  words[WORD.OCTAVES_SULCI] = octavesFor(
    radius,
    SULCI_SHAPE.cycles * SULCI_SHAPE.stretch,
    SULCI_SHAPE.octaves,
    bands.ice * budget,
  )
  words[WORD.OCTAVES_RELIEF] = octavesFor(
    radius,
    reliefCycles,
    RELIEF_SHAPE.octaves,
    bands.relief * budget,
  )
  words[WORD.OCTAVES_DUNES] = octavesFor(
    radius,
    reliefCycles * DUNE_SHAPE.cycles,
    DUNE_SHAPE.octaves,
    bands.relief * budget,
  )
  words[WORD.OCTAVES_GRIT] = GRIT_OCTAVES
  words[WORD.ERODED] = grammar.erosion > 0 ? 1 : 0

  const gritFrequencies: number[] = []
  const base = gritCycles(grammar)
  for (let k = 0; k < GRIT_OCTAVES; k += 1) {
    gritFrequencies.push(base * DEFAULT_FBM.lacunarity ** k)
  }

  return {
    records,
    words,
    drainage: graph === null ? null : packDrainage(graph),
    rungs,
    gritFrequencies,
  }
}

/** One packing per graph: a graph is shared by every surface that derives it. */
const packedDrainage = new WeakMap<DrainageGraph, KernelDrainage>()

function packDrainage(graph: DrainageGraph): KernelDrainage {
  const known = packedDrainage.get(graph)
  if (known !== undefined) return known
  invariant(
    graph.nodes <= MAX_KERNEL_DRAINAGE_NODES,
    `${graph.nodes} drainage nodes exceed the kernel's ${MAX_KERNEL_DRAINAGE_NODES}`,
  )
  invariant(
    graph.cellSegments.length <= MAX_KERNEL_DRAINAGE_LISTS,
    `${graph.cellSegments.length} drainage list entries exceed the kernel's ${MAX_KERNEL_DRAINAGE_LISTS}`,
  )
  // The lattice's rows only: the refined rows are a batch's, written per
  // dispatch (`packRefinedTiles`), and a graph has no use for their space.
  const words = new Uint32Array(DRAINAGE_REFINED_AT)
  const floats = new Float32Array(words.buffer)
  for (let n = 0; n < graph.nodes; n += 1) {
    const at = DRAINAGE_NODES_AT + n * 4
    floats[at] = graph.positions[n * 3] as number
    floats[at + 1] = graph.positions[n * 3 + 1] as number
    floats[at + 2] = graph.positions[n * 3 + 2] as number
    // NaN has no literal the kernel can compare against; a lake level below
    // any ground is the same "none" in a `greaterThan`.
    const lake = graph.lake[n] as number
    floats[at + 3] = Number.isNaN(lake) ? NO_KERNEL_WATER : lake
    for (let k = 0; k < 8; k += 1) {
      const m = graph.neighbors[n * 8 + k] as number
      words[DRAINAGE_NEIGHBORS_AT + n * 8 + k] = m < 0 ? 0xffff_ffff : m
    }
  }
  floats.set(graph.segments, DRAINAGE_SEGMENTS_AT)
  words.set(graph.cellStart, DRAINAGE_CELL_START_AT)
  words.set(graph.cellSegments, DRAINAGE_CELL_LISTS_AT)
  const built: KernelDrainage = { words, segmentCount: graph.segmentCount }
  packedDrainage.set(graph, built)
  return built
}

/**
 * Write each tile's refined rows into the drainage buffer's words, and
 * return how many words past `DRAINAGE_REFINED_AT` were written — the range
 * the dispatch uploads. Tile `t` of the batch reads header `t`.
 *
 * A tile names, at each refined level its region resolves, every cell any of
 * its samples can fall in: the cell under each of a 9 × 9 grid of lookups
 * over the bordered tile, and the cells a step of `REFINED_MARGIN` cells away
 * from each. The warp's slope is under a half, so a sample between grid
 * lookups is within that step of one, and the step is also what a float32
 * lookup can differ from the float64 one by, many times over. Returns null
 * where the rows would overrun `MAX_REFINED_WORDS`, and the producer sends
 * that batch's tiles to the pool.
 */
export function packRefinedTiles(
  surface: SurfaceParameters,
  regions: readonly RegionAddress[],
  layout: { readonly resolution: number; readonly border: number },
  words: Uint32Array,
): number | null {
  invariant(
    regions.length <= MAX_REFINED_TILES,
    `${regions.length} tiles exceed the kernel's ${MAX_REFINED_TILES} refined headers`,
  )
  const graph = drainageGraph(surface)
  const floats = new Float32Array(words.buffer)
  if (graph === null) return 0
  const refinement = drainageRefinement(graph)
  const sketch = terrainSketch(surface)
  let cursor = DRAINAGE_REFINED_AT + MAX_REFINED_TILES * REFINED_TILE_WORDS
  const limit = DRAINAGE_REFINED_AT + MAX_REFINED_WORDS
  for (const [t, region] of regions.entries()) {
    const header = DRAINAGE_REFINED_AT + t * REFINED_TILE_WORDS
    /*
     * The origin is the tile's true center rounded to float32, and the
     * rounding is written beside it: the kernel's `delta` is the sample's
     * offset from the true center, so the residual is what puts the sample
     * on the origin's footing exactly.
     */
    const origin = regionDirection(region, 0.5, 0.5)
    floats[header] = origin.x
    floats[header + 1] = origin.y
    floats[header + 2] = origin.z
    words[header + 3] = 0
    const ox = floats[header] as number
    const oy = floats[header + 1] as number
    const oz = floats[header + 2] as number
    floats[header + 4] = origin.x - ox
    floats[header + 5] = origin.y - oy
    floats[header + 6] = origin.z - oz
    words[header + 7] = 0
    const lookups = refinedLookups(graph, sketch, region, layout)
    const finest = Math.min(refinement.last, regionDrainageLevel(region.level))
    for (let k = 0; k < MAX_REFINED_LEVELS; k += 1) {
      const level = refinement.first + k
      const pair = header + 8 + k * 2
      if (level > finest) {
        words[pair] = 0
        words[pair + 1] = 0
        continue
      }
      const cells = refinedCells(lookups, level)
      const entries = cursor
      cursor += cells.length * REFINED_ENTRY_WORDS
      if (cursor > limit) return null
      words[pair] = entries
      words[pair + 1] = cells.length
      for (const [e, cell] of cells.entries()) {
        const records = refinement.listAt(level, cell.face, cell.i, cell.j)
        const entry = entries + e * REFINED_ENTRY_WORDS
        const span = 2 ** level
        words[entry] = (cell.face * span + cell.i) * span + cell.j
        words[entry + 1] = cursor
        words[entry + 2] = records.length / SEGMENT_STRIDE
        if (cursor + records.length > limit) return null
        floats.set(records, cursor)
        for (
          let at = cursor;
          at < cursor + records.length;
          at += SEGMENT_STRIDE
        ) {
          floats[at] = (floats[at] as number) - ox
          floats[at + 1] = (floats[at + 1] as number) - oy
          floats[at + 2] = (floats[at + 2] as number) - oz
          floats[at + 4] = (floats[at + 4] as number) - ox
          floats[at + 5] = (floats[at + 5] as number) - oy
          floats[at + 6] = (floats[at + 6] as number) - oz
        }
        cursor += records.length
      }
    }
  }
  return cursor - DRAINAGE_REFINED_AT
}

/** How far past each grid lookup a tile's cells are taken, in that level's cells. */
const REFINED_MARGIN = 0.35

/** Lookups over a tile's bordered grid, 9 × 9, as flat triples. */
function refinedLookups(
  graph: DrainageGraph,
  sketch: TerrainSketch,
  region: RegionAddress,
  layout: { readonly resolution: number; readonly border: number },
): Float64Array {
  const out = new Float64Array(81 * 3)
  const step = layout.resolution - 1
  const from = -layout.border / step
  const span = (step + 2 * layout.border) / step
  for (let a = 0; a < 9; a += 1) {
    for (let b = 0; b < 9; b += 1) {
      const lookup = drainageLookup(
        graph,
        sketch,
        regionDirection(region, from + (span * b) / 8, from + (span * a) / 8),
      )
      const at = (a * 9 + b) * 3
      out[at] = lookup.x
      out[at + 1] = lookup.y
      out[at + 2] = lookup.z
    }
  }
  return out
}

/** The cells of `level` the lookups and their margins fall in, each once. */
function refinedCells(
  lookups: Float64Array,
  level: number,
): { readonly face: number; readonly i: number; readonly j: number }[] {
  const span = 2 ** level
  const step = (REFINED_MARGIN * 2) / span
  const seen = new Set<number>()
  const out: { face: number; i: number; j: number }[] = []
  for (let at = 0; at < lookups.length; at += 3) {
    const x = lookups[at] as number
    const y = lookups[at + 1] as number
    const z = lookups[at + 2] as number
    const { face, u, v } = directionToFace({ x, y, z })
    for (const du of [-step, 0, step]) {
      for (const dv of [-step, 0, step]) {
        const there =
          du === 0 && dv === 0
            ? { face, u, v }
            : directionToFace(faceToDirection(face, u + du, v + dv))
        const i = Math.min(
          span - 1,
          Math.max(0, Math.floor(((there.u + 1) / 2) * span)),
        )
        const j = Math.min(
          span - 1,
          Math.max(0, Math.floor(((there.v + 1) / 2) * span)),
        )
        const key = (there.face * span + i) * span + j
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ face: there.face, i, j })
      }
    }
  }
  return out
}

/**
 * The water level the kernel writes where there is none, and packs for a
 * node under no lake: below any ground, so every comparison against it
 * reads "dry". The producer turns it back into the NaN `Heightfield.water`
 * carries, which WGSL cannot spell as a constant. It is `NO_STANDING`, so
 * a drowned reach's lane reads the same way.
 */
export const NO_KERNEL_WATER = NO_STANDING

/**
 * The frame one tile is evaluated in, written into `out` at `at`.
 *
 * Per rung, the lattice cell the patch center falls in and where in that cell
 * it sits, both from the float64 direction — the same `direction · cells`
 * `levelContribution` floors, split into the integer the kernel can carry
 * exactly and the fraction it adds the sample's own offset to. The grit's
 * octaves get the same treatment at their own frequencies, because at eight
 * meters of wavelength they are as fine as the tail's craters.
 *
 * The header slot carries the region itself, which is all the kernel needs to
 * derive every sample's offset from the center: the face coordinates of a
 * region are exact in float32 through level 23, and the difference between
 * two of them is exact too.
 */
export function writeTileFrame(
  kernel: KernelSurface,
  region: RegionAddress,
  out: Float32Array,
  at: number,
): void {
  invariant(
    region.level <= MAX_TILE_LEVEL,
    `A tile frame's face coordinates are exact through level ${MAX_TILE_LEVEL}; got ${region.level}`,
  )
  const center = regionDirection(region, 0.5, 0.5)
  out[at] = region.face
  out[at + 1] = region.level
  out[at + 2] = region.i
  out[at + 3] = region.j
  const frame = (index: number, cells: number, offset = 0): void => {
    const cell = at + 4 + index * 8
    const fraction = cell + 4
    writeAxisFrame(center.x, cells, out, cell, fraction, offset)
    writeAxisFrame(center.y, cells, out, cell + 1, fraction + 1)
    writeAxisFrame(center.z, cells, out, cell + 2, fraction + 2)
    out[cell + 3] = 0
    out[fraction + 3] = 0
  }
  kernel.rungs.forEach((rung, index) => frame(index, rung.cells))
  kernel.gritFrequencies.forEach((frequency, k) =>
    frame(GRIT_FRAMES_AT + k, frequency),
  )
  // `drainageLookup`'s cycles: every graph is on the one lattice.
  const warp =
    DRAINAGE_SHAPE.warpCycles * DRAINAGE_SHAPE.lattice * (2 / Math.PI) * 2
  DRAINAGE_WARP_OFFSETS.forEach((offset, k) =>
    frame(WARP_FRAMES_AT + k, warp, offset),
  )
}

function writeAxisFrame(
  component: number,
  cells: number,
  out: Float32Array,
  cellAt: number,
  fractionAt: number,
  offset = 0,
): void {
  const scaled = component * cells + offset
  const cell = Math.floor(scaled)
  invariant(
    Math.abs(cell) < 2 ** 24,
    `A rung at ${cells} cells per unit puts the anchor cell past float32's integer range`,
  )
  out[cellAt] = cell
  out[fractionAt] = scaled - cell
}

/**
 * The offset of a sample from its tile's center, in float64 — the arithmetic
 * the kernel performs in float32, written once here so a test can hold the
 * two together and so the frame's own claim can be checked without a GPU.
 *
 * Nothing subtracts two unit vectors. `raw = raw0 + Δ` with `Δ` exact, and
 * `d − d0 = Δ/|raw| − d0 · w/(n(1 + n))` where `w = (2 raw0·Δ + Δ·Δ)/|raw0|²`
 * and `n = √(1 + w)` — every term small and every one built from `Δ`, so the
 * result is exact to the precision of `Δ` rather than to the precision of a
 * unit vector.
 */
export function sampleOffset(
  region: RegionAddress,
  s: number,
  t: number,
): Vec3 {
  const span = 2 ** region.level
  const u0 = ((region.i + 0.5) / span) * 2 - 1
  const v0 = ((region.j + 0.5) / span) * 2 - 1
  const du = ((s - 0.5) * 2) / span
  const dv = ((t - 0.5) * 2) / span
  const raw0 = faceRaw(region.face, u0, v0)
  const delta = faceRaw(region.face, du, dv, true)
  const raw0Length = Math.hypot(raw0.x, raw0.y, raw0.z)
  const w =
    (2 * (raw0.x * delta.x + raw0.y * delta.y + raw0.z * delta.z) +
      (delta.x * delta.x + delta.y * delta.y + delta.z * delta.z)) /
    (raw0Length * raw0Length)
  const n = Math.sqrt(1 + w)
  const scale = 1 / (raw0Length * n)
  const pull = w / (n * (1 + n)) / raw0Length
  return {
    x: delta.x * scale - raw0.x * pull,
    y: delta.y * scale - raw0.y * pull,
    z: delta.z * scale - raw0.z * pull,
  }
}

/**
 * `faceToDirection` before the normalize, and — with `delta` — the same map
 * applied to a difference of face coordinates, where the fixed component is
 * zero rather than ±1.
 */
export function faceRaw(
  face: number,
  u: number,
  v: number,
  delta = false,
): Vec3 {
  const one = delta ? 0 : 1
  switch (face) {
    case 0:
      return { x: one, y: v, z: -u }
    case 1:
      return { x: -one, y: v, z: u }
    case 2:
      return { x: u, y: one, z: -v }
    case 3:
      return { x: u, y: -one, z: v }
    case 4:
      return { x: u, y: v, z: one }
    case 5:
      return { x: -u, y: v, z: -one }
    default:
      invariant(false, `Bad cube face ${face}`)
  }
}

/** A tile's own extent in samples, bordered: one kernel invocation each. */
export const tileSamples = (resolution: number, border: number): number =>
  heightfieldStride({ resolution, border }) ** 2
