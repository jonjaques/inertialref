import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DockZone } from './layout.ts'

/*
 * What a dockable panel is.
 *
 * Deliberately not a component type. A panel is a *definition* — an identity,
 * a name, a glyph, a default home and a thunk that produces its body — and the
 * thunk is what keeps a hidden panel free: the workspace never calls it, so a
 * catalog that is closed does not walk the star index eight times a second
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
  /**
   * Whether it is on screen the first time this workspace is ever drawn.
   *
   * Separate from `zone` rather than a fifth zone value, because the two answer
   * different questions and a panel needs both: the author's instruments start
   * closed, and the menu still has to know that reopening `perf` puts it in the
   * left pane. A `zone: 'hidden'` would have said the first thing and destroyed
   * the second — reopening would have put the panel back in `hidden`, which is
   * a toggle that does nothing.
   *
   * Defaults to true, so a mode's own panels are on screen when you arrive in
   * it. Only the guarded group sets it.
   */
  readonly defaultOpen?: boolean
  /** One line, for the menu's tooltip. */
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

/**
 * A run of panels the menu draws together, behind one separator.
 *
 * Grouping lives here rather than on the panel because it is a fact about the
 * *menu*, not about the panel: the same perf readout is a mode panel to whoever
 * is tuning the renderer and a dev panel to everyone else, and a `group` field
 * on the definition would have to be rewritten to move it. A group is also the
 * unit of disclosure — see `guarded`.
 */
export interface PanelGroup {
  readonly id: string
  /** Names the run in the menu's tooltip, and labels it for a screen reader. */
  readonly label: string
  readonly panels: readonly DockPanelDefinition[]
  /**
   * Hidden behind a disclosure until asked for, with its panels forced off
   * screen while it is.
   *
   * The dev instruments are the reason this exists. `PRODUCT.md` is emphatic
   * that the author's readouts are scaffolding a first-time visitor should
   * never meet — but the brief for this menu is that *every* panel is toggled
   * from one place, dev ones included. A disclosure is both: one button says
   * the instruments exist, and nothing behind it is on screen until it is
   * pressed.
   *
   * Suppression is deliberately a render-time filter rather than a move to
   * `hidden`. Hiding them would mean the arrangement someone built is gone the
   * next time the group is closed and reopened, which is a preference thrown
   * away by a disclosure it has nothing to do with.
   */
  readonly guarded?: boolean
  /** The icon on the disclosure. Required when `guarded`. */
  readonly icon?: LucideIcon
}

/** Every panel in every group, in menu order. */
export const allPanels = (
  groups: readonly PanelGroup[],
): readonly DockPanelDefinition[] => groups.flatMap((group) => group.panels)

/**
 * The subset the layout algebra needs, so it never sees a React node.
 *
 * `defaultOpen: false` becomes `hidden` *here* rather than in the definition,
 * which is what keeps the two meanings apart: `normalizeLayout` reads this to
 * place a panel it has never seen, and `useWorkspace` reads the definition's
 * own `zone` to decide where reopening puts it.
 */
export const layoutOf = (
  panels: readonly DockPanelDefinition[],
): readonly { id: string; zone: DockZone }[] =>
  panels.map((panel) => ({
    id: panel.id,
    zone: panel.defaultOpen === false ? 'hidden' : panel.zone,
  }))

/** The drag item React DnD carries. One type, so every zone accepts every panel. */
export const PANEL_DRAG_TYPE = 'inertialref/dock-panel'

export interface PanelDragItem {
  readonly id: string
  readonly from: DockZone
}
