'use no memo'
import { useDrag } from 'react-dnd'
import type { DockZone } from './layout.ts'
import { PanelChrome } from './PanelChrome.tsx'
import {
  type DockPanelDefinition,
  PANEL_DRAG_TYPE,
  type PanelDragItem,
} from './panels.ts'
import type { Workspace } from './useWorkspace.ts'

/**
 * A panel docked in a pane.
 *
 * `'use no memo'` for the same reason `DockZoneView` carries it — this subtree
 * is rebuilt mid-gesture from a ref-held measurement, which is not a pure
 * function of its props.
 */
export function DockPanel({
  definition,
  zone,
  siblings,
  workspace,
}: {
  definition: DockPanelDefinition
  zone: DockZone
  /** How many other panels share the pane. Decides how tall this one may grow. */
  siblings: number
  workspace: Workspace
}) {
  const [{ dragging }, drag, preview] = useDrag<
    PanelDragItem,
    void,
    { dragging: boolean }
  >(
    () => ({
      type: PANEL_DRAG_TYPE,
      item: { id: definition.id, from: zone },
      collect: (monitor) => ({ dragging: monitor.isDragging() }),
    }),
    [definition.id, zone],
  )

  const collapsed = workspace.isCollapsed(definition.id)
  return (
    <PanelChrome
      definition={definition}
      collapsed={collapsed}
      floating={false}
      dragging={dragging}
      // The preview connector on the whole panel, the drag connector on the
      // header alone: the drag image should be the thing being moved, and the
      // grab handle should be the one strip that is not also a control.
      rootRef={(node: HTMLElement | null) => {
        preview(node)
      }}
      handleRef={(node: HTMLElement | null) => {
        drag(node)
      }}
      onCollapse={() => workspace.toggleCollapsed(definition.id)}
      onFloat={() => workspace.float(definition.id)}
      onDock={() => workspace.dock(definition.id)}
      onHide={() => workspace.hide(definition.id)}
      /*
       * A docked panel is as tall as its content, and never so tall that it
       * hides the panels under it.
       *
       * Two failures, one rule. Uncapped, a panel taller than the pane — the
       * catalog is seventy-five rows — runs past the bottom and is clipped
       * mid-row by the pane's own scroll, so the last thing on screen is half a
       * line of type with no rounded corner under it. Capped at the pane's
       * *full* height instead, it fits exactly and pushes every panel below it
       * off the bottom, where the menu still reports them open and nothing on
       * screen suggests scrolling.
       *
       * 60vh is the stack's answer: it leaves the next panel's header visible,
       * which is the whole requirement — a stack you can see the shape of. The
       * `100% - 2.75rem` per sibling beside it is the same claim expressed
       * against the pane rather than the frame, and it is the one that binds on
       * a short window.
       *
       * **A panel that is alone in its pane has no stack to leave room for**,
       * and 60% of the frame applied to it is a number about somebody else's
       * layout. It left the Camera panel's lens cut off with 400 px of empty
       * pane beneath it. On its own the cap is the pane, which it still needs:
       * a `shrink-0` flex item taller than a scrolling column is the
       * clipped-mid-row failure above.
       *
       * The panel's own body scrolls in every case, which is what every readout
       * in here was already built to do — and `scroll-cue` in `PanelChrome`
       * says so when it is doing it.
       */
      style={{
        maxHeight:
          siblings === 0
            ? '100%'
            : `min(60dvh, calc(100% - ${siblings * 2.75}rem))`,
      }}
    >
      {definition.render()}
    </PanelChrome>
  )
}
