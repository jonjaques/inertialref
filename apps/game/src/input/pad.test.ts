import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buttonIndex,
  PAD_BUTTONS,
  PAD_CONTROLS,
  parsePad,
  stickAxis,
} from './pad.ts'
import { padFamily, padLabel, usbIds } from './padFamily.ts'
import {
  DEFAULT_STICK,
  FLICK_PRESS,
  latch,
  PAD_REPEAT,
  repeatsDue,
  shapeStick,
  shapeTrigger,
  TRIGGER_PRESS,
} from './padShape.ts'

/*
 * The pad's arithmetic, before anything binds it.
 *
 * Properties rather than examples for the shaping, because what matters about
 * a deadzone is a claim about every input — rest means rest, direction is
 * kept, the response is continuous — and an example only shows the one point
 * somebody thought to write down.
 */

const axis = fc.double({ min: -1.5, max: 1.5, noNaN: true })
const shape = fc.record({
  deadzone: fc.double({ min: 0, max: 0.5, noNaN: true }),
  outer: fc.double({ min: 0.8, max: 1, noNaN: true }),
  curve: fc.double({ min: 0.5, max: 3, noNaN: true }),
})

describe('shapeStick', () => {
  it('reads every point inside the deadzone as rest', () => {
    fc.assert(
      fc.property(axis, axis, shape, (x, y, s) => {
        fc.pre(Math.hypot(x, y) <= s.deadzone)
        expect(shapeStick(x, y, s)).toEqual({ x: 0, y: 0 })
      }),
    )
  })

  it('never reports more than full throw, even from a corner at length √2', () => {
    fc.assert(
      fc.property(axis, axis, shape, (x, y, s) => {
        const out = shapeStick(x, y, s)
        expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1 + 1e-12)
      }),
    )
  })

  it('keeps the direction it was pushed in — a radial cut, not a cross', () => {
    // A per-axis deadzone fails this near center: a slow diagonal loses
    // whichever component is still inside, and pitch-and-yaw becomes pitch.
    fc.assert(
      fc.property(axis, axis, shape, (x, y, s) => {
        const out = shapeStick(x, y, s)
        fc.pre(Math.hypot(out.x, out.y) > 1e-9)
        const cross = x * out.y - y * out.x
        expect(Math.abs(cross)).toBeLessThan(1e-9)
        expect(x * out.x + y * out.y).toBeGreaterThan(0)
      }),
    )
  })

  it('grows with the push, and reaches full throw at the outer edge', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        shape,
        (a, b, angle, s) => {
          const [near, far] = a < b ? [a, b] : [b, a]
          const at = (r: number) => {
            const out = shapeStick(r * Math.cos(angle), r * Math.sin(angle), s)
            return Math.hypot(out.x, out.y)
          }
          expect(at(near)).toBeLessThanOrEqual(at(far) + 1e-12)
          expect(at(s.outer)).toBeCloseTo(1, 9)
        },
      ),
    )
  })

  it('starts from zero at the deadzone, so the finest turn is not the deadzone itself', () => {
    // The unscaled radial cut's defect: the first value past the edge is the
    // edge, so nothing finer than the deadzone can be asked for.
    const s = DEFAULT_STICK
    const just = shapeStick(s.deadzone + 1e-4, 0, s)
    expect(just.x).toBeGreaterThan(0)
    expect(just.x).toBeLessThan(1e-3)
  })

  it('treats a NaN axis, which a disconnecting pad can report, as rest', () => {
    expect(shapeStick(Number.NaN, 0.9)).toEqual(shapeStick(0, 0.9))
  })
})

describe('shapeTrigger', () => {
  it('is zero at rest, one at the stop, and monotone between', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b) => {
          const [low, high] = a < b ? [a, b] : [b, a]
          expect(shapeTrigger(low)).toBeLessThanOrEqual(shapeTrigger(high))
        },
      ),
    )
    expect(shapeTrigger(0)).toBe(0)
    expect(shapeTrigger(0.03)).toBe(0)
    expect(shapeTrigger(1)).toBe(1)
  })
})

describe('latch', () => {
  it('does not chatter for a value sitting on a threshold', () => {
    // One threshold turns a trigger held at the edge into a press per poll;
    // the gap means a press has to be undone by the finger.
    for (const thresholds of [TRIGGER_PRESS, FLICK_PRESS]) {
      fc.assert(
        fc.property(
          fc.double({
            min: thresholds.release + 1e-6,
            max: thresholds.press - 1e-6,
            noNaN: true,
          }),
          fc.boolean(),
          (value, wasDown) => {
            expect(latch(value, wasDown, thresholds)).toBe(wasDown)
          },
        ),
      )
    }
  })

  it('presses at the press threshold and lets go below the release one', () => {
    expect(latch(TRIGGER_PRESS.press, false, TRIGGER_PRESS)).toBe(true)
    expect(latch(TRIGGER_PRESS.release, true, TRIGGER_PRESS)).toBe(false)
  })
})

describe('repeatsDue', () => {
  it('owes nothing before the delay, and one per interval after it', () => {
    expect(repeatsDue(PAD_REPEAT.delay - 0.01, 0)).toBe(0)
    expect(repeatsDue(PAD_REPEAT.delay, 0)).toBe(1)
    expect(repeatsDue(PAD_REPEAT.delay + PAD_REPEAT.interval * 3, 1)).toBe(3)
  })

  it('pays a late poll every step it owed, and never one twice', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 0.5, noNaN: true }), {
          maxLength: 40,
        }),
        (gaps) => {
          let held = 0
          let fired = 0
          for (const gap of gaps) {
            held += gap
            fired += repeatsDue(held, fired)
          }
          expect(fired).toBe(repeatsDue(held, 0))
        },
      ),
    )
  })
})

describe('the controls', () => {
  it('numbers the buttons in the standard mapping’s order', () => {
    expect(buttonIndex('south')).toBe(0)
    expect(buttonIndex('r2')).toBe(7)
    expect(buttonIndex('start')).toBe(9)
    expect(buttonIndex('up')).toBe(12)
    expect(buttonIndex('touchpad')).toBe(17)
    expect(PAD_BUTTONS).toHaveLength(18)
  })

  it('puts stick up at the negative end of the wire axis', () => {
    expect(stickAxis('ls.up')).toEqual({ side: 'left', axis: 'y', sign: -1 })
    expect(stickAxis('rs.right')).toEqual({ side: 'right', axis: 'x', sign: 1 })
  })

  it('round-trips every bindable control and refuses the system button', () => {
    for (const control of PAD_CONTROLS) {
      expect(parsePad(control)).toBe(control === 'home' ? null : control)
    }
    expect(parsePad('toString')).toBeNull()
    expect(parsePad(7)).toBeNull()
  })
})

describe('padFamily', () => {
  it('reads the USB ids from each engine’s format', () => {
    expect(
      usbIds(
        'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
      ),
    ).toEqual({ vendor: '054c', product: '0ce6' })
    expect(usbIds('54c-ce6-DualSense Wireless Controller')).toEqual({
      vendor: '054c',
      product: '0ce6',
    })
    expect(usbIds('DualSense Wireless Controller')).toBeNull()
  })

  it('names the family from the ids, then from the product name', () => {
    expect(
      padFamily(
        'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
      ),
    ).toBe('dualsense')
    expect(
      padFamily(
        'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
      ),
    ).toBe('dualshock')
    expect(padFamily('045e-0b13-Xbox Wireless Controller')).toBe('xbox')
    expect(padFamily('Pro Controller')).toBe('switch')
    expect(padFamily('DualSense Wireless Controller')).toBe('dualsense')
    expect(padFamily('Some Arcade Stick')).toBe('generic')
  })

  it('prints the glyph the attached pad has in that position', () => {
    // The bottom face button is three different letters across three
    // families, which is the whole reason a binding names the position.
    expect(padLabel('south', 'dualsense')).toBe('✕')
    expect(padLabel('south', 'xbox')).toBe('A')
    expect(padLabel('south', 'switch')).toBe('B')
    expect(padLabel('select', 'dualsense')).toBe('Create')
    expect(padLabel('select', 'dualshock')).toBe('Share')
    expect(padLabel('rs.up', 'xbox')).toBe('RS ↑')
    expect(padLabel('rs.up', 'dualsense')).toBe('R ↑')
  })
})
