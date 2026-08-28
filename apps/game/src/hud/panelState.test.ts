import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Lens, LENS_PRESETS } from '@inertialref/rendering'
import {
  FOCUS_MAX,
  isLens,
  LENS_CHANNELS,
  LENS_SLIDER_STEPS,
  reviveLens,
} from './controls.ts'
import { isBoolean, numberWithin, oneOf } from './panelState.ts'

/*
 * What a remembered preference has to prove.
 *
 * `localStorage` outlives the code that wrote it, and the panel's own comment
 * always said so — but the guard was around `JSON.parse`, which is the failure
 * that was never going to happen. The values that survive a rename parse
 * perfectly: a `dock.tab` of `"nav"` from before these five names existed
 * renders an empty dock with no active tab and no way back that is not
 * devtools. These are the predicates that turn that into "the default".
 *
 * The hook itself needs `window.localStorage` and vitest runs in Node with no
 * DOM, so what is tested is the half with the judgement in it — the same split
 * as `probeHealth` and its monitor.
 */

describe('remembered preferences', () => {
  it('accepts only the names the build still has', () => {
    const accept = oneOf(['navigate', 'graphics', 'perf'] as const)
    expect(accept('navigate')).toBe(true)
    // The renamed tab, the tab from a branch, and the shapes a hand-edited
    // storage entry produces.
    expect(accept('nav')).toBe(false)
    expect(accept('')).toBe(false)
    expect(accept(0)).toBe(false)
    expect(accept(null)).toBe(false)
    expect(accept(['navigate'])).toBe(false)
  })

  it('rejects a number outside the range the control offers', () => {
    const accept = numberWithin(20, 110)
    expect(accept(65)).toBe(true)
    expect(accept(20)).toBe(true)
    expect(accept(110)).toBe(true)
    expect(accept(19)).toBe(false)
    expect(accept(5_000)).toBe(false)
    // The three that reach a projection matrix and produce a black frame rather
    // than an error: they are all `typeof value === 'number'`.
    expect(accept(Number.NaN)).toBe(false)
    expect(accept(Number.POSITIVE_INFINITY)).toBe(false)
    expect(accept('65')).toBe(false)
  })

  it('survives its own round trip through JSON', () => {
    /*
     * The stored lens, through the exact path `usePersistentState` takes: the
     * effect writes `JSON.stringify(value)` and the next mount reads it back
     * through `accept` and `revive`.
     *
     * `JSON.stringify(Infinity)` is `null`, and a lens racked to the stop is
     * the lens the camera spends its whole life at — so the default did not
     * survive being stored. Every consumer guards with `Number.isFinite`,
     * which takes the same branch for `null`, so the only visible symptom was
     * an equality against `DEFAULT_LENS` that could never hold and a Reset
     * control enabled forever on a lens that was already the default.
     */
    const stored: unknown = JSON.parse(JSON.stringify(LENS_PRESETS.flight))
    expect((stored as { focus: unknown }).focus).toBeNull()
    expect(isLens(stored)).toBe(true)
    expect(reviveLens(stored as Lens)).toEqual(LENS_PRESETS.flight)
    // And a focus somebody actually set comes back untouched.
    const near = { ...LENS_PRESETS.flight, focus: 4 }
    expect(reviveLens(JSON.parse(JSON.stringify(near)) as Lens)).toEqual(near)
  })

  it('does not take a truthy string for a remembered toggle', () => {
    expect(isBoolean(true)).toBe(true)
    expect(isBoolean(false)).toBe(true)
    // `"true"` and `1` are what a previous shape of this panel wrote, and both
    // are truthy — so an unguarded read turns "off" into "on" exactly once, on
    // the reload after an upgrade.
    expect(isBoolean('true')).toBe(false)
    expect(isBoolean(1)).toBe(false)
    expect(isBoolean(null)).toBe(false)
  })
})

/*
 * The lens sliders, as arithmetic.
 *
 * `LensSlider` says this is the part worth testing and the part a renderer
 * cannot reach: the channels map a lens onto a scrub position and back, and
 * the component only draws the track. Every failure here is silent in a
 * screenshot — a thumb that will not move, or a value that drifts a little on
 * every keypress — so it is a property rather than an example.
 */
describe('the lens channels', () => {
  const CHANNELS = ['focal', 'zoom', 'aperture', 'focus'] as const

  it('round-trips every position the slider can send', () => {
    /*
     * On the grid, because that is the only input the control produces:
     * `LensSlider` sends `n / LENS_SLIDER_STEPS` for an integer `n`, and the
     * value it gets back is what sets the thumb on the next render. A channel
     * that does not round-trip *there* is a thumb that drifts a step under a
     * keypress, or one that will not move at all.
     */
    for (const id of CHANNELS) {
      const channel = LENS_CHANNELS[id]
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: LENS_SLIDER_STEPS }),
          (position) => {
            const held = channel.at(
              LENS_PRESETS.flight,
              position / LENS_SLIDER_STEPS,
            )
            const back = Math.round(channel.scrub(held) * LENS_SLIDER_STEPS)
            expect(back, `${id} at ${position}`).toBe(position)
          },
        ),
      )
    }
  })

  it('moves under every arrow key, including at the ends of the travel', () => {
    /*
     * The defect this exists for: `focus` spends its top position on infinity,
     * which is where the default lens sits. Give the sentinel a *band* of
     * positions instead of one and every arrow key inside it resolves back to
     * infinity, the controlled value snaps the thumb home, and the control
     * cannot be moved at all — from the state it ships in.
     */
    for (const id of CHANNELS) {
      const channel = LENS_CHANNELS[id]
      for (const start of [0, 1]) {
        const at = Math.round(
          channel.scrub(channel.at(LENS_PRESETS.flight, start)) *
            LENS_SLIDER_STEPS,
        )
        const toward = start === 0 ? at + 1 : at - 1
        const stepped = channel.at(
          LENS_PRESETS.flight,
          toward / LENS_SLIDER_STEPS,
        )
        expect(
          Math.round(channel.scrub(stepped) * LENS_SLIDER_STEPS),
          `${id} from ${at}`,
        ).toBe(toward)
      }
    }
  })

  it('keeps infinity to exactly one position of the focus travel', () => {
    const top = LENS_SLIDER_STEPS
    const infinite = LENS_CHANNELS.focus.at(LENS_PRESETS.flight, top / top)
    expect(infinite.focus).toBe(Infinity)
    // And the step below it is the far end of the finite band, not another ∞.
    const finite = LENS_CHANNELS.focus.at(LENS_PRESETS.flight, (top - 1) / top)
    expect(Number.isFinite(finite.focus)).toBe(true)
    expect(finite.focus).toBeCloseTo(FOCUS_MAX, 6)
  })

  it('produces a lens the storage guard believes', () => {
    // The channels write `engine.flightLens` and the same object is what gets
    // persisted, so a channel whose range fell outside `isLens` would be a
    // setting that silently reset on the next reload.
    for (const id of CHANNELS) {
      for (const scrub of [0, 0.25, 0.5, 0.75, 1]) {
        const held = LENS_CHANNELS[id].at(LENS_PRESETS.flight, scrub)
        expect(isLens(held), `${id} at ${scrub}`).toBe(true)
      }
    }
  })
})
