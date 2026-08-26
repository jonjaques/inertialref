import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SMALL_BODIES,
  sbdbUrl,
  SOLAR_SOURCES,
  type SolarSource,
} from './solarSources.ts'

/*
 * JPL's tables, turned into the reference the Solar System is checked against.
 *
 * The output is `data/reference/solar-system.json`: one record per planet,
 * dwarf planet, satellite and small body, in the units JPL publishes them in
 * rather than the SI the engine works in. That is deliberate. The conversion
 * from kilometers and days is exactly the step a transcription gets wrong, so
 * the reference keeps the published number and the test does the arithmetic —
 * a check that shared the conversion with the thing it checks would agree with
 * itself about a factor of 86,400.
 *
 * Two of the three tables are HTML, which is an unpleasant thing to parse and
 * the only form JPL publishes them in. The parser below is deliberately
 * literal: find rows, find cells, strip tags, take the first token. It does not
 * try to be a browser. What makes that safe is that every extracted table is
 * checked for the rows it must contain before anything is written — a layout
 * change produces an empty parse and an error naming the table, not a
 * reference file with four planets in it.
 */

/** Published as HTML tables with footnote markers and sigmas inside the cell. */
export interface PlanetRecord {
  readonly name: string
  readonly equatorialRadiusKm: number
  readonly meanRadiusKm: number
  readonly massKg: number
  readonly densityGramsPerCm3: number
  /** Sidereal, days. Negative is retrograde, which is JPL's own convention. */
  readonly rotationDays: number
  readonly orbitalYears: number
  readonly geometricAlbedo: number
  readonly equatorialGravity: number
  readonly escapeVelocityKmS: number
}

export interface SatelliteRecord {
  readonly planet: string
  readonly name: string
  readonly code: number
  readonly gmKm3S2: number | null
  readonly meanRadiusKm: number | null
  readonly densityGramsPerCm3: number | null
  readonly semiMajorAxisKm: number | null
  readonly eccentricity: number | null
  readonly inclinationDeg: number | null
  readonly argumentOfPeriapsisDeg: number | null
  readonly meanAnomalyDeg: number | null
  readonly nodeDeg: number | null
  readonly periodDays: number | null
  /** `Laplace`, `ecliptic` or `equatorial` — the plane the elements are in. */
  readonly frame: string | null
  readonly epoch: string | null
}

export interface SmallBodyRecord {
  readonly designation: string
  readonly name: string
  readonly fullName: string
  readonly orbitClass: string
  readonly kind: string
  readonly elements: {
    readonly semiMajorAxisAu: number | null
    readonly eccentricity: number | null
    readonly inclinationDeg: number | null
    readonly nodeDeg: number | null
    readonly argumentOfPeriapsisDeg: number | null
    readonly meanAnomalyDeg: number | null
    readonly periodDays: number | null
    readonly perihelionAu: number | null
    readonly aphelionAu: number | null
    readonly epochJd: number | null
  }
  readonly physical: {
    readonly diameterKm: number | null
    /** Tri- or bi-axial extent, km, longest first. Null where unmeasured. */
    readonly extentKm: readonly number[] | null
    readonly gmKm3S2: number | null
    readonly densityGramsPerCm3: number | null
    readonly rotationHours: number | null
    readonly geometricAlbedo: number | null
    readonly absoluteMagnitude: number | null
    readonly poleRaDeg: number | null
    readonly poleDecDeg: number | null
  }
  readonly discovery: {
    readonly year: number | null
    readonly by: string | null
  }
}

export interface SolarReference {
  readonly generated: string
  readonly sources: readonly {
    readonly name: string
    readonly url: string
    readonly credit: string
    readonly sha256: string
  }[]
  readonly planets: readonly PlanetRecord[]
  readonly dwarfPlanets: readonly PlanetRecord[]
  readonly satellites: readonly SatelliteRecord[]
  readonly smallBodies: readonly SmallBodyRecord[]
}

/* ------------------------------------------------------------------------- */
/* The literal HTML table reader                                              */
/* ------------------------------------------------------------------------- */

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&plusmn;': '±',
  '&times;': '×',
  '&minus;': '-',
}

const unescapeHtml = (text: string): string =>
  text
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity] ?? entity)
    .replace(/ /g, ' ')

/** Every `<tr>` in the document, as its list of cell texts. */
export function tableRows(html: string): readonly (readonly string[])[] {
  const rows: string[][] = []
  for (const [, body] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = []
    for (const [, cell] of (body ?? '').matchAll(
      /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi,
    )) {
      cells.push(unescapeHtml((cell ?? '').replace(/<[^>]*>/g, '')).trim())
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/**
 * The value in a JPL cell: the *first token*, and nothing else.
 *
 * A cell is `2440.53 ±0.04 [D]` — the value, a sigma, and a reference letter —
 * so the first whitespace-separated token is the number and everything after it
 * is provenance. Taking the first token rather than the first thing that looks
 * like a number is not fussiness; it is the fix for two silent failures found
 * by the tests that read this:
 *
 *   - **`n/a PLU060`.** Styx and Kerberos have no measured GM, and the cell says
 *     so and then names the ephemeris. A regex hunting for digits finds the
 *     `060` and reports Styx's gravitational parameter as 60 km³/s² — half
 *     Charon's, on a moon five kilometers across.
 *   - **`0.00000`.** Nereid's GM cell is a literal zero, which is JPL writing
 *     "unmeasured" in a numeric column. Zero is returned as null below, because
 *     nothing in this table legitimately has no mass.
 */
export function firstNumber(cell: string): number | null {
  const token = cell.trim().split(/\s+/)[0] ?? ''
  const value = Number(token.replace(/[±,]/g, ''))
  if (!Number.isFinite(value)) return null
  return value === 0 ? null : value
}

/** `firstNumber`, but a zero is a value rather than an absence. */
function angle(cell: string): number | null {
  const token = cell.trim().split(/\s+/)[0] ?? ''
  const value = Number(token.replace(/[±,]/g, ''))
  return Number.isFinite(value) ? value : null
}

const required = (value: number | null, what: string): number => {
  if (value === null) throw new Error(`missing ${what}`)
  return value
}

/* ------------------------------------------------------------------------- */
/* Planets and dwarf planets                                                  */
/* ------------------------------------------------------------------------- */

/*
 * One page, two tables, and the header row is how they are told apart.
 *
 * `phys_par.html` stacks the eight planets and the dwarf planets in the same
 * document with a repeated header, and the masses are in different units in
 * each — 10²⁴ kg for a planet and 10¹⁸ kg for a dwarf. Reading the section
 * header is not a nicety here: taking the second table's numbers at the first
 * table's scale makes Pluto a million times too heavy, and nothing downstream
 * would notice until it ate the Solar System.
 */
const PLANET_MASS_SCALE = 1e24
const DWARF_MASS_SCALE = 1e18

function parsePlanetTable(html: string): {
  planets: PlanetRecord[]
  dwarfPlanets: PlanetRecord[]
} {
  const planets: PlanetRecord[] = []
  const dwarfPlanets: PlanetRecord[] = []
  let into: PlanetRecord[] | null = null
  let scale = PLANET_MASS_SCALE

  for (const cells of tableRows(html)) {
    const head = cells[0] ?? ''
    if (head.startsWith('Planet')) {
      into = planets
      scale = PLANET_MASS_SCALE
      continue
    }
    if (head.replace(/\s+/g, '').startsWith('DwarfPlanet')) {
      into = dwarfPlanets
      scale = DWARF_MASS_SCALE
      continue
    }
    // The units row, and any row that is not a body.
    if (
      into === null ||
      cells.length < 11 ||
      head === '' ||
      head.startsWith('(')
    )
      continue
    const mass = firstNumber(cells[3] ?? '')
    if (mass === null) continue
    into.push({
      name: head,
      equatorialRadiusKm: required(
        firstNumber(cells[1] ?? ''),
        `${head} radius`,
      ),
      meanRadiusKm: required(
        firstNumber(cells[2] ?? ''),
        `${head} mean radius`,
      ),
      massKg: mass * scale,
      densityGramsPerCm3: required(
        firstNumber(cells[4] ?? ''),
        `${head} density`,
      ),
      rotationDays: required(firstNumber(cells[5] ?? ''), `${head} rotation`),
      orbitalYears: required(firstNumber(cells[6] ?? ''), `${head} period`),
      geometricAlbedo: firstNumber(cells[8] ?? '') ?? 0,
      equatorialGravity: firstNumber(cells[9] ?? '') ?? 0,
      escapeVelocityKmS: firstNumber(cells[10] ?? '') ?? 0,
    })
  }
  return { planets, dwarfPlanets }
}

/* ------------------------------------------------------------------------- */
/* Satellites                                                                 */
/* ------------------------------------------------------------------------- */

/*
 * The two satellite tables are joined on (planet, name) rather than on the
 * NAIF code, because only one of them publishes the code in a cell the parser
 * can reach. 46 bodies have physical parameters and 478 have elements; the
 * join keeps whichever side is missing as null rather than dropping the row,
 * so a moon with an orbit and no measured mass still reaches the reference and
 * still checks its orbit.
 */
const satelliteKey = (planet: string, name: string): string =>
  `${planet}/${name}`.toLowerCase()

function parseSatellites(
  physicalHtml: string,
  elementsHtml: string,
): SatelliteRecord[] {
  const physical = new Map<
    string,
    { gm: number | null; radius: number | null; density: number | null }
  >()
  for (const cells of tableRows(physicalHtml)) {
    if (cells.length < 6) continue
    const [planet = '', name = '', code = ''] = cells
    if (firstNumber(code) === null) continue
    physical.set(satelliteKey(planet, name), {
      gm: firstNumber(cells[3] ?? ''),
      radius: firstNumber(cells[4] ?? ''),
      density: firstNumber(cells[5] ?? ''),
    })
  }

  const satellites: SatelliteRecord[] = []
  for (const cells of tableRows(elementsHtml)) {
    if (cells.length < 14) continue
    const [, planet = '', name = '', code = ''] = cells
    const numericCode = firstNumber(code)
    if (numericCode === null || name === '' || planet === '') continue
    const measured = physical.get(satelliteKey(planet, name))
    satellites.push({
      planet,
      name,
      code: numericCode,
      gmKm3S2: measured?.gm ?? null,
      meanRadiusKm: measured?.radius ?? null,
      densityGramsPerCm3: measured?.density ?? null,
      frame: cells[5] ?? null,
      epoch: cells[6] ?? null,
      semiMajorAxisKm: firstNumber(cells[7] ?? ''),
      // An angle or an eccentricity of exactly zero is a *measurement* — most
      // of the inner satellites really are circular and coplanar to the
      // precision the table carries — so these read through `angle`, which
      // keeps a zero, rather than through `firstNumber`, which does not.
      eccentricity: angle(cells[8] ?? ''),
      argumentOfPeriapsisDeg: angle(cells[9] ?? ''),
      meanAnomalyDeg: angle(cells[10] ?? ''),
      inclinationDeg: angle(cells[11] ?? ''),
      nodeDeg: angle(cells[12] ?? ''),
      periodDays: firstNumber(cells[13] ?? ''),
    })
  }
  return satellites
}

/* ------------------------------------------------------------------------- */
/* Small bodies                                                               */
/* ------------------------------------------------------------------------- */

interface SbdbNamed {
  readonly name?: string
  readonly value?: string
  readonly title?: string
}

const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const pick = (rows: readonly SbdbNamed[], name: string): string | null =>
  rows.find((row) => row.name === name)?.value ?? null

/**
 * `0.5047 x 0.4918 x 0.4567` — SBDB's tri-axial extent, as a list of numbers.
 *
 * The order is JPL's, which is longest first, and it is the *full* extent
 * rather than a semi-axis. Halving it is the caller's job and is the second
 * place a transcription goes wrong, so the reference keeps what was published.
 */
const parseExtent = (value: string | null): number[] | null => {
  if (value === null) return null
  const parts = value
    .split(/\s*[x×]\s*/i)
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0)
  return parts.length >= 2 ? parts : null
}

const parsePole = (
  value: string | null,
): { ra: number | null; dec: number | null } => {
  if (value === null) return { ra: null, dec: null }
  const [ra = '', dec = ''] = value.split('/')
  return { ra: numberOf(ra), dec: numberOf(dec) }
}

function parseSmallBody(
  designation: string,
  name: string,
  payload: unknown,
): SmallBodyRecord {
  const body = payload as {
    object?: {
      fullname?: string
      shortname?: string
      kind?: string
      orbit_class?: { name?: string }
    }
    orbit?: { elements?: SbdbNamed[]; epoch?: string }
    phys_par?: SbdbNamed[]
    discovery?: { date?: string; who?: string }
  }
  const elements = body.orbit?.elements ?? []
  const physical = body.phys_par ?? []
  const pole = parsePole(pick(physical, 'pole'))
  const discoveredAt = body.discovery?.date ?? null
  return {
    designation,
    name,
    fullName: body.object?.fullname?.trim() ?? name,
    orbitClass: body.object?.orbit_class?.name ?? 'unknown',
    kind: body.object?.kind ?? 'unknown',
    elements: {
      semiMajorAxisAu: numberOf(pick(elements, 'a')),
      eccentricity: numberOf(pick(elements, 'e')),
      inclinationDeg: numberOf(pick(elements, 'i')),
      nodeDeg: numberOf(pick(elements, 'om')),
      argumentOfPeriapsisDeg: numberOf(pick(elements, 'w')),
      meanAnomalyDeg: numberOf(pick(elements, 'ma')),
      periodDays: numberOf(pick(elements, 'per')),
      perihelionAu: numberOf(pick(elements, 'q')),
      aphelionAu: numberOf(pick(elements, 'ad')),
      epochJd: numberOf(body.orbit?.epoch ?? null),
    },
    physical: {
      diameterKm: numberOf(pick(physical, 'diameter')),
      extentKm: parseExtent(pick(physical, 'extent')),
      gmKm3S2: numberOf(pick(physical, 'GM')),
      densityGramsPerCm3: numberOf(pick(physical, 'density')),
      rotationHours: numberOf(pick(physical, 'rot_per')),
      geometricAlbedo: numberOf(pick(physical, 'albedo')),
      absoluteMagnitude: numberOf(pick(physical, 'H')),
      poleRaDeg: pole.ra,
      poleDecDeg: pole.dec,
    },
    discovery: {
      year:
        discoveredAt === null
          ? null
          : (numberOf(discoveredAt.slice(0, 4)) ?? null),
      by: body.discovery?.who ?? null,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* ------------------------------------------------------------------------- */

const cacheDirectory = (root: string): string => join(root, '.data', 'raw')

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function fetchText(
  url: string,
  path: string,
  refresh: boolean,
  validate: (text: string) => void,
): Promise<{ text: string; cached: boolean }> {
  mkdirSync(dirname(path), { recursive: true })
  if (!refresh && exists(path)) {
    const text = readFileSync(path, 'utf8')
    validate(text)
    return { text, cached: true }
  }
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`${url}: ${response.status} ${response.statusText}`)
  const text = await response.text()
  validate(text)
  writeFileSync(path, text)
  return { text, cached: false }
}

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * Fetch everything and assemble the reference.
 *
 * `onProgress` rather than `console.log` because the ingest prints its own
 * report and this is a library — the same split every other builder here uses.
 */
export async function buildSolarReference({
  root,
  refresh = false,
  today,
  onProgress = () => {},
}: {
  root: string
  refresh?: boolean
  today: string
  onProgress?: (message: string) => void
}): Promise<SolarReference> {
  const texts = new Map<string, string>()
  const sources: {
    name: string
    url: string
    credit: string
    sha256: string
  }[] = []

  for (const source of SOLAR_SOURCES) {
    const { text, cached } = await fetchText(
      source.url,
      join(cacheDirectory(root), source.file),
      refresh,
      (payload) => validateSource(source, payload),
    )
    texts.set(source.key, text)
    sources.push({
      name: source.name,
      url: source.url,
      credit: source.credit,
      sha256: digest(text),
    })
    onProgress(
      `  ${source.name.padEnd(46)} ${String((text.length / 1024).toFixed(0)).padStart(6)} KB  ${
        cached ? 'cached' : 'downloaded'
      }`,
    )
  }

  const { planets, dwarfPlanets } = parsePlanetTable(texts.get('planets') ?? '')
  // The parse is checked against what the page is *for*. An empty result and a
  // result with three planets in it are the same failure, and both of them are
  // a layout change rather than a bad download — which the byte-count check
  // upstream cannot see.
  if (planets.length !== 8)
    throw new Error(
      `planet table: parsed ${planets.length} planets, expected 8 — the page layout changed`,
    )
  if (dwarfPlanets.length < 5)
    throw new Error(
      `planet table: parsed ${dwarfPlanets.length} dwarf planets, expected at least 5`,
    )

  const satellites = parseSatellites(
    texts.get('satellitePhysical') ?? '',
    texts.get('satelliteElements') ?? '',
  )
  if (satellites.length < 200)
    throw new Error(
      `satellite tables: parsed ${satellites.length} moons, expected hundreds`,
    )
  onProgress(
    `\n  ${planets.length} planets, ${dwarfPlanets.length} dwarf planets, ${satellites.length} satellites`,
  )

  const smallBodies: SmallBodyRecord[] = []
  for (const query of SMALL_BODIES) {
    const url = sbdbUrl(query.designation)
    const file = `sbdb_${query.designation.replace(/[^\w]+/g, '_')}.json`
    const { text } = await fetchText(
      url,
      join(cacheDirectory(root), 'sbdb', file),
      refresh,
      (payload) => {
        const parsed: unknown = JSON.parse(payload)
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('object' in parsed)
        )
          throw new Error(
            `SBDB ${query.designation}: no object block — ${payload.slice(0, 200)}`,
          )
      },
    )
    smallBodies.push(
      parseSmallBody(query.designation, query.name, JSON.parse(text)),
    )
  }
  sources.push({
    name: 'JPL Small-Body Database (SBDB) API',
    url: sbdbUrl('<designation>'),
    credit: 'NASA/JPL-Caltech Solar System Dynamics',
    sha256: digest(smallBodies.map((b) => b.fullName).join('|')),
  })
  onProgress(`  ${smallBodies.length} small bodies from SBDB`)

  return {
    generated: today,
    sources,
    planets,
    dwarfPlanets,
    satellites,
    smallBodies,
  }
}

function validateSource(source: SolarSource, text: string): void {
  if (text.length < source.minimumBytes)
    throw new Error(
      `${source.name}: got ${text.length} bytes, expected at least ${source.minimumBytes}. ` +
        `JPL serves a 17 KB "page not found" with a 200, so a short body is the usual shape of a moved URL.`,
    )
  if (!text.includes(source.sentinel))
    throw new Error(
      `${source.name}: the payload does not contain "${source.sentinel}", so it is not the table this expects.`,
    )
}
