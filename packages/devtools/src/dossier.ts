import {
  AU,
  EARTH_MASS,
  EARTH_RADIUS,
  GRAVITATIONAL_CONSTANT,
  JUPITER_MASS,
  JUPITER_RADIUS,
  type Kilograms,
  LIGHT_YEAR,
  type Meters,
  metersToParsecs,
  type Seconds,
  SECONDS_PER_DAY,
  SECONDS_PER_YEAR,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  STEFAN_BOLTZMANN,
} from '@inertialref/shared'
import { apoapsis, normalizeAngle, periapsis } from '@inertialref/physics'
import type { World } from '@inertialref/simulation'
import {
  archetypeName,
  type Body,
  type BodyKind,
  type BodyProvenance,
  type CatalogStar,
  findBody as findBodyAt,
  formatAddress,
  frostLine,
  habitableZone,
  hasSolidSurface,
  insolation,
  isDebris,
  isHabitable,
  isPlanetKind,
  orbitalOrder,
  parseSpectralType,
  type ReliefSource,
  type Star,
  type StarSystem,
  type SystemId,
  type UniverseAddress,
  volumetricMeanRadius,
  walkBodies,
} from '@inertialref/universe'
import { currentSystemOf, resolveDestination } from './travel.ts'
import type { HarnessHost } from './harness.ts'

/*
 * What a thing *is*, as a page of astronomy.
 *
 * The planetarium's object panel used to answer a different question. It showed
 * the range to the camera, the fraction of the frame the disk covered, the two
 * orbit angles and the address string — a readout of the *instrument*, in a mode
 * whose entire subject is the thing being looked at. Four rows about the
 * telescope and one about Mars.
 *
 * So this is the other half, and it lives here rather than in the panel for the
 * reason `travel.ts` does: it is a query over the world, it is the kind of thing
 * that gets an extra row every week, and every derivation in it — a density, a
 * synodic day, the angular size of the star in this body's sky — is arithmetic
 * that deserves a test in Node rather than a component that has to be rendered
 * to be checked.
 *
 * ## Four rules it follows
 *
 * **Derive, never store.** Density, surface gravity, escape velocity, the
 * parallax and the habitable zone are all computed from what the body already
 * carries. That is the catalog's own rule ("never store what the catalog can
 * derive") applied one layer up, and it is why a change to a planet's mass moves
 * nine numbers here rather than leaving eight of them stale.
 *
 * **Nothing about the camera.** No range, no fill, no azimuth. Those are facts
 * about where you are standing, they belong to the instrument, and mixing them
 * into a body's record is what made the old panel read as a debugger. The
 * observatory's own readout is in the author's Camera instrument now.
 *
 * **An empty field is a row, not an omission.** `Fact.value` is nullable and a
 * null draws as *no data* with a reason attached. A reader can then tell "this
 * body has no atmosphere" from "nobody has measured its atmosphere", which are
 * completely different claims and are indistinguishable when the row is simply
 * absent. It also means the panel shows the shape of the record that is coming:
 * every empty field here is one the survey will eventually fill, and the list of
 * them is the specification for filling it.
 * `docs/design/planetarium.md` § "The record that is not filled in yet" is the
 * same list with the engineering source for each.
 *
 * **The reason is written in the universe's voice, never in the engine's.**
 * "No spectrometer has resolved this body's interior" and "the generator does
 * not produce a composition" are the same fact and only the first one may be
 * shown. A projected body is *real* — the galaxy is real, and `projected` means
 * the ship's computer worked it out from the star's parameters rather than
 * somebody having flown there ([galaxy](docs/design/galaxy.md): "projected from
 * stellar parameters — not confirmed"). The planetarium is a reading room for
 * that galaxy, not a debugger with a starfield behind it, and a panel that said
 * "not modeled yet" would be telling the reader the sky is a program.
 */

/** One reading: what it is, what it says, and a second scale for the same thing. */
export interface Fact {
  readonly label: string
  /**
   * The reading, or **null** where the record has no entry.
   *
   * Null is not an error and not an empty string — it is the honest answer, and
   * `pending` is required alongside it. See the header: a row that is simply
   * absent cannot distinguish "this body has none" from "nothing has measured
   * it", and those are the two answers a planetarium most needs to keep apart.
   */
  readonly value: string | null
  /**
   * The same quantity in the unit a reader actually thinks in.
   *
   * `5.97×10²⁴ kg` is a number nobody has an intuition for and `1.00 M⊕` is the
   * whole point of it. Two rows would separate them by the width of the panel;
   * one row with a trailing gloss keeps the comparison where the measurement is.
   */
  readonly note?: string
  /**
   * Why the field is empty, in the universe's own terms. Set exactly when
   * `value` is null.
   */
  readonly pending?: string
}

/** A titled run of facts. `id` is what its collapsed state is remembered by. */
export interface FactGroup {
  readonly id: string
  readonly title: string
  /** One line under the heading, when the group needs a caveat rather than a row. */
  readonly caption?: string
  readonly facts: readonly Fact[]
}

/** A body going round this one, as a row that can be clicked. */
export interface Satellite {
  readonly address: string
  readonly name: string
  readonly kind: BodyKind
  readonly radius: Meters
  readonly semiMajorAxis: Meters
  readonly orbitalPeriod: Seconds
}

/** Everything the object panel draws, for one star or one body. */
export interface Dossier {
  readonly address: string
  readonly name: string
  /** `star`, or the body's own class. Decides the glyph and the header line. */
  readonly kind: 'star' | BodyKind
  /** `Fourth planet of Sol`, `Ice giant`, `G-type main sequence star`. */
  readonly classification: string
  readonly provenance: BodyProvenance
  /** One sentence: what this is, in the reader's language rather than the model's. */
  readonly summary: string
  readonly system: { readonly id: SystemId; readonly name: string }
  /** What it goes round, or null for a star. */
  readonly primary: { readonly address: string; readonly name: string } | null
  readonly groups: readonly FactGroup[]
  readonly satellites: readonly Satellite[]
  /** How many fields are still empty. The panel's header says so once. */
  readonly pendingCount: number
}

/**
 * A field the record has no entry for.
 *
 * One helper so the shape cannot drift, and so every call site is forced to
 * supply the `why` — a bare "no data" is the thing this design is trying not to
 * be. See the header on the voice these are written in.
 */
const noData = (label: string, why: string, note?: string): Fact => ({
  label,
  value: null,
  pending: why,
  ...(note === undefined ? {} : { note }),
})

/* ------------------------------------------------------------------------- */
/* The entry point                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The record for whatever an address names, or null if it names nothing.
 *
 * Lenient about its input in exactly the way `Observatory.focus` is, and through
 * the same resolver: this is fed the address the observatory is already holding,
 * and a second parser would be a second addressing scheme.
 */
export function dossier(host: HarnessHost, address: string): Dossier | null {
  const world = host.world
  /*
   * `loadSystem` is inside the guard, not after it.
   *
   * A well-formed address for a system the catalog does not hold parses
   * cleanly and then trips `World.loadSystem`'s own `Unknown system` invariant —
   * so `dossier('s:NOSUCH')` threw past a signature that says `| null`. Only
   * `useDossier` had a catch of its own; the console, the headless runner and a
   * `?at=` URL carrying a save's address all took the throw.
   */
  let system
  let resolved
  try {
    resolved = resolveDestination(
      address,
      world.galaxy,
      currentSystemOf(world, host.player()),
    )
    system = world.loadSystem(resolved.system)
  } catch {
    return null
  }

  if (resolved.kind === 'system') return starDossier(world, system)
  const body = findBody(system, resolved.address)
  return body === undefined ? null : bodyDossier(world, system, body)
}

/** Fields still waiting on an observation, across the whole page. */
const countPending = (groups: readonly FactGroup[]): number =>
  groups.reduce(
    (total, group) =>
      total + group.facts.filter((fact) => fact.value === null).length,
    0,
  )

/* ------------------------------------------------------------------------- */
/* A star                                                                     */
/* ------------------------------------------------------------------------- */

function starDossier(world: World, system: StarSystem): Dossier {
  const star = system.star
  const cataloged = world.catalog.get(system.id)
  const spectral = parseSpectralType(star.spectralType)
  const zone = habitableZone(star)
  const frost = frostLine(star.luminosity)
  const census = censusOf(system)
  const parsecs =
    cataloged === undefined
      ? null
      : metersToParsecs(cataloged.distanceLightYears * LIGHT_YEAR)

  const physical: Fact[] = [
    {
      label: 'Spectral type',
      value: star.spectralType.length > 0 ? star.spectralType : '—',
      ...(spectral.luminosity === null
        ? {}
        : { note: LUMINOSITY_CLASS[spectral.luminosity] }),
    },
    {
      label: 'Temperature',
      value: `${round(star.temperature, 0)} K`,
      note: colourWord(star.temperature),
    },
    {
      label: 'Luminosity',
      value: `${significant(star.luminosity / SOLAR_LUMINOSITY)} L☉`,
      note: `${exponential(star.luminosity)} W`,
    },
    {
      label: 'Mass',
      value: `${round(star.mass / SOLAR_MASS, 3)} M☉`,
      note: `${exponential(star.mass)} kg`,
    },
    {
      label: 'Radius',
      value: `${round(star.radius / SOLAR_RADIUS, 3)} R☉`,
      note: kilometres(star.radius),
    },
    { label: 'Mean density', value: density(star.mass, star.radius) },
    {
      label: 'Surface gravity',
      value: `${significant(gravity(star.mass, star.radius))} m/s²`,
      note: `${significant(gravity(star.mass, star.radius) / STANDARD_GRAVITY)} g`,
    },
    {
      label: 'Absolute magnitude',
      value:
        cataloged?.physical.absoluteMagnitude == null
          ? null
          : round(cataloged.physical.absoluteMagnitude, 2),
      ...(cataloged?.physical.absoluteMagnitude == null
        ? {
            pending:
              'no photometric survey has returned a visual magnitude for this star. Its temperature and radius are inferred from the class alone',
          }
        : { note: 'visual, at 10 pc' }),
    },
    {
      label: 'Color index',
      value:
        cataloged?.physical.colourIndex == null
          ? null
          : round(cataloged.physical.colourIndex, 3),
      ...(cataloged?.physical.colourIndex == null
        ? {
            pending:
              'B−V requires two-band photometry. This star has been classified but not measured that way',
          }
        : { note: 'B−V' }),
    },
    noData(
      'Age',
      'dating a star means fitting it to an isochrone, which needs a metallicity and a surface gravity nobody has published for it',
    ),
    noData(
      'Metallicity',
      '[Fe/H] comes out of a high-resolution spectrum. None is on file for this star',
    ),
    noData(
      'Rotation period',
      'spin is read from starspots crossing the disk over months of photometry. This star has no such light curve on record',
    ),
    noData(
      'Variability',
      'nothing has watched this star long enough to say whether its output holds steady',
    ),
  ]

  const habitable = [...walkBodies(system)].filter((body) =>
    isHabitable(star, body),
  ).length

  const groups: FactGroup[] = [
    {
      id: 'star.physical',
      title: 'The Star',
      ...(cataloged?.physical.estimated === true
        ? {
            caption:
              'classified but not measured — the figures below are typical of the class',
          }
        : {}),
      facts: physical,
    },
    {
      id: 'star.system',
      title: 'System',
      facts: [
        { label: 'Planets', value: `${census.planets}` },
        { label: 'Dwarf planets', value: `${census.dwarfs}` },
        { label: 'Moons', value: `${census.moons}` },
        {
          label: 'Small bodies',
          value: `${census.debris}`,
          note: 'asteroids and comets',
        },
        {
          /*
           * Both halves count the same thing.
           *
           * `observedPlanets` is planets — Sol packs `SOLAR_PLANETS.length`, 8 —
           * so putting the dwarfs in the denominator wrote "8 of 17" over the
           * one system every reader opens first, with a note calling Pluto,
           * Ceres and Eris this build's own guesses. All seventeen are observed.
           */
          label: 'Confirmed',
          value: `${system.observedPlanets} of ${census.planets}`,
          note:
            system.observedPlanets < census.planets
              ? 'the rest projected'
              : 'every planet here has been seen',
        },
        {
          label: 'In the habitable zone',
          value: `${habitable}`,
          note: 'rocky, with an atmosphere',
        },
        {
          label: 'Companions',
          value:
            cataloged === undefined
              ? null
              : cataloged.components > 1
                ? `${cataloged.components - 1} recorded`
                : 'None recorded',
          ...(cataloged === undefined
            ? {
                pending:
                  'multiplicity is settled by resolving a star into components, which takes an instrument nobody has pointed here',
              }
            : cataloged.components > 1
              ? { note: 'the primary is charted' }
              : {}),
        },
        noData(
          'Companion orbits',
          'the separation and period of a multiple system come from decades of astrometry. Only the primary is charted here',
        ),
        noData(
          'Debris disk',
          'a dust belt shows as an infrared excess. No survey at those wavelengths covers this star',
        ),
      ],
    },
    {
      id: 'star.zones',
      title: 'Zones',
      caption:
        'both are solved from the star’s luminosity — they are boundaries of sunlight, not of climate',
      facts: [
        {
          label: 'Habitable zone',
          value: `${round(zone.inner / AU, 3)} – ${round(zone.outer / AU, 3)} AU`,
          note: 'liquid water, on a world with air',
        },
        {
          label: 'Frost line',
          value: `${round(frost / AU, 3)} AU`,
          note: 'volatiles survive beyond it',
        },
      ],
    },
    {
      id: 'star.record',
      title: 'Record',
      facts: [
        {
          label: 'Distance from Sol',
          value:
            cataloged === undefined
              ? null
              : `${round(cataloged.distanceLightYears, 3)} ly`,
          ...(cataloged === undefined
            ? {
                pending:
                  'this star’s place is fixed by the galactic model rather than by a parallax measurement',
              }
            : { note: `${round(parsecs ?? 0, 3)} pc` }),
        },
        {
          label: 'Parallax',
          value:
            parsecs === null || parsecs === 0
              ? null
              : `${round(1 / parsecs, 4)}″`,
          ...(parsecs === null || parsecs === 0
            ? { pending: 'no astrometric parallax has been taken of this star' }
            : { note: 'the angle the parsec is defined by' }),
        },
        {
          label: 'Also known as',
          value:
            cataloged === undefined
              ? null
              : cataloged.designations
                  .slice(0, 6)
                  .map((one) => one.text)
                  .join(' · '),
          ...(cataloged === undefined
            ? {
                pending:
                  'this star carries a survey address and no name anybody has given it',
              }
            : {}),
        },
        noData(
          'Proper motion',
          'the catalog holds one epoch. Two are needed before anything can be said to be moving across the sky',
        ),
        noData(
          'Radial velocity',
          'the Doppler shift along the line of sight. It needs a spectrum this star has not had taken',
        ),
        noData(
          'Constellation',
          'the eighty-eight boundaries are drawn from Earth’s sky and are not carried in this catalog',
        ),
      ],
    },
  ]

  return {
    address: `g:${world.galaxy}/s:${system.id}`,
    name: system.name,
    kind: 'star',
    classification: starClassification(star, spectral.luminosity),
    provenance: cataloged === undefined ? 'projected' : 'observed',
    summary: starSummary(star, census, cataloged),
    system: { id: system.id, name: system.name },
    primary: null,
    groups,
    satellites: [],
    pendingCount: countPending(groups),
  }
}

/* ------------------------------------------------------------------------- */
/* A body                                                                     */
/* ------------------------------------------------------------------------- */

function bodyDossier(world: World, system: StarSystem, body: Body): Dossier {
  const star = system.star
  const primary = primaryOf(system, body)
  const groups: FactGroup[] = [
    physicalGroup(body),
    orbitGroup(world, body, primary),
    // The period about the *star*, through the primary where there is one:
    // what moves the Sun across a moon's sky is its planet's year. See
    // `synodicDay`, where getting this wrong gives Luna an infinite day.
    rotationGroup(body, (primary ?? body).orbitalPeriod),
    atmosphereGroup(body),
    insolationGroup(star, body, primary),
  ]
  const geology = geologyGroup(body)
  if (geology !== null) groups.splice(1, 0, geology)
  const rings = ringGroup(body)
  if (rings !== null) groups.push(rings)
  groups.push(discoveryGroup(body))

  return {
    address: formatAddress(body.address),
    name: body.name,
    kind: body.kind,
    classification: classifyBody(system, body, primary),
    provenance: body.provenance,
    summary: bodySummary(star, body, primary),
    system: { id: system.id, name: system.name },
    primary:
      primary === null
        ? { address: `g:${world.galaxy}/s:${system.id}`, name: system.name }
        : { address: formatAddress(primary.address), name: primary.name },
    groups,
    satellites: body.moons.map((moon) => ({
      address: formatAddress(moon.address),
      name: moon.name,
      kind: moon.kind,
      radius: moon.radius,
      semiMajorAxis: moon.elements.semiMajorAxis,
      orbitalPeriod: moon.orbitalPeriod,
    })),
    pendingCount: countPending(groups),
  }
}

function physicalGroup(body: Body): FactGroup {
  const facts: Fact[] = []
  const figure = body.figure
  /*
   * The radius a volume is taken from, which is never `body.radius`.
   *
   * `radius` is the equatorial half-extent — the *largest* of the three on a
   * body gravity never rounded off — and every quantity below cubes or squares
   * it. Phobos is 13.3 × 11.9 × 9.8 km, so quoting 13.3 overstates its volume
   * by half and reports a mean density of 1.08 g/cm³ against a published 1.88,
   * directly under a row that has just printed the correct mean radius. The
   * spheroid case is the same error two orders of magnitude smaller: Earth's
   * equatorial radius gives 5.496 g/cm³ against a published 5.514.
   */
  const meanRadius = Math.cbrt(
    body.radius *
      (figure?.intermediateRadius ?? body.radius) *
      body.polarRadius,
  )

  if (figure === null) {
    facts.push({
      label: 'Radius',
      value: kilometres(body.radius),
      note: radiusNote(body.radius),
    })
    /*
     * Polar radius only where it is visible.
     *
     * Every rotating body is flattened by some amount and most of them by an
     * amount no telescope resolves; printing "1.0000" against Mercury's is a row
     * that says nothing, and Saturn's 0.902 is the first thing that reads as
     * wrong when a gas giant is drawn round. A tenth of a percent is where the
     * ellipticity starts being a fact about the picture.
     */
    const flattening = 1 - body.polarRadius / body.radius
    if (flattening > 1e-3) {
      facts.push({
        label: 'Polar radius',
        value: kilometres(body.polarRadius),
        note: `${round(flattening * 100, 2)}% flattened`,
      })
    }
  } else {
    /*
     * Three half-extents, because there is no radius to give.
     *
     * A body below the rounding limit kept whatever shape the last collision
     * left it, and `radius` is only the largest of three. Phobos is 13.0 × 11.4
     * × 9.1 km and quoting 13 alone overstates its volume by two thirds.
     */
    facts.push({
      label: 'Half-extents',
      value: `${round(body.radius / 1000, 1)} × ${round(
        figure.intermediateRadius / 1000,
        1,
      )} × ${round(body.polarRadius / 1000, 1)} km`,
      note: 'not a sphere',
    })
    facts.push({
      label: 'Mean radius',
      value: kilometres(meanRadius),
      note: 'same volume',
    })
  }

  facts.push({
    label: 'Mass',
    value: `${exponential(body.mass)} kg`,
    note: massNote(body.mass),
  })
  facts.push({ label: 'Mean density', value: density(body.mass, meanRadius) })
  const g = gravity(body.mass, meanRadius)
  facts.push({
    label: 'Surface gravity',
    value: `${significant(g)} m/s²`,
    note: `${significant(g / STANDARD_GRAVITY)} g`,
  })
  facts.push({
    label: 'Escape velocity',
    value: `${significant(Math.sqrt((2 * body.mu) / meanRadius) / 1000)} km/s`,
  })
  facts.push({
    label: 'Geometric albedo',
    value: round(body.appearance.geometricAlbedo, 3),
    note: albedoWord(body.appearance.geometricAlbedo),
  })
  facts.push(
    noData(
      'Composition',
      'the mean density says what this body weighs per litre and nothing about what is where. Separating a core from a mantle takes a gravity map from orbit, or a seismometer on the ground',
      'density implies it; nothing states it',
    ),
  )
  facts.push(
    noData(
      'Age',
      'a surface is dated by counting craters on it or by returning a sample. Neither has been done here',
    ),
  )
  return { id: 'body.physical', title: 'Physical', facts }
}

function orbitGroup(world: World, body: Body, primary: Body | null): FactGroup {
  const elements = body.elements
  const facts: Fact[] = []
  const moonScale = body.address.kind === 'body' && body.address.body.length > 1
  const span = (metres: Meters): string =>
    moonScale ? kilometres(metres) : `${round(metres / AU, 4)} AU`

  facts.push({
    label: 'Semi-major axis',
    value: span(elements.semiMajorAxis),
    note: moonScale
      ? `${round(elements.semiMajorAxis / AU, 6)} AU`
      : kilometres(elements.semiMajorAxis),
  })
  facts.push({
    label: 'Orbital period',
    value: period(body.orbitalPeriod),
    note: `${round(body.orbitalPeriod / SECONDS_PER_DAY, 3)} d`,
  })
  facts.push({
    label: 'Eccentricity',
    value: round(elements.eccentricity, 4),
    note: eccentricityWord(elements.eccentricity),
  })
  /*
   * The three angles, and the symbol lives in the *label*.
   *
   * A note is a gloss — a second reading of the same quantity, in the unit a
   * person thinks in — and it is set small and right-aligned under the value.
   * "Ω — where it crosses the plane going north" is not a gloss, it is a
   * definition, and at that width it wrapped to three lines under a number
   * three characters long. The symbol is the thing an astronomer reads and it
   * belongs beside the name of the element; the definition is a tooltip's job.
   */
  facts.push({
    label: 'Inclination',
    value: `${round(degrees(elements.inclination), 3)}°`,
    note: primary === null ? 'to the plane' : `to ${primary.name}’s equator`,
  })
  facts.push({
    label: 'Ascending node Ω',
    value: `${round(degrees(elements.longitudeOfAscendingNode), 2)}°`,
  })
  facts.push({
    label: 'Periapsis argument ω',
    value: `${round(degrees(elements.argumentOfPeriapsis), 2)}°`,
  })
  facts.push({ label: 'Periapsis', value: span(periapsis(elements)) })
  facts.push({ label: 'Apoapsis', value: span(apoapsis(elements)) })
  facts.push({
    label: 'Mean orbital speed',
    value: `${significant(
      (2 * Math.PI * elements.semiMajorAxis) / body.orbitalPeriod / 1000,
    )} km/s`,
  })

  /*
   * Where it is on that ellipse *now*, which is the one fact on this page that
   * moves.
   *
   * `renderTime`, not `clock.time`, for the reason every other reading of a
   * body's position in this repository uses it: the panel is describing the
   * instant the frame depicts. It matters less here than it does for a camera —
   * a countdown in days does not sawtooth — but two answers to "when is now" in
   * one mode is how the third site got it wrong.
   */
  const rate = (2 * Math.PI) / body.orbitalPeriod
  const anomaly = normalizeAngle(
    elements.meanAnomalyAtEpoch +
      rate * (world.clock.renderTime - elements.epoch),
  )
  facts.push({
    label: 'Next periapsis',
    value: period((2 * Math.PI - anomaly) / rate),
    note: `${round((anomaly / (2 * Math.PI)) * 100, 1)}% through this orbit`,
  })
  facts.push({
    label: 'Sphere of influence',
    value: kilometres(body.sphereOfInfluence),
    note: `${round(body.sphereOfInfluence / body.radius, 1)} radii`,
  })
  facts.push(
    noData(
      'Element drift',
      'these elements are quoted at J2000 and solved as a two-body problem. How the orbit precesses under everything else in the system has not been integrated, so a date ten thousand years out is approximate',
    ),
  )
  facts.push(
    noData(
      'Resonances',
      'whether this orbit is locked to a neighbour’s — 3:2, 1:2:4 — is a relationship between two records, and nothing holds it',
    ),
  )

  return { id: 'body.orbit', title: 'Orbit', facts }
}

function rotationGroup(body: Body, year: Seconds): FactGroup {
  const sidereal = Math.abs(body.rotationPeriod)
  const retrograde = body.rotationPeriod < 0
  const locked = tidallyLocked(body)
  const facts: Fact[] = [
    {
      label: 'Sidereal day',
      value: period(sidereal),
      ...(retrograde ? { note: 'retrograde' } : {}),
    },
  ]

  /*
   * The solar day, which is not the sidereal one and is the one a person means.
   *
   * Earth turns in 23h56m and the Sun comes back in 24h, because the planet has
   * moved a degree along its year in the meantime. The same subtraction is what
   * makes Luna's solar day 29.5 days against a 27.3-day month.
   */
  const solar = synodicDay(body.rotationPeriod, year)
  facts.push({
    label: 'Solar day',
    value: solar === null ? null : period(solar),
    ...(solar === null
      ? {
          pending:
            'this body turns once per year, so it keeps one face to its star and has no sunrise at all',
        }
      : { note: 'sunrise to sunrise' }),
  })
  /*
   * The obliquity an almanac prints, which is not the stored tilt.
   *
   * `solar/bodies.ts` states the convention it packs to: the retrograde fact
   * lives in the *sign of the rotation period*, so `axialTilt` carries only the
   * axis and Venus is filed as 2.64° rather than 177.36°. Both halves applied
   * at once give a prograde Venus, which is why the generator wants it that way
   * — and why a panel that prints the field raw reports Venus as 2.64° upright,
   * Uranus as 82.23° and Pluto as 60.41°, three numbers no reference carries.
   */
  const obliquity = retrograde
    ? 180 - Math.abs(degrees(body.axialTilt))
    : Math.abs(degrees(body.axialTilt))
  facts.push({
    label: 'Axial tilt',
    value: `${round(obliquity, 2)}°`,
    // The *word* is about seasons, and seasons run on the angle to the orbital
    // plane's normal — which is 2.64° for Venus, not 177.36°. An obliquity past
    // 90° is a pole pointing the other way round the same tilt.
    note: tiltWord(Math.min(obliquity, 180 - obliquity)),
  })
  facts.push(
    noData(
      'Pole direction',
      'the tilt is on record as a magnitude. Which way the axis points — the right ascension and declination of the north pole — is what a season depends on, and it has not been fixed',
    ),
  )
  facts.push(
    noData(
      'Precession',
      'how the axis itself wanders. It takes centuries of observation to measure and none is on file',
    ),
  )

  return {
    id: 'body.rotation',
    title: 'Rotation',
    ...(locked
      ? { caption: 'tidally locked — it keeps one face toward what it orbits' }
      : {}),
    facts,
  }
}

/**
 * What the ground is made of and what has happened to it.
 *
 * The `SurfaceGrammar` restated as a record. Every row is a claim about the
 * *place* — how hard a mountain can stand on it, how saturated with craters it
 * is, whether its lithosphere moves in pieces — and none of them is a claim
 * about how the terrain is drawn, which is the line ADR-0014 draws through this
 * whole panel.
 *
 * Null for a body with nowhere to stand. A gas giant's grammar exists (the
 * record is built for every body) and means nothing, so the honest thing is to
 * have no card rather than a card full of numbers about a surface that is not
 * there.
 */
/**
 * Why a body carries the relief it does, one phrase per source.
 *
 * `reliefSource` rather than the three constants re-compared here, because a
 * measured world does not go through the comparison at all: `solar/system.ts`
 * hands every body in Sol its published figure, so re-deriving the answer told
 * Earth "limited by what the crust can hold up" over a 9,900 m relief the crust
 * limit puts at 5,910. A row on this panel is a claim about the place
 * (ADR-0014), and a claim about a mechanism that did not run is the one kind
 * this panel may not make.
 */
const RELIEF_REASON: Readonly<Record<ReliefSource, string>> = {
  measured: 'measured from orbit rather than derived',
  ceiling: 'at the ceiling nothing measured anywhere exceeds',
  size: 'limited by the size of the body',
  strength: 'limited by what the crust can hold up',
}

function geologyGroup(body: Body): FactGroup | null {
  if (!hasSolidSurface(body)) return null
  const g = body.surface.grammar
  const facts: Fact[] = [
    {
      label: 'Terrain',
      value: archetypeName(g.archetype),
      /*
       * `gravity(...)` over the body's volumetric mean radius, not
       * `grammar.gravity`, so this row and the Physical card's agree.
       *
       * The grammar's copy is a *generation input*: `makeSurface` derives it
       * before the body has a figure and therefore from `radius`, the largest
       * half-extent, which its own docstring says overstates the mean by a few
       * percent on an irregular moon and by the flattening on an oblate planet.
       * That is fine for choosing a crater ladder and wrong for a panel — two
       * rows of one dossier quoting different surface gravities for one world is
       * the kind of thing ADR-0014 exists to prevent.
       */
      note: `${significant(gravity(body.mass, volumetricMeanRadius(body)))} m/s² at the datum`,
    },
    {
      label: 'Relief',
      value:
        body.surface.maxElevation > 0
          ? kilometres(body.surface.maxElevation)
          : 'None resolved',
      /*
       * Which of the three limits bit, named rather than implied. A reader who
       * wonders why a small moon carries as much relief as a planet is asking a
       * real question, and the answer is that a planet is limited by what its
       * crust can hold up and a moon by how big it is.
       */
      note:
        body.surface.maxElevation <= 0
          ? 'the shape model carries what relief there is'
          : RELIEF_REASON[g.reliefSource],
    },
  ]

  if (g.craterDensity > 0.02 && g.largestCrater > 0) {
    facts.push({
      label: 'Cratering',
      value:
        g.craterDensity > 0.75
          ? 'Saturated'
          : g.craterDensity > 0.35
            ? 'Heavy'
            : 'Sparse',
      note: `largest basin ${kilometres(g.largestCrater)} across; craters gain flat floors past ${kilometres(g.complexDiameter)}`,
    })
  } else {
    facts.push({
      label: 'Cratering',
      value: 'Effectively none',
      note:
        g.air > 0.5
          ? 'the air erases them faster than they arrive'
          : 'the surface is younger than the impacts that would mark it',
    })
  }

  facts.push({
    label: 'Lithosphere',
    value: g.plateCount > 1 ? `${g.plateCount} plates` : 'One lid',
    note:
      g.plateCount > 1
        ? 'margins that converge, open and slide'
        : 'a single shell that cracks rather than subducts',
  })

  if (g.relaxation > 0.1) {
    facts.push({
      label: 'Ice',
      value: `${round(g.relaxation * 100, 0)}% relaxed`,
      note: `at ${round(g.temperature, 0)} K a large old crater sags toward a palimpsest`,
    })
  }
  if (g.chaos > 0.1 || g.stripes > 0.1) {
    facts.push({
      label: 'Tidal working',
      value: g.stripes > 0.1 ? 'Fractured shell' : 'Broken crust',
      note: 'the primary flexes it faster than it can anneal',
    })
  }

  facts.push(
    noData(
      'Surface age',
      'crater counts date a surface against a cratering rate, and nobody has flown the survey this one would need',
    ),
  )
  facts.push(
    noData(
      'Composition',
      'the rocks have a density and a strength. Which minerals add up to them wants a sample, and no lander has taken one',
    ),
  )
  return { id: 'body.geology', title: 'Geology', facts }
}

function atmosphereGroup(body: Body): FactGroup {
  const air = body.atmosphere
  if (air === null) {
    /*
     * An airless body still gets the group, and the first row is a *fact*
     * rather than an empty field: "none" is an answer, and collapsing it into
     * the same grey as "nobody has looked" would throw away the difference this
     * whole design exists to keep.
     */
    return {
      id: 'body.atmosphere',
      title: 'Atmosphere',
      facts: [
        { label: 'Envelope', value: 'None', note: 'vacuum at the datum' },
        noData(
          'Exosphere',
          'an airless body can still hold a sputtered exosphere — Mercury’s sodium, Luna’s argon. Detecting one takes a spectrometer in orbit',
        ),
      ],
    }
  }

  /*
   * Pressure from density, because the record stores the density.
   *
   * p = ρ g H for an isothermal column, which is the same atmosphere the drag
   * model integrates — so the number in this panel and the drag a hull feels
   * come from one description rather than from two that agree until somebody
   * edits one.
   */
  const g = gravity(body.mass, body.radius)
  const pressure = air.surfaceDensity * g * air.scaleHeight
  const facts: Fact[] = [
    {
      label: 'Surface pressure',
      value: pressurised(pressure),
      note: `${significant(pressure / 101_325)} atm`,
    },
    {
      label: 'Surface density',
      value: `${significant(air.surfaceDensity)} kg/m³`,
      note: `${significant(air.surfaceDensity / 1.225)}× Earth`,
    },
    {
      label: 'Scale height',
      value: kilometres(air.scaleHeight),
      note: 'density falls to 1/e',
    },
    {
      label: 'Ceiling',
      value: kilometres(air.ceiling),
      note: 'the sensible atmosphere ends',
    },
  ]
  const haze = body.appearance.haze
  if (haze !== null) {
    facts.push({
      label: 'Visible haze',
      value: kilometres(haze.height),
      note: `optical thickness ${round(haze.thickness, 2)}`,
    })
  }
  facts.push({
    label: 'Cloud deck',
    value:
      body.appearance.clouds === null
        ? 'None'
        : kilometres(body.appearance.clouds.altitude),
    ...(body.appearance.clouds === null
      ? {}
      : {
          note: `turns in ${period(Math.abs(body.appearance.clouds.rotationPeriod))}`,
        }),
  })
  facts.push(
    noData(
      'Composition',
      'the column has a density, a scale height and a colour. Which gases add up to that needs a transmission spectrum, and none has been taken',
    ),
  )
  facts.push(
    noData(
      'Circulation',
      'the deck’s turn rate is known; its weather is not. No jet streams, no seasonal bands and no storms with positions',
    ),
  )
  return { id: 'body.atmosphere', title: 'Atmosphere', facts }
}

function insolationGroup(
  star: Star,
  body: Body,
  primary: Body | null,
): FactGroup {
  /*
   * Measured at the *star*, through the primary where there is one.
   *
   * A moon's own semi-major axis is around its planet, so using it would put
   * Europa 671,000 km from the Sun. What lights a moon is the planet's orbit.
   */
  const range = (primary ?? body).elements.semiMajorAxis
  // `insolation`, not the formula written out: `isHabitable` tests bodies
  // against that function and this panel counts what it says, so a second copy
  // of the flux model would eventually shade a band the simulation disagreed
  // with. Same argument `habitableZone` is exported beside it for.
  const flux = insolation(star, range)
  const albedo = body.appearance.geometricAlbedo
  /*
   * Equilibrium temperature: the balance of absorbed sunlight against a
   * blackbody's own radiation, with no atmosphere in it.
   *
   * The albedo this balance wants is the **Bond** albedo — the fraction of all
   * incident power reflected in every direction — and the record carries the
   * *geometric* one, which is a back-scatter ratio at zero phase. They are not
   * interchangeable and the ratio between them is not a constant: Earth's pair
   * is 0.306 / 0.434, Mercury's 0.088 / 0.142, Mars's 0.250 / 0.170. So this
   * figure is low for Earth by about 14 K and the note says which albedo it
   * came from, because a reader checking it against an almanac otherwise finds
   * a number that matches nothing. The Bond albedo is the field that closes it,
   * and `docs/design/planetarium.md` § "The record that is not filled in yet"
   * is where it is listed.
   */
  const equilibrium = Math.pow(
    ((1 - albedo) * flux) / (4 * STEFAN_BOLTZMANN),
    0.25,
  )
  const published = body.measurement?.equilibriumTemperature ?? null
  const angular = 2 * Math.asin(Math.min(1, star.radius / range))

  return {
    id: 'body.insolation',
    title: 'Sunlight',
    facts: [
      {
        label: 'Insolation',
        value: `${significant(flux)} W/m²`,
        note: `${significant(flux / 1361)}× Earth`,
      },
      {
        label: 'Equilibrium temp.',
        value: `${round(published ?? equilibrium, 0)} K`,
        note: `${round((published ?? equilibrium) - 273.15, 0)} °C${
          published === null ? ' · from the geometric albedo' : ' · published'
        }`,
      },
      {
        // The picture fact, and the one that lands: the Sun from Pluto is a
        // 50-arcsecond disk, which is a bright star with a shape.
        label: `${star.name} in the sky`,
        value: `${arcs(angular)} across`,
        note: `${significant(angular / SUN_FROM_EARTH)}× the Sun from Earth`,
      },
      noData(
        'Surface temperature',
        'the figure above is what a bare rock at this distance would sit at. Earth’s is around 255 K against a measured 288, and what the air and the ground do with that 33 K is a greenhouse model nobody has run over this body',
        'equilibrium ≠ surface',
      ),
      noData(
        'Magnetic field',
        'a magnetometer has to be flown through it. Nothing here has been, so there is no field strength, no magnetosphere and no aurora on record',
      ),
      noData(
        'Apparent magnitude',
        'how bright this body looks from Earth. Size, albedo and geometry are all on file; the phase curve that closes it is not',
      ),
    ],
  }
}

function ringGroup(body: Body): FactGroup | null {
  const rings = body.appearance.rings
  if (rings === null) return null
  return {
    id: 'body.rings',
    title: 'Rings',
    facts: [
      {
        label: 'Inner edge',
        value: kilometres(rings.innerRadius),
        note: `${round(rings.innerRadius / body.radius, 2)} radii`,
      },
      {
        label: 'Outer edge',
        value: kilometres(rings.outerRadius),
        note: `${round(rings.outerRadius / body.radius, 2)} radii`,
      },
      {
        label: 'Width',
        value: kilometres(rings.outerRadius - rings.innerRadius),
      },
      {
        label: 'Optical depth',
        value: significant(rings.opticalDepth),
        note: opacityWord(rings.opticalDepth),
      },
      noData(
        'Divisions',
        'the system is charted as one annulus. Resolving the gaps in it, and the shepherd moons that hold them open, needs a close pass',
      ),
      noData(
        'Particle size',
        'the size distribution and composition of the ring particles come from a radio occultation. None has been made here',
      ),
    ],
  }
}

function discoveryGroup(body: Body): FactGroup {
  const measured = body.measurement
  if (measured === null) {
    return {
      id: 'body.discovery',
      title: 'Record',
      facts: [
        noData(
          'First observed',
          body.provenance === 'projected'
            ? 'nobody has confirmed this body directly. It is projected from the star’s own parameters, and the projection carries no date'
            : 'this body’s discovery is older than the survey record that reached this catalog',
        ),
        noData(
          'Designation history',
          'which authority named it, and what it was called before. The catalog carries the current name and nothing behind it',
        ),
      ],
    }
  }
  /*
   * Year zero is not a year.
   *
   * `SolarBody.discoveryYear` uses 0 for "known since antiquity", which is the
   * six naked-eye planets plus Luna and the Sun — and rendered as a number it
   * came out as `First observed 0`, which is both meaningless and the kind of
   * sentinel leaking into a readout that this whole panel is meant not to do.
   * It is also not an empty field: "nobody wrote down when this was first
   * seen" is an answer, and a stronger one than a date.
   */
  const facts: Fact[] = [
    measured.discoveryYear > 0
      ? { label: 'First observed', value: `${measured.discoveryYear}` }
      : {
          label: 'First observed',
          value: 'Antiquity',
          note: 'known before anybody recorded when',
        },
    { label: 'Method', value: measured.discoveryMethod },
  ]
  /*
   * How the two headline numbers were arrived at, because for a confirmed
   * exoplanet they usually were not both measured. Radial velocity gives
   * M sin i — a lower bound, not a mass — and a transit gives a radius with no
   * mass at all.
   */
  if (measured.massIsLowerBound)
    facts.push({
      label: 'Mass basis',
      value: 'Lower bound',
      note: 'M sin i, radial velocity',
    })
  else if (measured.massInferred)
    facts.push({
      label: 'Mass basis',
      value: 'Inferred',
      note: 'from the radius',
    })
  else facts.push({ label: 'Mass basis', value: 'Measured' })
  facts.push({
    label: 'Radius basis',
    value: measured.radiusInferred ? 'Inferred' : 'Measured',
    ...(measured.radiusInferred ? { note: 'from the mass' } : {}),
  })
  facts.push({
    label: 'Published insolation',
    value:
      measured.insolation === null
        ? null
        : `${round(measured.insolation, 2)}× Earth`,
    ...(measured.insolation === null
      ? {
          /*
           * The reason is about *this row*, not about the star.
           *
           * The old sentence said the host star's luminosity had not been
           * measured — on Earth, whose star's page prints 1.000 L☉ two clicks
           * away. What is missing is the discovery paper's own figure; the
           * Sunlight group above computes the flux and always has one.
           */
          pending:
            'the flux above is worked out from the star and this orbit. A separately published figure is something a discovery paper carries, and no survey has filed one for this body',
        }
      : {}),
  })
  return { id: 'body.discovery', title: 'Record', facts }
}

/* ------------------------------------------------------------------------- */
/* Naming things                                                              */
/* ------------------------------------------------------------------------- */

const KIND_NOUN: Readonly<Record<BodyKind, string>> = {
  rocky: 'Terrestrial planet',
  ice: 'Ice world',
  'gas-giant': 'Gas giant',
  'ice-giant': 'Ice giant',
  moon: 'Moon',
  dwarf: 'Dwarf planet',
  asteroid: 'Asteroid',
  comet: 'Comet',
}

/** The short noun for a class, for a badge or a filter chip. */
export const kindNoun = (kind: BodyKind): string => KIND_NOUN[kind]

const ORDINALS = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
]

/**
 * `Fourth planet of Sol`, `Moon of Mars`, `Asteroid of Sol`.
 *
 * The ordinal is **orbital**, and it is computed rather than read off the
 * address: `b:2` is the third body ever *issued* in a system and says nothing
 * about how far out it is (ADR-0009). Earth is `b:2` and is also the third
 * planet, which is a coincidence that holds in Sol and nowhere else — in a
 * cataloged system the letters are discovery order, so `b:0` is routinely the
 * innermost or the outermost or neither.
 */
function classifyBody(
  system: StarSystem,
  body: Body,
  primary: Body | null,
): string {
  const noun = KIND_NOUN[body.kind]
  if (primary !== null) return `${noun} of ${primary.name}`
  if (!isPlanetKind(body.kind)) return `${noun} of ${system.name}`
  // `orbitalOrder` from `universe`, which is that sort — a private copy of it
  // is how the ordinal here and the row order in the catalog come to disagree.
  const order = orbitalOrder(system).filter((one) => isPlanetKind(one.kind))
  const at = order.findIndex((one) => one.id === body.id)
  const ordinal = ORDINALS[at]
  return ordinal === undefined
    ? `${noun} of ${system.name}`
    : `${ordinal} planet of ${system.name}`
}

const LUMINOSITY_CLASS: Readonly<Record<string, string>> = {
  I: 'supergiant',
  II: 'bright giant',
  III: 'giant',
  IV: 'subgiant',
  V: 'main sequence',
  VI: 'subdwarf',
  VII: 'white dwarf',
}

function starClassification(star: Star, luminosity: string | null): string {
  const suffix =
    luminosity === null
      ? 'star'
      : `${LUMINOSITY_CLASS[luminosity] ?? 'star'} star`
  return `${star.spectralClass}-type ${suffix}`
}

function starSummary(
  star: Star,
  census: Census,
  cataloged: CatalogStar | undefined,
): string {
  /*
   * Three clauses, and each has a case that only shows up on one star.
   *
   * The Sun is the denominator of two of them, so writing the sentence without
   * a branch for it produces "catalogued at 0.00 light years, putting out 1.000
   * times fainter than the Sun" — which is wrong twice about the one star every
   * reader will look at first.
   */
  const ratio = star.luminosity / SOLAR_LUMINOSITY
  const brightness =
    Math.abs(ratio - 1) < 0.005
      ? 'the Sun’s own output'
      : ratio > 1
        ? `${significant(ratio)} times the Sun’s output`
        : `${significant(1 / ratio)} times less light than the Sun`
  const worlds =
    census.planets === 0
      ? 'No planets are charted here'
      : `${census.planets} ${census.planets === 1 ? 'planet is' : 'planets are'} charted here`
  const seen =
    cataloged === undefined
      ? 'Charted from stellar parameters'
      : cataloged.distanceLightYears < 0.001
        ? 'The star every distance in this catalog is measured from'
        : `Catalogued at ${round(cataloged.distanceLightYears, 2)} light years`
  return `${seen}: ${colourWord(star.temperature)}, ${round(star.temperature, 0)} K, putting out ${brightness}. ${worlds}.`
}

function bodySummary(star: Star, body: Body, primary: Body | null): string {
  const around = primary === null ? star.name : primary.name
  /*
   * Earth is the ruler in both directions, and the two halves of that read
   * differently. Above one Earth it is a multiple — "2.5× Earth’s radius" — and
   * below one a percentage, because "0.34× Earth’s radius" is a number a reader
   * has to convert and "34% of Earth’s radius" is one they already have.
   *
   * The multiple carries `×` rather than the words it used to: "at 1.00 Earth
   * radii" is a plural over a value of one, and `at` is a preposition for a
   * place rather than for a size.
   */
  const size =
    body.radius >= EARTH_RADIUS
      ? `${significant(body.radius / EARTH_RADIUS)}× Earth’s radius`
      : `${round((body.radius / EARTH_RADIUS) * 100, 1)}% of Earth’s radius`
  const air =
    body.atmosphere === null ? 'It has no atmosphere' : 'It has an atmosphere'
  return `${KIND_NOUN[body.kind]}, ${size}, orbiting ${around} once every ${period(body.orbitalPeriod)}. ${air}.`
}

/* ------------------------------------------------------------------------- */
/* Arithmetic                                                                 */
/* ------------------------------------------------------------------------- */

interface Census {
  readonly planets: number
  readonly dwarfs: number
  readonly moons: number
  readonly debris: number
}

function censusOf(system: StarSystem): Census {
  let planets = 0
  let dwarfs = 0
  let moons = 0
  let debris = 0
  for (const body of walkBodies(system)) {
    if (body.kind === 'moon') moons += 1
    else if (body.kind === 'dwarf') dwarfs += 1
    else if (isDebris(body.kind)) debris += 1
    else if (isPlanetKind(body.kind)) planets += 1
  }
  return { planets, dwarfs, moons, debris }
}

/**
 * Standard gravity, m/s² — the unit the `g` gloss is quoted in.
 *
 * Not `gravity(EARTH_MASS, EARTH_RADIUS)`, which is 9.82: that is the figure at
 * the equator of an Earth-mass sphere, and `g` is a defined constant rather than
 * a reading anybody took.
 */
const STANDARD_GRAVITY = 9.806_65

/**
 * Surface gravity of a sphere of this mass and radius, m/s².
 *
 * `GRAVITATIONAL_CONSTANT` rather than a literal, because `body.mu` — which the
 * escape-velocity row beside this one uses — is `GRAVITATIONAL_CONSTANT × mass`
 * from `universe`. Two spellings of G in adjacent rows agree only by the digits
 * happening to match, and a CODATA revision would move one and not the other.
 */
export const gravity = (mass: Kilograms, radius: Meters): number =>
  (GRAVITATIONAL_CONSTANT * mass) / (radius * radius)

/**
 * Whether a body turns once per orbit, within a percent.
 *
 * A percent rather than an equality: Luna's sidereal month and its rotation
 * period agree to about a part in 10⁵ and a charted body's agree exactly, but
 * nothing guarantees either, and a lock reported only on an exact match is a
 * lock that is never reported.
 */
export const tidallyLocked = (body: Body): boolean =>
  body.orbitalPeriod > 0 &&
  Math.abs(Math.abs(body.rotationPeriod) - body.orbitalPeriod) /
    body.orbitalPeriod <
    0.01

/**
 * Sunrise to sunrise: the synodic day, or null where there is not one.
 *
 * 1/T_solar = 1/T_sidereal − 1/T_year, with the sign of the rotation kept — a
 * retrograde spin *adds* rather than subtracts, which is why Venus's solar day
 * (117 d) is shorter than its year while its sidereal day (243 d) is longer.
 *
 * **`year` is the period about the _star_, not about whatever the body
 * immediately orbits.** For a planet the two are the same and the distinction
 * is invisible. For a moon they are not, and using the wrong one is not a small
 * error: Luna is tidally locked, so its rotation period and its month are equal
 * and the difference of their reciprocals is *zero* — an infinitely long day,
 * for a body whose sunrises are 29.5 days apart. What actually moves the Sun
 * across a moon's sky is the planet's year, and against Earth's 365.25 days the
 * same subtraction gives the synodic month exactly.
 *
 * Null when the two rates cancel: a body turning once per year keeps one face
 * to its star and has no sunrise at all. Mercury does not — it is in a 3:2
 * resonance, which is why its solar day is 176 days rather than infinite.
 */
export function synodicDay(rotation: Seconds, year: Seconds): Seconds | null {
  if (!Number.isFinite(rotation) || rotation === 0) return null
  if (!Number.isFinite(year) || year <= 0) return Math.abs(rotation)
  const rate = 1 / rotation - 1 / year
  const solar = Math.abs(1 / rate)
  // A denormal rotation period overflows the reciprocal to infinity and the
  // day back to zero. The honest answer there is the sidereal period: a body
  // spinning that fast is not measurably slowed by its own orbit.
  if (solar === 0) return Math.abs(rotation)
  return Number.isFinite(solar) ? solar : null
}

/*
 * Both lookups go through `universe`'s own `findBody`, which indexes straight
 * in — `system.planets[path[0]].moons[path[1]]`. The scan they replaced walked
 * all 129 of Sol's bodies formatting an address string per candidate, twice per
 * page, to answer a question the path already answers.
 */

const primaryOf = (system: StarSystem, body: Body): Body | null =>
  body.address.kind !== 'body' || body.address.body.length < 2
    ? null
    : (findBodyAt(system, body.address.body.slice(0, -1)) ?? null)

const findBody = (
  system: StarSystem,
  address: UniverseAddress,
): Body | undefined =>
  address.kind === 'body' ? findBodyAt(system, address.body) : undefined

/* ------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* ------------------------------------------------------------------------- */

/*
 * Written out rather than handed to `Intl`.
 *
 * `toLocaleString` would group the digits and would also decide the decimal
 * separator from whatever locale the browser is in — so the same body would
 * render "6.371,0 km" on one machine and "6,371.0 km" on another, and a test
 * asserting either would pass exactly where it was written. Every readout in
 * this interface is an instrument reading; instruments do not translate.
 */

const degrees = (radians: number): number => (radians * 180) / Math.PI

/**
 * The Sun's angular diameter from Earth, radians — 0.533°.
 *
 * The one angular size every reader already owns, so it is the denominator
 * every other one is quoted against: the Sun from Pluto is a fiftieth of this,
 * which is a bright star with a shape.
 */
const SUN_FROM_EARTH = 9.3e-3

function group(text: string): string {
  const [whole = '', fraction] = text.split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const digits = sign === '' ? whole : whole.slice(1)
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction}`
}

function round(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—'
  return group(value.toFixed(digits))
}

/**
 * Three significant figures, which is what a reading of this kind is worth.
 *
 * A non-finite value is the em dash every other formatter here gives it, and
 * never `'0'`: a zero radius or a zero period sends `gravity`, the escape
 * velocity and the flux to infinity, and printing those as `0 m/s²` is a
 * confident measurement of the opposite of the truth. `0` stays the answer for
 * an actual zero.
 */
function significant(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e5 || magnitude < 1e-3) return exponential(value)
  const digits = Math.max(0, 3 - Math.ceil(Math.log10(magnitude)))
  return group(value.toFixed(digits))
}

function exponential(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const [mantissa = '', power = ''] = value.toExponential(3).split('e')
  const sign = power.startsWith('-') ? '−' : ''
  return `${mantissa}×10${superscript(sign + power.replace(/^[+-]/, ''))}`
}

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '−': '⁻',
}

const superscript = (text: string): string =>
  [...text].map((char) => SUPERSCRIPTS[char] ?? char).join('')

function kilometres(metres: Meters): string {
  const km = metres / 1000
  if (!Number.isFinite(km)) return '—'
  if (Math.abs(km) >= 1e7) return `${round(km / 1e6, 3)} million km`
  if (Math.abs(km) >= 100) return `${round(km, 0)} km`
  if (Math.abs(km) >= 1) return `${round(km, 2)} km`
  return `${round(metres, 0)} m`
}

function period(seconds: Seconds): string {
  const s = Math.abs(seconds)
  if (!Number.isFinite(s)) return '—'
  if (s >= 2 * SECONDS_PER_YEAR) return `${round(s / SECONDS_PER_YEAR, 2)} yr`
  if (s >= 2 * SECONDS_PER_DAY) return `${round(s / SECONDS_PER_DAY, 2)} d`
  if (s >= 7200) return `${round(s / 3600, 2)} h`
  if (s >= 120) return `${round(s / 60, 1)} min`
  return `${round(s, 1)} s`
}

function pressurised(pascals: number): string {
  if (pascals >= 1e5) return `${significant(pascals / 1e5)} bar`
  if (pascals >= 100) return `${significant(pascals / 1000)} kPa`
  return `${significant(pascals)} Pa`
}

/**
 * Degrees, arcminutes or arcseconds — whichever the angle is actually read in.
 *
 * The break is at a twentieth of a degree rather than at one, because the
 * reference every reader has is the Sun from Earth and that is half a degree.
 * Rendered in arcminutes it comes out "32.0′", which is correct, is what an
 * almanac prints, and is not the number anybody is carrying around.
 */
function arcs(radians: number): string {
  const deg = degrees(radians)
  if (deg >= 0.05) return `${round(deg, 3)}°`
  if (deg >= 1 / 60) return `${round(deg * 60, 2)}′`
  return `${round(deg * 3600, 1)}″`
}

function radiusNote(radius: Meters): string {
  if (radius >= JUPITER_RADIUS * 0.4)
    return `${round(radius / JUPITER_RADIUS, 3)} R♃`
  return `${round(radius / EARTH_RADIUS, 3)} R⊕`
}

function massNote(mass: Kilograms): string {
  if (mass >= JUPITER_MASS * 0.1) return `${round(mass / JUPITER_MASS, 3)} M♃`
  if (mass >= EARTH_MASS * 1e-3) return `${round(mass / EARTH_MASS, 4)} M⊕`
  // Below a thousandth of an Earth, the useful comparison is Luna rather than a
  // long row of zeroes: Ceres is 0.00016 M⊕ and 1.3% of the Moon.
  return `${significant((mass / 7.342e22) * 100)}% of Luna`
}

function density(mass: Kilograms, radius: Meters): string {
  const volume = (4 / 3) * Math.PI * radius * radius * radius
  return `${round(mass / volume / 1000, 3)} g/cm³`
}

const colourWord = (temperature: number): string => {
  if (temperature >= 30_000) return 'blue'
  if (temperature >= 10_000) return 'blue-white'
  if (temperature >= 7_500) return 'white'
  if (temperature >= 6_000) return 'yellow-white'
  if (temperature >= 5_200) return 'yellow'
  if (temperature >= 3_700) return 'orange'
  return 'red'
}

const albedoWord = (albedo: number): string => {
  if (albedo >= 0.6) return 'brilliant'
  if (albedo >= 0.3) return 'bright'
  if (albedo >= 0.1) return 'dark'
  return 'darker than charcoal'
}

const eccentricityWord = (e: number): string => {
  if (e < 0.01) return 'very nearly circular'
  if (e < 0.1) return 'near-circular'
  if (e < 0.4) return 'elliptical'
  if (e < 0.9) return 'strongly elliptical'
  return 'near-parabolic'
}

const tiltWord = (degreesOfObliquity: number): string => {
  const deg = Math.abs(degreesOfObliquity)
  if (deg < 3) return 'almost upright — no seasons'
  if (deg < 35) return 'seasons like Earth’s'
  if (deg < 80) return 'extreme seasons'
  return 'lying on its side'
}

const opacityWord = (depth: number): string => {
  if (depth >= 1) return 'opaque'
  if (depth >= 0.1) return 'translucent'
  if (depth >= 1e-3) return 'tenuous'
  return 'a dust band, barely there'
}
