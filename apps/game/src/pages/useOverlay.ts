import { useCallback } from 'react'
import { useLocation, useNavigate, type Location } from 'react-router'
import {
  HOME,
  overlayBackground,
  overlayState,
  type OverlayLocationState,
} from './paths.ts'

/*
 * The other half of the background-location contract.
 *
 * `paths.ts` holds the pure half — what a link puts in `location.state`, and
 * how to read it back — because that half is testable in Node and is what the
 * shell and the route table consult. This is the React binding, and it is one
 * hook rather than three lines repeated in each dialog because repeating them
 * is exactly what went wrong: `ShellBar` and `routes.tsx` implemented the
 * contract and everything else ignored it. Closing settings opened from
 * `/planetarium?at=s:SOL/b:5` navigated to `/`, which unmounted the
 * planetarium, ran `observatory.clear()` and lost the address — a dialog's
 * close button returning the player to the main menu.
 *
 * Its own module rather than a corner of `OverlayPage.tsx` for the reason
 * `focus.ts` gives: a file that exports both components and plain functions is
 * one Fast Refresh gives up on, and `react/only-export-components` says so.
 */

export interface Overlay {
  /** The mode behind this dialog, or `null` on a cold load. */
  readonly background: Location | null
  /**
   * `state` for a link that stays *inside* the dialog — a settings section, the
   * sign-in/sign-up cross-links.
   *
   * Without it the hop clears `location.state`, `ModeRoutes` re-resolves at the
   * dialog's own path, falls through to `<Route path="*">` and renders the menu
   * — tearing down the mode mid-dialog and running its cleanup. `undefined` on
   * a cold load, because there is no background to carry and the dialog's own
   * location is not one.
   */
  readonly keep: OverlayLocationState | undefined
  /** Close: back to the mode behind, or to the menu when there is none. */
  readonly close: () => void
}

export function useOverlay(): Overlay {
  const location = useLocation()
  const navigate = useNavigate()
  const background = overlayBackground(location)

  const close = useCallback(() => {
    if (background === null) {
      void navigate(HOME)
      return
    }
    /*
     * `replace`, and to the background rather than `navigate(-1)`.
     *
     * Both land on the mode when the dialog was opened with one link and
     * closed immediately, but a dialog is not one entry: the settings sections
     * are routes, and a `-1` after two of them is a hop to the section before.
     * Naming the destination is the same answer however many hops happened
     * inside. `replace` because closing is not somewhere to come back to —
     * pushing meant Back re-opened the dialog you had just dismissed.
     */
    void navigate(
      {
        pathname: background.pathname,
        search: background.search,
        hash: background.hash,
      },
      { replace: true },
    )
  }, [background, navigate])

  return {
    background,
    keep: background === null ? undefined : overlayState(background),
    close,
  }
}
