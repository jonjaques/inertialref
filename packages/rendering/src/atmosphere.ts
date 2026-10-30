/*
 * Precomputed atmospheric scattering, in the Bruneton/Hillaire family.
 *
 * The analytic shell in the client was a placeholder with a named successor —
 * "Bruneton's precomputed transmittance and multiple-scattering LUTs", spike 2
 * — and this is that successor's precompute half. Two small tables per
 * atmosphere:
 *
 * **Transmittance** T(r, μ): how much of each wavelength survives the trip
 * from a point at radius r, along zenith-cosine μ, out to space. This is the
 * table that makes sunsets: a grazing ray crosses so much air that the blue
 * coefficient extinguishes first, and everything lit by that ray — cloud,
 * limb, the air itself — reddens with no hand-tuned "sunset color" anywhere.
 *
 * **Multiple scattering** Ψ(r, μs): Hillaire's isotropic estimate of every
 * scattering order past the first, as a single lookup. Single scattering
 * alone leaves the twilight side too dark and the thick-air limb too blue;
 * Ψ is why a dusk sky glows instead of switching off.
 *
 * Everything is in **planet radii** — the ground is r = 1 — because that is
 * the one unit that survives the renderer's distance compression: both shell
 * radii are rescaled together every time the LOD tier moves, so anything
 * baked in meters would be wrong by whatever the compressor chose that frame.
 *
 * Pure arrays in, pure arrays out, no GPU and no three.js: the bake runs
 * identically in a worker, a test, or the main thread, and the *physics* is
 * what the tests in `atmosphere.test.ts` hold still, on any Node at all — the
 * shader that consumes these tables needs a GPU, and gets one only from
 * `pnpm test:gpu`.
 *
 * Coefficients derive from the authored `HazeLayer`, not from a gas mix: the
 * zenith color *is* the scattering spectrum (a sky's color is β, up to
 * normalization), the limb color tints the aerosol where the column cannot
 * make that color itself (`aerosolTint`), and `thickness` scales the column.
 * Mars therefore keeps its butterscotch sky and its blue sunset — both are in
 * its authored colors — without this file knowing what CO₂ is.
 *
 * The column's shape is measured rather than authored: the gas falls off over
 * the body's own scale height and the aerosol over the haze's, and the
 * optical depths, the aerosol's albedo and its asymmetry are Earth's
 * published ones. ADR-0056 has the sources and the one calibrated factor.
 */

import type { AirHeights } from './datum.ts'

export interface HazeAuthoring {
  readonly color: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  readonly limb: { readonly r: number; readonly g: number; readonly b: number }
  readonly thickness: number
  /** The aerosol's Ångström exponent: its optical depth goes as λ^−α. */
  readonly aerosolAngstrom: number
  /** The ozone column, Dobson units. Earth's is about 300. */
  readonly ozone: number
}

export interface AtmosphereRecipe {
  /** Shell top over ground radius; the ground is 1. */
  readonly topRatio: number
  /** Rayleigh scale height, planet radii. */
  readonly hRayleigh: number
  /** Aerosol scale height, planet radii — aerosols hug the ground. */
  readonly hMie: number
  /** Rayleigh scattering coefficient per planet radius, RGB. */
  readonly betaRayleigh: readonly [number, number, number]
  /** Aerosol scattering coefficient per planet radius, RGB (tinted). */
  readonly mieScatter: readonly [number, number, number]
  /** Aerosol extinction per planet radius, RGB — the slope, untinted. */
  readonly mieExtinction: readonly [number, number, number]
  /** Ozone absorption per planet radius at the layer's peak, RGB. */
  readonly ozone: readonly [number, number, number]
  /** Where the ozone layer peaks, and its half-width, planet radii. */
  readonly ozonePeak: number
  readonly ozoneHalfWidth: number
}

export interface ScatteringLut {
  readonly width: number
  readonly height: number
  /** RGBA32F texels, alpha 1 — sized for a direct GPU upload. */
  readonly data: Float32Array
}

export const TRANSMITTANCE_WIDTH = 512
export const TRANSMITTANCE_HEIGHT = 64
/** Ψ's columns, over the sun's cosine. */
export const MULTI_SCATTER_WIDTH = 32
/**
 * Ψ's rows, over altitude. Half its columns: Ψ is smooth in height, and the
 * value at 16 rows is within 5% of the value at 32 through −15° of twilight,
 * for half the bake.
 */
export const MULTI_SCATTER_HEIGHT = 16
/**
 * The smallest Ψ the table can say, so its logarithm is finite. A vacuum, or
 * a point the sun cannot reach by any second bounce, reads as this.
 */
export const MULTI_SCATTER_FLOOR = 1e-30

/**
 * Earth's vertical Rayleigh optical depth, summed over RGB, at thickness 1.
 *
 * Bodhaine et al. (1999) at sea level: 0.041, 0.097 and 0.243 at 680, 550 and
 * 440 nm. Splitting the sum by the authored zenith color reproduces that
 * spectrum within a few percent, which is what licenses deriving physics from
 * art direction in the first place.
 */
const TAU_RAYLEIGH_SUM = 0.38

/**
 * Earth's vertical aerosol optical depth at thickness 1: 0.12, the global mean
 * at 550 nm in the MACv2 climatology (Kinne 2017), inside MODIS's 0.13–0.19.
 *
 * It is also what the anchor asks for. The CIE clear sky's zenith falls by a
 * factor of eight between a 60° and a 10° sun, because at a high sun most of
 * the zenith's light is the aerosol's forward lobe; a cleaner column of 0.05
 * falls by three, which makes a low sun's sky as bright as a noon one beside
 * the sun that lights it. At 0.12 the model's luminous turbidity is 2.3, where CIE type 12 puts
 * a standard clear sky at 2.5.
 */
const TAU_MIE = 0.12

/**
 * The three bands' wavelengths, nm: where Bodhaine's column above is read,
 * and where an aerosol's Ångström slope is evaluated against its 550 nm depth.
 */
const BANDS = [680, 550, 440] as const

/** Aerosol extinction over scattering: a single-scattering albedo of 0.94
 * (MACv2's global mean, and Wolff's for Martian dust in the solar band). */
const MIE_EXTINCTION_RATIO = 1 / 0.94

/** Aerosol asymmetry: 0.70, MACv2's global mean. Pathfinder measured Martian
 * dust at 0.72–0.77 across the visible; one value serves every haze here. */
export const AEROSOL_ASYMMETRY = 0.7

/**
 * Ozone's Chappuis-band cross-sections for the three channels, m² a
 * molecule, and a Dobson unit in molecules per m².
 *
 * Ozone scatters nothing and absorbs orange and green, and it is why a
 * twilight zenith is blue. Once the sun is down, the light overhead has
 * crossed the stratosphere edgeways to reach the shadowed column, through
 * thirty or forty times the vertical ozone; without it that light arrives
 * reddened by the gas and the dusk sky is the gray of a dim sunset. Its
 * vertical depth on Earth is only 0.03, so the day sky barely moves.
 *
 * Each value is the 233 K spectrum Bruneton's reference implementation
 * (2017) tabulates in 10 nm bins, averaged over the channel's CIE 1931
 * color-matching lobe rather than read at the band's nominal wavelength. The
 * band peaks at 600 nm, between the red's 680 and the green's 550: read at
 * 680 the red channel escaped it, and a −6° zenith came out violet
 * (0.65 : 0.39 : 1) where the averaged band gives 0.32 : 0.39 : 1, the blue a
 * civil-dusk photograph records.
 */
const OZONE_CROSS_SECTION = [3.98e-25, 3.61e-25, 2.52e-26] as const
const DOBSON_UNIT = 2.687e20

/**
 * The ozone layer's shape, in scale heights of its own gas: Earth's tent
 * rises from 10 km to a 25 km peak and falls to nothing at 40 km (Bruneton
 * 2017, after the 1976 US standard atmosphere), which over 8.5 km is a peak
 * at 2.94 and a half-width of 1.76. Earth's is the only ozone column in the
 * catalog.
 */
const OZONE_PEAK_HEIGHTS = 25 / 8.5
const OZONE_HALF_WIDTH_HEIGHTS = 15 / 8.5

/**
 * Scattered radiance to scene units: π, and nothing else.
 *
 * The march produces radiance per unit of the sun's irradiance, and a scene
 * unit is an albedo-one surface under that sun, which is the irradiance over
 * π — so the sky keeps its physical ratio to the ground it stands over.
 * Nothing is fitted: at π the zenith under a 60° sun is 1.07 times the CIE
 * standard clear sky's (type 12, Darula and Kittler 2002) at the model's own
 * luminous turbidity of 2.3, and `atmosphere.test.ts` holds that anchor.
 */
export const ATMOSPHERE_GAIN = Math.PI

/** Midpoint samples along the zenith column in `zenithSkyRadiance`. */
const ZENITH_STEPS = 32

/** March steps for the transmittance table. */
const TRANSMITTANCE_STEPS = 48

/**
 * Directions and steps for the multiple-scattering estimate.
 *
 * Sixty-four directions, because once the column is in shadow its light
 * arrives from a narrow wedge of sunlit air toward the sun's azimuth, and a
 * sparser sphere either misses that wedge or lands a direction in it by
 * chance: at 16 the zenith at −12° is eleven times the measured sky, and it
 * does not move by more than noise past 64.
 */
const MS_DIRECTIONS = 64
const MS_STEPS = 16

/**
 * Derive the physical recipe from an authored haze layer, its shell, and its
 * two measured scale heights (`airHeights`), all in radii of the drawn sphere.
 */
export function atmosphereRecipe(
  haze: HazeAuthoring,
  topRatio: number,
  heights: AirHeights,
): AtmosphereRecipe {
  const hRayleigh = Math.max(heights.rayleigh, 1e-7)
  const hMie = Math.max(heights.aerosol, 1e-7)
  const ceiling = Math.max(topRatio - 1, 1e-7)
  // τ = β·∫ρ, so β = τ over the column the density profile actually holds.
  const columnRayleigh = densityColumn(hRayleigh, ceiling)
  const columnMie = densityColumn(hMie, ceiling)

  const { color, limb, thickness } = haze
  const colorSum = Math.max(color.r + color.g + color.b, 1e-6)
  const tau = TAU_RAYLEIGH_SUM * thickness
  const betaRayleigh: [number, number, number] = [
    ((color.r / colorSum) * tau) / columnRayleigh,
    ((color.g / colorSum) * tau) / columnRayleigh,
    ((color.b / colorSum) * tau) / columnRayleigh,
  ]

  // The aerosol's depth per band: 550 nm is the measured one, and the
  // others follow its Ångström slope.
  const tauMie = BANDS.map(
    (wavelength) =>
      TAU_MIE * thickness * (wavelength / 550) ** -haze.aerosolAngstrom,
  )
  const tint = aerosolTint(limb, betaRayleigh, hRayleigh)
  const mieScatter: [number, number, number] = [
    (tint[0] * tauMie[0]!) / columnMie,
    (tint[1] * tauMie[1]!) / columnMie,
    (tint[2] * tauMie[2]!) / columnMie,
  ]
  // Extinction follows the slope and not the tint: a tinted extinction
  // double-counts the color the scattering tint already applied, and drifts
  // white sums.
  const mieExtinction: [number, number, number] = [
    (tauMie[0]! / columnMie) * MIE_EXTINCTION_RATIO,
    (tauMie[1]! / columnMie) * MIE_EXTINCTION_RATIO,
    (tauMie[2]! / columnMie) * MIE_EXTINCTION_RATIO,
  ]

  // A tent's area is its peak times its half-width, so the peak absorption is
  // the column's depth over the half-width.
  const ozonePeak = hRayleigh * OZONE_PEAK_HEIGHTS
  const ozoneHalfWidth = hRayleigh * OZONE_HALF_WIDTH_HEIGHTS
  const molecules = haze.ozone * DOBSON_UNIT
  const ozone: [number, number, number] = [
    (molecules * OZONE_CROSS_SECTION[0]) / ozoneHalfWidth,
    (molecules * OZONE_CROSS_SECTION[1]) / ozoneHalfWidth,
    (molecules * OZONE_CROSS_SECTION[2]) / ozoneHalfWidth,
  ]

  return {
    topRatio,
    hRayleigh,
    hMie,
    betaRayleigh,
    mieScatter,
    mieExtinction,
    ozone,
    ozonePeak,
    ozoneHalfWidth,
  }
}

/**
 * The vertical column of a `densities` profile: ∫₀ᶜ e^(−h/H)·(1 − h/C) dh.
 *
 * Not H. The fade that takes the density to zero at the ceiling removes
 * H/C of the column — 8% of Earth's gas under its 110 km shell — and an
 * aerosol whose scale height approaches the shell loses most of it, so a
 * coefficient taken as τ/H draws a thinner column than the one measured.
 */
export function densityColumn(scaleHeight: number, ceiling: number): number {
  const ratio = scaleHeight / ceiling
  return scaleHeight * (1 - ratio * (1 - Math.exp(-1 / ratio)))
}

/**
 * The aerosol's own color: the part of the authored limb the Rayleigh column
 * does not already make, with a mean of one.
 *
 * `limb` is what light that has grazed the air looks like, and the
 * transmittance table reddens that light by itself. Earth's orange terminator
 * is its λ⁻⁴ column at a grazing airmass and nothing more, so tinting the
 * aerosol with the whole limb applies the orange twice — and the second
 * application is not confined to the limb. The aerosol's forward lobe sits
 * around the sun at noon, which it painted salmon, and its multiple
 * scattering laid the tint over the whole day sky: a 59° sun gave a zenith of
 * 1.00 : 0.73 : 0.91 against an authored 0.29 : 0.51 : 1. Mars is the
 * opposite case: a 600 Pa column cannot turn anything blue, so its blue limb
 * is the dust's own forward scattering and has to stay on the aerosol.
 *
 * So the split is made in log chroma, where a transmittance is a subtraction.
 * The horizontal column's reddening comes off the limb, and of what remains
 * only the part along the limb's own departure from gray is kept, capped at
 * the limb itself: Earth's remainder points away from its limb and leaves the
 * aerosol gray, Mars keeps about half its blue, and Titan and Venus, whose
 * limbs are their own sky color, keep all of it. The horizontal airmass is
 * Chapman's `√(π/2H)` for a ground observer, in the recipe's own planet
 * radii.
 */
export function aerosolTint(
  limb: HazeAuthoring['limb'],
  betaRayleigh: readonly [number, number, number],
  hRayleigh: number,
): [number, number, number] {
  const airmass = Math.sqrt(Math.PI / (2 * Math.max(hRayleigh, 1e-9)))
  const departure = (values: readonly number[]): number[] => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return values.map((value) => value - mean)
  }
  const tinted = departure(
    [limb.r, limb.g, limb.b].map((value) => Math.log(Math.max(value, 1e-6))),
  )
  // A transmittance is e^−τ, so dividing it out of the limb adds τ back.
  const remainder = departure(
    betaRayleigh.map((beta) => beta * hRayleigh * airmass),
  ).map((reddening, c) => (tinted[c] as number) + reddening)
  const along = tinted.reduce(
    (sum, value, c) => sum + value * (remainder[c] as number),
    0,
  )
  const length = tinted.reduce((sum, value) => sum + value * value, 0)
  const kept = length < 1e-12 ? 0 : Math.min(Math.max(along / length, 0), 1)
  const tint = tinted.map((value) => Math.exp(value * kept))
  const mean = (tint[0]! + tint[1]! + tint[2]!) / 3
  return [tint[0]! / mean, tint[1]! / mean, tint[2]! / mean]
}

/**
 * Densities at height h above the ground, planet radii.
 *
 * The `(1 − h01)` factor takes both profiles to exactly zero at the shell's
 * ceiling. The exponential alone leaves ~1% there, and on an HDR canvas that
 * renders the shell's outer boundary as a visible hairline — the same cut the
 * analytic shell had to patch, kept identical here and in the shader so the
 * table and the march agree about where the air ends.
 */
function densities(
  h: number,
  recipe: AtmosphereRecipe,
): { rayleigh: number; mie: number; ozone: number } {
  const ceiling = recipe.topRatio - 1
  const fade = Math.max(0, 1 - h / ceiling)
  const ozone = ozoneDensity(h, recipe)
  if (fade === 0 || h < 0) {
    // Below the ground the air is whatever it is at the ground: a march step
    // that dips fractionally under r = 1 must not read vacuum.
    if (h < 0)
      return { rayleigh: fade > 0 ? 1 : 0, mie: fade > 0 ? 1 : 0, ozone }
    return { rayleigh: 0, mie: 0, ozone }
  }
  return {
    rayleigh: Math.exp(-h / recipe.hRayleigh) * fade,
    mie: Math.exp(-h / recipe.hMie) * fade,
    ozone,
  }
}

/** The ozone tent at height `h`, 1 at its peak; the shader's is the same. */
function ozoneDensity(h: number, recipe: AtmosphereRecipe): number {
  return Math.max(
    0,
    1 - Math.abs(h - recipe.ozonePeak) / Math.max(recipe.ozoneHalfWidth, 1e-9),
  )
}

/**
 * Sample `i` of `n` along a segment of `length`, crowded toward `perigee` —
 * the segment's lowest point, where its air is densest. Returns the distance
 * along the segment and the step the sample stands for.
 *
 * A uniform march does not resolve air that falls off over a kilometer or
 * two. Twelve spread evenly put the first sample 5 km up a 120 km column,
 * past e^−4 of Earth's aerosol, and draw a noon zenith at 39% of one marched
 * in 2,000 steps; an even 32 draw it at 80%. The samples sit at the squares
 * of an even spread on each side of the perigee, in proportion to each
 * side's length, so the steps are fine where the density is and coarse where
 * there is none: 32 come within 0.5% of 2,000, and twelve within 4%.
 * `materials.ts` places the shell's twelve by the same rule.
 */
export function marchSample(
  i: number,
  n: number,
  length: number,
  perigee: number,
): readonly [number, number] {
  const at = Math.min(Math.max(perigee, 0), length)
  const split = length > 0 ? at / length : 0
  const u = (i + 0.5) / n
  if (u < split) {
    const w = (split - u) / split
    return [at - at * w * w, (2 * at * w) / split / n]
  }
  const w = (u - split) / (1 - split)
  return [at + (length - at) * w * w, (2 * (length - at) * w) / (1 - split) / n]
}

/** Distance along (r, μ) to the sphere of radius `radius`, or Infinity. */
function distanceToSphere(r: number, mu: number, radius: number): number {
  const discriminant = r * r * (mu * mu - 1) + radius * radius
  if (discriminant < 0) return Infinity
  const root = Math.sqrt(discriminant)
  const near = -r * mu - root
  const far = -r * mu + root
  if (near > 0) return near
  if (far > 0) return far
  return Infinity
}

/**
 * Transmittance from radius r along zenith-cosine μ to the top of the air.
 *
 * Zero for rays that meet the ground: the light did not get through, and the
 * table stores that fact rather than leaving callers to re-derive the horizon.
 */
export function transmittanceFrom(
  r: number,
  mu: number,
  recipe: AtmosphereRecipe,
): [number, number, number] {
  // Only a downward ray can meet the ground: from r ≥ 1 the radius along a
  // μ ≥ 0 ray is non-decreasing. The explicit guard matters at exactly r = 1,
  // where rounding turns the tangent intersection at s = 0 into a tiny
  // positive distance and a grazing-up ray reads as ending in rock.
  const ground = mu < 0 ? distanceToSphere(r, mu, 1) : Infinity
  if (ground !== Infinity) return [0, 0, 0]
  const top = distanceToSphere(r, mu, recipe.topRatio)
  if (top === Infinity) return [1, 1, 1]

  let tauR = 0
  let tauG = 0
  let tauB = 0
  // A ray climbing from r is densest where it starts; one aimed below the
  // horizontal is densest where it passes closest to the ground.
  const perigee = mu < 0 ? -r * mu : 0
  for (let i = 0; i < TRANSMITTANCE_STEPS; i += 1) {
    const [s, step] = marchSample(i, TRANSMITTANCE_STEPS, top, perigee)
    const radius = Math.sqrt(r * r + s * s + 2 * r * s * mu)
    const { rayleigh, mie, ozone } = densities(radius - 1, recipe)
    tauR +=
      (recipe.betaRayleigh[0] * rayleigh +
        recipe.mieExtinction[0] * mie +
        recipe.ozone[0] * ozone) *
      step
    tauG +=
      (recipe.betaRayleigh[1] * rayleigh +
        recipe.mieExtinction[1] * mie +
        recipe.ozone[1] * ozone) *
      step
    tauB +=
      (recipe.betaRayleigh[2] * rayleigh +
        recipe.mieExtinction[2] * mie +
        recipe.ozone[2] * ozone) *
      step
  }
  return [Math.exp(-tauR), Math.exp(-tauG), Math.exp(-tauB)]
}

/**
 * The transmittance table.
 *
 * u spans μ ∈ [−1, 1] linearly and v spans altitude — a deliberately naive
 * parameterization against Bruneton's distance-warped one. Its weakness is
 * resolution exactly at the horizon, where T drops to zero within a texel;
 * bilinear filtering smears that edge across Δμ ≈ 0.004, about a quarter of
 * a degree — the width of a sun. A penumbra there is not a defect, it is the
 * soft horizon every orbital photograph shows.
 */
export function bakeTransmittance(recipe: AtmosphereRecipe): ScatteringLut {
  const width = TRANSMITTANCE_WIDTH
  const height = TRANSMITTANCE_HEIGHT
  const data = new Float32Array(width * height * 4)
  const ceiling = recipe.topRatio - 1
  for (let y = 0; y < height; y += 1) {
    const r = 1 + (y / (height - 1)) * ceiling
    for (let x = 0; x < width; x += 1) {
      const mu = (x / (width - 1)) * 2 - 1
      const [tr, tg, tb] = transmittanceFrom(r, mu, recipe)
      const index = (y * width + x) * 4
      data[index] = tr
      data[index + 1] = tg
      data[index + 2] = tb
      data[index + 3] = 1
    }
  }
  return { width, height, data }
}

/** Bilinear read of a baked table at (u, v) ∈ [0,1]², clamped. */
export function sampleLut(
  lut: ScatteringLut,
  u: number,
  v: number,
): [number, number, number] {
  const x = Math.min(Math.max(u, 0), 1) * (lut.width - 1)
  const y = Math.min(Math.max(v, 0), 1) * (lut.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, lut.width - 1)
  const y1 = Math.min(y0 + 1, lut.height - 1)
  const fx = x - x0
  const fy = y - y0
  const read = (px: number, py: number, c: number): number =>
    lut.data[(py * lut.width + px) * 4 + c] as number
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c += 1) {
    const top = read(x0, y0, c) * (1 - fx) + read(x1, y0, c) * fx
    const bottom = read(x0, y1, c) * (1 - fx) + read(x1, y1, c) * fx
    out[c] = top * (1 - fy) + bottom * fy
  }
  return out
}

const transmittanceAt = (
  lut: ScatteringLut,
  recipe: AtmosphereRecipe,
  radius: number,
  mu: number,
): [number, number, number] =>
  sampleLut(lut, (mu + 1) / 2, (radius - 1) / (recipe.topRatio - 1))

/** A Fibonacci sphere: N directions with no axis favored. */
function fibonacciSphere(count: number): [number, number, number][] {
  const golden = Math.PI * (3 - Math.sqrt(5))
  const out: [number, number, number][] = []
  for (let i = 0; i < count; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / count
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    const angle = golden * i
    out.push([Math.cos(angle) * ring, Math.sin(angle) * ring, z])
  }
  return out
}

/**
 * Hillaire's isotropic multiple-scattering table Ψ(r, μs), as ln Ψ.
 *
 * At each grid point: march a bundle of directions, accumulating the second
 * order of scattering (single-scattered light arriving from every direction,
 * isotropic phase) and the transfer factor f — how much of what scatters here
 * scatters *again*. The geometric series over orders collapses to
 * Ψ = L₂ / (1 − f). The main march then adds Ψ·σs at every sample: all orders
 * past the first for two multiplies and a lookup, which is the entire reason
 * twilight has a sky instead of an edge.
 *
 * The table holds the logarithm, and every reader takes `Math.exp` of a
 * bilinear read (`multipleScatteringAt`). Through twilight Ψ falls tenfold
 * every two degrees and a column of this table spans 11°, so blending the
 * values themselves draws each texel as its brighter neighbor, and the
 * zenith at −12° at three times what the same table says read geometrically.
 * Interpolating the logarithm is exact for an exponential falloff.
 */
export function bakeMultipleScattering(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
  /** Samples per direction; the default is converged, and a test refines it. */
  steps = MS_STEPS,
): ScatteringLut {
  const width = MULTI_SCATTER_WIDTH
  const height = MULTI_SCATTER_HEIGHT
  const data = new Float32Array(width * height * 4)
  const directions = fibonacciSphere(MS_DIRECTIONS)
  const ceiling = recipe.topRatio - 1
  const isotropic = 1 / (4 * Math.PI)

  for (let y = 0; y < height; y += 1) {
    const r = 1 + (y / (height - 1)) * ceiling
    for (let x = 0; x < width; x += 1) {
      const muSun = (x / (width - 1)) * 2 - 1
      const sun: [number, number, number] = [
        Math.sqrt(Math.max(0, 1 - muSun * muSun)),
        0,
        muSun,
      ]

      const luminance = [0, 0, 0]
      const transfer = [0, 0, 0]
      for (const direction of directions) {
        const muRay = direction[2]
        /*
         * From the ground row, a ray aimed down is already in the ground.
         * `distanceToSphere` answers its far side instead — the start is on
         * the sphere, so the near root is zero and not taken — and a march
         * past this line crosses the planet at the surface's density: a chord
         * of rock lit as if it were air, which grows Ψ at the ground sixfold
         * as the steps are refined. Same μ ≥ 0 guard as `transmittanceFrom`, for its rounding.
         */
        if (muRay < 0 && r <= 1) continue
        const ground = muRay < 0 ? distanceToSphere(r, muRay, 1) : Infinity
        const top = distanceToSphere(r, muRay, recipe.topRatio)
        const end = Math.min(ground, top)
        if (!Number.isFinite(end) || end <= 0) continue
        const perigee = muRay < 0 ? -r * muRay : 0

        const tau = [0, 0, 0]
        for (let i = 0; i < steps; i += 1) {
          const [s, step] = marchSample(i, steps, end, perigee)
          // Position in the plane spanned by zenith and the ray.
          const px = direction[0] * s
          const py = direction[1] * s
          const pz = r + direction[2] * s
          const radius = Math.sqrt(px * px + py * py + pz * pz)
          const { rayleigh, mie, ozone } = densities(radius - 1, recipe)
          const muSunHere =
            (px * sun[0] + py * sun[1] + pz * sun[2]) / Math.max(radius, 1e-6)
          const sunlight = transmittanceAt(
            transmittance,
            recipe,
            radius,
            muSunHere,
          )
          for (let c = 0; c < 3; c += 1) {
            const scatter =
              (recipe.betaRayleigh[c] as number) * rayleigh +
              (recipe.mieScatter[c] as number) * mie
            const extinction =
              (recipe.betaRayleigh[c] as number) * rayleigh +
              (recipe.mieExtinction[c] as number) * mie +
              (recipe.ozone[c] as number) * ozone
            const view = Math.exp(
              -((tau[c] as number) + extinction * step * 0.5),
            )
            luminance[c] =
              (luminance[c] as number) +
              view * scatter * isotropic * (sunlight[c] as number) * step
            transfer[c] = (transfer[c] as number) + view * scatter * step
            tau[c] = (tau[c] as number) + extinction * step
          }
        }
      }

      const index = (y * width + x) * 4
      for (let c = 0; c < 3; c += 1) {
        const secondOrder = (luminance[c] as number) / MS_DIRECTIONS
        const f = Math.min((transfer[c] as number) / MS_DIRECTIONS, 0.95)
        data[index + c] = Math.log(
          Math.max(secondOrder / (1 - f), MULTI_SCATTER_FLOOR),
        )
      }
      data[index + 3] = 1
    }
  }
  return { width, height, data }
}

/** Ψ at (r, μs) from the logarithmic table, interpolated geometrically. */
export function multipleScatteringAt(
  table: ScatteringLut,
  recipe: AtmosphereRecipe,
  radius: number,
  muSun: number,
): [number, number, number] {
  const height01 = Math.min(
    Math.max((radius - 1) / (recipe.topRatio - 1), 0),
    1,
  )
  const [r, g, b] = sampleLut(table, (muSun + 1) / 2, height01)
  return [Math.exp(r), Math.exp(g), Math.exp(b)]
}

/**
 * The sky straight overhead, in scene units per unit of the sun's color.
 *
 * The shell's own march along one ray — the zenith from `radius` planet radii
 * — with the sun `muSun` from overhead. Along a radial line every sample sees
 * the sun at the same cosine, so the column is one-dimensional and the sun's
 * transmittance is computed exactly rather than read from the table. Zero
 * above the air, and zero once the whole column is in the planet's shadow.
 *
 * What it is for is the one number the presentation needs about the sky an
 * observer is standing under: how bright the air in front of everything else
 * is. Enhanced's lift of the faint sky is measured against it.
 */
export function zenithSkyRadiance(
  recipe: AtmosphereRecipe,
  multiScatter: ScatteringLut,
  radius: number,
  muSun: number,
): [number, number, number] {
  const r = Math.max(radius, 1)
  const column = recipe.topRatio - r
  if (column <= 0) return [0, 0, 0]
  const g = AEROSOL_ASYMMETRY
  const phaseRayleigh = (3 / (16 * Math.PI)) * (1 + muSun * muSun)
  const phaseMie =
    (1 - g * g) /
    (4 * Math.PI) /
    Math.max(1 + g * g - 2 * g * muSun, 1e-4) ** 1.5
  const radiance: [number, number, number] = [0, 0, 0]
  const depth = [0, 0, 0]
  for (let i = 0; i < ZENITH_STEPS; i += 1) {
    const [offset, step] = marchSample(i, ZENITH_STEPS, column, 0)
    const at = r + offset
    const { rayleigh, mie, ozone } = densities(at - 1, recipe)
    const sunlight = transmittanceFrom(at, muSun, recipe)
    const psi = multipleScatteringAt(multiScatter, recipe, at, muSun)
    for (let c = 0; c < 3; c += 1) {
      const scatterRayleigh = (recipe.betaRayleigh[c] as number) * rayleigh
      const scatterMie = (recipe.mieScatter[c] as number) * mie
      const extinction =
        scatterRayleigh +
        (recipe.mieExtinction[c] as number) * mie +
        (recipe.ozone[c] as number) * ozone
      const view = Math.exp(-((depth[c] as number) + extinction * step * 0.5))
      const single =
        (scatterRayleigh * phaseRayleigh + scatterMie * phaseMie) *
        (sunlight[c] as number)
      const multiple = (psi[c] as number) * (scatterRayleigh + scatterMie)
      radiance[c] =
        (radiance[c] as number) +
        view * (single + multiple) * step * ATMOSPHERE_GAIN
      depth[c] = (depth[c] as number) + extinction * step
    }
  }
  return radiance
}

/**
 * What to draw a star's disk with, per channel, when the eye is inside the
 * air and the shell will then dim it by the path's mean transmittance.
 *
 * The shell composites gray — L + T̄·background — which is right for a sky of
 * faint things behind the air and wrong for the disk in two ways. It does not
 * redden: a sun on the horizon came through white. And under Enhanced, where
 * the disk is drawn at a calibrated eight times the surface white rather than
 * its physical fifty thousand, the full extinction takes it below its own
 * sky: through a dusty column at a 4.6° sun the disk was a brown spot in a
 * peach glow, the brightest thing in the scene drawn as the dimmest.
 *
 * So the disk arrives in the column's own color, at the column's luminance
 * raised to `compression` — the exponent that took the physical disk to the
 * drawn one, ln 8 over ln 53,000 for the Sun at 1 AU under Enhanced and 1 for
 * a photograph. The air dims the disk by the same law that put it on screen,
 * so it keeps its rank against the sky until it is physically level with it,
 * and it keeps its hue, because a physical disk through that column is that
 * color at any brightness the hue-preserving curve can show. Compressing each
 * channel instead bleached a 2° sun to 1 : 0.89 : 0.69. Zero once the planet
 * is in the way.
 *
 * What this returns is drawn *before* the shell divides it back down, so it
 * is the disk over the column's transmittance, and through the last degree or
 * two above a sea-level horizon that transmittance is 10⁻⁵ and smaller. The
 * scene's target is half-float, whose largest value is 65,504: uncapped, the
 * drawn disk overflows to infinity there, and the shell's extinction cannot
 * bring an infinity back. So the return is capped at `DISK_THROUGH_AIR_CEILING`, and
 * a sun that low dims faster than the law that drew it, in the column's own
 * color, until the ground takes it.
 */
export function diskThroughAir(
  recipe: AtmosphereRecipe,
  radius: number,
  mu: number,
  compression: number,
): [number, number, number] {
  const passed = transmittanceFrom(Math.max(radius, 1), mu, recipe)
  const mean = (passed[0] + passed[1] + passed[2]) / 3
  const luminance = 0.2126 * passed[0] + 0.7152 * passed[1] + 0.0722 * passed[2]
  if (mean <= 1e-12 || luminance <= 1e-12) return [0, 0, 0]
  const gain = Math.min(
    luminance ** (compression - 1) / mean,
    DISK_THROUGH_AIR_CEILING / luminance,
  )
  return [passed[0] * gain, passed[1] * gain, passed[2] * gain]
}

/**
 * The most `diskThroughAir` returns, in luminance: 2¹¹. At Enhanced's
 * calibrated eight that is 16,384 in the scene's half-float target, a quarter
 * of its range, which leaves the glare and the bloom summed over the disk room
 * to stay finite. The law holds above a column transmittance of 8·10⁻⁵ —
 * Earth's sun from sea level above about 2°.
 */
export const DISK_THROUGH_AIR_CEILING = 2048
