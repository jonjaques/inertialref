import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  GRAVITATIONAL_CONSTANT,
  SECONDS_PER_DAY,
  STEFAN_BOLTZMANN,
} from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { TEST_CATALOG } from './catalog/fixture.ts'
import {
  type Body,
  type BodyFixedDirection,
  catalogStub,
  generateSystem,
  groundElevation,
  MILKY_WAY,
  ROUNDING_RADIUS,
  type StarSystem,
  surfaceRadius,
  walkBodies,
} from './index.ts'

/** Relative difference, so a tolerance means the same thing at any scale. */
const relative = (a: number, b: number): number =>
  b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b)

/*
 * The debris every system has, and the measurements it is supposed to match.
 *
 * A generated belt is the easiest thing in this project to make plausible and
 * the easiest to get wrong, because nobody can look at one and tell. So it is
 * checked against the two places the real population has a *sharp* feature:
 * the rotation barrier and the size ladder. Both are consequences of physics
 * rather than of taste, both are measured across hundreds of thousands of real
 * bodies, and a generator that reproduces them is doing something better than
 * looking right.
 */

const ROOT = rootSeed('inertialref')

const systems = (): readonly StarSystem[] =>
  TEST_CATALOG.stars.map((star) =>
    generateSystem(ROOT, MILKY_WAY, catalogStub(star)),
  )

const SMALL = new Set(['asteroid', 'comet', 'dwarf'])

/** Anything that is not a world, however it got there. */
const isSmall = (body: Body): boolean => SMALL.has(body.kind)

/** The generated half of that: Sol's are measurements, not draws. */
const isDebris = (body: Body): boolean =>
  body.provenance === 'projected' && isSmall(body)

const debrisOf = (system: StarSystem): readonly Body[] =>
  system.planets.filter(isDebris)

const allDebris = (): readonly Body[] => systems().flatMap(debrisOf)

describe('a generated system has debris in it', () => {
  it('gives every system a belt', () => {
    for (const system of systems()) {
      // Sol is built from measurements and has fifty-nine of its own; every
      // other system draws its belt. Both have to have something, which is the
      // claim: there is no longer a system in the galaxy that is only planets.
      const small = system.planets.filter(isSmall).length
      expect(`${system.name}: ${small > 0}`).toBe(`${system.name}: true`)
    }
  })

  it('is the same belt every time it is asked for', () => {
    const once = allDebris().map((b) => `${b.name}@${b.elements.semiMajorAxis}`)
    const twice = allDebris().map(
      (b) => `${b.name}@${b.elements.semiMajorAxis}`,
    )
    expect(once).toEqual(twice)
    expect(once.length).toBeGreaterThan(20)
  })

  it('leaves every planet at the address it had before debris existed', () => {
    /*
     * ADR-0009, as the reason the debris is issued last. A save that pointed at
     * `b:3` before this feature has to point at the same world after it, and
     * appending is what makes that true for free.
     */
    for (const system of systems()) {
      const worlds = system.planets.filter((body) => !isSmall(body))
      for (let i = 0; i < worlds.length; i += 1) {
        const address = worlds[i]?.address
        expect(address?.kind).toBe('body')
        expect(address?.kind === 'body' ? address.body : null).toEqual([i])
      }
    }
  })
})

describe('the rotation barrier', () => {
  it('nothing generated spins faster than it can hold itself together', () => {
    /*
     * The sharpest feature in the whole light-curve database.
     *
     * A strengthless rubble pile flies apart at `T = sqrt(3π / Gρ)` — 2.13
     * hours at the 2,400 kg/m³ this generator uses for an asteroid, 4.3 hours
     * for a 600 kg/m³ comet. The measured population piles up against that line
     * and does not cross it, and every known faster rotator is a monolith below
     * the size where cohesion stops mattering.
     *
     * This is the assertion that says the generated population is a population
     * rather than a uniform draw dressed as one. A generator that picked a
     * rotation period out of a plausible-looking range would fail it on the
     * first few bodies.
     */
    const barrier = (density: number): number =>
      Math.sqrt((3 * Math.PI) / (GRAVITATIONAL_CONSTANT * density))
    const asteroid = barrier(2_400)
    const comet = barrier(600)
    for (const body of allDebris()) {
      const period = Math.abs(body.rotationPeriod)
      const floor = body.kind === 'comet' ? comet : asteroid
      expect(`${body.name}: ${period >= floor * 0.999}`).toBe(
        `${body.name}: true`,
      )
    }
    // And the barrier is where it should be: 2.13 h and 4.26 h.
    expect(asteroid / 3_600).toBeCloseTo(2.13, 2)
    expect(comet / 3_600).toBeCloseTo(4.26, 2)
  })

  it('puts most of them near the barrier and a few nowhere near it', () => {
    /*
     * A barrier with nothing against it is a clamp, not a distribution. The
     * measured shape is a pile-up in the first few hours with a long slow tail
     * — 253 Mathilde takes 17 days, 3548 Leucus 18 — so both ends are asserted.
     */
    const hours = allDebris()
      .filter((b) => b.kind !== 'comet')
      .map((b) => Math.abs(b.rotationPeriod) / 3_600)
      .sort((a, b) => a - b)
    expect(hours.length).toBeGreaterThan(20)
    const median = hours[Math.floor(hours.length / 2)] as number
    expect(median).toBeGreaterThan(3)
    expect(median).toBeLessThan(20)
    // Something within an hour of the barrier, and something over a day.
    expect(hours[0]).toBeLessThan(3.5)
    expect(hours[hours.length - 1]).toBeGreaterThan(24)
  })

  it('spins them both ways', () => {
    // YORP and collisions have no preferred direction, so roughly a third
    // retrograde. A population that all turned the same way would be a tell.
    const retrograde = allDebris().filter((b) => b.rotationPeriod < 0).length
    const fraction = retrograde / allDebris().length
    expect(fraction).toBeGreaterThan(0.15)
    expect(fraction).toBeLessThan(0.55)
  })
})

describe('the size ladder', () => {
  it('follows the order statistic a collisional cascade produces', () => {
    /*
     * Dohnanyi's `dN/dD ∝ D^-3.5` means the k-th largest body in a belt goes as
     * `k^(-1/2.5)`. Over a system's own debris that is a factor of about three
     * from the largest to the tenth, which is what the real main belt's top ten
     * do — Ceres at 470 km down to Davida at 135.
     *
     * Checked as a monotone ladder with a bounded spread rather than as a fit,
     * because each rung carries a ±25% jitter and eight rungs is not a sample
     * anybody should fit a slope to.
     */
    for (const system of systems()) {
      const belt = debrisOf(system)
        .filter((b) => b.kind !== 'comet')
        .map((b) => (b.radius * b.polarRadius ** 2) ** (1 / 3))
      if (belt.length < 4) continue
      const largest = Math.max(...belt)
      const smallest = Math.min(...belt)
      expect(`${system.name}: ${largest / smallest < 12}`).toBe(
        `${system.name}: true`,
      )
      expect(`${system.name}: ${largest / smallest > 1.2}`).toBe(
        `${system.name}: true`,
      )
    }
  })

  it('calls a round one a dwarf planet and a lumpy one an asteroid', () => {
    /*
     * The 2006 vote, as a consequence rather than as a label. Above
     * `ROUNDING_RADIUS` self-gravity wins and the body has no `figure`; below
     * it, it does. Nothing may be both.
     */
    for (const body of allDebris()) {
      const mean =
        body.figure === null
          ? body.radius
          : (body.radius * body.figure.intermediateRadius * body.polarRadius) **
            (1 / 3)
      const label = `${body.name} (${(mean / 1_000).toFixed(0)} km, ${body.kind})`
      if (mean >= ROUNDING_RADIUS) {
        expect(`${label}: round`).toBe(`${label}: round`)
        expect(`${label}: ${body.figure === null}`).toBe(`${label}: true`)
        expect(`${label}: ${body.kind === 'dwarf'}`).toBe(`${label}: true`)
      } else {
        expect(`${label}: ${body.figure !== null}`).toBe(`${label}: true`)
        expect(`${label}: ${body.kind !== 'dwarf'}`).toBe(`${label}: true`)
      }
    }
  })

  it('keeps the density it claims', () => {
    // The mass comes from the volume and a class density, and the figure
    // preserves volume — so the density has to come back out unchanged. This
    // is what catches an axis rescale that quietly changed how heavy a body is.
    for (const body of allDebris()) {
      const b = body.figure?.intermediateRadius ?? body.radius
      const volume = (4 / 3) * Math.PI * body.radius * b * body.polarRadius
      const density = body.mass / volume
      const expected =
        body.kind === 'comet' ? 600 : body.kind === 'dwarf' ? 2_000 : 2_400
      expect(`${body.name}: ${Math.abs(density / expected - 1) < 0.02}`).toBe(
        `${body.name}: true`,
      )
    }
  })
})

describe('the datum a ship lands on', () => {
  /*
   * The one place a wrong figure is a *safety* bug rather than a cosmetic one.
   *
   * Ground contact is gated on whether a body has a spin frame, not on whether
   * it is landable, so a ship can touch down on Haumea. `surfaceRadius` is the
   * datum that test runs against, and it used `body.radius` — which for a body
   * with a figure is `a`, the largest half-extent. On Haumea that is 1050 km
   * against a polar 537: half a body-radius of empty space, reported as
   * altitude zero.
   */
  const solSystem = (): StarSystem =>
    generateSystem(ROOT, MILKY_WAY, catalogStub(TEST_CATALOG.stars[0]!))

  const axis = (which: 'x' | 'y' | 'z'): BodyFixedDirection =>
    ({
      x: which === 'x' ? 1 : 0,
      y: which === 'y' ? 1 : 0,
      z: which === 'z' ? 1 : 0,
    }) as BodyFixedDirection

  it('follows the measured ellipsoid rather than the longest half-extent', () => {
    for (const body of [...walkBodies(solSystem())]) {
      if (body.figure === null) continue
      const label = `${body.name}`
      // Along each principal axis the datum is that axis's own half-extent.
      expect(
        `${label} equator: ${relative(surfaceRadius(body, axis('x')), body.radius) < 1e-9}`,
      ).toBe(`${label} equator: true`)
      expect(
        `${label} pole: ${relative(surfaceRadius(body, axis('y')), body.polarRadius) < 1e-9}`,
      ).toBe(`${label} pole: true`)
      expect(
        `${label} b: ${relative(surfaceRadius(body, axis('z')), body.figure.intermediateRadius) < 1e-9}`,
      ).toBe(`${label} b: true`)
    }
  })

  it('never puts the ground above the body anywhere on it', () => {
    /*
     * The regression, stated as the property it broke: an ellipsoid's radius
     * is between its shortest and longest half-extent in *every* direction, so
     * a datum outside that range is a datum outside the body.
     */
    for (const body of [...walkBodies(solSystem())]) {
      if (body.figure === null) continue
      for (let i = 0; i < 64; i += 1) {
        // Fibonacci sphere: 64 directions with no polar clustering.
        const y = 1 - (2 * (i + 0.5)) / 64
        const r = Math.sqrt(Math.max(0, 1 - y * y))
        const theta = Math.PI * (1 + Math.sqrt(5)) * i
        const direction = {
          x: Math.cos(theta) * r,
          y,
          z: Math.sin(theta) * r,
        } as BodyFixedDirection
        const datum = surfaceRadius(body, direction)
        const label = `${body.name} at ${i}`
        expect(`${label}: ${datum <= body.radius * 1.000001}`).toBe(
          `${label}: true`,
        )
        expect(`${label}: ${datum >= body.polarRadius * 0.999999}`).toBe(
          `${label}: true`,
        )
      }
    }
  })

  it('leaves every spheroid exactly where it was', () => {
    // The other half of the promise: nothing without a figure moved, which is
    // every planet, every large moon, Pluto and Ceres.
    for (const body of [...walkBodies(solSystem())]) {
      if (body.figure !== null) continue
      for (const which of ['x', 'y', 'z'] as const)
        expect(`${body.name}: ${surfaceRadius(body, axis(which))}`).toBe(
          `${body.name}: ${body.radius + groundElevation(body.surface, axis(which))}`,
        )
    }
  })
})

describe('where the debris is', () => {
  it('does not put a rock inside a planet', () => {
    for (const system of systems()) {
      const worlds = system.planets.filter((b) => !isDebris(b))
      for (const rock of debrisOf(system)) {
        for (const world of worlds) {
          const ratio =
            rock.elements.semiMajorAxis / world.elements.semiMajorAxis
          const label = `${rock.name} vs ${world.name}`
          expect(`${label}: ${ratio > 1.079 || ratio < 1 / 1.079}`).toBe(
            `${label}: true`,
          )
        }
      }
    }
  })

  it('tells a comet from an asteroid by its orbit, which is what a comet is', () => {
    /*
     * 2060 Chiron and 95P/Chiron are the same object: it was an asteroid until
     * somebody saw a coma. What actually separates the two populations is the
     * orbit — a comet comes from a long way out on a steep, eccentric path, and
     * an asteroid sits in the plane on a nearly circular one.
     */
    const comets = allDebris().filter((b) => b.kind === 'comet')
    const rocks = allDebris().filter((b) => b.kind !== 'comet')
    expect(comets.length).toBeGreaterThan(3)
    for (const comet of comets) {
      expect(`${comet.name}: ${comet.elements.eccentricity > 0.5}`).toBe(
        `${comet.name}: true`,
      )
    }
    const inPlane = (bodies: readonly Body[]): number =>
      bodies.filter((b) => b.elements.inclination < 0.35).length / bodies.length
    // Nearly every asteroid is within 20° of the plane; comets arrive from
    // anywhere, so far fewer of them are.
    expect(inPlane(rocks)).toBeGreaterThan(0.85)
    expect(inPlane(comets)).toBeLessThan(0.5)
  })

  it('gives every one of them a period that follows from its orbit', () => {
    for (const system of systems()) {
      for (const body of debrisOf(system)) {
        const expected =
          2 *
          Math.PI *
          Math.sqrt(
            body.elements.semiMajorAxis ** 3 / (system.star.mu + body.mu),
          )
        expect(
          `${body.name}: ${Math.abs(body.orbitalPeriod / expected - 1) < 1e-9}`,
        ).toBe(`${body.name}: true`)
      }
    }
  })

  it('never puts one on a hyperbola or inside its own star', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TEST_CATALOG.stars.length - 1 }),
        (i) => {
          const system = generateSystem(
            ROOT,
            MILKY_WAY,
            catalogStub(TEST_CATALOG.stars[i]!),
          )
          /*
           * The floor is the star, not a number of astronomical units.
           *
           * An absolute 0.05 AU was the first version of this, and Proxima
           * Centauri failed it — correctly. Proxima puts out 0.08% of a solar
           * luminosity, so its frost line is at 0.076 AU and its belt is inside
           * that; a rock at 0.047 AU round an M dwarf is at 200 K, which is
           * colder than the main belt. Every distance in a system scales with the
           * star, which is the reason the bands are drawn in units of the frost
           * line in the first place.
           */
          const sublimation = Math.sqrt(
            system.star.luminosity /
              (16 * Math.PI * STEFAN_BOLTZMANN * 1_500 ** 4),
          )
          for (const body of debrisOf(system)) {
            expect(body.elements.eccentricity).toBeLessThan(1)
            const periapsisDistance =
              body.elements.semiMajorAxis * (1 - body.elements.eccentricity)
            expect(periapsisDistance).toBeGreaterThan(system.star.radius)
            // Inside this it is vapor, not a body.
            expect(periapsisDistance).toBeGreaterThan(sublimation * 0.99)
            expect(body.orbitalPeriod).toBeGreaterThan(SECONDS_PER_DAY)
          }
        },
      ),
    )
  })
})
