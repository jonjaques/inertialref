import {
  invariant,
  type Kelvin,
  LIGHT_YEAR,
  type Meters,
} from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import { type SystemId, systemId } from '../address.ts'
import { cellKey, cellOf, cellsWithin, type GalacticCell } from '../cells.ts'
import { heliocentricToUniverse } from './astrometry.ts'
import {
  bayerName,
  type BayerName,
  constellationGenitive,
  type Designation,
  flamsteedName,
  glieseName,
  searchKey,
  searchKeysFor,
} from './designations.ts'
import {
  type CatalogMetadata,
  decodeCatalog,
  NO_INDEX,
  type PackedCatalog,
  type PackedPlanet,
  type PackedStar,
  type Provenance,
} from './format.ts'
import {
  blackbodyColour,
  effectiveTemperature,
  estimateMass,
  type LinearRgb,
  luminosityFromAbsoluteMagnitude,
  radiusFromLuminosity,
  temperatureFromSpectralType,
} from './photometry.ts'
import {
  isGiant,
  parseSpectralType,
  type SpectralType,
  UNKNOWN_SPECTRAL_TYPE,
} from './spectral.ts'

/*
 * The catalog at runtime.
 *
 * `format.ts` reads the bytes; this turns them into something the simulation and
 * the renderer can use. Two jobs beyond decoding:
 *
 *   **Derive the physics.** A catalog publishes a magnitude and a color; a
 *   renderer needs radiant power, an emission temperature, an angular size and a
 *   mass. `photometry.ts` does the conversion and this applies it once per star
 *   at load, because every one of those is needed by the star map on the first
 *   frame and none of them is cheap to recompute per frame.
 *
 *   **Index it.** Two questions get asked constantly and neither may be a scan
 *   of 7,529 rows: "which star is this id" and "what is within N light-years".
 *   The second is answered through the same cell grid the procedural generator
 *   uses, so that a query's cost depends on the volume asked about and not on
 *   how much catalog happens to exist.
 *
 * This is a *value*, not a service: it is constructed from bytes and never
 * mutates. That is what lets it be an explicit input to generation rather than
 * ambient state, which is what `docs/design/galaxy.md` Rule 1 requires — the
 * catalog version has to be a generation input, and a global would make it a
 * hidden one.
 */

/** Everything about a star that does not follow from anything else. */
export interface StarPhysical {
  /** Bolometric luminosity in solar units. */
  readonly solarLuminosities: number
  readonly solarRadii: number
  readonly solarMasses: number
  /**
   * `derived` when the mass follows from the measurements, `typical` when it is
   * a class-representative value because they do not determine it. A red giant's
   * mass genuinely is not knowable from its light.
   */
  readonly massBasis: 'derived' | 'typical'
  readonly temperature: Kelvin
  /** Linear sRGB of a blackbody at `temperature`, brightest channel normalized. */
  readonly colour: LinearRgb
  /** Absolute visual magnitude as published, or null. */
  readonly absoluteMagnitude: number | null
  /** Color index B−V as published, or null. */
  readonly colourIndex: number | null
  /**
   * True when the physical values above rest on a fallback rather than a
   * measurement — no magnitude, or no classification. The system panel says so
   * rather than presenting a guess as a reading.
   */
  readonly estimated: boolean
}

export interface CatalogPlanet extends PackedPlanet {
  /** `Tau Ceti e` — the host's common name and the planet letter. */
  readonly name: string
}

export interface CatalogStar {
  readonly id: SystemId
  /** The name to show. Never empty. */
  readonly name: string
  /** Every name this star is known by, the common one first. */
  readonly designations: readonly Designation[]
  readonly position: UniverseVector
  /** Distance from the Sun, light-years. */
  readonly distanceLightYears: number
  readonly spectralType: SpectralType
  /** The classification string exactly as published, `''` if there was none. */
  readonly spectralSource: string
  /** Number of stellar components. 1 means "not known to be multiple". */
  readonly components: number
  readonly provenance: Provenance
  readonly physical: StarPhysical
  /** Confirmed planets, in orbital order. */
  readonly planets: readonly CatalogPlanet[]
}

export interface StarCatalog {
  readonly metadata: CatalogMetadata
  /** The whole-catalog version. A generation input; see Rule 1. */
  readonly version: string
  /** Radius of the volume this catalog covers. Procedure owns everything past it. */
  readonly radius: Meters
  /** Radius inside which procedural fill is suppressed; see `CellContext`. */
  readonly completeRadius: Meters
  readonly stars: readonly CatalogStar[]
  /** Exact lookup by id. */
  get(id: SystemId): CatalogStar | undefined
  /** Lookup by any name or designation, case- and punctuation-insensitive. */
  find(text: string): CatalogStar | undefined
  /**
   * Stars whose name or designation matches `text`, best first.
   *
   * `find` is exact-key-only, which is the right answer for an address and the
   * wrong one for a search box — nothing could reach a star by typing three
   * letters of its name. The panels filtered a *survey* instead, so a search
   * could only find what was already within a few light years of the camera;
   * this answers over the whole catalog, which is a question the survey
   * interface cannot even express.
   *
   * Indexed, never a scan of the star list: the keys are built once at decode
   * (measured at 0.18 ms marginal, because the decode loop already computes
   * them for `find`) and a query over all 16,537 of them takes 0.14–0.30 ms —
   * comfortably per-keystroke, where a 150 ly star sweep is not.
   *
   * Ranked exact, then prefix, then substring, and nearest first within each.
   * `limit` is the number of *stars*, not of matched keys.
   */
  search(text: string, limit?: number): readonly CatalogStar[]
  /** Every cataloged star within `radius` of a point, unordered. */
  within(centre: UniverseVector, radius: Meters): readonly CatalogStar[]
  /** Cataloged stars in one generation cell. The procedural fill needs the count. */
  inCell(cell: GalacticCell): readonly CatalogStar[]
}

/* ------------------------------------------------------------------------- */
/* Deriving one star                                                          */
/* ------------------------------------------------------------------------- */

/** When nothing is known, the neighborhood's most common kind of star. */
const FALLBACK_TEMPERATURE: Kelvin = 3_550
const FALLBACK_LUMINOSITY = 0.02

function derivePhysical(packed: PackedStar, type: SpectralType): StarPhysical {
  const temperature =
    effectiveTemperature(type, packed.colourIndex) ?? FALLBACK_TEMPERATURE
  const evolved = isGiant(type)
  const estimated =
    packed.absoluteMagnitude === null ||
    (packed.colourIndex === null && type.spectralClass === null)

  const solarLuminosities =
    packed.absoluteMagnitude === null
      ? FALLBACK_LUMINOSITY
      : luminosityFromAbsoluteMagnitude(
          packed.absoluteMagnitude,
          temperature,
          evolved,
        )
  const mass = estimateMass(type, solarLuminosities)
  return {
    solarLuminosities,
    solarRadii: radiusFromLuminosity(solarLuminosities, temperature),
    solarMasses: mass.solarMasses,
    massBasis: mass.basis,
    temperature,
    colour: blackbodyColour(temperature),
    absoluteMagnitude: packed.absoluteMagnitude,
    colourIndex: packed.colourIndex,
    estimated,
  }
}

const BAYER_LETTERS = [
  'Alp',
  'Bet',
  'Gam',
  'Del',
  'Eps',
  'Zet',
  'Eta',
  'The',
  'Iot',
  'Kap',
  'Lam',
  'Mu',
  'Nu',
  'Xi',
  'Omi',
  'Pi',
  'Rho',
  'Sig',
  'Tau',
  'Ups',
  'Phi',
  'Chi',
  'Psi',
  'Ome',
] as const

const CONSTELLATION_ABBREVIATIONS = [
  'And',
  'Ant',
  'Aps',
  'Aqr',
  'Aql',
  'Ara',
  'Ari',
  'Aur',
  'Boo',
  'Cae',
  'Cam',
  'Cnc',
  'CVn',
  'CMa',
  'CMi',
  'Cap',
  'Car',
  'Cas',
  'Cen',
  'Cep',
  'Cet',
  'Cha',
  'Cir',
  'Col',
  'Com',
  'CrA',
  'CrB',
  'Crv',
  'Crt',
  'Cru',
  'Cyg',
  'Del',
  'Dor',
  'Dra',
  'Equ',
  'Eri',
  'For',
  'Gem',
  'Gru',
  'Her',
  'Hor',
  'Hya',
  'Hyi',
  'Ind',
  'Lac',
  'Leo',
  'LMi',
  'Lep',
  'Lib',
  'Lup',
  'Lyn',
  'Lyr',
  'Men',
  'Mic',
  'Mon',
  'Mus',
  'Nor',
  'Oct',
  'Oph',
  'Ori',
  'Pav',
  'Peg',
  'Per',
  'Phe',
  'Pic',
  'Psc',
  'PsA',
  'Pup',
  'Pyx',
  'Ret',
  'Sge',
  'Sgr',
  'Sco',
  'Scl',
  'Sct',
  'Ser',
  'Sex',
  'Tau',
  'Tel',
  'Tri',
  'TrA',
  'Tuc',
  'UMa',
  'UMi',
  'Vel',
  'Vir',
  'Vol',
  'Vul',
] as const

/**
 * The index tables the packed file's `bayer` and `constellation` bytes point at.
 *
 * Exported because the ingest writes those bytes and must agree about what they
 * mean. Order is fixed forever: inserting a constellation would silently move
 * every star after it into a different sky.
 */
export const CATALOG_TABLES = {
  bayer: BAYER_LETTERS,
  constellations: CONSTELLATION_ABBREVIATIONS,
} as const

/** The packed Bayer fields expanded, or null where the star has none. */
function expandedBayerOf(
  packed: PackedStar,
  keepSuperscript = true,
): BayerName | null {
  const constellation =
    packed.constellation === NO_INDEX
      ? null
      : (CONSTELLATION_ABBREVIATIONS[packed.constellation] ?? null)
  if (packed.bayer === NO_INDEX || constellation === null) return null
  const letter = BAYER_LETTERS[packed.bayer]
  if (letter === undefined) return null
  const raw =
    packed.bayerSuperscript > 0
      ? `${letter}-${packed.bayerSuperscript}`
      : letter
  return bayerName(raw, constellation, keepSuperscript)
}

/**
 * Every name a star is known by, most familiar first.
 *
 * The common name leads because it is what the HUD shows and what a player
 * types; the catalog numbers trail because they are what a paper cites.
 */
export function designationsOf(packed: PackedStar): readonly Designation[] {
  const names: Designation[] = []
  const constellation =
    packed.constellation === NO_INDEX
      ? null
      : (CONSTELLATION_ABBREVIATIONS[packed.constellation] ?? null)

  if (packed.proper !== '') names.push({ kind: 'proper', text: packed.proper })

  const expanded = expandedBayerOf(packed)
  if (expanded !== null) names.push({ kind: 'bayer', text: expanded.text })

  if (packed.flamsteed > 0 && constellation !== null) {
    const text = flamsteedName(String(packed.flamsteed), constellation)
    if (text !== null) names.push({ kind: 'flamsteed', text })
  }

  const gliese = glieseName(packed.gliese)
  if (gliese !== null) names.push({ kind: 'gliese', text: gliese })
  if (packed.hip > 0)
    names.push({ kind: 'hipparcos', text: `HIP ${packed.hip}` })
  if (packed.hd > 0)
    names.push({ kind: 'henry-draper', text: `HD ${packed.hd}` })
  if (packed.hr > 0)
    names.push({ kind: 'harvard-revised', text: `HR ${packed.hr}` })

  // The chosen common name may be a form none of the above produced — an α Cen
  // whose superscript was dropped, for instance. Put it first either way, and do
  // not repeat it.
  const rest = names.filter((n) => n.text !== packed.commonName)
  const chosen = names.find((n) => n.text === packed.commonName)
  return [{ kind: chosen?.kind ?? 'proper', text: packed.commonName }, ...rest]
}

/* ------------------------------------------------------------------------- */
/* The catalog                                                              */
/* ------------------------------------------------------------------------- */

class DecodedCatalog implements StarCatalog {
  readonly metadata: CatalogMetadata
  readonly stars: readonly CatalogStar[]
  readonly #byId = new Map<SystemId, CatalogStar>()
  readonly #byName = new Map<string, CatalogStar>()
  readonly #byCell = new Map<string, CatalogStar[]>()
  /*
   * The search index: every key, and the star it belongs to, in parallel
   * arrays.
   *
   * `#byName` cannot serve this. It keeps the *first* star per key — which is
   * what an exact lookup wants — so it can neither rank a partial match nor
   * report the second star that shares a designation prefix. These are the same
   * keys, all of them, kept rather than discarded: the decode loop already
   * computes them, so the marginal cost is the pushes (measured, 0.18 ms).
   *
   * Parallel arrays rather than an array of pairs, because this is scanned per
   * keystroke and 16,537 objects is 16,537 allocations that buy nothing.
   */
  readonly #searchKeys: string[] = []
  readonly #searchStars: CatalogStar[] = []

  constructor(packed: PackedCatalog) {
    this.metadata = packed.metadata

    const planetsByHost = new Map<number, PackedPlanet[]>()
    for (const planet of packed.planets) {
      const list = planetsByHost.get(planet.host)
      if (list === undefined) planetsByHost.set(planet.host, [planet])
      else list.push(planet)
    }

    const stars: CatalogStar[] = []
    for (let index = 0; index < packed.stars.length; index += 1) {
      const row = packed.stars[index] as PackedStar
      const type =
        row.spectralType === ''
          ? UNKNOWN_SPECTRAL_TYPE
          : parseSpectralType(row.spectralType)
      const position = heliocentricToUniverse(row.x, row.y, row.z)
      const designations = designationsOf(row)
      const planets = (planetsByHost.get(index) ?? [])
        .map((planet) => ({
          ...planet,
          name:
            planet.name === ''
              ? `${row.commonName} ${planet.letter}`
              : planet.name,
        }))
        // Orbital order for display. Planets with no published semi-major axis
        // sort last rather than to zero, which would put an unmeasured orbit
        // inside every measured one.
        .sort(
          (a, b) =>
            (a.semiMajorAxisAu ?? Infinity) - (b.semiMajorAxisAu ?? Infinity),
        )

      const star: CatalogStar = {
        id: systemId(row.id),
        name: row.commonName,
        designations,
        position,
        distanceLightYears: Math.hypot(row.x, row.y, row.z) / LIGHT_YEAR,
        spectralType: type,
        spectralSource: row.spectralType,
        components: row.components,
        provenance: row.provenance,
        physical: derivePhysical(row, type),
        planets,
      }
      stars.push(star)

      this.#byId.set(star.id, star)
      // The Greek Bayer form (`α Cen`) is search-only: designations.ts
      // promises it is findable — it is what gets pasted out of Wikipedia —
      // but listing it as a designation would cite the same catalog twice
      // on the system panel.
      const greek = expandedBayerOf(row)?.greek
      const shared = searchKeysFor(
        designations,
        greek === undefined ? [star.id] : [star.id, greek],
      )
      for (const key of shared) {
        if (!this.#byName.has(key)) this.#byName.set(key, star)
        this.#searchKeys.push(key)
        this.#searchStars.push(star)
      }

      /*
       * Search-only keys: the Bayer forms with the superscript dropped.
       *
       * `α Cen` is what gets pasted out of Wikipedia, and `designations.ts`
       * says so — but only `α¹ Cen` was ever indexed, because dropping the
       * superscript keys `ζ¹ Reticuli` and `ζ² Reticuli` — two unrelated
       * systems — to one string, and `find` must not answer an ambiguous name
       * with an arbitrary one of two.
       *
       * That is a constraint on `find`, not on `search`. A search box handed an
       * ambiguous name should offer *both* stars; this is exactly what the
       * split by question buys, so these go into the search index and stay out
       * of the exact map.
       */
      const plain = expandedBayerOf(row, false)
      if (plain !== null) {
        for (const key of searchKeysFor([], [plain.text, plain.greek])) {
          if (shared.includes(key)) continue
          this.#searchKeys.push(key)
          this.#searchStars.push(star)
        }
      }

      const key = cellKey(cellOf(position))
      const bucket = this.#byCell.get(key)
      if (bucket === undefined) this.#byCell.set(key, [star])
      else bucket.push(star)
    }
    this.stars = stars
  }

  get version(): string {
    return this.metadata.version
  }

  get radius(): Meters {
    return this.metadata.radiusLightYears * LIGHT_YEAR
  }

  get completeRadius(): Meters {
    return this.metadata.completeRadiusLightYears * LIGHT_YEAR
  }

  get(id: SystemId): CatalogStar | undefined {
    return this.#byId.get(id)
  }

  find(text: string): CatalogStar | undefined {
    return this.#byName.get(searchKey(text))
  }

  search(text: string, limit = 20): readonly CatalogStar[] {
    const needle = searchKey(text)
    // An empty needle matches every key at position 0, which would return the
    // first `limit` stars in decode order dressed up as search results.
    if (needle === '') return []

    /*
     * The best rank per *star*, not per key.
     *
     * A star is in the index under several keys — `HIP71683`, `alphacentauri`,
     * `rigilkentaurus`, `αcen` — and a query can hit more than one of them at
     * different ranks. Keeping the best is what stops "cen" returning Alpha
     * Centauri three times while the star below it never appears.
     */
    const best = new Map<SystemId, { star: CatalogStar; rank: number }>()
    for (let i = 0; i < this.#searchKeys.length; i += 1) {
      const key = this.#searchKeys[i] as string
      const at = key.indexOf(needle)
      if (at === -1) continue
      const rank = key === needle ? 0 : at === 0 ? 1 : 2
      const star = this.#searchStars[i] as CatalogStar
      const found = best.get(star.id)
      if (found === undefined || rank < found.rank)
        best.set(star.id, { star, rank })
    }

    // Nearest first within a rank, because a search box in a navigation panel
    // is a way of *going* somewhere: the reachable Sirius outranks a match
    // 140 light years out that happens to share a prefix.
    return [...best.values()]
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.star.distanceLightYears - b.star.distanceLightYears,
      )
      .slice(0, limit)
      .map((one) => one.star)
  }

  inCell(cell: GalacticCell): readonly CatalogStar[] {
    return this.#byCell.get(cellKey(cell)) ?? []
  }

  within(centre: UniverseVector, radius: Meters): readonly CatalogStar[] {
    const found: CatalogStar[] = []
    for (const cell of cellsWithin(centre, radius))
      for (const star of this.inCell(cell))
        if (UV.distance(star.position, centre) <= radius) found.push(star)
    return found
  }
}

export const loadCatalog = (packed: PackedCatalog): StarCatalog =>
  new DecodedCatalog(packed)

/** Decode a packed catalog file and index it. */
export function readCatalog(bytes: Uint8Array): StarCatalog {
  const packed = decodeCatalog(bytes)
  invariant(
    packed.stars.length > 0,
    'Star catalog decoded to zero stars; the file is truncated or empty',
  )
  return new DecodedCatalog(packed)
}

/* ------------------------------------------------------------------------- */
/* The fallback                                                               */
/* ------------------------------------------------------------------------- */

/*
 * One star, so that a host with no catalog asset still has somewhere to be.
 *
 * The alternative — refusing to start — makes every unit test that touches a
 * `World` depend on a 160 KB binary, and makes a failed fetch a blank screen
 * rather than a smaller galaxy. This is honest about what it is: `radius: 0`
 * means the catalog claims no volume, so procedural generation fills
 * everything including the solar neighborhood, and the horizon-of-knowledge
 * shell correctly collapses to nothing.
 */
const SOL_ROW: PackedStar = {
  id: 'SOL',
  x: 0,
  y: 0,
  z: 0,
  absoluteMagnitude: 4.85,
  colourIndex: 0.656,
  spectralType: 'G2V',
  components: 1,
  provenance: 'observed',
  hip: 0,
  hd: 0,
  hr: 0,
  constellation: NO_INDEX,
  bayer: NO_INDEX,
  bayerSuperscript: 0,
  flamsteed: 0,
  proper: 'Sol',
  gliese: '',
  commonName: 'Sol',
}

export const SOL_ONLY_CATALOG: StarCatalog = new DecodedCatalog({
  metadata: {
    version: 'sol-only',
    radiusLightYears: 0,
    completeRadiusLightYears: 0,
    attribution: [],
    sources: [],
  },
  stars: [SOL_ROW],
  planets: [],
})

export { constellationGenitive, temperatureFromSpectralType }
