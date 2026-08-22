import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  centroid,
  DELTA_LINE,
  DELTA_PAGE,
  DELTA_PIXEL,
  delta,
  keyAction,
  pinchFactor,
  spread,
  wheelNotches,
} from './gestures.ts'
import { declutter, pick, PICK_SLOP, type PickCandidate } from './pick.ts'

/*
 * The two halves of the planetarium that are not the camera: what an input
 * event meant, and what a click was aimed at. Both are decisions rather than
 * geometry, and both have a version that works on the machine it was written on
 * — which is why they are here rather than in a component.
 */

const candidate = (
  over: Partial<PickCandidate> & Pick<PickCandidate, 'address'>,
): PickCandidate => ({
  name: over.address,
  x: 0,
  y: 0,
  radius: 0,
  offscreen: false,
  ...over,
})

describe('the wheel', () => {
  it('reads the same physical scroll the same way in every browser', () => {
    /*
     * The bug this exists for: Chrome reports ~100 px per detent, Firefox
     * reports 3 lines, and a handler that trusts `deltaY` zooms about thirty
     * times faster on one than the other. Both of these are one notch.
     */
    expect(wheelNotches(100, DELTA_PIXEL)).toBeCloseTo(1, 6)
    expect(wheelNotches(6.25, DELTA_LINE)).toBeCloseTo(1, 6)
  })

  it('lets a trackpad deliver a fraction of a notch', () => {
    // Continuous scroll is the normal case on a laptop, and it has to work:
    // ten small notches and one large one land in the same place, because the
    // zoom underneath is multiplicative.
    const small = wheelNotches(10, DELTA_PIXEL)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(0.2)
  })

  it('keeps the sign the DOM gives it', () => {
    expect(wheelNotches(-100)).toBeLessThan(0)
    expect(wheelNotches(100)).toBeGreaterThan(0)
  })

  it('bounds a flick so one event cannot cross the whole range', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.constantFrom(DELTA_PIXEL, DELTA_LINE, DELTA_PAGE),
        (deltaY, mode) => {
          expect(Math.abs(wheelNotches(deltaY, mode))).toBeLessThanOrEqual(4)
        },
      ),
    )
  })

  it('ignores a non-finite delta rather than producing one', () => {
    expect(wheelNotches(Number.NaN)).toBe(0)
    expect(wheelNotches(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('pinch', () => {
  it('measures spread from the centroid, so a third finger is not a jump', () => {
    /*
     * The version everybody writes first takes the distance between touches 0
     * and 1. With two fingers the two agree up to a factor; with three they do
     * not, and the pair version leaps the instant a finger lands or lifts. Here
     * the same hand opening by the same amount gives the same ratio either way.
     */
    const two = [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]
    const twoWider = [
      { x: 50, y: 100 },
      { x: 250, y: 100 },
    ]
    expect(pinchFactor(spread(two), spread(twoWider))).toBeCloseTo(0.5, 6)

    const three = [...two, { x: 150, y: 180 }]
    const threeWider = three.map((point) => ({
      x: 150 + (point.x - 150) * 2,
      y: 120 + (point.y - 120) * 2,
    }))
    expect(pinchFactor(spread(three), spread(threeWider))).toBeCloseTo(0.5, 6)
  })

  it('does nothing on the first frame of a gesture', () => {
    // No previous measurement means no ratio. The version that treats a missing
    // one as zero divides by it.
    expect(pinchFactor(0, 120)).toBe(1)
    expect(pinchFactor(120, 0)).toBe(1)
    expect(spread([{ x: 10, y: 10 }])).toBe(0)
    expect(spread([])).toBe(0)
  })

  it('is bounded, and never zero or negative', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 4000, noNaN: true }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        (previous, current) => {
          const factor = pinchFactor(previous, current)
          expect(factor).toBeGreaterThanOrEqual(0.5)
          expect(factor).toBeLessThanOrEqual(2)
        },
      ),
    )
  })

  it('finds the centroid of any number of touches', () => {
    expect(
      centroid([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ]),
    ).toEqual({ x: 5, y: 10 })
    expect(centroid([])).toBeNull()
  })
})

describe('drag', () => {
  it('contributes nothing when there is no previous sample', () => {
    // The first move of a gesture, and the move after a finger count changed.
    // Treating a missing sample as the origin swings the camera by the
    // pointer's absolute screen position — a full turn, from one frame.
    expect(delta(null, { x: 900, y: 400 })).toEqual({ x: 0, y: 0 })
    expect(delta({ x: 900, y: 400 }, null)).toEqual({ x: 0, y: 0 })
    expect(delta({ x: 10, y: 10 }, { x: 14, y: 7 })).toEqual({ x: 4, y: -3 })
  })
})

describe('the keyboard', () => {
  it('orbits, zooms, frames and resets', () => {
    expect(keyAction({ key: 'ArrowLeft' })?.kind).toBe('orbit')
    expect(keyAction({ key: '=' })?.kind).toBe('zoom')
    expect(keyAction({ key: 'f' })?.kind).toBe('frame')
    expect(keyAction({ key: 'Home' })?.kind).toBe('reset')
    expect(keyAction({ key: 'q' })).toBeNull()
  })

  it('zooms in on plus and out on minus', () => {
    // Sign errors here are invisible in review and immediately obvious in use.
    const inward = keyAction({ key: '+' })
    const outward = keyAction({ key: '-' })
    expect(inward?.kind === 'zoom' && inward.notches).toBeLessThan(0)
    expect(outward?.kind === 'zoom' && outward.notches).toBeGreaterThan(0)
  })

  it('treats shift as a magnitude, not a different action', () => {
    const slow = keyAction({ key: 'ArrowRight' })
    const fast = keyAction({ key: 'ArrowRight', shiftKey: true })
    expect(slow?.kind).toBe(fast?.kind)
    expect(fast?.kind === 'orbit' && fast.dx).toBeGreaterThan(
      slow?.kind === 'orbit' ? slow.dx : 0,
    )
  })

  it('leaves the platform its own shortcuts', () => {
    // Cmd-left is the back gesture and Ctrl-plus is the page zoom. Swallowing
    // either to pan a camera is breaking the browser to move a planet.
    expect(keyAction({ key: 'ArrowLeft', metaKey: true })).toBeNull()
    expect(keyAction({ key: '=', ctrlKey: true })).toBeNull()
    expect(keyAction({ key: 'ArrowUp', altKey: true })).toBeNull()
  })
})

describe('picking', () => {
  it('prefers what the pointer is inside, largest first', () => {
    /*
     * The rule that makes clicking a planet work at all. A distant point source
     * three pixels from the cursor is the nearest thing to it and is never what
     * was meant when a disc fills a third of the frame behind it.
     */
    const planet = candidate({
      address: 'b:5',
      x: 400,
      y: 300,
      radius: 180,
    })
    const speck = candidate({ address: 'b:1', x: 403, y: 302, radius: 0 })
    expect(pick([speck, planet], { x: 402, y: 301 })?.address).toBe('b:5')
  })

  it('picks a moon in front of the planet it is against', () => {
    // The other half of the same rule: a pointer inside both takes the larger,
    // so a moon has to be picked by being *nearer*, not by being on top. It is
    // outside the moon's few pixels but well inside its slop.
    const planet = candidate({ address: 'b:5', x: 400, y: 300, radius: 300 })
    const moon = candidate({ address: 'b:5.1', x: 470, y: 260, radius: 4 })
    expect(pick([planet, moon], { x: 471, y: 261 })?.address).toBe('b:5')
    // ...which is why a moon drawn *over* its planet is picked by clicking it
    // exactly, and the panel's list is the way to reach one that is not.
    expect(pick([moon], { x: 471, y: 261 })?.address).toBe('b:5.1')
  })

  it('reaches something a few pixels across', () => {
    // Most of what is worth clicking in a planetarium is a handful of pixels.
    // A hit test against the true radius makes Mercury unclickable.
    const mercury = candidate({ address: 'b:0', x: 500, y: 500, radius: 1 })
    expect(pick([mercury], { x: 500 + PICK_SLOP - 2, y: 500 })).not.toBeNull()
    expect(pick([mercury], { x: 500 + PICK_SLOP + 8, y: 500 })).toBeNull()
  })

  it('never picks something behind the camera', () => {
    // A point behind the eye projects to a screen position that is a perfectly
    // plausible number, and clicking empty sky would select a planet on the
    // other side of the sun.
    const behind = candidate({
      address: 'b:2',
      x: 500,
      y: 500,
      radius: 400,
      offscreen: true,
    })
    expect(pick([behind], { x: 500, y: 500 })).toBeNull()
  })

  it('returns null rather than a fallback when nothing is near', () => {
    expect(pick([], { x: 0, y: 0 })).toBeNull()
  })
})

describe('label decluttering', () => {
  const spacing = { x: 90, y: 16 }

  it('keeps the first of an overlapping pair', () => {
    // Greedy in the caller's order, so the caller's ordering is the priority.
    const kept = declutter(
      [
        { x: 100, y: 100, id: 'bright' },
        { x: 120, y: 104, id: 'faint' },
        { x: 400, y: 100, id: 'clear' },
      ],
      spacing,
      10,
    )
    expect(kept.map((label) => label.id)).toEqual(['bright', 'clear'])
  })

  it('respects the cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      x: i * 200,
      y: 100,
    }))
    expect(declutter(many, spacing, 24)).toHaveLength(24)
  })

  it('is stable: the same input gives the same set', () => {
    // Greedy rather than optimal precisely for this. An optimal packing changes
    // discontinuously as the camera moves, so labels flicker in and out; a
    // stable imperfect set is far easier to read.
    const labels = Array.from({ length: 40 }, (_, i) => ({
      x: (i * 37) % 800,
      y: (i * 53) % 600,
    }))
    expect(declutter(labels, spacing, 20)).toEqual(
      declutter(labels, spacing, 20),
    )
  })
})
