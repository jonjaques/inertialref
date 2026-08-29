import type { Meters } from '@inertialref/shared'
import { clamp01, noise3, smoothstep } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { PlateContext } from './bands.ts'
import { rayBrightness } from './craters.ts'
import type { SurfaceGrammar } from './grammar.ts'
import { PLATE_MARGIN, plateProperty, type TerrainSketch } from './sketch.ts'

/*
 * What the ground is made of, as four numbers.
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
 * varies; where the volatiles have condensed. Those are facts about the body's
 * past, they come out of the same sketch the landforms do, and they are the
 * four channels below.
 *
 * **The whole record is four bytes.** A patch is 4,225 vertices and a
 * whole-disk selection is several hundred patches, so a float per channel would
 * be 67 KB a patch against the 203 KB the geometry already costs. Every one of
 * these is a fraction that saturates, read through a mip chain and a splat
 * weight — `Uint8` resolves it to a four-hundredth, and nothing downstream can
 * tell that from a float.
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
}

/** The ground with nothing on it: bare mature bedrock. */
export const BARE_COVER: SurfaceCover = {
  bright: 0,
  dark: 0,
  mineral: 0.5,
  ice: 0,
}

/**
 * Cycles per unit of direction space for the mare gate.
 *
 * Low, because what it has to produce is a *hemispheric* asymmetry. The Moon's
 * maria cover a third of the near side and 2% of the far side, and the
 * explanation is crustal thickness varying on the scale of the body itself —
 * one and a half cycles across the sphere is that scale.
 */
const MARE_CYCLES = 1.5

/** And for the compositional ramp, which varies on the scale of a province. */
const MINERAL_CYCLES = 4.5

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
const GATE_LO = 0.1
const GATE_HI = 0.45

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
const FROST_POINT = 170

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
): SurfaceCover {
  return {
    bright: rayBrightness(sketch.rayCraters, grammar, direction),
    dark: mareCover(sketch, grammar, direction, craters, craterLimit),
    mineral: mineralCover(sketch, direction, plates),
    ice: iceCover(sketch, grammar, direction),
  }
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
  const melt = clamp01(grammar.bands.volcanism * 6) * (1 - grammar.icy)
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
  const basin = smoothstep(-2 * craterLimit, -5 * craterLimit, craters)
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
    0.55 *
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
  return clamp01(0.5 + 0.3 * province + 0.34 * (felsic - 0.5))
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
 * An ice shell short-circuits all of it. Callisto is ice at the equator at noon.
 */
function iceCover(
  sketch: TerrainSketch,
  grammar: SurfaceGrammar,
  direction: Vec3,
): number {
  const shell = clamp01((grammar.icy - 0.35) / 0.4)
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
  const supply = Math.max(shell, clamp01(grammar.airMass / 100))
  if (supply <= 0) return 0

  /*
   * Latitude, as radiative equilibrium and nothing more: absorbed flux goes as
   * the cosine of the solar zenith angle and emission as the fourth power of
   * temperature, so the ground runs as `cos^(1/4)`. That is a weak function —
   * Earth's poles come out at 0.55 of the equator's temperature — which is why
   * a cap needs a body already near the frost point rather than merely one
   * that is tilted.
   *
   * `direction` is a unit vector in body-fixed axes and the spin axis is +Y,
   * which is the convention `datumRadius` divides `polarRadius` into.
   */
  const cosZenith = Math.max(0.02, Math.sqrt(Math.max(0, 1 - direction.y ** 2)))
  const local = grammar.groundTemperature * cosZenith ** 0.25
  // Ragged, because a cap edge is weather rather than a parallel. One octave:
  // the shape of a cap margin at any finer scale is seasonal and this is not.
  const ragged =
    noise3(
      sketch.seeds.frost,
      direction.x * 9,
      direction.y * 9,
      direction.z * 9,
    ) * 12
  const cap = smoothstep(FROST_POINT + 22, FROST_POINT - 12, local + ragged)
  return clamp01(Math.max(shell, Math.min(cap, supply)))
}

/**
 * The four channels as bytes, in the order the vertex attribute carries them.
 *
 * `Math.round` rather than a truncating multiply, because the ends have to
 * survive: a cover of exactly 1 truncated by `value * 255 | 0` is 255 only if
 * the multiply lands on it, and a 254 where the field says "wholly ice" is a
 * one-part-in-255 seam wherever a fully covered patch meets one that rounded
 * the other way.
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
}

/** How many bytes `packCover` writes per sample. */
export const COVER_CHANNELS = 4
