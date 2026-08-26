import { describe, expect, it } from 'vitest'
import {
  GROUND_STANCE,
  type Presentation,
  createPresentationStack,
  resolveStances,
} from './presentation.ts'

/*
 * Menu → planetarium → flight → back, in Node, with no React.
 *
 * This is `observatory.test.ts`'s state-hash promise applied to presentation
 * state, which had no such guarantee: the round trip below is exactly the one
 * that was broken, and it was broken in a way nothing could see. Leaving the
 * planetarium after arriving from the menu restored `showShip` to `true` — a
 * value it had never held in that session — because the planetarium restored to
 * a literal instead of to whatever was underneath it.
 */

/** The stack plus a record of what it published, which is what a mode sees. */
function stack() {
  const seen: Presentation[] = []
  return {
    seen,
    presentation: createPresentationStack((one) => seen.push(one)),
  }
}

const MENU = { showShip: false, flareArtifacts: 0.15, observatory: true }
const PLANETARIUM = { showShip: false, showOrbits: true, observatory: true }
const FLIGHT = { showShip: true, showOrbits: false, observatory: false }

describe('the presentation stance', () => {
  it('starts on the ground stance', () => {
    expect(stack().presentation.resolved()).toEqual(GROUND_STANCE)
  })

  it('lands every field where it started after menu → planetarium → flight → back', () => {
    /*
     * THE REGRESSION, as a round trip. Each mode pushes on the way in and
     * releases on the way out; nothing remembers what it displaced, and that is
     * exactly why it comes back.
     */
    const { presentation } = stack()

    const menu = presentation.push(MENU)
    expect(presentation.resolved().showShip).toBe(false)
    expect(presentation.resolved().flareArtifacts).toBe(0.15)

    const planetarium = presentation.push(PLANETARIUM)
    expect(presentation.resolved().showOrbits).toBe(true)
    // The menu is still underneath, so its lens setting still applies — it was
    // never "restored" and never had to be.
    expect(presentation.resolved().flareArtifacts).toBe(0.15)

    planetarium.release()
    // Back to the menu's stance, not to a literal. The old code put `showShip`
    // back to `true` here, over a menu that had deliberately hidden it.
    expect(presentation.resolved()).toEqual({
      ...GROUND_STANCE,
      showShip: false,
      flareArtifacts: 0.15,
      observatory: true,
    })

    const flight = presentation.push(FLIGHT)
    expect(presentation.resolved().showShip).toBe(true)
    expect(presentation.resolved().observatory).toBe(false)

    flight.release()
    menu.release()
    expect(presentation.resolved()).toEqual(GROUND_STANCE)
    expect(presentation.depth()).toBe(0)
  })

  it('lets a panel override its mode without touching it', () => {
    // The case that decided the shape: an override is a push, so it composes
    // for free and needs no channel of its own.
    const { presentation } = stack()
    const mode = presentation.push(PLANETARIUM)
    const override = presentation.push({ showShip: true })

    expect(presentation.resolved().showShip).toBe(true)
    // The mode below is untouched, so its other fields still apply.
    expect(presentation.resolved().showOrbits).toBe(true)

    override.release()
    expect(presentation.resolved().showShip).toBe(false)
    mode.release()
  })

  it('leaves a layer where it is when it changes what it asks for', () => {
    // The planetarium's switches update a held layer. If `update` moved it to
    // the top, flipping a checkbox would silently win over a panel override.
    const { presentation } = stack()
    const mode = presentation.push({ showShip: false, observatory: true })
    const override = presentation.push({ showShip: true })

    mode.update({ showShip: false, showOrbits: true, observatory: true })
    expect(presentation.resolved().showShip).toBe(true)
    expect(presentation.resolved().showOrbits).toBe(true)
    override.release()
    expect(presentation.resolved().showShip).toBe(false)
  })

  it('releases by identity, so an out-of-order unmount takes its own layer', () => {
    /*
     * React does not promise that one component's cleanup runs before the
     * next one's mount — a route change interleaves them, and StrictMode
     * doubles the whole sequence. Popping the top would take somebody else's
     * layer, which is the ordering bug this replaced.
     */
    const { presentation } = stack()
    const first = presentation.push({ showShip: false })
    const second = presentation.push({ showOrbits: true })

    first.release()
    expect(presentation.depth()).toBe(1)
    expect(presentation.resolved()).toEqual({
      ...GROUND_STANCE,
      showOrbits: true,
    })
    second.release()
    expect(presentation.depth()).toBe(0)
  })

  it('is idempotent on release, and inert on update after release', () => {
    const { presentation } = stack()
    const layer = presentation.push({ showShip: false })
    layer.release()
    layer.release()
    layer.update({ showShip: false })
    expect(presentation.depth()).toBe(0)
    expect(presentation.resolved()).toEqual(GROUND_STANCE)
  })

  it('publishes only when the resolved answer actually moves', () => {
    // The engine applies this by writing plain fields the frame loop reads and
    // by clearing the observatory. Republishing an unchanged stance would clear
    // a target that nothing asked to drop.
    const { presentation, seen } = stack()
    const first = presentation.push({ showShip: false })
    expect(seen).toHaveLength(1)

    // A second layer asking for exactly the same thing changes nothing.
    const second = presentation.push({ showShip: false })
    expect(seen).toHaveLength(1)

    second.release()
    expect(seen).toHaveLength(1)
    first.release()
    expect(seen).toHaveLength(2)
    expect(seen.at(-1)).toEqual(GROUND_STANCE)
  })

  it('resolves bottom to top, last writer per field', () => {
    expect(
      resolveStances([
        { showShip: false, flareArtifacts: 0.15 },
        { showOrbits: true },
        { showShip: true },
      ]),
    ).toEqual({
      ...GROUND_STANCE,
      showShip: true,
      showOrbits: true,
      flareArtifacts: 0.15,
    })
  })

  it('carries the orbit scope like any other field', () => {
    // It arrived after the stack existed, which is what the stack is for: a
    // panel's override is a one-field push and `release` puts back the mode's.
    expect(resolveStances([{ orbitScope: 'all' }]).orbitScope).toBe('all')
    expect(
      resolveStances([{ orbitScope: 'all' }, { showShip: true }]).orbitScope,
    ).toBe('all')
    expect(resolveStances([]).orbitScope).toBe('context')
  })

  it('leaves a field alone when no layer claims it', () => {
    // An omitted field is "not my business", which is what makes an override a
    // one-field push rather than a whole stance somebody has to fill in.
    expect(resolveStances([{ showOrbits: true }])).toEqual({
      ...GROUND_STANCE,
      showOrbits: true,
    })
  })
})
