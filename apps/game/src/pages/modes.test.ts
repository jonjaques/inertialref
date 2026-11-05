import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEATURES } from '@inertialref/protocol'
import { doors, isEnterable, MODES } from './modes.ts'
import { PLAY_MULTIPLAYER, PLAY_SOLO } from './paths.ts'

const mode = (to: string) => MODES.find((card) => card.to === to)!
const offered = (grants: Parameters<typeof doors>[0]) =>
  doors(grants).enterable.map((card) => card.to)

/*
 * `import.meta.env.DEV` is what a production bundle folds to false, so the
 * shipped menu is this predicate with the stub in place.
 */
describe('the menu in a production build', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('holds solo out from an account with no grant', () => {
    vi.stubEnv('DEV', false)
    expect(offered([])).not.toContain(PLAY_SOLO)
    expect(doors([]).withheld.map((card) => card.to)).toContain(PLAY_SOLO)
  })

  it('offers solo to an account granted it', () => {
    vi.stubEnv('DEV', false)
    expect(offered(['solo'])).toContain(PLAY_SOLO)
    expect(doors(['solo']).withheld.map((card) => card.to)).not.toContain(
      PLAY_SOLO,
    )
    // The tour grant is the guide's, and opens no mode.
    expect(offered(['tour'])).not.toContain(PLAY_SOLO)
  })

  it('opens nothing that is not built, whatever the grant', () => {
    vi.stubEnv('DEV', false)
    // What an admin is granted: every feature.
    expect(isEnterable(mode(PLAY_MULTIPLAYER), FEATURES)).toBe(false)
    for (const card of MODES)
      if (card.status === 'designed' || card.status === 'deferred')
        expect(isEnterable(card, FEATURES)).toBe(false)
  })

  it('offers multiplayer to its grant the moment it is built', () => {
    vi.stubEnv('DEV', false)
    const built = { ...mode(PLAY_MULTIPLAYER), status: 'built' as const }
    expect(isEnterable(built, [])).toBe(false)
    expect(isEnterable(built, ['multiplayer'])).toBe(true)
  })
})

describe('the menu in a development build', () => {
  it('offers every built mode with no grant at all', () => {
    expect(import.meta.env.DEV).toBe(true)
    expect(offered([])).toContain(PLAY_SOLO)
  })

  it('puts every mode in exactly one list', () => {
    for (const grants of [[], ['solo'] as const, FEATURES]) {
      const { enterable, withheld } = doors(grants)
      expect([...enterable, ...withheld].map((card) => card.to).sort()).toEqual(
        MODES.map((card) => card.to).sort(),
      )
    }
  })
})
