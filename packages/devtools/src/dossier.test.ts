import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EARTH_MASS, EARTH_RADIUS, SECONDS_PER_DAY } from '@inertialref/shared'
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

const valueOf = (page: Dossier, label: string): string | null | undefined =>
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
      /*
       * Every row says something, and a row with no value says *why*.
       *
       * The empty string is the failure this guards: it renders as a label
       * beside a blank, which reads as a load fault rather than as an answer.
       * `value: null` is the deliberate form and it carries `pending` with it.
       */
      for (const fact of facts(page as Dossier)) {
        const where = `${body.name} · ${fact.label}`
        if (fact.value === null) {
          expect(fact.pending?.length ?? 0, where).toBeGreaterThan(20)
        } else {
          expect(fact.value.length, where).toBeGreaterThan(0)
        }
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

  it('draws an unmeasured field as a row rather than leaving it out', () => {
    /*
     * The promise PRODUCT.md makes, and the reason `value` is nullable. An
     * absent row cannot distinguish "this body has no atmosphere" from "nobody
     * has measured its atmosphere", and those are the two answers a
     * planetarium most needs to keep apart.
     */
    const live = session()
    const page = live.harness.dossier('s:SOL/b:2') as Dossier
    expect(page.pendingCount).toBeGreaterThan(3)
    const empty = facts(page).filter((fact) => fact.value === null)
    expect(empty.map((fact) => fact.label)).toContain('Composition')
    expect(empty.length).toBe(page.pendingCount)
  })

  it('says why a field is empty in the universe’s voice, not the engine’s', () => {
    /*
     * The planetarium is a reading room for a galaxy that is *there* — a
     * projected body is real, it simply has not been visited. A reason that
     * said "the generator does not produce one" would tell the reader the sky
     * is a program, which is the one thing this mode may not do.
     *
     * **Over every page this build can produce, not a hand-listed four.** The
     * first version named `s:SOL`, `s:SOL/b:2`, `s:SOL/b:3.0` and `s:SOL/b:5`,
     * which never entered `discoveryGroup`'s projected branch — every Sol body
     * carries a `measurement` — and never opened a procedurally charted system
     * at all. That is exactly the population whose reasons are most tempting to
     * write in the engine's voice, because it is the population the generator
     * invents. This walks all 129 bodies of Sol, its star, and a projected
     * system with its own.
     *
     * What it cannot check is whether a reason is *true*. One that claimed a
     * host star's luminosity had not been measured shipped past this, on Earth,
     * whose star's page renders 1.000 L☉ two clicks away. See ADR-0014.
     */
    const live = session()
    const banned =
      /generator|generated|procedural|not modeled|this build|codebase|engine|TODO|implement/i
    let projectedPages = 0
    let checked = 0

    for (const address of everyPage(live)) {
      const page = live.harness.dossier(address) as Dossier
      if (page.provenance === 'projected') projectedPages += 1
      for (const fact of facts(page)) {
        if (fact.pending === undefined) continue
        checked += 1
        expect(fact.pending, `${address} · ${fact.label}`).not.toMatch(banned)
      }
    }

    // The two populations the hand-listed version could not reach.
    expect(projectedPages).toBeGreaterThan(0)
    expect(checked).toBeGreaterThan(500)
  })

  it('reaches the branch a body nobody has confirmed takes', () => {
    // `discoveryGroup` has a second half for a projected body, and no Sol
    // address enters it — every body there carries a `measurement`.
    const live = session()
    const projected = [...everyPage(live)]
      .map((address) => live.harness.dossier(address))
      .find(
        (page): page is Dossier =>
          // A *body*, not the star it goes round: a star's record has no
          // discovery group at all, so the first projected page in the walk is
          // the wrong one to assert against.
          page !== null &&
          page.provenance === 'projected' &&
          page.kind !== 'star',
      )
    expect(projected).toBeDefined()
    expect(valueOf(projected as Dossier, 'First observed')).toBeNull()
    const why = facts(projected as Dossier).find(
      (fact) => fact.label === 'First observed',
    )?.pending
    expect(why).toContain('projected')
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

  it('does not print a sentinel year as a year', () => {
    /*
     * `SolarBody.discoveryYear` is 0 for the bodies known since antiquity, and
     * a panel that renders it renders `First observed 0`. It is not an empty
     * field either — "nobody wrote down when this was first seen" is a stronger
     * answer than a date.
     */
    const live = session()
    const earth = live.harness.dossier('s:SOL/b:2') as Dossier
    expect(valueOf(earth, 'First observed')).toBe('Antiquity')
    const uranus = live.harness.dossier('s:SOL/b:6') as Dossier
    expect(valueOf(uranus, 'First observed')).toBe('1781')
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

  it('does not describe the Sun as fainter than the Sun', () => {
    // The Sun is the denominator of two clauses in that sentence, so writing
    // it without a branch produced "catalogued at 0.00 light years, putting out
    // 1.000 times fainter than the Sun" — wrong twice, about the one star every
    // reader looks at first.
    const live = session()
    const sol = live.harness.dossier('s:SOL') as Dossier
    expect(sol.summary).not.toMatch(/0\.00 light years/)
    expect(sol.summary).not.toMatch(/1\.00 times/)
    expect(sol.summary).toContain('the Sun’s own output')
  })

  it('counts planets rather than bodies', () => {
    // `system.planets` is every body orbiting the star, which for Sol is 66.
    // Four call sites once rendered that beside the word "planets".
    const live = session()
    const sol = live.harness.dossier('s:SOL') as Dossier
    expect(valueOf(sol, 'Planets')).toBe('8')
  })

  it('counts the companions the catalog records, and charts the primary', () => {
    const live = session()
    const pages = TEST_CATALOG.stars
      .filter((star) => star.components > 1)
      .slice(0, 3)
      .map((star) => live.harness.dossier(`s:${star.id}`))
      .filter((page): page is Dossier => page !== null)
    for (const page of pages) {
      expect(valueOf(page, 'Companions')).toMatch(/recorded$/)
      expect(valueOf(page, 'Companion orbits')).toBeNull()
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
      if (fact.value === null) continue
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

/**
 * Every address this build can produce a page for: Sol, its 129 bodies, and the
 * first projected system in reach with its own.
 *
 * The survey rather than a literal list, so a system gained or a body added is
 * covered without anybody remembering to add a string.
 */
function* everyPage(live: Session): Generator<string> {
  const rows = live.harness.targets({ lightYears: 8 })
  let projected: string | null = null
  for (const row of rows) {
    if (row.system === 'SOL') {
      yield row.address
      continue
    }
    if (row.kind === 'system' && row.provenance === 'projected') {
      projected ??= row.address
    }
  }
  if (projected === null) return
  yield projected
  // Loading it is what makes its bodies addressable at all.
  for (const body of live.harness.loadSystem(projected.split('s:')[1] ?? '')) {
    yield body.address
  }
}

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
