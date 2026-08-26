import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EARTH_MASS,
  EARTH_RADIUS,
  SECONDS_PER_DAY,
} from '@inertialref/shared'
import { TEST_CATALOG, type Body } from '@inertialref/universe'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { openSession, type Session } from './session.ts'
import { gravity, synodicDay, tidallyLocked } from './dossier.ts'
import type { Dossier, Fact } from './dossier.ts'

/*
 * The fact sheet, against a live world.
 *
 * Two halves, and they are tested differently on purpose. The **derivations** —
 * gravity, the synodic day, the tidal-lock test — are arithmetic over numbers
 * and get properties, because the failure mode of each is a sign or a
 * reciprocal that is right for Earth and wrong for Venus. The **page** is a
 * projection onto rows, and what matters there is that it never claims the
 * camera's business, never omits the gaps, and answers for every body in Sol
 * rather than for the four that were checked by hand.
 */

function session(): Session {
  const registry = createTaskRegistry()
  return openSession({
    seed: 'inertialref',
    workers: () => createInlineWorker(registry),
    catalog: TEST_CATALOG,
  })
}

const facts = (page: Dossier): readonly Fact[] =>
  page.groups.flatMap((group) => group.facts)

const valueOf = (page: Dossier, label: string): string | undefined =>
  facts(page).find((fact) => fact.label === label)?.value

describe('a body’s record', () => {
  it('answers for every body in the system, not just the planets', () => {
    /*
     * Sol is 129 bodies and 92 of them are not spheres. The old panel showed
     * four rows that worked for anything; this one branches on figure, on
     * atmosphere, on rings and on whether a moon's semi-major axis should be
     * read in kilometers — so "it renders Earth" proves very little.
     */
    const live = session()
    const sol = live.world.loadSystem('SOL' as never)
    let checked = 0
    for (const body of walk(sol.planets)) {
      const page = live.harness.dossier(`s:SOL/${addressOf(body)}`)
      expect(page, body.name).not.toBeNull()
      expect(page?.name).toBe(body.name)
      expect(page?.groups.length ?? 0).toBeGreaterThan(2)
      // Every fact has to say something. An empty value is a row that renders
      // as a label and a gap, which reads as a load failure.
      for (const fact of facts(page as Dossier)) {
        expect(
          fact.value.length,
          `${body.name} · ${fact.label}`,
        ).toBeGreaterThan(0)
      }
      checked += 1
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('says nothing about the camera', () => {
    /*
     * The rule this rewrite exists for. The panel it replaced led with the
     * range to the eye, the fraction of the frame the disk filled and the two
     * orbit angles — four readings about the telescope on a page about Mars.
     */
    const live = session()
    const page = live.harness.dossier('s:SOL/b:2') as Dossier
    const labels = facts(page).map((fact) => fact.label.toLowerCase())
    for (const banned of ['range', 'fills', 'phase', 'altitude', 'azimuth']) {
      expect(labels, banned).not.toContain(banned)
    }
  })

  it('reads a moon’s orbit in kilometers and a planet’s in AU', () => {
    // `formatDistance` renders Luna's 384,400 km as "0.003 AU", which is
    // technically right and useless for telling two moons apart.
    const live = session()
    const luna = live.harness.dossier('s:SOL/b:2.0') as Dossier
    expect(valueOf(luna, 'Semi-major axis')).toMatch(/km$/)
    const earth = live.harness.dossier('s:SOL/b:2') as Dossier
    expect(valueOf(earth, 'Semi-major axis')).toMatch(/AU$/)
  })

  it('gives three half-extents for a body that is not a spheroid', () => {
    /*
     * Phobos is 13.0 × 11.4 × 9.1 km. A single radius overstates its volume by
     * two thirds, and `figure` is present exactly when a body is not round —
     * null means round, never "unknown".
     */
    const live = session()
    const phobos = live.harness.dossier('s:SOL/b:3.0') as Dossier
    expect(valueOf(phobos, 'Half-extents')).toMatch(/×.*×.*km/)
    expect(valueOf(phobos, 'Radius')).toBeUndefined()
  })

  it('states what it has no data for', () => {
    // The promise PRODUCT.md makes: the interface says which side of the
    // observed/projected line it is on, and an omission is not an answer.
    const live = session()
    const page = live.harness.dossier('s:SOL/b:2') as Dossier
    expect(page.gaps.length).toBeGreaterThan(3)
    for (const gap of page.gaps) {
      expect(gap.label.length).toBeGreaterThan(0)
      expect(gap.why.length).toBeGreaterThan(20)
    }
    expect(page.gaps.map((gap) => gap.label)).toContain('Composition')
  })

  it('lists the satellites as addresses, so the panel can send you to one', () => {
    const live = session()
    const jupiter = live.harness.dossier('s:SOL/b:4') as Dossier
    expect(jupiter.satellites.length).toBeGreaterThan(0)
    for (const moon of jupiter.satellites) {
      expect(live.harness.dossier(moon.address)).not.toBeNull()
    }
  })

  it('numbers a planet by its orbit, never by its address', () => {
    /*
     * ADR-0009: `b:2` is the third body *issued*, not the third one out. It
     * happens to be both in Sol, which is exactly why this is easy to get wrong
     * — in a cataloged system the letters are discovery order.
     */
    const live = session()
    expect((live.harness.dossier('s:SOL/b:0') as Dossier).classification).toBe(
      'First planet of Sol',
    )
    expect((live.harness.dossier('s:SOL/b:2') as Dossier).classification).toBe(
      'Third planet of Sol',
    )
  })

  it('returns null rather than throwing on an address that names nothing', () => {
    const live = session()
    expect(live.harness.dossier('s:SOL/b:9999')).toBeNull()
    expect(live.harness.dossier('not an address at all')).toBeNull()
  })
})

describe('a star’s record', () => {
  it('quotes the zones as distances, from the same solver the generator uses', () => {
    const live = session()
    const sol = live.harness.dossier('s:SOL') as Dossier
    expect(sol.kind).toBe('star')
    // Sol's habitable band is around 0.8–1.4 AU under this build's insolation
    // bounds, and its frost line is the 2.7 AU the giants form beyond.
    expect(valueOf(sol, 'Habitable zone')).toMatch(/AU$/)
    expect(valueOf(sol, 'Frost line')).toBe('2.700 AU')
  })

  it('counts planets rather than bodies', () => {
    // `system.planets` is every body orbiting the star, which for Sol is 66.
    // Four call sites once rendered that beside the word "planets".
    const live = session()
    const sol = live.harness.dossier('s:SOL') as Dossier
    expect(valueOf(sol, 'Planets')).toBe('8')
  })

  it('says when the second star of a pair is not simulated', () => {
    const live = session()
    const pages = TEST_CATALOG.stars
      .filter((star) => star.components > 1)
      .slice(0, 3)
      .map((star) => live.harness.dossier(`s:${star.id}`))
      .filter((page): page is Dossier => page !== null)
    for (const page of pages) {
      expect(page.gaps.map((gap) => gap.label)).toContain(
        'The other components',
      )
    }
  })
})

describe('the derivations', () => {
  it('gives Earth its own surface gravity', () => {
    expect(gravity(EARTH_MASS, EARTH_RADIUS)).toBeCloseTo(9.82, 1)
  })

  it('falls off as the inverse square of the radius', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e20, max: 1e28, noNaN: true }),
        fc.double({ min: 1e5, max: 1e8, noNaN: true }),
        fc.double({ min: 1.1, max: 10, noNaN: true }),
        (mass, radius, factor) => {
          const expected = gravity(mass, radius) / (factor * factor)
          // Relative, and the bound is named: a double carries about sixteen
          // significant digits and this is four multiplications and a divide
          // deep, so 1e-12 is the tightest an equality here can honestly be.
          // `toBeCloseTo(_, 10)` is an *absolute* bound and fails on any body
          // whose surface gravity is large, which is most stars.
          expect(
            Math.abs(gravity(mass, radius * factor) - expected) / expected,
          ).toBeLessThan(1e-12)
        },
      ),
    )
  })

  it('makes a retrograde solar day shorter than the sidereal one', () => {
    /*
     * The sign, which is the whole reason this is not `1/(1/a − 1/b)` written
     * inline at a call site. Venus turns backwards in 243 days against a 225-day
     * year, and its sunrise-to-sunrise day is 117 — *shorter* than either.
     * Dropping the sign gives 2802 days, which is wrong by a factor of 24 and
     * looks perfectly plausible in a panel.
     */
    const day = synodicDay(
      -243.025 * SECONDS_PER_DAY,
      224.701 * SECONDS_PER_DAY,
    ) as number
    expect(day / SECONDS_PER_DAY).toBeCloseTo(116.75, 1)
  })

  it('makes a prograde solar day longer than the sidereal one', () => {
    // Earth turns in 23h56m and the Sun comes back in 24h, because the planet
    // moved a degree along its year in the meantime.
    const day = synodicDay(
      0.99726968 * SECONDS_PER_DAY,
      365.256 * SECONDS_PER_DAY,
    ) as number
    expect(day / 3600).toBeCloseTo(24.0, 1)
  })

  it('never returns a negative or non-finite day (property)', () => {
    // A panel prints whatever comes back. Zero, a negative and an infinity are
    // each a plausible-looking row, and the last two arrive from a denormal
    // period and a retrograde spin without any arithmetic looking wrong.
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        fc.double({ min: 1, max: 1e10, noNaN: true }),
        (rotation, year) => {
          const day = synodicDay(rotation, year)
          if (day === null) return
          expect(Number.isFinite(day)).toBe(true)
          expect(day).toBeGreaterThan(0)
        },
      ),
    )
  })

  it('recognises a lock in either direction of spin', () => {
    const period = 27.3 * SECONDS_PER_DAY
    expect(
      tidallyLocked(
        fakeBody({ rotationPeriod: period, orbitalPeriod: period }),
      ),
    ).toBe(true)
    expect(
      tidallyLocked(
        fakeBody({ rotationPeriod: -period, orbitalPeriod: period }),
      ),
    ).toBe(true)
    expect(
      tidallyLocked(
        fakeBody({ rotationPeriod: period / 2, orbitalPeriod: period }),
      ),
    ).toBe(false)
  })
})

describe('the readings', () => {
  it('never renders a bare exponent or a locale’s decimal comma', () => {
    /*
     * `toLocaleString` would group the digits *and* pick the separator from
     * whichever locale the browser is in, so the same planet would read
     * "6.371,0 km" on one machine and "6,371.0 km" on another. Every readout
     * here is an instrument reading and instruments do not translate.
     */
    const live = session()
    const page = live.harness.dossier('s:SOL/b:4') as Dossier
    for (const fact of facts(page)) {
      expect(fact.value, fact.label).not.toMatch(/e[+-]\d/)
      expect(fact.value, fact.label).not.toMatch(/\d,\d{1,2}\b(?!\d)/)
    }
  })

  it('puts the Sun at half a degree from Earth’s orbit', () => {
    // The picture fact, and a good check on the small-angle handling: 0.53°
    // from Earth, an arcminute-scale disk from Neptune.
    const live = session()
    const earth = live.harness.dossier('s:SOL/b:2') as Dossier
    expect(valueOf(earth, 'Sol in the sky')).toMatch(/^0\.53[0-9]° across$/)
  })
})

/* ------------------------------------------------------------------------- */

/** Enough of a `Body` for the two period derivations, which read two fields. */
function fakeBody(over: {
  rotationPeriod: number
  orbitalPeriod: number
}): Body {
  return over as unknown as Body
}

function* walk(bodies: readonly Body[]): Generator<Body> {
  for (const body of bodies) {
    yield body
    yield* walk(body.moons)
  }
}

const addressOf = (body: Body): string =>
  body.address.kind === 'body' ? `b:${body.address.body.join('.')}` : ''
