import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { deriveSeed, rootSeed } from '@inertialref/procedural'
import { UNIVERSE_ORIGIN } from '@inertialref/spatial'
import { catalogStub, generateCell, MILKY_WAY, NO_CATALOGUE } from './galaxy.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { systemId } from './address.ts'
import { generateSystem, isLandable, walkBodies } from './system.ts'
import {
  findWorlds,
  isEmptyQuery,
  matchesBody,
  matchSystem,
  type WorldQuery,
} from './worldQuery.ts'

/*
 * The query, against real generated systems.
 *
 * Sol is the fixture that can be reasoned about — everybody knows which of its
 * bodies have air and which have a sea — and a procedural cell is the fixture
 * that cannot, which is why the properties are asserted over that one. The two
 * together are the whole claim: the predicates mean what their names say, and
 * they compose the way an intersection does.
 */

const SEED = rootSeed('inertialref')

/** A cell of generated systems, enough that a filter has something to remove. */
const cell = generateCell(
  deriveSeed(SEED, `g:${MILKY_WAY}`),
  { x: 3, y: 0, z: 2 },
  NO_CATALOGUE,
)

/*
 * Sol through the ordinary door — `generateSystem` short-circuits to the
 * hand-built model for it, so this is the same system the game loads rather
 * than a fixture that happens to resemble it.
 */
const solStub = catalogStub(
  TEST_CATALOG.get(systemId('SOL')) as NonNullable<
    ReturnType<typeof TEST_CATALOG.get>
  >,
)
const sol = generateSystem(SEED, MILKY_WAY, solStub)
const solMatches = (query: WorldQuery): readonly string[] =>
  matchSystem(sol, query, UNIVERSE_ORIGIN).map((one) => one.name)

describe('a world query', () => {
  it('says when it is asking for nothing', () => {
    expect(isEmptyQuery({})).toBe(true)
    expect(isEmptyQuery({ kinds: [] })).toBe(true)
    expect(isEmptyQuery({ sea: false })).toBe(false)
    expect(isEmptyQuery({ kinds: ['rocky'] })).toBe(false)
  })

  it('finds the worlds in Sol that have air', () => {
    const withAir = solMatches({ atmosphere: true, kinds: ['rocky'] })
    expect(withAir).toContain('Earth')
    expect(withAir).toContain('Venus')
    expect(withAir).toContain('Mars')
    // Mercury has none, and Luna is a moon rather than a rocky planet.
    expect(withAir).not.toContain('Mercury')
    expect(withAir).not.toContain('Luna')
  })

  it('finds the ringed giants, and only those', () => {
    const ringed = solMatches({ rings: true })
    expect(ringed).toContain('Saturn')
    expect(ringed).not.toContain('Earth')
    for (const name of ringed) expect(name).not.toBe('Mercury')
  })

  it('separates a sea from an atmosphere, because they are two questions', () => {
    // Venus has a great deal of air and nothing liquid on it; the query has to
    // be able to say so, which a single "habitable" flag could not.
    const airless = solMatches({ atmosphere: false })
    expect(airless).toContain('Mercury')
    const seas = solMatches({ sea: true })
    expect(seas).not.toContain('Venus')
    expect(seas).not.toContain('Mercury')
  })

  it('bands a radius in Earth radii', () => {
    const giants = solMatches({ minRadius: 3 })
    expect(giants).toContain('Jupiter')
    expect(giants).toContain('Saturn')
    expect(giants).not.toContain('Earth')
    const small = solMatches({ maxRadius: 0.5 })
    expect(small).not.toContain('Earth')
    expect(small).toContain('Ceres')
  })

  it('counts moons, and a body with none is not a body with one', () => {
    const withMoons = solMatches({ moons: 2 })
    expect(withMoons).toContain('Jupiter')
    expect(withMoons).toContain('Mars')
    expect(withMoons).not.toContain('Venus')
  })

  it('reads landability from the same function `land` does', () => {
    /*
     * Not a second opinion. The search saying a body can be stood on while the
     * verb refuses is the failure this is written against, and it is the kind
     * a separate predicate acquires quietly — so the assertion is that the two
     * agree body for body rather than that the filter returns something.
     */
    const landable = new Set(solMatches({ landable: true }))
    for (const body of walkBodies(sol))
      expect(landable.has(body.name)).toBe(isLandable(body))
  })
})

describe('matching, as properties over generated systems', () => {
  /** Every body of every system in the cell, with its star. */
  const population = findWorlds(SEED, MILKY_WAY, cell, {}, UNIVERSE_ORIGIN)

  it('an empty query matches everything the volume holds', () => {
    expect(population.length).toBeGreaterThan(20)
    for (const match of population) expect(match.address).toContain('/b:')
  })

  it('narrows monotonically: every clause can only remove', () => {
    /*
     * The property that makes the controls composable. A reader turns a chip
     * on expecting fewer rows, and a clause that could *add* one — through a
     * default, a coercion, a missing field read as a match — would make the
     * whole panel unpredictable in a way no single example catches.
     */
    fc.assert(
      fc.property(
        fc.record(
          {
            atmosphere: fc.boolean(),
            sea: fc.boolean(),
            rings: fc.boolean(),
            landable: fc.boolean(),
            habitable: fc.boolean(),
            moons: fc.integer({ min: 0, max: 3 }),
            minRadius: fc.double({ min: 0, max: 4, noNaN: true }),
          },
          { requiredKeys: [] },
        ),
        (query) => {
          const narrowed = findWorlds(
            SEED,
            MILKY_WAY,
            cell,
            query,
            UNIVERSE_ORIGIN,
          )
          expect(narrowed.length).toBeLessThanOrEqual(population.length)
          const whole = new Set(population.map((one) => one.address))
          for (const match of narrowed)
            expect(whole.has(match.address)).toBe(true)
        },
      ),
      { numRuns: 25 },
    )
  })

  it('two clauses are the intersection of one and the other', () => {
    const air = findWorlds(
      SEED,
      MILKY_WAY,
      cell,
      { atmosphere: true },
      UNIVERSE_ORIGIN,
    )
    const rocky = findWorlds(
      SEED,
      MILKY_WAY,
      cell,
      { kinds: ['rocky'] },
      UNIVERSE_ORIGIN,
    )
    const both = findWorlds(
      SEED,
      MILKY_WAY,
      cell,
      { atmosphere: true, kinds: ['rocky'] },
      UNIVERSE_ORIGIN,
    )
    const inAir = new Set(air.map((one) => one.address))
    const inRocky = new Set(rocky.map((one) => one.address))
    const expected = [...inAir].filter((address) => inRocky.has(address))
    expect(both.map((one) => one.address).sort()).toEqual(expected.sort())
  })

  it('is a pure function of the seed, not of the order it is asked in', () => {
    // Rule 4, at the level a search can break it: asking twice, and asking in
    // a different order, must not change what comes back.
    const query: WorldQuery = { landable: true }
    const once = findWorlds(SEED, MILKY_WAY, cell, query, UNIVERSE_ORIGIN)
    const again = findWorlds(SEED, MILKY_WAY, cell, query, UNIVERSE_ORIGIN)
    expect(again).toEqual(once)
    const reversed = findWorlds(
      SEED,
      MILKY_WAY,
      [...cell].reverse(),
      query,
      UNIVERSE_ORIGIN,
    )
    expect(reversed.map((one) => one.address).sort()).toEqual(
      once.map((one) => one.address).sort(),
    )
  })

  it('stops where it is told, rather than finishing the batch', () => {
    // What makes a search cancellable at all: a second question must not wait
    // for the first one's whole volume.
    let seen = 0
    const stopped = findWorlds(
      SEED,
      MILKY_WAY,
      cell,
      {},
      UNIVERSE_ORIGIN,
      () => (seen += 1) > 2,
    )
    expect(stopped.length).toBeLessThan(population.length)
  })

  it('skips a star the query excluded before generating its system', () => {
    /*
     * The optimization that makes a filtered search affordable, asserted as
     * behavior rather than as a timing: a class nothing in the cell has must
     * return nothing, and it must do so without the generator refusing — the
     * stub filter is the only thing that can produce that combination.
     */
    const none = findWorlds(
      SEED,
      MILKY_WAY,
      cell,
      { starClasses: ['W'] },
      UNIVERSE_ORIGIN,
    )
    expect(none).toEqual([])
  })

  it('finds worlds around catalog stars with luminosity prefixes', () => {
    const stub = catalogStub(TEST_CATALOG.find("Barnard's Star")!)
    const query: WorldQuery = { starClasses: ['M'] }
    const expected = matchSystem(
      generateSystem(SEED, MILKY_WAY, stub),
      query,
      stub.position,
    )
    expect(expected.map((one) => one.name)).toContain("Barnard's Star b")
    expect(findWorlds(SEED, MILKY_WAY, [stub], query, stub.position)).toEqual(
      expected,
    )
  })

  it.each(['dM4', 'sdM4', 'gK5', 'esdM5', 'DA2', '(unclassified)'])(
    'filters %s by the generated star classification',
    (spectralType) => {
      const stub = {
        ...catalogStub(TEST_CATALOG.find("Barnard's Star")!),
        spectralType,
      }
      const generated = generateSystem(SEED, MILKY_WAY, stub)
      const query: WorldQuery = {
        starClasses: [generated.star.spectralClass],
      }
      const expected = matchSystem(generated, query, stub.position)
      expect(expected.length).toBeGreaterThan(0)
      expect(findWorlds(SEED, MILKY_WAY, [stub], query, stub.position)).toEqual(
        expected,
      )
    },
  )
})

describe('a match', () => {
  it('carries what a listing draws, from the record rather than a tag', () => {
    // Measured from Sol itself: the universe origin is the galactic centre and
    // Sol is 26,673 light years out from it, so a distance taken from there is
    // a real number about the wrong question.
    const earth = matchSystem(sol, { kinds: ['rocky'] }, sol.position).find(
      (one) => one.name === 'Earth',
    )
    expect(earth?.address).toBe('g:milky-way/s:SOL/b:2')
    expect(earth?.systemName).toBe('Sol')
    expect(earth?.hasAtmosphere).toBe(true)
    expect(earth?.moons).toBe(1)
    expect(earth?.landable).toBe(true)
    expect(earth?.spectralType).toContain('G')
    // Distance from where the search was centered, which for Sol at the
    // universe origin is zero and must not be a NaN from an empty division.
    expect(earth?.lightYears).toBeCloseTo(0, 6)
  })

  it('agrees with the predicate it was selected by', () => {
    for (const match of matchSystem(sol, {}, UNIVERSE_ORIGIN)) {
      const body = [...walkBodies(sol)].find(
        (one) => one.name === match.name && one.kind === match.kind,
      )
      if (body === undefined) continue
      expect(matchesBody(sol.star, body, { sea: match.hasSea })).toBe(true)
      expect(matchesBody(sol.star, body, { landable: match.landable })).toBe(
        true,
      )
    }
  })
})
