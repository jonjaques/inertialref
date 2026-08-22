import { Link } from 'react-router'
import type { LucideIcon } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'

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
  return (
    <Link
      to={to}
      className={`flex min-h-6 items-center gap-1.5 rounded text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </Link>
  )
}
