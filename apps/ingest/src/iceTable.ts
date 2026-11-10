import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { AIR_BANDS, type IceTableSource } from '@inertialref/rendering'
import { DROPLET_TABLE, encodePhase, tableAngle } from './mieTable.ts'
import { BAUM_DIAMETERS, BAUM_ICE } from './weatherSources.ts'

/*
 * The ice rows' generator: `node apps/ingest/src/iceTable.ts` reads Baum's
 * severely roughened aggregate of solid columns from `.data/weather/baum/`
 * and writes `packages/rendering/src/iceAggregate.generated.ts`, then
 * `pnpm exec prettier -w` formats it.
 *
 * The files are NetCDF-3 classic (`CDF\x01`), not NetCDF-4: they are not
 * HDF5, so `h5wasm`, which reads ISCCP-H, cannot open them. The classic
 * format is a fixed header and big-endian arrays at stated offsets, and the
 * reader below is the subset these files use: no record dimension, and
 * only float and double arrays.
 *
 * A row is one of the set's 23 effective diameters, already a bulk over
 * Baum's measured size distributions, so nothing here integrates over size.
 * What the reduction does is the droplet table's own band average, its
 * angular axis and its normalization, so the atlas holds both classes on
 * one layout and reads them by one lookup.
 */

/* ------------------------------------------------------------------------- */
/* NetCDF classic                                                             */
/* ------------------------------------------------------------------------- */

/** A classic file's header, and its arrays read on demand. */
export interface Netcdf {
  readonly dimensions: ReadonlyMap<string, number>
  /** Global attributes: text as a string, numbers as an array. */
  readonly attributes: ReadonlyMap<string, string | readonly number[]>
  /** A variable's dimension names, outermost first. */
  shape(name: string): readonly string[]
  /** A float or double variable, C order (its last dimension fastest), as float64. */
  read(name: string): Float64Array
}

const ABSENT = 0
const NC_DIMENSION = 10
const NC_VARIABLE = 11
const NC_ATTRIBUTE = 12
/** Bytes per value of the classic types, by their codes 1 to 6: byte, char, short, int, float, double. */
const TYPE_BYTES = [0, 1, 1, 2, 4, 4, 8] as const
const NC_FLOAT = 5
const NC_DOUBLE = 6

interface VariableHeader {
  readonly dimensions: readonly string[]
  readonly count: number
  readonly type: number
  readonly begin: number
}

/** A cursor over a classic header: every count and offset is big-endian, every block padded to four bytes. */
class Header {
  readonly #view: DataView
  readonly #bytes: Uint8Array
  readonly #text = new TextDecoder('utf-8', { fatal: true })
  at = 4
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  int(): number {
    if (this.at + 4 > this.#bytes.length)
      throw new Error('netcdf: the header runs past the file')
    const value = this.#view.getInt32(this.at)
    this.at += 4
    return value
  }
  long(): number {
    const high = this.int()
    const low = this.int() >>> 0
    return high * 2 ** 32 + low
  }
  name(): string {
    const length = this.int()
    const text = this.#text.decode(
      this.#bytes.subarray(this.at, this.at + length),
    )
    this.at += (length + 3) & ~3
    return text
  }
  values(type: number, count: number): string | readonly number[] {
    const size = TYPE_BYTES[type]
    if (size === undefined || type === 0)
      throw new Error(`netcdf: no classic type ${type}`)
    const start = this.at
    this.at += (count * size + 3) & ~3
    if (type === 2)
      return this.#text.decode(this.#bytes.subarray(start, start + count))
    return Array.from({ length: count }, (_, k) => {
      const p = start + k * size
      if (type === 1) return this.#view.getInt8(p)
      if (type === 3) return this.#view.getInt16(p)
      if (type === 4) return this.#view.getInt32(p)
      if (type === NC_FLOAT) return this.#view.getFloat32(p)
      return this.#view.getFloat64(p)
    })
  }
  /** A list's tag and length: ABSENT is a zero tag and a zero length. */
  list(tag: number): number {
    const found = this.int()
    const count = this.int()
    if (found === ABSENT && count === 0) return 0
    if (found !== tag)
      throw new Error(`netcdf: a list tagged ${found} where ${tag} belongs`)
    return count
  }
  attributes(): Map<string, string | readonly number[]> {
    const out = new Map<string, string | readonly number[]>()
    const count = this.list(NC_ATTRIBUTE)
    for (let k = 0; k < count; k += 1) {
      const name = this.name()
      const type = this.int()
      out.set(name, this.values(type, this.int()))
    }
    return out
  }
}

/**
 * A NetCDF classic file's header and its arrays. Refuses NetCDF-4 (HDF5),
 * the 64-bit-data format, and a record dimension, none of which these
 * files use, rather than misreading them.
 */
export function readNetcdf(bytes: Uint8Array): Netcdf {
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!)
  const version = bytes[3]!
  if (magic !== 'CDF' || (version !== 1 && version !== 2))
    throw new Error(
      `netcdf: not a classic file (it opens ${JSON.stringify(magic)} version ${version})`,
    )
  const header = new Header(bytes)
  if (header.int() !== 0)
    throw new Error('netcdf: a record dimension, which this reader refuses')
  const dimensions = new Map<string, number>()
  const names: string[] = []
  for (let k = header.list(NC_DIMENSION); k > 0; k -= 1) {
    const name = header.name()
    const length = header.int()
    if (length === 0) throw new Error(`netcdf: ${name} is the record dimension`)
    names.push(name)
    dimensions.set(name, length)
  }
  const attributes = header.attributes()
  const variables = new Map<string, VariableHeader>()
  for (let k = header.list(NC_VARIABLE); k > 0; k -= 1) {
    const name = header.name()
    const ids = Array.from({ length: header.int() }, () => header.int())
    header.attributes()
    const type = header.int()
    header.int() // vsize: the padded size, which the shape already gives
    const begin = version === 1 ? header.int() : header.long()
    const dims = ids.map((id) => names[id]!)
    const count = dims.reduce((n, d) => n * dimensions.get(d)!, 1)
    variables.set(name, { dimensions: dims, count, type, begin })
  }
  const variable = (name: string): VariableHeader => {
    const found = variables.get(name)
    if (found === undefined) throw new Error(`netcdf: no variable ${name}`)
    return found
  }
  return {
    dimensions,
    attributes,
    shape: (name) => variable(name).dimensions,
    read(name) {
      const { count, type, begin } = variable(name)
      if (type !== NC_FLOAT && type !== NC_DOUBLE)
        throw new Error(`netcdf: ${name} is type ${type}, not float or double`)
      const size = TYPE_BYTES[type]
      if (begin + count * size > bytes.length)
        throw new Error(`netcdf: ${name} runs past the file`)
      const view = new DataView(bytes.buffer, bytes.byteOffset + begin)
      return Float64Array.from({ length: count }, (_, k) =>
        type === NC_FLOAT
          ? view.getFloat32(k * size)
          : view.getFloat64(k * size),
      )
    },
  }
}

/* ------------------------------------------------------------------------- */
/* The source                                                                 */
/* ------------------------------------------------------------------------- */

/** One file read: its name, its size in bytes and its SHA-256, hex. */
export interface IceSourceFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

/** The three files the table is made from, by role. */
export const BAUM_FILES = {
  phase:
    'AggregateSolidColumns_SeverelyRough_AllWavelengths_FullPhaseMatrix.nc.gz',
  bulk: 'AggregateSolidColumns_SeverelyRough_AllWavelengths_NoPhaseMatrix.nc',
  readme: 'README.txt',
} as const

/*
 * What each file weighed and hashed to the day the table was made. A file
 * that differs is refused, so the table is rebuilt only from the bytes it
 * was made from; a new release is a change made here on purpose. The hash
 * of the phase file is of the gzip the archive holds, not of the NetCDF
 * inside it.
 */
export const BAUM_MANIFEST: readonly IceSourceFile[] = [
  {
    name: BAUM_FILES.phase,
    bytes: 54_438_395,
    sha256: '5c21fdfc234138358a630e8def696d1bae50d72d0fb62b5f0b70c9d37ac4d312',
  },
  {
    name: BAUM_FILES.bulk,
    bytes: 248_248,
    sha256: '7af93395c9cacd879e07ed8662a3414c443e9d8b14c15b06686bce469fbd34a1',
  },
  {
    name: BAUM_FILES.readme,
    bytes: 2_122,
    sha256: '89f674faeef9c82b366f0d0ceaee44ca05f2253935d56fb02d81f1dd045d3b46',
  },
]

/*
 * The README's own words that the table's record quotes. Read from the
 * file, not assumed: the generator refuses a README without them, and one
 * that names a license or terms of use, so "no license or terms of use are
 * stated" is a fact about these bytes.
 */
export const README_DATE = BAUM_ICE.sourceDate
export const README_METHOD =
  'please refer to the 2011 paper for details - the methodology has not changed in the meantime.'

/**
 * Where the archive is extracted: `.data/weather/baum` under the main
 * checkout, found from `root` through git, so every worktree reads one
 * copy. Outside a git checkout it is the directory under `root` itself.
 */
export function baumCache(root: string): string {
  let common: string
  try {
    common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return join(root, BAUM_ICE.cache)
  }
  const directory = isAbsolute(common) ? common : resolve(root, common)
  return join(dirname(directory), BAUM_ICE.cache)
}

/** Whether every file the table is made from is in `cache`. */
export function baumCached(cache: string): boolean {
  return Object.values(BAUM_FILES).every((name) =>
    existsSync(join(cache, name)),
  )
}

/** A file's bytes, held to the manifest: its size and its hash, or a refusal. */
export function readListed(cache: string, name: string): Uint8Array {
  const bytes = readFileSync(join(cache, name))
  const listed = BAUM_MANIFEST.find((entry) => entry.name === name)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (listed === undefined)
    throw new Error(`iceTable: ${name} is not in the manifest`)
  if (listed.bytes !== bytes.byteLength || listed.sha256 !== sha256)
    throw new Error(
      `iceTable: ${name} is ${bytes.byteLength} bytes hashing to ${sha256}, where the manifest records ${listed.bytes} and ${listed.sha256}`,
    )
  return bytes
}

/** The README's text, held to the words the record quotes and to stating no terms. */
export function checkReadme(text: string): void {
  const flat = text.replace(/\s+/g, ' ')
  for (const words of [README_DATE, README_METHOD])
    if (!flat.includes(words))
      throw new Error(`iceTable: the README does not say "${words}"`)
  const terms = /licen[cs]e|terms of use|copyright|permission/i.exec(flat)
  if (terms !== null)
    throw new Error(
      `iceTable: the README says "${terms[0]}", so "no license stated" is not true of it`,
    )
}

/** One habit's single-scattering set: the phase file's P11 and the bulk file's properties. */
export interface IceModel {
  /** µm. */
  readonly wavelengths: Float64Array
  /** µm: the rows. */
  readonly diameters: Float64Array
  /** Degrees, ascending. */
  readonly angles: Float64Array
  /** [angle][diameter][wavelength], normalized as Baum's: (1/2)∫P11 sin θ dθ = 1. */
  readonly p11: Float64Array
  /** [diameter][wavelength] each. */
  readonly extinction: Float64Array
  readonly albedo: Float64Array
  readonly asymmetry: Float64Array
  /** µm² a particle, [diameter][wavelength]: the size distribution's projected area. */
  readonly area: Float64Array
}

const BULK = [
  'extinction_efficiency',
  'single_scattering_albedo',
  'asymmetry_parameter',
  'total_area',
] as const

const sameArrays = (a: Float64Array, b: Float64Array): boolean =>
  a.length === b.length && a.every((value, k) => value === b[k])

function checkShape(file: Netcdf, name: string, dims: readonly string[]): void {
  const shape = file.shape(name)
  if (shape.join(' × ') !== dims.join(' × '))
    throw new Error(
      `iceTable: ${name} is ${shape.join(' × ')}, where ${dims.join(' × ')} belongs`,
    )
}

/** What a set's files must hold: the README's counts, and its diameters. */
export interface IceLayout {
  readonly counts: {
    readonly nDeff: number
    readonly nScatAng: number
    readonly nWaveLen: number
  }
  readonly diameters: { readonly least: number; readonly step: number }
}

/** Baum's: 23 diameters from 10 µm in steps of 5, 498 angles, 445 wavelengths. */
export const BAUM_LAYOUT: IceLayout = {
  counts: { nDeff: BAUM_DIAMETERS.count, nScatAng: 498, nWaveLen: 445 },
  diameters: BAUM_DIAMETERS,
}

/**
 * The model the two files hold, held to the README's counts and to each
 * other: the bulk file's properties must be the phase file's own copies of
 * them, and its axes the same.
 */
export function iceModel(
  phaseFile: Netcdf,
  bulkFile: Netcdf,
  layout: IceLayout = BAUM_LAYOUT,
): IceModel {
  for (const file of [phaseFile, bulkFile])
    for (const [dim, count] of Object.entries(layout.counts))
      if (file.dimensions.get(dim) !== count)
        throw new Error(
          `iceTable: ${dim} is ${file.dimensions.get(dim)}, where the README says ${count}`,
        )
  checkShape(phaseFile, 'p11_phase_function', ['nScatAng', 'nDeff', 'nWaveLen'])
  for (const name of BULK) checkShape(bulkFile, name, ['nDeff', 'nWaveLen'])
  for (const name of ['wavelengths', 'effective_diameter', ...BULK])
    if (!sameArrays(phaseFile.read(name), bulkFile.read(name)))
      throw new Error(`iceTable: the two files' ${name} differ`)
  const diameters = bulkFile.read('effective_diameter')
  const { least, step } = layout.diameters
  if (diameters.some((d, j) => d !== least + j * step))
    throw new Error(
      `iceTable: the effective diameters are ${[...diameters].join(', ')}`,
    )
  const angles = phaseFile.read('phase_angles')
  if (angles.some((a, i) => i > 0 && !(a > angles[i - 1]!)))
    throw new Error('iceTable: the phase angles do not ascend')
  // The table's axis runs 0° to 180° and the reduction never extrapolates:
  // a set that stops short of either end is refused, not continued.
  if (angles[0] !== 0 || angles[angles.length - 1] !== 180)
    throw new Error(
      `iceTable: the phase angles run ${angles[0]}° to ${angles[angles.length - 1]}°, not 0° to 180°`,
    )
  return {
    wavelengths: bulkFile.read('wavelengths'),
    diameters,
    angles,
    p11: phaseFile.read('p11_phase_function'),
    extinction: bulkFile.read('extinction_efficiency'),
    albedo: bulkFile.read('single_scattering_albedo'),
    asymmetry: bulkFile.read('asymmetry_parameter'),
    area: bulkFile.read('total_area'),
  }
}

/** The aggregate's model and the README, from the extracted archive, every file held to the manifest. */
export function readBaum(cache: string): IceModel {
  checkReadme(
    new TextDecoder('utf-8', { fatal: true }).decode(
      readListed(cache, BAUM_FILES.readme),
    ),
  )
  return iceModel(
    readNetcdf(gunzipSync(readListed(cache, BAUM_FILES.phase))),
    readNetcdf(readListed(cache, BAUM_FILES.bulk)),
  )
}

/* ------------------------------------------------------------------------- */
/* The reduction                                                              */
/* ------------------------------------------------------------------------- */

/** A band's wavelengths, by index into the model's, and their weights, summing to 1. */
export interface IceBand {
  readonly center: number
  readonly indices: readonly number[]
  readonly weights: readonly number[]
  /** True where the band held fewer than two of the set's wavelengths and took its two nearest. */
  readonly nearest: boolean
}

/**
 * A band of center `center` nm over the set's wavelengths: every wavelength
 * strictly inside ±`bandHalfWidth`, under the droplet table's own raised
 * cosine, cos²(π(λ − λ_c)/(2·half)). A band holding fewer than two takes
 * the two nearest instead, weighted linearly to the center, because the
 * raised cosine is zero at its own edge and would weight a wavelength past
 * it by nothing.
 */
export function iceBand(wavelengths: Float64Array, center: number): IceBand {
  const half = DROPLET_TABLE.bandHalfWidth
  // The file holds µm in float32, so 0.59 reads as 589.99999 nm: rounded to
  // a picometer, a wavelength on the band's edge is on it, and is left out
  // with the zero weight it would carry.
  const nm = Array.from(wavelengths, (um) => Math.round(um * 1e6) / 1000)
  const inside = nm.flatMap((l, k) => (Math.abs(l - center) < half ? [k] : []))
  if (inside.length >= 2) {
    const raw = inside.map(
      (k) => Math.cos((Math.PI * (nm[k]! - center)) / (2 * half)) ** 2,
    )
    const total = raw.reduce((sum, w) => sum + w, 0)
    return {
      center,
      indices: inside,
      weights: raw.map((w) => w / total),
      nearest: false,
    }
  }
  const [a, b] = nm
    .map((l, k) => [Math.abs(l - center), k] as const)
    .sort((p, q) => p[0] - q[0] || p[1] - q[1])
    .slice(0, 2)
    .map(([, k]) => k)
    .sort((p, q) => p - q) as [number, number]
  const t = (center - nm[a]!) / (nm[b]! - nm[a]!)
  return { center, indices: [a, b], weights: [1 - t, t], nearest: true }
}

/** A row reduced to one band at the source's own angles, before the table's axis. */
export interface BandRow {
  /** sr⁻¹ at the model's angles: P11/(4π), weighted by what each wavelength scatters. */
  readonly phase: Float64Array
  readonly extinction: number
  readonly albedo: number
  readonly asymmetry: number
}

/**
 * Row `row` in band `band`, at the source's angles. As in the droplet
 * table, a band's phase is its scattered light over its scattering: each
 * wavelength weighted by the band's weight times C_sca = Q_ext·ω·A, so the
 * row is the phase of the band's light. Q_ext averages by area, and the
 * albedo and g by extinction and by scattering.
 */
export function bandRow(model: IceModel, row: number, band: IceBand): BandRow {
  const waves = model.wavelengths.length
  const rows = model.diameters.length
  const angles = model.angles.length
  let area = 0
  let extinction = 0
  let scattering = 0
  let asymmetry = 0
  const scatter = band.indices.map((l, k) => {
    const at = row * waves + l
    const a = band.weights[k]! * model.area[at]!
    const e = a * model.extinction[at]!
    const s = e * model.albedo[at]!
    area += a
    extinction += e
    scattering += s
    asymmetry += s * model.asymmetry[at]!
    return s
  })
  const phase = new Float64Array(angles)
  for (let i = 0; i < angles; i += 1) {
    let sum = 0
    band.indices.forEach((l, k) => {
      sum += scatter[k]! * model.p11[(i * rows + row) * waves + l]!
    })
    phase[i] = sum / scattering / (4 * Math.PI)
  }
  return {
    phase,
    extinction: extinction / area,
    albedo: scattering / extinction,
    asymmetry: asymmetry / scattering,
  }
}

/**
 * A phase at `degrees` resampled onto the table's angles, linear in θ and
 * in the logarithm of the phase: a phase falls over four decades from the
 * forward peak, and a straight line in p between two source angles sags
 * above it. Refuses a table angle outside the source's, and a phase that
 * is not positive, whose logarithm is none.
 */
export function resampleLog(
  degrees: Float64Array,
  phase: Float64Array,
  angles: number = DROPLET_TABLE.angles,
): Float64Array {
  if (phase.some((p) => !(p > 0)))
    throw new Error('iceTable: a phase that is not positive has no logarithm')
  const logs = Array.from(phase, Math.log)
  const out = new Float64Array(angles)
  let k = 0
  for (let i = 0; i < angles; i += 1) {
    const theta = (tableAngle(i) * 180) / Math.PI
    // The table's ends are 0 and π to a rounding; the source's are exact.
    const at = Math.min(
      degrees[degrees.length - 1]!,
      Math.max(degrees[0]!, theta),
    )
    if (Math.abs(at - theta) > 1e-9)
      throw new Error(`iceTable: ${theta}° is outside the source's angles`)
    while (k + 2 < degrees.length && degrees[k + 1]! < at) k += 1
    const f = (at - degrees[k]!) / (degrees[k + 1]! - degrees[k]!)
    out[i] = Math.exp(logs[k]! + (logs[k + 1]! - logs[k]!) * f)
  }
  return out
}

/** ∫p dΩ over the table's own angles: the trapezoid in θ with sin θ that `phaseIntegral` takes. */
export function tableIntegral(phase: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i + 1 < phase.length; i += 1) {
    const t0 = tableAngle(i)
    const t1 = tableAngle(i + 1)
    sum +=
      0.5 *
      (phase[i]! * Math.sin(t0) + phase[i + 1]! * Math.sin(t1)) *
      (t1 - t0)
  }
  return 2 * Math.PI * sum
}

/** A row on the table's axis, every band normalized to one there, and its bulk. */
export interface IceRow {
  /** sr⁻¹, [angle][band]. */
  readonly phase: Float64Array
  /** Per band: what renormalizing multiplied the resampled phase by. */
  readonly scale: readonly number[]
  readonly bands: readonly BandRow[]
}

/** Row `row`: each band reduced, resampled onto the table's angles and renormalized. */
export function iceRow(
  model: IceModel,
  row: number,
  bands: readonly IceBand[],
): IceRow {
  const angles = DROPLET_TABLE.angles
  const phase = new Float64Array(angles * 3)
  const reduced = bands.map((band) => bandRow(model, row, band))
  const scale = reduced.map((band, b) => {
    const resampled = resampleLog(model.angles, band.phase)
    const s = 1 / tableIntegral(resampled)
    resampled.forEach((p, i) => {
      phase[3 * i + b] = p * s
    })
    return s
  })
  return { phase, scale, bands: reduced }
}

/** Half float's largest finite value. */
const HALF_MAX = 65504

/**
 * The least power of two a row is divided by to be held in half floats:
 * one, or for a large crystal's forward peak two or four. Its least value
 * is 0.013 sr⁻¹, so a quarter of it is still a normal half and keeps its
 * eleven bits.
 */
export function halfScale(phase: ArrayLike<number>): number {
  let peak = 0
  for (let i = 0; i < phase.length; i += 1) peak = Math.max(peak, phase[i]!)
  // Rounding to half carries a value within half a step of 65504 up to the
  // tie at 65520, which `halfBits` refuses; the bound is the largest value
  // that rounds to a finite half.
  let scale = 1
  while (peak / scale >= HALF_MAX + 16) scale *= 2
  return scale
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

/** The air's three bands over a model's wavelengths. */
export function iceBands(model: IceModel): readonly IceBand[] {
  return AIR_BANDS.map((center) => iceBand(model.wavelengths, center))
}

/** The whole table, in the generated file's form. */
export function generateIce(
  model: IceModel,
  files: readonly IceSourceFile[],
): IceTableSource {
  const bands = iceBands(model)
  const rows = Array.from(model.diameters, (_, j) => iceRow(model, j, bands))
  const angles = DROPLET_TABLE.angles
  const phase = new Float64Array(rows.length * angles * 3)
  const scales = rows.map((row, j) => {
    const scale = halfScale(row.phase)
    phase.set(
      row.phase.map((p) => p / scale),
      j * angles * 3,
    )
    return scale
  })
  const bulk = (row: IceRow, key: 'extinction' | 'albedo' | 'asymmetry') =>
    Number(mean(row.bands.map((band) => band[key])).toPrecision(7))
  return {
    format: 'inertialref/ice',
    version: 1,
    habit: 'aggregate of solid columns, severely roughened',
    citation: BAUM_ICE.citations.join('\n'),
    license: BAUM_ICE.license,
    sourceDate: README_DATE,
    url: BAUM_ICE.url,
    files: files.map((f) => ({ ...f })),
    wavelengths: bands.map((band) =>
      band.indices.map((l) =>
        Number((model.wavelengths[l]! * 1000).toFixed(3)),
      ),
    ),
    angles,
    diameters: model.diameters.length,
    diameterMin: model.diameters[0]!,
    diameterStep: model.diameters[1]! - model.diameters[0]!,
    bands: [...AIR_BANDS],
    scales,
    phase: encodePhase(phase),
    bulk: rows.map(
      (row) =>
        [
          bulk(row, 'extinction'),
          bulk(row, 'albedo'),
          bulk(row, 'asymmetry'),
        ] as const,
    ),
  }
}

/**
 * The generated file's text, before prettier. Nothing in it differs
 * between two runs: the machine, the Node version and the seconds a run
 * took go to the console.
 */
export function sourceText(source: IceTableSource): string {
  const { angles, diameters, diameterMin, diameterStep, bands } = source
  const last = diameterMin + (diameters - 1) * diameterStep
  const nearest = source.wavelengths.some((w) => w.length < 2)
  const header = [
    'Generated by `node apps/ingest/src/iceTable.ts`; rerun it rather than',
    'editing, then `pnpm exec prettier -w` this file.',
    '',
    `Baum's ice: the ${source.habit},`,
    'P11 reduced to the phase atlas’s layout, sr⁻¹ normalized to ∫p dΩ = 1:',
    `${angles} angles × ${diameters} rows × ${bands.length} bands as little-endian float16 in base64,`,
    `laid out [row][angle][band]. Angle i is θ = (π/2)(1 − cos(πi/${angles - 1}));`,
    `row j is the effective diameter ${diameterMin} + ${diameterStep}j µm, ${diameterMin} to ${last}.`,
    '',
    `A band (the air’s ${bands.join(', ')} nm) is the set’s wavelengths within`,
    `±${DROPLET_TABLE.bandHalfWidth} nm under cos²(π(λ − λ_c)/${2 * DROPLET_TABLE.bandHalfWidth}), each weighted by what`,
    nearest
      ? 'it scatters, Q_ext·ω·A; a band with fewer than two takes its two nearest.'
      : 'it scatters, Q_ext·ω·A; every band holds two or more (`wavelengths`).',
    'The 498 source angles, 0° to 180°, are resampled linearly in θ and in',
    'ln p, never extrapolated, and each row and band is renormalized on this',
    'axis. `bulk` is [Q_ext, albedo, g] a row, the mean of the three bands.',
    '`scales` is the power of two a row’s stored phase is multiplied by: a',
    'large crystal’s forward peak passes half float’s 65504 sr⁻¹.',
    '',
    `Source: ${source.url}`,
    ...source.citation.split('\n').map((c) => `Cite: ${c}`),
    `License: ${source.license}. The README is dated "${source.sourceDate}".`,
    'Files read, with their bytes and SHA-256:',
    ...source.files.map((f) => `  ${f.name}  ${f.bytes}  ${f.sha256}`),
  ]
  return (
    '/*\n' +
    header.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    '\n */\nexport const ICE_AGGREGATE = ' +
    JSON.stringify(source, null, 2) +
    ' as const\n'
  )
}

const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))

// `import.meta.main`, as the droplet generator: run through a symlink, argv
// names the link and the comparison with this file's path is false.
if (import.meta.main) {
  const start = process.hrtime.bigint()
  const cache = baumCache(REPOSITORY)
  if (!baumCached(cache))
    throw new Error(
      `iceTable: ${cache} does not hold ${Object.values(BAUM_FILES).join(', ')}. Extract Baum's archive there; nothing fetches it.`,
    )
  const model = readBaum(cache)
  const source = generateIce(model, BAUM_MANIFEST)
  const out = join(REPOSITORY, BAUM_ICE.table)
  writeFileSync(out, sourceText(source))
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  console.log(
    `iceTable: wrote ${out} in ${seconds.toFixed(1)} s (Node ${process.version}); now run pnpm exec prettier -w on it`,
  )
}
