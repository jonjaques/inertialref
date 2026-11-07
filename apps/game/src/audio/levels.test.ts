import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decibelsOf, gainOf, levelOf, readLevel, speakLevel } from './levels.ts'

describe('levels', () => {
  it('round-trips a slider position through its gain', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (level) => {
        expect(levelOf(gainOf(level))).toBeCloseTo(level, 9)
      }),
    )
  })

  it('is monotonic and stays between silence and unity', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 2, noNaN: true }),
        fc.double({ min: -1, max: 2, noNaN: true }),
        (a, b) => {
          const [low, high] = a < b ? [a, b] : [b, a]
          expect(gainOf(low)).toBeLessThanOrEqual(gainOf(high))
          expect(gainOf(low)).toBeGreaterThanOrEqual(0)
          expect(gainOf(high)).toBeLessThanOrEqual(1)
        },
      ),
    )
  })

  it('puts the halfway mark 12 dB down, not 6', () => {
    expect(decibelsOf(0.5)).toBeCloseTo(-12.04, 2)
    expect(decibelsOf(1)).toBe(0)
    expect(decibelsOf(0)).toBe(Number.NEGATIVE_INFINITY)
  })

  it('reads and speaks a level', () => {
    expect(readLevel(0)).toBe('off')
    expect(readLevel(0.7)).toBe('70%')
    expect(speakLevel(0.5)).toBe('50 percent, -12 decibels')
    expect(speakLevel(0)).toBe('off')
  })
})
