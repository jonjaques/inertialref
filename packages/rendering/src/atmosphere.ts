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
 * normalization), the limb color tints the aerosol, and `thickness` scales
 * the column. Mars therefore keeps its butterscotch sky and its blue sunset
 * — both are in its authored colors — without this file knowing what CO₂ is.
 */

export interface HazeAuthoring {
  readonly colour: {
    readonly r: number
    readonly g: number
    readonly b: number
  }
  readonly limb: { readonly r: number; readonly g: number; readonly b: number }
  readonly thickness: number
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
  /** Aerosol extinction per planet radius, gray — scatter / 0.9. */
  readonly mieExtinction: number
}

export interface ScatteringLut {
  readonly width: number
  readonly height: number
  /** RGBA32F texels, alpha 1 — sized for a direct GPU upload. */
  readonly data: Float32Array
}

export const TRANSMITTANCE_WIDTH = 512
export const TRANSMITTANCE_HEIGHT = 64
export const MULTI_SCATTER_SIZE = 32

/**
 * Earth's vertical Rayleigh optical depth, summed over RGB, at thickness 1.
 *
 * Measured, not chosen: the real column is (0.046, 0.108, 0.265), which sums
 * to 0.42 — and splitting that sum by the authored zenith color reproduces
 * the real spectrum within a few percent, which is what licenses deriving
 * physics from art direction in the first place.
 */
const TAU_RAYLEIGH_SUM = 0.42

/** Vertical aerosol optical depth at thickness 1 — a hazy-bright Earth day.
 * 0.035 is the textbook clear-sky number and it read too clean: the white-gold
 * band under every ISS dusk is aerosol, and at 0.035 the band barely showed. */
const TAU_MIE = 0.05

/** Mie extinction over scattering: aerosols absorb a little. */
const MIE_EXTINCTION_RATIO = 1.11

/** March steps for the transmittance table. */
const TRANSMITTANCE_STEPS = 48

/** Directions and steps for the multiple-scattering estimate. */
const MS_DIRECTIONS = 16
const MS_STEPS = 16

/**
 * Scale heights as fractions of the drawn shell.
 *
 * 0.22 puts e^−4.5 of the density at the authored ceiling — the same falloff
 * the analytic shell used, so the shell reads the same size it always did —
 * and the aerosol deck sits at less than half that, which is why a limb is
 * blue on top and warm underneath rather than uniformly mixed.
 */
const RAYLEIGH_SHELL_FRACTION = 0.22
const MIE_SHELL_FRACTION = 0.09

/** Derive the physical recipe from an authored haze layer and its shell. */
export function atmosphereRecipe(
  haze: HazeAuthoring,
  topRatio: number,
): AtmosphereRecipe {
  const shell = Math.max(topRatio - 1, 1e-5)
  const hRayleigh = shell * RAYLEIGH_SHELL_FRACTION
  const hMie = shell * MIE_SHELL_FRACTION

  const { colour, limb, thickness } = haze
  const colourSum = Math.max(colour.r + colour.g + colour.b, 1e-6)
  // τ = β·H for an exponential column, so β = τ/H.
  const tau = TAU_RAYLEIGH_SUM * thickness
  const betaRayleigh: [number, number, number] = [
    ((colour.r / colourSum) * tau) / hRayleigh,
    ((colour.g / colourSum) * tau) / hRayleigh,
    ((colour.b / colourSum) * tau) / hRayleigh,
  ]

  const limbMean = Math.max((limb.r + limb.g + limb.b) / 3, 1e-6)
  const tauMie = TAU_MIE * thickness
  const mieScatter: [number, number, number] = [
    ((limb.r / limbMean) * tauMie) / hMie,
    ((limb.g / limbMean) * tauMie) / hMie,
    ((limb.b / limbMean) * tauMie) / hMie,
  ]
  // Extinction is deliberately gray: a tinted extinction double-counts the
  // color the scattering tint already applied, and drifts white sums.
  const mieExtinction = (tauMie / hMie) * MIE_EXTINCTION_RATIO

  return { topRatio, hRayleigh, hMie, betaRayleigh, mieScatter, mieExtinction }
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
): { rayleigh: number; mie: number } {
  const ceiling = recipe.topRatio - 1
  const fade = Math.max(0, 1 - h / ceiling)
  if (fade === 0 || h < 0) {
    // Below the ground the air is whatever it is at the ground: a march step
    // that dips fractionally under r = 1 must not read vacuum.
    if (h < 0) return { rayleigh: fade > 0 ? 1 : 0, mie: fade > 0 ? 1 : 0 }
    return { rayleigh: 0, mie: 0 }
  }
  return {
    rayleigh: Math.exp(-h / recipe.hRayleigh) * fade,
    mie: Math.exp(-h / recipe.hMie) * fade,
  }
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
function transmittanceFrom(
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

  const step = top / TRANSMITTANCE_STEPS
  let tauR = 0
  let tauG = 0
  let tauB = 0
  for (let i = 0; i < TRANSMITTANCE_STEPS; i += 1) {
    const s = (i + 0.5) * step
    const radius = Math.sqrt(r * r + s * s + 2 * r * s * mu)
    const { rayleigh, mie } = densities(radius - 1, recipe)
    const mieExt = mie * recipe.mieExtinction
    tauR += (recipe.betaRayleigh[0] * rayleigh + mieExt) * step
    tauG += (recipe.betaRayleigh[1] * rayleigh + mieExt) * step
    tauB += (recipe.betaRayleigh[2] * rayleigh + mieExt) * step
  }
  return [Math.exp(-tauR), Math.exp(-tauG), Math.exp(-tauB)]
}

/**
 * The transmittance table.
 *
 * u spans μ ∈ [−1, 1] linearly and v spans altitude — a deliberately naive
 * parameterisation against Bruneton's distance-warped one. Its weakness is
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
 * Hillaire's isotropic multiple-scattering table Ψ(r, μs).
 *
 * At each grid point: march a small bundle of directions, accumulating the
 * second order of scattering (single-scattered light arriving from every
 * direction, isotropic phase) and the transfer factor f — how much of what
 * scatters here scatters *again*. The geometric series over orders collapses
 * to Ψ = L₂ / (1 − f). The main march then adds Ψ·σs at every sample: all
 * orders past the first for two multiplies and a lookup, which is the entire
 * reason twilight has a sky instead of an edge.
 */
export function bakeMultipleScattering(
  recipe: AtmosphereRecipe,
  transmittance: ScatteringLut,
): ScatteringLut {
  const size = MULTI_SCATTER_SIZE
  const data = new Float32Array(size * size * 4)
  const directions = fibonacciSphere(MS_DIRECTIONS)
  const ceiling = recipe.topRatio - 1
  const isotropic = 1 / (4 * Math.PI)

  for (let y = 0; y < size; y += 1) {
    const r = 1 + (y / (size - 1)) * ceiling
    for (let x = 0; x < size; x += 1) {
      const muSun = (x / (size - 1)) * 2 - 1
      const sun: [number, number, number] = [
        Math.sqrt(Math.max(0, 1 - muSun * muSun)),
        0,
        muSun,
      ]

      const luminance = [0, 0, 0]
      const transfer = [0, 0, 0]
      for (const direction of directions) {
        const muRay = direction[2]
        // Same μ ≥ 0 guard as `transmittanceFrom`, for the same rounding.
        const ground = muRay < 0 ? distanceToSphere(r, muRay, 1) : Infinity
        const top = distanceToSphere(r, muRay, recipe.topRatio)
        const end = Math.min(ground, top)
        if (!Number.isFinite(end) || end <= 0) continue
        const step = end / MS_STEPS

        const tau = [0, 0, 0]
        for (let i = 0; i < MS_STEPS; i += 1) {
          const s = (i + 0.5) * step
          // Position in the plane spanned by zenith and the ray.
          const px = direction[0] * s
          const py = direction[1] * s
          const pz = r + direction[2] * s
          const radius = Math.sqrt(px * px + py * py + pz * pz)
          const { rayleigh, mie } = densities(radius - 1, recipe)
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
              recipe.mieExtinction * mie
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

      const index = (y * size + x) * 4
      for (let c = 0; c < 3; c += 1) {
        const secondOrder = (luminance[c] as number) / MS_DIRECTIONS
        const f = Math.min((transfer[c] as number) / MS_DIRECTIONS, 0.95)
        data[index + c] = secondOrder / (1 - f)
      }
      data[index + 3] = 1
    }
  }
  return { width: size, height: size, data }
}
