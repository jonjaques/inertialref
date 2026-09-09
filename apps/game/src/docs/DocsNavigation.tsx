import { House, SlidersHorizontal } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { FOCUS_RING } from '../hud/focus.ts'
import { FooterLink } from '../pages/FooterLink.tsx'
import {
  HOME,
  SETTINGS,
  overlayState,
  resolvedLocation,
} from '../pages/paths.ts'

/** The reading room has an exit before the live workspace is available. */
export function DocsNavigation() {
  const here = resolvedLocation(useLocation())
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <nav
        aria-label="Documentation shortcuts"
        className="type-ui pointer-events-auto flex items-center gap-5 rounded-lg border border-slate-700/60 bg-slate-950/90 px-4 py-2 text-slate-400"
      >
        <FooterLink to={HOME} icon={House} label="Home" />
        <Link
          to={SETTINGS}
          state={overlayState(here)}
          className={`flex min-h-6 items-center gap-1.5 rounded transition-colors hover:text-sky-200 ${FOCUS_RING}`}
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
          Settings
        </Link>
      </nav>
    </div>
  )
}
