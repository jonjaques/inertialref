import { LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import {
  canonicalSystemId,
  CATALOG_TABLES,
  equatorialToGalactic,
  galacticToCartesian,
  NO_INDEX,
  type PackedCatalog,
  type PackedPlanet,
  type PackedStar,
  parseSpectralType,
  searchKey,
  type DiscoveryMethod,
  DISCOVERY_METHODS,
} from '@inertialref/universe'
import { type CsvTable, number, parseCsv } from './csv.ts'
import { chooseCommonName, type NameSource } from './naming.ts'

/*
 * HYG + the NASA Exoplanet Archive → one packed catalog.
 *
 * The pipeline is normalize → resolve identity → merge planets → pack, and the
 * middle two steps are where an ingest goes quietly wrong, so both count what
 * they did and the caller prints it. A run that silently drops 30% of the
 * catalog looks exactly like a run that does not, unless it says so.
 */

const PARSECS_TO_LIGHT_YEARS = PARSEC / LIGHT_YEAR

/**
 * HYG's "no usable parallax" sentinel.
 *
 * 10,224 of 119,614 rows carry it. They must be *dropped*, not clamped: a
 * clamped one lands at 326,000 ly, which is outside the galaxy and inside every
 * distance query that does not think to exclude it.
 */
const NO_PARALLAX_PARSECS = 100_000

/**
 * Proper motions are 4-byte floats in a text file and the catalog uses 9999.99
 * as a "not measured" marker in at least one place — Barnard's Star, of all
 * stars, carries `pmdec = 9999.99`. Nothing downstream reads proper motion yet;
 * this exists so that when something does, the sentinel is already known about.
 */
const IMPLAUSIBLE_PROPER_MOTION = 9_000

export interface BuildOptions {
  readonly radiusLightYears: number
  readonly completeRadiusLightYears: number
  readonly version: string
}

export interface BuildReport {
  readonly starsConsidered: number
  readonly starsKept: number
  readonly droppedNoParallax: number
  readonly systems: number
  readonly multiples: number
  readonly withProperName: number
  readonly withSpectralType: number
  readonly withColourIndex: number
  readonly withMagnitude: number
  readonly unstableIds: number
  readonly duplicateIds: readonly string[]
  readonly planetsConsidered: number
  readonly planetsMatched: number
  readonly planetsUnmatched: readonly string[]
  /** Distinct host stars the archive knows and HYG does not. */
  readonly unmatchedHosts: readonly string[]
  readonly hostSystems: number
  readonly matchedBy: Readonly<Record<string, number>>
  readonly spectralUnparsed: number
  readonly sentinelProperMotions: number
}

interface HygRow {
  readonly hygId: string
  readonly hip: number
  readonly hd: number
  readonly hr: number
  readonly gliese: string
  readonly proper: string
  readonly bayer: string
  readonly bayerSuperscript: number
  readonly flamsteed: string
  readonly constellation: string
  readonly spect: string
  readonly ci: number | null
  readonly absmag: number | null
  readonly apparentMagnitude: number
  readonly ra: number
  readonly dec: number
  readonly distanceParsecs: number
  readonly comp: number
  readonly compPrimary: string
  readonly sentinelProperMotion: boolean
}

function readHyg(table: CsvTable, row: readonly string[]): HygRow | null {
  const distance = number(table, row, 'dist')
  if (distance === null || distance >= NO_PARALLAX_PARSECS) return null
  const bayerRaw = table.cell(row, 'bayer')
  const superscript = /-([0-9]+)$/.exec(bayerRaw)?.[1]
  const pmra = number(table, row, 'pmra') ?? 0
  const pmdec = number(table, row, 'pmdec') ?? 0
  return {
    hygId: table.cell(row, 'id'),
    hip: number(table, row, 'hip') ?? 0,
    hd: number(table, row, 'hd') ?? 0,
    hr: number(table, row, 'hr') ?? 0,
    gliese: table.cell(row, 'gl'),
    proper: table.cell(row, 'proper'),
    bayer: bayerRaw.replace(/-[0-9]+$/, ''),
    bayerSuperscript:
      superscript === undefined ? 0 : Number.parseInt(superscript, 10),
    flamsteed: table.cell(row, 'flam'),
    constellation: table.cell(row, 'con'),
    spect: table.cell(row, 'spect'),
    ci: number(table, row, 'ci'),
    absmag: number(table, row, 'absmag'),
    // Naked-eye prominence decides between an IAU proper name and a
    // designation; see `chooseCommonName`. A missing magnitude means faint.
    apparentMagnitude: number(table, row, 'mag') ?? 99,
    ra: (number(table, row, 'ra') ?? 0) * 15, // HYG publishes RA in hours
    dec: number(table, row, 'dec') ?? 0,
    distanceParsecs: distance,
    comp: number(table, row, 'comp') ?? 1,
    compPrimary: table.cell(row, 'comp_primary'),
    sentinelProperMotion:
      Math.abs(pmra) > IMPLAUSIBLE_PROPER_MOTION ||
      Math.abs(pmdec) > IMPLAUSIBLE_PROPER_MOTION,
  }
}

const nameSource = (row: HygRow): NameSource => ({
  proper: row.proper,
  apparentMagnitude: row.apparentMagnitude,
  bayer:
    row.bayerSuperscript > 0
      ? `${row.bayer}-${row.bayerSuperscript}`
      : row.bayer,
  flamsteed: row.flamsteed,
  constellation: row.constellation,
  gliese: row.gliese,
  hip: row.hip,
  hd: row.hd,
  hr: row.hr,
})

/* ------------------------------------------------------------------------- */

interface HostIndex {
  readonly byHip: Map<number, number>
  readonly byHd: Map<number, number>
  readonly byName: Map<string, number>
  readonly positions: readonly { ra: number; dec: number; pc: number }[]
}

export function buildCatalog(
  hygCsv: string,
  exoplanetCsv: string,
  options: BuildOptions,
): { catalog: PackedCatalog; report: BuildReport } {
  const hyg = parseCsv(hygCsv)
  const maxParsecs = options.radiusLightYears / PARSECS_TO_LIGHT_YEARS

  /* --- normalize ------------------------------------------------------- */

  let droppedNoParallax = 0
  let sentinelProperMotions = 0
  const rows: HygRow[] = []
  const byHygId = new Map<string, HygRow>()
  for (const raw of hyg.rows) {
    const row = readHyg(hyg, raw)
    if (row === null) {
      droppedNoParallax += 1
      continue
    }
    byHygId.set(row.hygId, row)
    if (row.distanceParsecs > maxParsecs) continue
    if (row.sentinelProperMotion) sentinelProperMotions += 1
    rows.push(row)
  }

  /* --- resolve identity ------------------------------------------------ */

  /*
   * Group components into systems using HYG's own `comp_primary`, which is the
   * HYG id of the system's primary. Deriving the grouping from proximity was
   * considered and rejected: two unrelated stars can sit 0.1 ly apart on the
   * sky, and a positional rule would merge them permanently and silently.
   */
  const groups = new Map<string, HygRow[]>()
  for (const row of rows) {
    const primary =
      row.compPrimary !== '' && byHygId.has(row.compPrimary)
        ? row.compPrimary
        : row.hygId
    const group = groups.get(primary)
    if (group === undefined) groups.set(primary, [row])
    else group.push(row)
  }

  const stars: PackedStar[] = []
  const idToIndex = new Map<string, number>()
  const duplicateIds: string[] = []
  let unstableIds = 0
  let spectralUnparsed = 0
  let multiples = 0

  // Sorted by HYG id so the output is a pure function of the input rather than
  // of Map iteration order, which the diff gate between versions depends on.
  const ordered = [...groups.entries()].sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  )

  for (const [primaryId, components] of ordered) {
    // Primary first, then by component number: the primary supplies the
    // position, the identity and the photometry the system is described by.
    components.sort((a, b) =>
      a.hygId === primaryId ? -1 : b.hygId === primaryId ? 1 : a.comp - b.comp,
    )
    const primary = components[0] as HygRow

    const id = canonicalSystemId({
      hip: primary.hip,
      gliese: primary.gliese,
      hd: primary.hd,
      hr: primary.hr,
      sourceKey: primary.hygId,
      proper: primary.proper,
    })
    if (id.startsWith('HYG')) unstableIds += 1
    if (idToIndex.has(id)) {
      // Two systems cannot share an address. Keeping the first and reporting the
      // rest is the only choice that does not depend on iteration order; the
      // count is printed so a source change that starts producing collisions is
      // visible rather than a silently shorter catalog.
      duplicateIds.push(id)
      continue
    }

    const galactic = equatorialToGalactic(primary.ra, primary.dec)
    const cartesian = galacticToCartesian(
      galactic,
      primary.distanceParsecs * PARSEC,
    )
    const type = parseSpectralType(primary.spect)
    if (primary.spect !== '' && type.spectralClass === null)
      spectralUnparsed += 1
    if (components.length > 1) multiples += 1

    const bayerIndex = CATALOG_TABLES.bayer.indexOf(
      primary.bayer as (typeof CATALOG_TABLES.bayer)[number],
    )
    const constellationIndex = CATALOG_TABLES.constellations.indexOf(
      primary.constellation as (typeof CATALOG_TABLES.constellations)[number],
    )

    idToIndex.set(id, stars.length)
    stars.push({
      id,
      x: cartesian.x,
      y: cartesian.y,
      z: cartesian.z,
      absoluteMagnitude: primary.absmag,
      colourIndex: primary.ci,
      spectralType: primary.spect,
      components: components.length,
      provenance: 'observed',
      hip: primary.hip,
      hd: primary.hd,
      hr: primary.hr,
      constellation: constellationIndex < 0 ? NO_INDEX : constellationIndex,
      bayer: bayerIndex < 0 ? NO_INDEX : bayerIndex,
      bayerSuperscript: primary.bayerSuperscript,
      flamsteed: /^[0-9]+$/.test(primary.flamsteed)
        ? Number.parseInt(primary.flamsteed, 10)
        : 0,
      proper: primary.proper,
      gliese: primary.gliese,
      commonName: chooseCommonName(components.map(nameSource), id),
    })
  }

  /* --- merge planets --------------------------------------------------- */

  const index = buildHostIndex(stars, rows, idToIndex)
  const { planets, matched, unmatched, unmatchedHosts, matchedBy } =
    matchPlanets(exoplanetCsv, index, stars, options.radiusLightYears)

  /*
   * The Solar System is deliberately absent from this file.
   *
   * The archive contains exoplanets, and the eight planets orbiting the star the
   * player starts at are not among them — so an earlier version of this ingest
   * carried them here by hand. They have moved to
   * `packages/universe/src/solar/`, because what Sol needs is not eight rows in
   * a planet table: it needs twenty moons, measured oblateness, axial tilts,
   * ring geometry and albedos, none of which this format has a column for and
   * none of which is catalog data. They are facts, and they live in source.
   */
  const hostSystems = new Set(planets.map((p) => p.host)).size

  return {
    catalog: {
      metadata: {
        version: options.version,
        radiusLightYears: options.radiusLightYears,
        completeRadiusLightYears: options.completeRadiusLightYears,
        attribution: ATTRIBUTION,
        sources: [],
      },
      stars,
      planets,
    },
    report: {
      starsConsidered: rows.length,
      starsKept: stars.length,
      droppedNoParallax,
      systems: stars.length,
      multiples,
      withProperName: stars.filter((s) => s.proper !== '').length,
      withSpectralType: stars.filter((s) => s.spectralType !== '').length,
      withColourIndex: stars.filter((s) => s.colourIndex !== null).length,
      withMagnitude: stars.filter((s) => s.absoluteMagnitude !== null).length,
      unstableIds,
      duplicateIds,
      planetsConsidered: matched + unmatched.length,
      planetsMatched: matched,
      planetsUnmatched: unmatched,
      unmatchedHosts,
      hostSystems,
      matchedBy,
      spectralUnparsed,
      sentinelProperMotions,
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Matching planets to their hosts                                            */
/* ------------------------------------------------------------------------- */

function buildHostIndex(
  stars: readonly PackedStar[],
  rows: readonly HygRow[],
  idToIndex: ReadonlyMap<string, number>,
): HostIndex {
  const byHip = new Map<number, number>()
  const byHd = new Map<number, number>()
  const byName = new Map<string, number>()
  const positions: { ra: number; dec: number; pc: number }[] = new Array(
    stars.length,
  )

  const rowById = new Map<string, HygRow>()
  for (const row of rows) {
    const key = canonicalSystemId({
      hip: row.hip,
      gliese: row.gliese,
      hd: row.hd,
      hr: row.hr,
      sourceKey: row.hygId,
      proper: row.proper,
    })
    if (!rowById.has(key)) rowById.set(key, row)
  }

  for (let i = 0; i < stars.length; i += 1) {
    const star = stars[i] as PackedStar
    if (star.hip > 0) byHip.set(star.hip, i)
    if (star.hd > 0) byHd.set(star.hd, i)
    for (const name of [star.commonName, star.proper, star.gliese]) {
      const key = searchKey(name)
      if (key !== '' && !byName.has(key)) byName.set(key, i)
    }
    // The Gliese designation is written half a dozen ways between the two
    // archives — `GJ 674`, `Gl 674`, `GJ674` — and `searchKey` folds all of them
    // except the Gl/GJ split, which is a different prefix rather than different
    // punctuation.
    if (star.gliese !== '') {
      const folded = searchKey(star.gliese.replace(/^Gl/i, 'GJ'))
      if (!byName.has(folded)) byName.set(folded, i)
    }
    const row = rowById.get(star.id)
    positions[i] = {
      ra: row?.ra ?? 0,
      dec: row?.dec ?? 0,
      pc: row?.distanceParsecs ?? 0,
    }
  }
  void idToIndex
  return { byHip, byHd, byName, positions }
}

const DEG = Math.PI / 180

/**
 * Angular separation in arcseconds, small-angle.
 *
 * The `+ 540) % 360) - 180` is the whole reason this is a function rather than
 * two lines at the call site. Right ascension wraps at 0h, so two positions of
 * the *same* star either side of it — 359.99° and 0.01°, which are 72 arcseconds
 * apart — subtract to 359.98° and come out as 1.3 million arcseconds. The match
 * is then rejected, the star lands in `unmatchedHosts`, and the report says
 * "HYG does not contain this host" about a host it contains.
 *
 * Small-angle in declination is fine and wrapping there is not: declination is
 * bounded at ±90° and does not wrap, it reflects.
 */
export function separationArcsec(
  a: { ra: number; dec: number },
  b: { ra: number; dec: number },
): number {
  const dDec = (a.dec - b.dec) * 3_600
  const shortestArc = (((a.ra - b.ra + 540) % 360) - 180) * 3_600
  const dRa = shortestArc * Math.cos(((a.dec + b.dec) / 2) * DEG)
  return Math.hypot(dRa, dDec)
}

/**
 * Cross-match tolerance.
 *
 * Generous on the sky and tight in distance. A published exoplanet host position
 * and a HYG position for the same star disagree by up to a few arcseconds
 * because they are at different epochs and these are high-proper-motion nearby
 * stars; two *different* stars that close together and also at the same distance
 * would be a physical binary, which is the same system anyway.
 */
const MATCH_ARCSEC = 60
const MATCH_DISTANCE_TOLERANCE = 0.2

function matchPlanets(
  csv: string,
  index: HostIndex,
  stars: readonly PackedStar[],
  radiusLightYears: number,
): {
  planets: PackedPlanet[]
  matched: number
  unmatched: string[]
  unmatchedHosts: string[]
  matchedBy: Record<string, number>
} {
  const table = parseCsv(csv)
  const planets: PackedPlanet[] = []
  const unmatched: string[] = []
  const unmatchedHosts = new Set<string>()
  const matchedBy: Record<string, number> = {
    hip: 0,
    hd: 0,
    name: 0,
    position: 0,
  }

  for (const row of table.rows) {
    const distance = number(table, row, 'sy_dist')
    if (
      distance === null ||
      distance * PARSECS_TO_LIGHT_YEARS > radiusLightYears
    )
      continue

    const name = table.cell(row, 'pl_name')
    const host = findHost(table, row, index, distance)
    if (host === null) {
      unmatched.push(name)
      unmatchedHosts.add(table.cell(row, 'hostname'))
      continue
    }
    matchedBy[host.by] = (matchedBy[host.by] ?? 0) + 1

    const letter = table.cell(row, 'pl_letter')
    const method = table.cell(row, 'discoverymethod')
    planets.push({
      host: host.index,
      letter: letter === '' ? 'b' : letter,
      name: '',
      semiMajorAxisAu: number(table, row, 'pl_orbsmax'),
      orbitalPeriodDays: number(table, row, 'pl_orbper'),
      eccentricity: number(table, row, 'pl_orbeccen'),
      inclinationDeg: number(table, row, 'pl_orbincl'),
      argumentOfPeriapsisDeg: number(table, row, 'pl_orblper'),
      massEarths: number(table, row, 'pl_bmasse'),
      // `Msini` is a lower bound from radial velocity, not a mass: the orbit's
      // inclination is unknown, so the true mass is this divided by sin i. Games
      // that present it as a mass are quoting a number that is right only for
      // edge-on systems.
      massIsLowerBound: table.cell(row, 'pl_bmassprov').startsWith('Msini'),
      radiusEarths: number(table, row, 'pl_rade'),
      equilibriumTemperature: round(number(table, row, 'pl_eqt')),
      insolation: number(table, row, 'pl_insol'),
      discoveryYear: number(table, row, 'disc_year') ?? 0,
      discoveryMethod: (DISCOVERY_METHODS as readonly string[]).includes(method)
        ? (method as DiscoveryMethod)
        : 'Unknown',
      circumbinary: table.cell(row, 'cb_flag') === '1',
    })
  }

  void stars
  return {
    planets,
    matched: planets.length,
    unmatched,
    unmatchedHosts: [...unmatchedHosts].sort(),
    matchedBy,
  }
}

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value)

function findHost(
  table: CsvTable,
  row: readonly string[],
  index: HostIndex,
  distanceParsecs: number,
): { index: number; by: string } | null {
  const hip = /HIP\s*([0-9]+)/.exec(table.cell(row, 'hip_name'))?.[1]
  if (hip !== undefined) {
    const at = index.byHip.get(Number.parseInt(hip, 10))
    if (at !== undefined) return { index: at, by: 'hip' }
  }
  const hd = /HD\s*([0-9]+)/.exec(table.cell(row, 'hd_name'))?.[1]
  if (hd !== undefined) {
    const at = index.byHd.get(Number.parseInt(hd, 10))
    if (at !== undefined) return { index: at, by: 'hd' }
  }
  const host = table.cell(row, 'hostname')
  const byName =
    index.byName.get(searchKey(host)) ??
    index.byName.get(searchKey(host.replace(/^Gl\b/i, 'GJ')))
  if (byName !== undefined) return { index: byName, by: 'name' }

  // Last resort: the archives disagree about the name but not about the sky.
  const ra = number(table, row, 'ra')
  const dec = number(table, row, 'dec')
  if (ra === null || dec === null) return null
  let best: { index: number; separation: number } | null = null
  for (let i = 0; i < index.positions.length; i += 1) {
    const candidate = index.positions[i] as {
      ra: number
      dec: number
      pc: number
    }
    if (
      Math.abs(candidate.pc - distanceParsecs) >
      MATCH_DISTANCE_TOLERANCE * distanceParsecs
    )
      continue
    const separation = separationArcsec({ ra, dec }, candidate)
    if (separation > MATCH_ARCSEC) continue
    if (best === null || separation < best.separation)
      best = { index: i, separation }
  }
  return best === null ? null : { index: best.index, by: 'position' }
}

/*
 * The attribution that must travel with the data.
 *
 * `docs/spikes.md` §4 establishes that CC BY-SA 4.0's share-alike reaches the
 * packed database but not the code that reads it, and that the notice has to
 * carry the creator, a license reference, a link to the source and a statement
 * that the data was modified. It is written into the file itself as well as into
 * the license file beside it, so that a copy of the asset alone still carries
 * its terms.
 */
const ATTRIBUTION: readonly string[] = [
  'Star data: The HYG Database v4.4 by David Nash (astronexus), ' +
    'https://codeberg.org/astronexus/hyg — licensed CC BY-SA 4.0, ' +
    'https://creativecommons.org/licenses/by-sa/4.0/. Modified: filtered by ' +
    'distance, grouped into systems, re-projected into galactic coordinates ' +
    'and repacked. This derived database is likewise CC BY-SA 4.0.',
  'Planet data: This research has made use of the NASA Exoplanet Archive, ' +
    'which is operated by the California Institute of Technology, under ' +
    'contract with the National Aeronautics and Space Administration under ' +
    'the Exoplanet Exploration Program.',
]
