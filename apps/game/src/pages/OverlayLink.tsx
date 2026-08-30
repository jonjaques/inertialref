import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { useOverlayStore } from './overlay.ts'

/*
 * A dialog with an address, opened without leaving the document.
 *
 * A mode link is an `<a href>` — the next page is a document, and a click
 * loads it. A dialog is not: following `/settings` as a document from the
 * planetarium would unmount the planetarium, drop the observatory's target
 * and rebuild the renderer. This intercepts the unmodified click and
 * `pushState`s (or `replaceState`s, for a hop inside the dialog). A modified
 * click — new tab, new window, download — is the browser's.
 */

function modified(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  )
}

export function OverlayLink({
  to,
  replace = false,
  children,
  onClick,
  ...rest
}: {
  to: string
  /** Stay inside the dialog: a settings tab, the sign-in/sign-up cross-link. */
  replace?: boolean
  children: ReactNode
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const open = useOverlayStore((state) => state.open)
  const hop = useOverlayStore((state) => state.hop)
  return (
    <a
      href={to}
      {...rest}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || modified(event)) return
        event.preventDefault()
        if (replace) hop(to)
        else open(to)
      }}
    >
      {children}
    </a>
  )
}
