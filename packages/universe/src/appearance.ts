import type { Kelvin } from '@inertialref/shared'
import { type Rng } from '@inertialref/procedural'
import type { LinearRgb } from './catalog/photometry.ts'
import type { LiquidKind, SurfaceGrammar } from './grammar.ts'
import type { BodyKind } from './system.ts'

/*
 * What a generated world looks like, as families rather than dials.
 *
 * `system.ts` decides what a body *is*; this decides what it is drawn in when
 * nobody has photographed it, and it is its own module because the Solar
 * System's builder needs the liquid half of it too, and `system.ts` already
 * imports that builder. Everything here is a pure function of an `Rng` forked
 * from the surface seed and of the grammar — the same inputs the terrain is a
 * function of, so a world's colour is as deterministic as its coastline.
 */

/**
 * The liquid that stands on a body, as it is drawn.
 *
 * Three liquids ([`LiquidKind`](./grammar.ts)) and each is a different
 * picture: water is blue in the deep and turquoise over a shelf because it
 * absorbs red first; a hydrocarbon sea is dark amber, clear in the red and
 * opaque in the blue; magma is not lit at all, it is the light. `absorption`
 * is what turns a depth into a colour — the sea sheet attenuates what it
 * refracts by `e^(−absorption · path)` per channel — and it is the number
 * that makes a shoreline read as shallow before it reads as blue.
 */
export interface LiquidAppearance {
  readonly kind: LiquidKind
  /** What the deep liquid scatters back, linear sRGB. Open sea from above. */
  readonly colour: LinearRgb
  /** Absorption per meter of path, per channel. */
  readonly absorption: LinearRgb
  /** The liquid's own emission, linear — a magma sea's glow. Black elsewhere. */
  readonly glow: LinearRgb
}

/*
 * The palette a solid world is drawn from, and why it is a list of families
 * rather than a colour dial.
 *
 * A hue drawn uniformly from a wheel makes every world the same unlikely
 * pastel. Real surfaces cluster: the iron oxides that make Mars and half the
 * deserts on Earth, the dark basalt of every mare and every ocean floor, the
 * pale feldspar of a highland, olivine's grey-green, the sulfur Io wears, the
 * tholins that stain every cold body in the outer system amber. Each row is
 * one of those, in linear sRGB, and a world draws one with a weight the
 * grammar bends — a hot world toward the sulfur and the dark basalt, a cold
 * one toward the tholins and the ice — and then a little chroma and value of
 * its own so two olivine worlds are not one world twice. The families are
 * deliberately more saturated than `KIND_COLOUR`'s class means, because a
 * generated world is drawn from this at every distance and the ground's own
 * deposits contrast *against* it; the tone curve and the deposits keep it
 * from reading as paint.
 */
export interface ColourFamily {
  readonly colour: LinearRgb
  /** Weight at a temperate ground temperature. */
  readonly weight: number
  /** Where on the temperature axis the family is most likely, Kelvin, or null for anywhere. */
  readonly warmest: number | null
}

const ROCK_FAMILIES: readonly ColourFamily[] = [
  { colour: { r: 0.25, g: 0.24, b: 0.23 }, weight: 2.0, warmest: null }, // basalt grey
  { colour: { r: 0.38, g: 0.23, b: 0.13 }, weight: 2.0, warmest: 300 }, // iron-oxide ochre
  { colour: { r: 0.42, g: 0.17, b: 0.1 }, weight: 1.2, warmest: 400 }, // red desert
  { colour: { r: 0.44, g: 0.41, b: 0.37 }, weight: 1.2, warmest: null }, // pale feldspar
  { colour: { r: 0.27, g: 0.3, b: 0.21 }, weight: 1.0, warmest: null }, // olivine
  { colour: { r: 0.47, g: 0.36, b: 0.11 }, weight: 0.9, warmest: 700 }, // sulfur
  { colour: { r: 0.15, g: 0.14, b: 0.13 }, weight: 0.9, warmest: null }, // carbonaceous
  { colour: { r: 0.36, g: 0.25, b: 0.12 }, weight: 1.0, warmest: 120 }, // tholin amber
  { colour: { r: 0.21, g: 0.32, b: 0.26 }, weight: 0.5, warmest: null }, // copper green
  { colour: { r: 0.52, g: 0.46, b: 0.42 }, weight: 0.5, warmest: 350 }, // salt and dust
  { colour: { r: 0.28, g: 0.23, b: 0.31 }, weight: 0.5, warmest: null }, // violet grey
]

const ICE_FAMILIES: readonly ColourFamily[] = [
  { colour: { r: 0.66, g: 0.71, b: 0.76 }, weight: 2.0, warmest: null }, // clean ice
  { colour: { r: 0.6, g: 0.72, b: 0.78 }, weight: 1.0, warmest: null }, // blue ice
  { colour: { r: 0.72, g: 0.62, b: 0.55 }, weight: 1.0, warmest: 60 }, // methane-pink
  { colour: { r: 0.55, g: 0.53, b: 0.48 }, weight: 1.0, warmest: null }, // dirty ice
  { colour: { r: 0.62, g: 0.66, b: 0.55 }, weight: 0.5, warmest: null }, // sulfate-stained
]

/** A family's weight at a ground temperature: its own, bent toward its warmest. */
function familyWeight(family: ColourFamily, groundTemperature: Kelvin): number {
  if (family.warmest === null) return family.weight
  const decades = Math.log10(groundTemperature / family.warmest)
  return family.weight * Math.exp(-decades * decades * 6)
}

function drawFamily(
  rng: Rng,
  families: readonly ColourFamily[],
  groundTemperature: Kelvin,
): LinearRgb {
  const index = rng.weightedIndex(
    families.map((family) => familyWeight(family, groundTemperature)),
  )
  const base = (families[index] ?? families[0]) as ColourFamily
  /*
   * A little of its own: the value moves by a fifth and the chroma by a
   * quarter about the family's luminance, so the family is recognisable and
   * the world is not a copy.
   */
  const value = rng.range(0.82, 1.2)
  const chroma = rng.range(0.75, 1.25)
  const grey =
    0.2126 * base.colour.r + 0.7152 * base.colour.g + 0.0722 * base.colour.b
  const channel = (c: number): number =>
    Math.max(0, (grey + (c - grey) * chroma) * value)
  return {
    r: channel(base.colour.r),
    g: channel(base.colour.g),
    b: channel(base.colour.b),
  }
}

/** What a solid world's ground reflects, from its seed and its grammar. */
export function surfaceColourFor(
  rng: Rng,
  kind: BodyKind,
  grammar: SurfaceGrammar,
): LinearRgb {
  const temperature = Math.max(grammar.groundTemperature, 20)
  // `icy` is a ramp rather than the kind, because the mixed bodies are the
  // point: a two-thirds-ice moon draws from both tables in proportion.
  const rock = drawFamily(rng, ROCK_FAMILIES, temperature)
  const ice = drawFamily(rng, ICE_FAMILIES, temperature)
  const t = kind === 'ice' ? Math.max(grammar.icy, 0.6) : grammar.icy
  return {
    r: rock.r + (ice.r - rock.r) * t,
    g: rock.g + (ice.g - rock.g) * t,
    b: rock.b + (ice.b - rock.b) * t,
  }
}

/*
 * What the air scatters, as a composition family.
 *
 * Rayleigh scattering off small molecules is blue whatever the molecule, so
 * blue is the common answer; the others are the aerosols and the absorbers
 * that override it. Suspended dust is Mars — a butterscotch sky and a blue
 * sunset, the exact inverse of Earth's. Sulfuric haze is Venus, a yellow-white
 * glare. Tholins are Titan, orange all the way round. Methane absorbs red and
 * turns a sky teal, which is Uranus's colour brought down to a surface. Each
 * is gated by the temperature its chemistry survives at.
 */
export interface HazeFamily {
  readonly colour: LinearRgb
  readonly limb: LinearRgb
  readonly weight: number
  readonly coldest: Kelvin
  readonly hottest: Kelvin
}

const HAZE_FAMILIES: readonly HazeFamily[] = [
  // Rayleigh: a blue sky and an orange limb.
  {
    colour: { r: 0.28, g: 0.48, b: 0.95 },
    limb: { r: 0.86, g: 0.45, b: 0.26 },
    weight: 3,
    coldest: 0,
    hottest: Infinity,
  },
  // Dust: butterscotch by day, blue at the terminator.
  {
    colour: { r: 0.74, g: 0.56, b: 0.36 },
    limb: { r: 0.42, g: 0.58, b: 0.92 },
    weight: 1.4,
    coldest: 150,
    hottest: 900,
  },
  // Sulfuric: a yellow-white glare.
  {
    colour: { r: 0.88, g: 0.8, b: 0.5 },
    limb: { r: 0.96, g: 0.72, b: 0.32 },
    weight: 1.2,
    coldest: 450,
    hottest: Infinity,
  },
  // Tholin: orange all round.
  {
    colour: { r: 0.82, g: 0.5, b: 0.2 },
    limb: { r: 0.92, g: 0.52, b: 0.24 },
    weight: 1.4,
    coldest: 0,
    hottest: 170,
  },
  // Methane: a teal sky and a warm limb.
  {
    colour: { r: 0.32, g: 0.7, b: 0.82 },
    limb: { r: 0.72, g: 0.58, b: 0.42 },
    weight: 1.0,
    coldest: 0,
    hottest: 230,
  },
  // Thin and high: violet.
  {
    colour: { r: 0.42, g: 0.36, b: 0.92 },
    limb: { r: 0.9, g: 0.42, b: 0.5 },
    weight: 0.6,
    coldest: 0,
    hottest: Infinity,
  },
  // An oxidant-rich green, rare.
  {
    colour: { r: 0.46, g: 0.76, b: 0.6 },
    limb: { r: 0.9, g: 0.62, b: 0.3 },
    weight: 0.35,
    coldest: 200,
    hottest: 500,
  },
]

export function hazeFor(
  rng: Rng,
  grammar: SurfaceGrammar,
): { readonly colour: LinearRgb; readonly limb: LinearRgb } {
  const temperature = grammar.groundTemperature
  const index = rng.weightedIndex(
    HAZE_FAMILIES.map((family) =>
      temperature >= family.coldest && temperature <= family.hottest
        ? family.weight
        : 0,
    ),
  )
  const family = (HAZE_FAMILIES[index] ?? HAZE_FAMILIES[0]) as HazeFamily
  return { colour: family.colour, limb: family.limb }
}

/*
 * What photosynthesis looks like from orbit, as a list of pigments.
 *
 * Chlorophyll is the common answer on Earth for reasons that are still
 * argued about, so it is weighted as the common answer here; the rest are
 * molecules that do the same job with a different absorption band —
 * retinal's purple, the carotenoids' gold, phycoerythrin's red, and a
 * near-black pigment that takes everything a dim star offers. A world draws
 * one and keeps it, because a biosphere's colour is a property of its
 * chemistry rather than of a province.
 */
export const PIGMENTS: readonly {
  readonly colour: LinearRgb
  readonly weight: number
}[] = [
  { colour: { r: 0.08, g: 0.21, b: 0.05 }, weight: 3.5 }, // chlorophyll
  { colour: { r: 0.16, g: 0.06, b: 0.19 }, weight: 1.2 }, // retinal purple
  { colour: { r: 0.3, g: 0.19, b: 0.04 }, weight: 1.2 }, // carotenoid gold
  { colour: { r: 0.24, g: 0.07, b: 0.05 }, weight: 1.2 }, // phycoerythrin red
  { colour: { r: 0.05, g: 0.19, b: 0.16 }, weight: 0.9 }, // teal
  { colour: { r: 0.05, g: 0.06, b: 0.05 }, weight: 0.8 }, // near-black
]

export function pigmentFor(rng: Rng): LinearRgb {
  const index = rng.weightedIndex(PIGMENTS.map((pigment) => pigment.weight))
  const base = (PIGMENTS[index] ?? PIGMENTS[0]) as (typeof PIGMENTS)[number]
  const value = rng.range(0.8, 1.25)
  return {
    r: base.colour.r * value,
    g: base.colour.g * value,
    b: base.colour.b * value,
  }
}

/**
 * The three liquids as pictures. See `LiquidAppearance`.
 *
 * Water's absorption is the published one to within the eye's tolerance —
 * about 0.35 per meter in the red, 0.06 in the green and 0.02 in the blue —
 * scaled by a turbidity the seed draws, so one sea is a Bahamas shelf and
 * the next is silt. The deep colour is the open-ocean reflectance the sphere
 * already uses, tinted between navy and teal.
 */
export function liquidAppearance(
  kind: LiquidKind | null,
  rng: Rng,
): LiquidAppearance | null {
  if (kind === null) return null
  if (kind === 'water') {
    const teal = rng.range(0, 1)
    const turbidity = rng.range(0.8, 2.4)
    return {
      kind,
      colour: {
        r: 0.01 + 0.006 * teal,
        g: 0.035 + 0.03 * teal,
        b: 0.13 - 0.03 * teal,
      },
      absorption: {
        r: 0.35 * turbidity,
        g: 0.065 * turbidity,
        b: 0.025 * turbidity,
      },
      glow: { r: 0, g: 0, b: 0 },
    }
  }
  if (kind === 'hydrocarbon') {
    const stain = rng.range(0, 1)
    return {
      kind,
      colour: { r: 0.045 + 0.02 * stain, g: 0.028, b: 0.012 },
      absorption: { r: 0.05, g: 0.12 + 0.1 * stain, b: 0.3 + 0.2 * stain },
      glow: { r: 0, g: 0, b: 0 },
    }
  }
  // Magma: opaque, and the source of its own light. The glow runs past one
  // because it is the thing the tone curve's headroom is for.
  const heat = rng.range(0.8, 1.3)
  return {
    kind,
    colour: { r: 0.12, g: 0.03, b: 0.01 },
    absorption: { r: 6, g: 6, b: 6 },
    glow: { r: 2.6 * heat, g: 0.55 * heat, b: 0.06 * heat },
  }
}
