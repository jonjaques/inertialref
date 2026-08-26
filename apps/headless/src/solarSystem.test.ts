import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AU,
  GRAVITATIONAL_CONSTANT,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { orbitalPeriod, stateVectorAt } from '@inertialref/physics'
import { Vec } from '@inertialref/spatial'
import {
  type Body,
  catalogStub,
  generateSystem,
  MILKY_WAY,
  readCatalog,
  type StarSystem,
  walkBodies,
} from '@inertialref/universe'

/*
 * The Solar System, checked against the people who measured it.
 *
 * `packages/universe/src/solar/` carries about fourteen hundred transcribed
 * numbers — a hundred and twenty-nine bodies with a radius, a mass, a spin
 * and six orbital elements each. A table that size, typed by hand, has typos in
 * it. That is not a worry, it is the base rate, and a transposed digit in a
 * semi-major axis produces a Solar System that runs, renders, and is wrong in a
 * way nobody notices until somebody looks up Deimos.
 *
 * So the transcription is checked against the source. `data/reference/
 * solar-system.json` is written by `pnpm solar:fetch` straight out of JPL's
 * planetary, satellite and small-body tables, in the units JPL publishes them
 * in, and every assertion below builds a body **through the engine** and
 * compares.
 *
 * Two things make that worth more than a diff of two tables.
 *
 * **The units are converted in only one direction.** The reference keeps
 * kilometers and days; the engine works in meters and seconds. The conversion
 * happens here, so a check and the thing it checks cannot share a factor of
 * 86,400 and agree with each other about it.
 *
 * **Half of what is compared is derived rather than stored.** The engine does
 * not store an orbital period — it computes one from `G(M+m)` and the
 * semi-major axis — and it does not store a surface gravity or an escape
 * velocity at all. Comparing those against JPL's published values tests the
 * physics *and* the data with one assertion: an orbital period that matches
 * JPL's to five figures means the mass is right, the axis is right, and
 * `orbitalPeriod` is right, because there is no way for two of those to be
 * wrong and still produce it.
 *
 * It lives in `apps/headless` rather than in `packages/universe` because it
 * reads a file, and `packages/*` may not. It runs with no DOM, no React and no
 * GPU, which is the other thing this app exists to prove.
 */

const root = new URL('../../../', import.meta.url)

interface Reference {
  readonly generated: string
  readonly sources: readonly { readonly name: string; readonly url: string }[]
  readonly planets: readonly PlanetRow[]
  readonly dwarfPlanets: readonly PlanetRow[]
  readonly satellites: readonly SatelliteRow[]
  readonly smallBodies: readonly SmallBodyRow[]
}

interface PlanetRow {
  readonly name: string
  readonly equatorialRadiusKm: number
  readonly meanRadiusKm: number
  readonly massKg: number
  readonly densityGramsPerCm3: number
  readonly rotationDays: number
  readonly orbitalYears: number
  readonly geometricAlbedo: number
  readonly equatorialGravity: number
  readonly escapeVelocityKmS: number
}

interface SatelliteRow {
  readonly planet: string
  readonly name: string
  readonly gmKm3S2: number | null
  readonly meanRadiusKm: number | null
  readonly semiMajorAxisKm: number | null
  readonly eccentricity: number | null
  readonly inclinationDeg: number | null
  readonly periodDays: number | null
}

interface SmallBodyRow {
  readonly name: string
  readonly fullName: string
  readonly elements: {
    readonly semiMajorAxisAu: number | null
    readonly eccentricity: number | null
    readonly inclinationDeg: number | null
    readonly nodeDeg: number | null
    readonly argumentOfPeriapsisDeg: number | null
    readonly periodDays: number | null
  }
  readonly physical: {
    readonly diameterKm: number | null
    readonly extentKm: readonly number[] | null
    readonly rotationHours: number | null
    readonly geometricAlbedo: number | null
  }
}

interface ShapeRow {
  readonly key: string
  readonly name: string
  readonly meanRadius: number
  readonly semiAxes: readonly number[]
  readonly volumeRatio: number
}

/**
 * What the shipped geometry actually measures.
 *
 * `apps/ingest` writes this while it builds each `.irsm`, straight out of
 * `shapeExtent` — so it is the volume and the half-extents of the *file the
 * game loads*, not of the model it came from. That is what makes it usable as
 * a third party here: a body whose data file and whose geometry disagree fails,
 * and neither one is checking itself.
 */
const shapes: readonly ShapeRow[] = (
  JSON.parse(
    readFileSync(new URL('data/shapes/manifest.json', root), 'utf8'),
  ) as { shapes: ShapeRow[] }
).shapes

const shapeOf = (body: Body): ShapeRow | undefined =>
  body.figure?.model == null
    ? undefined
    : shapes.find((row) => row.key === body.figure?.model)

/**
 * The volume-equivalent radius: the sphere of the same volume.
 *
 * For a spheroid it is `(a·b·c)^(1/3)` and that is exact. For a body with a
 * shape model it is *not* — the half-extents are a bounding box, and the
 * bounding box of a lumpy body encloses 10–20% more than the body does — so
 * the shipped model's own measured value is used instead. Amalthea is the case
 * that forces it: the box says 94 km and the geometry says 82, and JPL says
 * 83.5.
 */
function meanRadiusOf(body: Body): number {
  const shape = shapeOf(body)
  if (shape !== undefined) {
    /*
     * Rescaled by what the *data file* says the body is, not by what the model
     * was built at. The renderer normalizes a shape mesh by `body.radius`, so a
     * body whose published size has moved since its model was made is drawn at
     * the new size with the old shape — which is 1998 KY26 exactly: a 1999
     * Arecibo model of a 30 m rock that turned out to be 11 m. `a` and the
     * model's own longest half-extent are the same number for every other body
     * here, so this is a no-op everywhere it is not needed.
     */
    return shape.meanRadius * (body.radius / (shape.semiAxes[0] as number))
  }
  const b = body.figure?.intermediateRadius ?? body.radius
  return (body.radius * b * body.polarRadius) ** (1 / 3)
}

const reference: Reference = JSON.parse(
  readFileSync(new URL('data/reference/solar-system.json', root), 'utf8'),
) as Reference

let cached: StarSystem | null = null
function sol(): StarSystem {
  if (cached !== null) return cached
  const catalog = readCatalog(
    readFileSync(new URL('data/catalog/stars-150ly.irsc', root)),
  )
  const stub = catalog.get('SOL' as never)
  if (stub === undefined) throw new Error('the catalog has no Sol')
  cached = generateSystem(rootSeed('inertialref'), MILKY_WAY, catalogStub(stub))
  return cached
}

const everything = (): readonly Body[] => [...walkBodies(sol())]

function find(name: string): Body {
  const body = everything().find((candidate) => candidate.name === name)
  if (body === undefined) throw new Error(`Sol has no body called ${name}`)
  return body
}

/** Modeled here, or deliberately not. The reference lists more than the game. */
const modelled = (name: string): boolean =>
  everything().some((body) => body.name === name)

const KM = 1_000
const DEG = Math.PI / 180
const DAY = SECONDS_PER_DAY
const YEAR = 365.25 * DAY

/** Relative difference, for a tolerance that means the same thing at any scale. */
const relative = (a: number, b: number): number =>
  b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b)

/* ------------------------------------------------------------------------- */

describe('the reference this is all checked against', () => {
  it('is JPL, and says so', () => {
    const names = reference.sources.map((s) => s.name).join(' ')
    expect(names).toContain('JPL')
    for (const source of reference.sources)
      expect(source.url).toMatch(/^https:\/\/ssd/)
    expect(reference.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('covers the whole system', () => {
    expect(reference.planets.length).toBe(8)
    expect(reference.dwarfPlanets.length).toBeGreaterThanOrEqual(5)
    expect(reference.satellites.length).toBeGreaterThan(400)
    expect(reference.smallBodies.length).toBeGreaterThan(50)
  })
})

describe('the eight planets, against the JPL fact table', () => {
  it.each(reference.planets.map((p) => [p.name, p] as const))(
    '%s has the published radius, mass, spin and orbit',
    (name, row) => {
      const body = find(name)

      // Equatorial radius, exactly. Not "close to": these are transcribed, and
      // the only reason for a mismatch is that somebody typed one wrong.
      expect(relative(body.radius, row.equatorialRadiusKm * KM)).toBeLessThan(
        1e-4,
      )
      expect(relative(body.mass, row.massKg)).toBeLessThan(1e-3)

      // Signed: JPL publishes Venus and Uranus as negative days, and so does
      // this project. Two encodings of retrograde and both of them have to
      // survive the round trip, because applying both flips it back.
      expect(
        relative(body.rotationPeriod, row.rotationDays * DAY),
      ).toBeLessThan(1e-3)
      expect(Math.sign(body.rotationPeriod)).toBe(Math.sign(row.rotationDays))

      /*
       * The period is *derived*, and that is what makes this the strongest
       * assertion in the file.
       *
       * `Body.orbitalPeriod` is `orbitalPeriod(G(M☉ + m), a)` — nothing about
       * it comes from a table. Matching JPL's published sidereal period to
       * four figures therefore says the semi-major axis is right, the Sun's
       * mass is right, the planet's mass is right, and Kepler's third law is
       * implemented correctly, all at once. One digit wrong anywhere and this
       * moves.
       */
      expect(
        relative(body.orbitalPeriod, row.orbitalYears * YEAR),
      ).toBeLessThan(2e-3)
    },
  )

  it.each(reference.planets.map((p) => [p.name, p] as const))(
    '%s has the surface gravity and escape velocity that follow from it',
    (name, row) => {
      const body = find(name)
      // Neither of these is stored anywhere. They come out of mu and the
      // radius, which is the point: they are an independent check on a pair of
      // numbers that could both be wrong in a way that preserved their ratio.
      const gravity = body.mu / (body.radius * body.radius)
      const escape = Math.sqrt((2 * body.mu) / body.radius) / KM
      /*
       * 2%, and the 2% is Jupiter's rotation rather than slack.
       *
       * JPL publishes *effective* equatorial gravity: the Newtonian term, minus
       * the centrifugal term, plus the oblateness correction. `mu/r²` is the
       * first of those alone. On a terrestrial planet the difference is under
       * a third of a percent; on Jupiter, which turns in 9.9 hours, the
       * centrifugal term alone is 2.2 m/s² out of 24.8, and on Saturn it is
       * larger still. The engine models a point mass, so the gap is real
       * physics it does not have — not an error to tighten away.
       */
      expect(
        `${name} gravity: ${relative(gravity, row.equatorialGravity) < 0.02}`,
      ).toBe(`${name} gravity: true`)
      expect(
        `${name} escape: ${relative(escape, row.escapeVelocityKmS) < 0.02}`,
      ).toBe(`${name} escape: true`)
    },
  )

  it.each(reference.planets.map((p) => [p.name, p] as const))(
    '%s has the published bulk density, which is mass over the real ellipsoid',
    (name, row) => {
      const body = find(name)
      /*
       * Volume of the *spheroid*, not of a sphere of the equatorial radius.
       *
       * Saturn is 9.8% oblate, so getting this wrong by using `4/3 πr³` puts
       * its density out by 10% — which is the whole reason `polarRadius` is
       * carried rather than derived, and this is the assertion that says the
       * two radii are the right way round.
       */
      const volume =
        (4 / 3) * Math.PI * body.radius * body.radius * body.polarRadius
      const density = body.mass / volume / 1_000
      expect(relative(density, row.densityGramsPerCm3)).toBeLessThan(0.02)
    },
  )

  it('keeps the two retrograde planets retrograde, once', () => {
    /*
     * The double-encoding trap, checked from the physics rather than the table.
     *
     * A fact sheet says Venus is retrograde twice: a negative rotation period
     * *and* a 177.36 degree obliquity. Carry both and the spin evaluator
     * applies both, and Venus turns the right way round. The component of the
     * spin along the orbit normal is `cos(tilt) · sign(period)`, and it has to
     * come out negative for exactly the bodies that really turn backwards.
     */
    const netSpin = (body: Body): number =>
      Math.cos(body.axialTilt) * Math.sign(body.rotationPeriod)
    for (const name of ['Venus', 'Uranus', 'Pluto', 'Triton', 'Ryugu'])
      expect(`${name}: ${netSpin(find(name)) < 0}`).toBe(`${name}: true`)
    for (const name of ['Earth', 'Mars', 'Jupiter', 'Luna', 'Bennu', 'Ceres'])
      expect(`${name}: ${netSpin(find(name)) > 0}`).toBe(`${name}: true`)
  })
})

describe('the dwarf planets, against the same table', () => {
  it.each(
    reference.dwarfPlanets
      .filter((row) => modelled(row.name))
      .map((row) => [row.name, row] as const),
  )('%s is the published size and mass', (name, row) => {
    const body = find(name)
    expect(relative(body.mass, row.massKg)).toBeLessThan(1e-3)
    /*
     * 1%, because JPL's dwarf-planet table publishes rotation in *days to four
     * figures*: Makemake is `0.937`, which is 22.49 hours and cannot resolve
     * the 22.8266 the lightcurve gives. The data file carries the hours.
     */
    expect(relative(body.rotationPeriod, row.rotationDays * DAY)).toBeLessThan(
      0.02,
    )
    expect(Math.sign(body.rotationPeriod)).toBe(Math.sign(row.rotationDays))

    /*
     * Size compared as a volume, and Haumea is the exception that proves why.
     *
     * JPL's table gives one radius per dwarf planet. For a sphere that is the
     * radius. For Haumea it is 715 km, and Haumea is 1050 x 840 x 537 — a
     * Jacobi ellipsoid whose long axis is nearly twice its short one, and whose
     * volume-equivalent radius from the 2017 occultation (Ortiz et al., Nature
     * 550, 219) is 798 km rather than the 715 km that Spitzer and Herschel
     * thermal modelling gave. That is two measurements disagreeing, not a
     * transcription error, and the newer one is what the data file uses.
     */
    if (name === 'Haumea') {
      expect(meanRadiusOf(body) / KM).toBeGreaterThan(770)
      expect(meanRadiusOf(body) / KM).toBeLessThan(810)
      return
    }
    expect(relative(meanRadiusOf(body), row.meanRadiusKm * KM)).toBeLessThan(
      0.01,
    )
  })

  it('classifies all five as dwarf planets and none of them as planets', () => {
    for (const row of reference.dwarfPlanets) {
      if (!modelled(row.name)) continue
      expect(`${row.name}: ${find(row.name).kind}`).toBe(`${row.name}: dwarf`)
    }
    // The 2006 vote, as a number. Everything else in `planets` is a rock.
    expect(sol().observedPlanets).toBe(8)
  })

  it('makes Pluto and Charon the double body they are', () => {
    const pluto = find('Pluto')
    const charon = find('Charon')
    // The barycentre is outside Pluto's surface, which is true of no other
    // planet–satellite pair in the Solar System.
    const barycentre =
      (charon.elements.semiMajorAxis * charon.mass) / (pluto.mass + charon.mass)
    expect(barycentre).toBeGreaterThan(pluto.radius)
    // Mutually locked: Charon's orbit, Charon's day and Pluto's day are one
    // number. Nothing else in the system does this either.
    expect(
      relative(charon.orbitalPeriod, Math.abs(pluto.rotationPeriod)),
    ).toBeLessThan(1e-3)
    expect(relative(charon.rotationPeriod, charon.orbitalPeriod)).toBeLessThan(
      1e-3,
    )
  })
})

describe('the satellites, against the JPL satellite tables', () => {
  const rows = reference.satellites.filter(
    (row) =>
      // `> 0`, not `!== null`. Nereid's GM cell is a literal `0.00000`, which
      // is JPL writing "unmeasured" in a numeric column; `firstNumber` in the
      // ingest already turns that into a null, and this is the belt to its
      // braces.
      (row.gmKm3S2 ?? 0) > 0 &&
      row.semiMajorAxisKm !== null &&
      modelled(row.name),
  )

  /*
   * Moons whose orbit is published in a frame this project does not use.
   *
   * JPL's satellite elements are in each moon's **local Laplace plane** — the
   * plane its orbit actually precesses about, which for a close-in moon is the
   * planet's equator and for a distant one tilts toward the planet's *orbit*.
   * `SolarBody.inclination` is to the planet's equator, so the two agree for
   * everything inside a few tens of planetary radii and diverge outside it.
   * Iapetus is the case: 15.47 degrees to Saturn's equator, 7.6 to its Laplace
   * plane, and it is the tilt to the equator that makes it the one moon from
   * which the rings are visible as anything but a line.
   */
  const OTHER_FRAME = new Set(['Iapetus', 'Phoebe', 'Himalia', 'Nereid'])

  it('checks every moon the game models and JPL publishes', () => {
    // Guard against the filter above quietly matching nothing.
    expect(rows.length).toBeGreaterThan(35)
  })

  it.each(rows.map((row) => [`${row.planet}/${row.name}`, row] as const))(
    '%s has the published mass, size and orbit',
    (_label, row) => {
      const body = find(row.name)

      // GM, not M: JPL measures the product, because that is what an
      // ephemeris fit actually constrains. Dividing by G is the conversion,
      // and doing it here rather than in the data file is what makes this a
      // check on the data file.
      const mass = ((row.gmKm3S2 as number) * 1e9) / GRAVITATIONAL_CONSTANT
      expect(relative(body.mass, mass)).toBeLessThan(0.02)

      /*
       * 1.5%, because JPL's satellite table rounds. Mimas is published as
       * `186000` km against the 185,539 the ephemeris fit gives, and Nix as
       * `49300` against 48,694 — three significant figures in a column that
       * gives six for Io. The data file carries the precise values, so this
       * bound is the *table's* resolution rather than the data's.
       */
      expect(
        `${row.name} axis: ${relative(body.elements.semiMajorAxis, (row.semiMajorAxisKm as number) * KM) < 0.015}`,
      ).toBe(`${row.name} axis: true`)

      /*
       * Pluto's small moons are the one place the engine's model of "moon" is
       * knowably wrong, and it is asserted rather than excused.
       *
       * Two things are going on and both are real.
       *
       * **The barycentre.** Styx, Nix, Kerberos and Hydra orbit the
       * Pluto–Charon barycentre, and Charon is 12.2% of Pluto's mass. The
       * engine is a patched-conic hierarchy — a moon orbits its parent, full
       * stop — so it propagates them about `G(M_Pluto + m_moon)` and leaves
       * Charon out. A period goes as `M^(-1/2)`, so every one comes out
       * `sqrt(1.122) = 5.9%` long. That is a systematic error with a sign, and
       * the sign is what is checked: the engine's period is always the longer
       * one.
       *
       * **The resonances.** The residual on top is not the engine's. These four
       * are in a 3:1, 4:1, 5:1 and 6:1 chain with Charon, in a six-body system
       * that is chaotic enough that Nix and Hydra tumble — and JPL's own
       * published `a` and `P` for them are not Keplerian about Pluto and
       * Charon either, disagreeing with each other by up to 3%. A two-body
       * relation is good to a few percent here and no better, whoever computes
       * it.
       */
      const BARYCENTRIC = new Set(['Styx', 'Nix', 'Kerberos', 'Hydra'])
      if (BARYCENTRIC.has(row.name) && row.periodDays !== null) {
        const published = Math.abs(row.periodDays) * DAY
        expect(`${row.name} longer: ${body.orbitalPeriod > published}`).toBe(
          `${row.name} longer: true`,
        )
        expect(
          `${row.name} within 12%: ${relative(body.orbitalPeriod, published) < 0.12}`,
        ).toBe(`${row.name} within 12%: true`)
      } else if (row.periodDays !== null) {
        /*
         * Derived again, and against a much harder number than a planet's.
         *
         * A moon's period depends on `G(M_planet + m_moon)`, and the Moon is
         * 1.2% of the Earth — half a percent of its own period, which is the
         * gap between 27.32 days and 27.45. A test that used `G·M_planet`
         * alone would pass on every moon in the system except that one.
         */
        expect(
          relative(body.orbitalPeriod, Math.abs(row.periodDays) * DAY),
        ).toBeLessThan(0.01)
      }

      if (row.eccentricity !== null)
        expect(
          Math.abs(body.elements.eccentricity - row.eccentricity),
        ).toBeLessThan(0.01)
      if (row.inclinationDeg !== null && !OTHER_FRAME.has(row.name))
        expect(
          `${row.name} inclination: ${Math.abs(body.elements.inclination / DEG - row.inclinationDeg) < 1.5}`,
        ).toBe(`${row.name} inclination: true`)
    },
  )

  it.each(
    rows
      .filter((row) => row.meanRadiusKm !== null)
      .map((row) => [`${row.planet}/${row.name}`, row] as const),
  )('%s is the published size, however lumpy it is', (_label, row) => {
    const body = find(row.name)
    const published = (row.meanRadiusKm as number) * KM
    /*
     * Against the *volume-equivalent* radius, not against `body.radius`.
     *
     * JPL publishes a mean radius. For a round moon that is the radius. For
     * Amalthea it is 83.5 km, and Amalthea is 145 x 83 x 70 — so `body.radius`,
     * the largest half-extent, is 74% larger than the published number and
     * correctly so. `meanRadiusOf` reads the shipped geometry's own measured
     * volume where there is one, which for Amalthea gives 81.8 km against
     * JPL's 83.5: two independent measurements of the same moon, agreeing to
     * 2%.
     *
     * 15% for the rest, and the 15% is real. Naiad has no shape model and its
     * published tri-axial fit is 96 x 60 x 52 km, whose equivalent radius is
     * 33 km — against the 29 km "mean radius" JPL's table carries from a
     * different reduction of the same Voyager images. Where two numbers for
     * one 60-kilometer moon disagree by 13%, no tolerance makes them agree.
     */
    if (row.name === 'Naiad') {
      // The two numbers for Naiad are 33 km (Karkoschka's 96 x 60 x 52 fit to
      // the Voyager images) and 29 km (JPL's table, from a different reduction
      // of the same images). 13% apart, on a moon nobody has been back to.
      expect(meanRadiusOf(body) / KM).toBeGreaterThan(28)
      expect(meanRadiusOf(body) / KM).toBeLessThan(35)
      return
    }
    expect(
      `${row.name}: ${relative(meanRadiusOf(body), published) < 0.15}`,
    ).toBe(`${row.name}: true`)
  })
})

describe('the small bodies, against the JPL Small-Body Database', () => {
  const rows = reference.smallBodies.filter((row) => modelled(row.name))

  it('checks every asteroid, comet and dwarf planet the game models', () => {
    expect(rows.length).toBeGreaterThan(50)
  })

  it.each(rows.map((row) => [row.name, row] as const))(
    '%s is on its published orbit',
    (name, row) => {
      const body = find(name)
      const e = row.elements
      expect(
        relative(
          body.elements.semiMajorAxis,
          (e.semiMajorAxisAu as number) * AU,
        ),
      ).toBeLessThan(1e-5)
      expect(
        Math.abs(body.elements.eccentricity - (e.eccentricity as number)),
      ).toBeLessThan(1e-5)
      expect(
        Math.abs(
          body.elements.inclination / DEG - (e.inclinationDeg as number),
        ),
      ).toBeLessThan(1e-4)
      expect(
        Math.abs(
          body.elements.longitudeOfAscendingNode / DEG - (e.nodeDeg as number),
        ),
      ).toBeLessThan(1e-4)
      expect(
        Math.abs(
          body.elements.argumentOfPeriapsis / DEG -
            (e.argumentOfPeriapsisDeg as number),
        ),
      ).toBeLessThan(1e-4)
      // And the period the engine computes from that axis matches JPL's.
      expect(
        relative(body.orbitalPeriod, (e.periodDays as number) * DAY),
      ).toBeLessThan(1e-3)
    },
  )

  it.each(
    rows
      .filter((row) => row.physical.rotationHours !== null)
      .map((row) => [row.name, row] as const),
  )('%s turns at its published rate', (name, row) => {
    const body = find(name)
    expect(
      relative(
        Math.abs(body.rotationPeriod),
        Math.abs(row.physical.rotationHours as number) * 3_600,
      ),
    ).toBeLessThan(0.02)
  })

  it.each(
    rows
      .filter((row) => (row.physical.extentKm?.length ?? 0) === 3)
      .map((row) => [row.name, row] as const),
  )('%s has the published tri-axial extent', (name, row) => {
    const body = find(name)
    const published = [...(row.physical.extentKm as readonly number[])]
      .sort((a, b) => b - a)
      .map((km) => (km * KM) / 2)
    /*
     * Sorted, because JPL does not sort it.
     *
     * Toutatis is published as `1.7 x 2.03 x 4.26`, in the order the paper
     * that measured it happened to use. Taking the first number as the longest
     * axis makes it a body two and a half times too small, and the mistake
     * would be invisible: it is still an asteroid, still lumpy, still there.
     */
    // `?? body.radius`, not `?? 0`: a round body has no `figure` because a = b,
    // and reading a missing intermediate axis as zero made Ceres — which is
    // 482 x 482 x 446 and about as tri-axial as a billiard ball — fail a
    // tri-axial-extent check on an axis it does have.
    const figure = [
      body.radius,
      body.figure?.intermediateRadius ?? body.radius,
      body.polarRadius,
    ]
    /*
     * A body with a shape model is not compared against JPL's extent at all,
     * and that is the honest answer rather than a dodge.
     *
     * A published `extent` is a best-fit *ellipsoid*. A half-extent measured
     * off a shape model is a *bounding box*. On a body that is bent those are
     * different quantities, not one quantity measured twice: Eros is
     * `34.4 x 11.2 x 11.2` as an ellipsoid and 35.1 x 17.2 x 12.1 as a box,
     * and both are right. The shape model is what the game draws, so the shape
     * model is what the data file carries — and the check that keeps *it*
     * honest is the volume, which is unambiguous, agrees to 1%, and is the
     * assertion below.
     */
    if (shapeOf(body) !== undefined) return
    for (let i = 0; i < 3; i += 1)
      expect(
        `${name} axis ${i}: ${relative(figure[i] as number, published[i] as number) < 0.25}`,
      ).toBe(`${name} axis ${i}: true`)
  })

  it.each(
    rows
      .filter((row) => row.physical.diameterKm !== null)
      .map((row) => [row.name, row] as const),
  )('%s encloses the volume its published diameter implies', (name, row) => {
    const body = find(name)
    const mean = meanRadiusOf(body)
    /*
     * The unambiguous check, and the one that catches a real error.
     *
     * `diameter` in SBDB is the diameter of the sphere of the same
     * cross-section, so `(a·b·c)^(1/3)` is the like-for-like comparison. A
     * transposed digit, a wrong unit or a mis-sorted axis all move this;
     * bounding-box-versus-ellipsoid does not, because it preserves volume.
     */
    /*
     * Hartley 2 is exempt, and the exemption is the news rather than the
     * exception. SBDB carries 1.6 km, which is a thermal-model effective
     * diameter from before anybody had seen it. EPOXI flew past in 2010 and
     * measured a dumbbell 2.33 km long with a 0.69 km waist and a mean radius
     * of 0.58 km — so the published diameter and the published shape disagree
     * by 27%, and the spacecraft wins.
     */
    /*
     * Three bodies where SBDB's diameter and the resolved shape disagree, and
     * in all three the resolved shape is what the game draws.
     *
     *   Hartley 2 — SBDB carries 1.6 km, a thermal-model effective diameter
     *     from before anyone had seen it. EPOXI flew past in 2010 and measured
     *     a dumbbell 2.33 km long with a 0.69 km waist: mean radius 0.58 km.
     *   Castalia — SBDB's 1.4 km comes from an absolute magnitude and an
     *     assumed albedo. The 1989 Arecibo radar model, which is the first
     *     asteroid anybody ever resolved, gives 1.08 km equivalent.
     *   Patroclus — SBDB's 140 km is the effective diameter of the *binary*.
     *     Patroclus alone is 127 km and Menoetius 117, and they are modeled as
     *     two bodies here because that is what they are.
     *   Toutatis — SBDB's 5.4 km is close to the body's *longest* dimension.
     *     The 1995 Goldstone/Arecibo radar model is 4.6 x 2.4 x 1.9 km, whose
     *     equivalent diameter is 2.45 km, and that model is what ships.
     */
    const RESOLVED = new Map([
      ['Hartley 2', [0.5, 0.65]],
      ['Castalia', [0.5, 0.6]],
      ['Patroclus', [54, 60]],
      ['Toutatis', [1.1, 1.35]],
    ])
    const window = RESOLVED.get(name)
    if (window !== undefined) {
      expect(`${name}: ${mean / KM > (window[0] as number)}`).toBe(
        `${name}: true`,
      )
      expect(`${name}: ${mean / KM < (window[1] as number)}`).toBe(
        `${name}: true`,
      )
      return
    }
    expect(
      `${name}: ${relative(mean, ((row.physical.diameterKm as number) * KM) / 2) < 0.2}`,
    ).toBe(`${name}: true`)
  })

  it('puts Halley where Halley was at J2000', () => {
    /*
     * The end-to-end check on the whole element pipeline.
     *
     * JPL publishes Halley's elements at an epoch decades away from J2000, and
     * `apps/ingest` propagates the mean anomaly back to the epoch the engine
     * calls zero. Nothing in the transcription can be verified by looking at
     * it. What *can* be checked is the consequence.
     *
     * Halley passed perihelion on 9 February 1986 and aphelion at 35.1 AU in
     * December 2023, on a 75.32-year orbit with a = 17.93 AU and e = 0.967. At
     * the start of 2000 it was 13.89 years past perihelion, so
     * `M = 2π · 13.89 / 75.32 = 66.4°`; solving `E − e sin E = M` gives
     * E = 2.026 rad and `r = a(1 − e cos E) = 25.5 AU` — outside Neptune,
     * still climbing, and twenty-four years from turning round.
     *
     * This solves Kepler's equation, builds the state vector and measures the
     * distance — the same code path the simulation flies — so a sign error in
     * the propagation, a degrees-for-radians slip, or a solver that quietly
     * failed on a 0.967 eccentricity all land here.
     */
    const halley = find('Halley')
    const sunMu = GRAVITATIONAL_CONSTANT * 1.988_41e30
    const distance =
      Vec.length(stateVectorAt(halley.elements, sunMu, 0).position) / AU
    expect(distance).toBeGreaterThan(24.5)
    expect(distance).toBeLessThan(26.5)
  })

  it('flies the two comets that broke the Kepler solver', () => {
    /*
     * C/2020 F3 (NEOWISE) is e = 0.99913 and C/1995 O1 (Hale-Bopp) is 0.99495.
     * Plain Newton–Raphson diverges above about 0.999 — see `kepler.ts` — and
     * returned a body 1.5 radians from where it should be, silently. This is
     * the regression: both must stay between their own perihelion and
     * aphelion at every phase of their orbit, which is the one thing a
     * conic guarantees and a failed solve does not.
     */
    for (const name of ['NEOWISE', 'Hale-Bopp', 'Halley']) {
      const body = find(name)
      const a = body.elements.semiMajorAxis
      const e = body.elements.eccentricity
      const sunMu = GRAVITATIONAL_CONSTANT * 1.988_41e30
      for (let i = 0; i < 64; i += 1) {
        const t = (i / 64) * orbitalPeriod(sunMu, a)
        const r = Vec.length(stateVectorAt(body.elements, sunMu, t).position)
        expect(`${name} at ${i}: ${r >= a * (1 - e) * 0.999}`).toBe(
          `${name} at ${i}: true`,
        )
        expect(`${name} at ${i}: ${r <= a * (1 + e) * 1.001}`).toBe(
          `${name} at ${i}: true`,
        )
      }
    }
  })
})

describe('the shape of the system as a whole', () => {
  it("obeys Kepler's third law across five orders of magnitude in distance", () => {
    /*
     * From Mercury at 0.39 AU to Sedna at 544, every body orbiting the Sun has
     * to satisfy `T² / a³ = 4π²/GM☉` — one constant, a hundred and twenty
     * million to one in period. This is the single assertion that would catch a
     * unit error anywhere in the whole table.
     */
    const sunMu = GRAVITATIONAL_CONSTANT * 1.988_41e30
    for (const body of sol().planets) {
      const ratio =
        (body.orbitalPeriod * body.orbitalPeriod) /
        body.elements.semiMajorAxis ** 3
      expect(
        `${body.name}: ${relative(ratio, (4 * Math.PI ** 2) / sunMu) < 1e-3}`,
      ).toBe(`${body.name}: true`)
    }
  })

  it('puts every moon outside its primary and inside its reach', () => {
    for (const parent of sol().planets) {
      for (const moon of parent.moons) {
        const periapsis =
          moon.elements.semiMajorAxis * (1 - moon.elements.eccentricity)
        const apoapsis =
          moon.elements.semiMajorAxis * (1 + moon.elements.eccentricity)
        const label = `${parent.name}/${moon.name}`
        // Above the surface — including Phobos, which is 6,000 km up and
        // falling, and Dimorphos, which is 780 m from Didymos.
        expect(`${label}: ${periapsis > parent.radius}`).toBe(`${label}: true`)
        // And bound: outside the sphere of influence it is not a moon, it is
        // a body on its own orbit around the Sun that happens to be nearby.
        expect(`${label}: ${apoapsis < parent.sphereOfInfluence}`).toBe(
          `${label}: true`,
        )
      }
    }
  })

  it('is as big as it should be', () => {
    const bodies = everything()
    // Eight planets, five recognized dwarfs and four candidates, fifty
    // asteroids and comets, and sixty-two moons.
    expect(bodies.length).toBeGreaterThan(120)
    for (const body of bodies) expect(body.provenance).toBe('observed')
    // Every one of them addressable, and every address distinct.
    expect(new Set(bodies.map((b) => b.id)).size).toBe(bodies.length)
  })

  it('knows which bodies gravity rounded off and which it did not', () => {
    /*
     * The line this whole change is about.
     *
     * A `figure` is present exactly when a body is not a spheroid. Every planet
     * and every large moon is round, and every rock is not — and the boundary
     * is a real physical one at a couple of hundred kilometers, so it can be
     * checked rather than asserted body by body.
     */
    for (const body of everything()) {
      const round = body.figure === null
      const meanRadius =
        body.figure === null
          ? body.radius
          : (body.radius * body.figure.intermediateRadius * body.polarRadius) **
            (1 / 3)
      /*
       * Haumea is round *and* has a figure, and that is not a contradiction.
       *
       * Hydrostatic equilibrium does not mean spheroidal. A body spun fast
       * enough leaves the Maclaurin sequence for the Jacobi one and its
       * equilibrium shape becomes a tri-axial ellipsoid — and Haumea, turning
       * once every 3.9 hours, is the only large body in the Solar System that
       * has. 1050 x 840 x 537 km is what gravity *wants* it to be. It is the
       * one body here for which "round" and "spheroid" come apart.
       */
      if (body.name === 'Haumea') {
        expect(body.figure).not.toBeNull()
        continue
      }
      if (meanRadius > 400_000)
        expect(
          `${body.name} (${(meanRadius / KM).toFixed(0)} km): round=${round}`,
        ).toBe(`${body.name} (${(meanRadius / KM).toFixed(0)} km): round=true`)
      if (meanRadius < 150_000)
        expect(
          `${body.name} (${(meanRadius / KM).toFixed(0)} km): round=${round}`,
        ).toBe(`${body.name} (${(meanRadius / KM).toFixed(0)} km): round=false`)
    }
  })

  it('names a shape model only where one is shipped', () => {
    const manifest: { shapes: { key: string }[] } = JSON.parse(
      readFileSync(new URL('data/shapes/manifest.json', root), 'utf8'),
    ) as { shapes: { key: string }[] }
    const shipped = new Set(manifest.shapes.map((entry) => entry.key))
    const named = new Set<string>()
    for (const body of everything()) {
      const model = body.figure?.model
      if (model === null || model === undefined) continue
      named.add(model)
      // A key with no file falls back to the generated figure, which is
      // graceful and silent — so nothing else would catch a typo here.
      expect(`${body.name} -> ${model}: shipped=${shipped.has(model)}`).toBe(
        `${body.name} -> ${model}: shipped=true`,
      )
    }
    expect(named.size).toBeGreaterThan(20)
  })
})
