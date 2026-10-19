import { useSyncExternalStore } from 'react'

/*
 * The way home, as a focus target the skip link can reach.
 *
 * Both menus carry the mark that links back to the front door — the IR menu on
 * a desktop, `CompactDock`'s bar on a phone — and only one is mounted at a
 * time. Each puts this id on that link and attaches `holdWayHome` as its ref,
 * and the skip link renders only while one is attached. Presence is counted
 * from the element rather than worked out from the route, because every reason
 * the menu is absent is a different condition held by a different owner: the
 * front door draws no menu, `Shift+H` clears the chrome, a cutscene unmounts
 * the mode, the runtime has not loaded. A link that skipped to nothing in any
 * of those would be a tab stop that does nothing when pressed.
 */

/** The `id` of the link back to the front door, in whichever menu is drawn. */
export const WAY_HOME = 'way-home'

let held = 0
let pending = false
const listeners = new Set<() => void>()

/*
 * Listeners hear about a change once the commit that made it is over.
 *
 * The IR menu's link sits under a `TooltipTrigger asChild`, and Radix's `Slot`
 * composes a fresh ref callback on every render — so every render of the menu
 * detaches the link and attaches it again, and the count passes through zero.
 * Told synchronously, the skip link would see "no menu" mid-commit and render
 * twice for nothing. A microtask later the count is back where it was and the
 * snapshot has not changed, so nothing renders.
 */
function notify(): void {
  if (pending) return
  pending = true
  queueMicrotask(() => {
    pending = false
    for (const listener of listeners) listener()
  })
}

/**
 * A ref callback for the way-home link: counts it while it is attached.
 *
 * A count rather than a flag, so the order in which a re-keyed menu — the IR
 * menu is keyed by its placement — or StrictMode's second attach detaches and
 * attaches its nodes cannot leave the answer wrong.
 */
export function holdWayHome(node: HTMLElement | null): (() => void) | void {
  if (node === null) return
  held += 1
  notify()
  return () => {
    held -= 1
    notify()
  }
}

/** Whether a way-home link is in the document. */
export function wayHomeHeld(): boolean {
  return held > 0
}

/** Hear about a change in `wayHomeHeld`, after the commit that made it. */
export function subscribeWayHome(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a way-home link is in the document, as a render input. False on the server. */
export function useWayHome(): boolean {
  return useSyncExternalStore(subscribeWayHome, wayHomeHeld, () => false)
}

/**
 * Move focus to the way-home link, if there is one.
 *
 * `preventScroll` because nothing here scrolls: the document is locked, and a
 * scroll attempt on a locked page is a jump nobody asked for.
 */
export function focusWayHome(): void {
  if (typeof document === 'undefined') return
  document.getElementById(WAY_HOME)?.focus({ preventScroll: true })
}
