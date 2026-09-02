import type { Meters } from '@inertialref/shared'
import {
  clamp,
  falloff,
  fbm3,
  fbmField,
  mix,
  noise3,
  pcg4d,
  ridged3,
  ridgedField,
  type Seed,
  smoothstep,
  toUnit,
} from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { SurfaceGrammar } from './grammar.ts'
import {
  CANONICAL_AMPLITUDE_FLOOR,
  CANONICAL_DETAIL_FLOOR,
  convergence,
  type Hotspot,
  plateAt,
  PLATE_MARGIN,
  plateProperty,
  type PlateSample,
  type StripeAxis,
  type TerrainSketch,
} from './sketch.ts'

/*
 * The band stack.
 *
 * Six fields, evaluated coarse to fine, each returning a number in roughly
 * [-1, 1] that `elevationAt` scales by that band's share of the body's relief
 * budget. Shares rather than meters, because a band that carried its own scale
 * could quietly grow past the peak the strength limit allows — and because the
 * budget is where the grammar says how much of this world is craters and how
 * much is mountain belts.
 *
 * The crater band is the exception and lives in `craters.ts`: it works in
 * meters, because its shape is published in meters — depth over diameter, rim
 * height over diameter, a transition diameter that scales as 1/g — and
 * converting all of that into a fraction of a budget would be inventing a
 * second set of numbers that had to agree with the first.
 *
 * **Octave counts are derived, not written down.** A band evaluated at `d · k`
 * has its coarsest features about `R/k` meters across, and each octave is
 * `lacunarity` times finer and half as tall; `octavesFor` counts how many it
 * takes to reach the canonical floor — in wavelength or in amplitude, whichever
 * comes first — and stops there. That is the "coarse-to-fine with early-out"
 * the plan asks for, stated as arithmetic: a 50 km moon does not evaluate the
 * twelve octaves an Earth-sized world needs, because it runs out of world
 * first, and a band with a tenth of the relief budget stops three octaves
 * earlier than one with all of it.
 *
 * **The plate lookup is done once and handed round.** Three of the six bands
 * read the plates a sample sits among, and each of them used to call `plateAt`
 * itself — a pass over every nucleus, three times over, for an answer that
 * depends on nothing but the direction. `convergence` was paid twice the same
 * way. `plateContext` is that work, done once per sample by `elevationAt` and
 * passed down; it is 4.4 ms a patch on a world with plates.
 *
 * **Only the bands that read a gradient pay for one.** `gradientNoise3` is four
 * times the cost of `noise3` — the value is one trilinear interpolation and the
 * gradient is three more — and it is worth it exactly where the derivative is
 * consumed: the relief band's slope damping, and the belts' when the grammar
 * says the world erodes. Everywhere else — the hypsometric swell,
 * the domain warp, the arc cones, the sulci — the value is all anyone wants and
 * the v1 primitives are what get called. On an airless world that is the whole
 * stack except the craters.
 */

/**
 * How many octaves it takes a band to reach the canonical detail floor.
 *
 * Two floors, and the tighter one wins. Wavelength: the coarsest feature is
 * about `R/cycles` meters across and each octave is `lacunarity` times finer,
 * so `log(coarsest/floor)` octaves reach 8 m. Amplitude: octaves halve, and a
 * normalized fBm's `i`-th one carries `peak · 2^-i / 2`, so it drops under half
 * a meter after `log2(peak)` of them.
 *
 * `peak` is the band's whole contribution in meters — its share of the budget —
 * and passing it is what makes a band that owns a tenth of a small moon's
 * relief stop at four octaves where the arithmetic on wavelength alone would
 * ask for eleven. The gain is assumed to be the default 0.5; a band that sets
 * its own would need this to read it, and none does.
 */
export function octavesFor(
  radius: Meters,
  cycles: number,
  max: number,
  peak: Meters = Number.POSITIVE_INFINITY,
): number {
  const coarsest = radius / Math.max(cycles, 1e-6)
  if (!(coarsest > CANONICAL_DETAIL_FLOOR)) return 1
  const byLength = Math.ceil(
    Math.log(coarsest / CANONICAL_DETAIL_FLOOR) / Math.log(2.03),
  )
  const byAmplitude = Number.isFinite(peak)
    ? Math.ceil(Math.log2(Math.max(1, peak / CANONICAL_AMPLITUDE_FLOOR)))
    : Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(max, byLength, byAmplitude))
}

/**
 * How wide a margin each band reads a plate property over.
 *
 * They are the support radii of `plateProperty`'s weights: a plate this much
 * farther from the sample than the nearest one has no say in that band. They
 * genuinely differ, which is why there are three rather than one — hypsometry
 * changes crust type over a shelf and slope, a mountain belt is an orogen wide,
 * and an arc's volcanoes sit closer to the trench than either.
 *
 * `HYPSOMETRY_MARGIN` is a quarter of a radian, ~1,600 km on Earth: a
 * continental shelf and slope together, and the scale over which the crust
 * actually changes type. `BELT_MARGIN` is a tenth, ~640 km, which is the width
 * of an orogen — the Andes are 700 km across including the foreland.
 * `ARC_MARGIN` is 0.06, which is where the volcanoes are rather than where the
 * orogen is.
 *
 * **None of them may exceed `PLATE_MARGIN`**, which is how far `plateAt`
 * bothers to look: a band blending over a wider margin than the search would be
 * dividing by a sum it had already truncated, and the answer would jump as a
 * plate fell out of a set it still had weight in. `geology.test.ts` holds the
 * three against it.
 */
export const HYPSOMETRY_MARGIN = PLATE_MARGIN
export const BELT_MARGIN = 0.1
export const ARC_MARGIN = 0.06

/*
 * The numbers each band is written in, named once and exported.
 *
 * `apps/game/src/render/terrainKernel.ts` is a TSL port of this file that
 * evaluates the same stack on the GPU, and a port carrying its own copy of `9`
 * and `11.3` is right until one side moves. Every literal below is read here
 * and there; `terrainProducer.gpu.test.ts` holds the two evaluations to a
 * stated tolerance, which is what catches a number one of them stopped reading.
 * The margins above are the same kind of thing and predate the table.
 */

/** The continental swell: cycles per unit direction, its octave cap, and its share. */
export const HYPSOMETRY_SHAPE = {
  cycles: 1.6,
  octaves: 5,
  swell: 0.35,
} as const

/**
 * The belts: the ridged field's scale, and how a range reads on each crust
 * under each motion. `lid*` is the stagnant-lid scarp field,
 * `(1 − ranges)^power · gain + offset`.
 */
export const BELT_SHAPE = {
  cycles: 9,
  octaves: 7,
  oceanicUplift: -0.9,
  continentalOpening: -0.7,
  oceanicOpening: 0.55,
  scarp: 0.35,
  lidPower: 3,
  lidGain: 2,
  lidOffset: -0.1,
} as const

/** Arc cones over a convergent margin: `edge · continental · across · cones^power · gain`. */
export const ARC_SHAPE = {
  cycles: 60,
  octaves: 4,
  offset: 11.3,
  power: 3,
  gain: 1.6,
} as const

/** A hotspot shield: the flank's concavity and how deep the caldera notches it. */
export const SHIELD_SHAPE = { flankPower: 0.7, calderaDepth: 0.4 } as const

/** Chaos terrain: block size on the ground, the wall's width, and the gate. */
export const CHAOS_SHAPE = {
  blockMeters: 10_000,
  wall: 0.35,
  floor: 0.05,
} as const

/** Sulci: grooves at `cycles`, compressed `stretch`-fold along x. */
export const SULCI_SHAPE = {
  cycles: 24,
  stretch: 5,
  octaves: 5,
  gain: 0.5,
  floor: 0.05,
} as const

/** A tiger stripe's double ridge, in multiples of its own offset. */
export const STRIPE_SHAPE = {
  shoulder: 0.7,
  reach: 3,
  shoulderWidth: 2,
} as const

/** The relief tail: its scale from `roughness`, the warp that bends it. */
export const RELIEF_SHAPE = {
  cyclesPerRoughness: 2.2,
  roughnessFloor: 0.5,
  octaves: 12,
  warpCycles: 0.5,
  warpOctaves: 2,
  warpAmount: 0.1,
} as const

/** Dunes: a ridged field at `cycles` times the relief's, compressed along x. */
export const DUNE_SHAPE = {
  floor: 0.02,
  cycles: 40,
  stretch: 0.15,
  octaves: 3,
  gain: 0.18,
} as const

/**
 * The valleys: where they run, how sharp they are, and how deep they cut.
 *
 * `cycles` sets the spacing of the trunk valleys — a body's radius over
 * twenty-four, which is 180 km on Gliese 908 IV and 265 on Earth, about the
 * spacing of the major river basins on a continent. The tributaries run at
 * `tributaryCycles` times that, unwarped, and carve `tributaryGain` as deep.
 * `sharpness` is what turns the noise's zero-level set into a valley: the
 * field is `1 − |n| · sharpness`, so a valley is the strip where the noise
 * crosses zero, and the strip is `1/sharpness` of the noise's own range wide.
 * `valleyPower` narrows the cut into a V; `floodGain` at `floodPower` is the
 * broad shallow floodplain the V sits in. Above `channelStart` the floor is
 * flat: that is the riverbed, and the cover marks it wet.
 *
 * `depth` is the deepest cut at full drainage as a fraction of the relief
 * budget — a kilometer on an 8 km world, which is the Grand Canyon's order — and
 * `headGain` is how much of the ground's height above the drainage datum a
 * channel may take, so a valley shallows toward the coast and its floor meets
 * the sea rather than cutting under it.
 */
export const DRAINAGE_SHAPE = {
  cycles: 24,
  octaves: 3,
  tributaryCycles: 3.1,
  tributaryOctaves: 2,
  tributaryGain: 0.45,
  warpCycles: 0.45,
  warpAmount: 0.3,
  sharpness: 2.6,
  valleyPower: 6,
  floodPower: 1.6,
  floodGain: 0.22,
  depth: 0.13,
  headGain: 0.85,
  channelStart: 0.991,
  channelFull: 0.998,
} as const

/**
 * The coast: how wide the shelf and the plain are, and how flat each is.
 *
 * Widths are fractions of the hypsometry band's share of the budget, which is
 * the scale the sea datum itself is set on. `shelfFlat` and `plainFlat` are
 * the slope at the waterline as a fraction of the landform's own — a shelf a
 * fifth as steep as the ground that made it is a shallow sea a long way out,
 * which is what a continental shelf is, and the plain behind the beach is
 * flatter than the hills behind that.
 */
export const COAST_SHAPE = {
  width: 0.1,
  shelfWidth: 1.4,
  shelfFlat: 0.22,
  plainWidth: 0.7,
  plainFlat: 0.42,
} as const

/**
 * The plate work every band shares, done once per sample.
 *
 * `elevationAt` builds one of these and hands it to the three bands that read
 * plates, because all three want the same answer and none of them can cache it:
 * the bands are pure functions of a direction and the direction changes every
 * sample. What it saves is stated in the module header.
 *
 * `across` is folded in for the same reason and computed only where it is read:
 * it is the *belts'* convergence, weighted at `BELT_MARGIN`, and `beltBand` is
 * the only band that reads it.
 *
 * **The arc computes its own, and sharing this one was wrong.** `ARC_MARGIN` is
 * inside `BELT_MARGIN`, which reads as the arc asking for strictly less — but
 * `convergence` returns `total/weight`, a normalised mean, and re-weighting a
 * mean moves it in either direction rather than shrinking it. Measured on Earth
 * over the 11,833 of 40,000 directions the arc actually reads: the two disagree
 * in 3,510 of them, worst case a belt reading of 0.0005 — pure transform, no arc
 * at all — against an arc reading of 1.0000, fully convergent with cones at full
 * height, at a `boundary` of 0.0583 with three plates in range. Through
 * `edge · continental · across · cones³ · 1.6` that is 436 m of a 802 m
 * volcanism budget. A second `convergence` pass costs a loop over two to four
 * plates on the thin band where `boundary < ARC_MARGIN`, which is what the arc's
 * own gate was already paying for.
 *
 * **`across` is defined only where `edge > 0`, and it is zero rather than
 * continuous outside that.** It steps at `boundary === BELT_MARGIN`, where the
 * pair weights go to zero but their normalized ratio does not. Nothing sees it:
 * `beltBand` multiplies by an `edge` that is exactly zero there and returns
 * before that anyway, and the arc gates at 0.06. A third consumer, or an
 * `ARC_MARGIN` raised past `BELT_MARGIN`, would see it — which is the kind of
 * precondition this whole branch exists because nobody wrote down.
 */
export interface PlateContext {
  readonly sample: PlateSample | null
  /**
   * Relative motion across the nearby boundary: positive convergent, negative
   * divergent, near zero transform. Zero away from every boundary, where no
   * band reads it.
   */
  readonly across: number
}

const NO_PLATES: PlateContext = { sample: null, across: 0 }

export function plateContext(
  sketch: TerrainSketch,
  direction: Vec3,
): PlateContext {
  const sample = plateAt(sketch, direction)
  if (sample === null) return NO_PLATES
  return {
    sample,
    across:
      sample.boundary < BELT_MARGIN
        ? convergence(sample, direction, BELT_MARGIN)
        : 0,
  }
}

/**
 * Hypsometry: continents against ocean floor.
 *
 * A plate is continental or oceanic, and that one bit is what gives Earth its
 * bimodal elevation histogram — means near +0.8 km and −3.7 km with very little
 * ground in between. The blend across a boundary is what stops it being a step:
 * `F2 − F1` is zero exactly on the boundary and grows inward, so the two
 * plates' bases mix over a margin instead of meeting at a cliff.
 *
 * A stagnant-lid world has one plate and takes the `null` branch, which is the
 * swell alone — unimodal, which is Mercury.
 */
export function hypsometryBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  plates: PlateContext,
  direction: Vec3,
  peak: Meters,
): number {
  const swellCycles = HYPSOMETRY_SHAPE.cycles
  const swell = fbm3(
    sketch.seeds.hypsometry,
    direction.x * swellCycles,
    direction.y * swellCycles,
    direction.z * swellCycles,
    {
      octaves: octavesFor(
        grammar.meanRadius,
        swellCycles,
        HYPSOMETRY_SHAPE.octaves,
        peak * HYPSOMETRY_SHAPE.swell,
      ),
    },
  )

  const sample = plates.sample
  if (sample === null) return clamp(swell, -1, 1)

  const base = plateProperty(sample, (plate) => plate.base, HYPSOMETRY_MARGIN)
  return clamp(base + swell * HYPSOMETRY_SHAPE.swell, -1, 1)
}

/**
 * Tectonic belts: what happens along a plate boundary.
 *
 * Three cases, from the component of relative motion across the boundary.
 * Convergent builds a ridged range on the overriding side and a trench on the
 * other. Divergent opens a rift on continental crust and a mid-ocean ridge on
 * oceanic. Transform neither builds nor opens and leaves a scarp — a step whose
 * sign is the plate's, so the two sides of the fault sit at different heights.
 *
 * A one-plate world still cracks. Mercury's lobate scarps are a whole planet
 * that shrank as its core froze, and they are hundreds of kilometers long and a
 * kilometer high on a body with no plates at all, so the `null` branch is a
 * global scarp field rather than nothing.
 */
export function beltBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  plates: PlateContext,
  direction: Vec3,
  peak: Meters,
): number {
  /*
   * The gate, before the noise it gates.
   *
   * A belt exists within `BELT_MARGIN` of a boundary and nowhere else, which on
   * a world with twenty-odd plates is most of the sphere — and the ridged fBm
   * this band is drawn from was generated for every one of those samples and
   * then multiplied by an `edge` of zero. Seven octaves of it, with the
   * analytic-derivative form on any world that erodes: 4.4 ms a patch, thrown
   * away.
   */
  const sample = plates.sample
  const edge =
    sample === null ? 0 : 1 - smoothstep(0, BELT_MARGIN, sample.boundary)
  if (sample !== null && edge <= 0) return 0

  const cycles = BELT_SHAPE.cycles
  const options = {
    octaves: octavesFor(grammar.meanRadius, cycles, BELT_SHAPE.octaves, peak),
    damping: grammar.erosion,
  }
  // The analytic-derivative form only where the damping consumes the gradient.
  // On an airless world `erosion` is zero, and there it would be twice the cost
  // of `ridged3` for the same number.
  const raw =
    grammar.erosion > 0
      ? ridgedField(
          sketch.seeds.belts,
          direction.x * cycles,
          direction.y * cycles,
          direction.z * cycles,
          options,
        ).value
      : ridged3(
          sketch.seeds.belts,
          direction.x * cycles,
          direction.y * cycles,
          direction.z * cycles,
          options,
        )
  const ranges = raw * 0.5 + 0.5

  if (sample === null) {
    /*
     * Lobate scarps: long, low, one-sided. The `1 -` turns the ridge crest into
     * a scarp face, and the cube keeps it to a few percent of the surface.
     *
     * Clamped like every other exit from this function, and for the reason the
     * band contract states: a band returns roughly [-1, 1] and is scaled by its
     * share of the relief budget, so the shares summing to one is what bounds
     * the stack ([ADR-0019](../../../docs/adr/0019-the-geology.md) § Decision).
     * `(1 - ranges)³·2 - 0.1` reaches 1.9 as `ranges` goes to zero, and this is
     * the branch every stagnant lid takes — which is most rocky worlds with air.
     * Unclamped it was a 1.9 that turned a few percent of the surface into a
     * uniform pedestal over the whole of it.
     */
    return clamp(
      (1 - ranges) ** BELT_SHAPE.lidPower * BELT_SHAPE.lidGain +
        BELT_SHAPE.lidOffset,
      -1,
      1,
    )
  }

  const across = plates.across
  const converging = Math.max(0, across)
  const diverging = Math.max(0, -across)
  const sliding = 1 - Math.abs(across)
  /*
   * Continentalness and the transform's sense, both read as a partition.
   *
   * `edge` is *one* at the line and falls to zero away from it, so this band is
   * at full strength exactly where the plates around a sample change places —
   * which makes it the worst place in the field to read a property off one of
   * them by name. Taking `sample.plate.continental` directly flipped `uplift`
   * between `ranges` and `-0.9·ranges` at a continental-oceanic margin: a
   * 1,347.6 m step on Earth, and the one the hypsometry band's own half-blend
   * was partly masking, so correcting that alone made Earth worse rather than
   * better.
   */
  const continental = plateProperty(
    sample,
    (plate) => (plate.continental ? 1 : 0),
    BELT_MARGIN,
  )
  const step = plateProperty(sample, (plate) => plate.step, BELT_MARGIN)

  const uplift =
    converging * mix(BELT_SHAPE.oceanicUplift * ranges, ranges, continental)
  const opening =
    diverging *
    mix(
      BELT_SHAPE.oceanicOpening * ranges,
      BELT_SHAPE.continentalOpening * ranges,
      continental,
    )
  const scarp = sliding * BELT_SHAPE.scarp * step * ranges
  return clamp(edge * (uplift + opening + scarp), -1, 1)
}

/**
 * Volcanic edifices: hotspot shields, their calderas, and arc cones.
 *
 * A shield is a broad dome with a notch in the top, and the notch is not
 * decoration: a caldera is where the summit collapsed into the emptied chamber,
 * and a shield drawn without one reads as a hill. The `0.7` exponent on the
 * falloff is what makes the flank concave — Mauna Loa averages four degrees and
 * steepens toward the rift zones rather than toward the summit.
 *
 * Arc cones are gated on a convergent boundary, because that is where they are:
 * a volcanic arc is the subducting slab dehydrating under the overriding plate,
 * so the field only has cones where the belt band has a trench.
 */
export function volcanicBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  plates: PlateContext,
  direction: Vec3,
  peak: Meters,
): number {
  let height = 0
  for (const hotspot of sketch.hotspots) {
    height += shieldProfile(hotspot, direction)
  }

  const sample = plates.sample
  // The gate before the work it gates, as in `beltBand`: an arc exists within
  // `ARC_MARGIN` of a boundary, which on a plate world is a few percent of the
  // sphere, and everywhere else this whole block multiplies out to zero.
  const edge =
    sample === null ? 0 : 1 - smoothstep(0, ARC_MARGIN, sample.boundary)
  if (sample !== null && edge > 0) {
    /*
     * Continentalness scales the arc rather than gating it.
     *
     * `if (sample.plate.continental)` is a hard gate on a property that flips
     * as you cross the line, and `edge` is one *at* that line — so an arc that
     * exists on the overriding side of a margin vanished at a step on the other
     * side of it, at full amplitude. Reading it across the boundary makes the
     * arc fade out over the same 0.06 radians the rest of the band uses, which
     * is also the honest picture: an arc sits behind the trench and thins
     * toward it rather than stopping at a line.
     */
    const continental = plateProperty(
      sample,
      (plate) => (plate.continental ? 1 : 0),
      ARC_MARGIN,
    )
    if (continental > 0) {
      // The arc's own margin, not the belts'. See `plateContext`.
      const across = Math.max(0, convergence(sample, direction, ARC_MARGIN))
      const cycles = ARC_SHAPE.cycles
      const cones =
        ridged3(
          sketch.seeds.belts,
          direction.x * cycles + ARC_SHAPE.offset,
          direction.y * cycles,
          direction.z * cycles,
          {
            octaves: octavesFor(
              grammar.meanRadius,
              cycles,
              ARC_SHAPE.octaves,
              peak,
            ),
          },
        ) *
          0.5 +
        0.5
      height +=
        edge * continental * across * cones ** ARC_SHAPE.power * ARC_SHAPE.gain
    }
  }
  return clamp(height, -1, 1)
}

function shieldProfile(hotspot: Hotspot, direction: Vec3): number {
  // Chord rather than arc, as in the crater band: 0.35 radians is the widest
  // shield the sketch draws and the two differ by half a percent there.
  const ex = direction.x - hotspot.axis.x
  const ey = direction.y - hotspot.axis.y
  const ez = direction.z - hotspot.axis.z
  const distance = Math.sqrt(ex * ex + ey * ey + ez * ez)
  const t = distance / hotspot.radius
  if (t >= 1) return 0
  const flank = hotspot.strength * falloff(t) ** SHIELD_SHAPE.flankPower
  const caldera =
    t < hotspot.caldera
      ? hotspot.strength *
        SHIELD_SHAPE.calderaDepth *
        falloff(t / hotspot.caldera)
      : 0
  return flank - caldera
}

/**
 * The icy-active set: chaos terrain, sulci, and tiger-stripe troughs.
 *
 * All three are the same cause — a shell being worked by a tide it cannot
 * relax — and they are separated because they look nothing alike. Chaos is
 * Europa's block rafts: crust broken into pieces, rotated, and refrozen at
 * different heights, which is a Voronoi field with plateau interiors and sharp
 * walls. Sulci are Ganymede's grooved bands, parallel ridges over tens of
 * kilometers, which is ridged noise with one axis compressed fivefold. Tiger
 * stripes are Enceladus's four parallel fractures — a great-circle trough with
 * a raised ridge on each shoulder, which is what a double ridge is.
 */
export function iceBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  peak: Meters,
): number {
  let height = 0

  if (grammar.chaos > CHAOS_SHAPE.floor) {
    // ~10 km blocks, which is the scale Europa's chaos regions break into.
    const cells = grammar.meanRadius / CHAOS_SHAPE.blockMeters
    height += grammar.chaos * blockField(sketch.seeds.chaos, direction, cells)
  }

  if (grammar.sulci > SULCI_SHAPE.floor) {
    const cycles = SULCI_SHAPE.cycles
    const sulci = ridged3(
      sketch.seeds.sulci,
      direction.x * cycles * SULCI_SHAPE.stretch,
      direction.y * cycles,
      direction.z * cycles,
      {
        octaves: octavesFor(
          grammar.meanRadius,
          cycles * SULCI_SHAPE.stretch,
          SULCI_SHAPE.octaves,
          peak,
        ),
      },
    )
    height += grammar.sulci * SULCI_SHAPE.gain * sulci
  }

  for (const stripe of sketch.stripes) {
    height += grammar.stripes * stripeProfile(stripe, direction)
  }

  return clamp(height, -1, 1)
}

/**
 * A double ridge over a great-circle fracture.
 *
 * The trough is the fracture itself and the two ridges are the material pushed
 * up on either side of it as the walls grind. Cassini measured Enceladus's at
 * ~500 m deep and ~2 km wide with flanking ridges roughly as high, so the
 * shoulders are a real feature rather than a way of hiding the cut.
 */
function stripeProfile(stripe: StripeAxis, direction: Vec3): number {
  const away = Math.abs(
    direction.x * stripe.pole.x +
      direction.y * stripe.pole.y +
      direction.z * stripe.pole.z,
  )
  const reach = stripe.halfWidth + stripe.offset * STRIPE_SHAPE.reach
  if (away > reach) return 0
  const trough = -falloff(Math.min(1, away / stripe.halfWidth))
  const shoulderCenter = stripe.halfWidth + stripe.offset
  const shoulder =
    STRIPE_SHAPE.shoulder *
    falloff(
      Math.min(
        1,
        Math.abs(away - shoulderCenter) /
          (stripe.offset * STRIPE_SHAPE.shoulderWidth),
      ),
    )
  return trough + shoulder
}

/**
 * Voronoi block rafts: plateau interiors, sharp walls, each block at its own
 * height.
 *
 * A cube lattice in ℝ³ intersected with the sphere, for the reason the crater
 * field picks one — no face seams and no corners. The walk stays at the ±1
 * Worley window where `craters.ts` derives a wider one, and the reason is the
 * gate rather than the geometry: a truncated window can only be wrong about
 * `F1` and `F2` near a *wall*, which is exactly where `smoothstep(0, 0.35,
 * wall)` has already taken the amplitude to zero. A crater has no such gate —
 * its apron reaches `EJECTA_REACH` radii past its own cell at full height, and
 * it is indexed off the sphere besides.
 *
 * Measured rather than argued, because the argument is about a candidate set
 * and those have been wrong here before: the bisection walk over twelve great
 * circles finds nothing above **9.3e-10 m** on any of the eleven bodies with
 * chaos, Mimas, Dione and Miranda among them at full chaos and up to 3.4 km of
 * ice band.
 *
 * `F2 − F1` is the distance to the nearest wall, and running it through a
 * smoothstep is what makes the interior flat instead of conical.
 */
function blockField(seed: Seed, direction: Vec3, cells: number): number {
  const size = 1 / cells
  const baseX = Math.floor(direction.x * cells)
  const baseY = Math.floor(direction.y * cells)
  const baseZ = Math.floor(direction.z * cells)
  let nearest = Infinity
  let second = Infinity
  let winner = 0
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const ix = baseX + dx
        const iy = baseY + dy
        const iz = baseZ + dz
        const hash = pcg4d(ix ^ seed.a, iy, iz, seed.b)
        const px = (ix + toUnit(hash.x)) * size - direction.x
        const py = (iy + toUnit(hash.y)) * size - direction.y
        const pz = (iz + toUnit(hash.z)) * size - direction.z
        const distance = px * px + py * py + pz * pz
        if (distance < nearest) {
          second = nearest
          nearest = distance
          winner = hash.w
        } else if (distance < second) {
          second = distance
        }
      }
    }
  }
  if (!Number.isFinite(second)) return 0
  const wall = (Math.sqrt(second) - Math.sqrt(nearest)) / size
  return (toUnit(winner) * 2 - 1) * smoothstep(0, CHAOS_SHAPE.wall, wall)
}

/**
 * The tail: domain-warped, derivative-damped fBm, plus dunes where there is
 * wind.
 *
 * Everything the named features do not explain. The domain warp is what stops
 * it reading as noise — a warped field bends its own ridges around, which is
 * what a landscape that has been drained and re-drained looks like — and the
 * damping is the erosion stand-in: on an airless world it is zero and rims stay
 * razor-edged, under a thick atmosphere it is 1.2 and the band is worn to two
 * fifths of its roughness and half its amplitude.
 */
export function reliefBand(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  roughness: number,
  direction: Vec3,
  peak: Meters,
): number {
  const cycles =
    Math.max(RELIEF_SHAPE.roughnessFloor, roughness) *
    RELIEF_SHAPE.cyclesPerRoughness
  const octaves = octavesFor(
    grammar.meanRadius,
    cycles,
    RELIEF_SHAPE.octaves,
    peak,
  )

  /*
   * The warp is two octaves and a tenth of a cell, which is enough to bend a
   * ridge and not enough to fold the field over itself. A warp that large stops
   * being a landscape and starts being marble.
   */
  const warpCycles = cycles * RELIEF_SHAPE.warpCycles
  const warpOptions = { octaves: RELIEF_SHAPE.warpOctaves } as const
  const wx = fbm3(
    sketch.seeds.warpX,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const wy = fbm3(
    sketch.seeds.warpY,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const wz = fbm3(
    sketch.seeds.warpZ,
    direction.x * warpCycles,
    direction.y * warpCycles,
    direction.z * warpCycles,
    warpOptions,
  )
  const amount = RELIEF_SHAPE.warpAmount / cycles

  const options = { octaves, damping: grammar.erosion }
  const relief =
    grammar.erosion > 0
      ? fbmField(
          sketch.seeds.relief,
          (direction.x + wx * amount) * cycles,
          (direction.y + wy * amount) * cycles,
          (direction.z + wz * amount) * cycles,
          options,
        ).value
      : fbm3(
          sketch.seeds.relief,
          (direction.x + wx * amount) * cycles,
          (direction.y + wy * amount) * cycles,
          (direction.z + wz * amount) * cycles,
          options,
        )

  if (grammar.dunes <= DUNE_SHAPE.floor) return clamp(relief, -1, 1)

  /*
   * A dune sea is anisotropic by definition — the wind has a direction — and
   * one compressed axis is how that reads without the field carrying a wind
   * map. It is stretched along x in body-fixed axes rather than along a local
   * prevailing wind, which is the thing this owes the phase that gives the
   * grammar a circulation.
   */
  const duneCycles = cycles * DUNE_SHAPE.cycles
  const dunes = ridged3(
    sketch.seeds.dunes,
    direction.x * duneCycles * DUNE_SHAPE.stretch,
    direction.y * duneCycles,
    direction.z * duneCycles,
    {
      octaves: octavesFor(
        grammar.meanRadius,
        duneCycles,
        DUNE_SHAPE.octaves,
        peak,
      ),
    },
  )
  return clamp(relief + grammar.dunes * DUNE_SHAPE.gain * dunes, -1, 1)
}

/**
 * A valley field: 1 in the bed of a valley, 0 on the divides between them.
 *
 * The strip where a noise crosses zero. A noise's zero-level set on the
 * sphere is a network of closed curves at every octave — so where the field
 * is `1 − |n|` sharpened, the valleys branch, meander where a finer octave
 * bends the crossing, and never end in the middle of a plain, which is what a
 * river does and what a ridged field's crests do not. The warp bends the
 * trunk valleys the way a floodplain wanders; the tributaries are the same
 * construction at three times the frequency on their own seed and are left
 * unwarped, which is one noise apiece rather than four.
 *
 * Nothing here knows which way is downhill. A network that drains — every
 * valley joining a larger one and every one reaching the sea — needs a
 * per-region drainage graph, which is the seam
 * [the terrain plan](../../../design/plans/terrain.md) names and defers. What
 * this buys instead is the *look* at every scale the mesh reaches, for the
 * cost of a stateless field: `drainageCarve` shallows the cut toward the
 * datum, so a valley meets the shore at sea level whichever way its floor
 * ran to get there.
 */
export function valleyField(
  seed: Seed,
  direction: Vec3,
  cycles: number,
  octaves: number,
  warp: number,
): number {
  let px = direction.x * cycles
  let py = direction.y * cycles
  let pz = direction.z * cycles
  if (warp > 0) {
    /*
     * Three channels from one seed, by offsetting the domain a long way
     * along x — far enough that the three fields share no lattice cell.
     * Cheaper than three seeds, and exactly as uncorrelated at the scale
     * this reads them.
     */
    const wc = cycles * DRAINAGE_SHAPE.warpCycles
    const wx = noise3(
      seed,
      direction.x * wc + 37.1,
      direction.y * wc,
      direction.z * wc,
    )
    const wy = noise3(
      seed,
      direction.x * wc + 71.3,
      direction.y * wc,
      direction.z * wc,
    )
    const wz = noise3(
      seed,
      direction.x * wc + 113.7,
      direction.y * wc,
      direction.z * wc,
    )
    px += wx * warp
    py += wy * warp
    pz += wz * warp
  }
  const n = fbm3(seed, px, py, pz, { octaves })
  return 1 - Math.min(1, Math.abs(n) * DRAINAGE_SHAPE.sharpness)
}

/** The trunk valleys of a body, at their own scale and warp. */
export const trunkValley = (sketch: TerrainSketch, direction: Vec3): number =>
  valleyField(
    sketch.seeds.drainage,
    direction,
    DRAINAGE_SHAPE.cycles,
    DRAINAGE_SHAPE.octaves,
    DRAINAGE_SHAPE.warpAmount,
  )

/** And the tributaries that feed them. */
export const tributaryValley = (
  sketch: TerrainSketch,
  direction: Vec3,
): number =>
  valleyField(
    sketch.seeds.tributary,
    direction,
    DRAINAGE_SHAPE.cycles * DRAINAGE_SHAPE.tributaryCycles,
    DRAINAGE_SHAPE.tributaryOctaves,
    0,
  )

/**
 * The profile a valley field carves: a V inside a broad shallow floodplain,
 * with a flat floor where the channel runs. 0 on a divide, 1 in the bed.
 */
export function valleyProfile(valley: number): number {
  const v = valley ** DRAINAGE_SHAPE.valleyPower
  const flood = DRAINAGE_SHAPE.floodGain * valley ** DRAINAGE_SHAPE.floodPower
  const bed = smoothstep(
    DRAINAGE_SHAPE.channelStart,
    DRAINAGE_SHAPE.channelFull,
    valley,
  )
  return Math.min(1, Math.max(v + flood, bed))
}

/**
 * How deep the drainage cuts at a sample, meters, never positive.
 *
 * The cut is capped two ways and the cap is smooth. `depth` of the budget is
 * the most a valley may take at full drainage; `headGain` of the ground's
 * height above the drainage datum is the most it may take here, so the floor
 * shallows to nothing at the shore. `1 − e^(−x)` joins the two without a
 * crease: near the datum it is the second limit and far above it the first.
 */
export function drainageCarve(
  grammar: SurfaceGrammar,
  valley: number,
  tributary: number,
  aboveDatum: Meters,
  budget: Meters,
): Meters {
  if (aboveDatum <= 0 || grammar.drainage <= 0) return 0
  const deepest = DRAINAGE_SHAPE.depth * budget * grammar.drainage
  if (deepest <= 0) return 0
  const cap =
    deepest * (1 - Math.exp((-DRAINAGE_SHAPE.headGain * aboveDatum) / deepest))
  const shape = Math.min(
    1,
    valleyProfile(valley) +
      DRAINAGE_SHAPE.tributaryGain * valleyProfile(tributary),
  )
  return -cap * shape
}

/**
 * How much of the sample is riverbed, 0..1 — the flat floor of a channel,
 * trunk or tributary, that `drainageCarve` has just cut.
 */
export function channelWetness(valley: number, tributary: number): number {
  const trunk = smoothstep(
    DRAINAGE_SHAPE.channelStart,
    DRAINAGE_SHAPE.channelFull,
    valley,
  )
  const branch = smoothstep(
    DRAINAGE_SHAPE.channelStart + 0.004,
    DRAINAGE_SHAPE.channelFull,
    tributary,
  )
  return Math.max(trunk, 0.7 * branch)
}

/**
 * The coast: the landform pulled toward the sea datum on both sides of it.
 *
 * A noise field crossing a datum makes a coastline, and it makes one with the
 * slope of the noise — the shore is a cliff, the sea is deep a hundred meters
 * out, and there is nowhere for the water to be shallow. Compressing the
 * elevation toward the datum inside a band on each side widens the shelf
 * under the water and lays a plain behind the beach, and the compression is
 * C¹ at the band's edge — the smoothstep's slope is zero there — so nothing
 * creases where the remap lets go. The two sides differ on purpose: a shelf
 * is wider and flatter than a coastal plain, and the waterline itself keeps a
 * kink between them, which is what a beach is.
 *
 * `width` is in meters and is the caller's — `COAST_SHAPE.width` of the
 * hypsometry share, which is the scale the datum itself is set on.
 */
export function coastRemap(
  elevation: Meters,
  sea: Meters,
  width: Meters,
): Meters {
  const x = elevation - sea
  const below = x < 0
  const w = width * (below ? COAST_SHAPE.shelfWidth : COAST_SHAPE.plainWidth)
  const t = Math.abs(x) / w
  if (t >= 1 || w <= 0) return elevation
  const flat = below ? COAST_SHAPE.shelfFlat : COAST_SHAPE.plainFlat
  return sea + x * (flat + (1 - flat) * smoothstep(0, 1, t))
}
