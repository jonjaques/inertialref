import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV } from '@inertialref/spatial'
import {
  catalogStub,
  cellOf,
  cellsWithin,
  generateCell,
  galaxySeedOf,
  generateSystem,
  isUnstableId,
  MILKY_WAY,
  orbitalOrder,
  readCatalog,
  type StarCatalog,
  systemsWithin,
  utf8,
} from '@inertialref/universe'
import { parseCsv } from './csv.ts'
import { chooseCommonName } from './naming.ts'

/*
 * The vendored artefact, checked against reality.
 *
 * `packages/universe` tests the codec and the derivations against a five-star
 * fixture, because it must not need a file to exist. This is the other half:
 * the committed 460 KB asset, decoded, asked the questions a player will ask,
 * and compared against numbers anybody can look up. It lives here because
 * `apps/*` may read a file and `packages/*` may not.
 *
 * If this fails after `pnpm catalog:build`, the ingest changed the universe.
 * That is allowed — astronomy publishes — but it is never allowed to be a
 * surprise, which is the entire reason these numbers are written down.
 */

const ASSET = new URL('../../../data/catalog/stars-150ly.irsc', import.meta.url)

let cached: StarCatalog | null = null
const catalog = (): StarCatalog => (cached ??= readCatalog(readFileSync(ASSET)))

const ROOT = rootSeed('inertialref')
const GALAXY_SEED = galaxySeedOf(ROOT)

describe('the vendored catalogue', () => {
  it('covers the volume it claims to', () => {
    const c = catalog()
    expect(c.metadata.radiusLightYears).toBe(150)
    expect(c.stars.length).toBeGreaterThan(7_000)
    for (const star of c.stars)
      expect(star.distanceLightYears).toBeLessThanOrEqual(150.001)
  })

  it('carries the attribution the licence requires', () => {
    // CC BY-SA 4.0 § 3(a)(1). The notice travels inside the file as well as
    // beside it, so a copy of the asset alone still states its terms.
    const attribution = catalog().metadata.attribution.join(' ')
    expect(attribution).toContain('HYG')
    expect(attribution).toContain('CC BY-SA 4.0')
    expect(attribution).toContain('Modified')
    expect(attribution).toContain('NASA Exoplanet Archive')
    expect(catalog().metadata.sources.length).toBeGreaterThan(1)
  })

  /*
   * The nearest stars, in order, with their published distances.
   *
   * This is the assertion a player can check against Wikipedia, which is the
   * whole point of shipping real data. The tolerance is 0.05 ly — the spread
   * between the Hipparcos parallaxes HYG carries and the modern Gaia ones.
   */
  const NEIGHBOURS: readonly [string, string, number][] = [
    ['HIP70890', 'Proxima Centauri', 4.25],
    ['HIP71683', 'Alpha Centauri', 4.32],
    ['HIP87937', "Barnard's Star", 5.95],
    ['GJ406', 'Wolf 359', 7.8],
    ['HIP54035', 'Lalande 21185', 8.31],
    ['HIP32349', 'Sirius', 8.6],
    ['HIP16537', 'Epsilon Eridani', 10.47],
    ['HIP8102', 'Tau Ceti', 11.91],
  ]

  it.each(NEIGHBOURS)(
    'has %s as %s at the published distance',
    (id, name, lightYears) => {
      const star = catalog().get(id as never)
      expect(star, id).toBeDefined()
      expect(star?.name).toBe(name)
      expect(star?.distanceLightYears).toBeCloseTo(lightYears, 1)
    },
  )

  it('lists Sol first and at the origin', () => {
    const sol = catalog().get('SOL' as never)
    expect(sol?.name).toBe('Sol')
    expect(sol?.distanceLightYears).toBe(0)
    expect(sol?.physical.solarLuminosities).toBeCloseTo(1, 1)
    expect(sol?.physical.temperature).toBeCloseTo(5_772, -2)
  })

  it('finds a star by every name it has', () => {
    const c = catalog()
    for (const [query, id] of [
      ['Sirius', 'HIP32349'],
      ['alpha canis majoris', 'HIP32349'],
      ['HD 48915', 'HIP32349'],
      ['Rigil Kentaurus', 'HIP71683'],
      ['alpha centauri', 'HIP71683'],
      ['61 Cygni', 'HIP104214'],
      ['Tau Ceti', 'HIP8102'],
      ['gliese 699', 'HIP87937'],
    ] as const)
      expect(c.find(query)?.id, query).toBe(id)
  })

  it('keeps almost every id in a catalogue that outlives HYG', () => {
    // A `HYG…` id is one only HYG's row numbering guarantees, so a rebuild that
    // renumbers moves it — and a save pointing at it points at nothing. 1% is
    // the level it sits at today; a jump means the identity ladder regressed.
    const unstable = catalog().stars.filter((s) => isUnstableId(s.id)).length
    expect(unstable / catalog().stars.length).toBeLessThan(0.01)
  })

  it('issues one address per system', () => {
    const ids = new Set(catalog().stars.map((s) => s.id as string))
    expect(ids.size).toBe(catalog().stars.length)
  })

  it('gives every star a name that is not its id', () => {
    // The id is an address and nobody should ever read one. A star with no
    // designation at all falls back to it, and that set should stay small.
    const c = catalog()
    const bare = c.stars.filter((s) => s.name === (s.id as string)).length
    expect(bare / c.stars.length).toBeLessThan(0.01)
    for (const star of c.stars) expect(star.name).not.toBe('')
  })
})

describe('the real Solar System', () => {
  const solSystem = () => {
    const sol = catalog().get('SOL' as never)
    if (sol === undefined) throw new Error('no Sol')
    return generateSystem(ROOT, MILKY_WAY, catalogStub(sol))
  }

  it('has the eight planets, named, in the right orbits', () => {
    const system = solSystem()
    const observed = orbitalOrder(system).filter(
      (b) => b.provenance === 'observed',
    )
    expect(observed.map((b) => b.name)).toEqual([
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ])
  })

  it('puts Earth one astronomical unit out and at the right size', () => {
    const earth = solSystem().planets.find((b) => b.name === 'Earth')
    expect(earth?.elements.semiMajorAxis).toBeCloseTo(1.495_978_707e11, -6)
    // Equatorial and polar, not a mean: 21.4 km of difference, which is what
    // makes the planet an ellipsoid rather than a sphere.
    expect(earth?.radius).toBe(6_378_137)
    expect(earth?.polarRadius).toBe(6_356_752)
    expect(earth?.mass).toBeCloseTo(5.9722e24, -21)
    expect(earth?.kind).toBe('rocky')
    expect(earth?.provenance).toBe('observed')
  })

  it('flattens the giants by the measured amount', () => {
    // Saturn is 9.8% oblate and Jupiter 6.5%. Drawn as spheres they read as
    // wrong before anyone can say why, so the polar radii are carried rather
    // than derived — the uniform-density relation overstates Jupiter's by 70%.
    const flattening = (name: string) => {
      const body = solSystem().planets.find((b) => b.name === name)
      if (body === undefined) throw new Error(name)
      return 1 - body.polarRadius / body.radius
    }
    expect(flattening('Saturn')).toBeCloseTo(0.098, 3)
    expect(flattening('Jupiter')).toBeCloseTo(0.065, 3)
    expect(flattening('Mercury')).toBe(0)
  })

  it('gives the Solar System its real moons', () => {
    const system = solSystem()
    const moons = system.planets.flatMap((planet) => planet.moons)
    expect(moons.map((m) => m.name)).toContain('Luna')
    expect(moons.map((m) => m.name)).toContain('Titan')
    expect(moons.map((m) => m.name)).toContain('Europa')
    expect(moons.length).toBe(20)
    for (const moon of moons) expect(moon.provenance).toBe('observed')

    const luna = moons.find((m) => m.name === 'Luna')
    expect(luna?.radius).toBe(1_737_400)
    expect(luna?.elements.semiMajorAxis).toBe(384_400_000)
    // Tidally locked: the same face has pointed at us for four billion years.
    expect(luna?.rotationPeriod).toBeCloseTo(luna?.orbitalPeriod ?? 0, -4)
  })

  it('keeps Triton retrograde and Uranus on its side', () => {
    const system = solSystem()
    const uranus = system.planets.find((b) => b.name === 'Uranus')
    // 97.77°: it orbits on its side, and it is the planet's defining fact.
    expect(((uranus?.axialTilt ?? 0) * 180) / Math.PI).toBeCloseTo(97.77, 1)
    // Retrograde rotation, carried as a negative period.
    expect(uranus?.rotationPeriod).toBeLessThan(0)

    const triton = system.planets
      .find((b) => b.name === 'Neptune')
      ?.moons.find((m) => m.name === 'Triton')
    expect(triton?.rotationPeriod).toBeLessThan(0)
    // Captured, not formed here — the only large moon in the system that was.
    expect(
      ((triton?.elements.inclination ?? 0) * 180) / Math.PI,
    ).toBeGreaterThan(90)
  })

  it('gives Saturn rings that start where a moon cannot survive', () => {
    const saturn = solSystem().planets.find((b) => b.name === 'Saturn')
    const rings = saturn?.appearance.rings
    expect(rings).toBeDefined()
    // C ring inner edge to A ring outer edge, 1.24 to 2.27 Saturn radii.
    expect((rings?.innerRadius ?? 0) / (saturn?.radius ?? 1)).toBeCloseTo(
      1.24,
      1,
    )
    expect((rings?.outerRadius ?? 0) / (saturn?.radius ?? 1)).toBeCloseTo(
      2.27,
      1,
    )
    expect(rings?.texture).toBe('saturn-ring')
  })

  it('classifies the giants as giants, from density rather than mass', () => {
    const system = solSystem()
    const kinds = Object.fromEntries(
      system.planets.map((b) => [b.name, b.kind]),
    )
    expect(kinds['Jupiter']).toBe('gas-giant')
    expect(kinds['Saturn']).toBe('gas-giant')
    expect(kinds['Uranus']).toBe('ice-giant')
    expect(kinds['Neptune']).toBe('ice-giant')
  })

  it('does not invent a ninth planet on top of a real one', () => {
    const system = solSystem()
    expect(system.observedPlanets).toBe(8)
    const real = system.planets
      .filter((b) => b.provenance === 'observed')
      .map((b) => b.elements.semiMajorAxis)
    for (const projected of system.planets.filter(
      (b) => b.provenance === 'projected',
    ))
      for (const known of real) {
        const ratio = projected.elements.semiMajorAxis / known
        expect(ratio > 1.5 || ratio < 1 / 1.5).toBe(true)
      }
  })

  it('keeps a planet at the same address whatever else is generated', () => {
    // Issue ordinals. Earth is `b:2` because it was the third body issued in
    // this system, and it stays `b:2` if a ninth planet is confirmed tomorrow.
    const earth = solSystem().planets.find((b) => b.name === 'Earth')
    expect(earth?.id).toBe('@g:milky-way/s:SOL/b:2')
  })
})

describe('confirmed exoplanets', () => {
  it('puts real planets around real stars', () => {
    const c = catalog()
    const withPlanets = c.stars.filter((s) => s.planets.length > 0)
    expect(withPlanets.length).toBeGreaterThan(400)
    /*
     * The host index is a position in the star array, so an off-by-one there
     * puts every planet around its neighbour and nothing throws. Exoplanet names
     * are `<host> <letter>`, so a planet naming a star it does not orbit is that
     * bug, visibly. The Solar System is the exception the check has to allow —
     * Neptune is not called "Sol i".
     */
    const solar = new Set([
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ])
    for (const star of withPlanets)
      for (const planet of star.planets) {
        if (solar.has(planet.name)) {
          expect(star.id).toBe('SOL')
          continue
        }
        expect(planet.name, `${star.name} / ${planet.name}`).toBe(
          `${star.name} ${planet.letter}`,
        )
      }
  })

  it('matches Tau Ceti to its confirmed planets', () => {
    const tau = catalog().get('HIP8102' as never)
    expect(tau?.planets.length).toBeGreaterThanOrEqual(3)
    for (const planet of tau?.planets ?? []) {
      expect(planet.name.startsWith('Tau Ceti ')).toBe(true)
      expect(planet.semiMajorAxisAu ?? 0).toBeGreaterThan(0)
    }
  })

  it('keeps an M sin i lower bound labelled as one', () => {
    // Radial velocity gives `M sin i`, not a mass, and most nearby planets were
    // found that way. Presenting it as a mass is quoting a number that is right
    // only for an edge-on system.
    const c = catalog()
    const bounded = c.stars
      .flatMap((s) => s.planets)
      .filter((p) => p.massIsLowerBound)
    expect(bounded.length).toBeGreaterThan(100)
  })
})

describe('the galaxy the catalogue produces', () => {
  it('invents no star closer than Proxima Centauri', () => {
    /*
     * The failure this exists for: the density model says how many stars there
     * are, not how many are *unknown*, so subtracting the catalogue from it and
     * scattering the difference put a procedural M dwarf 3.4 light-years away.
     * A main-sequence star that close would be the astronomical discovery of the
     * century, and the game claimed one on the first run.
     */
    const c = catalog()
    const sol = c.get('SOL' as never)
    if (sol === undefined) throw new Error('no Sol')
    for (const cell of cellsWithin(sol.position, 25 * LIGHT_YEAR))
      for (const stub of generateCell(GALAXY_SEED, cell, {
        catalogued: c.inCell(cell).length,
        completeRadius: c.completeRadius,
      }))
        expect(
          UV.distance(stub.position, sol.position) / LIGHT_YEAR,
        ).toBeGreaterThanOrEqual(25)
  })

  it('has the right neighbours in the right order out to ten light-years', () => {
    const c = catalog()
    const sol = c.get('SOL' as never)
    if (sol === undefined) throw new Error('no Sol')
    const near = systemsWithin(GALAXY_SEED, c, sol.position, 10 * LIGHT_YEAR)
      .filter((s) => s.catalogued && s.id !== 'SOL')
      .map((s) => ({
        name: s.name,
        ly: UV.distance(s.position, sol.position) / LIGHT_YEAR,
      }))
      .sort((a, b) => a.ly - b.ly)
    expect(near.slice(0, 4).map((s) => s.name)).toEqual([
      'Proxima Centauri',
      'Alpha Centauri',
      "Barnard's Star",
      'Wolf 359',
    ])
  })

  it('fills the gap beyond the catalogue rather than doubling it', () => {
    // At 100 ly HYG holds roughly a third of what the density model expects, so
    // there must be procedural stars out there — and more of them than there are
    // catalogued ones, or the fill is not filling anything.
    const c = catalog()
    const sol = c.get('SOL' as never)
    if (sol === undefined) throw new Error('no Sol')
    const far = UV.translate(sol.position, {
      x: 100 * LIGHT_YEAR,
      y: 0,
      z: 0,
    })
    const cell = cellOf(far)
    const catalogued = c.inCell(cell).length
    const procedural = generateCell(GALAXY_SEED, cell, {
      catalogued,
      completeRadius: c.completeRadius,
    }).length
    expect(catalogued).toBeGreaterThan(0)
    expect(procedural).toBeGreaterThan(catalogued)
  })
})

describe('the packed format carries its own UTF-8', () => {
  /*
   * `format.ts` implements UTF-8 by hand because `TextEncoder` is a host global
   * and the `packages/*` project compiles against neither the DOM lib nor
   * Node's — the core has to run unchanged in a browser, a worker and Node, and
   * the file format should decide how many bytes a star's name occupies rather
   * than inheriting it. This is the check that carrying it did not mean getting
   * it wrong, and it lives here because comparing against the platform's encoder
   * requires a platform that has one.
   */
  it('agrees with the platform encoder byte for byte', () => {
    const encoder = new TextEncoder()
    fc.assert(
      // `grapheme`, not `binary`: a lone surrogate is not text, `TextEncoder`
      // substitutes U+FFFD for one, and asserting byte equality against that
      // would be testing an error-recovery convention rather than UTF-8.
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        expect([...utf8.encode(text)]).toEqual([...encoder.encode(text)])
        expect(utf8.decode(encoder.encode(text))).toBe(text)
      }),
    )
  })

  it('survives the names actually in the catalogue', () => {
    // Boötis, α, and every accented proper name in the file. A codec that
    // assumes one byte per character corrupts these and nothing else.
    for (const star of catalog().stars)
      for (const name of star.designations)
        expect(utf8.decode(utf8.encode(name.text))).toBe(name.text)
  })
})

describe('the CSV reader', () => {
  it('does not shift a row when a field contains a comma', () => {
    // A naive `split(',')` does not fail on this, it silently moves every column
    // after the quoted one — so a star's spectral type becomes its colour index.
    const table = parseCsv('a,b,c\n1,"two, and a half",3\n')
    const row = table.rows[0]
    if (row === undefined) throw new Error('no row')
    expect(table.cell(row, 'b')).toBe('two, and a half')
    expect(table.cell(row, 'c')).toBe('3')
  })

  it('handles doubled quotes and CRLF', () => {
    const table = parseCsv('a,b\r\n1,"say ""hi"""\r\n')
    const row = table.rows[0]
    if (row === undefined) throw new Error('no row')
    expect(table.cell(row, 'b')).toBe('say "hi"')
    expect(table.rows).toHaveLength(1)
  })
})

describe('choosing a common name', () => {
  const component = (over: Record<string, unknown> = {}) => ({
    proper: '',
    apparentMagnitude: 0,
    bayer: '',
    flamsteed: '',
    constellation: '',
    gliese: '',
    hip: 0,
    hd: 0,
    hr: 0,
    ...over,
  })

  it('prefers a proper name to a designation', () => {
    expect(
      chooseCommonName(
        [
          component({
            proper: 'Sirius',
            bayer: 'Alp',
            flamsteed: '9',
            constellation: 'CMa',
          }),
          component(),
        ],
        'HIP32349',
      ),
    ).toBe('Sirius')
  })

  it('falls back to the shared designation when two components are named', () => {
    // Rigil Kentaurus and Toliman each name one star of α Centauri and neither
    // names the system, so the only name that refers to the whole thing is the
    // Bayer one — with the superscript dropped, because the components differ
    // only by it.
    expect(
      chooseCommonName(
        [
          component({
            proper: 'Rigil Kentaurus',
            bayer: 'Alp-1',
            constellation: 'Cen',
          }),
          component({
            proper: 'Toliman',
            bayer: 'Alp-2',
            constellation: 'Cen',
          }),
        ],
        'HIP71683',
      ),
    ).toBe('Alpha Centauri')
  })

  it('keeps the superscript for two unrelated stars that share a letter', () => {
    // κ¹ and κ² Sculptoris are separate systems. Dropping the superscript would
    // give both of them the same name.
    expect(
      chooseCommonName(
        [component({ bayer: 'Kap-1', constellation: 'Scl' })],
        'HIP1',
      ),
    ).toBe('Kappa¹ Sculptoris')
  })

  it('overrules a recent IAU name that nobody uses', () => {
    // ε Eridani was named Ran in 2015 and is still called Epsilon Eridani by
    // everyone, including the exoplanet literature about its planet.
    const epsilonEridani = [
      component({
        proper: 'Ran',
        bayer: 'Eps',
        constellation: 'Eri',
        apparentMagnitude: 3.73,
      }),
    ]
    expect(chooseCommonName(epsilonEridani, 'HIP16537')).toBe('Epsilon Eridani')

    // ...and does not overrule a classical one. Same shape, four magnitudes
    // brighter.
    const sirius = [
      component({
        proper: 'Sirius',
        bayer: 'Alp',
        constellation: 'CMa',
        apparentMagnitude: -1.44,
      }),
    ]
    expect(chooseCommonName(sirius, 'HIP32349')).toBe('Sirius')

    // A faint star with no designation keeps its proper name; there is nothing
    // else to call it.
    const barnard = [
      component({ proper: "Barnard's Star", apparentMagnitude: 9.54 }),
    ]
    expect(chooseCommonName(barnard, 'HIP87937')).toBe("Barnard's Star")
  })

  it('walks all the way down to a catalogue number', () => {
    expect(chooseCommonName([component({ hip: 12_345 })], 'HIP12345')).toBe(
      'HIP 12345',
    )
    expect(chooseCommonName([component({ gliese: 'Gl 551' })], 'GJ551')).toBe(
      'Gliese 551',
    )
    expect(chooseCommonName([component()], 'HYG7')).toBe('HYG7')
  })
})
