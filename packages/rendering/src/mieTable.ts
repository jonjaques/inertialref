import type { IceTable } from './iceTable.ts'
import { MIE_DROPLETS } from './mieDroplets.generated.ts'

/*
 * The droplets' Lorenz–Mie phase table: its type, the decoder of the
 * generated file (`apps/ingest/src/mieTable.ts` writes it), and the CPU reads
 * the GPU's lookup is held to.
 *
 * The angular axis is dense at both ends — θ_i = (π/2)(1 − cos(π·i/(n − 1)))
 * puts 0° and 180° on texel centers — because both ends carry the structure:
 * the forward peak and the corona at one, the glory's rings at the other,
 * the first of them 1.9° out for a 10 µm cloud in red, where the texels are
 * 0.057° apart. The radius axis is logarithmic, rows 9.4% apart.
 */

export interface MieTable {
  /** θ_i = (π/2)(1 − cos(π·i/(angles − 1))), both ends dense (§6.4). */
  readonly angles: number
  readonly radii: number
  /** µm: r_j = radiusMin·(radiusMax/radiusMin)^(j/(radii − 1)). */
  readonly radiusMin: number
  readonly radiusMax: number
  /** The gamma's effective variance. */
  readonly variance: number
  /** nm: the air's three bands. */
  readonly bands: readonly [number, number, number]
  readonly wavelengthsPerBand: number
  /** nm. */
  readonly bandHalfWidth: number
  /** sr⁻¹, normalized to ∫p dΩ = 1, laid out [row][angle][band]: radii × angles × 3. */
  readonly phase: Float32Array
  /** Per row: Q_ext, single-scattering albedo and asymmetry, band-averaged. */
  readonly bulk: readonly {
    readonly extinction: number
    readonly albedo: number
    readonly asymmetry: number
  }[]
  /**
   * Per row: the red band's first glory ring, degrees from the antisolar
   * point — the first maximum of p(π − ψ) after its first minimum past ψ = 0 —
   * found by the generator on the series at 0.005° steps, finer than the
   * table's own texels there.
   */
  readonly gloryRed: readonly number[]
}

/** The generated file's form: the table, with its phase as base64 little-endian float16. */
export interface MieTableSource {
  readonly format: 'inertialref/mie'
  readonly version: 1
  readonly angles: number
  readonly radii: number
  readonly radiusMin: number
  readonly radiusMax: number
  readonly variance: number
  readonly bands: readonly [number, number, number]
  readonly wavelengthsPerBand: number
  readonly bandHalfWidth: number
  /** Where the refractive index came from. */
  readonly index: string
  readonly phase: string
  /** Per row: [Q_ext, albedo, asymmetry]. */
  readonly bulk: readonly (readonly [number, number, number])[]
  readonly gloryRed: readonly number[]
}

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = /*@__PURE__*/ (() => {
  const digits = new Int8Array(128).fill(-1)
  for (let i = 0; i < BASE64.length; i += 1) digits[BASE64.charCodeAt(i)] = i
  return digits
})()

/** Base64 to bytes; the core project's lib has no `atob`. */
function base64Bytes(text: string): Uint8Array {
  const body = text.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4))
  let value = 0
  let bits = 0
  let j = 0
  for (let i = 0; i < body.length; i += 1) {
    const code = body.charCodeAt(i)
    const digit = code < 128 ? (DIGITS[code] ?? -1) : -1
    if (digit < 0) throw new Error(`mieTable: '${body[i]}' is not base64`)
    value = ((value << 6) | digit) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[j] = (value >> bits) & 0xff
      j += 1
    }
  }
  return bytes
}

function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1
  const exponent = (half >> 10) & 0x1f
  const mantissa = half & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

const FLOAT = new Float32Array(1)
const FLOAT_BITS = new Uint32Array(FLOAT.buffer)

/**
 * IEEE binary16 bits of `value` as a float32 holds it, rounded to nearest,
 * ties to even: `Math.f16round`'s rounding of a float32, as bits. Written
 * out because a worker holds no `three` to convert with, and `Math.f16round`
 * is younger than some browsers WebGPU runs in; and not three's
 * `DataUtils.toHalfFloat`, which truncates. Past 65504 it is an infinity,
 * as the standard's rounding is.
 */
export function halfBitsOf(value: number): number {
  FLOAT[0] = value
  const bits = FLOAT_BITS[0]!
  const sign = (bits >>> 16) & 0x8000
  const exponent = (bits >>> 23) & 0xff
  const mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200)
  const biased = exponent - 112
  if (biased >= 0x1f) return sign | 0x7c00
  const round = (kept: number, rest: number, half: number): number =>
    rest > half || (rest === half && (kept & 1) === 1) ? kept + 1 : kept
  if (biased <= 0) {
    // A subnormal half, or nothing: the implicit bit joins the mantissa.
    if (biased < -10) return sign
    const shift = 14 - biased
    const full = mantissa | 0x800000
    return (
      sign | round(full >>> shift, full & ((1 << shift) - 1), 1 << (shift - 1))
    )
  }
  // A carry out of the mantissa steps the exponent, up to the infinity.
  return (
    sign | round((biased << 10) | (mantissa >>> 13), mantissa & 0x1fff, 0x1000)
  )
}

/** Each value's `halfBitsOf`, in order: an atlas as its RGBA16F texels. */
export function toHalves(values: Float32Array): Uint16Array {
  const halves = new Uint16Array(values.length)
  for (let k = 0; k < values.length; k += 1) halves[k] = halfBitsOf(values[k]!)
  return halves
}

/**
 * `count` little-endian half floats from base64, as a phase table holds its
 * texels. Throws where the text holds another number of them: `what` names
 * the table and its shape in the message.
 */
export function halfFloatsFromBase64(
  text: string,
  count: number,
  what: string,
): Float32Array {
  const bytes = base64Bytes(text)
  if (bytes.length !== count * 2)
    throw new Error(
      `${what}: the phase holds ${bytes.length} bytes where ${count} half floats are ${count * 2}`,
    )
  const values = new Float32Array(count)
  for (let i = 0; i < count; i += 1)
    values[i] = halfToFloat(bytes[2 * i]! | (bytes[2 * i + 1]! << 8))
  return values
}

/**
 * The table a source describes. Throws on a file that is not one: committed
 * data that does not decode is a broken build, not a table to draw with.
 */
export function decodeMieTable(source: MieTableSource): MieTable {
  if (source.format !== 'inertialref/mie' || source.version !== 1)
    throw new Error('mieTable: not an inertialref/mie table, version 1')
  const count = source.radii * source.angles * 3
  const phase = halfFloatsFromBase64(
    source.phase,
    count,
    `mieTable (${source.radii} × ${source.angles} × 3)`,
  )
  if (source.bulk.length !== source.radii)
    throw new Error('mieTable: one bulk entry a row')
  if (source.gloryRed.length !== source.radii)
    throw new Error('mieTable: one glory angle a row')
  return {
    angles: source.angles,
    radii: source.radii,
    radiusMin: source.radiusMin,
    radiusMax: source.radiusMax,
    variance: source.variance,
    bands: source.bands,
    wavelengthsPerBand: source.wavelengthsPerBand,
    bandHalfWidth: source.bandHalfWidth,
    phase,
    bulk: source.bulk.map(([extinction, albedo, asymmetry]) => ({
      extinction,
      albedo,
      asymmetry,
    })),
    gloryRed: source.gloryRed,
  }
}

/** The committed droplet table, decoded afresh: a caller owns what it gets. */
export function mieDroplets(): MieTable {
  return decodeMieTable(MIE_DROPLETS)
}

/** Radians. */
export function angleOf(
  table: { readonly angles: number },
  index: number,
): number {
  return (Math.PI / 2) * (1 - Math.cos((Math.PI * index) / (table.angles - 1)))
}

/** The continuous texel index of `theta`, radians: `angleOf`'s inverse. */
export function angleIndex(
  table: { readonly angles: number },
  theta: number,
): number {
  const c = Math.min(1, Math.max(-1, 1 - (2 * theta) / Math.PI))
  return ((table.angles - 1) * Math.acos(c)) / Math.PI
}

/** µm. */
export function radiusOf(table: MieTable, row: number): number {
  return (
    table.radiusMin *
    (table.radiusMax / table.radiusMin) ** (row / (table.radii - 1))
  )
}

/** The continuous row of `radius`, µm: `radiusOf`'s inverse. */
export function radiusIndex(table: MieTable, radius: number): number {
  return (
    ((table.radii - 1) * Math.log(radius / table.radiusMin)) /
    Math.log(table.radiusMax / table.radiusMin)
  )
}

/** Bilinear in (angle index, row), per band, clamped at both axes' ends: what the GPU's linear read does. */
export function samplePhase(
  table: MieTable,
  cosTheta: number,
  radius: number,
): readonly [number, number, number] {
  const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)))
  const a = Math.min(table.angles - 1, Math.max(0, angleIndex(table, theta)))
  const r = Math.min(table.radii - 1, Math.max(0, radiusIndex(table, radius)))
  const a0 = Math.floor(a)
  const r0 = Math.floor(r)
  const a1 = Math.min(a0 + 1, table.angles - 1)
  const r1 = Math.min(r0 + 1, table.radii - 1)
  const fa = a - a0
  const fr = r - r0
  const at = (row: number, angle: number, band: number): number =>
    table.phase[(row * table.angles + angle) * 3 + band]!
  const band = (b: number): number => {
    const near = at(r0, a0, b) + (at(r0, a1, b) - at(r0, a0, b)) * fa
    const far = at(r1, a0, b) + (at(r1, a1, b) - at(r1, a0, b)) * fa
    return near + (far - near) * fr
  }
  return [band(0), band(1), band(2)]
}

/** ∫p dΩ of one row and band over the table's own grid (trapezoid in θ with sin θ). */
export function phaseIntegral(
  table: MieTable,
  row: number,
  band: number,
): number {
  let sum = 0
  const at = (i: number): number =>
    table.phase[(row * table.angles + i) * 3 + band]! *
    Math.sin(angleOf(table, i))
  for (let i = 0; i + 1 < table.angles; i += 1)
    sum +=
      0.5 * (at(i) + at(i + 1)) * (angleOf(table, i + 1) - angleOf(table, i))
  return 2 * Math.PI * sum
}

/**
 * `f_δ = 1/Q_ext` at a radius, µm: the diffraction's share of a droplet's
 * extinction, which the scaled medium counts as light that goes on (phase 1
 * design §5.1). Linear in the row between the rows' own `1/Q_ext`, clamped
 * at the table's ends, so at a row's radius it is that row's exactly.
 */
export function diffractionShare(table: MieTable, radius: number): number {
  const row = Math.min(table.radii - 1, Math.max(0, radiusIndex(table, radius)))
  const low = Math.floor(row)
  const high = Math.min(low + 1, table.radii - 1)
  const share = (k: number): number => 1 / table.bulk[k]!.extinction
  return share(low) + (share(high) - share(low)) * (row - low)
}

/* ------------------------------------------------------------------------- */
/* The sun's disk                                                             */
/* ------------------------------------------------------------------------- */

/** A phase table's angular rows, whatever its class: what the disk's convolution reads. */
export interface PhaseRows {
  /** θ_i = (π/2)(1 − cos(π·i/(angles − 1))). */
  readonly angles: number
  /** sr⁻¹, laid out [row][angle][band]: rows × angles × 3. */
  readonly phase: Float32Array
}

/** Gauss–Legendre nodes on [−1, 1] and their weights, by Newton's method on P_n. */
function gaussLegendre(n: number): {
  readonly nodes: Float64Array
  readonly weights: Float64Array
} {
  const nodes = new Float64Array(n)
  const weights = new Float64Array(n)
  for (let k = 0; k < n; k += 1) {
    let x = Math.cos((Math.PI * (k + 0.75)) / (n + 0.5))
    let slope = 1
    for (let step = 0; step < 100; step += 1) {
      let p0 = 1
      let p1 = x
      for (let l = 2; l <= n; l += 1) {
        const p2 = ((2 * l - 1) * x * p1 - (l - 1) * p0) / l
        p0 = p1
        p1 = p2
      }
      slope = (n * (x * p1 - p0)) / (x * x - 1)
      const dx = p1 / slope
      x -= dx
      if (Math.abs(dx) < 1e-16) break
    }
    nodes[k] = x
    weights[k] = 2 / ((1 - x * x) * slope * slope)
  }
  return { nodes, weights }
}

/** Nodes a piece of the disk's integral: the design's sixteen (§5.4). */
const DISK_NODES = 16
const GAUSS = /*@__PURE__*/ gaussLegendre(DISK_NODES)

/**
 * One texel's convolution as a sum over the table's own texels. Node k
 * stands at a continuous texel index whose four neighbors, reflected at the
 * axis's ends, are `texels[4k…4k + 3]`, with Catmull–Rom's weights for its
 * fraction in `blend[4k…]`, and it weighs its value by `weight[k]`. Texel
 * k's nodes are `start[k]` up to `start[k + 1]`, and their weights sum to one.
 */
interface DiskKernel {
  readonly start: Int32Array
  readonly texels: Int32Array
  readonly blend: Float64Array
  readonly weight: Float64Array
}

/** A texel index past the axis's ends, reflected: the phase is even through both poles. */
function reflected(index: number, angles: number): number {
  const last = angles - 1
  const folded = index < 0 ? -index : index > last ? 2 * last - index : index
  return Math.min(last, Math.max(0, folded))
}

/**
 * The disk's weights for every texel of a table of `angles` angles, shared
 * by every row and band: one row and band costs a weighted sum.
 *
 * The cap's azimuthal extent at polar angle θ′ about the forward axis is
 * 2·φ_max, with sin²(φ_max/2) = sin((α + δ)/2)·sin((α − δ)/2)/(sin θ′·sin Θ)
 * and δ = θ′ − Θ: the design's acos form, rewritten so nothing subtracts two
 * cosines near one, which near either pole is where all the structure is and
 * where the acos form's numerator cancels to nothing. The integral runs in
 * pieces: where the whole ring lies in the cap (θ′ < α − Θ, or past
 * 2π − Θ − α) its extent is 2π, and the piece between has a square-root
 * edge at each end, which `θ′ = c + h·sin(πx/2)` takes out before sixteen
 * Gauss–Legendre nodes. The weights are normalized by their own sum, not by
 * Ω_c, so a constant phase convolves to itself exactly.
 */
function diskKernel(angles: number, alpha: number): DiskKernel {
  const texels: number[] = []
  const blend: number[] = []
  const weights: number[] = []
  const start = new Int32Array(angles + 1)
  const table = { angles }
  for (let i = 0; i < angles; i += 1) {
    start[i] = weights.length
    const center = angleOf(table, i)
    const sinCenter = Math.sin(center)
    const pieces: [from: number, to: number, whole: boolean][] = []
    if (alpha > center) pieces.push([0, alpha - center, true])
    const from = Math.abs(center - alpha)
    const to = Math.min(center + alpha, 2 * Math.PI - center - alpha)
    if (to > from) pieces.push([from, to, false])
    if (alpha > Math.PI - center)
      pieces.push([2 * Math.PI - center - alpha, Math.PI, true])
    const first = weights.length
    let total = 0
    for (const [a, b, whole] of pieces) {
      const middle = (a + b) / 2
      const half = (b - a) / 2
      for (let k = 0; k < DISK_NODES; k += 1) {
        const x = GAUSS.nodes[k]!
        const theta = middle + half * Math.sin((Math.PI / 2) * x)
        const sinTheta = Math.sin(theta)
        let extent = Math.PI
        if (!whole) {
          const delta = theta - center
          const ratio =
            (Math.sin((alpha + delta) / 2) * Math.sin((alpha - delta) / 2)) /
            (sinTheta * sinCenter)
          extent = 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, ratio))))
        }
        const weight =
          GAUSS.weights[k]! *
          (Math.PI / 2) *
          half *
          Math.cos((Math.PI / 2) * x) *
          2 *
          extent *
          sinTheta
        const index = Math.min(
          angles - 1,
          Math.max(0, angleIndex(table, theta)),
        )
        const lower = Math.min(Math.floor(index), angles - 2)
        const f = index - lower
        for (let j = -1; j <= 2; j += 1)
          texels.push(reflected(lower + j, angles))
        blend.push(
          0.5 * (-f + 2 * f * f - f * f * f),
          0.5 * (2 - 5 * f * f + 3 * f * f * f),
          0.5 * (f + 4 * f * f - 3 * f * f * f),
          0.5 * (-f * f + f * f * f),
        )
        weights.push(weight)
        total += weight
      }
    }
    for (let k = first; k < weights.length; k += 1) weights[k]! /= total
  }
  start[angles] = weights.length
  return {
    start,
    texels: Int32Array.from(texels),
    blend: Float64Array.from(blend),
    weight: Float64Array.from(weights),
  }
}

/**
 * The table's phase as a sun of angular radius `angularRadius`, radians,
 * draws it: each row and band averaged over the sun's disk, in the table's
 * own layout, [row][angle][band] (phase 1 design §5.4):
 *
 *   p̃(Θ) = (1/Ω_c) ∫ p(θ′)·2·φ_max(Θ, θ′)·sin θ′ dθ′
 *
 * Under a point sun, an angular radius of zero, the phase is the table's
 * own, texel for texel. Each row's integral is kept: averaging over a cap
 * moves light between directions and makes none.
 *
 * Between texels the phase is read cubically in its logarithm (Catmull–Rom
 * in the texel index), not linearly as `samplePhase` reads it. A texel is a
 * sample of the phase, and the forward peak's flank falls as a power of
 * the angle, which a straight line between two samples overestimates: read
 * linearly, the disk's average took that excess in, and the committed
 * table's largest row gained 8 × 10⁻⁴ of its integral, and a
 * Henyey–Greenstein phase at g = 0.99 was 8 × 10⁻⁴ high at 1.4°. Cubic in
 * the logarithm, those are 1.4 × 10⁻⁵ and 2 × 10⁻⁶.
 */
export function convolveDisk(
  table: PhaseRows,
  angularRadius: number,
): Float32Array {
  if (!(angularRadius >= 0 && angularRadius < Math.PI / 2))
    throw new Error(
      `convolveDisk: a sun of angular radius ${angularRadius} rad is not a disk`,
    )
  if (angularRadius === 0) return Float32Array.from(table.phase)
  const { angles, phase } = table
  const rows = phase.length / (angles * 3)
  const kernel = diskKernel(angles, angularRadius)
  const out = new Float32Array(phase.length)
  const logs = new Float64Array(angles)
  for (let row = 0; row < rows; row += 1)
    for (let band = 0; band < 3; band += 1) {
      const at = (i: number): number => (row * angles + i) * 3 + band
      for (let i = 0; i < angles; i += 1) logs[i] = Math.log(phase[at(i)]!)
      for (let i = 0; i < angles; i += 1) {
        let sum = 0
        for (let k = kernel.start[i]!; k < kernel.start[i + 1]!; k += 1) {
          let log = 0
          for (let j = 0; j < 4; j += 1)
            log += kernel.blend[4 * k + j]! * logs[kernel.texels[4 * k + j]!]!
          sum += kernel.weight[k]! * Math.exp(log)
        }
        out[at(i)] = sum
      }
    }
  return out
}

/* ------------------------------------------------------------------------- */
/* The phase atlas                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The phase atlas's rows (phase 1 design §4.4): the droplets, then the ice,
 * then rows held for rain and dust. A class's rows are its table's, and a
 * slot its table does not fill stays zero: the read clamps inside the rows a
 * level's class names, so no fetch reaches one.
 */
export const PHASE_ATLAS = {
  rows: 64,
  dropletRow: 0,
  dropletRows: 32,
  iceRow: 32,
  iceRows: 23,
} as const

export interface PhaseAtlas {
  /** Texels across: the droplet table's angles. */
  readonly width: number
  readonly height: number
  /**
   * [row][angle][rgba]: the phase per band, sr⁻¹, convolved with the sun's
   * disk, in rgb, and the row's gain, 1/(1 − f_δ), in a.
   */
  readonly texels: Float32Array
  /** Rows each class fills, from its first. */
  readonly dropletRows: number
  readonly iceRows: number
  /** Radians: the disk it was convolved with. */
  readonly angularRadius: number
}

/** 1/(1 − f_δ) of a row whose extinction efficiency is `extinction`, f_δ = 1/Q_ext. */
function gainOf(extinction: number): number {
  if (!(extinction > 1))
    throw new Error(
      `phaseAtlas: a Q_ext of ${extinction} leaves no light past the diffraction`,
    )
  return 1 / (1 - 1 / extinction)
}

/**
 * A table's rows on `angles` angles of the same warped axis, linear in the
 * texel index between its own: the ice table is generated on the droplets'
 * axis and copied as it is, and only a stand-in with fewer angles is
 * resampled.
 */
function onAngles(table: PhaseRows, rows: number, angles: number): PhaseRows {
  if (table.angles === angles) return table
  const phase = new Float32Array(rows * angles * 3)
  for (let i = 0; i < angles; i += 1) {
    const index = angleIndex(table, angleOf({ angles }, i))
    const lower = Math.min(Math.floor(index), table.angles - 2)
    const f = index - lower
    for (let row = 0; row < rows; row += 1)
      for (let band = 0; band < 3; band += 1) {
        const at = (row * table.angles + lower) * 3 + band
        const low = table.phase[at]!
        phase[(row * angles + i) * 3 + band] =
          low + (table.phase[at + 3]! - low) * f
      }
  }
  return { angles, phase }
}

/**
 * The phase atlas's texels: the droplets' rows and the ice's, each convolved
 * with a sun of angular radius `angularRadius`, radians, with each row's
 * gain beside its phase, so first order takes `1/(1 − f_δ)` at a sample's
 * own radius from the fetch it already makes (§4.4). Through an adiabatic
 * level the radius doubles and `1 − f_δ` moves 4%, which a level's constant
 * would put into first order at one end.
 */
export function phaseAtlas(
  droplets: MieTable,
  ice: IceTable,
  angularRadius: number,
): PhaseAtlas {
  const { rows, dropletRow, dropletRows, iceRow, iceRows } = PHASE_ATLAS
  if (droplets.radii > dropletRows || ice.diameters > iceRows)
    throw new Error(
      `phaseAtlas: ${droplets.radii} droplet rows and ${ice.diameters} ice rows where the atlas holds ${dropletRows} and ${iceRows}`,
    )
  if (ice.bands.some((band, k) => band !== droplets.bands[k]))
    throw new Error('phaseAtlas: the ice table’s bands are not the droplets’')
  const width = droplets.angles
  const texels = new Float32Array(width * rows * 4)
  const place = (
    first: number,
    table: PhaseRows,
    gains: readonly number[],
  ): void => {
    const phase = convolveDisk(table, angularRadius)
    gains.forEach((gain, row) => {
      for (let i = 0; i < width; i += 1) {
        const to = ((first + row) * width + i) * 4
        const from = (row * width + i) * 3
        texels[to] = phase[from]!
        texels[to + 1] = phase[from + 1]!
        texels[to + 2] = phase[from + 2]!
        texels[to + 3] = gain
      }
    })
  }
  place(
    dropletRow,
    droplets,
    droplets.bulk.map((b) => gainOf(b.extinction)),
  )
  place(
    iceRow,
    onAngles(ice, ice.diameters, width),
    ice.bulk.map((b) => gainOf(b.extinction)),
  )
  return {
    width,
    height: rows,
    texels,
    dropletRows: droplets.radii,
    iceRows: ice.diameters,
    angularRadius,
  }
}

/**
 * The atlas read at cos θ and a continuous atlas row, bilinear and clamped at
 * the angle axis's ends, rgba: what the GPU's linear read of it does. The
 * row is the caller's, already clamped inside its class: `radiusIndex` for
 * the droplets, `iceRowIndex` for the ice, each from its class's first row.
 */
export function sampleAtlas(
  atlas: PhaseAtlas,
  cosTheta: number,
  row: number,
): readonly [number, number, number, number] {
  const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)))
  const angles = { angles: atlas.width }
  const a = Math.min(atlas.width - 1, Math.max(0, angleIndex(angles, theta)))
  const r = Math.min(atlas.height - 1, Math.max(0, row))
  const a0 = Math.floor(a)
  const r0 = Math.floor(r)
  const a1 = Math.min(a0 + 1, atlas.width - 1)
  const r1 = Math.min(r0 + 1, atlas.height - 1)
  const at = (j: number, i: number, c: number): number =>
    atlas.texels[(j * atlas.width + i) * 4 + c]!
  const channel = (c: number): number => {
    const near = at(r0, a0, c) + (at(r0, a1, c) - at(r0, a0, c)) * (a - a0)
    const far = at(r1, a0, c) + (at(r1, a1, c) - at(r1, a0, c)) * (a - a0)
    return near + (far - near) * (r - r0)
  }
  return [channel(0), channel(1), channel(2), channel(3)]
}
