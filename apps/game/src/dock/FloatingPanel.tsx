'use no memo'
import { useRef } from 'react'
import { useDrag } from 'react-dnd'
import { cascade, type FloatPoint } from './floating.ts'
import { PanelChrome } from './PanelChrome.tsx'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'
import type { Workspace } from './useWorkspace.ts'

/**
 * A panel floating over the scene.
 *
 * The same chrome as a docked one, positioned absolutely and dragged by the
 * same header. Where it *lands* is not decided here: the drag ends over
 * `FloatField` or over a pane, and each of those knows what a release on it
 * means. This only has to report where the panel started, because a drag
 * reports a delta and a delta needs an origin.
 *
 * `'use no memo'`: `useDrag`'s collected state changes on every pointer move
 * during a gesture, which is not something a compiler that assumes render is a
 * pure function of props can memoise. Same opt-out as `DockPanel`.
 */
export function FloatingPanel({
  definition,
  index,
  workspace,
  viewport,
}: {
  definition: DockPanelDefinition
  /** Its place in the float stack, for a panel that has never been placed. */
  index: number
  workspace: Workspace
  viewport: { readonly width: number; readonly height: number }
}) {
  const node = useRef<HTMLElement | null>(null)
  const at: FloatPoint =
    workspace.floats[definition.id] ?? cascade(index, viewport)

  const [{ dragging }, drag, preview] = useDrag<
    PanelDragItem,
    void,
    { dragging: boolean }
  >(
    () => ({
      type: PANEL_DRAG_TYPE,
      item: { id: definition.id, from: 'float' },
      /*
       * The fallback path, and only the fallback path.
       *
       * `FloatField` handles the ordinary release by reading the drag preview's
       * projected top-left, which is exact. The touch backend synthesises drags
       * and does not always produce one, and a release that lands on nothing —
       * outside the window, over a portalled tooltip — never reaches a drop
       * target at all. Both end here, where a delta from where the panel
       * started is enough to keep it under the hand.
       */
      end: (_item, monitor) => {
        if (monitor.didDrop()) return
        const delta = monitor.getDifferenceFromInitialOffset()
        if (delta === null) return
        const rect = node.current?.getBoundingClientRect()
        workspace.nudge(definition.id, delta, at, {
          width: rect?.width ?? 304,
          height: rect?.height ?? 220,
        })
      },
      collect: (monitor) => ({ dragging: monitor.isDragging() }),
    }),
    [definition.id, at.x, at.y, workspace],
  )

  return (
    <PanelChrome
      definition={definition}
      collapsed={workspace.isCollapsed(definition.id)}
      floating
      dragging={dragging}
      rootRef={(element: HTMLElement | null) => {
        node.current = element
        preview(element)
      }}
      handleRef={(element: HTMLElement | null) => {
        drag(element)
      }}
      onCollapse={() => workspace.toggleCollapsed(definition.id)}
      onFloat={() => workspace.float(definition.id)}
      onDock={() => workspace.dock(definition.id)}
      onHide={() => workspace.hide(definition.id)}
      /*
       * `z-10`, and it is the only z-index in the workspace.
       *
       * The float field is rendered *before* the panes so that a drag released
       * over a pane reaches the pane — DOM order is hit-testing order, and that
       * ordering is the whole arbitration between "dock it" and "float it".
       * Paint order follows the same rule, though, so without this a floating
       * panel dragged over a pane disappears behind it: lifted out of the stack
       * and immediately buried, which reads as the panel having been destroyed.
       *
       * One class fixes both, because a positioned element with a z-index
       * paints above its `auto` siblings *and* takes their hit tests — which is
       * also correct here. A floating panel is on top; you should be able to
       * click the part of it that overlaps a pane.
       *
       * `max-h` rather than a height: a floating panel is as tall as its
       * content until that would run off the bottom of the frame, at which
       * point its body scrolls — the same rule a pane applies to its stack.
       */
      className="pointer-events-auto absolute z-10 max-h-[calc(100vh-8rem)] w-[19rem] max-w-[calc(100vw-1.5rem)]"
      style={{ left: at.x, top: at.y }}
    >
      {definition.render()}
    </PanelChrome>
  )
}
