/*
 * Where the Solar System's measurements come from.
 *
 * The star catalog is a *database* — it is licensed, it is packed, and it ships
 * as an artifact. This is not. These are published measurements of named
 * objects, and `packages/universe/src/solar/bodies.ts` carries them transcribed
 * into source because facts are not a dataset.
 *
 * So what does this file fetch, and why does it exist at all?
 *
 * **It fetches the reference the tests compare the transcription against.**
 * A hand-typed table of six hundred numbers has typos in it; that is not a
 * hypothetical, it is the base rate. `apps/headless/src/solarSystem.test.ts`
 * builds Sol out of the engine and checks every body against
 * `data/reference/solar-system.json`, which is written by this ingest straight
 * out of JPL. A transposed digit in a semi-major axis fails a test instead of
 * quietly putting Deimos inside Phobos's orbit.
 *
 * That is also why the reference is committed rather than fetched at test time.
 * A test that reaches the network is a test that fails on a plane, and a
 * reference that can change between two runs of the same commit is not a
 * reference. Re-run `pnpm solar:fetch` when JPL publishes; the diff is the
 * news.
 *
 * ## The four tables, and why each one
 *
 * JPL Solar System Dynamics publishes the planets and the satellites as HTML
 * tables and the small bodies through an API. All four are the *same*
 * institution's current best values, which matters more than it sounds: mixing
 * a fact sheet's Phobos with an ephemeris's Deimos gives two moons measured
 * against different Mars.
 *
 * NASA/JPL material is not subject to copyright. There is nothing to license
 * and no attribution obligation; the credit line below is courtesy and
 * traceability, not compliance.
 */

export type SolarSourceKind = 'html' | 'json'

export interface SolarSource {
  readonly key: string
  readonly name: string
  readonly url: string
  readonly file: string
  readonly kind: SolarSourceKind
  readonly credit: string
  /** Fail if the payload is smaller than this. A 404 page is 17 KB of HTML. */
  readonly minimumBytes: number
  /** A string the real payload contains and an error page does not. */
  readonly sentinel: string
}

const JPL = 'NASA/JPL-Caltech Solar System Dynamics'

export const SOLAR_SOURCES: readonly SolarSource[] = [
  {
    key: 'planets',
    name: 'JPL planetary physical parameters',
    url: 'https://ssd.jpl.nasa.gov/planets/phys_par.html',
    file: 'jpl_planets_phys.html',
    kind: 'html',
    credit: JPL,
    minimumBytes: 40_000,
    // The dwarf-planet section of the same table, which is half of why this
    // page is used rather than the eight-row fact sheet.
    sentinel: 'Makemake',
  },
  {
    key: 'satellitePhysical',
    name: 'JPL planetary satellite physical parameters',
    url: 'https://ssd.jpl.nasa.gov/sats/phys_par/',
    file: 'jpl_satellites_phys.html',
    kind: 'html',
    credit: JPL,
    minimumBytes: 40_000,
    sentinel: 'Enceladus',
  },
  {
    key: 'satelliteElements',
    name: 'JPL planetary satellite mean elements',
    url: 'https://ssd.jpl.nasa.gov/sats/elem/',
    file: 'jpl_satellites_elem.html',
    kind: 'html',
    credit: JPL,
    minimumBytes: 200_000,
    sentinel: 'Laplace',
  },
]

/**
 * One SBDB query per small body.
 *
 * `full-prec=1` because the default rounds a semi-major axis to seven figures,
 * which is 4,000 km of Bennu's orbit — invisible in a table and a real error to
 * compare a transcription against. `phys-par=1` and `discovery=1` are the two
 * blocks that carry everything this project stores: extent, GM, density,
 * rotation, pole, albedo, and who found it when.
 */
export const sbdbUrl = (designation: string): string =>
  `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(
    designation,
  )}&phys-par=1&discovery=1&full-prec=1`

export interface SmallBodyQuery {
  /** What SBDB is asked for. A number for an asteroid, `1P` for a comet. */
  readonly designation: string
  /** The name this project uses, which is not always SBDB's `shortname`. */
  readonly name: string
}

/*
 * What is asked for, and the rule that decided it.
 *
 * There are 1.4 million numbered small bodies. "Complete" is not a target; it
 * is a category error. The rule here is **a body somebody has resolved** —
 * every asteroid and comet a spacecraft has flown past or orbited, every dwarf
 * planet and dwarf-planet candidate, and the handful of main-belt giants big
 * enough to be worlds. That is the set for which a shape, a rotation and a
 * color are *measurements* rather than a guess dressed as one, which is the
 * line `docs/design/art.md` draws through the whole project.
 *
 * The consequence worth naming: this list is the reason the renderer had to
 * stop drawing spheres. Sixty of these bodies are irregular, and an irregular
 * body drawn as a sphere is not a simplification, it is the wrong object.
 */
export const SMALL_BODIES: readonly SmallBodyQuery[] = [
  /* --- Dwarf planets: the five the IAU recognizes, and the four next in line. */
  { designation: '1', name: 'Ceres' },
  { designation: '134340', name: 'Pluto' },
  { designation: '136199', name: 'Eris' },
  { designation: '136108', name: 'Haumea' },
  { designation: '136472', name: 'Makemake' },
  { designation: '90377', name: 'Sedna' },
  { designation: '50000', name: 'Quaoar' },
  { designation: '90482', name: 'Orcus' },
  { designation: '225088', name: 'Gonggong' },

  /* --- Main-belt bodies large enough to have a geology. */
  { designation: '2', name: 'Pallas' },
  { designation: '3', name: 'Juno' },
  { designation: '4', name: 'Vesta' },
  { designation: '10', name: 'Hygiea' },
  { designation: '16', name: 'Psyche' },
  { designation: '87', name: 'Sylvia' },
  { designation: '243', name: 'Ida' },
  { designation: '253', name: 'Mathilde' },
  { designation: '216', name: 'Kleopatra' },
  { designation: '511', name: 'Davida' },
  { designation: '704', name: 'Interamnia' },

  /* --- Visited: every asteroid a spacecraft has resolved. */
  { designation: '951', name: 'Gaspra' },
  { designation: '433', name: 'Eros' },
  { designation: '5535', name: 'Annefrank' },
  { designation: '25143', name: 'Itokawa' },
  { designation: '2867', name: 'Steins' },
  { designation: '21', name: 'Lutetia' },
  { designation: '4179', name: 'Toutatis' },
  { designation: '162173', name: 'Ryugu' },
  { designation: '101955', name: 'Bennu' },
  { designation: '65803', name: 'Didymos' },
  { designation: '152830', name: 'Dinkinesh' },
  { designation: '52246', name: 'Donaldjohanson' },
  { designation: '3548', name: 'Eurybates' },
  { designation: '15094', name: 'Polymele' },
  { designation: '11351', name: 'Leucus' },
  { designation: '21900', name: 'Orus' },
  { designation: '617', name: 'Patroclus' },
  { designation: '486958', name: 'Arrokoth' },

  /* --- Centaurs. Two of the four small bodies known to have rings. */
  { designation: '10199', name: 'Chariklo' },
  { designation: '2060', name: 'Chiron' },

  /* --- Near-Earth objects worth knowing the orbit of. */
  { designation: '99942', name: 'Apophis' },
  { designation: '3200', name: 'Phaethon' },
  { designation: '1036', name: 'Ganymed' },
  { designation: '1566', name: 'Icarus' },
  { designation: '1620', name: 'Geographos' },
  { designation: '4769', name: 'Castalia' },
  { designation: '6489', name: 'Golevka' },
  { designation: '1998 KY26', name: '1998 KY26' },

  /* --- Comets: the visited nuclei, and the two everybody has seen. */
  { designation: '1P', name: 'Halley' },
  { designation: '2P', name: 'Encke' },
  { designation: '9P', name: 'Tempel 1' },
  { designation: '19P', name: 'Borrelly' },
  { designation: '55P', name: 'Tempel-Tuttle' },
  { designation: '67P', name: 'Churyumov-Gerasimenko' },
  { designation: '81P', name: 'Wild 2' },
  { designation: '103P', name: 'Hartley 2' },
  { designation: '109P', name: 'Swift-Tuttle' },
  { designation: 'C/1995 O1', name: 'Hale-Bopp' },
  { designation: 'C/2020 F3', name: 'NEOWISE' },
]
