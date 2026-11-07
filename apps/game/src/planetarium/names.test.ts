import { describe, expect, it } from 'vitest'
import type { PickCandidate } from './pick.ts'
import { DENSITY, type NameContext, SPACECRAFT_CAP, skyNames } from './names.ts'

/*
 * Which names the sky carries, without a renderer.
 *
 * Every rule here fails silently on screen: a sky captioned with rubble, a
 * subject with no name, a cluster of stations wearing a planet's slot. So each
 * is one assertion over projected candidates, the same shape `projectScene`
 * hands `SkyLabels`.
 */

const SKY = { width: 4000, height: 1000 }

/** A candidate at `x`, spaced well clear of any other unless a test says so. */
const at = (
  address: string,
  x: number,
  over: Partial<PickCandidate> = {},
): PickCandidate => ({
  address,
  name: address,
  kind: 'rocky',
  craft: null,
  x,
  y: 500,
  radius: 10,
  offscreen: false,
  ...over,
})

/** A station going round `parent`, far from the eye unless `near`. */
const station = (
  address: string,
  x: number,
  parent = 'earth',
  near = false,
): PickCandidate =>
  at(address, x, {
    kind: 'station',
    radius: 2,
    craft: { parent, near, drawn: near },
  })

const CONTEXT: NameContext = {
  density: 'normal',
  minor: false,
  spacecraft: 'nearby',
  subject: null,
  companion: null,
}

const named = (
  candidates: readonly PickCandidate[],
  over: Partial<NameContext> = {},
): readonly string[] =>
  skyNames(candidates, SKY, { ...CONTEXT, ...over }).map((one) => one.address)

describe('the names on the sky', () => {
  it('names a station nearby only for the subject’s own neighborhood', () => {
    const iss = station('iss', 300)
    const moon = at('moon', 800, { kind: 'moon' })
    // Looking at the Moon from far off, the ISS is a sibling and unnamed.
    expect(named([moon, iss], { subject: 'moon' })).toEqual(['moon'])
    // It goes round the subject.
    expect(named([moon, iss], { subject: 'earth' })).toContain('iss')
    // It is the companion the subject is tracked against.
    expect(named([moon, iss], { subject: 'moon', companion: 'iss' })).toContain(
      'iss',
    )
    // The eye is inside 2,000 km of it.
    expect(
      named([moon, station('iss', 300, 'earth', true)], { subject: 'moon' }),
    ).toContain('iss')
  })

  it('names every spacecraft on `all`, and none but the subject on `off`', () => {
    const far = [station('a', 300, 'mars'), station('b', 600, 'mars')]
    expect(named(far, { spacecraft: 'all' })).toEqual(['a', 'b'])
    expect(named(far, { spacecraft: 'off' })).toEqual([])
    expect(named(far, { spacecraft: 'off', subject: 'b' })).toEqual(['b'])
  })

  it('places spacecraft after every natural body, inside a cap of their own', () => {
    // Ten stations and two planets at normal density: both planets, and four
    // stations, whatever order the scene listed them in.
    const crowd = Array.from({ length: 10 }, (_, i) =>
      station(`craft-${i}`, 200 + i * 200),
    )
    const worlds = [at('venus', 2400), at('mars', 2600)]
    const kept = named([...crowd, ...worlds], { spacecraft: 'all' })
    expect(kept.slice(0, 2)).toEqual(['venus', 'mars'])
    expect(kept.filter((one) => one.startsWith('craft-'))).toHaveLength(
      SPACECRAFT_CAP.normal,
    )
    // A station whose name lands on a planet's loses the slot, not the planet.
    expect(
      named([station('iss', 2405), at('venus', 2400)], { spacecraft: 'all' }),
    ).toEqual(['venus'])
  })

  it('spends the cap out of the density budget, never on top of it', () => {
    const worlds = Array.from({ length: 7 }, (_, i) =>
      at(`w${i}`, 200 + i * 200),
    )
    const crowd = Array.from({ length: 5 }, (_, i) =>
      station(`c${i}`, 1800 + i * 200),
    )
    const kept = named([...worlds, ...crowd], {
      density: 'sparse',
      spacecraft: 'all',
    })
    expect(kept).toHaveLength(DENSITY.sparse)
    expect(kept.filter((one) => one.startsWith('c'))).toHaveLength(1)
  })

  it('keeps a spacecraft subject’s name in front of the planet behind it', () => {
    // Looking down on the station, its name and Earth's land on each other;
    // the subject's ring is the one a reader is reading.
    const earth = at('earth', 500, { radius: 400 })
    const iss = station('iss', 505)
    expect(named([earth, iss], { subject: 'iss', spacecraft: 'off' })).toEqual([
      'iss',
    ])
  })

  it('leaves the rubble out unless it is the subject, and keeps the dwarfs', () => {
    const bennu = at('bennu', 300, { kind: 'asteroid' })
    const pluto = at('pluto', 600, { kind: 'dwarf' })
    expect(named([bennu, pluto])).toEqual(['pluto'])
    expect(named([bennu, pluto], { subject: 'bennu' })).toEqual([
      'bennu',
      'pluto',
    ])
    expect(named([bennu, pluto], { minor: true })).toEqual(['bennu', 'pluto'])
  })

  it('names nothing off the screen, behind the eye, or without a name', () => {
    expect(
      named([
        at('behind', 300, { offscreen: true }),
        at('left', -5),
        at('nameless', 600, { name: '' }),
      ]),
    ).toEqual([])
  })
})
