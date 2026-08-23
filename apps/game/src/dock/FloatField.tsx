'use no memo'
import { useDrop } from 'react-dnd'
import { FloatingPanel } from './FloatingPanel.tsx'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'
import type { Workspace } from './useWorkspace.ts'

/*
 * The scene, treated as a place a panel can be put down.
 *
 * Two jobs that have to be one component, because they are one surface: it
 * draws the floating panels, and it is the drop target that *makes* a panel
 * float — a release anywhere that is not a pane.
 *
 * The pointer-events rule is the whole trick. This covers the viewport, and the
 * viewport is the thing being simulated: a layer that swallowed clicks would
 * mean the camera could never be orbited again. So it is inert until React DnD
 * says something dockable is actually in flight, and inert again the moment the
 * gesture ends. `canDrop` is true for the life of a drag regardless of where
 * the pointer is, which is exactly the window this needs to be live for.
 *
 * The panes are siblings rendered *after* this one, so a release over a pane
 * hits the pane — no z-index, no `didDrop` bookkeeping in the common case. The
 * check below is for the touch backend, which can deliver both.
 *
 * `'use no memo'`: the collected drag state changes on every pointer move.
 */
export function FloatField({
  panels,
  workspace,
  viewport,
}: {
  /** The floating panels, in layout order, already filtered of the suppressed. */
  panels: readonly DockPanelDefinition[]
  workspace: Workspace
  viewport: { readonly width: number; readonly height: number }
}) {
  const [{ active }, drop] = useDrop<PanelDragItem, void, { active: boolean }>(
    () => ({
      accept: PANEL_DRAG_TYPE,
      drop: (item, monitor) => {
        if (monitor.didDrop()) return
        /*
         * The projected top-left of the drag preview, not the pointer.
         *
         * A panel grabbed by the right-hand end of its header and dropped
         * should land where it visibly *is*, not with its corner snapped under
         * the cursor — which is a jump of most of the panel's width and reads
         * as the drop having missed. `getSourceClientOffset` is React DnD's
         * answer to exactly this and it is already in the coordinate space
         * `clampFloat` works in.
         *
         * It is null on some synthesised drags; `FloatingPanel`'s own `end`
         * handler covers that case with a delta, and a panel arriving from a
         * pane with nothing to go on gets the cascade.
         */
        const at = monitor.getSourceClientOffset()
        const rect = document
          .querySelector(`[data-dock-panel="${CSS.escape(item.id)}"]`)
          ?.getBoundingClientRect()
        const size = {
          width: rect?.width ?? 304,
          height: rect?.height ?? 220,
        }
        workspace.float(item.id, at ?? undefined, size)
      },
      collect: (monitor) => ({ active: monitor.canDrop() }),
    }),
    [workspace],
  )

  return (
    <div
      ref={(node) => {
        drop(node)
      }}
      data-dock-zone="float"
      className={`absolute inset-0 ${active ? 'pointer-events-auto' : 'pointer-events-none'}`}
    >
      {panels.map((definition, index) => (
        <FloatingPanel
          key={definition.id}
          definition={definition}
          index={index}
          workspace={workspace}
          viewport={viewport}
        />
      ))}
    </div>
  )
}
