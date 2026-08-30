import type { LucideIcon } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { OverlayLink } from './OverlayLink.tsx'
import { isOverlayPath } from './paths.ts'

/** A small, text-first link on the menu's bottom row. */
export function FooterLink({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: LucideIcon
  label: string
}) {
  const className = `flex min-h-6 items-center gap-1.5 rounded text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`
  const inner = (
    <>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </>
  )
  if (isOverlayPath(to)) {
    return (
      <OverlayLink to={to} className={className}>
        {inner}
      </OverlayLink>
    )
  }
  return (
    <a href={to} className={className}>
      {inner}
    </a>
  )
}
