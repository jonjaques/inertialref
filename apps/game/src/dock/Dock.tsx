'use no memo'
import { useCallback, type ReactNode } from 'react'
import { DockZoneView } from './DockZoneView.tsx'
import {
  type DockLayout,
  type DockZone,
  dropIndex,
  movePanel,
} from './layout.ts'
import type { DockLayoutUpdate } from './useDockLayout.ts'
import type { DockPanelDefinition } from './panels.ts'

/*
 * The dock: panels in zones, moved by dragging their headers.
 *
 * Everything about *where* a panel ends up is in `layout.ts`, tested in Node.
 * What is here is the two things only a browser can do — measure where a
 * pointer is, and paint the result — and the seam between them is
 * `insertionIndex`, which takes a coordinate and a list of extents and returns
 * a number that `movePanel` can use. The measuring half is `DockZoneView`.
 *
 * `'use no memo'`: the drag rewrites the drop indicator on every pointer move,
 * and the React Compiler's assumption that a render is a pure function of its
 * props does not survive a component whose output depends on a ref-held
 * measurement taken mid-gesture. Same opt-out and reason as `hud/PerfPanel.tsx`.
 */

export interface DockProps {
  readonly panels: readonly DockPanelDefinition[]
  readonly layout: DockLayout
  readonly onLayout: (update: DockLayoutUpdate) => void
  /**
   * The launcher, rendered as the row's first item rather than positioned over
   * it. Absolute positioning was the first version and it overlapped the left
   * zone the moment a panel was docked there — the rail has to take part in the
   * same layout as the thing it sits beside.
   */
  readonly rail?: ReactNode
}

export function Dock({ panels, layout, onLayout, rail }: DockProps) {
  const byId = new Map(panels.map((panel) => [panel.id, panel]))
  /*
   * Updater form, not a computed value, and the difference is load-bearing.
   *
   * One pointer gesture can deliver more than one drop — nested targets, a
   * synthesized drag, a hand that releases over a boundary — and two moves
   * composed against the same captured `layout` silently discard the first.
   * Against the previous state they compose, which is what the arithmetic in
   * `layout.ts` was written to allow.
   */
  const move = useCallback(
    (id: string, zone: DockZone, index: number) => {
      /*
       * `index` is measured against the panels on screen, which still include
       * the one being dragged — `dropIndex` is the translation into the index
       * `movePanel` reads, and without it a downward drag inside one zone
       * landed a slot past the line the drop indicator had just drawn.
       *
       * Inside the updater, so it is computed against the same state the move
       * is applied to. Against the captured `layout` it would be right for the
       * first drop of a gesture and wrong for a second.
       */
      onLayout((current) =>
        movePanel(current, id, zone, dropIndex(current, id, zone, index)),
      )
    },
    [onLayout],
  )
  const hide = useCallback(
    (id: string) => {
      onLayout((current) => movePanel(current, id, 'hidden'))
    },
    [onLayout],
  )

  const zone = (name: DockZone) => (
    <DockZoneView
      zone={name}
      ids={layout[name]}
      byId={byId}
      onMove={move}
      onHide={hide}
    />
  )

  /*
   * `pointer-events-none` on every container and `auto` on the panels
   * themselves: the gap in the middle is the scene, and it has to receive the
   * drags that orbit the camera. Which zone gets which axis is `isColumn` in
   * `layout.ts`, where the reasoning lives.
   */
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col">
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        {rail !== undefined && (
          <div className="pointer-events-none flex shrink-0 items-center">
            {rail}
          </div>
        )}
        {zone('left')}
        <div className="min-w-0 flex-1" />
        {zone('right')}
      </div>
      <div className="px-2 pb-2">{zone('bottom')}</div>
    </div>
  )
}
