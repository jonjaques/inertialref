import {
  AEROSOL_ASYMMETRY,
  AEROSOL_FORWARD_PEAK,
  type AtmosphereRecipe,
  MULTI_SCATTER_FLOOR,
  marchSample,
  type ScatteringLut,
} from './atmosphere.ts'

/*
 * The sky's light on a cloud, as a table a body's air bakes beside its
 * transmittance and its multiple scattering: for a sun's cosine and a
 * height, the sky's mean radiance and the difference between the irradiance
 * of its two sides, up against down and sunward against away (design §5.6).
 *
 * Three blocks of 34 columns over the sun's cosine, a guard column each side
 * of a block's 32 so a bilinear read never blends two blocks, and 16 rows
 * laid evenly in the optical depth of the air below them (`skyRowsOf`), from
 * the datum to just under the air's top:
 *
 *   block 0  ln L̄        the sky's mean radiance per band
 *   block 1  Δ           the upper side's irradiance less the lower's, over π·L̄
 *   block 2  Δ_s         the sunward side's less the far side's, over π·L̄
 *
 * and in block k's alpha band k's `c`, how far the upper side's irradiance
 * stands from the one the first two blocks imply (`SkyTableMoments.upper`).
 *
 * Radiance is per unit of the sun's irradiance and before `ATMOSPHERE_GAIN`,
 * the unit the cloud's first order is gathered in, so the composite's one
 * gain lights both.
 *
 * Irradiance and not a hemisphere's mean radiance, because a diffusion
 * boundary takes each side's irradiance: under a sky uniform above and dark
 * below, Δ = 2 and a thick deck's top returns the sky's radiance exactly,
 * where the hemisphere's mean returns 0.875 of it. The mean is a logarithm
 * for the reason Ψ is one: through twilight it falls tenfold in two degrees,
 * and blending values across a column draws each texel as its brighter
 * neighbor. Δ and Δ_s are ratios bounded by ±4 and blend as values.
 *
 * Each grid point is a quadrature of the air's own march over the sphere
 * (`skyDirections`): single scattering through the transmittance
 * table, Ψ for every order past it, and where a direction meets the ground,
 * a Lambert ground at `SKY_GROUND_ALBEDO` under the clear sky's own light.
 * The march is `zenithSkyRadiance`'s along any direction, so the cloud and
 * the air agree about the sky (`skyIrradiance.test.ts` holds the two equal
 * at the zenith).
 */

/** Columns a block holds, and the guard column each side of it. */
export const SKY_BLOCK_COLUMNS = 32
export const SKY_BLOCK_GUARD = 1
export const SKY_BLOCKS = 3
export const SKY_TABLE_WIDTH =
  SKY_BLOCKS * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD)
export const SKY_TABLE_HEIGHT = 16

/**
 * Where the table's rows stand: the row coordinate, 0 at the datum and 1 at
 * the last row, at a height `u` given as a share of the air's depth, is
 *
 *   saturate(a·(1 − e^(−b·u)) + c·(1 − e^(−d·u)))
 *
 * for `[a, b, c, d]`: the gas's and the haze's columns under `u`, each its
 * vertical optical depth over its own scale height, over the two columns
 * under the last row. The bake places row `y` where this is `y/15`, by
 * bisection, and the read forms it from the same four numbers, so the read
 * adds no fetch.
 *
 * Laid evenly in height the rows stand 6.7 km apart on Earth, and every
 * cloud under 6 km reads its sky from a blend of the first two: the mean
 * radiance 16% off and the upper side's irradiance up to 60%, at any sun.
 * The sky changes with the air above a point, and the air is crowded into
 * its first scale heights, so the rows are crowded there too (ruling 007).
 * The form is not the true optical depth, which also holds ozone, the
 * detached layer and the fade to the top: it need only be monotone, crowd
 * the rows as the optical depth does, and be one function at the bake and
 * at the read. Each column is weighed by its mean over the three bands.
 */
export type SkyRows = readonly [number, number, number, number]

/**
 * The last row stands where the two columns leave the whole air's by one
 * part in `SKY_TOP_SHARE`, 29.6 km on Earth and 36.9 km on the cornerstones'
 * world, and not at the top, where the sky from above is dark and the
 * irradiance from it zero. A read over the last row holds it: no clamp to
 * the row under it, which stands at 15.6 km on Earth.
 */
export const SKY_TOP_SHARE = 64

/** The rows of a table with no sky: every height reads row 0, which holds what every row holds. */
export const NO_SKY_ROWS: SkyRows = [0, 0, 0, 0]

/** The sky table: its texels, and where its rows stand (`skyRowsOf`). */
export interface SkyTable extends ScatteringLut {
  readonly rows: SkyRows
}

/**
 * The rows of an air whose gas and haze hold no column, as a scale height
 * in the air's depths: one column so tall that the rows stand within 1% of
 * evenly in height. Such an air still has a sky, lit by its detached layer
 * and its ground, so its rows must still part; the same closed form keeps
 * the bake and both readers on one function.
 */
export const SKY_EVEN_SCALE = 64

/** The rows for an air: its two columns, weighed as `SkyRows` says. */
export function skyRowsOf(recipe: AtmosphereRecipe): SkyRows {
  const ceiling = recipe.topRatio - 1
  if (!(ceiling > 0)) return NO_SKY_ROWS
  const mean = (v: readonly number[]) =>
    ((v[0] as number) + (v[1] as number) + (v[2] as number)) / 3
  const gas = mean(recipe.betaRayleigh) * recipe.hRayleigh
  const haze = mean(recipe.mieExtinction) * recipe.hMie
  const b = ceiling / recipe.hRayleigh
  const d = ceiling / recipe.hMie
  const whole = gas * -Math.expm1(-b) + haze * -Math.expm1(-d)
  if (!(whole > 0)) {
    const even = 1 / SKY_EVEN_SCALE
    return [1 / (-Math.expm1(-even) * (1 - 1 / SKY_TOP_SHARE)), even, 0, 0]
  }
  const last = whole * (1 - 1 / SKY_TOP_SHARE)
  return [gas / last, b, haze / last, d]
}

/** The row coordinate, 0 to 1, at a height given as a share of the air's depth. */
export function skyRowAt(rows: SkyRows, height01: number): number {
  const [a, b, c, d] = rows
  const u = Math.min(Math.max(height01, 0), 1)
  const v = a * -Math.expm1(-b * u) + c * -Math.expm1(-d * u)
  return Math.min(Math.max(v, 0), 1)
}

/**
 * Each row's height as a share of the air's depth: where `skyRowAt` reads
 * `y/15`, by bisection. Row 0 is the datum; the last is under the top.
 */
export function skyRowShares(rows: SkyRows): readonly number[] {
  return Array.from({ length: SKY_TABLE_HEIGHT }, (_, y) => {
    const target = y / (SKY_TABLE_HEIGHT - 1)
    if (y === 0) return 0
    let low = 0
    let high = 1
    for (let pass = 0; pass < 60; pass += 1) {
      const middle = (low + high) / 2
      if (skyRowAt(rows, middle) < target) low = middle
      else high = middle
    }
    return (low + high) / 2
  })
}

/**
 * The ground the sky is lit over: a Lambert albedo, one for every body. The
 * air's bake carries a haze, a ratio and heights and no albedo, and phase 2
 * replaces the constant when it couples the ground's light to the deck over
 * it.
 */
export const SKY_GROUND_ALBEDO = 0.15

/**
 * The quadrature a texel is baked with: `SKY_ABOVE` heights over the
 * horizon and `SKY_BELOW` under it, by `SKY_AZIMUTHS` azimuths over the half
 * of the sky on one side of the sun's vertical plane, which mirrors the
 * other: 180 marched directions standing for 360. See `skyDirections` for
 * why the heights split at the horizon.
 *
 * Against 2,016 directions on Earth's air, at three suns and three cloud
 * heights, it holds L̄ to 0.92% and Δ and Δ_s to 0.005 and 0.008
 * (`skyIrradiance.test.ts`), and the bake costs about 1.2 times the
 * transmittance and Ψ together, in Node on the Mac mini (Mac18,5, Apple
 * M6). Eight azimuths miss the aerosol's forward lobe under a low sun, Δ_s
 * by 0.016; sixteen heights over the horizon buy L̄ 0.2% for a quarter
 * more time.
 */
export const SKY_ABOVE = 12
export const SKY_BELOW = 6
export const SKY_AZIMUTHS = 10
/**
 * Samples along each direction, crowded toward its densest air: as many as
 * Ψ's bake takes, so the table and the air's multiple scattering are one
 * march.
 */
export const SKY_STEPS = 16

/** A value per band, in `AIR_BANDS`' order. */
export type Bands = readonly [number, number, number]

/** The sky at one point, per band: the table's three blocks, decoded. */
export interface SkyMoments {
  /** L̄: the mean radiance over the whole sphere, per unit of the sun's irradiance. */
  readonly mean: Bands
  /** Δ: (E_up − E_down)/(π·L̄). */
  readonly up: Bands
  /** Δ_s: (E_sunward − E_away)/(π·L̄), across a vertical face turned to the sun's azimuth. */
  readonly sunward: Bands
}

/**
 * The sky's moments as the table holds them: the three blocks and the
 * alphas' fourth number, per band.
 */
export interface SkyTableMoments extends SkyMoments {
  /**
   * c = E_above/(π·L̄) − (1 + Δ/2): the upper side's irradiance less the
   * one a sky linear in direction with this L̄ and Δ would give it, over
   * π·L̄. The air's sky is brightest at its horizon, so the linear sky
   * misjudges each side of a thick deck by 2% to over 200% (ruling 007);
   * with `c` the upper side is exact, and the lower is
   * π·L̄·(1 − Δ/2 + c) by Δ's definition. Zero where L̄ is at the floor.
   */
  readonly upper: Bands
}

/** What the sky's march reads: the air's recipe and its own two tables. */
export interface SkyAir {
  readonly recipe: AtmosphereRecipe
  readonly transmittance: ScatteringLut
  readonly multiScatter: ScatteringLut
}

/** How a quadrature is taken: directions over the sphere, and samples along each. */
export interface SkyQuadrature {
  /** Heights over the horizon, heights under it, and azimuths over a half circle. */
  readonly above: number
  readonly below: number
  readonly azimuths: number
  readonly steps: number
  /**
   * The sun's transmittance from a radius along a zenith cosine. The
   * transmittance table by default; a test hands `transmittanceFrom` to
   * hold the march to `zenithSkyRadiance`, which marches the sun exactly.
   */
  readonly sunlight?: (radius: number, mu: number) => Bands
}

const DEFAULT_QUADRATURE: SkyQuadrature = {
  above: SKY_ABOVE,
  below: SKY_BELOW,
  azimuths: SKY_AZIMUTHS,
  steps: SKY_STEPS,
}

/**
 * The air's densities at height `h` over the datum: `densities` in
 * `atmosphere.ts`, which that module keeps private. Two copies of one law
 * drift, so the test that holds this march equal to `zenithSkyRadiance`
 * holds this function to that one.
 */
function densities(
  h: number,
  recipe: AtmosphereRecipe,
): { rayleigh: number; mie: number; ozone: number; detached: number } {
  const ceiling = recipe.topRatio - 1
  const fade = Math.max(0, 1 - h / ceiling)
  const ozone = tent(h, recipe.ozonePeak, recipe.ozoneHalfWidth)
  const detached = tent(h, recipe.detachedPeak, recipe.detachedHalfWidth)
  if (fade === 0 || h < 0) {
    if (h < 0)
      return {
        rayleigh: fade > 0 ? 1 : 0,
        mie: fade > 0 ? 1 : 0,
        ozone,
        detached,
      }
    return { rayleigh: 0, mie: 0, ozone, detached }
  }
  return {
    rayleigh: Math.exp(-h / recipe.hRayleigh) * fade,
    mie: Math.exp(-h / recipe.hMie) * fade,
    ozone,
    detached,
  }
}

function tent(h: number, peak: number, halfWidth: number): number {
  return Math.max(0, 1 - Math.abs(h - peak) / Math.max(halfWidth, 1e-9))
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

/** Gauss–Legendre nodes and weights on [0, 1], by Newton's method on Pₙ. */
function gaussLegendre(n: number): {
  readonly nodes: Float64Array
  readonly weights: Float64Array
} {
  const nodes = new Float64Array(n)
  const weights = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    let x = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5))
    let slope = 1
    for (let pass = 0; pass < 100; pass += 1) {
      let p0 = 1
      let p1 = x
      for (let k = 2; k <= n; k += 1) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
        p0 = p1
        p1 = p2
      }
      const value = n === 1 ? x : p1
      const previous = n === 1 ? 1 : p0
      slope = (n * (x * value - previous)) / (x * x - 1)
      const next = x - value / slope
      const done = Math.abs(next - x) < 1e-15
      x = next
      if (done) break
    }
    nodes[i] = (1 - x) / 2
    weights[i] = 1 / ((1 - x * x) * slope * slope)
  }
  return { nodes, weights }
}

/**
 * The directions a quadrature at radius `r` takes, as (x, y, z, weight):
 * z up, the sun's azimuth +x, the weights solid angle summing to 4π.
 *
 * The sky is not smooth where the ray stops meeting the ground. From any
 * height the brightest light is the band just over the horizon, a ray that
 * grazes the densest air, and under it the ray ends on the ground; from the
 * top of the air under a set sun that band is nearly all the light there
 * is. A Fibonacci sphere lands its directions on that band by chance, and
 * at the top of Earth's air at −8.6° its mean moved 30% between 2,000
 * directions and 4,000. So the heights split at the horizon,
 * z_h = −√(1 − 1/r²), and each side is Gauss–Legendre in w with
 * z = z_h ± (end − z_h)·w², crowded toward z_h quadratically, as a march is
 * toward its perigee. A sky polynomial in z on each side is then integrated
 * exactly: a sky uniform above the datum's horizon and dark below gives
 * Δ = 2 to rounding.
 *
 * In azimuth the sky is smooth and periodic, which the midpoint rule
 * integrates spectrally, and it mirrors across the sun's vertical plane, so
 * the azimuths cover y ≥ 0 and weigh twice.
 */
export function skyDirections(
  r: number,
  quadrature: Pick<SkyQuadrature, 'above' | 'below' | 'azimuths'>,
): Float64Array {
  const horizon = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)))
  const { above, below, azimuths } = quadrature
  const out = new Float64Array((above + below) * azimuths * 4)
  const arc = Math.PI / azimuths
  let k = 0
  const side = (count: number, end: number): void => {
    const { nodes, weights } = gaussLegendre(count)
    const span = end - horizon
    for (let i = 0; i < count; i += 1) {
      const w = nodes[i] as number
      const z = horizon + span * w * w
      const dz = Math.abs(span) * 2 * w * (weights[i] as number)
      const ring = Math.sqrt(Math.max(0, 1 - z * z))
      for (let j = 0; j < azimuths; j += 1) {
        const phi = (j + 0.5) * arc
        out[k] = Math.cos(phi) * ring
        out[k + 1] = Math.sin(phi) * ring
        out[k + 2] = z
        out[k + 3] = 2 * dz * arc
        k += 4
      }
    }
  }
  side(above, 1)
  side(below, -1)
  return out
}

/**
 * Sums over a quadrature, per sun and band: the radiance's weight, its
 * first moments along z and along x, and the irradiance from above and from
 * the sun's side alone, fifteen numbers a sun.
 */
type Sums = Float64Array
const SUMS = 15

function addInto(
  sums: Sums,
  at: number,
  light: readonly number[],
  x: number,
  z: number,
  weight: number,
): void {
  for (let c = 0; c < 3; c += 1) {
    const l = (light[c] as number) * weight
    const k = at * SUMS + c * 5
    sums[k] = (sums[k] as number) + l
    sums[k + 1] = (sums[k + 1] as number) + l * z
    sums[k + 2] = (sums[k + 2] as number) + l * x
    if (z > 0) sums[k + 3] = (sums[k + 3] as number) + l * z
    if (x > 0) sums[k + 4] = (sums[k + 4] as number) + l * x
  }
}

/**
 * The moments from a sun's sums. Each difference is four times the
 * radiance's first moment over its mean: E_up − E_down = Σ L·z·w, and
 * π·L̄ = π·Σ L·w/4π. A sky with no light has no difference between its
 * sides, so Δ and Δ_s are zero where L̄ is under `MULTI_SCATTER_FLOOR`, and
 * L̄ is held at it.
 */
function momentsFrom(sums: Sums, at: number): SkyTableMoments {
  const band = (c: number) => {
    const k = at * SUMS + c * 5
    const total = sums[k] as number
    const mean = total / (4 * Math.PI)
    if (!(mean > MULTI_SCATTER_FLOOR))
      return { mean: MULTI_SCATTER_FLOOR, up: 0, sunward: 0, upper: 0 }
    const up = (4 * (sums[k + 1] as number)) / total
    return {
      mean,
      up,
      sunward: (4 * (sums[k + 2] as number)) / total,
      // π·L̄ is total/4.
      upper: (4 * (sums[k + 3] as number)) / total - (1 + up / 2),
    }
  }
  const [r, g, b] = [band(0), band(1), band(2)]
  return {
    mean: [r.mean, g.mean, b.mean],
    up: [r.up, g.up, b.up],
    sunward: [r.sunward, g.sunward, b.sunward],
    upper: [r.upper, g.upper, b.upper],
  }
}

/**
 * The moments of a sky given as radiance along each direction: `radiance`
 * fills `out` with the light arriving from (x, y, z), z up and the sun's
 * azimuth +x, and `directions` is `skyDirections`' (x, y, z, weight).
 */
export function skyMomentsOf(
  directions: Float64Array,
  radiance: (x: number, y: number, z: number, out: number[]) => void,
): SkyTableMoments {
  const sums: Sums = new Float64Array(SUMS)
  const light = [0, 0, 0]
  for (let i = 0; i < directions.length; i += 4) {
    const x = directions[i] as number
    const z = directions[i + 2] as number
    radiance(x, directions[i + 1] as number, z, light)
    addInto(sums, 0, light, x, z, directions[i + 3] as number)
  }
  return momentsFrom(sums, 0)
}

/** The ground's light at the sun cosines of the table's columns. */
interface SkyGround {
  /** Radiance per band, per unit of the sun's irradiance, at each column. */
  readonly radiance: Float64Array
}

/**
 * One of the air's tables as the march reads it: bilinear, as `sampleLut`
 * reads it, and exponentiated where the table holds a logarithm, as
 * `multipleScatteringAt` reads Ψ. A read is split in two, because a
 * sample's radius is fixed under all 32 suns and only its sun's cosine
 * moves: `rowOf` blends the sample's two rows' places once, and `readRow`
 * reads across the columns once a sun. The reads were a third of the bake
 * when each did both.
 */
interface AirTable {
  readonly lut: ScatteringLut
  readonly ceiling: number
  readonly logarithm: boolean
}

/** Writes the sample's row places at `buffer[at..at+2]`: the two rows' offsets and the blend. */
function rowOf(
  table: AirTable,
  radius: number,
  buffer: Float64Array,
  at: number,
): void {
  const { width, height } = table.lut
  const v =
    Math.min(Math.max((radius - 1) / table.ceiling, 0), 1) * (height - 1)
  const y0 = Math.floor(v)
  const y1 = Math.min(y0 + 1, height - 1)
  buffer[at] = y0 * width * 4
  buffer[at + 1] = y1 * width * 4
  buffer[at + 2] = v - y0
}

/** The table at a sun's cosine `mu`, on the row places `rowOf` wrote, into `out`. */
function readRow(
  table: AirTable,
  buffer: Float64Array,
  at: number,
  mu: number,
  out: number[],
): void {
  const { width, data } = table.lut
  const u = Math.min(Math.max((mu + 1) / 2, 0), 1) * (width - 1)
  const x0 = Math.floor(u)
  const fx = u - x0
  const step = x0 < width - 1 ? 4 : 0
  const low = (buffer[at] as number) + x0 * 4
  const high = (buffer[at + 1] as number) + x0 * 4
  const fy = buffer[at + 2] as number
  for (let k = 0; k < 3; k += 1) {
    const a = data[low + k] as number
    const b = data[low + step + k] as number
    const c = data[high + k] as number
    const d = data[high + step + k] as number
    const value = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
    out[k] = table.logarithm ? Math.exp(value) : value
  }
}

/**
 * The march's two reads of the air: the sun's transmittance, and Ψ, and
 * `exact` where a test marches the sun in place of reading its table.
 */
interface SkyReads {
  readonly transmittance: AirTable
  readonly psi: AirTable
  readonly exact: ((radius: number, mu: number) => Bands) | undefined
}

function readsOf(air: SkyAir, quadrature: SkyQuadrature): SkyReads {
  const ceiling = air.recipe.topRatio - 1
  return {
    transmittance: { lut: air.transmittance, ceiling, logarithm: false },
    psi: { lut: air.multiScatter, ceiling, logarithm: true },
    exact: quadrature.sunlight,
  }
}

/** The sun's transmittance at the datum under a sun at cosine `mu`, into `out`. */
function sunlightAtDatum(reads: SkyReads, mu: number, out: number[]): void {
  if (reads.exact !== undefined) {
    const [r, g, b] = reads.exact(1, mu)
    out[0] = r
    out[1] = g
    out[2] = b
    return
  }
  const places = new Float64Array(3)
  rowOf(reads.transmittance, 1, places, 0)
  readRow(reads.transmittance, places, 0, mu, out)
}

/** The ground's radiance under a sun at cosine `mu`, read between the columns. */
function groundAt(ground: SkyGround, mu: number, out: number[]): void {
  const x = Math.min(Math.max((mu + 1) / 2, 0), 1) * (SKY_BLOCK_COLUMNS - 1)
  const x0 = Math.floor(x)
  const x1 = Math.min(x0 + 1, SKY_BLOCK_COLUMNS - 1)
  const f = x - x0
  for (let c = 0; c < 3; c += 1)
    out[c] =
      (ground.radiance[x0 * 3 + c] as number) * (1 - f) +
      (ground.radiance[x1 * 3 + c] as number) * f
}

/*
 * A ray marched once, for every sun. Along a ray from a fixed point the
 * samples, their densities and the view's transmittance are the same under
 * any sun; only the sun's transmittance, Ψ and the phase move with it. So a
 * row of the table marches each direction once and lights it under all 32
 * suns, which halves the bake, and splitting each table read across its
 * row and its column (`rowOf`) takes a sixth more off it, in Node on the
 * Mac mini (Mac18,5, Apple M6).
 *
 * A sample is `RAY_STRIDE` numbers: its radius and its position's two
 * components in the sun's plane, its row places in the transmittance table
 * and in Ψ's (`rowOf`), then per band the step's light, (1 −
 * e^−τ)/σ through the view's transmittance to it, times each scattering
 * coefficient the light is formed from: the gas and the detached layer's
 * (Rayleigh's phase), the aerosol's sideways, the aerosol's turn toward its
 * forward color, and every scatterer's for Ψ.
 */
const RAY_STRIDE = 21
/** Where a sample's light coefficients start. */
const RAY_LIGHT = 9

interface MarchedRay {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly samples: number
  /** The view's transmittance at the ray's end, per band. */
  readonly through: readonly number[]
  /** Where the ray meets the ground, in the sun's plane, or null. */
  readonly ground: { readonly x: number; readonly z: number } | null
  /** On the datum, aimed down: the ray is in the ground where it starts. */
  readonly underfoot: boolean
}

function marchRay(
  recipe: AtmosphereRecipe,
  reads: SkyReads,
  steps: number,
  r: number,
  x: number,
  y: number,
  z: number,
  buffer: Float64Array,
): MarchedRay {
  const through = [1, 1, 1]
  const none = { x, y, z, samples: 0, through, ground: null }
  // On the datum a ray aimed down is already in the ground, which is lit by
  // the sun at the point's own cosine; the far root `distanceToSphere`
  // would answer is a chord of rock.
  if (z < 0 && r <= 1) return { ...none, underfoot: true }
  const groundHit = z < 0 ? distanceToSphere(r, z, 1) : Infinity
  const top = distanceToSphere(r, z, recipe.topRatio)
  const end = Math.min(groundHit, top)
  if (!Number.isFinite(end) || end <= 0) return { ...none, underfoot: false }
  const perigee = z < 0 ? -r * z : 0
  for (let i = 0; i < steps; i += 1) {
    const [s, step] = marchSample(i, steps, end, perigee)
    const px = x * s
    const py = y * s
    const pz = r + z * s
    const radius = Math.sqrt(px * px + py * py + pz * pz)
    const { rayleigh, mie, ozone, detached } = densities(radius - 1, recipe)
    const k = i * RAY_STRIDE
    buffer[k] = radius
    buffer[k + 1] = px
    buffer[k + 2] = pz
    rowOf(reads.transmittance, radius, buffer, k + 3)
    rowOf(reads.psi, radius, buffer, k + 6)
    for (let c = 0; c < 3; c += 1) {
      const scatterRayleigh = (recipe.betaRayleigh[c] as number) * rayleigh
      const scatterMie = (recipe.mieScatter[c] as number) * mie
      const scatterDetached = (recipe.detachedScatter[c] as number) * detached
      const extinction =
        scatterRayleigh +
        (recipe.mieExtinction[c] as number) * mie +
        (recipe.ozone[c] as number) * ozone +
        recipe.detachedExtinction * detached
      const stepTau = extinction * step
      const lost = -Math.expm1(-stepTau)
      const seen =
        (through[c] as number) * (stepTau > 0 ? (step * lost) / stepTau : step)
      const j = k + RAY_LIGHT + c * 4
      buffer[j] = seen * (scatterRayleigh + scatterDetached)
      buffer[j + 1] = seen * scatterMie
      buffer[j + 2] =
        seen *
        ((recipe.mieForward[c] as number) - (recipe.mieScatter[c] as number)) *
        mie
      buffer[j + 3] = seen * (scatterRayleigh + scatterMie + scatterDetached)
      through[c] = (through[c] as number) * (1 - lost)
    }
  }
  const hit =
    groundHit <= top
      ? { x: x * groundHit, z: r + z * groundHit, y: y * groundHit }
      : null
  return {
    x,
    y,
    z,
    samples: steps,
    through,
    ground:
      hit === null
        ? null
        : {
            x: hit.x / Math.hypot(hit.x, hit.y, hit.z),
            z: hit.z / Math.hypot(hit.x, hit.y, hit.z),
          },
    underfoot: false,
  }
}

const sunScratch = [0, 0, 0]
const psiScratch = [0, 0, 0]
const litScratch = [0, 0, 0]

/**
 * The radiance a marched ray carries to its start under a sun at (sx, 0,
 * sz): `zenithSkyRadiance`'s march along the ray, per unit of the sun's
 * irradiance and before the gain, and where the ray meets the ground the
 * ground's light through it. With `ground` null the ground is black.
 */
function rayLight(
  ray: MarchedRay,
  buffer: Float64Array,
  reads: SkyReads,
  ground: SkyGround | null,
  sx: number,
  sz: number,
  out: number[],
): void {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  if (ray.underfoot) {
    if (ground !== null) groundAt(ground, sz, out)
    return
  }
  const nu = ray.x * sx + ray.z * sz
  const g = AEROSOL_ASYMMETRY
  const phaseRayleigh = (3 / (16 * Math.PI)) * (1 + nu * nu)
  const phaseMie =
    (1 - g * g) / (4 * Math.PI) / Math.max(1 + g * g - 2 * g * nu, 1e-4) ** 1.5
  const forwardShare = phaseMie / AEROSOL_FORWARD_PEAK
  for (let i = 0; i < ray.samples; i += 1) {
    const k = i * RAY_STRIDE
    const radius = buffer[k] as number
    const muSun =
      ((buffer[k + 1] as number) * sx + (buffer[k + 2] as number) * sz) /
      Math.max(radius, 1e-6)
    if (reads.exact === undefined)
      readRow(reads.transmittance, buffer, k + 3, muSun, sunScratch)
    else {
      const exact = reads.exact(radius, muSun)
      sunScratch[0] = exact[0]
      sunScratch[1] = exact[1]
      sunScratch[2] = exact[2]
    }
    readRow(reads.psi, buffer, k + 6, muSun, psiScratch)
    for (let c = 0; c < 3; c += 1) {
      const j = k + RAY_LIGHT + c * 4
      const single =
        ((buffer[j] as number) * phaseRayleigh +
          ((buffer[j + 1] as number) +
            (buffer[j + 2] as number) * forwardShare) *
            phaseMie) *
        (sunScratch[c] as number)
      const multiple = (buffer[j + 3] as number) * (psiScratch[c] as number)
      out[c] = (out[c] as number) + single + multiple
    }
  }
  if (ground === null || ray.ground === null) return
  groundAt(ground, ray.ground.x * sx + ray.ground.z * sz, litScratch)
  for (let c = 0; c < 3; c += 1)
    out[c] =
      (out[c] as number) +
      (ray.through[c] as number) * (litScratch[c] as number)
}

/** The sun's direction for a cosine `mu`: in the xz plane, its azimuth +x. */
function sunAt(mu: number): readonly [number, number] {
  return [Math.sqrt(Math.max(0, 1 - mu * mu)), mu]
}

/**
 * A row's sums at radius `r`, one sun a cosine of `suns`: each direction of
 * `directions` marched once and lit under every sun.
 */
function rowSums(
  air: SkyAir,
  reads: SkyReads,
  steps: number,
  ground: SkyGround | null,
  r: number,
  directions: Float64Array,
  suns: readonly number[],
): Sums {
  const sums: Sums = new Float64Array(suns.length * SUMS)
  const buffer = new Float64Array(steps * RAY_STRIDE)
  const light = [0, 0, 0]
  const sun = suns.map(sunAt)
  for (let i = 0; i < directions.length; i += 4) {
    const x = directions[i] as number
    const z = directions[i + 2] as number
    const weight = directions[i + 3] as number
    const ray = marchRay(
      air.recipe,
      reads,
      steps,
      r,
      x,
      directions[i + 1] as number,
      z,
      buffer,
    )
    sun.forEach(([sx, sz], at) => {
      rayLight(ray, buffer, reads, ground, sx, sz, light)
      addInto(sums, at, light, x, z, weight)
    })
  }
  return sums
}

/** The sun's cosine at each column of a block. */
const COLUMN_SUNS = Array.from(
  { length: SKY_BLOCK_COLUMNS },
  (_, column) => (column / (SKY_BLOCK_COLUMNS - 1)) * 2 - 1,
)

/**
 * The ground's light at each of the table's sun cosines: Lambert at
 * `SKY_GROUND_ALBEDO` under the sun through the air and the clear sky's
 * irradiance from above, both at the datum. The sky above the datum sees no
 * ground, so it is taken with a black one, and the light the ground returns
 * to the air and the air back to it is left out: at an albedo of 0.15 under
 * an air that reflects a tenth, a percent and a half.
 */
function groundLight(
  air: SkyAir,
  reads: SkyReads,
  quadrature: SkyQuadrature,
): SkyGround {
  // From the datum the horizon is level, so the directions over it are
  // exactly the upper hemisphere, and their z-moment is the irradiance.
  const directions = skyDirections(1, { ...quadrature, below: 0 })
  const sums = rowSums(
    air,
    reads,
    quadrature.steps,
    null,
    1,
    directions,
    COLUMN_SUNS,
  )
  const radiance = new Float64Array(SKY_BLOCK_COLUMNS * 3)
  const sunlight = [0, 0, 0]
  COLUMN_SUNS.forEach((mu, column) => {
    sunlightAtDatum(reads, mu, sunlight)
    for (let c = 0; c < 3; c += 1) {
      const beam = mu > 0 ? mu * (sunlight[c] as number) : 0
      const sky = sums[column * SUMS + c * 5 + 1] as number
      radiance[column * 3 + c] = (SKY_GROUND_ALBEDO / Math.PI) * (beam + sky)
    }
  })
  return { radiance }
}

/**
 * The sky's moments at radius `r` (the datum is 1) under a sun at cosine
 * `muSun`, by a quadrature of the air's own march. What each texel of the
 * table holds, and with a finer quadrature the reference it is tested
 * against.
 */
export function marchSkyMoments(
  air: SkyAir,
  r: number,
  muSun: number,
  quadrature: SkyQuadrature = DEFAULT_QUADRATURE,
): SkyTableMoments {
  const reads = readsOf(air, quadrature)
  const ground = groundLight(air, reads, quadrature)
  const directions = skyDirections(r, quadrature)
  const sums = rowSums(air, reads, quadrature.steps, ground, r, directions, [
    muSun,
  ])
  return momentsFrom(sums, 0)
}

/** The irradiance on each side of a horizontal and a vertical face, per band. */
export interface SkyFaces {
  readonly above: Bands
  readonly below: Bands
  /** On a vertical face turned to the sun's azimuth, and on its back. */
  readonly sunward: Bands
  readonly away: Bands
}

/**
 * The irradiance on each side of a horizontal face and of a vertical one
 * turned to the sun, at radius `r` under a sun at cosine `muSun`, per unit
 * of the sun's irradiance and before the gain: the quadrature's own sums.
 *
 * The table keeps each face's difference and not its sides. A sky linear in
 * the face's normal would give each side as π·L̄·(1 ± Δ/2), but the real one
 * is brightest at its horizon and dark overhead high up, and that form errs
 * by a factor of five at 20 km under a low sun and by 9 to 37% on the datum
 * (`skyIrradiance.test.ts`). The ground's skylight wants one side, so it
 * takes a quantity the table does not hold.
 */
export function marchSkyFaces(
  air: SkyAir,
  r: number,
  muSun: number,
  quadrature: SkyQuadrature = DEFAULT_QUADRATURE,
): SkyFaces {
  const reads = readsOf(air, quadrature)
  const ground = groundLight(air, reads, quadrature)
  const directions = skyDirections(r, quadrature)
  const sums = rowSums(air, reads, quadrature.steps, ground, r, directions, [
    muSun,
  ])
  const band = (i: number): Bands => [
    sums[i] as number,
    sums[5 + i] as number,
    sums[10 + i] as number,
  ]
  const [vertical, across, above, sunward] = [
    band(1),
    band(2),
    band(3),
    band(4),
  ]
  return {
    above,
    below: [
      above[0] - vertical[0],
      above[1] - vertical[1],
      above[2] - vertical[2],
    ],
    sunward,
    away: [
      sunward[0] - across[0],
      sunward[1] - across[1],
      sunward[2] - across[2],
    ],
  }
}

/**
 * The radiance arriving at radius `r` from the unit direction (x, y, z),
 * z up, under a sun at cosine `muSun` whose azimuth is +x, over a black
 * ground: one ray of the quadrature, per unit of the sun's irradiance and
 * before `ATMOSPHERE_GAIN`.
 */
export function skyRadiance(
  air: SkyAir,
  r: number,
  muSun: number,
  direction: Bands,
  quadrature: Pick<SkyQuadrature, 'steps' | 'sunlight'> = DEFAULT_QUADRATURE,
): Bands {
  const [x, y, z] = direction
  const buffer = new Float64Array(quadrature.steps * RAY_STRIDE)
  const reads = readsOf(air, { ...DEFAULT_QUADRATURE, ...quadrature })
  const ray = marchRay(air.recipe, reads, quadrature.steps, r, x, y, z, buffer)
  const [sx, sz] = sunAt(muSun)
  const out = [0, 0, 0]
  rayLight(ray, buffer, reads, null, sx, sz, out)
  return [out[0] as number, out[1] as number, out[2] as number]
}

/** The column of block `block` that holds the sun's `column`th cosine. */
function texelColumn(block: number, column: number): number {
  return (
    block * (SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD) + SKY_BLOCK_GUARD + column
  )
}

/** A table that holds no sky: L̄ at the floor, no difference between any two sides, `c` zero. */
export function darkSkyTable(height = SKY_TABLE_HEIGHT): SkyTable {
  const data = new Float32Array(SKY_TABLE_WIDTH * height * 4)
  const floor = Math.log(MULTI_SCATTER_FLOOR)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < SKY_TABLE_WIDTH; x += 1) {
      const index = (y * SKY_TABLE_WIDTH + x) * 4
      if (x < SKY_BLOCK_COLUMNS + 2 * SKY_BLOCK_GUARD) {
        data[index] = floor
        data[index + 1] = floor
        data[index + 2] = floor
      }
    }
  return { width: SKY_TABLE_WIDTH, height, data, rows: NO_SKY_ROWS }
}

/**
 * The sky's moments for an air, from its own two tables: RGBA32F, sized for
 * upload. An air with no shell, `topRatio` not over 1, has no sky, and its
 * table is `darkSkyTable`'s.
 */
export function bakeSkyMoments(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
  multiScatter: ScatteringLut,
  quadrature: SkyQuadrature = DEFAULT_QUADRATURE,
): SkyTable {
  if (!(recipe.topRatio > 1)) return darkSkyTable()
  const air: SkyAir = { recipe, transmittance, multiScatter }
  const reads = readsOf(air, quadrature)
  const ground = groundLight(air, reads, quadrature)
  const rows = skyRowsOf(recipe)
  const shares = skyRowShares(rows)
  const { data } = darkSkyTable()
  const ceiling = recipe.topRatio - 1
  const write = (
    block: number,
    column: number,
    y: number,
    v: Bands,
    alpha: number,
  ) => {
    const index = (y * SKY_TABLE_WIDTH + texelColumn(block, column)) * 4
    data[index] = v[0]
    data[index + 1] = v[1]
    data[index + 2] = v[2]
    data[index + 3] = alpha
  }
  for (let y = 0; y < SKY_TABLE_HEIGHT; y += 1) {
    const r = 1 + (shares[y] as number) * ceiling
    const sums = rowSums(
      air,
      reads,
      quadrature.steps,
      ground,
      r,
      skyDirections(r, quadrature),
      COLUMN_SUNS,
    )
    for (let column = 0; column < SKY_BLOCK_COLUMNS; column += 1) {
      const moments = momentsFrom(sums, column)
      const logMean: Bands = [
        Math.log(moments.mean[0]),
        Math.log(moments.mean[1]),
        Math.log(moments.mean[2]),
      ]
      for (const [block, value] of [
        [0, logMean],
        [1, moments.up],
        [2, moments.sunward],
      ] as const) {
        // Block k's alpha is band k's c: three bands in three spare channels.
        const alpha = moments.upper[block]
        write(block, column, y, value, alpha)
        // The guards repeat the block's edge columns, so a read clamped to
        // the block's first or last cosine filters against itself.
        if (column === 0) write(block, -SKY_BLOCK_GUARD, y, value, alpha)
        if (column === SKY_BLOCK_COLUMNS - 1)
          write(block, SKY_BLOCK_COLUMNS, y, value, alpha)
      }
    }
  }
  return { width: SKY_TABLE_WIDTH, height: SKY_TABLE_HEIGHT, data, rows }
}

/**
 * The table's moments at a height, as a share of the air's depth, and a
 * sun's cosine, read as the node reads them: the row from `skyRowAt` on the
 * table's own rows, bilinear inside each block, the mean geometrically.
 *
 * It takes any `ScatteringLut` so a caller that holds the bake's answer
 * under that type still reads it, and throws on one without its rows: read
 * evenly in height, the rows would be 60% wrong and nothing would say so.
 */
export function skyMomentsAt(
  table: ScatteringLut & { readonly rows?: SkyRows },
  height01: number,
  muSun: number,
): SkyTableMoments {
  if (table.rows === undefined)
    throw new Error(
      'skyMomentsAt: the table carries no rows; read a SkyTable from bakeSkyMoments or darkSkyTable',
    )
  const x = Math.min(Math.max((muSun + 1) / 2, 0), 1) * (SKY_BLOCK_COLUMNS - 1)
  const y = skyRowAt(table.rows, height01) * (table.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, SKY_BLOCK_COLUMNS - 1)
  const y1 = Math.min(y0 + 1, table.height - 1)
  const fx = x - x0
  const fy = y - y0
  const read = (block: number): [number, number, number, number] => {
    const at = (column: number, row: number, c: number) =>
      table.data[
        (row * table.width + texelColumn(block, column)) * 4 + c
      ] as number
    const out: [number, number, number, number] = [0, 0, 0, 0]
    for (let c = 0; c < 4; c += 1) {
      const low = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx
      const high = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx
      out[c] = low * (1 - fy) + high * fy
    }
    return out
  }
  const [lr, lg, lb, cr] = read(0)
  const [ur, ug, ub, cg] = read(1)
  const [sr, sg, sb, cb] = read(2)
  return {
    mean: [Math.exp(lr), Math.exp(lg), Math.exp(lb)],
    up: [ur, ug, ub],
    sunward: [sr, sg, sb],
    upper: [cr, cg, cb],
  }
}
