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

/**
 * The table a source describes. Throws on a file that is not one: committed
 * data that does not decode is a broken build, not a table to draw with.
 */
export function decodeMieTable(source: MieTableSource): MieTable {
  if (source.format !== 'inertialref/mie' || source.version !== 1)
    throw new Error('mieTable: not an inertialref/mie table, version 1')
  const count = source.radii * source.angles * 3
  const bytes = base64Bytes(source.phase)
  if (bytes.length !== count * 2)
    throw new Error(
      `mieTable: the phase holds ${bytes.length} bytes where ${source.radii} × ${source.angles} × 3 half floats are ${count * 2}`,
    )
  if (source.bulk.length !== source.radii)
    throw new Error('mieTable: one bulk entry a row')
  if (source.gloryRed.length !== source.radii)
    throw new Error('mieTable: one glory angle a row')
  const phase = new Float32Array(count)
  for (let i = 0; i < count; i += 1)
    phase[i] = halfToFloat(bytes[2 * i]! | (bytes[2 * i + 1]! << 8))
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
export function angleOf(table: MieTable, index: number): number {
  return (Math.PI / 2) * (1 - Math.cos((Math.PI * index) / (table.angles - 1)))
}

/** The continuous texel index of `theta`, radians: `angleOf`'s inverse. */
export function angleIndex(table: MieTable, theta: number): number {
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
