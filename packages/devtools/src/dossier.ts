import {
  AU,
  EARTH_MASS,
  EARTH_RADIUS,
  JUPITER_MASS,
  JUPITER_RADIUS,
  type Kilograms,
  type Meters,
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
  type Body,
  type BodyKind,
  type BodyProvenance,
  type CatalogStar,
  formatAddress,
  frostLine,
  habitableZone,
  isDebris,
  isPlanetKind,
  parseSpectralType,
  type Star,
  type StarSystem,
  type SystemId,
  type UniverseAddress,
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
 * ## Three rules it follows
 *
 * **Derive, never store.** Density, surface gravity, escape velocity and the
 * habitable zone are all computed from what the body already carries. That is
 * the catalog's own rule ("never store what the catalog can derive") applied one
 * layer up, and it is why a change to a planet's mass moves nine numbers here
 * rather than leaving eight of them stale.
 *
 * **Nothing about the camera.** No range, no fill, no azimuth. Those are facts
 * about where you are standing, they belong to the instrument, and mixing them
 * into a body's record is what made the old panel read as a debugger. The
 * observatory's own readout is in the author's Camera instrument now.
 *
 * **Say what is not known.** `gaps` is not an apology, it is the same claim
 * `provenance` makes on every row of the catalog: this build knows a bulk
 * density and does not know a composition, and a panel that quietly omitted the
 * second would let a reader assume it had been checked. PRODUCT.md promises the
 * interface always states which half of that it is on.
 */

/** One reading: what it is, what it says, and a second scale for the same thing. */
export interface Fact {
  readonly label: string
  readonly value: string
  /**
   * The same quantity in the unit a reader actually thinks in.
   *
   * `5.97e24 kg` is a number nobody has an intuition for and `1.00 M⊕` is the
   * whole point of it. Two rows would separate them by the width of the panel;
   * one row with a trailing gloss keeps the comparison where the measurement is.
   */
  readonly note?: string
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

/**
 * A fact a planetarium is expected to carry and this universe has no data for.
 *
 * Stated rather than omitted, and stated *specifically* — "no composition"
 * rather than "limited data" — because the useful version tells a reader what
 * the model actually contains and tells whoever adds it next what the shape of
 * the missing field is.
 */
export interface Gap {
  readonly label: string
  readonly why: string
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
  readonly gaps: readonly Gap[]
}

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
  let resolved
  try {
    resolved = resolveDestination(
      address,
      world.galaxy,
      currentSystemOf(world, host.player()),
    )
  } catch {
    return null
  }

  const system = world.loadSystem(resolved.system)
  if (resolved.kind === 'system') return starDossier(world, system)

  const body = findBody(system, resolved.address)
  if (body === undefined) return null
  return bodyDossier(world, system, body)
}

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
    {
      label: 'Mean density',
      value: density(star.mass, star.radius),
    },
    {
      label: 'Surface gravity',
      value: `${significant(gravity(star.mass, star.radius))} m/s²`,
      note: `${significant(gravity(star.mass, star.radius) / 9.80665)} g`,
    },
  ]
  if (cataloged?.physical.absoluteMagnitude != null) {
    physical.push({
      label: 'Absolute magnitude',
      value: round(cataloged.physical.absoluteMagnitude, 2),
      note: 'visual, at 10 pc',
    })
  }
  if (cataloged?.physical.colourIndex != null) {
    physical.push({
      label: 'Colour index',
      value: round(cataloged.physical.colourIndex, 3),
      note: 'B−V',
    })
  }

  const groups: FactGroup[] = [
    {
      id: 'star.physical',
      title: 'The Star',
      ...(cataloged?.physical.estimated === true
        ? {
            caption:
              'no published magnitude or classification — these rest on a class-typical fallback',
          }
        : {}),
      facts: physical,
    },
    {
      id: 'star.system',
      title: 'System',
      facts: [
        { label: 'Planets', value: `${census.planets}` },
        ...(census.dwarfs > 0
          ? [{ label: 'Dwarf planets', value: `${census.dwarfs}` }]
          : []),
        ...(census.moons > 0
          ? [{ label: 'Moons', value: `${census.moons}` }]
          : []),
        ...(census.debris > 0
          ? [
              {
                label: 'Small bodies',
                value: `${census.debris}`,
                note: 'asteroids and comets',
              },
            ]
          : []),
        {
          label: 'Confirmed',
          value: `${system.observedPlanets} of ${census.planets + census.dwarfs}`,
          note: 'the rest are projections',
        },
      ],
    },
    {
      id: 'star.zones',
      title: 'Zones',
      caption:
        'both are insolation boundaries solved from the star’s luminosity, not climate models',
      facts: [
        {
          label: 'Habitable zone',
          value: `${round(zone.inner / AU, 3)} – ${round(zone.outer / AU, 3)} AU`,
          note: 'where a rocky world with air could hold liquid water',
        },
        {
          label: 'Frost line',
          value: `${round(frost / AU, 3)} AU`,
          note: 'beyond it, volatiles survive and giants can form',
        },
      ],
    },
  ]

  const catalogFacts: Fact[] = []
  if (cataloged !== undefined) {
    catalogFacts.push({
      label: 'Distance from Sol',
      value: `${round(cataloged.distanceLightYears, 3)} ly`,
      note: `${round((cataloged.distanceLightYears * 9.4607304725808e15) / 3.085677581491367e16, 3)} pc`,
    })
    if (cataloged.components > 1) {
      catalogFacts.push({
        label: 'Components',
        value: `${cataloged.components}`,
        note: 'one is simulated',
      })
    }
    const names = cataloged.designations
      .slice(0, 6)
      .map((one) => one.text)
      .join(' · ')
    if (names.length > 0)
      catalogFacts.push({ label: 'Also known as', value: names })
  }
  if (catalogFacts.length > 0) {
    groups.push({ id: 'star.catalog', title: 'Record', facts: catalogFacts })
  }

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
    gaps: starGaps(cataloged),
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
  ]

  const air = atmosphereGroup(body)
  if (air !== null) groups.push(air)
  groups.push(insolationGroup(star, body, primary))
  const rings = ringGroup(body)
  if (rings !== null) groups.push(rings)
  const found = discoveryGroup(body)
  if (found !== null) groups.push(found)

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
    gaps: bodyGaps(body),
  }
}

function physicalGroup(body: Body): FactGroup {
  const facts: Fact[] = []
  const figure = body.figure

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
      value: kilometres(
        Math.cbrt(body.radius * figure.intermediateRadius * body.polarRadius),
      ),
      note: 'the sphere of the same volume',
    })
  }

  facts.push({
    label: 'Mass',
    value: `${exponential(body.mass)} kg`,
    note: massNote(body.mass),
  })
  facts.push({ label: 'Mean density', value: density(body.mass, body.radius) })
  const g = gravity(body.mass, body.radius)
  facts.push({
    label: 'Surface gravity',
    value: `${significant(g)} m/s²`,
    note: `${significant(g / 9.80665)} g`,
  })
  facts.push({
    label: 'Escape velocity',
    value: `${significant(Math.sqrt((2 * body.mu) / body.radius) / 1000)} km/s`,
  })
  facts.push({
    label: 'Geometric albedo',
    value: round(body.appearance.geometricAlbedo, 3),
    note: albedoWord(body.appearance.geometricAlbedo),
  })
  return { id: 'body.physical', title: 'Physical', facts }
}

function orbitGroup(world: World, body: Body, primary: Body | null): FactGroup {
  const elements = body.elements
  const facts: Fact[] = []
  const moonScale = body.address.kind === 'body' && body.address.body.length > 1

  facts.push({
    label: 'Semi-major axis',
    value: moonScale
      ? kilometres(elements.semiMajorAxis)
      : `${round(elements.semiMajorAxis / AU, 4)} AU`,
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
  facts.push({
    label: 'Inclination',
    value: `${round(degrees(elements.inclination), 3)}°`,
    note:
      primary === null
        ? 'to the system’s reference plane'
        : `to ${primary.name}’s equator`,
  })
  facts.push({
    label: 'Periapsis',
    value: moonScale
      ? kilometres(periapsis(elements))
      : `${round(periapsis(elements) / AU, 4)} AU`,
  })
  facts.push({
    label: 'Apoapsis',
    value: moonScale
      ? kilometres(apoapsis(elements))
      : `${round(apoapsis(elements) / AU, 4)} AU`,
  })
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

  return {
    id: 'body.orbit',
    title: 'Orbit',
    facts,
  }
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
   * makes Luna's solar day 29.5 days against a 27.3-day month, and it is why a
   * tidally locked body has a day at all rather than none.
   */
  const solar = synodicDay(body.rotationPeriod, year)
  if (solar !== null && Number.isFinite(solar)) {
    facts.push({
      label: 'Solar day',
      value: period(solar),
      note: 'sunrise to sunrise',
    })
  }
  facts.push({
    label: 'Axial tilt',
    value: `${round(degrees(body.axialTilt), 2)}°`,
    note: tiltWord(body.axialTilt),
  })

  return {
    id: 'body.rotation',
    title: 'Rotation',
    ...(locked
      ? {
          caption: 'tidally locked — it keeps one face toward what it orbits',
        }
      : {}),
    facts,
  }
}

function atmosphereGroup(body: Body): FactGroup | null {
  const air = body.atmosphere
  if (air === null) return null
  /*
   * Pressure from density, because the model stores the density.
   *
   * p = ρ g H for an isothermal column, which is the same atmosphere
   * `atmosphericDensity` integrates — so the number in this panel and the drag
   * the ship feels come from one description rather than from two that agree
   * until somebody edits one.
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
      note: 'where the density falls to 1/e',
    },
    {
      label: 'Ceiling',
      value: kilometres(air.ceiling),
      note: 'above it, drag is not modeled',
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
  if (body.appearance.clouds !== null) {
    facts.push({
      label: 'Cloud deck',
      value: kilometres(body.appearance.clouds.altitude),
      note: `turns in ${period(Math.abs(body.appearance.clouds.rotationPeriod))}`,
    })
  }
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
  const flux = star.luminosity / (4 * Math.PI * range * range)
  const albedo = body.appearance.geometricAlbedo
  /*
   * Equilibrium temperature, which is the only temperature this build can
   * honestly quote — the balance of absorbed sunlight against a blackbody's own
   * radiation, with no atmosphere in it. Earth comes out at 255 K against a
   * measured 288: the 33 K difference is the greenhouse effect, which is
   * exactly the model this does not have. `gaps` says so.
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
          published === null ? '' : ' · published'
        }`,
      },
      {
        // The picture fact, and the one that lands: the Sun from Pluto is a
        // 50-arcsecond disk, which is a bright star with a shape.
        label: `${star.name} in the sky`,
        value: `${arcs(angular)} across`,
        note: `${significant(angular / SUN_FROM_EARTH)}× the Sun from Earth`,
      },
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
    ],
  }
}

function discoveryGroup(body: Body): FactGroup | null {
  const measured = body.measurement
  if (measured === null) return null
  const facts: Fact[] = [
    { label: 'Discovered', value: `${measured.discoveryYear}` },
    { label: 'Method', value: measured.discoveryMethod },
  ]
  /*
   * How the two headline numbers were arrived at, because for an exoplanet they
   * usually were not both measured. Radial velocity gives M sin i — a lower
   * bound, not a mass — and a transit gives a radius with no mass at all.
   */
  if (measured.massIsLowerBound)
    facts.push({
      label: 'Mass',
      value: 'lower bound',
      note: 'M sin i, from radial velocity',
    })
  else if (measured.massInferred)
    facts.push({
      label: 'Mass',
      value: 'inferred',
      note: 'from the radius, by a mass–radius relation',
    })
  if (measured.radiusInferred)
    facts.push({ label: 'Radius', value: 'inferred', note: 'from the mass' })
  if (measured.insolation !== null)
    facts.push({
      label: 'Published insolation',
      value: `${round(measured.insolation, 2)}× Earth`,
    })
  return { id: 'body.discovery', title: 'Discovery', facts }
}

/* ------------------------------------------------------------------------- */
/* What is not recorded                                                       */
/* ------------------------------------------------------------------------- */

/*
 * The astronomy this build does not have.
 *
 * Every entry is a field a real planetarium shows and this universe carries no
 * value for, which is a different statement from "unknown to science" — most of
 * these are published for the Solar System and simply are not in the packed
 * catalog or the generator yet. Writing them down here rather than in a document
 * nobody opens means the gap is visible at the exact moment a reader would
 * otherwise assume the absence was an answer.
 *
 * `docs/design/planetarium.md` § "What is not recorded" is the same list with
 * the reasoning; this is the version the panel draws.
 */

function bodyGaps(body: Body): readonly Gap[] {
  const gaps: Gap[] = [
    {
      label: 'Composition',
      why: 'the model carries a bulk density, not a chemistry — there is no iron core, no silicate mantle and no ice fraction to report',
    },
    {
      label: 'Surface temperature',
      why: 'the figure above is an equilibrium temperature. Greenhouse warming, thermal inertia and the day–night range need an atmosphere model this build does not have',
    },
    {
      label: 'Magnetic field',
      why: 'nothing in the generator produces one, so there is no magnetosphere, no aurora and no radiation belt',
    },
    {
      label: 'Age',
      why: 'systems are generated whole. Nothing carries a formation date or a differentiation history',
    },
  ]
  if (body.atmosphere !== null) {
    gaps.push({
      label: 'Atmospheric composition',
      why: 'density, scale height and a scattering colour — the gases those imply are not stored, so "78% nitrogen" is not something this can claim',
    })
  }
  if (body.measurement === null) {
    gaps.push({
      label: 'Discovery record',
      why: 'only cataloged exoplanets carry a discovery year and method. A Solar System body has none in the packed data, and a projected one was never discovered at all',
    })
  }
  gaps.push({
    label: 'Secular motion',
    why: 'the elements are fixed at J2000. Precession, resonance and the long-period drift of a real orbit are not integrated, so a date ten thousand years out is Keplerian rather than true',
  })
  if (isDebris(body.kind)) {
    gaps.push({
      label: 'Light curve',
      why: 'no absolute magnitude, phase curve or rotation-resolved brightness — the shape model is geometry only',
    })
  }
  return gaps
}

function starGaps(cataloged: CatalogStar | undefined): readonly Gap[] {
  const gaps: Gap[] = [
    {
      label: 'Age and metallicity',
      why: 'the catalog packs a magnitude, a colour and a classification. Neither age nor composition is derivable from those, and neither is stored',
    },
    {
      label: 'Rotation and activity',
      why: 'no rotation period, no starspots, no flare record — a flare star and a quiet one are drawn identically',
    },
    {
      label: 'Variability',
      why: 'luminosity is a constant here. Cepheids, eclipsing binaries and long-period variables all hold still',
    },
    {
      label: 'Proper motion',
      why: 'stars are placed at their J2000 positions and stay there. The sky does not drift, however far the clock is wound',
    },
  ]
  if (cataloged !== undefined && cataloged.components > 1) {
    gaps.push({
      label: 'The other components',
      why: `the catalog records ${cataloged.components} stellar components and this build simulates one. Separations, mutual orbits and the second star’s own light are absent`,
    })
  }
  if (cataloged === undefined) {
    gaps.push({
      label: 'Everything here is projected',
      why: 'no telescope has resolved this star. Every figure on this page is what the generator expects of a star in this place, not a measurement',
    })
  }
  return gaps
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
  const order = [...system.planets]
    .filter((one) => isPlanetKind(one.kind))
    .sort((a, b) => a.elements.semiMajorAxis - b.elements.semiMajorAxis)
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
  const brightness =
    star.luminosity > SOLAR_LUMINOSITY
      ? `${significant(star.luminosity / SOLAR_LUMINOSITY)} times the Sun’s output`
      : `${significant(SOLAR_LUMINOSITY / star.luminosity)} times fainter than the Sun`
  const worlds =
    census.planets === 0
      ? 'no planets are mapped here'
      : `${census.planets} ${census.planets === 1 ? 'planet' : 'planets'} are mapped here`
  const seen =
    cataloged === undefined
      ? 'This star is a projection'
      : `Catalogued at ${round(cataloged.distanceLightYears, 2)} light years`
  return `${seen}. A ${colourWord(star.temperature)} ${star.spectralClass}-type star at ${round(star.temperature, 0)} K, putting out ${brightness}; ${worlds}.`
}

function bodySummary(star: Star, body: Body, primary: Body | null): string {
  const around = primary === null ? star.name : primary.name
  const size =
    body.radius >= EARTH_RADIUS
      ? `${significant(body.radius / EARTH_RADIUS)} Earth radii`
      : `${round((body.radius / EARTH_RADIUS) * 100, 1)}% of Earth’s radius`
  const air =
    body.atmosphere === null ? 'It has no atmosphere' : 'It holds an atmosphere'
  const lap = period(body.orbitalPeriod)
  return `${KIND_NOUN[body.kind]} at ${size}, going round ${around} once every ${lap}. ${air}.`
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

/** Surface gravity of a sphere of this mass and radius, m/s². */
export const gravity = (mass: Kilograms, radius: Meters): number =>
  (6.6743e-11 * mass) / (radius * radius)

/**
 * Whether a body turns once per orbit, within a percent.
 *
 * A percent rather than an equality: Luna's sidereal month and its rotation
 * period agree to about a part in 10⁵ and a generated body's agree exactly,
 * but nothing guarantees either, and a lock reported only on an exact match is
 * a lock that is never reported.
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
  if (!Number.isFinite(solar) || solar === 0) return Math.abs(rotation)
  return solar
}

function primaryOf(system: StarSystem, body: Body): Body | null {
  if (body.address.kind !== 'body' || body.address.body.length < 2) return null
  const parentPath = body.address.body.slice(0, -1)
  for (const candidate of walkBodies(system)) {
    if (
      candidate.address.kind === 'body' &&
      candidate.address.body.length === parentPath.length &&
      candidate.address.body.every((n, i) => n === parentPath[i])
    )
      return candidate
  }
  return null
}

function findBody(
  system: StarSystem,
  address: UniverseAddress,
): Body | undefined {
  if (address.kind !== 'body') return undefined
  const wanted = formatAddress(address)
  for (const body of walkBodies(system)) {
    if (formatAddress(body.address) === wanted) return body
  }
  return undefined
}

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
const SUN_FROM_EARTH = 9.30e-3

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

/** Three significant figures, which is what a reading of this kind is worth. */
function significant(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e5 || magnitude < 1e-3) return exponential(value)
  const digits = Math.max(0, 3 - Math.ceil(Math.log10(magnitude)))
  return group(value.toFixed(digits))
}

function exponential(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const text = value.toExponential(3)
  const [mantissa = '', power = ''] = text.split('e')
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
  const kgPerCubicMetre = mass / volume
  return `${round(kgPerCubicMetre / 1000, 3)} g/cm³`
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

const tiltWord = (tilt: number): string => {
  const deg = Math.abs(degrees(tilt))
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
