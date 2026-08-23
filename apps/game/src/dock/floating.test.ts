import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  cascade,
  clampFloat,
  FLOAT_MARGIN,
  type FloatSize,
  isFloatPositions,
  NO_FLOATS,
  nudgeFloat,
  placeFloat,
  pruneFloats,
} from './floating.ts'

/*
 * Where a floating panel may be, as a property.
 *
 * The claim every function here has to keep is one sentence:
 *
 *   **a floating panel is always somewhere the pointer can reach it.**
 *
 * A panel that is open, listed in the menu as open, and off the side of the
 * frame is the worst state this feature can produce — there is no gesture that
 * reaches it, no taskbar to recover it from, and the menu is actively lying.
 * It is worth a property test rather than examples because the ways in are
 * combinations: a drag near an edge, then a window resize, then a restore on a
 * different display. Those are sequences a hand produces in a minute and a test
 * author does not think to write down.
 */

/** A plausible panel and a plausible window, including degenerate ones. */
const size = fc.record({
  width: fc.integer({ min: 1, max: 2000 }),
  height: fc.integer({ min: 1, max: 2000 }),
})
const point = fc.record({
  x: fc.integer({ min: -5000, max: 5000 }),
  y: fc.integer({ min: -5000, max: 5000 }),
})

/** The invariant, as a function: inside the margin, or pinned to it. */
function expectReachable(
  at: { x: number; y: number },
  panel: FloatSize,
  viewport: FloatSize,
): void {
  expect(at.x).toBeGreaterThanOrEqual(FLOAT_MARGIN)
  expect(at.y).toBeGreaterThanOrEqual(FLOAT_MARGIN)
  // Fully inside when it fits; pinned to the margin when it does not, which is
  // the case a phone in landscape actually produces rather than a hypothetical.
  expect(at.x).toBeLessThanOrEqual(
    Math.max(FLOAT_MARGIN, viewport.width - panel.width - FLOAT_MARGIN),
  )
  expect(at.y).toBeLessThanOrEqual(
    Math.max(FLOAT_MARGIN, viewport.height - panel.height - FLOAT_MARGIN),
  )
}

describe('clamping a floating panel', () => {
  it('never puts one anywhere a pointer cannot reach', () => {
    fc.assert(
      fc.property(point, size, size, (at, panel, viewport) => {
        expectReachable(clampFloat(at, panel, viewport), panel, viewport)
      }),
    )
  })

  it('is a fixpoint, which is what makes it safe to run on every read', () => {
    // `pruneFloats` re-clamps on every render of the workspace. If clamping a
    // clamped point moved it, a panel would creep across the screen while
    // nobody touched it.
    fc.assert(
      fc.property(point, size, size, (at, panel, viewport) => {
        const once = clampFloat(at, panel, viewport)
        expect(clampFloat(once, panel, viewport)).toEqual(once)
      }),
    )
  })

  it('leaves a point that already fits exactly where it was', () => {
    const panel = { width: 300, height: 200 }
    const viewport = { width: 1600, height: 900 }
    expect(clampFloat({ x: 400, y: 300 }, panel, viewport)).toEqual({
      x: 400,
      y: 300,
    })
  })

  it('pins a panel larger than the window to the margin', () => {
    // Not an inverted range: `Math.max` on the upper bound is what stops the
    // clamp producing a *negative* upper bound and pushing the panel off the
    // opposite edge from the one it was too big for.
    const at = clampFloat(
      { x: 900, y: 900 },
      { width: 3000, height: 3000 },
      { width: 800, height: 600 },
    )
    expect(at).toEqual({ x: FLOAT_MARGIN, y: FLOAT_MARGIN })
  })
})

describe('moving one by a drag', () => {
  it('follows the hand, and still lands somewhere reachable', () => {
    fc.assert(
      fc.property(point, point, size, size, (from, delta, panel, viewport) => {
        const next = nudgeFloat(
          NO_FLOATS,
          'catalogue',
          delta,
          clampFloat(from, panel, viewport),
          panel,
          viewport,
        )
        const at = next.catalogue
        expect(at).toBeDefined()
        if (at !== undefined) expectReachable(at, panel, viewport)
      }),
    )
  })

  it('treats an unplaced panel as being where it was drawn', () => {
    // A panel floated for the first time has no stored coordinate — it is
    // rendering at its cascade point. Without the `from` fallback the first
    // drag would be measured from the origin and jump the panel to the corner.
    const panel = { width: 300, height: 200 }
    const viewport = { width: 1600, height: 900 }
    const moved = nudgeFloat(
      NO_FLOATS,
      'object',
      { x: 40, y: 25 },
      { x: 100, y: 100 },
      panel,
      viewport,
    )
    expect(moved.object).toEqual({ x: 140, y: 125 })
  })

  it('moves only the panel that was dragged', () => {
    const panel = { width: 300, height: 200 }
    const viewport = { width: 1600, height: 900 }
    const two = placeFloat(
      placeFloat(NO_FLOATS, 'a', { x: 100, y: 100 }, panel, viewport),
      'b',
      { x: 400, y: 300 },
      panel,
      viewport,
    )
    const moved = nudgeFloat(
      two,
      'a',
      { x: 10, y: 10 },
      { x: 100, y: 100 },
      panel,
      viewport,
    )
    expect(moved.b).toEqual({ x: 400, y: 300 })
  })
})

describe('the cascade', () => {
  it('never puts two consecutive panels in the same place', () => {
    const viewport = { width: 1600, height: 900 }
    const first = cascade(0, viewport)
    const second = cascade(1, viewport)
    // Two panels floated one after the other and drawn at the same point look
    // like one panel, and the top one has to be dragged off the other before
    // either can be read.
    expect(second).not.toEqual(first)
  })

  it('stays reachable even on a window too small to stagger in', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), size, (index, viewport) => {
        expectReachable(
          cascade(index, viewport),
          { width: 320, height: 240 },
          viewport,
        )
      }),
    )
  })
})

describe('reconciling a stored map', () => {
  it('drops coordinates for panels that are no longer floating', () => {
    const panel = { width: 300, height: 200 }
    const viewport = { width: 1600, height: 900 }
    const stored = placeFloat(
      placeFloat(NO_FLOATS, 'stale', { x: 200, y: 200 }, panel, viewport),
      'live',
      { x: 300, y: 300 },
      panel,
      viewport,
    )
    const next = pruneFloats(stored, ['live'], panel, viewport)
    expect(Object.keys(next)).toEqual(['live'])
  })

  it('rescues a panel stored against a larger display', () => {
    /*
     * The failure this exists for, and it is not hypothetical: a position is
     * stored in viewport pixels, so a panel placed near the right edge of a
     * 2560px display and reopened in a 1280px window is off-screen, with the
     * menu still reporting it as open and no gesture that reaches it.
     */
    const panel = { width: 300, height: 200 }
    const stored = placeFloat(NO_FLOATS, 'perf', { x: 2200, y: 1300 }, panel, {
      width: 2560,
      height: 1440,
    })
    const small = { width: 1280, height: 800 }
    const next = pruneFloats(stored, ['perf'], panel, small)
    const at = next.perf
    expect(at).toBeDefined()
    if (at !== undefined) expectReachable(at, panel, small)
  })
})

describe('the stored-value guard', () => {
  it('accepts a position map and refuses everything else', () => {
    expect(isFloatPositions(NO_FLOATS)).toBe(true)
    expect(isFloatPositions({ perf: { x: 10, y: 20 } })).toBe(true)
    expect(isFloatPositions(null)).toBe(false)
    // An array is an object with numeric keys, and `Object.values` of an empty
    // one passes `every` — so a stored `[]` would sail through without this.
    expect(isFloatPositions([])).toBe(false)
    expect(isFloatPositions({ perf: { x: 10 } })).toBe(false)
    expect(isFloatPositions({ perf: { x: 'left', y: 20 } })).toBe(false)
    // `NaN` reaches `left:` in a style attribute and positions nothing.
    expect(isFloatPositions({ perf: { x: Number.NaN, y: 20 } })).toBe(false)
    expect(isFloatPositions({ perf: { x: 10, y: Infinity } })).toBe(false)
  })
})
