import { useOverlayStore } from './overlay.ts'

/*
 * The React binding for the overlay store.
 *
 * `overlay.ts` holds the arithmetic — open, hop, close, the warm/cold
 * distinction — because that half is testable in Node. This is the hook
 * OverlayPage calls, so a dialog's close button returns to the mode it was
 * opened over rather than to the menu.
 */

export interface Overlay {
  /** Close: back to the mode behind, or to the menu document when there is none. */
  readonly close: () => void
}

export function useOverlay(): Overlay {
  const close = useOverlayStore((state) => state.close)
  return { close }
}
