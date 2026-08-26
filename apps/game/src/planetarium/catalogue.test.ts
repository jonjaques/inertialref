import { describe, expect, it } from 'vitest'
import type { TravelTarget } from '@inertialref/devtools'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  groupBySystem,
  indentOf,
  measureOf,
  neighbours,
  orbitalOrder,
} from './catalogue.ts'
import { acceptsRow } from './kinds.ts'

/*
 * The catalog's arrangement, without a world or a React tree.
 *
 * Everything here is a pure function over rows, which is the whole reason it
 * was pulled out of the panel: the two bugs it exists to prevent — a listing in
 * issue order, and a filter that removes a moon by removing its planet — are
 * both invisible in a screenshot and both one assertion each.
 */

const row = (
  over: Partial<TravelTarget> & Pick<TravelTarget, 'address'>,
): TravelTarget => ({
  kind: 'body',
  name: over.address,
  system: 'SOL',
  depth: 1,
  detail: '',
  distance: 0,
  distanceText: '0 m',
  landable: false,
  loaded: true,
  provenance: 'observed',
  bodyKind: 'rocky',
  spectralType: null,
  colour: null,
  radius: 1e6,
  semiMajorAxis: AU,
  children: 0,
  parent: 's:SOL',
  ...over,
})

const star = (
  over: Partial<TravelTarget> & Pick<TravelTarget, 'address'>,
): TravelTarget =>
  row({
    kind: 'system',
    depth: 0,
    bodyKind: null,
    parent: null,
    semiMajorAxis: 0,
    colour: { r: 1, g: 0.9, b: 0.8 },
    ...over,
  })

const ALL = ['stars', 'planets', 'moons', 'dwarfs', 'asteroids', 'comets']

describe('grouping a survey', () => {
  it('puts each system’s bodies under it', () => {
    const groups = groupBySystem(
      [
        star({ address: 's:SOL' }),
        row({ address: 's:SOL/b:0' }),
        star({ address: 's:PROX' }),
        row({ address: 's:PROX/b:0', parent: 's:PROX' }),
      ],
      ALL,
    )
    expect(groups.map((group) => group.system.address)).toEqual([
      's:SOL',
      's:PROX',
    ])
    expect(groups[0]?.bodies.map((body) => body.address)).toEqual(['s:SOL/b:0'])
  })

  it('drops a body that arrives before any system', () => {
    // Cannot happen against the current survey, which emits the star first.
    // A listing that reparented a stray under whichever system came before it
    // would be wrong in a way nobody could see from the screen.
    expect(groupBySystem([row({ address: 's:SOL/b:0' })], ALL)).toEqual([])
  })

  it('keeps a star whose own class is filtered out but whose bodies survive', () => {
    /*
     * Turning off "Stars" is a request about the *rows that are stars*, not a
     * request to hide the tree under them. Filtering the group as a whole would
     * take Earth off the screen because Sol is a star.
     */
    const groups = groupBySystem(
      [star({ address: 's:SOL' }), row({ address: 's:SOL/b:0' })],
      ['planets'],
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.bodies).toHaveLength(1)
  })

  it('reports what the filter is holding back', () => {
    const groups = groupBySystem(
      [
        star({ address: 's:SOL' }),
        row({ address: 's:SOL/b:0' }),
        row({ address: 's:SOL/b:1', bodyKind: 'asteroid' }),
        row({ address: 's:SOL/b:2', bodyKind: 'comet' }),
      ],
      ['stars', 'planets'],
    )
    expect(groups[0]?.total).toBe(3)
    expect(groups[0]?.bodies).toHaveLength(1)
  })
})

describe('orbital order', () => {
  it('sorts outward rather than by the order addresses were issued', () => {
    /*
     * The bug this exists for. `b:2` is the third body ever *issued* in a
     * system, not the third one out (ADR-0009) — in a cataloged system the
     * letters are discovery order, so a hot Jupiter confirmed last sorts last
     * and orbits innermost.
     */
    const ordered = orbitalOrder([
      row({ address: 's:X/b:0', semiMajorAxis: 5 * AU }),
      row({ address: 's:X/b:1', semiMajorAxis: 0.1 * AU }),
      row({ address: 's:X/b:2', semiMajorAxis: 1 * AU }),
    ])
    expect(ordered.map((body) => body.address)).toEqual([
      's:X/b:1',
      's:X/b:2',
      's:X/b:0',
    ])
  })

  it('puts a moon under its planet, and sorts the moons outward too', () => {
    const ordered = orbitalOrder([
      row({ address: 's:X/b:1', semiMajorAxis: 5 * AU }),
      row({
        address: 's:X/b:1.1',
        depth: 2,
        parent: 's:X/b:1',
        semiMajorAxis: 1e9,
      }),
      row({
        address: 's:X/b:1.0',
        depth: 2,
        parent: 's:X/b:1',
        semiMajorAxis: 4e8,
      }),
      row({ address: 's:X/b:0', semiMajorAxis: 1 * AU }),
    ])
    expect(ordered.map((body) => body.address)).toEqual([
      's:X/b:0',
      's:X/b:1',
      's:X/b:1.0',
      's:X/b:1.1',
    ])
  })

  it('keeps a moon whose planet the filter removed', () => {
    // Losing Io because "Planets" is off is a filter deciding what a moon is.
    const ordered = orbitalOrder([
      row({ address: 's:X/b:1.0', depth: 2, parent: 's:X/b:1' }),
    ])
    expect(ordered).toHaveLength(1)
    expect(indentOf(ordered[0] as TravelTarget, new Set())).toBe(1)
  })

  it('sorts a promoted moon by where its parent was, not by its own orbit', () => {
    /*
     * The bug the second argument exists for. Turning off "Asteroids" in Sol
     * left Dimorphos, Selam, Dactyl and six more sitting *above Mercury*: a
     * moon of an asteroid orbits at a kilometre or two and the planets orbit at
     * tenths of an AU, so promoting them to the top level put nine rocks nobody
     * asked for at the head of the list, measured in kilometres in a column of
     * AU.
     */
    const didymos = row({ address: 's:X/b:9', semiMajorAxis: 1.64 * AU })
    const dimorphos = row({
      address: 's:X/b:9.0',
      depth: 2,
      parent: 's:X/b:9',
      semiMajorAxis: 1190,
    })
    const mercury = row({ address: 's:X/b:0', semiMajorAxis: 0.39 * AU })
    const ordered = orbitalOrder(
      [mercury, dimorphos],
      [mercury, didymos, dimorphos],
    )
    expect(ordered.map((body) => body.address)).toEqual([
      's:X/b:0',
      's:X/b:9.0',
    ])
  })

  it('falls back to its own orbit when the parent is not in either list', () => {
    // Nothing in the survey produces this, and a sort key of `undefined`
    // silently sorts everything to one end.
    const orphan = row({
      address: 's:X/b:9.0',
      depth: 2,
      parent: 's:X/b:9',
      semiMajorAxis: 1190,
    })
    const inner = row({ address: 's:X/b:0', semiMajorAxis: 0.39 * AU })
    expect(orbitalOrder([inner, orphan]).map((body) => body.address)).toEqual([
      's:X/b:9.0',
      's:X/b:0',
    ])
  })

  it('indents a moon under a planet that is on screen', () => {
    const moon = row({ address: 's:X/b:1.0', depth: 2, parent: 's:X/b:1' })
    expect(indentOf(moon, new Set(['s:X/b:1']))).toBe(2)
  })
})

describe('the filter', () => {
  it('treats an empty selection as everything', () => {
    /*
     * A filter whose worst state is an empty list that looks exactly like a
     * failed survey is a control with a trap in it — and the way out is not
     * discoverable from the empty list.
     */
    expect(acceptsRow(row({ address: 'a' }), [])).toBe(true)
    expect(acceptsRow(row({ address: 'a', bodyKind: 'comet' }), [])).toBe(true)
  })

  it('separates the classes that share a chip from the ones that do not', () => {
    const giant = row({ address: 'a', bodyKind: 'gas-giant' })
    const rock = row({ address: 'b', bodyKind: 'rocky' })
    const rubble = row({ address: 'c', bodyKind: 'asteroid' })
    expect(acceptsRow(giant, ['planets'])).toBe(true)
    expect(acceptsRow(rock, ['planets'])).toBe(true)
    expect(acceptsRow(rubble, ['planets'])).toBe(false)
    expect(acceptsRow(rubble, ['asteroids'])).toBe(true)
  })
})

describe('the readings at the end of a row', () => {
  it('measures a system from the eye and a body from its primary', () => {
    expect(
      measureOf(star({ address: 's:PROX', distanceText: '4.244 ly' })),
    ).toBe('4.244 ly')
    expect(measureOf(row({ address: 's:X/b:0', semiMajorAxis: AU }))).toBe(
      '1.00 AU',
    )
  })

  it('reads a moon in kilometers', () => {
    // `formatDistance` renders Luna's 384,400 km as "0.003 AU" — correct, and
    // indistinguishable from every other moon in the system.
    expect(
      measureOf(
        row({ address: 's:X/b:1.0', depth: 2, semiMajorAxis: 3.844e8 }),
      ),
    ).toBe('384,400 km')
  })
})

describe('the neighborhood rail', () => {
  it('places the observer at the left end and the survey edge at the right', () => {
    const placed = neighbours(
      [
        star({ address: 's:SOL', distance: 0 }),
        star({ address: 's:EDGE', distance: 10 * LIGHT_YEAR }),
      ],
      10,
    )
    expect(placed[0]?.at).toBe(0)
    expect(placed[1]?.at).toBe(1)
  })

  it('spreads the near half, which a linear scale does not', () => {
    /*
     * A survey's volume grows as r³, so most of what it finds is near the
     * edge and a linear rail piles the whole neighborhood into the left tenth.
     * At a quarter of the radius, √ puts a star at the halfway mark.
     */
    const [quarter] = neighbours(
      [star({ address: 's:A', distance: 2.5 * LIGHT_YEAR })],
      10,
    )
    expect(quarter?.at).toBeCloseTo(0.5, 6)
  })

  it('drops a loaded system that is outside the survey radius', () => {
    /*
     * The survey always lists a loaded system whatever the sweep — flying out
     * and having the place you came from vanish from the *list* is how you get
     * stranded. The rail is a different claim: a dot's position is a distance,
     * so clamping one to the right-hand end puts a star 40 ly away exactly on
     * the "10 ly" tick, under a caption that then counts it as within 10.
     */
    expect(
      neighbours([star({ address: 's:FAR', distance: 40 * LIGHT_YEAR })], 10),
    ).toHaveLength(0)
  })

  it('draws at most two dozen, so a wide sweep is still a picture', () => {
    // A 50 ly sweep finds around fourteen hundred systems, and fourteen hundred
    // dots in a 20 px band is a solid bar rather than a neighborhood.
    const many = Array.from({ length: 200 }, (_, at) =>
      star({ address: `s:S${at}`, distance: (at / 100) * LIGHT_YEAR }),
    )
    const placed = neighbours(many, 10)
    expect(placed).toHaveLength(24)
    expect(placed[0]?.address).toBe('s:S0')
  })

  it('is nearest first, whatever order the survey gave', () => {
    const placed = neighbours(
      [
        star({ address: 's:B', distance: 8 * LIGHT_YEAR }),
        star({ address: 's:A', distance: 4 * LIGHT_YEAR }),
      ],
      10,
    )
    expect(placed.map((one) => one.address)).toEqual(['s:A', 's:B'])
  })

  it('ignores bodies — a rail of light years is a rail of stars', () => {
    expect(
      neighbours([star({ address: 's:A' }), row({ address: 's:A/b:0' })], 10),
    ).toHaveLength(1)
  })
})
