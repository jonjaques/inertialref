import { Bug } from 'lucide-react'
import type { DockPanelDefinition, PanelGroup } from './panels.ts'

/*
 * How a mode's panels and the author's instruments become one menu.
 *
 * A plain module rather than a corner of `Workspace.tsx` for the reason
 * `pages/modes.ts` and `hud/controls.ts` are: a `.tsx` that exports a constant
 * alongside its components is a file Fast Refresh gives up on, and in this app
 * a full reload rebuilds the `WebGPURenderer` and loses the camera.
 *
 * It is also the one place the two-group shape is written down. Every mode has
 * exactly the same structure — what this mode is for, then what the author uses
 * to see inside it — and stating it here rather than at three call sites is
 * what stops the flight mode's menu from being ordered differently to the
 * planetarium's.
 */

/** The mode's own panels, in the order the menu should offer them. */
export type WorkspacePanels = readonly DockPanelDefinition[]

/** The group id the disclosure toggles. One guarded group, named once. */
export const DEV_GROUP = 'dev'

/**
 * The author's instruments, and whether they are currently out.
 *
 * `App` owns both halves — the panels, because they read renderer state and
 * connection state that only `App` has, and the flag, because it is the same
 * `debug` preference the backtick key has always toggled and it outlives any
 * one mode.
 */
export interface DevWorkspace {
  readonly panels: WorkspacePanels
  readonly open: boolean
  /**
   * A setter rather than a toggle, because two callers need it and only one of
   * them is a button. `G` and `P` open a panel that is inside this group, so
   * they have to be able to *ensure* it is disclosed — a shortcut that toggled
   * it would put the instruments away half the time it was pressed.
   */
  readonly onOpenChange: (open: boolean) => void
}

/**
 * The menu's groups, in order: this place, then the instruments.
 *
 * The mode's group is unlabelled in the bar itself — the mode's name is already
 * beside the mark, two centimetres to the left, and repeating it over its own
 * panels would be the third time the word "planetarium" appeared in one strip.
 * The label survives for the screen reader and the tooltip.
 */
export function groupsFor(
  title: string,
  panels: WorkspacePanels,
  dev: DevWorkspace,
): readonly PanelGroup[] {
  const groups: PanelGroup[] = []
  if (panels.length > 0) groups.push({ id: 'mode', label: title, panels })
  if (dev.panels.length > 0)
    groups.push({
      id: DEV_GROUP,
      label: 'Instruments',
      panels: dev.panels,
      guarded: true,
      icon: Bug,
    })
  return groups
}

/**
 * The panels that may actually be drawn.
 *
 * A guarded group's panels are filtered out here rather than moved to `hidden`,
 * and the difference is a preference somebody made. Hiding them would mean the
 * arrangement built with the instruments out is gone the moment they are put
 * away — the layout would be rewritten by a disclosure that has nothing to do
 * with where anything is. Filtering leaves the layout exactly as it was, so
 * pressing the disclosure twice is a no-op rather than a reset.
 */
export function visiblePanels(
  groups: readonly PanelGroup[],
  devOpen: boolean,
): WorkspacePanels {
  return groups.flatMap((group) =>
    group.guarded === true && !devOpen ? [] : group.panels,
  )
}
