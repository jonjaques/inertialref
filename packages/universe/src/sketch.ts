import type { Meters } from '@inertialref/shared'
import {
  clamp01,
  deriveSeed,
  formatSeed,
  latticeSeed,
  Rng,
  type Seed,
  smoothstep,
} from '@inertialref/procedural'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import type { SurfaceGrammar } from './grammar.ts'
import type { SurfaceParameters } from './system.ts'

/*
 * The coarse structure a per-sample function cannot express.
 *
 * Everything in the band stack is a pure function of a direction, which is what
 * makes a patch generatable in any order in any worker. But some geology is not
 * local: where a plate boundary runs depends on where every nucleus is, and
 * "the third-largest volcano on this world" is a fact about the world rather
 * than about a point on it. So each body derives a few kilobytes once — plate
 * nuclei and their motions, a hotspot list, the crater field's lattice ladder —
 * and every sample evaluates against that.
 *
 * It is regenerable content and therefore a **cache, never a save**: derived
 * from the surface seed and the grammar in a fraction of a millisecond, and
 * memoized wherever elevation is evaluated. Each worker derives and keeps its
 * own, which is why the heightfield task's payload carries a surface and not a
 * sketch.
 *
 * Plate identity is a spherical Voronoi diagram over the nuclei, and the second
 * distance is what makes it useful: `F2 − F1` is zero on a boundary and grows
 * inward, so the distance-to-boundary field a belt needs comes out of the same
 * search as the plate that owns the sample. Thirty nuclei is thirty dot
 * products, which is cheaper than any lattice scheme that would have to handle
 * the sphere's topology.
 */

export interface TectonicPlate {
  /** Unit direction of the nucleus, in body-fixed axes. */
  readonly axis: Vec3
  /**
   * Unit tangent at the nucleus: the direction the plate is drifting.
   *
   * Tangent rather than arbitrary, because the whole point is the component of
   * relative motion *across* a boundary — a radial component would mean a plate
   * moving into or out of the body.
   */
  readonly motion: Vec3
  /** Continental crust rather than ocean floor. */
  readonly continental: boolean
  /** Interior datum offset, as a signed fraction of the hypsometry budget. */
  readonly base: number
  /** ±1: which way a transform boundary steps. */
  readonly step: number
}

export interface Hotspot {
  readonly axis: Vec3
  /** Angular radius of the edifice, radians. */
  readonly radius: number
  /** Height as a fraction of the volcanism budget. */
  readonly strength: number
  /** Caldera radius, as a fraction of `radius`. */
  readonly caldera: number
}

/** One lattice of the crater field. See `craters.ts`. */
export interface CraterLevel {
  /** Cells per unit along each axis of direction space. */
  readonly cells: number
  /** The largest crater this level places, meters. Half of it is the smallest. */
  readonly diameter: Meters
  /** Chance that a cell holds one. */
  readonly density: number
}

/** A great-circle trough: the pole of the circle, and how deep it cuts. */
export interface StripeAxis {
  readonly pole: Vec3
  /** Angular half-width of the trough, radians. */
  readonly halfWidth: number
  /** Offset of the pair from the great circle itself, radians. */
  readonly offset: number
}

/**
 * One derived seed per band, kept on the sketch.
 *
 * `elevationAt` used to call `deriveSeed` twice per sample — a string hash per
 * band per sample, on a function that runs five thousand times per patch. The
 * seeds depend on the surface and nothing else, so they belong with the rest of
 * what the surface derives once.
 */
export interface BandSeeds {
  readonly hypsometry: Seed
  readonly belts: Seed
  readonly relief: Seed
  readonly dunes: Seed
  readonly sulci: Seed
  readonly chaos: Seed
  readonly warpX: Seed
  readonly warpY: Seed
  readonly warpZ: Seed
}

export interface TerrainSketch {
  readonly plates: readonly TectonicPlate[]
  readonly hotspots: readonly Hotspot[]
  /** Coarsest first. Empty on a world the grammar gives no craters. */
  readonly craterLevels: readonly CraterLevel[]
  readonly stripes: readonly StripeAxis[]
  readonly seeds: BandSeeds
  /** The surface seed, folded to the one lane a lattice hash carries. */
  readonly latticeSeed: number
}

/**
 * The widest margin any band reads a plate property over, radians.
 *
 * It is the support radius of the weights below: a plate more than this much
 * farther from the sample than the nearest one is has no say in anything, so
 * `plateAt` need not carry it. Every band's own margin has to be no wider —
 * `geology.test.ts` holds that, because a band asking for a blend over a margin
 * the search already truncated would be dividing by a sum that had lost a term
 * still carrying weight.
 */
export const PLATE_MARGIN = 0.25

/**
 * The plates near a direction, and how much farther each is than the nearest.
 *
 * **This is a partition of unity, not a ranking, and the difference is a
 * kilometre of cliff.** The obvious version returns the nearest plate and the
 * second-nearest — one pass, two minima, and `F2 − F1` falls out of it for
 * free. What that version cannot do is be *read*: which plate is second changes
 * discontinuously along the locus where the second and third nearest are
 * equidistant, and that is a network of curves through every plate's interior,
 * nowhere near an edge. Measured either side of one on Proxima Centauri II: the
 * same nearest plate, base 0.432, with the second jumping from base 0.224 to
 * −0.894 at a `boundary` of 5.72e-2 — **1,532 m of step**, of a 20,434 m relief
 * budget, and 3,081 m on Earth. It is the same shape as the cube-corner problem
 * `craters.ts` avoids: a rank-based lookup has a seam wherever the ranking
 * changes.
 *
 * So the sample carries *every* plate within `PLATE_MARGIN` of the nearest, and
 * `plateProperty` weights them by a smooth function of how much farther they
 * are and normalises. No rank identity enters, so a property read this way is
 * continuous by construction: a plate joins the set at the support radius with
 * weight zero, and two plates that swap places have equal weight at the instant
 * they do.
 *
 * `boundary` is `F2 − F1` in radians and survives unchanged, because the
 * *value* of the second distance is continuous even where the plate holding it
 * is not. `plate` is the nearest, and its identity is discontinuous at a
 * boundary in exactly the way the second's was at an interior seam — nothing
 * reads a property off it, and it is here to be the fallback and to be looked
 * at.
 */
export interface PlateSample {
  readonly plate: TectonicPlate
  /** Zero exactly on a boundary, and half the plate's width at its center. */
  readonly boundary: number
  /** Every plate within `PLATE_MARGIN` of the nearest, the nearest included. */
  readonly nearby: readonly TectonicPlate[]
  /** How much farther than the nearest each of those is, radians. Parallel. */
  readonly excess: readonly number[]
}

export function plateAt(
  sketch: TerrainSketch,
  direction: Vec3,
): PlateSample | null {
  const plates = sketch.plates
  if (plates.length < 2) return null
  let bestIndex = 0
  let best = -Infinity
  let second = -Infinity
  for (let i = 0; i < plates.length; i += 1) {
    const plate = plates[i] as TectonicPlate
    // The cosine, so the search is dot products and the arc-cosine is paid
    // twice at the end rather than `plateCount` times in the loop.
    const cosine =
      direction.x * plate.axis.x +
      direction.y * plate.axis.y +
      direction.z * plate.axis.z
    if (cosine > best) {
      second = best
      best = cosine
      bestIndex = i
    } else if (cosine > second) {
      second = cosine
    }
  }
  const near = Math.acos(Math.min(1, Math.max(-1, best)))
  const far = Math.acos(Math.min(1, Math.max(-1, second)))
  /*
   * The second pass, and it is a threshold in cosines so that it is not a
   * second arc-cosine per plate.
   *
   * Cosine decreases with angle, so "within `PLATE_MARGIN` of the nearest" is
   * one comparison against `cos(near + PLATE_MARGIN)`, and only the two or
   * three plates that pass it pay for the arc-cosine that says by how much. On
   * a twenty-plate world that is twenty dot products and three transcendentals
   * rather than twenty of each.
   */
  const limit = Math.cos(Math.min(Math.PI, near + PLATE_MARGIN))
  const nearby: TectonicPlate[] = []
  const excess: number[] = []
  for (let i = 0; i < plates.length; i += 1) {
    const plate = plates[i] as TectonicPlate
    const cosine =
      direction.x * plate.axis.x +
      direction.y * plate.axis.y +
      direction.z * plate.axis.z
    if (cosine < limit) continue
    nearby.push(plate)
    excess.push(Math.acos(Math.min(1, Math.max(-1, cosine))) - near)
  }
  return {
    plate: plates[bestIndex] as TectonicPlate,
    boundary: far - near,
    nearby,
    excess,
  }
}

/**
 * How much say a plate has at a sample, given how much farther it is than the
 * nearest one and how wide the band's margin is.
 *
 * One at the nearest plate, zero at the margin and past it, smooth in between.
 * The compact support is what makes the sum finite, the continuity is what
 * makes the whole scheme work, and the zero derivative at the far end is what
 * lets a plate join the set without a crease. Nothing about it depends on which
 * plate this is.
 *
 * **`(1 − s)/(1 + s)` rather than `1 − s`, and the difference is the shape of a
 * continental margin.** The plain complement blends too far into a plate's
 * interior: at half the margin it still gives its neighbour a third of the say,
 * where the two-plate blend this replaces gave a fifth. On Earth that is the
 * difference between a bimodal elevation histogram and a smeared one — Sarle's
 * coefficient reads 0.583 with this and 0.553 with the complement, against the
 * 5/9 at which a distribution stops having two modes. This form *is* that
 * two-plate blend wherever only two plates are in range: the ratio it gives the
 * neighbour is `(1 − s)/(1 + s)`, which is what `mix(average, mine, s)` was
 * spending all along. What the partition changes is the interior seams and the
 * triple junctions, and nothing else.
 */
const plateWeight = (excess: number, width: number): number => {
  const s = smoothstep(0, width, excess)
  return (1 - s) / (1 + s)
}

/**
 * A plate's own property, read as a weighted average over every plate nearby.
 *
 * Deep inside a plate only that plate has weight and the answer is its own
 * value. At a boundary the two sides weigh the same and the answer is their
 * average. At a triple junction three do. There is no step anywhere in that,
 * because a plate's weight reaches zero before it can leave the set.
 *
 * `width` is each band's own margin rather than one shared number, because the
 * bands genuinely differ: hypsometry changes crust type over a shelf and slope,
 * a mountain belt is an orogen wide, and an arc's volcanoes sit closer to the
 * trench than either. A boolean becomes a fraction on the way through — the
 * caller asks for `plate.continental ? 1 : 0` and gets continentalness, which
 * is what a passive margin actually is.
 */
export function plateProperty(
  sample: PlateSample,
  of: (plate: TectonicPlate) => number,
  width: number,
): number {
  let total = 0
  let weight = 0
  for (let i = 0; i < sample.nearby.length; i += 1) {
    const share = plateWeight(sample.excess[i] as number, width)
    if (share <= 0) continue
    total += share * of(sample.nearby[i] as TectonicPlate)
    weight += share
  }
  // The nearest plate has zero excess and therefore full weight, so this is
  // unreachable — and it is the honest answer if a margin ever goes to zero.
  return weight <= 0 ? of(sample.plate) : total / weight
}

/**
 * How the plates at a boundary are moving relative to each other.
 *
 * Positive is convergent, negative divergent, and near zero is transform.
 *
 * Weighted over *pairs*, for the reason `plateProperty` is weighted over
 * plates: a convergence computed from the nearest plate and whichever one
 * happens to be second inherits the second's seam, and near a triple junction
 * that seam runs through the ground the belt band is loudest on. Every pair
 * contributes the product of its two weights, and `pairConvergence` is
 * symmetric, so a pair cannot notice that its members swapped rank.
 *
 * There is nothing to weight where only one plate has any, and there the bands
 * that read this are already at zero: `edge` and the weights share a margin, so
 * a sample with one plate in range is further from a boundary than the band
 * reaches.
 */
export function convergence(
  sample: PlateSample,
  direction: Vec3,
  width: number,
): number {
  let total = 0
  let weight = 0
  for (let i = 0; i < sample.nearby.length; i += 1) {
    const mine = plateWeight(sample.excess[i] as number, width)
    if (mine <= 0) continue
    for (let j = i + 1; j < sample.nearby.length; j += 1) {
      const theirs = plateWeight(sample.excess[j] as number, width)
      if (theirs <= 0) continue
      const share = mine * theirs
      total +=
        share *
        pairConvergence(
          sample.nearby[i] as TectonicPlate,
          sample.nearby[j] as TectonicPlate,
          direction,
        )
      weight += share
    }
  }
  if (weight <= 0) return 0
  return Math.max(-1, Math.min(1, total / weight))
}

/**
 * The component of two plates' relative motion across the line between them.
 *
 * The normal is the direction from one nucleus toward the other, made tangent
 * at the sample — so it is the boundary's own normal wherever the sample is,
 * rather than the normal at either nucleus. Symmetric under swapping the two:
 * both `toward` and `relative` negate, so their dot product does not.
 */
function pairConvergence(
  a: TectonicPlate,
  b: TectonicPlate,
  direction: Vec3,
): number {
  const toward = Vec.sub(b.axis, a.axis)
  const radial = Vec.dot(toward, direction)
  const normal = Vec.sub(toward, Vec.scale(direction, radial))
  const lengthSquared = Vec.lengthSquared(normal)
  if (lengthSquared < 1e-18) return 0
  const unit = Vec.scale(normal, 1 / Math.sqrt(lengthSquared))
  const relative = Vec.sub(a.motion, b.motion)
  return Math.max(-1, Math.min(1, Vec.dot(relative, unit)))
}

/** A unit tangent to the sphere at `axis`, rotated by `angle` about it. */
function tangentAt(axis: Vec3, angle: number): Vec3 {
  // Any vector not parallel to the axis works as a seed for the basis; +Y is
  // parallel exactly at the poles, which is why the fallback exists at all.
  const seed = Math.abs(axis.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0)
  const east = Vec.normalize(Vec.cross(seed, axis))
  const north = Vec.cross(axis, east)
  return Vec.normalize(
    Vec.add(
      Vec.scale(east, Math.cos(angle)),
      Vec.scale(north, Math.sin(angle)),
    ),
  )
}

/**
 * The crater field's lattice ladder, coarsest first.
 *
 * Each level halves the diameter and doubles the cells per axis, which
 * quadruples the cell count — so one crater per cell reproduces a cumulative
 * size–frequency slope of −2 for free, which is the lunar highlands at
 * saturation ([Robbins 2018](https://onlinelibrary.wiley.com/doi/10.1111/maps.12990)).
 * Nothing has to enforce the slope; it is the geometry.
 *
 * The *production* slope is steeper than −2, and that is where `density`
 * comes in: an unsaturated surface is thinned at the large end and approaches
 * saturation at the small end, because small craters accumulate faster than
 * they are destroyed. So the per-level chance climbs toward 1 as the diameter
 * falls, and a young surface has a steeper distribution than an old one rather
 * than the same one scaled down.
 *
 * **The ladder is a property of the body, not of the patch, and the obvious
 * alternative is what makes that worth stating.** Stopping the ladder at each
 * patch's own sample spacing would be free detail control — an orbital patch
 * would not pay for boulder-scale craters — and it breaks the morph. A CDLOD
 * child hands over by sliding its vertices onto its parent's grid, so a fully
 * morphed child is the child's *own field* sampled at the parent's spacing; that
 * equals the parent's mesh only if both evaluate the same function. Two patches
 * with different ladders differ by every crater between their two floors, and at
 * level 12 on a lunar-sized body that is eight meters of pop at the handover.
 * One field, one ladder, and the cost ceiling is `MAX_CRATER_LEVELS`.
 */
export function craterLadder(
  grammar: SurfaceGrammar,
  floor: Meters = CANONICAL_DETAIL_FLOOR,
  limit: number = MAX_CRATER_LEVELS,
): readonly CraterLevel[] {
  const largest = grammar.largestCrater
  if (!(largest > 0) || grammar.craterDensity <= 0) return []
  const levels: CraterLevel[] = []
  for (let level = 0; level < limit; level += 1) {
    const diameter = largest / 2 ** level
    if (diameter < floor) break
    // Cells per unit along an axis of direction space. A crater of diameter D
    // subtends D/R, so a cell of that size holds exactly one at most — which
    // sets the density and nothing else. **How far a sample has to walk to find
    // every crater that reaches it is `craters.ts`'s business, not this one's**,
    // and it is wider than a cell: the ejecta reach is 1.3 of them and the shell
    // is not flat against the lattice. Writing the containment down here as a
    // ±1 neighborhood is what made it look settled while it was not.
    const cells = grammar.meanRadius / diameter
    levels.push({
      cells,
      diameter,
      density: clamp01(grammar.craterDensity * 1.35 ** level),
    })
  }
  return levels
}

/**
 * The shortest ground wavelength the canonical field carries, meters.
 *
 * `TERRAIN-PLAN.md` § 5 names the canonical floor as roughly 0.5 m of amplitude
 * at ~8 m of wavelength, and this is the wavelength half of it. Below it,
 * detail is synthesized at render time and may differ between backends by
 * design — the divergence is bounded, named and measured rather than denied.
 * A landing ship spans tens of meters, so ground that is right to within this
 * is ground.
 */
export const CANONICAL_DETAIL_FLOOR: Meters = 8

/**
 * The amplitude half of the same floor, meters.
 *
 * A band whose octave contributes less than this contributes nothing the mesh,
 * the contact test or the eye can tell from zero, and evaluating it is the
 * clearest waste in the stack: octave amplitudes halve, so the last three
 * octaves of a twelve-octave band cost a quarter of it and move the ground by
 * less than a meter between them. `octavesFor` stops on whichever floor it
 * reaches first — this one or the wavelength.
 *
 * `TERRAIN_DETAIL_TOLERANCE` in `terrain.ts` is this number: the level past
 * which refinement stops buying detail is the level past which the field stops
 * having any, and they cannot be allowed to drift apart.
 */
export const CANONICAL_AMPLITUDE_FLOOR: Meters = 0.5

/**
 * How deep the crater ladder is allowed to go.
 *
 * Eleven halvings is a factor of 2,048: on Mercury that is a 1,100 km basin
 * down to a kilometer, on Iapetus a 331 km one down to 320 m, and on Callisto
 * 104 km down to a hundred. Three decades of diameter, which is the range a
 * body's craters read at from orbit down to a landing.
 *
 * **It is a cost ceiling and it sets the streaming depth, and both are worth
 * stating.** Each level is a hundred-odd cell tests and up to two hashes per
 * surviving cell, so the band is linear in this. And `surfaceDetailFloor` lands
 * two to three levels below whatever the finest crater is — a rim is about a
 * seventh of its crater wide, so resolving one to half a meter takes samples
 * seven times finer again — which sets how deep the quadtree refines and
 * therefore how many patches a landing generates. Measured on Mercury: at
 * fourteen levels the finest crater is 134 m, the floor is 16, and filling the
 * disk under a landed ship is 1,250 patches; at eleven it is a kilometer, the
 * floor is 14, and the fill is 600. The craters below it are the micro-relief
 * tail that is synthesized at render time rather than meshed.
 *
 * On a body whose largest crater is small, the canonical floor ends the ladder
 * before this does.
 */
export const MAX_CRATER_LEVELS = 11

function derive(seed: Seed, grammar: SurfaceGrammar): TerrainSketch {
  const plates: TectonicPlate[] = []
  const plateRng = new Rng(deriveSeed(seed, 'plates'))
  for (let i = 0; i < grammar.plateCount; i += 1) {
    const axis = Vec.normalize(plateRng.unitVector())
    const continental = plateRng.next() >= grammar.oceanicFraction
    plates.push({
      axis,
      motion: tangentAt(axis, plateRng.range(0, 2 * Math.PI)),
      continental,
      /*
       * Earth's elevation histogram is bimodal with means near +0.8 km and
       * −3.7 km, and the ratio between them is what this pair of ranges is:
       * continents sit a little above the datum, ocean floor a long way below.
       * A one-plate world never gets here and comes out unimodal, which is
       * Mercury.
       */
      base: continental
        ? plateRng.range(0.15, 0.45)
        : plateRng.range(-1, -0.55),
      step: plateRng.bool() ? 1 : -1,
    })
  }

  const hotspots: Hotspot[] = []
  const hotspotRng = new Rng(deriveSeed(seed, 'hotspots'))
  for (let i = 0; i < grammar.hotspotCount; i += 1) {
    /*
     * A shield's angular radius, and the stagnant-lid case is why it is a
     * function of the plate count rather than a constant. Tharsis is a third of
     * Mars; a Hawaiian shield is a hundredth of Earth. What differs is whether
     * the plate carries the volcano away from the plume before it finishes.
     */
    const spread = grammar.plateCount === 1 ? 0.35 : 0.09
    hotspots.push({
      axis: Vec.normalize(hotspotRng.unitVector()),
      radius: hotspotRng.range(spread * 0.4, spread),
      strength: hotspotRng.range(0.35, 1),
      caldera: hotspotRng.range(0.06, 0.18),
    })
  }

  const stripes: StripeAxis[] = []
  if (grammar.stripes > 0.05) {
    const stripeRng = new Rng(deriveSeed(seed, 'stripes'))
    /*
     * Enceladus has four, they are roughly parallel, and they are tens of
     * kilometers apart on a 252 km moon — so the poles of their great circles
     * cluster rather than scatter. One drawn axis and small perturbations of it
     * is what makes them read as a set rather than as four unrelated cuts.
     */
    const anchor = Vec.normalize(stripeRng.unitVector())
    const across = tangentAt(anchor, stripeRng.range(0, 2 * Math.PI))
    for (let i = 0; i < 4; i += 1) {
      stripes.push({
        pole: Vec.normalize(
          Vec.add(anchor, Vec.scale(across, (i - 1.5) * 0.06)),
        ),
        halfWidth: stripeRng.range(0.004, 0.01),
        offset: stripeRng.range(0.002, 0.006),
      })
    }
  }

  return {
    plates,
    hotspots,
    craterLevels: craterLadder(grammar),
    stripes,
    seeds: {
      hypsometry: deriveSeed(seed, 'hypsometry'),
      belts: deriveSeed(seed, 'belts'),
      relief: deriveSeed(seed, 'relief'),
      dunes: deriveSeed(seed, 'dunes'),
      sulci: deriveSeed(seed, 'sulci'),
      chaos: deriveSeed(seed, 'chaos'),
      warpX: deriveSeed(seed, 'warp:x'),
      warpY: deriveSeed(seed, 'warp:y'),
      warpZ: deriveSeed(seed, 'warp:z'),
    },
    latticeSeed: latticeSeed(seed),
  }
}

/*
 * Memoized twice over, and both layers are load-bearing.
 *
 * The **string** cache is keyed by what the derivation reads rather than by the
 * `SurfaceParameters` object, and that is the whole reason this cache works at
 * all: the heightfield worker rebuilds a fresh `SurfaceParameters` from its
 * payload on every task, so a `WeakMap` alone would derive a new sketch for
 * every patch — a millisecond apiece against a twelve-millisecond patch. Two
 * equal surfaces share an entry however they were constructed.
 *
 * The **`WeakMap`** in front of it is keyed by that object, and it exists
 * because `elevationAt` resolves the sketch *per sample*: a 69×69 bordered
 * patch is 4,761 of them, so the string cache's key — nine numbers joined,
 * every one of them a float formatted into text — was built 4,761 times a patch
 * to find a value that could not have changed. Measured at 1.7 ms on an airless
 * world and 2.5 on Earth, which is 7% of the patch spent formatting a cache
 * key. `SurfaceParameters` is immutable, so the object identifying the entry is
 * the object that derived it.
 */
const BY_SURFACE = new WeakMap<SurfaceParameters, TerrainSketch>()
const CACHE = new Map<string, TerrainSketch>()
const CACHE_LIMIT = 96

const cacheKey = (seed: Seed, grammar: SurfaceGrammar): string =>
  [
    formatSeed(seed),
    grammar.plateCount,
    grammar.oceanicFraction,
    grammar.hotspotCount,
    grammar.craterDensity,
    grammar.complexDiameter,
    grammar.largestCrater,
    grammar.meanRadius,
    grammar.stripes,
  ].join('|')

/** The sketch for a surface, derived once and kept. */
export function terrainSketch(surface: SurfaceParameters): TerrainSketch {
  const known = BY_SURFACE.get(surface)
  if (known !== undefined) return known
  const key = cacheKey(surface.seed, surface.grammar)
  const hit = CACHE.get(key)
  if (hit !== undefined) {
    BY_SURFACE.set(surface, hit)
    return hit
  }
  const sketch = derive(surface.seed, surface.grammar)
  // First in, first out, one entry per miss — the same policy `surveySites`
  // uses and for the same reason: clearing the whole map at the cap turns every
  // revisit into a fresh derivation.
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, sketch)
  BY_SURFACE.set(surface, sketch)
  return sketch
}
