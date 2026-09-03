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
  SULCI_SHAPE,
} from './bands.ts'
import { COVER_CHANNELS } from './cover.ts'
import { MAX_RAY_CRATERS, RAY_HARMONICS } from './craters.ts'
import {
  GRIT_OCTAVES,
  gritCycles,
  gritRelief,
  MICRO_CRATER_CEILING,
} from './micro.ts'
import { type CraterLevel, MAX_CRATER_LEVELS, terrainSketch } from './sketch.ts'
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
 *   stripe   [px py pz halfWidth] [offset · · ·]
 *   level    [cells diameter density rung]
 *   ray      [ax ay az angularRadius] [tx ty tz age] [bx by bz cosReach]
 *            [phase0 phase1 phase2 phase3] [phase4 phase5 · ·]
 */
export const PLATE_STRIDE = 3
export const HOTSPOT_STRIDE = 2
export const STRIPE_STRIDE = 2
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
  DRAINAGE: 34,
  LIQUID: 35,
  BIOTA: 36,
  DRAINAGE_DATUM: 37,
  COAST_WIDTH: 38,
} as const

/** `vec4` slots the scalar block occupies. Forty-eight floats; thirty-nine are spent. */
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
  SEED_TRIBUTARY: 31,
  SEED_RAIN: 32,
} as const

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
 * the arithmetic. Forty-eight today, with one word to spare.
 */
export const SLAB_AT = Math.ceil((LEVEL_DRAW_AT + MAX_KERNEL_LEVELS) / 4) * 4

/** Words in a body's record, padded to whole `uvec4`s. */
export const KERNEL_WORDS = SLAB_AT + 4 * MAX_KERNEL_LEVELS + 4

/**
 * Words of cover the kernel writes per interior sample: `COVER_CHANNELS`
 * bytes, four to a word. Two, and the producer slices its readback by it.
 */
export const COVER_WORDS = COVER_CHANNELS / 4

/** Where the tail's grit octaves start in a tile's rung frames. */
export const GRIT_FRAMES_AT = MAX_KERNEL_LEVELS
/** Rung frames a tile carries: every crater level, then every grit octave. */
export const TILE_FRAMES = MAX_KERNEL_LEVELS + GRIT_OCTAVES
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
  scalar(SCALAR.DRAINAGE, grammar.drainage)
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
  sketch.stripes.forEach((stripe, i) => {
    const at = slot(STRIPES_AT + i * STRIPE_STRIDE)
    put(at, stripe.pole.x, stripe.pole.y, stripe.pole.z, stripe.halfWidth)
    put(at + 4, stripe.offset)
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
  words[WORD.SEED_TRIBUTARY] = seeds.tributary.a >>> 0
  words[WORD.SEED_RAIN] = seeds.rain.a >>> 0

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

  return { records, words, rungs, gritFrequencies }
}

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
  const centre = regionDirection(region, 0.5, 0.5)
  out[at] = region.face
  out[at + 1] = region.level
  out[at + 2] = region.i
  out[at + 3] = region.j
  const frame = (index: number, cells: number): void => {
    const cell = at + 4 + index * 8
    const fraction = cell + 4
    writeAxisFrame(centre.x, cells, out, cell, fraction)
    writeAxisFrame(centre.y, cells, out, cell + 1, fraction + 1)
    writeAxisFrame(centre.z, cells, out, cell + 2, fraction + 2)
    out[cell + 3] = 0
    out[fraction + 3] = 0
  }
  kernel.rungs.forEach((rung, index) => frame(index, rung.cells))
  kernel.gritFrequencies.forEach((frequency, k) =>
    frame(GRIT_FRAMES_AT + k, frequency),
  )
}

function writeAxisFrame(
  component: number,
  cells: number,
  out: Float32Array,
  cellAt: number,
  fractionAt: number,
): void {
  const scaled = component * cells
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
