import type { MouseEvent } from 'react'

/*
 * Who owns the keyboard, and when.
 *
 * Its own module rather than a corner of `widgets.tsx` because Fast Refresh
 * treats a file that exports both components and plain functions as neither,
 * and every control in the overlay imports this.
 */

/**
 * The focus ring, once.
 *
 * The system had no focus style at all while every control blurred itself on
 * click — there was never a focused control to draw one on. `releaseFocus`
 * changes that, so this exists, and it is a 1px outline in the accent rather
 * than a ring with an offset because a hairline in Instrument Blue is how the
 * rest of the system draws structure. No glow, no offset, nothing that moves.
 */
export const FOCUS_RING =
  'focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400'

/**
 * Hand focus back to the flight loop — but only when a pointer took it.
 *
 * Flight input is a window-level keydown handler, so a *clicked* button that
 * keeps focus swallows Space, the pause key, and turns it into a second click
 * on itself. That is the whole reason every control in this overlay blurs
 * itself, and it is real.
 *
 * Blurring unconditionally solves it by making the dock untraversable: a
 * keyboard user who activates anything is returned to the top of the document
 * and has to tab back in, which across five tabs of collapsible sections is not
 * navigation. `detail` is the click count, and a click synthesised from Enter
 * or Space on a focused button reports 0 in every engine — so a pointer keeps
 * the old behaviour exactly and a keyboard keeps its place.
 *
 * Keeping its place is only worth anything because `useShipControls` declines
 * Space when the keystroke is aimed at a control inside `.hud-layer`. Without
 * that guard the window handler's `preventDefault` cancels the activation on
 * keydown — before the click event exists — so a focused button did not
 * "swallow Space" at all: it never saw it, and the simulation paused instead.
 */
export function releaseFocus(event: MouseEvent<HTMLElement>): void {
  if (event.detail > 0) event.currentTarget.blur()
}
