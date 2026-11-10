import { mieDroplets, diffractionShare } from './mieTable.ts'
import type { LevelSpec } from './weatherClimate.ts'
import { type CloudGenus, genusProfile } from './weatherScenario.ts'

/*
 * The genus table: what a cloud genus is, apart from where a weather puts
 * it. A phase class, how its water grows with height, its mean in-cloud
 * extinction, its droplets, its cell and its edge, and the thickness a layer
 * of it may have (phase 1 design §5.2).
 *
 * Unscaled throughout: a genus's `sigma` is the extinction a retrieval
 * reports, at `Q_ext` near 2, and what a transmittance is formed from is
 * `scaledExtinction` of it (§5.1). Arithmetic alone, so the frame's
 * derivation, the profile table's bake and the calibration read one table
 * in Node.
 *
 * **The extinction is the genus's, and the thickness is what yields.** A
 * genus's mean σ is the plan's measured figure (plan §5.1) and is held; what
 * the calibration against ISCCP-H moves is a regime's thickness, inside the
 * genus's range, and its cover. The ranges, the cells and the erosions are
 * named here so that calibration has one place to move them, and each says
 * where its present value comes from.
 */

/** What scatters: the droplets' Mie rows of the phase atlas, or the ice rows. */
export type GenusClass = 'droplets' | 'ice'

/**
 * How a genus's water grows over its base: adiabatically, adiabatically to
 * its mean and flat above, or not at all.
 */
export type GenusWater = 'adiabatic' | 'capped' | 'flat'

export interface GenusSpec {
  readonly class: GenusClass
  readonly water: GenusWater
  /** A level of this genus is cumuliform: its climate's convective share is 1. */
  readonly cumuliform: boolean
  /** Mean in-cloud extinction over a layer of it, unscaled, 1/m. */
  readonly sigma: number
  /** Effective radius at the layer's mean water, µm. */
  readonly radius: number
  /** The least and greatest thickness a regime may give a layer of it, meters. */
  readonly thickness: readonly [least: number, greatest: number]
  /** One Worley cell of the base noise, meters. */
  readonly cell: number
  /** How far the detail noise eats the edge, 0..1. */
  readonly erosion: number
}

/* ------------------------------------------------------------------------- */
/* Water                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The adiabatic water's growth with height over the base, kg/m³ per meter:
 * 2 g m⁻³ km⁻¹ (Wood 2009, plan §5.1).
 */
export const ADIABATIC_GROWTH = 2e-6
/** `z₀` of the sub-adiabatic factor `f_ad = z₀/(z₀ + z)`, meters (Wood 2009). */
export const ADIABATIC_SCALE = 500
/**
 * Droplets a cubic meter: the marine 74 cm⁻³ on every body (Wood 2000). The
 * continental 288 needs a land mask in the maps, which is phase 3's.
 */
export const DROPLET_NUMBER = 74e6
/** The droplet distribution's breadth `k`: 0.80 for marine stratocumulus, 0.67 polluted (Wood 2000). */
export const DROPLET_BREADTH = 0.8
/** kg/m³. */
const WATER_DENSITY = 1000
/**
 * The diffraction share `f_δ` of ice: crystals far larger than the
 * wavelength have `Q_ext` → 2, so half their extinction is the forward
 * peak. The ice rows' own table replaces it when it lands.
 */
export const ICE_DIFFRACTION_SHARE = 0.5

/**
 * Liquid water at `z` meters over the base, kg/m³:
 * `LWC = s·f_ad(z)·Γ_ad·z`, `s` the sub-adiabatic share.
 */
export function adiabaticWater(z: number, share = 1): number {
  if (!(z > 0)) return 0
  return (
    (share * ADIABATIC_GROWTH * z * ADIABATIC_SCALE) / (ADIABATIC_SCALE + z)
  )
}

/** The effective radius of `water` kg/m³ held by the marine droplets, µm: `(3·LWC/(4π·ρ_w·k·N))^⅓`. */
export function effectiveRadius(water: number): number {
  const volume =
    (3 * Math.max(0, water)) /
    (4 * Math.PI * WATER_DENSITY * DROPLET_BREADTH * DROPLET_NUMBER)
  return 1e6 * Math.cbrt(volume)
}

/** Extinction of `water` kg/m³ at its own effective radius, 1/m: `σ = 3·LWC/(2·ρ_w·r_e)`. */
export function waterExtinction(water: number): number {
  const radius = effectiveRadius(water) * 1e-6
  return radius > 0 ? (3 * water) / (2 * WATER_DENSITY * radius) : 0
}

/** The water whose extinction is `sigma`, kg/m³: `waterExtinction`'s inverse, since σ goes as LWC^⅔. */
function waterOf(sigma: number): number {
  const unit = waterExtinction(1e-3)
  return 1e-3 * Math.pow(Math.max(0, sigma) / unit, 1.5)
}

/** The droplets' effective radius in a cloud whose mean extinction is `sigma`, µm. */
function dropletRadius(sigma: number): number {
  return effectiveRadius(waterOf(sigma))
}

/* ------------------------------------------------------------------------- */
/* The table                                                                  */
/* ------------------------------------------------------------------------- */

const droplets = (
  water: GenusWater,
  cumuliform: boolean,
  sigma: number,
  thickness: readonly [number, number],
  cell: number,
  erosion: number,
): GenusSpec => ({
  class: 'droplets',
  water,
  cumuliform,
  sigma,
  radius: dropletRadius(sigma),
  thickness,
  cell,
  erosion,
})

/*
 * Each figure's source. σ is plan §5.1's, km⁻¹ over 1000, the marine figure
 * where the plan gives two (the droplets are marine on every body), and the
 * middle of a range where it gives one. The thickness ranges are the
 * design's §5.2 table. The cells and erosions are the placeholder regimes'
 * (`WEATHER_SCENARIOS`), which phase 0's measurements priced: altostratus,
 * which no regime holds, takes stratus's. A droplet genus's radius is not
 * an input: it is the marine droplets' radius at the water that gives the
 * genus's σ, so a genus whose σ moves keeps its droplets consistent.
 */
export const GENUS_TABLE: Readonly<Record<CloudGenus, GenusSpec>> =
  /*@__PURE__*/ Object.freeze({
    stratus: droplets('capped', false, 0.04, [200, 700], 3000, 0.2),
    stratocumulus: droplets('adiabatic', false, 0.035, [200, 500], 1800, 0.4),
    cumulus: droplets('adiabatic', true, 0.052, [200, 1500], 1200, 0.6),
    // 20–40 km⁻¹ in the plan.
    altostratus: droplets('flat', false, 0.03, [300, 1500], 3000, 0.2),
    // 20–40 km⁻¹ in the plan.
    altocumulus: droplets('adiabatic', false, 0.03, [100, 400], 1000, 0.5),
    // "To the level's top": the anvil regime's 14 km column is the one a
    // regime draws, from a 1 km base to a tropical tropopause near 15 km.
    cumulonimbus: droplets('adiabatic', true, 0.093, [14000, 14000], 8000, 0.4),
    // "To the ground": the fog regime's 150 m.
    fog: droplets('flat', false, 0.0081, [150, 150], 500, 0.2),
    cirrus: {
      class: 'ice',
      water: 'flat',
      cumuliform: false,
      // 0.05–0.5 km⁻¹ in the plan: the cirrus-over-cumulus regime's 0.2.
      sigma: 0.0002,
      // The regime's 32 µm, under the plan's 34–92 µm for ice r_e; the ice
      // rows' own table sets it when it lands.
      radius: 32,
      thickness: [500, 2000],
      cell: 5000,
      erosion: 0.3,
    },
  } satisfies Record<CloudGenus, GenusSpec>)

/* ------------------------------------------------------------------------- */
/* Shapes with height                                                         */
/* ------------------------------------------------------------------------- */

/** ∫₀^a z₀z/(z₀ + z) dz. */
const adiabaticIntegral = (a: number): number =>
  ADIABATIC_SCALE * (a - ADIABATIC_SCALE * Math.log1p(a / ADIABATIC_SCALE))

/** z₀z/(z₀ + z): the adiabatic water's shape, with Γ_ad and s left out. */
const adiabaticShape = (z: number): number =>
  (ADIABATIC_SCALE * z) / (ADIABATIC_SCALE + z)

/**
 * The water's growth over a level of `thickness` meters, `w(h)`, normalized
 * to a mean of one over the level: `h01` is 0 at the base and 1 at the top,
 * and is clamped there. One through a flat genus. An adiabatic genus's
 * water is zero at its base and greatest at its top; a capped genus's grows
 * adiabatically until it reaches its own mean and holds it.
 */
export function genusWater(
  genus: CloudGenus,
  h01: number,
  thickness: number,
): number {
  const { water } = GENUS_TABLE[genus]
  if (water === 'flat' || !(thickness > 0)) return 1
  const z = Math.min(1, Math.max(0, h01)) * thickness
  const mean = adiabaticIntegral(thickness) / thickness
  if (water === 'adiabatic') return adiabaticShape(z) / mean
  // The height where the adiabatic water reaches its mean, which is inside
  // the level because the shape is increasing and the mean is under its top.
  const reach = (mean * ADIABATIC_SCALE) / (ADIABATIC_SCALE - mean)
  const capped =
    (adiabaticIntegral(reach) + (thickness - reach) * mean) / thickness
  return Math.min(adiabaticShape(z), mean) / capped
}

/**
 * The extinction's shape with height, `σ(h)/σ_ref`: the genus's edge, its
 * rise from the base and fall to the top, times `w(h)^⅔`. Zero outside the
 * level.
 */
export function genusExtinctionShape(
  genus: CloudGenus,
  h01: number,
  thickness: number,
): number {
  const edge = genusProfile(genus, h01)
  return edge === 0 ? 0 : edge * genusWater(genus, h01, thickness) ** (2 / 3)
}

/** The radius's shape with height, `r_e(h)/r_ref = w(h)^⅓`; one through ice, whose crystals do not grow by this law. */
export function genusRadiusShape(
  genus: CloudGenus,
  h01: number,
  thickness: number,
): number {
  if (GENUS_TABLE[genus].class === 'ice') return 1
  return genusWater(genus, h01, thickness) ** (1 / 3)
}

/** Midpoint steps the means over a level are taken with: 2 × 10⁻⁶ of a smoothstep's integral. */
const MEAN_STEPS = 1024

/** The mean of `genusExtinctionShape` over a level of `thickness`: §5.6's p̄. */
export function genusShapeMean(genus: CloudGenus, thickness: number): number {
  let sum = 0
  for (let i = 0; i < MEAN_STEPS; i += 1)
    sum += genusExtinctionShape(genus, (i + 0.5) / MEAN_STEPS, thickness)
  return sum / MEAN_STEPS
}

/**
 * Unscaled extinction at `h01` of a layer of `genus` `thickness` thick,
 * 1/m: the shape scaled so its mean over the layer is the genus's σ.
 */
export function genusExtinction(
  genus: CloudGenus,
  h01: number,
  thickness: number,
): number {
  const mean = genusShapeMean(genus, thickness)
  if (!(mean > 0)) return 0
  return (
    (GENUS_TABLE[genus].sigma * genusExtinctionShape(genus, h01, thickness)) /
    mean
  )
}

/** The effective radius at `h01` of a layer of `genus`, µm. */
export function genusRadius(
  genus: CloudGenus,
  h01: number,
  thickness: number,
): number {
  return GENUS_TABLE[genus].radius * genusRadiusShape(genus, h01, thickness)
}

/**
 * `σ′ = (1 − f_δ)·σ`: the extinction every transmittance is formed from,
 * with the droplets' diffraction half taken out as light that goes on.
 * `share` is `f_δ`, `diffractionShare` of the phase table at the radius.
 */
export function scaledExtinction(sigma: number, share: number): number {
  return (1 - share) * sigma
}

/** `f_δ` of a genus's class at a radius, µm: the droplets' Mie table's `1/Q_ext`, or ice's half. */
export function genusDiffractionShare(
  genus: CloudGenus,
  radius: number,
): number {
  return GENUS_TABLE[genus].class === 'ice'
    ? ICE_DIFFRACTION_SHARE
    : diffractionShare(dropletTable(), radius)
}

let droplet: ReturnType<typeof mieDroplets> | null = null
const dropletTable = (): ReturnType<typeof mieDroplets> =>
  (droplet ??= mieDroplets())

/* ------------------------------------------------------------------------- */
/* A level's profile table                                                    */
/* ------------------------------------------------------------------------- */

/** Heights a level's table holds: h01 = i/63, so both ends of the level are texels. */
export const PROFILE_HEIGHTS = 64
/** Rows a level's table holds: v = j/7 from its stratiform genus to its cumuliform one. */
export const PROFILE_ROWS = 8

/**
 * A level's profile as the field reads it: one table of 64 heights by eight
 * rows of RGBA8, and the numbers it is normalized by.
 *
 * Row j blends the level's two genera at a convective share of j/7, so one
 * bilinear read at row 7·v is the profile of a sample whose share is v. Each
 * channel is a share of the level's own greatest value, never over one:
 *
 * | Channel | Holds                                                         |
 * | ------- | ------------------------------------------------------------- |
 * | R       | Unscaled extinction over `sigma`, the level's greatest        |
 * | G       | R's mean over the level: the density an unresolved cell holds |
 * | B       | The share of the row's column above the height                |
 * | A       | The effective radius over `radius`, the level's greatest      |
 *
 * R is what the recipe thresholds the base noise against, as phase 0's
 * profile was, so it must not pass one: the noise reaches one, and a shape
 * over one would put cloud where the cover is zero.
 */
export interface LevelProfile {
  /** The level's greatest unscaled extinction over its rows and heights, 1/m. */
  readonly sigma: number
  /** The same, scaled at `radius`: what R is a share of, for a transmittance. */
  readonly scaled: number
  /** The level's greatest effective radius, µm. */
  readonly radius: number
  /** The base noise's cell, meters, and the detail's erosion: the cumuliform genus's. */
  readonly cell: number
  readonly erosion: number
  /** RGBA8, `[row][height][channel]`. */
  readonly texels: Uint8Array
}

/** The profile's two ends: the genera the level blends, by the convective share. */
function rowGenera(level: LevelSpec): readonly [CloudGenus, CloudGenus] {
  const { stratiform, cumuliform } = level
  if (GENUS_TABLE[stratiform].class !== GENUS_TABLE[cumuliform].class)
    throw new Error(
      `weatherGenus: a level blends ${stratiform} and ${cumuliform}, which scatter as different classes`,
    )
  return [stratiform, cumuliform]
}

/** Subdivisions of a texel the column's share is integrated over. */
const COLUMN_STEPS = 16

function buildProfile(level: LevelSpec): LevelProfile {
  const thickness = Math.max(level.top - level.base, 1)
  const [low, high] = rowGenera(level)
  const means = [
    genusShapeMean(low, thickness),
    genusShapeMean(high, thickness),
  ]
  const at = (genus: CloudGenus, mean: number, h01: number) => ({
    sigma:
      mean > 0
        ? (GENUS_TABLE[genus].sigma *
            genusExtinctionShape(genus, h01, thickness)) /
          mean
        : 0,
    radius: genusRadius(genus, h01, thickness),
  })
  const sample = (v: number, h01: number) => {
    const a = at(low, means[0]!, h01)
    const b = at(high, means[1]!, h01)
    return {
      sigma: a.sigma + (b.sigma - a.sigma) * v,
      radius: a.radius + (b.radius - a.radius) * v,
    }
  }
  // The greatest of each over a fine grid, so a byte never clips.
  const fine = (PROFILE_HEIGHTS - 1) * COLUMN_STEPS
  let sigma = 0
  let radius = 0
  for (let j = 0; j < PROFILE_ROWS; j += 1)
    for (let i = 0; i <= fine; i += 1) {
      const s = sample(j / (PROFILE_ROWS - 1), i / fine)
      sigma = Math.max(sigma, s.sigma)
      radius = Math.max(radius, s.radius)
    }
  const texels = new Uint8Array(PROFILE_ROWS * PROFILE_HEIGHTS * 4)
  const byte = (x: number): number =>
    Math.round(255 * Math.min(1, Math.max(0, x)))
  for (let j = 0; j < PROFILE_ROWS; j += 1) {
    const v = j / (PROFILE_ROWS - 1)
    // The row's extinction share by midpoint over the fine grid, its total
    // and what lies above each texel.
    const above = new Float64Array(PROFILE_HEIGHTS)
    let total = 0
    for (let i = fine - 1; i >= 0; i -= 1) {
      total += sample(v, (i + 0.5) / fine).sigma
      if (i % COLUMN_STEPS === 0) above[i / COLUMN_STEPS] = total
    }
    const mean = sigma > 0 ? total / fine / sigma : 0
    for (let i = 0; i < PROFILE_HEIGHTS; i += 1) {
      const s = sample(v, i / (PROFILE_HEIGHTS - 1))
      const at = (j * PROFILE_HEIGHTS + i) * 4
      texels[at] = byte(sigma > 0 ? s.sigma / sigma : 0)
      texels[at + 1] = byte(mean)
      texels[at + 2] = byte(total > 0 ? above[i]! / total : 0)
      texels[at + 3] = byte(radius > 0 ? s.radius / radius : 0)
    }
  }
  return {
    sigma,
    scaled: scaledExtinction(sigma, genusDiffractionShare(high, radius)),
    radius,
    cell: GENUS_TABLE[high].cell,
    erosion: GENUS_TABLE[high].erosion,
    texels,
  }
}

/*
 * A level's table is a function of its four members, and the bodies a
 * session visits have a few levels each, so tables are kept by those
 * members. The bound only keeps a long session's map from growing: a table
 * dropped is built again, identically, at the next read.
 */
const PROFILES = new Map<string, LevelProfile>()
const PROFILES_HELD = 256

/** A level's profile table, built once for its members. */
export function levelProfile(level: LevelSpec): LevelProfile {
  const key = `${level.base}|${level.top}|${level.stratiform}|${level.cumuliform}`
  let profile = PROFILES.get(key)
  if (profile === undefined) {
    if (PROFILES.size >= PROFILES_HELD) PROFILES.clear()
    profile = buildProfile(level)
    PROFILES.set(key, profile)
  }
  return profile
}

/** The table's four channels at `h01` and convective share `v`, read bilinearly with clamped edges, each in [0, 1]. */
export function readLevelProfile(
  profile: LevelProfile,
  h01: number,
  v: number,
): readonly [number, number, number, number] {
  const x = Math.min(1, Math.max(0, h01)) * (PROFILE_HEIGHTS - 1)
  const y = Math.min(1, Math.max(0, v)) * (PROFILE_ROWS - 1)
  const i0 = Math.min(PROFILE_HEIGHTS - 2, Math.floor(x))
  const j0 = Math.min(PROFILE_ROWS - 2, Math.floor(y))
  const fx = x - i0
  const fy = y - j0
  const { texels } = profile
  const texel = (i: number, j: number, c: number): number =>
    texels[(j * PROFILE_HEIGHTS + i) * 4 + c]!
  const channel = (c: number): number => {
    const a = texel(i0, j0, c) + (texel(i0 + 1, j0, c) - texel(i0, j0, c)) * fx
    const b =
      texel(i0, j0 + 1, c) +
      (texel(i0 + 1, j0 + 1, c) - texel(i0, j0 + 1, c)) * fx
    return (a + (b - a) * fy) / 255
  }
  return [channel(0), channel(1), channel(2), channel(3)]
}
