import { CompactDock } from './CompactDock.tsx'
import { DockPane } from './DockPane.tsx'
import { DockProvider } from './DockProvider.tsx'
import { FloatField } from './FloatField.tsx'
import { IrMenu } from './IrMenu.tsx'
import { PANE_ZONES } from './layout.ts'
import type { DevWorkspace, WorkspacePanels } from './workspace.ts'
import { DEV_GROUP, groupsFor, visiblePanels } from './workspace.ts'
import { allPanels } from './panels.ts'
import { useWorkspace } from './useWorkspace.ts'
import { useWorkspaceKeys } from './useWorkspaceKeys.ts'
import { useCompact } from '../hud/viewport.ts'

/*
 * The whole arrangement: two panes, a field of floating panels, and the menu
 * that says what is in them.
 *
 * One component in one place, rendered by every mode that has panels, and that
 * is the change this replaces a `Dock` and a `DockRail` to make. Before this
 * the planetarium had a docking system and the flight modes had a fixed panel
 * in the top-right corner; the same readout was a draggable panel in one mode
 * and a tab in the other, and moving a feature between them was a rewrite.
 * Now a mode contributes *panels* and the workspace is the same everywhere.
 *
 * Rendered by the mode rather than by `App` because a panel body closes over
 * what the mode has in scope — the observatory's target, the focus callback,
 * the label switches — and lifting that into `App` would mean either a context
 * or a props type per panel. `App` supplies the one group every mode shares,
 * which is the author's instruments, and each mode supplies its own.
 *
 * The layout is per-mode too, keyed by `id`: a workspace arranged for the
 * planetarium is about the planetarium's panels, and restoring it over flight —
 * where three of the five do not exist — would be a saved arrangement nobody
 * made.
 */

export function Workspace({
  id,
  title,
  panels,
  dev,
}: {
  /** The `localStorage` key this mode's arrangement is remembered under. */
  readonly id: string
  /** The place, beside the mark in the menu. */
  readonly title: string
  /** The mode's own panels, in menu order. */
  readonly panels: WorkspacePanels
  /** The author's instruments, from `App`. Guarded behind their disclosure. */
  readonly dev: DevWorkspace
}) {
  const compact = useCompact()
  const groups = groupsFor(title, panels, dev)
  /*
   * Every panel, guarded ones included, is `known` to the layout.
   *
   * Passing only the disclosed ones would make `normalizeLayout` drop the rest
   * as unrecognised — so closing the instruments and opening them again would
   * find every one of them back in its default pane, having forgotten an
   * arrangement the disclosure had nothing to do with. What the disclosure
   * controls is what is *rendered*, which is `visiblePanels` below.
   */
  const workspace = useWorkspace(id, allPanels(groups))
  /*
   * `H` hides both panes; `G` and `P` open a panel by name.
   *
   * `onShow` discloses the instruments first, because both named panels are
   * inside that group — a shortcut that quietly did nothing because a
   * disclosure was closed is worse than no shortcut at all.
   */
  useWorkspaceKeys(workspace, {
    onShow: (panel) => {
      if (dev.panels.some((definition) => definition.id === panel))
        dev.onOpenChange(true)
      workspace.toggle(panel)
    },
  })
  const visible = visiblePanels(groups, dev.open)
  const byId = new Map(visible.map((panel) => [panel.id, panel]))
  const inZone = (zone: 'left' | 'right' | 'float') =>
    workspace.layout[zone]
      .map((panelId) => byId.get(panelId))
      .filter((panel) => panel !== undefined)

  /*
   * On a phone the panes stop being read and the panels become a sheet.
   *
   * `CompactDock` has the argument at length: "left" and "right" have no
   * meaning on a 390 px screen, so a drag that moved a panel between them would
   * be a gesture with an invisible effect.
   *
   * It takes `title` for the same reason the IR menu does, and that is the
   * correction rather than a convenience: the compact arrangement used to be
   * the panels *only*, so the mark, the place and the settings — everything the
   * menu carries that is not a panel — simply did not exist on a phone, and a
   * mode had no way out of itself.
   */
  if (compact) {
    return (
      <DockProvider>
        <CompactDock panels={visible} layout={workspace.layout} mode={title} />
      </DockProvider>
    )
  }

  return (
    <DockProvider>
      <div className="pointer-events-none absolute inset-0">
        {/*
         * The float field first, the panes after.
         *
         * DOM order is hit-testing order in one stacking context with no
         * z-index anywhere, so a release over a pane reaches the pane and a
         * release over the scene falls through to the field. That is the whole
         * arbitration between "dock it" and "float it", and it needs no
         * bookkeeping as long as this order holds.
         */}
        <FloatField
          panels={inZone('float')}
          workspace={workspace}
          viewport={workspace.viewport}
        />
        {PANE_ZONES.map((zone) => (
          <DockPane
            key={zone}
            zone={zone}
            panels={inZone(zone)}
            workspace={workspace}
          />
        ))}
        <IrMenu
          mode={title}
          groups={groups}
          workspace={workspace}
          revealed={dev.open ? DEV_REVEALED : NO_GROUPS}
          onReveal={() => dev.onOpenChange(!dev.open)}
        />
      </div>
    </DockProvider>
  )
}

/** The one guarded group there is, as a set, so the menu takes one shape. */
const DEV_REVEALED: ReadonlySet<string> = new Set([DEV_GROUP])
const NO_GROUPS: ReadonlySet<string> = new Set()
