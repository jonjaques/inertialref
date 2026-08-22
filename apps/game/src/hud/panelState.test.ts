import { describe, expect, it } from 'vitest'
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
