import type { Meters } from '@inertialref/shared'
import {
  clamp01,
  deriveSeed,
  formatSeed,
  latticeSeed,
  Rng,
  type Seed,
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
 * The plate a direction belongs to, and how far it is from the nearest edge.
 *
 * One pass, two minima. `boundary` is `F2 − F1` in radians of angular distance:
 * zero exactly on a boundary, and half the plate's own width at its center.
 */
export interface PlateSample {
  readonly plate: TectonicPlate
  readonly neighbor: TectonicPlate
  readonly boundary: number
}

export function plateAt(
  sketch: TerrainSketch,
  direction: Vec3,
): PlateSample | null {
  const plates = sketch.plates
  if (plates.length < 2) return null
  let bestIndex = 0
  let best = -Infinity
  let secondIndex = 1
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
      secondIndex = bestIndex
      best = cosine
      bestIndex = i
    } else if (cosine > second) {
      second = cosine
      secondIndex = i
    }
  }
  const near = Math.acos(Math.min(1, Math.max(-1, best)))
  const far = Math.acos(Math.min(1, Math.max(-1, second)))
  return {
    plate: plates[bestIndex] as TectonicPlate,
    neighbor: plates[secondIndex] as TectonicPlate,
    boundary: far - near,
  }
}

/**
 * How the two plates at a boundary are moving relative to each other.
 *
 * Positive is convergent, negative divergent, and near zero is transform. The
 * normal is the direction from the owning nucleus toward its neighbor, made
 * tangent at the sample — so it is the boundary's own normal wherever the
 * sample is, rather than the normal at either nucleus.
 */
export function convergence(sample: PlateSample, direction: Vec3): number {
  const toward = Vec.sub(sample.neighbor.axis, sample.plate.axis)
  const radial = Vec.dot(toward, direction)
  const normal = Vec.sub(toward, Vec.scale(direction, radial))
  const lengthSquared = Vec.lengthSquared(normal)
  if (lengthSquared < 1e-18) return 0
  const unit = Vec.scale(normal, 1 / Math.sqrt(lengthSquared))
  const relative = Vec.sub(sample.plate.motion, sample.neighbor.motion)
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
    // subtends D/R, so a cell of that size holds exactly one at most, and a
    // sample's 3×3×3 neighborhood is guaranteed to contain every crater whose
    // support reaches it.
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
 * stating.** Each level is twenty-seven cell tests and up to two hashes per
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
 * Memoized by (seed, grammar identity).
 *
 * Keyed by a string rather than by the `SurfaceParameters` object, and that is
 * the whole reason this cache works at all: the heightfield worker rebuilds a
 * fresh `SurfaceParameters` from its payload on every task, so a `WeakMap` on
 * the object would derive a new sketch for every patch — a millisecond apiece
 * against a twelve-millisecond patch. The key is what the derivation reads, so
 * two equal surfaces share an entry however they were constructed.
 */
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
  const key = cacheKey(surface.seed, surface.grammar)
  const hit = CACHE.get(key)
  if (hit !== undefined) return hit
  const sketch = derive(surface.seed, surface.grammar)
  // First in, first out, one entry per miss — the same policy `surveySites`
  // uses and for the same reason: clearing the whole map at the cap turns every
  // revisit into a fresh derivation.
  if (CACHE.size >= CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, sketch)
  return sketch
}
