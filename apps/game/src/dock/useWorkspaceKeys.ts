import { useEffect, useRef } from 'react'
import { PANE_ZONES } from './layout.ts'
import { isOpen, type Workspace } from './useWorkspace.ts'

/*
 * The three keys that are about what is on screen rather than about the ship.
 *
 * They used to be bindings in `useShipControls`, called back into `App`, which
 * held the dock's open state and its current tab. Neither of those exists any
 * more: a workspace is per-mode, its state lives in the hook that owns it, and
 * routing a keystroke from a window listener in `App` down to a mode's
 * workspace would be an event bus in place of a function call.
 *
 * So the listener is here, beside the state it changes. Two window `keydown`
 * handlers rather than one is fine — they claim disjoint keys, and the
 * alternative was a shared one that could only reach half of what it fired.
 */

export interface WorkspaceKeyOptions {
  /**
   * Open a panel by id, disclosing whatever group it is in.
   *
   * `G` and `P` name the author's instruments, which are behind a disclosure,
   * so "show the perf panel" has to be able to press that disclosure too — a
   * shortcut that silently did nothing because a group was closed is worse
   * than no shortcut.
   */
  readonly onShow: (panel: string) => void
}

/** Panel id per key code. Two, and both are the ones an author reaches for. */
const SHORTCUTS: Readonly<Record<string, string>> = {
  KeyG: 'navigate',
  KeyP: 'perf',
}

/** Whether the keystroke belongs to something being typed into. */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

export function useWorkspaceKeys(
  workspace: Workspace,
  options: WorkspaceKeyOptions,
): void {
  /*
   * Through a ref, so the listener is bound once for the life of the mode.
   *
   * The workspace object is rebuilt on every render, and a panel that polls the
   * harness re-renders this subtree several times a second. Depending on it
   * directly would tear down and rebuild a window listener at that rate.
   */
  const latest = useRef({ workspace, options })
  useEffect(() => {
    latest.current = { workspace, options }
  })

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTyping(event)) return
      const { workspace: current, options: handlers } = latest.current

      if (event.code === 'KeyH') {
        /*
         * One key, both panes, and the sense is decided by what is already
         * true: if either pane is open, `H` clears the frame; if both are
         * away, it brings them back. A per-pane toggle would mean pressing it
         * twice left the workspace inverted rather than restored.
         */
        const anyOpen = PANE_ZONES.some((zone) => current.panes[zone])
        for (const zone of PANE_ZONES) current.setPane(zone, !anyOpen)
        return
      }

      const panel = SHORTCUTS[event.code]
      if (panel === undefined) return
      // A second press closes it again, which is what every other way of
      // reaching a panel does — the menu glyph, the panel's own close button.
      if (isOpen(current.layout, panel)) current.hide(panel)
      else handlers.onShow(panel)
    }

    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])
}
