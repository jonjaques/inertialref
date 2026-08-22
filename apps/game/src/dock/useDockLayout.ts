import {
  type DockLayout,
  EMPTY_LAYOUT,
  isDockLayout,
  normalizeLayout,
} from './layout.ts'
import { type DockPanelDefinition, layoutOf } from './panels.ts'
import { usePersistentState } from '../hud/panelState.ts'

/*
 * The stored arrangement, repaired against the panels this build has.
 *
 * Two steps rather than one, and the split is the point. `usePersistentState`
 * decides whether the stored value is *shaped* like a layout — that is the
 * `Accept` guard, and a value that fails it is a value from a different
 * program. `normalizeLayout` then decides whether it still *means* anything:
 * ids come and go across builds, and an arrangement whose panel names have
 * moved on is worth repairing rather than discarding, because the user made it.
 *
 * Normalising on read rather than only on write, because the panel set is what
 * changes: a layout written by yesterday's build is fine until today's build
 * adds a panel, and the write that would have fixed it may never come.
 */
export type DockLayoutUpdate =
  DockLayout | ((previous: DockLayout) => DockLayout)

export function useDockLayout(
  key: string,
  panels: readonly DockPanelDefinition[],
): [DockLayout, (update: DockLayoutUpdate) => void] {
  const [stored, setStored] = usePersistentState<DockLayout>(
    `dock.layout.${key}`,
    EMPTY_LAYOUT,
    isDockLayout,
  )
  const known = layoutOf(panels)

  /*
   * The updater always sees a *complete* layout, never the raw stored one.
   *
   * This is what makes `togglePanel` mean what it says. A first-run layout is
   * `EMPTY_LAYOUT` on disk and the full default on screen, so an updater handed
   * the raw value would find every panel in no zone at all — `zoneOf` returns
   * null — and "close the catalogue" would open it instead. Normalising on the
   * way in and again on the way out also means the stored string and the
   * rendered arrangement can never drift, which is a bug that only shows up
   * after a reload, long after the gesture that caused it.
   */
  const update = (next: DockLayoutUpdate): void => {
    setStored((previous) => {
      const current = normalizeLayout(previous, known)
      return normalizeLayout(
        typeof next === 'function' ? next(current) : next,
        known,
      )
    })
  }

  // `EMPTY_LAYOUT` as the fallback rather than a computed default: normalising
  // an empty layout *is* the default, so there is one definition of where a
  // panel lives — its own — instead of a second list here that could disagree.
  return [normalizeLayout(stored, known), update]
}
