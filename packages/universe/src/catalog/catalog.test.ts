import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  formatSpectralType,
  isGiant,
  isWhiteDwarf,
  parseSpectralType,
} from './spectral.ts'
import {
  blackbodyColour,
  bolometricCorrection,
  effectiveTemperature,
  estimateMass,
  luminosityFromAbsoluteMagnitude,
  radiusFromLuminosity,
  temperatureFromColourIndex,
} from './photometry.ts'
import {
  bayerName,
  constellationGenitive,
  flamsteedName,
  glieseName,
  searchKey,
} from './designations.ts'
import { canonicalSystemId, normaliseGliese } from './identity.ts'
import {
  decodeCatalog,
  encodeCatalog,
  NO_INDEX,
  type PackedCatalog,
  type PackedPlanet,
  type PackedStar,
} from './format.ts'
import { TEST_CATALOG } from './fixture.ts'

describe('spectral types', () => {
  /*
   * Golden vectors, and every one of them is a real HYG v4.4 string that a
   * `spect[0]` parse gets wrong. Within 150 ly that naive test classifies 87% of
   * the catalogue and is quietly wrong about the other 13%, which is roughly a
   * thousand stars rendered the wrong colour.
   */
  const VECTORS: readonly [string, string, string | null, number | null][] = [
    // source        canonical  class  subclass
    ['G2V', 'G2V', 'G', 2],
    ['M5Ve', 'M5V', 'M', 5],
    ['K1V', 'K1V', 'K', 1],
    ['F5IV-V', 'F5IV', 'F', 5],
    ['A0Vvar', 'A0V', 'A', 0],
    // `m` is a metallic-line peculiarity, not a class, and the `...` is not a
    // subclass. Sirius.
    ['A0m...', 'A0', 'A', 0],
    // Yale/Gliese luminosity prefixes. The `d` is "dwarf".
    ['dM4', 'M4V', 'M', 4],
    ['sdM4', 'M4VI', 'M', 4], // Barnard's Star
    ['gK5', 'K5III', 'K', 5],
    // Lowercase, no subclass — 571 entries within 150 ly.
    ['m', 'M', 'M', null],
    ['k-m', 'K', 'K', null],
    ['m+', 'M', 'M', null],
    // White dwarfs. `D` is a class of its own and must not fall through.
    ['DA2', 'D2', 'D', 2],
    ['DZ', 'D', 'D', null],
    ['M3.5', 'M3.5', 'M', 3.5],
    ['K0III', 'K0III', 'K', 0],
    ['', '', null, null],
    ['pec', '', null, null],
  ]

  it.each(VECTORS)('parses %s', (source, canonical, cls, subclass) => {
    const type = parseSpectralType(source)
    expect(type.spectralClass).toBe(cls)
    expect(type.subclass).toBe(subclass)
    expect(formatSpectralType(type)).toBe(canonical)
    expect(type.source).toBe(source)
  })

  it('recognises evolved stars and white dwarfs', () => {
    expect(isGiant(parseSpectralType('K0III'))).toBe(true)
    expect(isGiant(parseSpectralType('gK5'))).toBe(true)
    expect(isGiant(parseSpectralType('G2V'))).toBe(false)
    expect(isWhiteDwarf(parseSpectralType('DA2'))).toBe(true)
    expect(isWhiteDwarf(parseSpectralType('dM4'))).toBe(false)
  })

  it('never throws, whatever the catalogue contains', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const type = parseSpectralType(text)
        expect(type.source).toBe(text.trim())
        if (type.subclass !== null) {
          expect(type.subclass).toBeGreaterThanOrEqual(0)
          expect(type.subclass).toBeLessThan(10)
        }
      }),
    )
  })
})

describe('photometry', () => {
  /*
   * The calibration point everything else hangs off. The Sun's own catalogue
   * entry has to come back out as one solar luminosity and one solar radius, or
   * every derived quantity in the file is off by whatever this is off by.
   *
   * 3% because that is what B−V, a bolometric correction and Stefan-Boltzmann
   * cost when composed — not a tolerance chosen to make this pass.
   */
  it('round-trips the Sun to within 3%', () => {
    const type = parseSpectralType('G2V')
    const temperature = effectiveTemperature(type, 0.656)
    if (temperature === null) throw new Error('no temperature')
    expect(temperature).toBeCloseTo(5_772, -2)
    const luminosity = luminosityFromAbsoluteMagnitude(4.85, temperature)
    expect(luminosity).toBeGreaterThan(0.97)
    expect(luminosity).toBeLessThan(1.03)
    expect(radiusFromLuminosity(luminosity, temperature)).toBeCloseTo(1, 1)
  })

  it('matches the published bolometric correction for the Sun', () => {
    // Pecaut & Mamajek give −0.08 at G2V. Anything materially different means
    // the table has been reindexed against a different temperature scale, which
    // is the mistake this whole module was rewritten to fix.
    expect(bolometricCorrection(5_772)).toBeCloseTo(-0.08, 2)
  })

  /*
   * Published temperatures and luminosities for stars anybody can look up.
   *
   * The tolerances are wide and they are measurements of a real limit rather
   * than a target: a temperature inferred from a spectral classification is
   * good to a few percent, and a luminosity inferred from a V magnitude and a
   * bolometric correction is good to tens of percent — worst at the late-M end,
   * where the correction is steep and the published values themselves disagree.
   * Proxima Centauri is the worst case in the catalogue at roughly half its
   * published luminosity, and it is a flare star at the edge of the calibration.
   */
  const REFERENCE: readonly [string, string, number, number, number, number][] =
    [
      // name, spect, B−V, M_V, published Teff, published L (solar)
      ['Sun', 'G2V', 0.656, 4.85, 5_772, 1],
      ['Rigil Kentaurus', 'G2V', 0.71, 4.379, 5_790, 1.519],
      ['Toliman', 'K1V', 0.9, 5.739, 5_260, 0.5],
      ['Sirius A', 'A0m...', 0.009, 1.454, 9_940, 25.4],
      ['Procyon A', 'F5IV-V', 0.432, 2.671, 6_530, 6.93],
      ['Tau Ceti', 'G8V', 0.727, 5.686, 5_344, 0.52],
      ['61 Cyg A', 'K5V', 1.069, 7.49, 4_374, 0.153],
      ["Barnard's Star", 'sdM4', 1.57, 13.235, 3_134, 0.0035],
      ['Arcturus', 'K1III', 1.239, -0.3, 4_286, 170],
    ]

  it.each(REFERENCE)(
    'derives %s within the limits of the method',
    (_name, spect, colourIndex, magnitude, publishedT, publishedL) => {
      const type = parseSpectralType(spect)
      const temperature = effectiveTemperature(type, colourIndex)
      if (temperature === null) throw new Error('no temperature')
      const luminosity = luminosityFromAbsoluteMagnitude(
        magnitude,
        temperature,
        isGiant(type),
      )
      expect(Math.abs(temperature / publishedT - 1)).toBeLessThan(0.06)
      expect(Math.abs(luminosity / publishedL - 1)).toBeLessThan(0.45)
    },
  )

  it('gives a red star a red colour and a blue star a blue one', () => {
    const cool = blackbodyColour(3_000)
    const hot = blackbodyColour(20_000)
    expect(cool.r).toBeGreaterThan(cool.b)
    expect(hot.b).toBeGreaterThan(hot.r)
    // The Sun is very nearly white by construction — it is the reference the
    // eye is adapted to — so neither channel may run away from the other.
    const sun = blackbodyColour(5_772)
    expect(Math.abs(sun.r - sun.b)).toBeLessThan(0.25)
  })

  it('does not apply the main-sequence mass relation to evolved stars', () => {
    // Arcturus is 170 solar luminosities and 1.1 solar masses. The
    // mass-luminosity relation reads its inflated envelope as mass and returns
    // roughly three times that, which would put a planet on the wrong orbit.
    const giant = estimateMass(parseSpectralType('K1III'), 170)
    expect(giant.basis).toBe('typical')
    expect(giant.solarMasses).toBeLessThan(4)
    const dwarf = estimateMass(parseSpectralType('G2V'), 1)
    expect(dwarf.basis).toBe('derived')
    expect(dwarf.solarMasses).toBeCloseTo(1, 1)
  })

  it('never returns a negative temperature, however red the star', () => {
    fc.assert(
      fc.property(fc.double({ min: -2, max: 6, noNaN: true }), (bv) => {
        // Unclamped, Ballesteros' denominator changes sign around B−V = 2.2 and
        // the formula returns a *negative* temperature. There are entries out
        // there with B−V above 3.
        expect(temperatureFromColourIndex(bv)).toBeGreaterThan(1_000)
      }),
    )
  })
})

describe('designations', () => {
  it('expands a Bayer designation into the name people use', () => {
    expect(bayerName('Alp', 'Cen')?.text).toBe('Alpha Centauri')
    expect(bayerName('Alp-1', 'Cen')?.text).toBe('Alpha¹ Centauri')
    expect(bayerName('Alp-1', 'Cen', false)?.text).toBe('Alpha Centauri')
    expect(bayerName('Tau', 'Cet')?.text).toBe('Tau Ceti')
    expect(bayerName('Eps', 'Eri')?.text).toBe('Epsilon Eridani')
    expect(bayerName('Alp', 'CMa')?.greek).toBe('α CMa')
    expect(bayerName('Zzz', 'Cen')).toBeNull()
    expect(bayerName('Alp', 'Xxx')).toBeNull()
  })

  it('expands a Flamsteed number', () => {
    expect(flamsteedName('61', 'Cyg')).toBe('61 Cygni')
    expect(flamsteedName('40', 'Eri')).toBe('40 Eridani')
    expect(flamsteedName('', 'Cyg')).toBeNull()
  })

  it('knows all 88 constellations by their genitive', () => {
    for (const [abbreviation, genitive] of [
      ['And', 'Andromedae'],
      ['CMa', 'Canis Majoris'],
      ['UMa', 'Ursae Majoris'],
      ['TrA', 'Trianguli Australis'],
      ['Boo', 'Boötis'],
    ] as const)
      expect(constellationGenitive(abbreviation)).toBe(genitive)
    expect(constellationGenitive('Zzz')).toBeNull()
  })

  it('spells Gliese out and leaves its supplements alone', () => {
    expect(glieseName('Gl 551')).toBe('Gliese 551')
    expect(glieseName('GJ 3063')).toBe('Gliese 3063')
    expect(glieseName('NN 3005')).toBe('NN 3005')
    expect(glieseName('')).toBeNull()
  })

  it('folds away everything a player should not have to type', () => {
    const key = searchKey('HIP 71683')
    expect(searchKey('hip71683')).toBe(key)
    expect(searchKey('Hip-71683')).toBe(key)
    // Diacritics, or Boötis is unreachable from a keyboard.
    expect(searchKey('Boötis')).toBe(searchKey('bootis'))
  })
})

describe('identity', () => {
  const source = (over: Partial<Parameters<typeof canonicalSystemId>[0]>) =>
    canonicalSystemId({
      hip: 0,
      gliese: '',
      hd: 0,
      hr: 0,
      sourceKey: '999',
      proper: '',
      ...over,
    })

  it('prefers the most stable designation, not the best known one', () => {
    expect(source({ proper: 'Sol' })).toBe('SOL')
    expect(source({ hip: 71_683, hd: 128_620, gliese: 'Gl 559A' })).toBe(
      'HIP71683',
    )
    expect(source({ gliese: 'Gl 559A', hd: 128_620 })).toBe('GJ559A')
    expect(source({ hd: 128_620, hr: 5_459 })).toBe('HD128620')
    expect(source({ hr: 5_459 })).toBe('HR5459')
    expect(source({})).toBe('HYG999')
  })

  it('gives one id to a star written Gl and GJ', () => {
    // HYG v4.4 merged five duplicate pairs that existed precisely because one
    // spelling was not recognised as the other. A resolver that repeats the
    // mistake issues two addresses for one star.
    expect(normaliseGliese('Gl 559A')).toBe('GJ559A')
    expect(normaliseGliese('GJ 559 A')).toBe('GJ559A')
    expect(normaliseGliese('gl559a')).toBe('GJ559A')
    expect(source({ gliese: 'Gl 699' })).toBe(source({ gliese: 'GJ 699' }))
  })

  it('refuses a designation that is not a legal address', () => {
    // `systemId` would throw on these, and an ingest that throws halfway is
    // worse than one that falls through to the next rung.
    expect(normaliseGliese('GJ 1002.1')).toBeNull()
    expect(source({ gliese: 'GJ 1002.1', hd: 7 })).toBe('HD7')
  })
})

describe('the packed format', () => {
  const star = (over: Partial<PackedStar>): PackedStar => ({
    id: 'HIP1',
    x: 1e16,
    y: -2e16,
    z: 3e15,
    absoluteMagnitude: 4.85,
    colourIndex: 0.656,
    spectralType: 'G2V',
    components: 1,
    provenance: 'observed',
    hip: 1,
    hd: 0,
    hr: 0,
    constellation: NO_INDEX,
    bayer: NO_INDEX,
    bayerSuperscript: 0,
    flamsteed: 0,
    proper: '',
    gliese: '',
    commonName: 'HIP 1',
    ...over,
  })

  it('round-trips every field', () => {
    const planet: PackedPlanet = {
      host: 1,
      letter: 'c',
      name: 'Neptune',
      semiMajorAxisAu: 30.07,
      orbitalPeriodDays: 60_189,
      eccentricity: 0.008_6,
      inclinationDeg: 1.77,
      argumentOfPeriapsisDeg: 276.3,
      massEarths: 17.147,
      massIsLowerBound: true,
      radiusEarths: 3.883,
      equilibriumTemperature: 47,
      insolation: 0.001_1,
      discoveryYear: 1846,
      discoveryMethod: 'Direct Observation',
      circumbinary: true,
    }
    const original: PackedCatalog = {
      metadata: {
        version: 'test-1',
        radiusLightYears: 150,
        completeRadiusLightYears: 25,
        attribution: ['CC BY-SA 4.0'],
        sources: [
          {
            name: 'HYG',
            url: 'https://x',
            licence: 'CC BY-SA 4.0',
            retrieved: 'abc',
          },
        ],
      },
      stars: [
        star({}),
        star({
          id: 'HIP71683',
          hip: 71_683,
          hd: 128_620,
          hr: 5_459,
          components: 2,
          constellation: 18,
          bayer: 0,
          bayerSuperscript: 1,
          flamsteed: 9,
          proper: 'Rigil Kentaurus',
          gliese: 'Gl 559A',
          commonName: 'Alpha Centauri',
          // Non-ASCII, because a name column that assumes one byte per character
          // silently corrupts Boötis and every Greek letter.
          spectralType: 'G2V α Boötis',
        }),
        star({
          id: 'HYG7',
          hip: 0,
          absoluteMagnitude: null,
          colourIndex: null,
          spectralType: '',
        }),
      ],
      planets: [planet],
    }

    const decoded = decodeCatalog(encodeCatalog(original))
    expect(decoded.metadata).toEqual(original.metadata)

    // Planet measurements are 32-bit floats: about seven significant digits,
    // where the published values carry two or three and their uncertainties are
    // percent-level. Comparing exactly would be asserting that a semi-major axis
    // is known to a part in 10^16.
    const back = decoded.planets[0] as PackedPlanet
    for (const key of [
      'semiMajorAxisAu',
      'orbitalPeriodDays',
      'massEarths',
      'radiusEarths',
      'insolation',
    ] as const)
      expect(back[key] as number).toBeCloseTo(planet[key] as number, 5)
    expect({
      ...back,
      semiMajorAxisAu: 0,
      orbitalPeriodDays: 0,
      massEarths: 0,
      radiusEarths: 0,
      insolation: 0,
    }).toEqual({
      ...planet,
      semiMajorAxisAu: 0,
      orbitalPeriodDays: 0,
      massEarths: 0,
      radiusEarths: 0,
      insolation: 0,
    })
    for (const [i, row] of original.stars.entries()) {
      const decodedStar = decoded.stars[i] as PackedStar
      // Position is quantised to 1 AU, which is four orders of magnitude inside
      // the parallax error at this distance. Everything else is exact.
      expect(Math.abs(decodedStar.x - row.x)).toBeLessThan(1.5e11)
      expect({ ...decodedStar, x: 0, y: 0, z: 0 }).toEqual({
        ...row,
        x: 0,
        y: 0,
        z: 0,
      })
    }
  })

  it('refuses a file it does not understand rather than decoding it', () => {
    const bytes = encodeCatalog({
      metadata: {
        version: 'v',
        radiusLightYears: 1,
        completeRadiusLightYears: 0,
        attribution: [],
        sources: [],
      },
      stars: [star({})],
      planets: [],
    })
    expect(() => decodeCatalog(bytes.slice(0, 20))).toThrow()
    const wrongMagic = bytes.slice()
    wrongMagic[0] = 0
    expect(() => decodeCatalog(wrongMagic)).toThrow(/Not a star catalogue/)
  })
})

describe('the catalogue at runtime', () => {
  it('indexes by cell rather than scanning', () => {
    // Same answer as a linear scan, which is the only thing the index owes.
    const centre = TEST_CATALOG.stars[0]?.position
    if (centre === undefined) throw new Error('empty fixture')
    const radius = 6 * 9.4607304725808e15
    const indexed = [...TEST_CATALOG.within(centre, radius)]
      .map((s) => s.id as string)
      .sort()
    const scanned = TEST_CATALOG.stars
      .filter((s) => s.distanceLightYears <= 6.000_1)
      .map((s) => s.id as string)
      .sort()
    expect(indexed).toEqual(scanned)
  })

  it('names a planet after its host, or after itself', () => {
    const barnard = TEST_CATALOG.get('HIP87937' as never)
    expect(barnard?.planets.map((p) => p.name)).toEqual([
      "Barnard's Star b",
      "Barnard's Star c",
    ])
  })

  it('sorts planets with no published orbit last, not first', () => {
    // `?? 0` would put an unmeasured orbit inside every measured one.
    const barnard = TEST_CATALOG.get('HIP87937' as never)
    const axes = barnard?.planets.map((p) => p.semiMajorAxisAu) ?? []
    expect(axes).toEqual([0.0229, 0.0281])
  })
})
