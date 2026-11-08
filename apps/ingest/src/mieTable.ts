import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { MieTableSource } from '@inertialref/rendering'
import {
  angularTable,
  efficiencies,
  mieSeries,
  mirroredIntensities,
  rings,
  wiscombeTerms,
} from './mie.ts'

/*
 * The droplet phase table's generator: `node apps/ingest/src/mieTable.ts`
 * writes `packages/rendering/src/mieDroplets.generated.ts`, then
 * `pnpm exec prettier -w` formats it.
 *
 * A row is a size distribution, not a drop. One drop's light carries
 * interference ripple, across angle and from one radius to the next, that a
 * cloud's spread of radii washes out; the spread is narrow (v = 0.01, about
 * 10% in radius) because the glory and the corona survive only a narrow one.
 * A channel is a band, not a wavelength, for the same reason in λ: nine
 * wavelengths under a raised cosine turn one wavelength's rings into the
 * color gradient a real ring has.
 */

/** The table's axes, distribution and bands. */
export const DROPLET_TABLE = {
  angles: 1024,
  radii: 32,
  radiusMin: 2,
  radiusMax: 32,
  variance: 0.01,
  /** nm: the air's bands (`atmosphere.ts`), so a channel is one wavelength in cloud and sky. */
  bands: [680, 550, 440],
  wavelengthsPerBand: 9,
  bandHalfWidth: 40,
} as const

/**
 * The log-radius grid every row is summed on, µm. Each radius is evaluated
 * once a wavelength and shared by every row it falls in — about fourteen, as
 * a row spans a factor of 3.5 in radius and the rows are 9.4% apart.
 *
 * Halving the step moves the largest row's light by under 0.2%, its bulk by
 * 6 × 10⁻⁵ and its glory ring not at all, but single values by up to 4.6%:
 * Mie resonances far narrower than any affordable step survive the
 * distribution where p is smallest, at the side minimum and in the glory's
 * core, and a finer step only samples more of them (mieTable.slow.test.ts).
 */
export interface RadiusGrid {
  readonly from: number
  readonly to: number
  readonly step: number
}
export const RADIUS_GRID: RadiusGrid = { from: 1, to: 64, step: 0.002 }

/** A row's weights stop below this share of their peak. */
const WEIGHT_FLOOR = 1e-8

/** Degrees between the glory scan's samples on the series. */
export const GLORY_STEP = 0.005

/** θ_i, radians: dense at both ends, so the forward peak and the glory both get texels. */
export function tableAngle(i: number): number {
  return (
    (Math.PI / 2) * (1 - Math.cos((Math.PI * i) / (DROPLET_TABLE.angles - 1)))
  )
}

/** Row j's effective radius, µm. */
export function rowRadius(j: number): number {
  const { radiusMin, radiusMax, radii } = DROPLET_TABLE
  return radiusMin * (radiusMax / radiusMin) ** (j / (radii - 1))
}

/**
 * Water's real index at 25 °C: G. M. Hale and M. R. Querry, "Optical
 * constants of water in the 200-nm to 200-µm wavelength region", Applied
 * Optics 12, 555–563 (1973), Table I, 350–750 nm. Transcribed from
 * refractiveindex.info's copy of the table (main/H2O/Hale) and checked against
 * the authors' manuscript (NASA NTRS 19730006973, Part I, Table I) and Pilon's
 * UCLA tabulation: all three agree here. The table gives three decimals, so n
 * is flat across 650–700 nm; that is the source's resolution, not a step in
 * water.
 */
const WATER_INDEX: readonly (readonly [nm: number, n: number])[] = [
  [350, 1.343],
  [375, 1.341],
  [400, 1.339],
  [425, 1.338],
  [450, 1.337],
  [475, 1.336],
  [500, 1.335],
  [525, 1.334],
  [550, 1.333],
  [575, 1.333],
  [600, 1.332],
  [625, 1.332],
  [650, 1.331],
  [675, 1.331],
  [700, 1.331],
  [725, 1.33],
  [750, 1.33],
]

/** Hale and Querry's n at λ nm, linear between their rows; refuses λ outside them. */
export function waterIndex(nm: number): number {
  const first = WATER_INDEX[0]!
  const last = WATER_INDEX[WATER_INDEX.length - 1]!
  if (!(nm >= first[0] && nm <= last[0]))
    throw new Error(
      `mieTable: ${nm} nm is outside Hale and Querry's ${first[0]}–${last[0]} nm here`,
    )
  let i = 1
  while (WATER_INDEX[i]![0] < nm) i += 1
  const [l0, n0] = WATER_INDEX[i - 1]!
  const [l1, n1] = WATER_INDEX[i]!
  return n0 + ((n1 - n0) * (nm - l0)) / (l1 - l0)
}

export interface Band {
  readonly wavelengths: readonly number[]
  /** Raised-cosine weights, summing to 1. */
  readonly weights: readonly number[]
}

/**
 * A band's wavelengths and weights: the midpoints of nine equal steps across
 * ±40 nm, under cos²(π(λ − λ_c)/80). The weight is zero at ±40 nm, so nodes on
 * the ends would spend two of the nine on nothing.
 */
export function band(center: number): Band {
  const { wavelengthsPerBand: count, bandHalfWidth: half } = DROPLET_TABLE
  const wavelengths = Array.from(
    { length: count },
    (_, k) => center + (half * (2 * k + 1 - count)) / count,
  )
  const raw = wavelengths.map(
    (nm) => Math.cos((Math.PI * (nm - center)) / (2 * half)) ** 2,
  )
  const total = raw.reduce((sum, w) => sum + w, 0)
  return { wavelengths, weights: raw.map((w) => w / total) }
}

/** r_i = from·e^(i·step), µm, up to `to`. */
export function radiusGrid(grid: RadiusGrid = RADIUS_GRID): Float64Array {
  const count = Math.floor(Math.log(grid.to / grid.from) / grid.step) + 1
  return Float64Array.from(
    { length: count },
    (_, i) => grid.from * Math.exp(i * grid.step),
  )
}

/** One row's weights on the grid: indices `first` onward, summing to 1. */
export interface RowWeights {
  readonly first: number
  readonly weights: Float64Array
}

/**
 * Hansen and Travis's (1974) modified gamma, n(r) ∝ r^((1 − 3v)/v)·exp(−r/(r_e·v)),
 * whose effective radius is r_e and effective variance v. On a log grid
 * w_i ∝ n(r_i)·r_i·Δln r, so Σw·f(r_i) is ∫n·f dr. Formed in logs, because
 * the factors leave float64 long before their product does: for the 2 µm row
 * a 64 µm drop's exp(−r/(r_e·v)) is e⁻³²⁰⁰.
 */
export function rowWeights(
  radii: Float64Array,
  effective: number,
  variance: number,
): RowWeights {
  const power = (1 - 3 * variance) / variance
  const logs = Array.from(
    radii,
    (r) => (power + 1) * Math.log(r) - r / (effective * variance),
  )
  const peak = Math.max(...logs)
  const floor = peak + Math.log(WEIGHT_FLOOR)
  const first = logs.findIndex((l) => l >= floor)
  const end = logs.findLastIndex((l) => l >= floor) + 1
  const weights = Float64Array.from(logs.slice(first, end), (l) =>
    Math.exp(l - peak),
  )
  const total = weights.reduce((sum, w) => sum + w, 0)
  for (let i = 0; i < weights.length; i += 1) weights[i] = weights[i]! / total
  return { first, weights }
}

/** One row of the table at the angles asked for. */
export interface RowSample {
  readonly row: number
  /** sr⁻¹, normalized to ∫p dΩ = 1, laid out [angle][band]. */
  readonly phase: Float64Array
  /** Per band: Q_ext, the single-scattering albedo, and g. */
  readonly extinction: readonly number[]
  readonly albedo: readonly number[]
  readonly asymmetry: readonly number[]
}

/**
 * Rows of the table at table angle indices `angles`.
 *
 * Within a band, a row's phase is its scattered light over its scattering:
 * Σ_λ ω_λ Σ_i w_i·dσ/dΩ / Σ_λ ω_λ Σ_i w_i·C_sca, with dσ/dΩ = (|S₁|² + |S₂|²)/(2k²).
 * That weights each radius by C_sca and each wavelength by what it scatters,
 * which is the phase of the band's light, and it is normalized by
 * construction. Q_ext and g average the same way, by area and by scattering.
 */
export function sampleRows(
  rows: readonly number[],
  angles: readonly number[],
  grid: RadiusGrid = RADIUS_GRID,
): RowSample[] {
  const radii = radiusGrid(grid)
  const weights = rows.map((row) =>
    rowWeights(radii, rowRadius(row), DROPLET_TABLE.variance),
  )
  const lo = Math.min(...weights.map((w) => w.first))
  const hi = Math.max(...weights.map((w) => w.first + w.weights.length))
  // θ_{1023 − i} = π − θ_i, so an angle and its mirror come from one sum.
  const last = DROPLET_TABLE.angles - 1
  const keys = [...new Set(angles.map((i) => Math.min(i, last - i)))].sort(
    (p, q) => p - q,
  )
  const slots = angles.map((i) => keys.indexOf(Math.min(i, last - i)))
  const mirrored = angles.map((i) => i > last - i)
  const shortest =
    Math.min(...DROPLET_TABLE.bands.flatMap((c) => band(c).wavelengths)) / 1000
  const table = angularTable(
    keys.map((k) => Math.cos(tableAngle(k))),
    wiscombeTerms((2 * Math.PI * radii[hi - 1]!) / shortest),
  )
  const forward = new Float64Array(keys.length)
  const backward = new Float64Array(keys.length)
  const intensity = new Float64Array(angles.length)
  // Per row: the phase sums, then C_sca, C_ext, g·C_sca and area, each per band.
  const phases = rows.map(() => new Float64Array(3 * angles.length))
  const bulks = rows.map(() => new Float64Array(12))
  DROPLET_TABLE.bands.forEach((center, b) => {
    const { wavelengths, weights: bandWeights } = band(center)
    wavelengths.forEach((nm, l) => {
      const um = nm / 1000
      const m = waterIndex(nm)
      const cross = (um * um) / (8 * Math.PI * Math.PI)
      for (let i = lo; i < hi; i += 1) {
        const covering = weights.flatMap((w, s) => {
          const share = w.weights[i - w.first] ?? 0
          return share > 0 ? [[s, share] as const] : []
        })
        if (covering.length === 0) continue
        const r = radii[i]!
        const series = mieSeries((2 * Math.PI * r) / um, m)
        const q = efficiencies(series)
        mirroredIntensities(series, table, forward, backward)
        for (let a = 0; a < angles.length; a += 1)
          intensity[a] = cross * (mirrored[a] ? backward : forward)[slots[a]!]!
        const area = Math.PI * r * r
        const terms = [
          area * q.scattering,
          area * q.extinction,
          area * q.scattering * q.asymmetry,
          area,
        ]
        for (const [s, share] of covering) {
          const f = bandWeights[l]! * share
          const bulk = bulks[s]!
          terms.forEach((term, t) => {
            bulk[3 * t + b] = bulk[3 * t + b]! + f * term
          })
          const sum = phases[s]!
          for (let a = 0; a < angles.length; a += 1)
            sum[3 * a + b] = sum[3 * a + b]! + f * intensity[a]!
        }
      }
    })
  })
  return rows.map((row, s) => {
    const bulk = bulks[s]!
    const per = (t: number) => [0, 1, 2].map((b) => bulk[3 * t + b]!)
    const [scattering, extinction, asymmetry, area] = [0, 1, 2, 3].map(per)
    return {
      row,
      phase: phases[s]!.map((value, k) => value / scattering![k % 3]!),
      extinction: extinction!.map((e, b) => e / area![b]!),
      albedo: scattering!.map((c, b) => c / extinction![b]!),
      asymmetry: asymmetry!.map((g, b) => g / scattering![b]!),
    }
  })
}

/**
 * The red band's first glory ring for a row, degrees from the antisolar
 * point: the first maximum of p(π − ψ) after its first minimum past ψ = 0
 * (`rings`), on the series at every GLORY_STEP outward. The table's texels are 0.03–0.13°
 * there, so the ring is found on the series and the table is held to it, not
 * the reverse.
 *
 * The scan runs in blocks and stops at the block that shows the ring, about
 * 20/r_e degrees out; it refuses a row with no ring inside 60/r_e, two and a
 * half times Laven's 24/r.
 */
export function gloryRing(row: number, grid: RadiusGrid = RADIUS_GRID): number {
  const effective = rowRadius(row)
  const radii = radiusGrid(grid)
  const { first, weights } = rowWeights(
    radii,
    effective,
    DROPLET_TABLE.variance,
  )
  const red = band(DROPLET_TABLE.bands[0])
  const largest = radii[first + weights.length - 1]!
  const shortest = Math.min(...red.wavelengths) / 1000
  const terms = wiscombeTerms((2 * Math.PI * largest) / shortest)
  const curve = (psi: readonly number[]): Float64Array => {
    const table = angularTable(
      psi.map((degrees) => Math.cos((degrees * Math.PI) / 180)),
      terms,
    )
    const forward = new Float64Array(psi.length)
    const backward = new Float64Array(psi.length)
    const values = new Float64Array(psi.length)
    red.wavelengths.forEach((nm, l) => {
      const um = nm / 1000
      const m = waterIndex(nm)
      const lambda = red.weights[l]! * um * um
      weights.forEach((w, i) => {
        const series = mieSeries((2 * Math.PI * radii[first + i]!) / um, m)
        mirroredIntensities(series, table, forward, backward)
        for (let k = 0; k < psi.length; k += 1)
          values[k] = values[k]! + lambda * w * backward[k]!
      })
    })
    return values
  }
  const block = 256
  const limit = Math.ceil(60 / effective / GLORY_STEP)
  const values: number[] = []
  while (values.length < limit) {
    const psi = Array.from(
      { length: block },
      (_, k) => (values.length + k) * GLORY_STEP,
    )
    values.push(...curve(psi))
    const ring = rings(values).first
    if (ring >= 0) return Number((ring * GLORY_STEP).toFixed(3))
  }
  throw new Error(
    `mieTable: row ${row} (${effective.toFixed(2)} µm) shows no glory ring inside ${60 / effective}°`,
  )
}

/**
 * IEEE binary16 bits of `value`, rounded to nearest, ties to even. Every step
 * is exact in float64 — a division by a power of two, a subtraction within a
 * binade, a multiplication by 1024 — so the rounding sees the true value.
 * Refuses what half precision cannot hold rather than writing an infinity
 * into committed data.
 */
export function halfBits(value: number): number {
  if (!Number.isFinite(value))
    throw new Error(`mieTable: ${value} has no half float`)
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0
  const v = Math.abs(value)
  if (v < 2 ** -14) return sign | roundEven(v / 2 ** -24)
  let exponent = Math.floor(Math.log2(v))
  if (2 ** exponent > v) exponent -= 1
  if (2 ** (exponent + 1) <= v) exponent += 1
  let mantissa = roundEven((v / 2 ** exponent - 1) * 1024)
  if (mantissa === 1024) {
    mantissa = 0
    exponent += 1
  }
  if (exponent > 15)
    throw new Error(`mieTable: ${value} is past half float's 65504`)
  return sign | ((exponent + 15) << 10) | mantissa
}

function roundEven(q: number): number {
  const floor = Math.floor(q)
  const rest = q - floor
  if (rest > 0.5) return floor + 1
  if (rest < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Values as little-endian float16, base64: the generated file's phase. */
export function encodePhase(values: ArrayLike<number>): string {
  const bytes = Buffer.alloc(2 * values.length)
  for (let i = 0; i < values.length; i += 1)
    bytes.writeUInt16LE(halfBits(values[i]!), 2 * i)
  return bytes.toString('base64')
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

/** The whole table, in the generated file's form. */
export function generateDroplets(): MieTableSource {
  const { angles, radii } = DROPLET_TABLE
  const rows = Array.from({ length: radii }, (_, j) => j)
  const samples = sampleRows(
    rows,
    Array.from({ length: angles }, (_, i) => i),
  )
  const phase = new Float64Array(radii * angles * 3)
  samples.forEach((sample, j) => phase.set(sample.phase, j * angles * 3))
  return {
    format: 'inertialref/mie',
    version: 1,
    angles,
    radii,
    radiusMin: DROPLET_TABLE.radiusMin,
    radiusMax: DROPLET_TABLE.radiusMax,
    variance: DROPLET_TABLE.variance,
    bands: [...DROPLET_TABLE.bands],
    wavelengthsPerBand: DROPLET_TABLE.wavelengthsPerBand,
    bandHalfWidth: DROPLET_TABLE.bandHalfWidth,
    index: 'Hale & Querry 1973, 25 °C',
    phase: encodePhase(phase),
    bulk: samples.map(
      (s) =>
        [
          Number(mean(s.extinction).toPrecision(7)),
          Number(mean(s.albedo).toPrecision(7)),
          Number(mean(s.asymmetry).toPrecision(7)),
        ] as const,
    ),
    gloryRed: rows.map((j) => gloryRing(j)),
  }
}

/** The generated file's text, before prettier. */
export function sourceText(source: MieTableSource, seconds: number): string {
  const cpu = cpus()[0]?.model.trim() ?? 'an unnamed CPU'
  const header = [
    `Generated by \`node apps/ingest/src/mieTable.ts\` in ${Math.round(seconds)} s`,
    `(${cpu}, Node ${process.version}); rerun it rather than editing, then`,
    '`pnpm exec prettier -w` this file.',
    '',
    'The droplets’ Lorenz–Mie phase table, sr⁻¹ normalized to ∫p dΩ = 1:',
    '1024 angles × 32 rows × 3 bands as little-endian float16 in base64,',
    'laid out [row][angle][band]. Angle i is θ = (π/2)(1 − cos(πi/1023));',
    'row j is the effective radius 2·16^(j/31) µm.',
    '',
    'A row is Hansen and Travis’s (1974) modified gamma at effective',
    'variance 0.01, summed on one log-radius grid from 1 to 64 µm at',
    'Δln r = 0.002 (2,080 radii), its weights cut below 10⁻⁸ of their peak.',
    'A band (the air’s 680, 550 and 440 nm) is nine wavelengths,',
    'λ_c + (40/9)(2k − 8) nm, under cos²(π(λ − λ_c)/80), each',
    'weighted by what it scatters. Water’s index is Hale and Querry’s (1973)',
    'Table I at 25 °C, linear in λ, with κ = 0. The series is BHMIE’s,',
    'with Wiscombe’s term count.',
    '',
    '`bulk` is [Q_ext, albedo, g] a row, the mean of the three bands.',
    '`gloryRed` is the red band’s first glory ring, degrees from the',
    'antisolar point: the first maximum of p(π − ψ) after its first minimum',
    `past ψ = 0, found on the series at ${GLORY_STEP}° steps, not through this table.`,
  ]
  return (
    '/*\n' +
    header.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    '\n */\nexport const MIE_DROPLETS = ' +
    JSON.stringify(source, null, 2) +
    ' as const\n'
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const start = process.hrtime.bigint()
  const source = generateDroplets()
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  const out = fileURLToPath(
    new URL(
      '../../../packages/rendering/src/mieDroplets.generated.ts',
      import.meta.url,
    ),
  )
  writeFileSync(out, sourceText(source, seconds))
  console.log(
    `mieTable: wrote ${out} in ${seconds.toFixed(1)} s; now run pnpm exec prettier -w on it`,
  )
}
