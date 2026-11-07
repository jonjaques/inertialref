import { describe, expect, it } from 'vitest'
import { ACTIONS } from '../input/keymap.ts'
import {
  defaultChord,
  defaultPad,
  keyChanged,
  padChanged,
} from './settingsDefaults.ts'

/*
 * What counts as a change on the binding pages.
 *
 * The marks in the gutter and the count on the tab are claims about what a
 * restore would undo, so they are by value: an override naming the act's own
 * default is no change at all, and counting it marked a row whose key had been
 * "rebound" to the key it already had.
 */
describe('a binding that differs from its default', () => {
  const bound = ACTIONS.find((one) => one.chord !== null && one.pad !== null)!
  const keyless = ACTIONS.find((one) => one.chord === null)!

  it('is not a change when it names the default', () => {
    expect(keyChanged(bound.id, defaultChord(bound.id))).toBe(false)
    expect(padChanged(bound.id, defaultPad(bound.id))).toBe(false)
  })

  it('is not a change when there is no override at all', () => {
    expect(keyChanged(bound.id, undefined)).toBe(false)
    expect(padChanged(bound.id, undefined)).toBe(false)
  })

  it('is a change when it names another key, or deliberately none', () => {
    const other = defaultChord(bound.id) === 'KeyQ' ? 'KeyJ' : 'KeyQ'
    expect(keyChanged(bound.id, other)).toBe(true)
    expect(keyChanged(bound.id, null)).toBe(true)
    expect(padChanged(bound.id, null)).toBe(true)
  })

  it('treats "nothing" as no change for an act that ships with nothing', () => {
    // The editors store no `null` for these — unbinding them is the default —
    // but a file imported from elsewhere may, and it must not read as a change.
    expect(keyChanged(keyless.id, null)).toBe(false)
  })
})
