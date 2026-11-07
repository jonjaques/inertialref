import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { moveTrack } from './playlist.ts'
import { landing, shiftOf } from './reorder.ts'

const ids = (n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `t${i}`)

describe('the drawn drag', () => {
  /*
   * The property the editor rests on: what a drag draws without reordering
   * anything — each row at its own slot plus its shift — is the order the
   * drop commits. If the two disagreed, a row would jump on release.
   */
  it('draws every other row where the drop will put it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 20, max: 80 }),
        (n, pickFrom, pickOver, height) => {
          const list = ids(n)
          const from = pickFrom % n
          const over = pickOver % n
          const committed = moveTrack(list, from, over)
          list.forEach((id, index) => {
            if (index === from) return
            const drawn = index * height + shiftOf(index, from, over, height)
            expect(drawn).toBe(committed.indexOf(id) * height)
          })
        },
      ),
    )
  })

  it('lands where the pointer is, counting only the other rows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.nat(),
        fc.integer({ min: -100, max: 3000 }),
        (n, pickFrom, y) => {
          const height = 44
          const mids = Array.from(
            { length: n },
            (_, i) => i * height + height / 2,
          )
          const from = pickFrom % n
          const over = landing(mids, from, y)
          expect(over).toBeGreaterThanOrEqual(0)
          expect(over).toBeLessThanOrEqual(n - 1)
          // Held over its own slot, a row stays where it is.
          expect(landing(mids, from, mids[from]!)).toBe(from)
        },
      ),
    )
  })

  it('moves a row three slots down when the pointer passes three midpoints', () => {
    const mids = [22, 66, 110, 154, 198, 242]
    expect(landing(mids, 0, 22 + 3 * 44 + 6)).toBe(3)
    expect(landing(mids, 5, 242 - 3 * 44 - 6)).toBe(2)
  })
})
