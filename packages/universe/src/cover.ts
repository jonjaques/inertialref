import type { Meters } from '@inertialref/shared'
import { clamp01, noise3, smoothstep } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import { channelWetness, type PlateContext } from './bands.ts'
import { rayBrightness } from './craters.ts'
import { biotaWindow, type SurfaceGrammar } from './grammar.ts'
import { PLATE_MARGIN, plateProperty, type TerrainSketch } from './sketch.ts'

/*
 * What the ground is made of, as six numbers.
 *
 * The height field says what shape the ground is. This says what it *is* — and
 * the split is not arbitrary, it is a split by who can answer. Three of the
 * inputs a biome is drawn from are geometry: latitude is the direction against
 * the spin axis, altitude is the radius, slope is the normal against the
 * radial. A shader has all three, per pixel, for free, and computing them here
 * and shipping them per vertex would be paying to send the renderer something
 * it is standing on.
 *
 * What a shader cannot derive is history. Whether this plain is flood basalt or
 * the same rock as the highland beside it; whether this ground was excavated
 * last week or three billion years ago; which way the crust's composition
 * varies; where the volatiles have condensed; where the liquid runs and where
 * something grows beside it. Those are facts about the body's past, they come
 * out of the same sketch the landforms do, and they are the six channels below.
 *
 * **The whole record is eight bytes**, two vertex attributes of four. A patch
 * is 4,225 vertices and a whole-disk selection is several hundred patches, so a
 * float per channel would be 100 KB a patch against the 203 KB the geometry
 * already costs. Every one of these is a fraction that saturates, read through
 * a mip chain and a splat weight — `Uint8` resolves it to a four-hundredth, and
 * nothing downstream can tell that from a float.
 */

/** What the ground at a direction is made of. Every field is 0 to 1. */
export interface SurfaceCover {
  /**
   * Impact-fresh material: crater rays and the continuous ejecta blanket.
   *
   * The one high-contrast albedo feature an airless world has, and the reason
   * the Moon does not read as a uniform ball. See `rayBrightness`.
   */
  readonly bright: number
  /**
   * Flood basalt: the dark, smooth plains that pond in basins.
   *
   * Mare against highland is the largest albedo contrast on the Moon — a
   * factor of two — and it is invisible to geometry, because a flooded basin
   * floor is exactly as flat and as low as an unflooded one. What decides it is
   * whether melt reached the surface there, which is the body's volcanic
   * history and a basin deep enough to crack the crust.
   */
  readonly dark: number
  /**
   * Where this crust sits on the body's own compositional ramp, 0.5 neutral.
   *
   * One scalar rather than a color because the *ends* of the ramp are a
   * property of the body — Mars runs dust-ochre to basalt-grey, Europa runs
   * clean ice to sulphur-stained — and only the position along it is a property
   * of the ground.
   */
  readonly mineral: number
  /** Condensed volatiles lying on the surface: caps, frost, an icy shell. */
  readonly ice: number
  /**
   * Standing liquid in a channel: the riverbed `drainageCarve` floored.
   *
   * A river is not in the height field — the field says where the valley
   * floor is, and this says whether liquid is running along it. The material
   * draws it as the sea is drawn, and it is the one channel that can put
   * water above the sea datum.
   */
  readonly wet: number
  /**
   * How much of the ground something is growing on, 0..1.
   *
   * The pigment of a biosphere, laid where the temperature, the air and the
   * rainfall allow it. The design bible's flora is post-MVP; this is the
   * colour it leaves on the ground when it arrives, and the reason a temperate
   * world reads as one from orbit rather than as a wet desert.
   */
  readonly biota: number
}

/** The ground with nothing on it: bare mature bedrock. */
export const BARE_COVER: SurfaceCover = {
  bright: 0,
  dark: 0,
  mineral: 0.5,
  ice: 0,
  wet: 0,
  biota: 0,
}

/**
 * Cycles per unit of direction space for the mare gate.
 *
 * Low, because what it has to produce is a *hemispheric* asymmetry. The Moon's
 * maria cover a third of the near side and 2% of the far side, and the
 * explanation is crustal thickness varying on the scale of the body itself —
 * one and a half cycles across the sphere is that scale.
 */
export const MARE_CYCLES = 1.5

/** And for the compositional ramp, which varies on the scale of a province. */
export const MINERAL_CYCLES = 4.5

/*
 * Exported, like every other number in this file, for the reason `bands.ts`
 * gives: the TSL port in `apps/game/src/render/terrainKernel.ts` reads the
 * same constants and a tolerance test holds the two evaluations together.
 */

/**
 * The rest of what the four channels are written in, named where each is
 * spent. `basinShallow` and `basinDeep` are in multiples of the crater band's
 * own ceiling; `airSupply` is the column mass, kg/m², at which an atmosphere
 * fully supplies condensables; `shellStart` and `shellSpan` turn `grammar.icy`
 * into an ice shell.
 */
export const COVER_SHAPE = {
  meltGain: 6,
  basinShallow: -2,
  basinDeep: -5,
  mareNoise: 0.55,
  provinceGain: 0.3,
  felsicGain: 0.34,
  frostCycles: 9,
  frostRagged: 12,
  capWarm: 22,
  capCold: -12,
  zenithFloor: 0.02,
  airSupply: 100,
  shellStart: 0.35,
  shellSpan: 0.4,
  rainCycles: 5,
  rainFloor: 0.3,
  treelineStart: 0.22,
  treelineEnd: 0.6,
  dampReach: 0.5,
  patchCycles: 46,
  patchFloor: 0.35,
} as const

/**
 * Where the mare gate opens and closes, on a lobe that runs −1.55 to 1.55.
 *
 * Narrow, and offset well above zero, so that the gate is a *decision* rather
 * than a modulation: the basins on the near side flood and the basins on the
 * far side are dry highland. Opened wide instead, every basin on the body
 * floods a little, which is a world with grey basins rather than one with
 * maria — and no threshold on the basin depth produces the asymmetry, because
 * the basins are not asymmetric. The flooding is.
 */
export const GATE_LO = 0.1
export const GATE_HI = 0.45

/**
 * Where water ice stops subliming away in vacuum, Kelvin.
 *
 * Not the melting point. A surface in vacuum loses ice by sublimation, and the
 * rate falls off exponentially with temperature — around 145 K a millimetre a
 * billion years, around 170 K a metre a year. So this is the line between a
 * body that keeps exposed ice for geological time and one that does not, and it
 * is why Mercury's poles hold ice at 1,600 K of subsolar heat: the floors of
 * their polar craters never see the sun.
 */
export const FROST_POINT = 170

/**
 * What the ground at a direction is made of.
 *
 * Pure, deterministic, and a function of the same sketch the landforms come
 * from — a save stores neither this nor the height beside it.
 */
export function surfaceCover(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  plates: PlateContext,
  craters: Meters,
  craterLimit: Meters,
  drainage: DrainageSample,
): SurfaceCover {
  const wet = wetCover(grammar, drainage)
  return {
    bright: rayBrightness(sketch.rayCraters, grammar, direction),
    dark: mareCover(sketch, grammar, direction, craters, craterLimit),
    mineral: mineralCover(sketch, direction, plates),
    ice: iceCover(sketch, grammar, direction),
    wet,
    biota: biotaCover(sketch, grammar, direction, drainage, wet),
  }
}

/**
 * What the drainage band worked out about a sample, handed on to the cover
 * rather than evaluated twice: the two valley fields, and how far the landform
 * stands above the drainage datum once they have cut it.
 */
export interface DrainageSample {
  readonly valley: number
  readonly tributary: number
  /** Meters above `drainageDatum`, after the carve. Negative under the sea. */
  readonly aboveDatum: Meters
}

/** A sample on a body with no drainage: dry, and nowhere in particular. */
export const NO_DRAINAGE: DrainageSample = {
  valley: 0,
  tributary: 0,
  aboveDatum: 0,
}

/**
 * Liquid running in a channel, where the band has floored one and the
 * grammar says the liquid exists.
 *
 * Gated on the ground standing above the datum: below it the sea is drawn
 * instead, and a riverbed under the sea is seabed.
 */
function wetCover(grammar: SurfaceGrammar, drainage: DrainageSample): number {
  if (grammar.liquid <= 0 || drainage.aboveDatum <= 0) return 0
  return clamp01(
    channelWetness(drainage.valley, drainage.tributary) * grammar.liquid,
  )
}

/**
 * What grows here.
 *
 * Four gates and a rainfall. The latitude term is the one `iceCover` uses,
 * read against the biosphere's window rather than the frost point, so the
 * cold ends of a temperate world are bare the way its poles are frozen; the
 * treeline thins growth with altitude as a fraction of the relief budget; the
 * shore takes it off the seabed; and the rainfall is a province-scale noise
 * with a floor, because a world with a sea has no dry side, only drier ones.
 * The valleys are damper than the divides, which is why the growth follows
 * the rivers from orbit.
 */
function biotaCover(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  drainage: DrainageSample,
  wet: number,
): number {
  if (grammar.biota <= 0) return 0
  const cosZenith = Math.max(
    COVER_SHAPE.zenithFloor,
    Math.sqrt(Math.max(0, 1 - direction.y ** 2)),
  )
  const local = grammar.groundTemperature * cosZenith ** 0.25
  const warmth = biotaWindow(local)
  if (warmth <= 0) return 0
  const budget = Math.max(grammar.reliefLimit, 1)
  const treeline =
    1 -
    smoothstep(
      COVER_SHAPE.treelineStart * budget,
      COVER_SHAPE.treelineEnd * budget,
      drainage.aboveDatum,
    )
  const ashore = smoothstep(0, 0.004 * budget, drainage.aboveDatum)
  const rain =
    noise3(
      sketch.seeds.rain,
      direction.x * COVER_SHAPE.rainCycles,
      direction.y * COVER_SHAPE.rainCycles,
      direction.z * COVER_SHAPE.rainCycles,
    ) *
      0.5 +
    0.5
  const damp = Math.min(
    1,
    rain +
      COVER_SHAPE.dampReach *
        Math.max(drainage.valley ** 2, drainage.tributary ** 2),
  )
  const moisture = COVER_SHAPE.rainFloor + (1 - COVER_SHAPE.rainFloor) * damp
  /*
   * And a patchiness at the scale of a province's weather, because a
   * biosphere is not a coat of paint: a forest gives way to grassland and
   * grassland to scrub over tens of kilometers, for reasons of soil and
   * drainage this field does not carry. One octave, off the rain's seed at
   * nine times its frequency, with a floor so the patches thin the growth
   * rather than cut it.
   */
  const patch =
    noise3(
      sketch.seeds.rain,
      direction.x * COVER_SHAPE.patchCycles + 53.7,
      direction.y * COVER_SHAPE.patchCycles,
      direction.z * COVER_SHAPE.patchCycles,
    ) *
      0.5 +
    0.5
  const patchy =
    COVER_SHAPE.patchFloor + (1 - COVER_SHAPE.patchFloor) * patch * patch
  // Nothing grows on the river itself.
  return clamp01(
    grammar.biota * warmth * treeline * ashore * moisture * patchy * (1 - wet),
  )
}

/**
 * Flood basalt, as basin depth gated by where the crust was thin.
 *
 * Two conditions, and both are needed. The basin is the crater field's own sum:
 * a body's deepest ground is the floor of its largest impacts, which is where
 * the lithosphere is thinnest and the melt reaches. And the gate is a
 * hemispheric noise, which is what stops every basin from flooding — on the
 * Moon it is the near side that did, on Mars the northern lowlands, and on
 * Mercury essentially the whole planet. A body with no volcanic budget at all
 * takes none of this.
 */
function mareCover(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
  craters: Meters,
  craterLimit: Meters,
): number {
  /*
   * Rock, and melt to erupt. `icy` runs the term to zero on an ice shell, where
   * the equivalent process is cryovolcanic resurfacing and produces bright
   * plains rather than dark ones — that is `ice`'s business, not this one's.
   */
  const melt =
    clamp01(grammar.bands.volcanism * COVER_SHAPE.meltGain) * (1 - grammar.icy)
  if (melt <= 0 || craterLimit <= 0) return 0

  /*
   * How far into a basin this is, in multiples of the crater band's own
   * ceiling — which is the unit that makes one pair of numbers serve every
   * body, because the ceiling scales with the relief the grammar allowed.
   *
   * The **raw** sum, and the thresholds are why: on Luna the median direction
   * sits at −2.2 ceilings and the first percentile at −6.6, so two and five
   * select roughly the deepest tenth. That is the mare's share of the near side
   * once the hemispheric gate has taken half of it. Read off the soft-limited
   * sum instead, every one of those numbers is −1.
   */
  const basin = smoothstep(
    COVER_SHAPE.basinShallow * craterLimit,
    COVER_SHAPE.basinDeep * craterLimit,
    craters,
  )
  if (basin <= 0) return 0

  /*
   * A dipole, roughened. The lobe is what makes a near side; the noise is what
   * keeps its edge from being a great circle drawn across the planet.
   */
  const dipole =
    direction.x * sketch.mareAxis.x +
    direction.y * sketch.mareAxis.y +
    direction.z * sketch.mareAxis.z
  const gate =
    dipole +
    COVER_SHAPE.mareNoise *
      noise3(
        sketch.seeds.mare,
        direction.x * MARE_CYCLES,
        direction.y * MARE_CYCLES,
        direction.z * MARE_CYCLES,
      )
  return clamp01(basin * smoothstep(GATE_LO, GATE_HI, gate) * melt)
}

/**
 * Composition, as a province noise plus the crust the plates carry.
 *
 * The plate term is read through `plateProperty` rather than off the nearest
 * plate, for the reason `AGENTS.md` states as a rule: the identity of a ranked
 * neighbor is discontinuous where the ranking changes, and those loci run
 * through every plate's interior. Read that way this would draw a hard-edged
 * polygon across the middle of a continent.
 */
function mineralCover(
  sketch: TerrainSketch,
  direction: Vec3,
  plates: PlateContext,
): number {
  const province = noise3(
    sketch.seeds.mineral,
    direction.x * MINERAL_CYCLES,
    direction.y * MINERAL_CYCLES,
    direction.z * MINERAL_CYCLES,
  )
  const sample = plates.sample
  // Continental crust is felsic and pale, ocean floor is mafic and dark: the
  // one compositional fact a plate carries, and the ramp's two ends.
  const felsic =
    sample === null
      ? 0.5
      : plateProperty(
          sample,
          (plate) => (plate.continental ? 1 : 0),
          PLATE_MARGIN,
        )
  return clamp01(
    0.5 +
      COVER_SHAPE.provinceGain * province +
      COVER_SHAPE.felsicGain * (felsic - 0.5),
  )
}

/**
 * Condensed volatiles, from where on the body it is cold enough to keep them.
 *
 * The latitude term is radiative equilibrium and nothing more: absorbed flux
 * goes as the cosine of the solar zenith angle and emission as the fourth power
 * of temperature, so surface temperature falls as `cos^(1/4)`. That is a weak
 * function — Earth's poles are 0.55 of the equator's temperature by it, which
 * is why a cap needs a body already close to the frost point rather than merely
 * tilted away from the sun.
 *
 * An ice shell carries the term rather than bypassing it. Callisto is ice at
 * the equator at noon because Callisto is at 134 K there and the cap saturates,
 * not because being made of ice exempts a body from being measured — a shell
 * read *over* the frost test draws a 491 K rock as two-thirds ice, since `icy`
 * is a function of density alone and density does not know where the body
 * orbits. See `supply` and the return below.
 */
function iceCover(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
): number {
  const shell = clamp01(
    (grammar.icy - COVER_SHAPE.shellStart) / COVER_SHAPE.shellSpan,
  )
  /*
   * Cold is not enough: there has to be something to condense.
   *
   * Mercury's poles are cold by this arithmetic and they are bare, because the
   * planet has no volatile inventory to draw on — the ice it does hold is
   * cometary, and it is in the floors of craters the sun has never reached,
   * which is a shadowing model this field does not have. The two supplies that
   * do work at the surface are an atmosphere that carries condensables and a
   * body made of ice to begin with.
   */
  const supply = Math.max(
    shell,
    clamp01(grammar.airMass / COVER_SHAPE.airSupply),
  )
  if (supply <= 0) return 0

  /*
   * The latitude term the docstring above derives. `direction` is a unit vector
   * in body-fixed axes and the spin axis is +Y, which is the convention
   * `datumRadius` divides `polarRadius` into.
   */
  const cosZenith = Math.max(
    COVER_SHAPE.zenithFloor,
    Math.sqrt(Math.max(0, 1 - direction.y ** 2)),
  )
  const local = grammar.groundTemperature * cosZenith ** 0.25
  // Ragged, because a cap edge is weather rather than a parallel. One octave:
  // the shape of a cap margin at any finer scale is seasonal and this is not.
  const ragged =
    noise3(
      sketch.seeds.frost,
      direction.x * COVER_SHAPE.frostCycles,
      direction.y * COVER_SHAPE.frostCycles,
      direction.z * COVER_SHAPE.frostCycles,
    ) * COVER_SHAPE.frostRagged
  const cap = smoothstep(
    FROST_POINT + COVER_SHAPE.capWarm,
    FROST_POINT + COVER_SHAPE.capCold,
    local + ragged,
  )
  /*
   * The shell rides inside `supply`, not around the whole expression.
   *
   * `supply` is already `max(shell, air)`, so on a genuinely cold icy body
   * `min(cap, supply)` is `supply` and the outer `max(shell, ...)` this
   * replaces changed nothing — it could only ever fire where `cap < shell`,
   * which is exactly the case where the frost test has said the ground is too
   * warm to hold volatiles. Across the whole catalog one body moves: a 491 K
   * sub-2,400 kg/m³ rock inside its star's frost line, from 0.69 ice to none.
   */
  return clamp01(Math.min(cap, supply))
}

/**
 * The channels as bytes, in the order the vertex attributes carry them: the
 * first four in `terrainCover`, the second four in `terrainCover2`.
 *
 * `Math.round` rather than a truncating multiply, because the ends have to
 * survive: a cover of exactly 1 truncated by `value * 255 | 0` is 255 only if
 * the multiply lands on it, and a 254 where the field says "wholly ice" is a
 * one-part-in-255 seam wherever a fully covered patch meets one that rounded
 * the other way.
 *
 * The last two bytes are written as zero and read by nothing. A vertex buffer
 * stride has to be a multiple of four, so six channels cost eight bytes
 * whatever is put in them, and the two spare are where the canonical slope
 * the deposits still want will go.
 */
export function packCover(
  cover: SurfaceCover,
  out: Uint8Array,
  at: number,
): void {
  out[at] = Math.round(clamp01(cover.bright) * 255)
  out[at + 1] = Math.round(clamp01(cover.dark) * 255)
  out[at + 2] = Math.round(clamp01(cover.mineral) * 255)
  out[at + 3] = Math.round(clamp01(cover.ice) * 255)
  out[at + 4] = Math.round(clamp01(cover.wet) * 255)
  out[at + 5] = Math.round(clamp01(cover.biota) * 255)
  out[at + 6] = 0
  out[at + 7] = 0
}

/**
 * The bytes back, as a record. The inverse of `packCover`.
 *
 * Beside it rather than at the reader, because the channel order and the 255
 * are one fact and a reader that spells them out again is a second place they
 * have to stay true — and the order is a live question while the deposits still
 * want a channel for the canonical slope.
 */
export function unpackCover(bytes: Uint8Array, at: number): SurfaceCover {
  return {
    bright: (bytes[at] as number) / 255,
    dark: (bytes[at + 1] as number) / 255,
    mineral: (bytes[at + 2] as number) / 255,
    ice: (bytes[at + 3] as number) / 255,
    wet: (bytes[at + 4] as number) / 255,
    biota: (bytes[at + 5] as number) / 255,
  }
}

/** How many bytes `packCover` writes per sample. */
export const COVER_CHANNELS = 8
