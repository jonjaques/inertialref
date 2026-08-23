'use no memo'
import { useCallback, useRef, useState } from 'react'
import { useDrop } from 'react-dnd'
import { DropLine } from './DropLine.tsx'
import { insertionIndex, type PaneZone } from './layout.ts'
import { PaneHandle } from './PaneHandle.tsx'
import { PanelSlot } from './PanelSlot.tsx'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'
import type { Workspace } from './useWorkspace.ts'

/*
 * One pane: a column of panels against one edge, and the half of the drop
 * gesture only a browser can do.
 *
 * A pane slides away rather than unmounting, and that is the difference between
 * a workspace and a set of toggles. Unmounting throws away every panel's scroll
 * position and re-runs every body's first render, so a pane closed to look at
 * something and reopened is a pane that has forgotten where you were in the
 * catalog. Translating it costs a transform and keeps all of it.
 *
 * What that costs in return is that a closed pane is still in the tree, so it
 * has to stop being interactive and stop being announced — `pointer-events` and
 * `inert` below, both of which a `hidden` would have given for free and neither
 * of which is worth the scroll position.
 *
 * `'use no memo'`: `hover` writes the drop indicator on every pointer move
 * during a drag, and the React Compiler's assumption that a render is a pure
 * function of its props does not survive a component whose output depends on a
 * ref-held measurement taken mid-gesture. Same opt-out and reason as
 * `hud/PerfPanel.tsx`.
 */

/** The pane's width. One panel wide — a pane is a column, not a workspace. */
const PANE_WIDTH = 'w-[19rem] max-w-[calc(100%-4rem)]'

export function DockPane({
  zone,
  panels,
  workspace,
}: {
  zone: PaneZone
  /** The panels in this pane, in order, already filtered of anything suppressed. */
  panels: readonly DockPanelDefinition[]
  workspace: Workspace
}) {
  const container = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState<number | null>(null)
  const open = workspace.panes[zone]
  const ids = panels.map((panel) => panel.id)

  /*
   * Where the pointer means to insert, measured against the panels on screen.
   *
   * The extents are read from the DOM on each hover rather than cached at drag
   * start. It is a handful of `getBoundingClientRect` calls — a pane holds
   * three or four panels — and the alternative is a cache that goes stale the
   * moment the drag itself reflows the stack, which is exactly when it is being
   * consulted.
   */
  const indexAt = useCallback(
    (client: { x: number; y: number } | null): number => {
      const node = container.current
      if (node === null || client === null) return ids.length
      const bounds = [...node.querySelectorAll('[data-dock-panel]')].map(
        (element) => {
          const rect = element.getBoundingClientRect()
          return { start: rect.top, end: rect.bottom }
        },
      )
      return insertionIndex(client.y, bounds)
    },
    [ids.length],
  )

  const [{ over, active }, drop] = useDrop<
    PanelDragItem,
    { docked: true },
    { over: boolean; active: boolean }
  >(
    () => ({
      accept: PANEL_DRAG_TYPE,
      hover: (_item, monitor) => {
        setIndicator(indexAt(monitor.getClientOffset()))
      },
      drop: (item, monitor) => {
        setIndicator(null)
        const index = indexAt(monitor.getClientOffset())
        /*
         * `index` is measured against the panels on screen — which still
         * include the dragged one, and *exclude* any panel a closed disclosure
         * is suppressing. `workspace.drop` owns both translations into the
         * index `movePanel` reads, and runs them inside the updater so a
         * gesture that delivers two drops composes rather than clobbers.
         */
        workspace.drop(item.id, zone, ids, index)
        // Returned so `FloatField`, which is the outer target, can see that the
        // release was already claimed and leave the panel alone.
        return { docked: true }
      },
      collect: (monitor) => ({
        over: monitor.isOver({ shallow: true }),
        // True while *anything* dockable is in flight, anywhere — which is what
        // reveals an emptied pane. Without it there is no way to dock into a
        // side that has been cleared, because there is nothing on screen to
        // aim at.
        active: monitor.canDrop(),
      }),
    }),
    [indexAt, workspace, zone],
  )

  const empty = panels.length === 0
  // Nothing in it and nothing in flight: no pane, and no handle either. A
  // reopen tab for a pane with nothing behind it is a control that does nothing.
  if (empty && !active) return null

  const side = zone === 'left' ? 'left-0' : 'right-0'
  /*
   * 110%, not `calc(100% + 1rem)`.
   *
   * The `calc` form compiled to nothing: Tailwind emitted the arbitrary value
   * verbatim, and `calc(100%+1rem)` without spaces around the operator is
   * invalid CSS, so the declaration was dropped and a closed pane sat exactly
   * where an open one does — `pointer-events-none`, `inert`, and fully visible.
   * The failure had no error anywhere; the pane simply stopped responding.
   *
   * A plain percentage needs no arithmetic and clears the frame by 10% of the
   * pane's own width, which at 19rem is 30px — more than the 0.75rem inset it
   * has to get past.
   */
  const away = zone === 'left' ? '-translate-x-[110%]' : 'translate-x-[110%]'

  return (
    <>
      <div
        ref={(node) => {
          container.current = node
          drop(node)
        }}
        data-dock-zone={zone}
        aria-label={`${zone} pane`}
        inert={!open}
        className={[
          'absolute top-3 bottom-16 flex min-h-0 flex-col gap-2 overflow-x-visible overflow-y-auto',
          'px-3 transition-transform duration-300 ease-out motion-reduce:transition-none',
          side,
          PANE_WIDTH,
          open
            ? 'pointer-events-auto translate-x-0'
            : `pointer-events-none ${away}`,
          empty ? 'justify-center' : '',
        ].join(' ')}
        onDragLeave={() => setIndicator(null)}
      >
        {empty ? (
          <p className="type-label rounded-lg border border-dashed border-sky-500/40 bg-sky-500/5 px-3 py-6 text-center text-sky-300/70">
            Drop Here
          </p>
        ) : (
          <>
            {panels.map((definition, index) => (
              <PanelSlot
                key={definition.id}
                definition={definition}
                zone={zone}
                indicate={over && indicator === index}
                workspace={workspace}
              />
            ))}
            {over && indicator === panels.length && <DropLine />}
          </>
        )}
      </div>

      {!open && (
        <PaneHandle
          zone={zone}
          count={panels.length}
          onOpen={() => workspace.setPane(zone, true)}
        />
      )}
    </>
  )
}
