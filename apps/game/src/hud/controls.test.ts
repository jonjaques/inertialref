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

/*
 * The lens, as the shell's own arithmetic.
 *
 * The guard vocabulary and the registry that spends it are
 * `state/preferences.test.ts`; what is here is the four channels and the two
 * functions that make a stored lens survive its own round trip. The split is
 * by what the thing under test is about rather than by which file it sits in.
 */

/*
 * The lens sliders, as arithmetic.
 *
 * `LensSlider` says this is the part worth testing and the part a renderer
 * cannot reach: the channels map a lens onto a scrub position and back, and
 * the component only draws the track. Every failure here is silent in a
 * screenshot — a thumb that will not move, or a value that drifts a little on
 * every keypress — so it is a property rather than an example.
 */
describe('a stored lens', () => {
  it('survives its own round trip through JSON', () => {
    /*
     * Through the exact path `usePersistentState` takes: the effect writes
     * `JSON.stringify(value)` and the next mount reads it back through `accept`
     * and `revive`.
     *
     * `JSON.stringify(Infinity)` is `null`, and a lens racked to the stop is
     * the lens the camera spends its whole life at — so the default does not
     * survive being stored without this. Every consumer guards with
     * `Number.isFinite`, which takes the same branch for `null`, so the only
     * visible symptom is an equality against the default that can never hold
     * and a Reset control enabled forever on a lens that is already the default.
     */
    const stored: unknown = JSON.parse(JSON.stringify(LENS_PRESETS.flight))
    expect((stored as { focus: unknown }).focus).toBeNull()
    expect(isLens(stored)).toBe(true)
    expect(reviveLens(stored as Lens)).toEqual(LENS_PRESETS.flight)
    // And a focus somebody actually set comes back untouched.
    const near = { ...LENS_PRESETS.flight, focus: 4 }
    expect(reviveLens(JSON.parse(JSON.stringify(near)) as Lens)).toEqual(near)
  })
})

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
    // The channels write the `camera.lens` preference, and the same object is
    // what `state/engineKnobs.ts` carries to `engine.flightLens`, so a channel
    // whose range fell outside `isLens` would be a setting that silently reset
    // on the next reload.
    for (const id of CHANNELS) {
      for (const scrub of [0, 0.25, 0.5, 0.75, 1]) {
        const held = LENS_CHANNELS[id].at(LENS_PRESETS.flight, scrub)
        expect(isLens(held), `${id} at ${scrub}`).toBe(true)
      }
    }
  })
})
