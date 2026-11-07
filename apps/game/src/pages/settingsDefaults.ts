import {
  CONTROLS_KEYMAP,
  CONTROLS_PAD,
  CONTROLS_PAD_TUNING,
  differs,
  DOCK_COLLAPSED,
  DOCK_FLOATS,
  DOCK_LAYOUT,
  DOCK_PANES,
  DOCK_PLACEMENT,
  resetPreference,
  usePersistentState,
} from '../state/preferences.ts'
import type { AppMode } from './paths.ts'

/**
 * What one settings page holds that differs from its defaults, and the verb
 * that puts it back.
 *
 * Every page's "restore defaults" is scoped to the rows that page draws, and
 * the scope is written here rather than left to the button: the keyboard's
 * bindings and the pad's are separate records precisely so that resetting one
 * leaves the other alone, and a page whose reset reached past what it shows
 * would be undoing choices the reader cannot see from where they pressed it.
 */
export interface PageDefaults {
  /** How many of the page's settings differ from their defaults. */
  readonly changed: number
  readonly restore: () => void
}

/** The bindings: one row per act that has been rebound or unbound. */
export function useKeyDefaults(): PageDefaults {
  const [overrides] = usePersistentState(CONTROLS_KEYMAP)
  return {
    changed: Object.keys(overrides).length,
    restore: () => resetPreference(CONTROLS_KEYMAP),
  }
}

/** The pad's bindings and its feel, which is everything its page draws. */
export function usePadDefaults(): PageDefaults {
  const [overrides] = usePersistentState(CONTROLS_PAD)
  const [tuning] = usePersistentState(CONTROLS_PAD_TUNING)
  const tuned = (
    Object.keys(CONTROLS_PAD_TUNING.initial) as (keyof typeof tuning)[]
  ).filter((field) =>
    differs(tuning[field], CONTROLS_PAD_TUNING.initial[field]),
  ).length
  return {
    changed: Object.keys(overrides).length + tuned,
    restore: () => {
      resetPreference(CONTROLS_PAD)
      resetPreference(CONTROLS_PAD_TUNING)
    },
  }
}

/**
 * The interface page's one stored choice, the menu bar's placement.
 *
 * The layouts are deliberately not in it. They are a different kind of thing —
 * where somebody has put panels over the course of using a mode, rather than a
 * setting they chose on this page — and the page offers resetting them as acts
 * of their own, with the mode named on the button.
 */
export function useInterfaceDefaults(): PageDefaults {
  const [placement] = usePersistentState(DOCK_PLACEMENT)
  return {
    changed: placement === DOCK_PLACEMENT.initial ? 0 : 1,
    restore: () => resetPreference(DOCK_PLACEMENT),
  }
}

/** The modes that keep a workspace — every mode except the menu. */
export const WORKSPACE_MODES: readonly Exclude<AppMode, 'menu'>[] = [
  'planetarium',
  'flight',
  'cinema',
  'docs',
]

/**
 * One mode's panels back where its definitions put them: the four records a
 * workspace keeps, removed, so the mounted workspace hears its defaults through
 * the same subscription an import reaches it by — nothing reloads.
 */
export function resetWorkspace(mode: Exclude<AppMode, 'menu'>): void {
  resetPreference(DOCK_LAYOUT.of(mode))
  resetPreference(DOCK_FLOATS.of(mode))
  resetPreference(DOCK_COLLAPSED.of(mode))
  resetPreference(DOCK_PANES.of(mode))
}
