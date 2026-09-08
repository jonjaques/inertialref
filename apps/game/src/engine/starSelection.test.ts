import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import { selectStars, type StarCandidate } from './starSelection.ts'

/*
 * The union of three selections that do not know about each other.
 *
 * Properties rather than examples, because the two claims — one record per
 * id, and the brightest kept when the buffer is full — are claims about every
 * input, and the inputs that break a union are the ones nobody writes down:
 * the same id in two lists, a tie in flux, a selection that arrives in a
 * different order than last time.
 */

const centre = UV.fromMeters(0, 0, 0)

/** A star within a few hundred light-years, with an id from a small alphabet. */
const candidate = fc
  .record<StarCandidate>({
    // Ninety ids for up to a few hundred stars: collisions are the point.
    id: fc.integer({ min: 0, max: 89 }).map((n) => `S${n}`),
    name: fc.constant(''),
    position: fc
      .tuple(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
      )
      .map(([x, y, z]) =>
        UV.fromMeters(x * LIGHT_YEAR, y * LIGHT_YEAR, z * LIGHT_YEAR),
      ),
    colour: fc.tuple(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
    ),
    solarLuminosities: fc.double({ min: 1e-3, max: 1e5, noNaN: true }),
  })
  .map((star) => ({ ...star, name: star.id }))

const selections = fc.array(fc.array(candidate, { maxLength: 60 }), {
  minLength: 1,
  maxLength: 4,
})

const flux = (star: StarCandidate): number => {
  const metres = Math.max(UV.distance(star.position, centre), 1)
  return star.solarLuminosities / (metres * metres)
}

/** The first record per id, in order — what the union owes before the ceiling. */
const firstPerId = (
  lists: readonly (readonly StarCandidate[])[],
): StarCandidate[] => {
  const seen = new Set<string>()
  const out: StarCandidate[] = []
  for (const list of lists)
    for (const star of list) {
      if (seen.has(star.id)) continue
      seen.add(star.id)
      out.push(star)
    }
  return out
}

describe('selecting the drawn stars', () => {
  it('ranks V light and lowers the diffuse partition limit when catalog stars fill the buffer', () => {
    const make = (id: string, visualLuminosities: number): StarCandidate => ({
      id,
      name: id,
      position: UV.fromMeters(100 * LIGHT_YEAR, 0, 0),
      colour: [1, 1, 1],
      solarLuminosities: 100 - visualLuminosities,
      visualLuminosities,
      catalogued: id === 'known',
    })
    const stars = [make('faint', 1), make('bright', 10), make('known', 100)]
    const result = selectStars(centre, [stars], 2, {
      origin: centre,
      apparentMagnitudeLimit: 10,
      levelMask: 511,
    })
    expect(result.ids).toEqual(['known', 'bright'])
    expect(result.catalogued).toEqual([true, false])
    expect(result.visualLuminosities).toEqual([100, 10])
    expect(result.resolved!.apparentMagnitudeLimit).toBeLessThan(10)
    const repeated = selectStars(
      centre,
      [[...stars].reverse()],
      2,
      result.resolved,
    )
    expect(new Set(repeated.ids)).toEqual(new Set(result.ids))
  })
  it('says each id once, in the order the selections are trusted', () => {
    fc.assert(
      fc.property(selections, (lists) => {
        const field = selectStars(centre, lists, 10_000)
        const expected = firstPerId(lists)
        expect(field.positions.length).toBe(expected.length)
        // The earlier selection's record wins: same name, same light.
        expect(field.names).toEqual(expected.map((s) => s.name))
        expect(field.luminosities).toEqual(
          expected.map((s) => s.solarLuminosities),
        )
      }),
    )
  })

  it('keeps the brightest from here when the ceiling binds', () => {
    fc.assert(
      fc.property(
        selections,
        fc.integer({ min: 1, max: 40 }),
        (lists, ceiling) => {
          const field = selectStars(centre, lists, ceiling)
          const union = firstPerId(lists)
          expect(field.positions.length).toBe(Math.min(ceiling, union.length))
          if (union.length <= ceiling) return
          // Every star kept is at least as bright as every star dropped.
          const kept = new Set(field.names)
          const keptFlux = union.filter((s) => kept.has(s.name)).map(flux)
          const droppedFlux = union.filter((s) => !kept.has(s.name)).map(flux)
          expect(Math.min(...keptFlux)).toBeGreaterThanOrEqual(
            Math.max(...droppedFlux),
          )
        },
      ),
    )
  })

  it('picks the same stars whatever order they arrive in', () => {
    // Ids are unique here so the choice is about brightness alone: with a
    // duplicate, the trusted order is meant to matter.
    const unique = fc
      .array(candidate, { minLength: 1, maxLength: 80 })
      .map((stars) => stars.map((s, i) => ({ ...s, id: `U${i}` })))
    fc.assert(
      fc.property(unique, fc.integer({ min: 1, max: 30 }), (stars, ceiling) => {
        const forward = selectStars(centre, [stars], ceiling)
        const backward = selectStars(centre, [[...stars].reverse()], ceiling)
        const split = selectStars(
          centre,
          [stars.slice(0, stars.length >> 1), stars.slice(stars.length >> 1)],
          ceiling,
        )
        const names = (field: { names: readonly string[] }) =>
          [...field.names].sort()
        expect(names(backward)).toEqual(names(forward))
        expect(names(split)).toEqual(names(forward))
      }),
    )
  })

  it('draws the sky beside the survey, and a star in both once', () => {
    const sirius: StarCandidate = {
      id: 'HIP32349',
      name: 'Sirius',
      position: UV.fromMeters(8.6 * LIGHT_YEAR, 0, 0),
      colour: [0.8, 0.9, 1],
      solarLuminosities: 25,
    }
    const betelgeuse: StarCandidate = {
      id: 'HIP27989',
      name: 'Betelgeuse',
      position: UV.fromMeters(0, 498 * LIGHT_YEAR, 0),
      colour: [1, 0.6, 0.3],
      solarLuminosities: 31_700,
    }
    const field = selectStars(centre, [[sirius], [], [sirius, betelgeuse]])
    expect(field.names).toEqual(['Sirius', 'Betelgeuse'])
    expect(field.luminosities).toEqual([25, 31_700])
  })
})
