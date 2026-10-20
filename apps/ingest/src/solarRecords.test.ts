import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  firstNumber,
  parsePlanetTable,
  parseSatellites,
  parseSmallBody,
  type PlanetRecord,
  type SatelliteRecord,
  type SmallBodyRecord,
  type SolarReference,
  solarReference,
  type SolarTexts,
  tableRows,
  validateSmallBody,
  validateSource,
} from './solarRecords.ts'
import { SMALL_BODIES, SOLAR_SOURCES } from './solarSources.ts'

/*
 * JPL's tables, read from excerpts and held to the reference the game ships.
 *
 * Each record parsed from `apps/ingest/fixtures/solar/` is compared with the
 * matching entry of the committed `data/reference/solar-system.json`, so the
 * fixtures are anchored to the data rather than to what a test's author
 * believed the page said. The whole reference is then written back into the
 * same table forms and read again: every number the game is checked against
 * survives the parser, not only the dozen in the excerpts.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/solar/${name}`, import.meta.url), 'utf8')

const REFERENCE = JSON.parse(
  readFileSync(
    new URL('../../../data/reference/solar-system.json', import.meta.url),
    'utf8',
  ),
) as SolarReference

const planet = (name: string): PlanetRecord =>
  [...REFERENCE.planets, ...REFERENCE.dwarfPlanets].find(
    (p) => p.name === name,
  )!

const satellites = (name: string): SatelliteRecord[] =>
  REFERENCE.satellites.filter((s) => s.name === name)

const smallBody = (name: string): SmallBodyRecord =>
  REFERENCE.smallBodies.find((b) => b.name === name)!

describe('the literal table reader', () => {
  it('reads cells, strips tags and unescapes entities', () => {
    expect(
      tableRows(
        '<table><tr><th>a<br/>b</th><td class="x">1&nbsp;&plusmn;&nbsp;2<sup>[D]</sup></td></tr>' +
          '<tr></tr><tr><td>&omega; &amp; &minus;3</td></tr></table>',
      ),
    ).toEqual([['ab', '1 ± 2[D]'], ['&omega; & -3']])
  })

  it.each([
    ['2440.53 ± 0.04 [D]', 2440.53],
    ['-243.018', -243.018],
    ['1,737.4', 1737.4],
    // Styx and Kerberos: no GM, then the ephemeris name. Not 60.
    ['n/a PLU060', null],
    // Nereid: JPL's zero means unmeasured; nothing here has no mass.
    ['0.00000', null],
    ['', null],
  ])('reads %j as %j', (cell, value) => {
    expect(firstNumber(cell)).toBe(value)
  })
})

describe('the planetary physical parameters', () => {
  it('reads each section at its own mass scale', () => {
    const { planets, dwarfPlanets } = parsePlanetTable(fixture('planets.html'))
    expect(planets).toEqual(['Mercury', 'Venus', 'Earth'].map(planet))
    // 10¹⁸ kg, not 10²⁴: Pluto at the planets' scale is a million times
    // too heavy.
    expect(dwarfPlanets).toEqual(['Ceres', 'Pluto'].map(planet))
  })

  it('refuses a row missing a value the reference needs', () => {
    const html = fixture('planets.html').replace(
      '<td>2439.4&nbsp;&plusmn;&nbsp;0.1</td>',
      '<td>n/a</td>',
    )
    expect(() => parsePlanetTable(html)).toThrow('missing Mercury mean radius')
  })
})

describe('the satellite tables', () => {
  it('joins the physical parameters onto the mean elements', () => {
    const parsed = parseSatellites(
      fixture('satellites-physical.html'),
      fixture('satellites-elements.html'),
    )
    expect(parsed).toEqual(
      ['Moon', 'Phobos', 'Puck', 'Nereid', 'Styx'].flatMap(satellites),
    )
  })
})

describe('the SBDB responses', () => {
  it.each([
    ['101955', 'Bennu'],
    ['1P', 'Halley'],
  ])('reads %s into the record for %s', (designation, name) => {
    const payload = fixture(`sbdb-${designation}.json`)
    validateSmallBody(designation, payload)
    expect(parseSmallBody(designation, name, JSON.parse(payload))).toEqual(
      smallBody(name),
    )
  })
})

describe('refusing the wrong payload', () => {
  const planets = SOLAR_SOURCES.find((source) => source.key === 'planets')!

  it('refuses a body too short to be the table', () => {
    expect(() =>
      validateSource(planets, '<html>Page not found</html>'),
    ).toThrow(/got 27 bytes, expected at least 40000.*page not found/s)
  })

  it('refuses a full-length page without the sentinel', () => {
    expect(() => validateSource(planets, 'x'.repeat(50_000))).toThrow(
      'does not contain "Makemake"',
    )
  })

  it('accepts the page it expects', () => {
    expect(() =>
      validateSource(planets, `${'x'.repeat(50_000)}Makemake`),
    ).not.toThrow()
  })

  it('refuses an SBDB answer with no object block', () => {
    expect(() =>
      validateSmallBody(
        '99999999',
        '{"message":"specified object was not found"}',
      ),
    ).toThrow('SBDB 99999999: no object block — {"message"')
  })
})

/* ------------------------------------------------------------------------- */
/* The whole reference, written back into the published forms                */
/* ------------------------------------------------------------------------- */

const cell = (value: number | string | null) =>
  `<td>${value === null ? 'n/a' : value}</td>`
const row = (cells: readonly (number | string | null)[]) =>
  `<tr>${cells.map(cell).join('')}</tr>`

function planetPage(
  planets: readonly PlanetRecord[],
  dwarfPlanets: readonly PlanetRecord[],
): string {
  const section = (
    title: string,
    records: readonly PlanetRecord[],
    scale: number,
  ) =>
    `<table><tr><th>${title}</th></tr><tr><th></th><th>(km)</th></tr>` +
    records
      .map((p) =>
        row([
          p.name,
          p.equatorialRadiusKm,
          p.meanRadiusKm,
          p.massKg / scale,
          p.densityGramsPerCm3,
          p.rotationDays,
          p.orbitalYears,
          '',
          p.geometricAlbedo,
          p.equatorialGravity,
          p.escapeVelocityKmS,
        ]),
      )
      .join('') +
    '</table>'
  return (
    section('Planet', planets, 1e24) +
    section('Dwarf<br>Planet', dwarfPlanets, 1e18)
  )
}

function satellitePages(records: readonly SatelliteRecord[]): {
  physical: string
  elements: string
} {
  const measured = records.filter(
    (s) =>
      s.gmKm3S2 !== null ||
      s.meanRadiusKm !== null ||
      s.densityGramsPerCm3 !== null,
  )
  return {
    physical: measured
      .map((s) =>
        row([
          s.planet,
          s.name,
          s.code,
          s.gmKm3S2,
          s.meanRadiusKm,
          s.densityGramsPerCm3,
        ]),
      )
      .join(''),
    elements: records
      .map((s, i) =>
        row([
          i + 1,
          s.planet,
          s.name,
          s.code,
          'DE440',
          s.frame,
          s.epoch,
          s.semiMajorAxisKm,
          s.eccentricity,
          s.argumentOfPeriapsisDeg,
          s.meanAnomalyDeg,
          s.inclinationDeg,
          s.nodeDeg,
          s.periodDays,
        ]),
      )
      .join(''),
  }
}

/** An SBDB response for a record: strings, and absent where it is null. */
function sbdbResponse(body: SmallBodyRecord): string {
  const named = (entries: Record<string, number | string | null>) =>
    Object.entries(entries)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => ({ name, value: String(value) }))
  const { elements: e, physical: p } = body
  // `parsePole` reads a pole with no `/` in it as no RA and a declination of
  // 0, because `numberOf('')` is 0 — and Kleopatra and Didymos carry exactly
  // that in the committed reference. So that is how such a pole is written.
  const pole =
    p.poleRaDeg === null && p.poleDecDeg === null
      ? null
      : p.poleRaDeg === null && p.poleDecDeg === 0
        ? 'unresolved'
        : `${p.poleRaDeg ?? 'n/a'}/${p.poleDecDeg ?? 'n/a'}`
  return JSON.stringify({
    object: {
      fullname: body.fullName,
      kind: body.kind,
      orbit_class: { name: body.orbitClass },
    },
    orbit: {
      epoch: e.epochJd === null ? undefined : String(e.epochJd),
      elements: named({
        a: e.semiMajorAxisAu,
        e: e.eccentricity,
        i: e.inclinationDeg,
        om: e.nodeDeg,
        w: e.argumentOfPeriapsisDeg,
        ma: e.meanAnomalyDeg,
        per: e.periodDays,
        q: e.perihelionAu,
        ad: e.aphelionAu,
      }),
    },
    phys_par: named({
      diameter: p.diameterKm,
      extent: p.extentKm === null ? null : p.extentKm.join(' x '),
      GM: p.gmKm3S2,
      density: p.densityGramsPerCm3,
      rot_per: p.rotationHours,
      albedo: p.geometricAlbedo,
      H: p.absoluteMagnitude,
      pole,
    }),
    discovery: {
      date:
        body.discovery.year === null
          ? undefined
          : `${String(body.discovery.year).padStart(4, '0')}-Jan-01`,
      who: body.discovery.by ?? undefined,
    },
  })
}

function textsFor(reference: SolarReference): SolarTexts {
  const pages = satellitePages(reference.satellites)
  return {
    tables: new Map([
      ['planets', planetPage(reference.planets, reference.dwarfPlanets)],
      ['satellitePhysical', pages.physical],
      ['satelliteElements', pages.elements],
    ]),
    smallBodies: reference.smallBodies.map((body) => ({
      query: { designation: body.designation, name: body.name },
      text: sbdbResponse(body),
    })),
  }
}

describe('solarReference', () => {
  it('reads every committed record back from the published forms', () => {
    const records = solarReference(textsFor(REFERENCE))
    // A mass is published as a coefficient of 10²⁴ or 10¹⁸ kg, and the
    // division and the multiplication back can each round by an ulp.
    const massless = (p: PlanetRecord) => ({ ...p, massKg: 0 })
    expect(records.planets.map(massless)).toEqual(
      REFERENCE.planets.map(massless),
    )
    expect(records.dwarfPlanets.map(massless)).toEqual(
      REFERENCE.dwarfPlanets.map(massless),
    )
    ;[...records.planets, ...records.dwarfPlanets].forEach((p, i) => {
      const committed = [...REFERENCE.planets, ...REFERENCE.dwarfPlanets][i]!
      expect(Math.abs(p.massKg / committed.massKg - 1)).toBeLessThan(
        2 * Number.EPSILON,
      )
    })
    expect(records.satellites).toEqual(REFERENCE.satellites)
    expect(records.smallBodies).toEqual(REFERENCE.smallBodies)
  })

  it('asks SBDB for exactly the bodies the reference holds', () => {
    expect(REFERENCE.smallBodies.map((b) => [b.designation, b.name])).toEqual(
      SMALL_BODIES.map((q) => [q.designation, q.name]),
    )
  })

  it.each([
    [
      'a planet short',
      { ...REFERENCE, planets: REFERENCE.planets.slice(1) },
      'planet table: parsed 7 planets, expected 8 — the page layout changed',
    ],
    [
      'a dwarf planet short',
      { ...REFERENCE, dwarfPlanets: REFERENCE.dwarfPlanets.slice(1) },
      'planet table: parsed 4 dwarf planets, expected at least 5',
    ],
    [
      'only the excerpt of the satellites',
      { ...REFERENCE, satellites: REFERENCE.satellites.slice(0, 199) },
      'satellite tables: parsed 199 moons, expected hundreds',
    ],
  ])('refuses a parse %s', (_label, reference, message) => {
    expect(() => solarReference(textsFor(reference))).toThrow(message)
  })
})
