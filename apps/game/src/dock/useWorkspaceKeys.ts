import { useActions } from '../input/useKeymap.ts'
import type { ActionId } from '../input/keymap.ts'
import { PANE_ZONES } from './layout.ts'
import type { Workspace } from './useWorkspace.ts'

/*
 * The keys that are about what is on screen rather than about the ship.
 *
 * They were a window `keydown` listener of their own, beside the state they
 * change, on the argument that routing a keystroke from `App` down to a mode's
 * workspace would be an event bus in place of a function call. The dispatcher
 * is the third answer: a mode registers a handler for an id and the listener
 * belongs to nobody, so the state stays here and the key does not.
 */

/** The panels the number row reaches, in menu order. */
const PANEL_KEYS: readonly ActionId[] = [
  'panel.1',
  'panel.2',
  'panel.3',
  'panel.4',
  'panel.5',
  'panel.6',
  'panel.7',
]

export interface WorkspaceKeyOptions {
  /**
   * Show a panel by id, or put a showing one away.
   *
   * The whole decision belongs to the caller, not this hook, because "is this
   * panel actually on screen" is more than the layout census: a dev panel can
   * be open in its pane and still suppressed by a closed disclosure, and a
   * hook that consulted `isOpen` alone answered that case by hiding a panel
   * nobody could see — a first press that did nothing visible and quietly
   * discarded the arranged slot the suppression exists to preserve.
   */
  readonly onToggle: (panel: string) => void
  /**
   * The panels the number row addresses, in menu order.
   *
   * The mode's own list rather than a constant, because "the third panel" means
   * a different panel in the planetarium than in flight — which is the whole
   * reason the numbers are bound to positions and the letters to names.
   */
  readonly panels: readonly string[]
  /**
   * Whether the workspace is on screen at all.
   *
   * `Workspace` renders nothing while the chrome is cleared, but rendering
   * nothing is not unmounting — so without this, `H` and the number row still
   * rearrange the dock and write the layout to storage behind a frame nobody
   * can see, which a plate script does by sending a digit.
   */
  readonly enabled?: boolean
}

export function useWorkspaceKeys(
  workspace: Workspace,
  options: WorkspaceKeyOptions,
): void {
  const live = options.enabled !== false
  useActions(
    ['chrome.panes'],
    () => {
      /*
       * One key, both panes, and the sense is decided by what is already true: if
       * either pane is open, this clears the frame; if both are away, it brings
       * them back. A per-pane toggle would mean pressing it twice left the
       * workspace inverted rather than restored.
       */
      const anyOpen = PANE_ZONES.some((zone) => workspace.panes[zone])
      for (const zone of PANE_ZONES) workspace.setPane(zone, !anyOpen)
    },
    live,
  )

  useActions(['panel.perf'], () => options.onToggle('perf'), live)

  useActions(
    PANEL_KEYS,
    (id) => {
      const index = PANEL_KEYS.indexOf(id)
      const panel = options.panels[index]
      // A number with no panel behind it does nothing rather than the nearest
      // thing: a mode with four panels has to leave `5` alone, or the key means
      // something different in every mode for no reason anybody could infer.
      if (panel !== undefined) options.onToggle(panel)
    },
    live,
  )
}
