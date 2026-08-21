import { invariant } from '@inertialref/shared'

/*
 * The packed catalogue file.
 *
 * One binary, shipped as its own asset and fetched at runtime. Both halves of
 * the codec live here on purpose: the ingest in `apps/ingest` imports `encode`
 * and the game imports `decode`, so there is no second description of the layout
 * to fall out of step with the first. A format change that breaks one breaks the
 * other in the same commit.
 *
 * ## Columnar, not interleaved
 *
 * Every field is a contiguous run of its own values rather than a run of whole
 * records. Measured on this data it is 7–8% smaller after brotli for free: like
 * values sit together, so the compressor sees `4.35, 4.36, 4.41…` instead of
 * those interleaved with positions and flags.
 *
 * ## Store measurements, derive everything else
 *
 * HYG ships a `lum` column that is exactly `10^((4.85 − absmag)/2.5)` — the
 * absolute magnitude restated. Packing it would spend bytes to repeat the file
 * and would freeze a V-band number in place of a bolometric one. Same for names:
 * a Bayer designation is a Greek letter plus a constellation, both of which are
 * small integers, and the string `Alpha Centauri` is reconstructed at load from
 * tables the client already contains. Only what nobody can recompute is stored.
 *
 * ## DataView, not typed-array views
 *
 * The obvious decode is to point an `Int32Array` at a slice of the buffer. That
 * requires every column to start on its element's alignment boundary and it
 * inherits the platform's endianness, which makes the file a different file on a
 * big-endian machine. Reading through a `DataView` with explicit
 * little-endianness costs a few milliseconds once, at load, for a file this
 * size — and the layout stops having invisible rules.
 */

/** `IRSC` — InertialRef star catalogue. */
export const MAGIC = 0x4952_5343

/**
 * Bumped when the layout changes in a way an older reader would misread.
 * The reader refuses a version it does not know rather than decoding garbage.
 */
export const FORMAT_VERSION = 1

/**
 * Position quantisation step.
 *
 * Positions are stored as signed 32-bit counts of this. At 1 AU per step the
 * representable range is ±2.1 × 10^9 AU ≈ ±34,000 ly, comfortably past the
 * 150 ly the file covers, and the quantisation error is bounded by half a step.
 * That sounds enormous until you compare it to what it is quantising: at 150 ly
 * the parallax uncertainty on a HYG position is several thousand AU, so the
 * quantiser is four orders of magnitude inside the measurement error and is,
 * for practical purposes, free.
 */
export const POSITION_STEP_AU = 1

/** `null` for a scaled 16-bit field: no measurement, as distinct from zero. */
const SENTINEL_I16 = -32_768
/** No constellation, no Bayer letter. Zero is a real index, 255 is not. */
export const NO_INDEX = 255

/**
 * Where a star's data came from, and therefore what the game may claim about it.
 * `observed` is in a published catalogue; the other two are defined by
 * `docs/design/galaxy.md` and are carried here so the field exists from day one.
 */
export const PROVENANCE = ['observed', 'projected', 'surveyed'] as const
export type Provenance = (typeof PROVENANCE)[number]

export const DISCOVERY_METHODS = [
  'Unknown',
  'Radial Velocity',
  'Transit',
  'Imaging',
  'Microlensing',
  'Astrometry',
  'Transit Timing Variations',
  'Eclipse Timing Variations',
  'Orbital Brightness Modulation',
  'Pulsar Timing',
  'Pulsation Timing Variations',
  'Disk Kinematics',
  // Not one of the archive's methods. The eight planets of the Solar System were
  // not "discovered" by any technique in that list, and calling Jupiter an
  // imaging detection would be a small lie in a file whose whole purpose is to
  // be checkable. Appended, never inserted: the index is what the file stores.
  'Direct Observation',
] as const
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number]

/* ------------------------------------------------------------------------- */
/* The records                                                                */
/* ------------------------------------------------------------------------- */

/**
 * One star system as the file stores it: measurements and identifiers, nothing
 * derived. `starCatalog.ts` turns this into the physical description the
 * simulation and the renderer consume.
 */
export interface PackedStar {
  /**
   * The canonical system id, verbatim.
   *
   * Stored rather than derived from the identifiers below, even though
   * `identity.ts` can compute it, because an id *is* identity: deriving it at
   * load would mean a client running different code could compute a different
   * address for the same row, and an address that depends on the reader is not
   * an address. The ingest decides once and the file carries the decision.
   */
  readonly id: string
  /** Galactic cartesian metres, Sun at the origin, +x toward the centre. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** Absolute visual magnitude, or null. */
  readonly absoluteMagnitude: number | null
  /** Colour index B−V, or null. */
  readonly colourIndex: number | null
  /**
   * The classification string exactly as the source catalogue wrote it, or `''`.
   *
   * Verbatim, not canonicalised. Rewriting `sdM4` as `M4VI` at pack time was
   * tried and is the wrong side of the same rule the rest of the file follows:
   * the string is the measurement, the canonical MK form is derived from it, and
   * `parseSpectralType` runs at load anyway. Storing the original also lets the
   * system panel cite what it is claiming, which the design asks for and a
   * rewritten string cannot support.
   */
  readonly spectralType: string
  /** Number of stellar components. 1 means "not known to be multiple". */
  readonly components: number
  readonly provenance: Provenance
  /** Hipparcos number, or 0. */
  readonly hip: number
  /** Henry Draper number, or 0. */
  readonly hd: number
  /** Harvard Revised (Yale Bright Star) number, or 0. */
  readonly hr: number
  /** Index into the constellation table, or `NO_INDEX`. */
  readonly constellation: number
  /** Index into the Bayer letter table, or `NO_INDEX`. */
  readonly bayer: number
  /** Bayer superscript (α¹ = 1), or 0 for none. */
  readonly bayerSuperscript: number
  /** Flamsteed number, or 0. */
  readonly flamsteed: number
  /** IAU proper name, or `''`. */
  readonly proper: string
  /**
   * The name to show by default.
   *
   * Decided by the ingest and stored rather than recomputed, because the choice
   * needs to see the *whole system* — whether a sibling component also carries a
   * proper name is what decides between `Rigil Kentaurus` and `Alpha Centauri` —
   * and a decoder holding one row cannot see that. Never empty: the ingest falls
   * back through the designations to the id.
   */
  readonly commonName: string
  /** Gliese designation exactly as the catalogue writes it, or `''`. */
  readonly gliese: string
}

/** One confirmed planet, as published. Absent measurements stay absent. */
export interface PackedPlanet {
  /** Index of the host in the star array. */
  readonly host: number
  /** `b`, `c`, … — the planet letter. */
  readonly letter: string
  /**
   * A name that is not `<host> <letter>`, or `''`.
   *
   * Exoplanet designations are formulaic and derived at load, which is why there
   * is no name column for the 880 of them. The eight planets of the Solar System
   * are the exception the field exists for: `Sol b` is nobody's name for Venus.
   */
  readonly name: string
  /** Semi-major axis in AU, or null. */
  readonly semiMajorAxisAu: number | null
  /** Orbital period in days, or null. */
  readonly orbitalPeriodDays: number | null
  readonly eccentricity: number | null
  /** Degrees. */
  readonly inclinationDeg: number | null
  /** Argument of periapsis, degrees. */
  readonly argumentOfPeriapsisDeg: number | null
  /** Best mass in Earth masses, or null. */
  readonly massEarths: number | null
  /** True when the mass is an `M sin i` lower bound rather than a mass. */
  readonly massIsLowerBound: boolean
  readonly radiusEarths: number | null
  /** Equilibrium temperature, Kelvin, or null. */
  readonly equilibriumTemperature: number | null
  /** Insolation relative to Earth, or null. */
  readonly insolation: number | null
  readonly discoveryYear: number
  readonly discoveryMethod: DiscoveryMethod
  /** True when the planet orbits a binary rather than one star. */
  readonly circumbinary: boolean
}

export interface CatalogMetadata {
  /** The whole-catalogue version, e.g. `hyg-4.4+nea-20260820`. */
  readonly version: string
  /** Radius of the volume this file covers, light-years. */
  readonly radiusLightYears: number
  /**
   * Radius inside which this catalogue is complete for main-sequence stars, so
   * procedural generation adds nothing there. See `CellContext.completeRadius`
   * for why it is not simply zero.
   */
  readonly completeRadiusLightYears: number
  /** Attribution and licence text that must travel with the data. */
  readonly attribution: readonly string[]
  readonly sources: readonly {
    readonly name: string
    readonly url: string
    readonly licence: string
    readonly retrieved: string
  }[]
}

export interface PackedCatalog {
  readonly metadata: CatalogMetadata
  readonly stars: readonly PackedStar[]
  readonly planets: readonly PackedPlanet[]
}

/* ------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* ------------------------------------------------------------------------- */

const AU_METERS = 1.495_978_707e11
const POSITION_STEP_METERS = POSITION_STEP_AU * AU_METERS

class Writer {
  #bytes = new Uint8Array(1 << 16)
  #view = new DataView(this.#bytes.buffer)
  #at = 0

  #ensure(extra: number): void {
    if (this.#at + extra <= this.#bytes.length) return
    let size = this.#bytes.length
    while (size < this.#at + extra) size *= 2
    const grown = new Uint8Array(size)
    grown.set(this.#bytes)
    this.#bytes = grown
    this.#view = new DataView(grown.buffer)
  }

  u8(value: number): void {
    this.#ensure(1)
    this.#view.setUint8(this.#at, value)
    this.#at += 1
  }

  u16(value: number): void {
    this.#ensure(2)
    this.#view.setUint16(this.#at, value, true)
    this.#at += 2
  }

  i16(value: number): void {
    this.#ensure(2)
    this.#view.setInt16(this.#at, value, true)
    this.#at += 2
  }

  u32(value: number): void {
    this.#ensure(4)
    this.#view.setUint32(this.#at, value, true)
    this.#at += 4
  }

  i32(value: number): void {
    this.#ensure(4)
    this.#view.setInt32(this.#at, value, true)
    this.#at += 4
  }

  f32(value: number): void {
    this.#ensure(4)
    this.#view.setFloat32(this.#at, value, true)
    this.#at += 4
  }

  bytes(data: Uint8Array): void {
    this.#ensure(data.length)
    this.#bytes.set(data, this.#at)
    this.#at += data.length
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#at)
  }
}

class Reader {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  #at = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8(): number {
    const value = this.#view.getUint8(this.#at)
    this.#at += 1
    return value
  }

  u16(): number {
    const value = this.#view.getUint16(this.#at, true)
    this.#at += 2
    return value
  }

  i16(): number {
    const value = this.#view.getInt16(this.#at, true)
    this.#at += 2
    return value
  }

  u32(): number {
    const value = this.#view.getUint32(this.#at, true)
    this.#at += 4
    return value
  }

  i32(): number {
    const value = this.#view.getInt32(this.#at, true)
    this.#at += 4
    return value
  }

  f32(): number {
    const value = this.#view.getFloat32(this.#at, true)
    this.#at += 4
    return value
  }

  slice(length: number): Uint8Array {
    const value = this.#bytes.subarray(this.#at, this.#at + length)
    this.#at += length
    return value
  }

  get offset(): number {
    return this.#at
  }
}

/*
 * UTF-8, by hand.
 *
 * `TextEncoder` exists in every runtime this has to work in, and is not in the
 * `ES2023` lib the `packages/*` project compiles against — that project
 * deliberately declares no DOM and no Node types, because the core must run
 * unchanged in a browser, a worker and Node, and the cheapest guarantee is to
 * depend on nothing. Declaring the global ambiently would work and would put a
 * host assumption in a file that defines a *file format*: the bytes a star's
 * name occupies should be decided here, not by whatever the runtime does. Star
 * names reach three bytes (`Boötis`, `α`), so the full BMP and surrogate pairs
 * are both handled, and `format.test.ts` round-trips this against the platform's
 * own encoder to prove it.
 */
function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i += 1
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000)
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
  }
  return new Uint8Array(out)
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] as number
    let code: number
    if (b0 < 0x80) {
      code = b0
      i += 1
    } else if (b0 < 0xe0) {
      code = ((b0 & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f)
      i += 2
    } else if (b0 < 0xf0) {
      code =
        ((b0 & 0x0f) << 12) |
        (((bytes[i + 1] as number) & 0x3f) << 6) |
        ((bytes[i + 2] as number) & 0x3f)
      i += 3
    } else {
      code =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] as number) & 0x3f) << 12) |
        (((bytes[i + 2] as number) & 0x3f) << 6) |
        ((bytes[i + 3] as number) & 0x3f)
      i += 4
    }
    out +=
      code < 0x10000
        ? String.fromCharCode(code)
        : String.fromCharCode(
            0xd800 + ((code - 0x10000) >> 10),
            0xdc00 + ((code - 0x10000) & 0x3ff),
          )
  }
  return out
}

export const utf8 = { encode: encodeUtf8, decode: decodeUtf8 }

/**
 * One string per star: a column of byte lengths, then one blob of text.
 *
 * The first version stored a `u32` absolute offset per string, which allows
 * random access into the blob. That cost four bytes per string per column and
 * the file has five of them — 142 KB of offsets for a 200 KB payload, to support
 * an access pattern nothing uses, because the decoder reads every column in
 * full. A `u8` length is enough for every name in the catalogue and cut the
 * packed file by 40%.
 *
 * `255` escapes to a following `u32`, so a long string is representable rather
 * than silently truncated — nothing in this data is near it, and a format that
 * corrupts quietly at a boundary is not worth the byte it saves.
 */
const LENGTH_ESCAPE = 255

function writeStringColumn(writer: Writer, values: readonly string[]): void {
  const blob: Uint8Array[] = []
  for (const value of values) {
    const encoded = encodeUtf8(value)
    if (encoded.length < LENGTH_ESCAPE) writer.u8(encoded.length)
    else {
      writer.u8(LENGTH_ESCAPE)
      writer.u32(encoded.length)
    }
    blob.push(encoded)
  }
  for (const chunk of blob) writer.bytes(chunk)
}

function readStringColumn(reader: Reader, count: number): string[] {
  const lengths = new Array<number>(count)
  for (let i = 0; i < count; i += 1) {
    const length = reader.u8()
    lengths[i] = length === LENGTH_ESCAPE ? reader.u32() : length
  }
  const values = new Array<string>(count)
  for (let i = 0; i < count; i += 1) {
    const length = lengths[i] as number
    values[i] = length === 0 ? '' : decodeUtf8(reader.slice(length))
  }
  return values
}

const scaled = (value: number | null, factor: number): number =>
  value === null ? SENTINEL_I16 : Math.round(value * factor)

const unscaled = (value: number, factor: number): number | null =>
  value === SENTINEL_I16 ? null : value / factor

/** Non-negative float where `NaN` means "not measured". */
const optionalFloat = (value: number | null): number => value ?? Number.NaN
const readOptionalFloat = (value: number): number | null =>
  Number.isNaN(value) ? null : value

export function encodeCatalog(catalog: PackedCatalog): Uint8Array {
  const w = new Writer()
  const { stars, planets } = catalog

  w.u32(MAGIC)
  w.u32(FORMAT_VERSION)
  const metadata = encodeUtf8(JSON.stringify(catalog.metadata))
  w.u32(metadata.length)
  w.bytes(metadata)
  w.u32(stars.length)
  w.u32(planets.length)

  for (const s of stars) w.i32(Math.round(s.x / POSITION_STEP_METERS))
  for (const s of stars) w.i32(Math.round(s.y / POSITION_STEP_METERS))
  for (const s of stars) w.i32(Math.round(s.z / POSITION_STEP_METERS))
  for (const s of stars) w.i16(scaled(s.absoluteMagnitude, 100))
  for (const s of stars) w.i16(scaled(s.colourIndex, 1_000))
  for (const s of stars) w.u32(s.hip)
  for (const s of stars) w.u32(s.hd)
  for (const s of stars) w.u16(s.hr)
  for (const s of stars) w.u16(s.flamsteed)
  for (const s of stars) w.u8(s.constellation)
  for (const s of stars) w.u8(s.bayer)
  for (const s of stars) w.u8(s.bayerSuperscript)
  for (const s of stars) w.u8(Math.min(255, s.components))
  for (const s of stars) w.u8(PROVENANCE.indexOf(s.provenance))
  writeStringColumn(
    w,
    stars.map((s) => s.id),
  )
  writeStringColumn(
    w,
    stars.map((s) => s.spectralType),
  )
  writeStringColumn(
    w,
    stars.map((s) => s.proper),
  )
  writeStringColumn(
    w,
    stars.map((s) => s.commonName),
  )
  writeStringColumn(
    w,
    stars.map((s) => s.gliese),
  )

  for (const p of planets) w.u32(p.host)
  for (const p of planets) w.u8(p.letter.charCodeAt(0))
  writeStringColumn(
    w,
    planets.map((p) => p.name),
  )
  for (const p of planets) w.f32(optionalFloat(p.semiMajorAxisAu))
  for (const p of planets) w.f32(optionalFloat(p.orbitalPeriodDays))
  for (const p of planets) w.f32(optionalFloat(p.massEarths))
  for (const p of planets) w.f32(optionalFloat(p.radiusEarths))
  for (const p of planets) w.f32(optionalFloat(p.insolation))
  for (const p of planets) w.i16(scaled(p.eccentricity, 10_000))
  for (const p of planets) w.i16(scaled(p.inclinationDeg, 100))
  for (const p of planets) w.i16(scaled(p.argumentOfPeriapsisDeg, 10))
  for (const p of planets) w.u16(p.equilibriumTemperature ?? 0)
  for (const p of planets) w.u16(p.discoveryYear)
  for (const p of planets)
    w.u8(Math.max(0, DISCOVERY_METHODS.indexOf(p.discoveryMethod)))
  for (const p of planets)
    w.u8((p.massIsLowerBound ? 1 : 0) | (p.circumbinary ? 2 : 0))

  return w.finish()
}

export function decodeCatalog(bytes: Uint8Array): PackedCatalog {
  const r = new Reader(bytes)
  const magic = r.u32()
  invariant(
    magic === MAGIC,
    `Not a star catalogue: magic 0x${magic.toString(16)} at byte 0`,
  )
  const version = r.u32()
  invariant(
    version === FORMAT_VERSION,
    `Star catalogue is format ${version}; this build reads ${FORMAT_VERSION}. ` +
      `Re-run \`pnpm catalog:build\`.`,
  )
  const metadata = JSON.parse(decodeUtf8(r.slice(r.u32()))) as CatalogMetadata
  const starCount = r.u32()
  const planetCount = r.u32()

  const column = <T>(count: number, read: () => T): T[] => {
    const values = new Array<T>(count)
    for (let i = 0; i < count; i += 1) values[i] = read()
    return values
  }

  const x = column(starCount, () => r.i32())
  const y = column(starCount, () => r.i32())
  const z = column(starCount, () => r.i32())
  const absoluteMagnitude = column(starCount, () => r.i16())
  const colourIndex = column(starCount, () => r.i16())
  const hip = column(starCount, () => r.u32())
  const hd = column(starCount, () => r.u32())
  const hr = column(starCount, () => r.u16())
  const flamsteed = column(starCount, () => r.u16())
  const constellation = column(starCount, () => r.u8())
  const bayer = column(starCount, () => r.u8())
  const bayerSuperscript = column(starCount, () => r.u8())
  const components = column(starCount, () => r.u8())
  const provenance = column(starCount, () => r.u8())
  const id = readStringColumn(r, starCount)
  const spectralType = readStringColumn(r, starCount)
  const proper = readStringColumn(r, starCount)
  const commonName = readStringColumn(r, starCount)
  const gliese = readStringColumn(r, starCount)

  const stars: PackedStar[] = new Array(starCount)
  for (let i = 0; i < starCount; i += 1) {
    stars[i] = {
      id: id[i] as string,
      x: (x[i] as number) * POSITION_STEP_METERS,
      y: (y[i] as number) * POSITION_STEP_METERS,
      z: (z[i] as number) * POSITION_STEP_METERS,
      absoluteMagnitude: unscaled(absoluteMagnitude[i] as number, 100),
      colourIndex: unscaled(colourIndex[i] as number, 1_000),
      spectralType: spectralType[i] as string,
      components: components[i] as number,
      provenance: PROVENANCE[provenance[i] as number] ?? 'observed',
      hip: hip[i] as number,
      hd: hd[i] as number,
      hr: hr[i] as number,
      constellation: constellation[i] as number,
      bayer: bayer[i] as number,
      bayerSuperscript: bayerSuperscript[i] as number,
      flamsteed: flamsteed[i] as number,
      proper: proper[i] as string,
      commonName: commonName[i] as string,
      gliese: gliese[i] as string,
    }
  }

  const host = column(planetCount, () => r.u32())
  const letter = column(planetCount, () => r.u8())
  const planetName = readStringColumn(r, planetCount)
  const semiMajorAxisAu = column(planetCount, () => r.f32())
  const orbitalPeriodDays = column(planetCount, () => r.f32())
  const massEarths = column(planetCount, () => r.f32())
  const radiusEarths = column(planetCount, () => r.f32())
  const insolation = column(planetCount, () => r.f32())
  const eccentricity = column(planetCount, () => r.i16())
  const inclinationDeg = column(planetCount, () => r.i16())
  const argumentOfPeriapsisDeg = column(planetCount, () => r.i16())
  const equilibriumTemperature = column(planetCount, () => r.u16())
  const discoveryYear = column(planetCount, () => r.u16())
  const discoveryMethod = column(planetCount, () => r.u8())
  const planetFlags = column(planetCount, () => r.u8())

  const planets: PackedPlanet[] = new Array(planetCount)
  for (let i = 0; i < planetCount; i += 1) {
    const flags = planetFlags[i] as number
    planets[i] = {
      host: host[i] as number,
      letter: String.fromCharCode(letter[i] as number),
      name: planetName[i] as string,
      semiMajorAxisAu: readOptionalFloat(semiMajorAxisAu[i] as number),
      orbitalPeriodDays: readOptionalFloat(orbitalPeriodDays[i] as number),
      eccentricity: unscaled(eccentricity[i] as number, 10_000),
      inclinationDeg: unscaled(inclinationDeg[i] as number, 100),
      argumentOfPeriapsisDeg: unscaled(argumentOfPeriapsisDeg[i] as number, 10),
      massEarths: readOptionalFloat(massEarths[i] as number),
      massIsLowerBound: (flags & 1) !== 0,
      radiusEarths: readOptionalFloat(radiusEarths[i] as number),
      equilibriumTemperature:
        (equilibriumTemperature[i] as number) === 0
          ? null
          : (equilibriumTemperature[i] as number),
      insolation: readOptionalFloat(insolation[i] as number),
      discoveryYear: discoveryYear[i] as number,
      discoveryMethod:
        DISCOVERY_METHODS[discoveryMethod[i] as number] ?? 'Unknown',
      circumbinary: (flags & 2) !== 0,
    }
  }

  invariant(
    r.offset === bytes.length,
    `Star catalogue has ${bytes.length - r.offset} trailing bytes; the reader ` +
      `and the writer disagree about the layout`,
  )
  return { metadata, stars, planets }
}
