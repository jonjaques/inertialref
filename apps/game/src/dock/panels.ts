import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DockZone } from './layout.ts'

/*
 * What a dockable panel is.
 *
 * Deliberately not a component type. A panel is a *definition* — an identity,
 * a name, a glyph, a default home and a thunk that produces its body — and the
 * thunk is what keeps a hidden panel free: the dock never calls it, so a
 * catalogue that is closed does not walk the star index eight times a second
 * to render into nothing.
 *
 * `id` is the string that ends up in `localStorage`, so it is an identity that
 * outlives a rename of the title. `normalizeLayout` is what copes when it does
 * not; see `layout.ts`.
 */
export interface DockPanelDefinition {
  /** Stable across renames — this is what a stored layout remembers. */
  readonly id: string
  readonly title: string
  readonly icon: LucideIcon
  /** Where it goes when nothing has been stored, and where reopening puts it. */
  readonly zone: DockZone
  /** One line, for the launcher rail's tooltip. */
  readonly hint: string
  /**
   * The panel's body, produced on demand.
   *
   * A thunk rather than an element so a closed panel costs nothing, and rather
   * than a component so the definition can close over whatever the mode
   * already has in scope without a context or a props type per panel.
   */
  readonly render: () => ReactNode
}

/** The subset the layout algebra needs, so it never sees a React node. */
export const layoutOf = (
  panels: readonly DockPanelDefinition[],
): readonly { id: string; zone: DockZone }[] =>
  panels.map((panel) => ({ id: panel.id, zone: panel.zone }))

/** The drag item React DnD carries. One type, so every zone accepts every panel. */
export const PANEL_DRAG_TYPE = 'inertialref/dock-panel'

export interface PanelDragItem {
  readonly id: string
  readonly from: DockZone
}
