import type { KeymapStore } from './keymapStore.ts'
import type { PadNavigator } from './padDriver.ts'

/*
 * The pad in the interface: the d-pad moves the focus, ✕ presses, ○ backs out.
 *
 * Fixed rather than rebindable, for the reason `Tab` and `Escape` are on the
 * keyboard: moving through an interface is the platform's gesture, and a pad
 * whose d-pad had been rebound away from it would have no way back into the
 * page that rebinds it.
 *
 * Spatial rather than sequential. A d-pad has four directions and the tab
 * order has two, so "down" walking the tab order lands wherever the DOM
 * happens to put the next control — across a panel, into a header — while the
 * picture of the interface says the control below is the one below. The
 * choice is a pure function of rectangles (`nearestInDirection`), tested in
 * Node; what is here is reading the document.
 */

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * The candidate a step in `direction` lands on, or null when none is that way.
 *
 * A candidate must lie ahead of the current control's center; among those,
 * the gap along the direction plus twice the offset across it wins. The factor
 * of two is what makes "down" prefer the control directly below over a nearer
 * one off to the side — the rule a reader applies without thinking, and the
 * one a plain distance gets wrong in every two-column panel.
 */
export function nearestInDirection<T>(
  from: Box,
  candidates: readonly { readonly item: T; readonly box: Box }[],
  direction: Direction,
): T | null {
  const fromX = (from.left + from.right) / 2
  const fromY = (from.top + from.bottom) / 2
  let best: T | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const { item, box } of candidates) {
    const x = (box.left + box.right) / 2
    const y = (box.top + box.bottom) / 2
    const vertical = direction === 'up' || direction === 'down'
    const ahead =
      direction === 'down'
        ? y - fromY
        : direction === 'up'
          ? fromY - y
          : direction === 'right'
            ? x - fromX
            : fromX - x
    if (ahead <= 1) continue
    const gap = Math.max(
      direction === 'down'
        ? box.top - from.bottom
        : direction === 'up'
          ? from.top - box.bottom
          : direction === 'right'
            ? box.left - from.right
            : from.left - box.right,
      0,
    )
    const across = vertical
      ? spanGap(from.left, from.right, box.left, box.right)
      : spanGap(from.top, from.bottom, box.top, box.bottom)
    const score = gap + across * 2
    if (score < bestScore) {
      bestScore = score
      best = item
    }
  }
  return best
}

/** How far apart two spans are along one axis; zero when they overlap. */
function spanGap(a0: number, a1: number, b0: number, b1: number): number {
  if (b1 < a0) return a0 - b1
  if (b0 > a1) return b0 - a1
  return 0
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="slider"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Whether a control is on screen and reachable at all. */
function reachable(element: HTMLElement): boolean {
  if (element.closest('[inert], [aria-hidden="true"]') !== null) return false
  if (element.getClientRects().length === 0) return false
  return getComputedStyle(element).visibility !== 'hidden'
}

/** A control that takes left and right itself, rather than moving the focus. */
function adjustable(element: HTMLElement): boolean {
  return (
    element.getAttribute('role') === 'slider' ||
    (element instanceof HTMLInputElement && element.type === 'range')
  )
}

/** The nearest ancestor that scrolls, or the document's scroller. */
function scroller(from: Element | null): Element | null {
  for (let at = from; at !== null; at = at.parentElement) {
    if (at.scrollHeight <= at.clientHeight + 1) continue
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return document.scrollingElement
}

/**
 * The navigator over this document, deciding by the keymap's live contexts.
 *
 * The interface owns the pad's navigation controls in three places: over a
 * dialog, on a page that is a document (the front door and the reading room),
 * and wherever a panel control already holds the focus — which is how a pad
 * gets into the dock from a mode, through `chrome.focus`, and how ○ gets it
 * back out to the scene.
 */
export function domNavigator(store: KeymapStore): PadNavigator {
  const live = (context: string): boolean =>
    (store.live as readonly string[]).includes(context)
  const page = (): boolean => live('menu') || live('docs')
  const focused = (): HTMLElement | null => {
    const active = document.activeElement
    return active instanceof HTMLElement && active !== document.body
      ? active
      : null
  }
  const inPanels = (): boolean =>
    focused()?.closest('.hud-layer') != null && !live('dialog')
  const controls = (): HTMLElement[] => {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]')
    const top = dialogs[dialogs.length - 1]
    const roots: readonly ParentNode[] =
      live('dialog') && top !== undefined
        ? [top]
        : page()
          ? [document]
          : [...document.querySelectorAll<HTMLElement>('.hud-layer')]
    return roots
      .flatMap((root) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)])
      .filter(reachable)
  }

  return {
    owns: () => live('dialog') || page() || inPanels(),

    move(direction) {
      const current = focused()
      const candidates = controls()
      if (current === null || !candidates.includes(current)) {
        focus(candidates[0])
        return
      }
      if (
        (direction === 'left' || direction === 'right') &&
        adjustable(current)
      ) {
        // The slider's own keys, so it steps exactly as it does for a
        // keyboard — its step, its bounds, its announcement.
        const key = direction === 'left' ? 'ArrowLeft' : 'ArrowRight'
        current.dispatchEvent(
          new KeyboardEvent('keydown', { key, code: key, bubbles: true }),
        )
        return
      }
      const next = nearestInDirection(
        current.getBoundingClientRect(),
        candidates
          .filter((one) => one !== current)
          .map((item) => ({ item, box: item.getBoundingClientRect() })),
        direction,
      )
      focus(next ?? undefined)
    },

    activate() {
      focused()?.click()
    },

    // Over a dialog the right button is the keymap's — `overlay.close` is
    // bound to it — so the navigator only claims it to leave the panels.
    canBack: () => inPanels(),

    back() {
      focused()?.blur()
    },

    scroll(pixels) {
      scroller(focused() ?? controls()[0] ?? null)?.scrollBy({ top: pixels })
    },
  }
}

/**
 * Focus a control and say so with the ring.
 *
 * `focusVisible`, because the browser's heuristic decides the ring from the
 * last *keyboard or pointer* event and a pad is neither — so without it a
 * focus moved by the d-pad would be invisible on exactly the hardware that
 * cannot see where it is any other way.
 */
function focus(element: HTMLElement | undefined): void {
  if (element === undefined) return
  element.focus({ preventScroll: false, focusVisible: true } as FocusOptions)
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
