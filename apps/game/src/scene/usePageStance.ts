import { useEffect } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  MENU_ADDRESS,
  MENU_FILL,
  MENU_PHASE,
  MENU_TILT,
} from '../pages/menuFraming.ts'
import { overlayStore, stancePathOf } from '../pages/overlay.ts'
import { modeForPath, stanceForPath } from '../pages/paths.ts'

/*
 * The backdrop's own stance, keyed to the document.
 *
 * The island persists across a ClientRouter navigation, so a React
 * lifecycle cannot be the writer: this component does not unmount. The
 * path is read off the address bar, except while a warm overlay is open
 * — that URL is the dialog, and the mode underneath still owns the
 * camera. Overlay paths that are the document (a cold `/settings`) are
 * the menu.
 *
 * Modes that drive the camera continuously still push their own layer.
 * This is the floor underneath them, released only when the island
 * itself unmounts.
 */

export function usePageStance(engine: GameEngine): void {
  useEffect(() => {
    const apply = (): void => {
      const path = stancePathOf(
        window.location.pathname,
        overlayStore.getState(),
      )
      handle.update(stanceForPath(path))
      if (modeForPath(path) !== 'menu') return
      try {
        const observatory = engine.harness.observatory
        observatory.focus(MENU_ADDRESS, { fill: MENU_FILL, ease: false })
        observatory.setPhase(MENU_PHASE, MENU_TILT)
      } catch {
        // A world without Sol is not a world this build makes, but a
        // backdrop that throws is a black page.
      }
    }

    const handle = engine.presentation.push(
      stanceForPath(
        stancePathOf(window.location.pathname, overlayStore.getState()),
      ),
    )
    apply()
    document.addEventListener('astro:page-load', apply)
    return () => {
      handle.release()
      document.removeEventListener('astro:page-load', apply)
    }
  }, [engine])
}
