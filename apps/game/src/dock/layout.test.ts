import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type DockLayout,
  type DockZone,
  DOCK_ZONES,
  defaultLayout,
  dropIndex,
  EMPTY_LAYOUT,
  hidePanel,
  insertionIndex,
  isDockLayout,
  movePanel,
  normalizeLayout,
  showPanel,
  togglePanel,
  zoneOf,
} from './layout.ts'

/*
 * The dock's invariant, stated once and then asserted against everything that
 * can touch a layout:
 *
 *   every known panel is in exactly one zone, exactly once.
 *
 * It is worth a property test rather than examples because the ways to break it
 * are combinations — move a panel to the zone it is already in, at an index
 * past the end, twice — and those are precisely the sequences a hand produces
 * during a real drag and a test author does not think to write down.
 */

const PANELS = [
  { id: 'catalogue', zone: 'left' as DockZone },
  { id: 'object', zone: 'right' as DockZone },
  { id: 'view', zone: 'right' as DockZone },
  { id: 'time', zone: 'left' as DockZone },
  { id: 'presets', zone: 'float' as DockZone },
]

const IDS = PANELS.map((panel) => panel.id)

/** Every panel, once, somewhere. The invariant as a function. */
function census(layout: DockLayout): string[] {
  return DOCK_ZONES.flatMap((zone) => [...layout[zone]]).sort()
}

const expectIntact = (layout: DockLayout): void => {
  expect(census(layout)).toEqual([...IDS].sort())
}

const anyMove = fc.record({
  panel: fc.constantFrom(...IDS),
  zone: fc.constantFrom(...DOCK_ZONES),
  index: fc.integer({ min: -3, max: 8 }),
})

describe('the layout invariant', () => {
  it('survives any sequence of moves', () => {
    fc.assert(
      fc.property(fc.array(anyMove, { maxLength: 40 }), (moves) => {
        let layout = defaultLayout(PANELS)
        for (const move of moves) {
          layout = movePanel(layout, move.panel, move.zone, move.index)
          expectIntact(layout)
        }
      }),
    )
  })

  it('survives hide, show and toggle in any order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            panel: fc.constantFrom(...IDS),
            verb: fc.constantFrom('hide', 'show', 'toggle'),
            zone: fc.constantFrom('left', 'right', 'float'),
          }),
          { maxLength: 40 },
        ),
        (steps) => {
          let layout = defaultLayout(PANELS)
          for (const step of steps) {
            const zone = step.zone as DockZone
            layout =
              step.verb === 'hide'
                ? hidePanel(layout, step.panel)
                : step.verb === 'show'
                  ? showPanel(layout, step.panel, zone)
                  : togglePanel(layout, step.panel, zone)
            expectIntact(layout)
          }
        },
      ),
    )
  })
})

describe('moving a panel', () => {
  it('puts it where it was asked for', () => {
    const layout = movePanel(defaultLayout(PANELS), 'catalogue', 'right', 0)
    expect(layout.right[0]).toBe('catalogue')
    expect(layout.left).not.toContain('catalogue')
  })

  it('means "one further down" inside its own zone', () => {
    /*
     * The reason `movePanel` removes before it inserts. Within one zone the
     * index is read against the list *without* the panel in it, so dropping
     * `view` at index 1 of a two-panel zone it already leads means "second",
     * not "back where you were" — which is what inserting into the original
     * array produces, and it reads as the drag having been ignored.
     */
    const start = movePanel(EMPTY_LAYOUT, 'object', 'right', 0)
    const two = movePanel(start, 'view', 'right', 1)
    expect(two.right).toEqual(['object', 'view'])
    expect(movePanel(two, 'object', 'right', 1).right).toEqual([
      'view',
      'object',
    ])
  })

  it('clamps an index rather than tearing a hole in the array', () => {
    // A drop index is a pointer position turned into a number, and a pointer
    // can be anywhere. `splice` past the end is harmless; `splice` at −4 is not.
    const layout = defaultLayout(PANELS)
    expect(movePanel(layout, 'time', 'left', 99).left.at(-1)).toBe('time')
    expect(movePanel(layout, 'time', 'left', -99).left[0]).toBe('time')
  })

  it('is stable when nothing actually moves', () => {
    const layout = defaultLayout(PANELS)
    const zone = zoneOf(layout, 'object') as DockZone
    const index = layout[zone].indexOf('object')
    expect(movePanel(layout, 'object', zone, index)).toEqual(layout)
  })
})

describe('a drop, against the panels that were on screen', () => {
  /*
   * The seam between the two lists. `insertionIndex` measures against the DOM,
   * which still holds the dragged panel at 40% opacity so the stack does not
   * reflow mid-gesture; `movePanel` reads its index against the list with the
   * panel already removed. Getting the translation wrong is invisible in review
   * and reads, in the hand, as the dock ignoring where you aimed.
   */
  const four: DockLayout = { ...EMPTY_LAYOUT, right: ['a', 'b', 'c', 'd'] }
  const drop = (panel: string, zone: DockZone, index: number): DockLayout =>
    movePanel(four, panel, zone, dropIndex(four, panel, zone, index))

  it('lands the panel where the indicator was drawn', () => {
    // Grab `a`, hover between `b` and `c`: the line is drawn at index 2 of the
    // four on screen, and `a` belongs between them. Splicing at 2 of the three
    // that remain put it after `c`.
    expect(drop('a', 'right', 2).right).toEqual(['b', 'a', 'c', 'd'])
    // Upward was always right: removing an element after the insertion point
    // does not shift it.
    expect(drop('c', 'right', 1).right).toEqual(['a', 'c', 'b', 'd'])
    // A different zone measures a list that never contained the panel.
    expect(drop('a', 'left', 0).left).toEqual(['a'])
  })

  it('is the identity for a drop on the panel’s own line', () => {
    // The two lines either side of a panel both mean "leave it alone", and a
    // gesture that ends where it started must not renumber the stack.
    expect(drop('b', 'right', 1).right).toEqual(['a', 'b', 'c', 'd'])
    expect(drop('b', 'right', 2).right).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts every panel where the line was, from any zone and any slot', () => {
    /*
     * The property: after the drop, the panel is at the position the indicator
     * displayed — which is the index it was given, counted among the panels
     * that were on screen, minus the ones the dragged panel itself was ahead
     * of. Stated against the *rendered* list rather than against `movePanel`,
     * so it is a claim about what the user saw.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...IDS),
        fc.constantFrom('left', 'right', 'float'),
        fc.array(anyMove, { maxLength: 12 }),
        fc.integer({ min: 0, max: 6 }),
        (panel, zone, moves, index) => {
          let layout = defaultLayout(PANELS)
          for (const move of moves)
            layout = movePanel(layout, move.panel, move.zone, move.index)

          const to = zone as DockZone
          // What the zone showed while the drag was in flight, dragged panel
          // included — the list `indexAt` measured and the DropLine was drawn
          // against.
          const onScreen = [...layout[to]]
          const at = Math.min(index, onScreen.length)

          const next = movePanel(
            layout,
            panel,
            to,
            dropIndex(layout, panel, to, at),
          )
          expectIntact(next)

          /*
           * Where the line was, derived from what it *meant* rather than from
           * the arithmetic under test: the indicator is drawn immediately
           * before `onScreen[at]`, so the panel belongs immediately before the
           * first panel at or after that slot which is not itself. Counting
           * from the far end is what keeps this independent — restating
           * `dropIndex`'s ±1 here would be a test of nothing.
           */
          const others = onScreen.filter((id) => id !== panel)
          const below = onScreen.slice(at).filter((id) => id !== panel)
          expect(next[to].indexOf(panel)).toBe(others.length - below.length)
          // ...and everything else kept its order.
          expect(next[to].filter((id) => id !== panel)).toEqual(others)
        },
      ),
    )
  })
})

describe('normalising a stored layout', () => {
  it('drops a panel this build no longer has', () => {
    // The `localStorage` outlives the code problem, in its layout form: a
    // renamed panel leaves a dead string holding a slot forever, rendering
    // nothing and reporting nothing.
    const stored: DockLayout = {
      ...EMPTY_LAYOUT,
      left: ['catalogue', 'a-panel-from-2025'],
    }
    const layout = normalizeLayout(stored, PANELS)
    expect(layout.left).toContain('catalogue')
    expect(census(layout)).not.toContain('a-panel-from-2025')
  })

  it('places a panel the stored layout has never heard of', () => {
    // The worse half: a new panel that appears in no zone is unreachable, and
    // there is no UI for opening something that does not exist anywhere.
    const stored: DockLayout = { ...EMPTY_LAYOUT, left: ['catalogue'] }
    const layout = normalizeLayout(stored, PANELS)
    expectIntact(layout)
    expect(layout.left).toContain('time')
  })

  it('de-duplicates a panel that somehow reached two zones', () => {
    const stored: DockLayout = {
      ...EMPTY_LAYOUT,
      left: ['object'],
      right: ['object'],
    }
    const layout = normalizeLayout(stored, PANELS)
    expectIntact(layout)
    // The first zone in `DOCK_ZONES` order wins, and the second copy is gone
    // rather than moved — the rest of `left` is just the panels that had no
    // stored home being placed where their definitions say.
    expect(layout.left[0]).toBe('object')
    expect(layout.right).not.toContain('object')
  })

  it('is a fixpoint, which is what makes it safe on every render', () => {
    fc.assert(
      fc.property(
        fc.record({
          left: fc.array(fc.constantFrom(...IDS, 'ghost'), { maxLength: 6 }),
          right: fc.array(fc.constantFrom(...IDS, 'ghost'), { maxLength: 6 }),
          float: fc.array(fc.constantFrom(...IDS, 'ghost'), { maxLength: 6 }),
          hidden: fc.array(fc.constantFrom(...IDS, 'ghost'), { maxLength: 6 }),
        }),
        (stored) => {
          const once = normalizeLayout(stored, PANELS)
          expect(normalizeLayout(once, PANELS)).toEqual(once)
          expectIntact(once)
        },
      ),
    )
  })

  it('preserves the order the user arranged', () => {
    const stored: DockLayout = {
      ...EMPTY_LAYOUT,
      right: ['view', 'object'],
    }
    expect(normalizeLayout(stored, PANELS).right).toEqual(['view', 'object'])
  })
})

describe('the stored-value guard', () => {
  it('accepts a layout and refuses everything else', () => {
    expect(isDockLayout(EMPTY_LAYOUT)).toBe(true)
    expect(isDockLayout(defaultLayout(PANELS))).toBe(true)
    expect(isDockLayout(null)).toBe(false)
    expect(isDockLayout('left')).toBe(false)
    expect(isDockLayout({ left: [], right: [], float: [] })).toBe(false)
    expect(isDockLayout({ ...EMPTY_LAYOUT, left: [1, 2] })).toBe(false)
  })

  it('accepts unknown ids, because repairing beats discarding', () => {
    // Structural only, deliberately: a layout stored before a panel was added
    // is repairable by `normalizeLayout`, and rejecting it here would throw
    // away an arrangement the user made over a name they never typed.
    expect(isDockLayout({ ...EMPTY_LAYOUT, left: ['who-knows'] })).toBe(true)
  })
})

describe('where a drop lands', () => {
  const stack = [
    { start: 0, end: 100 },
    { start: 100, end: 200 },
    { start: 200, end: 260 },
  ]

  it('inserts before the panel whose first half the pointer is in', () => {
    expect(insertionIndex(10, stack)).toBe(0)
    expect(insertionIndex(120, stack)).toBe(1)
    expect(insertionIndex(210, stack)).toBe(2)
  })

  it('appends past the last midpoint', () => {
    // Midpoints, not leading edges. With edges the final slot is unreachable —
    // there is no position past the last panel's start that is not also inside
    // it, so a panel could never be dragged to the end of a stack.
    expect(insertionIndex(240, stack)).toBe(3)
    expect(insertionIndex(9_999, stack)).toBe(3)
  })

  it('answers 0 for an empty zone', () => {
    expect(insertionIndex(50, [])).toBe(0)
  })

  it('never returns an index a move cannot use', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), (at) => {
        const index = insertionIndex(at, stack)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThanOrEqual(stack.length)
      }),
    )
  })
})
