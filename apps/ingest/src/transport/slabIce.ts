import { createHash } from 'node:crypto'
import {
  PHASE_ATLAS,
  angleOf,
  iceAggregate,
  mieDroplets,
  phaseAtlas,
  sampleAtlas,
  type IceTable,
  type PhaseAtlas,
} from '@inertialref/rendering'
import { capMoments, legendreInto, phaseOf } from './legendre.ts'
import { SOLAR_ANGULAR_RADIUS } from './moments.ts'
import type { SlabBand, SlabPopulation } from './slabTables.ts'

/*
 * The ice rows as the oracle solves them: the committed aggregate's phase
 * (`iceAggregate`, package T4's table) scaled as the renderer scales it, so
 * the view table can be judged on a medium of the shape it was not cut from.
 *
 * The renderer gives an ice row what it gives a droplet row: extinction
 * times 1 − f_δ, f_δ = 1/Q_ext, and first order on the whole phase at the
 * gain 1/(1 − f_δ), read from the phase atlas. What it takes out is f_δ of
 * the forward peak, and the scaled phase is what is left, renormalized.
 *
 * A droplet's peak is a Fraunhofer pattern and is taken out as one. An
 * aggregate's is not a disk's at any size. At the row's effective
 * diameter the disk's pattern is wider than the peak, what is left has a
 * negative ring, and χ′_l falls to 0.04 at l = 24 and climbs to 0.11 at
 * l = 128 (50 µm); delta-M at 128 streams then takes out more than the
 * low moments hold, and the oracle's reflected radiance goes negative by
 * τ 1. At twice the diameter, f_δ of the pattern is more than the peak
 * holds past l = 100. So the peak is clipped instead: inside 15° of
 * forward, under the 22° halo, the phase is held to the level above which
 * it holds f_δ of the light. What is left is non-negative by construction,
 * its moments fall to under 10⁻³ by l = 50, and the clip's edge is 4.8° to
 * 8.1° from forward.
 */

/** The cone the forward peak is clipped inside: under the 22° halo. */
const PEAK_CONE = (15 * Math.PI) / 180

/** The level above which a row's phase inside the cone holds `share` of its light, by bisection. */
function peakLevel(
  phase: (i: number) => number,
  angles: number,
  share: number,
): number {
  const removed = (level: number): number => {
    let sum = 0
    for (let i = 1; i < angles; i += 1) {
      const a = angleOf({ angles }, i - 1)
      const b = angleOf({ angles }, i)
      if (b > PEAK_CONE) break
      const excess = (j: number, theta: number): number =>
        Math.max(0, phase(j) - level) * Math.sin(theta)
      sum += ((b - a) / 2) * 2 * Math.PI * (excess(i - 1, a) + excess(i, b))
    }
    return sum
  }
  let low = 0
  let high = phase(0)
  for (let k = 0; k < 100; k += 1) {
    const middle = (low + high) / 2
    if (removed(middle) > share) low = middle
    else high = middle
  }
  return high
}

/** The moments a row's phase is projected on: past the oracle's 128 streams and its delta-M share. */
export const ICE_MOMENTS = 512

/** χ_l of a phase tabulated on the atlas's warped axis: trapezoids in θ, renormalized to χ₀ = 1. */
export function tableMoments(
  phase: (i: number) => number,
  angles: number,
  count: number,
): Float64Array {
  const out = new Float64Array(count)
  const p = new Float64Array(count)
  const theta = Array.from({ length: angles }, (_, i) => angleOf({ angles }, i))
  for (let i = 0; i < angles; i += 1) {
    const left = i > 0 ? theta[i]! - theta[i - 1]! : 0
    const right = i + 1 < angles ? theta[i + 1]! - theta[i]! : 0
    const weight =
      ((left + right) / 2) * 2 * Math.PI * Math.sin(theta[i]!) * phase(i)
    legendreInto(Math.cos(theta[i]!), count, p)
    for (let l = 0; l < count; l += 1) out[l] = out[l]! + weight * p[l]!
  }
  const zero = out[0]!
  return out.map((value) => value / zero)
}

/** µm: an ice row's radius, as the phase atlas reads one, half its effective diameter. */
export function iceRadius(table: IceTable, row: number): number {
  return (table.diameterMin + row * table.diameterStep) / 2
}

let atlas: PhaseAtlas | undefined

/** One ice row as the oracle solves it, a band a channel. */
export function icePopulation(row: number): SlabPopulation {
  const table = iceAggregate()
  atlas ??= phaseAtlas(mieDroplets(), table, SOLAR_ANGULAR_RADIUS)
  const bulk = table.bulk[row]!
  const share = 1 / bulk.extinction
  const cap = capMoments(SOLAR_ANGULAR_RADIUS, ICE_MOMENTS)
  const hash = createHash('sha256')
  const bands = table.bands.map((nm, b): SlabBand => {
    const at = (i: number): number =>
      table.phase[(row * table.angles + i) * 3 + b]!
    const moments = tableMoments(at, table.angles, ICE_MOMENTS)
    const level = peakLevel(at, table.angles, share)
    const scaled = tableMoments(
      (i) => (angleOf(table, i) < PEAK_CONE ? Math.min(at(i), level) : at(i)),
      table.angles,
      ICE_MOMENTS,
    )
    // What the clip took out, as moments: the share the march's first
    // order carries and its multiple scattering does not.
    const pattern = moments.map(
      (value, l) => (value - (1 - share) * scaled[l]!) / share,
    )
    for (const value of moments) hash.update(value.toPrecision(10))
    const scaledPhase = (mu: number): number => phaseOf(scaled, mu)
    return {
      center: nm,
      truth: { moments, phase: (mu) => phaseOf(moments, mu) },
      scaled: { moments: scaled, phase: scaledPhase },
      // First order as the renderer draws it: the atlas's own read, over
      // its gain, which is the 1/(1 − f_δ) the reference puts back.
      whole: (mu) => sampleAtlas(atlas!, mu, PHASE_ATLAS.iceRow + row)[b]!,
      disk: moments.map((value, l) => value * cap[l]!),
      pattern: pattern.map((value, l) => value * cap[l]!),
      negative: 0,
    }
  })
  return {
    radius: iceRadius(table, row),
    share,
    asymmetry: (bulk.asymmetry - share) / (1 - share),
    moment:
      bands.reduce((sum, band) => sum + band.scaled.moments[1]!, 0) /
      bands.length,
    bands,
    digest: hash.digest('hex').slice(0, 16),
  }
}

/** An ice row's transport scale, 1 − χ′₁, and what it is made of. */
export interface IceTransportRow {
  readonly radius: number
  readonly share: number
  /** g′ by the formula, and χ′₁. */
  readonly asymmetry: number
  readonly moment: number
}

/** Every ice row's transport scale. */
export function iceTransport(): IceTransportRow[] {
  const table = iceAggregate()
  return Array.from({ length: table.diameters }, (_, row) => {
    const population = icePopulation(row)
    return {
      radius: population.radius,
      share: population.share,
      asymmetry: population.asymmetry,
      moment: population.moment,
    }
  })
}
