import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import { buildCatalog, buildSkyCatalog, readHyg } from './build.ts'

/*
 * The catalog build, run over excerpts small enough to read.
 *
 * `apps/ingest/fixtures/` holds eighteen HYG rows and twelve archive rows,
 * each chosen for one path through _resolve identity_ or _merge planets_; the
 * README there names the row behind every count below. The counts are the
 * build's interface — the caller prints them because a run that drops a third
 * of the catalog looks exactly like one that does not — so every field of the
 * report is asserted exactly, and an off-by-one in any of them fails here.
 */

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

const OPTIONS = {
  radiusLightYears: 50,
  completeRadiusLightYears: 25,
  version: 'fixture',
}

const volume = () =>
  buildCatalog(readHyg(fixture('hyg.csv')), fixture('exoplanets.csv'), OPTIONS)

describe('the volume build over the fixture rows', () => {
  it('counts every step it took', () => {
    expect(volume().report).toEqual({
      // Thirteen rows inside 50 ly; Aldebaran, Betelgeuse and HYG 40001 are
      // beyond it, and the two rows without a parallax never reach the cut.
      starsConsidered: 13,
      // Eleven systems: α Cen A and B are one, and the second HIP 113020 row
      // is refused.
      starsKept: 11,
      // HYG 91000 at the 100,000 pc sentinel, HYG 91001 with no distance.
      droppedNoParallax: 2,
      systems: 11,
      multiples: 1,
      // Sol, Rigil Kentaurus, Proxima Centauri, Barnard's Star. Toliman's name
      // is a companion's and the system's proper name is its primary's.
      withProperName: 4,
      // Ross 128's row stops after `mag`; HYG 300002 has a blank `spect`.
      withSpectralType: 9,
      // Ross 128, GJ 1253 and HYG 300001 have no `ci`.
      withColorIndex: 8,
      // Ross 128 and both 300000-series rows have no `absmag`.
      withMagnitude: 8,
      // HYG 300001 and 300002 carry no designation at all.
      unstableIds: 2,
      duplicateIds: ['HIP113020'],
      // HD 189733 b is beyond 50 ly and Kepler-22 b has no distance: neither
      // is considered.
      planetsConsidered: 10,
      planetsMatched: 7,
      planetsUnmatched: ['TRAPPIST-1 b', 'TRAPPIST-1 c', "Teegarden's Star b"],
      unmatchedHosts: ['TRAPPIST-1', "Teegarden's Star"],
      hostSystems: 6,
      matchedBy: { hip: 4, hd: 1, name: 1, position: 1 },
      // HYG 300001's `pec` names no class.
      spectralUnparsed: 1,
      // Barnard's Star's `pmdec = 9999.99`.
      sentinelProperMotions: 1,
    })
  })

  it('gives each system the id the identity ladder decides', () => {
    expect(volume().catalog.stars.map((star) => star.id)).toEqual([
      'SOL',
      // No HIP in the row, so Gliese wins over HD 22049 and HR 1084.
      'GJ144',
      // The truncated row keeps the columns it has.
      'HIP57548',
      'HIP71683',
      'HIP70890',
      'HIP87937',
      'HIP113020',
      'GJ1061',
      'GJ1253',
      'HYG300001',
      'HYG300002',
    ])
  })

  it('packs the primary and counts the companions', () => {
    const alphaCen = volume().catalog.stars.find(
      (star) => star.id === 'HIP71683',
    )
    expect(alphaCen).toMatchObject({
      components: 2,
      proper: 'Rigil Kentaurus',
      spectralType: 'G2V',
      bayerSuperscript: 1,
    })
  })

  it('attaches each planet to the host its match path found', () => {
    const { catalog } = volume()
    expect(
      catalog.planets.map((planet) => catalog.stars[planet.host]!.id),
    ).toEqual([
      'HIP70890', // Proxima Cen b, by HIP
      'HIP87937', // Barnard b, by HIP under another host name
      'HIP113020', // GJ 876 b, by HIP, onto the first of the duplicate rows
      'HIP113020', // GJ 876 c
      'GJ144', // eps Eri b: HIP 16537 is absent from HYG's row, HD 22049 is not
      'GJ1061', // GJ 1061 b, by name
      // Wolf 1069 b, by position. GJ 1253 is 1.4″ from the archive's
      // position; HYG 300001 is 27″ away and inside the distance tolerance,
      // so it loses on separation; HYG 300002 is 0.4″ away and 25% farther,
      // so it loses on distance alone.
      'GJ1253',
    ])
  })

  it('fills the columns a planet row leaves blank or unrecognized', () => {
    const gj1061b = volume().catalog.planets[5]!
    // Blank `pl_letter` is `b`; an unknown method is `Unknown`, not dropped.
    expect(gj1061b).toMatchObject({
      letter: 'b',
      discoveryMethod: 'Unknown',
      massIsLowerBound: true,
      equilibriumTemperature: null,
    })
    const proximaB = volume().catalog.planets[0]!
    expect(proximaB).toMatchObject({
      massIsLowerBound: true,
      equilibriumTemperature: 234,
      circumbinary: false,
      discoveryYear: 2016,
    })
  })

  it('is a pure function of the rows, not of their order', () => {
    const lines = fixture('hyg.csv').trimEnd().split('\n')
    const reversed = [lines[0], ...lines.slice(1).reverse()].join('\n')
    const forward = volume()
    const backward = buildCatalog(
      readHyg(reversed),
      fixture('exoplanets.csv'),
      OPTIONS,
    )
    expect(backward.catalog.stars).toEqual(forward.catalog.stars)
    expect(backward.report).toEqual(forward.report)
  })
})

describe('the sky build over the fixture rows', () => {
  it('counts the bright rows beyond the volume', () => {
    const hyg = readHyg(fixture('hyg.csv'))
    const { report } = buildSkyCatalog(hyg, {
      beyondLightYears: 50,
      apparentMagnitudeLimit: 6.5,
      version: 'fixture-sky',
      volumeIds: new Set(volume().catalog.stars.map((star) => star.id)),
    })
    const lightYears = (parsecs: number) => parsecs * (PARSEC / LIGHT_YEAR)
    expect(report).toEqual({
      // Aldebaran and Betelgeuse; HYG 40001 is beyond 50 ly at V 9.5.
      starsConsidered: 2,
      systems: 2,
      multiples: 0,
      withProperName: 2,
      withSpectralType: 2,
      withColorIndex: 2,
      unstableIds: 0,
      duplicateIds: [],
      inVolume: [],
      spectralUnparsed: 0,
      sentinelProperMotions: 0,
      apparentMagnitudes: { '0': 2 },
      farthestLightYears: lightYears(152.6718),
      brightest: [
        {
          id: 'HIP27989',
          name: 'Betelgeuse',
          apparentMagnitude: 0.45,
          lightYears: lightYears(152.6718),
        },
        {
          id: 'HIP21421',
          name: 'Aldebaran',
          apparentMagnitude: 0.87,
          lightYears: lightYears(20.429),
        },
      ],
    })
  })
})

/* ------------------------------------------------------------------------- */

/** One RFC 4180 field, quoted the way HYG quotes: always, doubling `"`. */
const quote = (field: string): string => `"${field.replaceAll('"', '""')}"`

/** Any text a HYG cell can hold, commas, quotes and line breaks included. */
const cellText = fc.string({
  unit: fc.constantFrom('a', 'Z', '1', ' ', ',', '"', '\n', '\r\n', "'", 'é'),
  maxLength: 12,
})

const hygLine = fc.record({
  proper: cellText,
  spect: cellText,
  distance: fc.oneof(
    fc.double({ min: 0, max: 99_999, noNaN: true }).map(String),
    fc.constantFrom('100000', '', 'n/a'),
  ),
})

describe('readHyg', () => {
  it('reads one row per data line, whatever the cells hold', () => {
    fc.assert(
      fc.property(fc.array(hygLine, { maxLength: 40 }), (lines) => {
        const csv = [
          'id,proper,spect,dist',
          ...lines.map((line, i) =>
            [String(i), quote(line.proper), quote(line.spect), line.distance]
              .map(String)
              .join(','),
          ),
        ].join('\r\n')
        const table = readHyg(csv)
        const usable = lines.filter((line) => {
          const value = line.distance === '' ? NaN : Number(line.distance)
          return Number.isFinite(value) && value < 100_000
        })
        expect(table.rows.length + table.droppedNoParallax).toBe(lines.length)
        expect(table.rows.map((row) => row.proper)).toEqual(
          usable.map((line) => line.proper.trim()),
        )
        expect(table.byHygId.size).toBe(usable.length)
      }),
    )
  })
})
