import { Link } from 'react-router'
import { DOCS, HOME } from '../pages/paths.ts'

/**
 * The way out of a cover.
 *
 * A boot is five seconds on a good machine and longer on a phone, and a
 * black screen with no door is a screen somebody closes. The two places that
 * are readable without a renderer — the front door and the documentation —
 * are offered from the cover's bottom corner, opposite the ledger, in the
 * grade of a footer rather than of a call to action: the wait is the point of
 * the screen, and these are for the person who has decided not to.
 *
 * The same two links on the server-rendered admission and on the runtime's
 * cover, so the hand-off between them moves nothing a pointer was heading
 * for. Bottom right rather than bottom left, because the flight strip lands
 * in the left corner the moment the cover lifts, and chrome that stands where
 * the strip is about to reads as the strip's own text changing.
 */
export function BootNav() {
  return (
    <nav
      aria-label="Explore InertialRef"
      className="type-ui flex gap-5 text-slate-400"
    >
      <Link className="transition-colors hover:text-sky-300" to={HOME}>
        Home
      </Link>
      <Link className="transition-colors hover:text-sky-300" to={DOCS}>
        Documentation
      </Link>
    </nav>
  )
}
