import type { MouseEvent } from 'react'

/*
 * Who owns the keyboard, and when.
 *
 * Its own module rather than a corner of a component file, because Fast Refresh
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
 * the old behavior exactly and a keyboard keeps its place.
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

/**
 * Whether the keystroke belongs to something being typed into.
 *
 * Every window-level key listener needs this same refusal — flight input,
 * the workspace keys, the cinema transport — and it lives here rather than in
 * any one of them because the failure mode of a fork is silent: a new editable
 * target added to one copy and not the others leaves H, Space or an arrow
 * firing mid-typing in whichever handler was missed. The keys are not
 * remapped and the field is not special — a handler simply declines to read
 * input aimed elsewhere.
 *
 * With no DOM at all — the test suite, which runs in plain Node by design —
 * nothing is being typed into, and saying so is what lets the dispatcher's
 * decisions be asserted there rather than only in a browser.
 */
export function isTyping(event: KeyboardEvent): boolean {
  if (typeof HTMLElement === 'undefined') return false
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Whether the keystroke is aimed at a control in the overlay.
 *
 * The keys that have to ask are the ones a focused control also answers:
 * Space activates a button, and a window-level `preventDefault` on keydown
 * cancels that activation before the click event that would have carried it
 * ever exists — so a handler that did not decline left a focused button doing
 * nothing, silently, while the simulation paused underneath. The arrows are
 * the same conflict through Radix: a focused slider or toggle group owns them
 * for stepping and roving focus. `releaseFocus` depends on this guard — it
 * deliberately keeps focus after a keyboard activation, which is only
 * navigable if the focused control still hears its own keys.
 *
 * From the canvas or the body — where focus is during flight, because every
 * control hands it straight back on a *pointer* click — nothing declines. So
 * does a run with no DOM; see `isTyping`.
 */
export function isOverlayControl(event: KeyboardEvent): boolean {
  if (typeof HTMLElement === 'undefined') return false
  const target = event.target
  return target instanceof HTMLElement && target.closest('.hud-layer') !== null
}
