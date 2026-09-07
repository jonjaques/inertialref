'use no memo'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { NavigatorRow } from './NavigatorRow.tsx'
import {
  type Highlight,
  type ListRow,
  measureOf,
  moveInList,
} from './navigator.ts'

/*
 * The list, windowed.
 *
 * At 50 light years the survey answers with fourteen hundred systems, every
 * one a button with an SVG in it, and Sol alone unfolds to a hundred and
 * twenty-nine rows. Reconciling all of that against a fresh array twice a
 * second — beside the render loop — is the stutter the panel had; the
 * derivations are not the cost (0.19 ms at that size), React is. So only the
 * rows inside the scroll viewport exist, plus a margin of twelve either side,
 * and the rest is one tall, empty `<ul>` the scrollbar measures.
 *
 * `@tanstack/react-virtual` does the arithmetic. It is headless, so the tree
 * keeps its own markup, its own keyboard and its own single tab stop; what
 * it is handed is the scroll element and a row height, and what it hands back
 * is which indices to draw and where.
 *
 * **The scroll element is the panel's, not this list's.** The dock caps a
 * panel at 60vh and scrolls its body; a second scroller inside that one would
 * need a height nothing here can know. So the window observes the nearest
 * scrolling ancestor and offsets by `scrollMargin` — how far down that
 * scroller the list begins, which moves when the filters above it fold open.
 *
 * `'use no memo'`: the virtualizer is an object whose methods read scroll
 * position, which is mutable state outside React, and the compiler would
 * memoize the row set against props that have not changed while the scroll
 * has. Same bargain as `hud/PerfPanel.tsx`.
 */

/** The height every row is assumed to be until it has been measured. */
const ROW_HEIGHT = 28

/**
 * The nearest ancestor that scrolls vertically, or null.
 *
 * Read from computed style rather than by class name, so a panel body that
 * moves from `overflow-auto` to a different utility keeps working — and so the
 * same tree works inside the compact sheet and a floating panel, whose
 * scrollers are different elements with different classes.
 */
function scrollParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement
  while (parent !== null) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
    parent = parent.parentElement
  }
  return null
}

export function NavigatorTree({
  rows,
  current,
  tabbable,
  highlights,
  label,
  onAct,
  onFold,
}: {
  readonly rows: readonly ListRow[]
  /** The address drawn as selected. */
  readonly current: string | null
  /** The address that should carry the list's one tab stop, when drawn. */
  readonly tabbable: string | null
  readonly highlights?: ReadonlyMap<string, Highlight>
  readonly label: string
  readonly onAct: (address: string) => void
  readonly onFold: (address: string, open: boolean) => void
}) {
  const list = useRef<HTMLUListElement>(null)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const [margin, setMargin] = useState(0)
  /** A row the keyboard asked for that may not be mounted yet. */
  const pendingFocus = useRef<number | null>(null)

  /*
   * Where the list begins inside the scroller, kept current by watching the
   * panel it sits in.
   *
   * The filters and the rail above this list open and close, and each moves
   * the list's top by a different amount, so the offset cannot be measured
   * once. It is not a function of any prop either — it is a fact about layout
   * — so a `ResizeObserver` on the panel's own body is what notices it: any
   * change above the list changes the body's height, and the list's own growth
   * fires the same callback and measures the same offset, which the state
   * write then ignores.
   */
  useEffect(() => {
    const node = list.current
    if (node === null) return
    const body = node.parentElement
    if (body === null) return
    const measure = (): void => {
      const parent = scrollParent(node)
      setScroller(parent)
      if (parent === null) return
      setMargin(
        Math.round(
          node.getBoundingClientRect().top -
            parent.getBoundingClientRect().top +
            parent.scrollTop,
        ),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: margin,
    // The address, so a fold above a row does not re-mount every row below
    // it: keyed on index, opening Sol would replace the identity of the
    // hundred and twenty-nine rows under it in one commit.
    getItemKey: (index) => rows[index]?.key ?? index,
  })
  const items = virtualizer.getVirtualItems()

  /*
   * The list has one tab stop, and this is which row it is.
   *
   * The current row where it is drawn, else the first row on screen. `Tab`
   * should land where the reader is rather than at the top of a hundred rows —
   * but a row the window has not mounted cannot be a stop, and a list whose
   * only stop was scrolled away would have none at all.
   */
  const wanted =
    tabbable === null ? -1 : rows.findIndex((row) => row.key === tabbable)
  const stop = items.some((item) => item.index === wanted)
    ? wanted
    : (items[0]?.index ?? -1)

  const focusIndex = (index: number): void => {
    pendingFocus.current = index
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }

  // After every commit, because the row the keyboard asked for arrives in the
  // commit after the scroll moved, not the one that asked.
  useEffect(() => {
    const index = pendingFocus.current
    if (index === null) return
    const node = list.current?.querySelector<HTMLButtonElement>(
      `[data-navigator-row][data-index="${index}"]`,
    )
    if (node === null || node === undefined) return
    pendingFocus.current = null
    node.focus({ preventScroll: true })
  })

  /*
   * The tree's keyboard. Arrows and Home/End move between rows, `→` opens a
   * folded system, `←` closes an open one or climbs from a body to its
   * system; Enter and Space stay the button's own. The camera's arrow bindings
   * already yield here — every one of them is `yieldsToFocus`, and a focused
   * row is a control inside `.hud-layer` — so nothing has to be stopped from
   * propagating, and `preventDefault` only keeps the pane from scrolling under
   * the focus it just moved.
   *
   * Over the row *model*, not the DOM: a row two screens down is not mounted,
   * and `querySelectorAll` would say the list ends at the window's edge.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement
    const index = Number(target.dataset['index'])
    const row = rows[index]
    if (!Number.isInteger(index) || row === undefined) return
    const next = moveInList(event.key, index, rows.length)
    if (next !== null) {
      event.preventDefault()
      focusIndex(next)
      return
    }
    if (event.key === 'ArrowRight') {
      if (row.kind === 'system' && row.foldable && !row.open) {
        event.preventDefault()
        onFold(row.row.address, true)
      }
    } else if (event.key === 'ArrowLeft') {
      if (row.kind === 'system' && row.open) {
        event.preventDefault()
        onFold(row.row.address, false)
        return
      }
      if (row.kind === 'body') {
        const up = rows.findIndex(
          (one) => one.kind === 'system' && one.row.address === row.parent,
        )
        if (up >= 0) {
          event.preventDefault()
          focusIndex(up)
        }
      }
    }
  }

  return (
    /* A tree with one tab stop — see `NavigatorRow` and `onKeyDown`. The
       `<li>`s are `role="none"`: the tree items are the row buttons, and the
       hierarchy is `aria-level` on each of them, which is what ARIA prescribes
       for a tree whose DOM is flat. The `<ul>` is as tall as every row would
       be, so the scrollbar describes the whole list while only the window's
       worth of it exists. */
    <ul
      ref={list}
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {items.map((item) => {
        const row = rows[item.index]
        if (row === undefined) return null
        const shared = {
          row: row.row,
          index: item.index,
          selected: row.row.address === current,
          measure: measureOf(row.row),
          tabbable: item.index === stop,
          highlight: highlights?.get(row.row.address),
          onFocus: () => onAct(row.row.address),
        }
        return (
          <li
            key={item.key}
            role="none"
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {row.kind === 'system' ? (
              <NavigatorRow
                {...shared}
                indent={0}
                folded={row.folded}
                {...(row.foldable
                  ? {
                      expanded: row.open,
                      onExpand: () => onFold(row.row.address, !row.open),
                    }
                  : {})}
              />
            ) : (
              <NavigatorRow
                {...shared}
                indent={row.indent}
                parent={row.parent}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
