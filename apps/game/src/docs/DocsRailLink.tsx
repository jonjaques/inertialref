import { Link } from 'react-router'
import { FOCUS_RING } from '../hud/focus.ts'

/**
 * One page in the rail.
 *
 * A hairline down the left rather than a filled row, which is the system's own
 * way of drawing structure — `DESIGN.md`'s Hairline Rule — and the reason the
 * rail can carry twenty-six of these without becoming a wall. The current page
 * lights that hairline and brightens its ink; nothing moves and nothing fills.
 *
 * Truncated with the full label in `title`, because a rail is fifteen rem wide
 * and `The Record With Holes In It` is not.
 */
export function DocsRailLink({
  to,
  label,
  current,
  head = false,
}: {
  to: string
  label: string
  current: boolean
  /** The page a group is named after: the same row, one grade brighter. */
  head?: boolean
}) {
  return (
    <li>
      <Link
        to={to}
        aria-current={current ? 'page' : undefined}
        title={label}
        className={`type-ui block truncate border-l py-[3px] pl-3 transition-colors ${FOCUS_RING} ${
          current
            ? 'border-sky-400 text-sky-200'
            : `border-slate-800 hover:border-slate-600 hover:text-sky-200 ${
                head ? 'text-slate-300' : 'text-slate-400'
              }`
        }`}
      >
        {label}
      </Link>
    </li>
  )
}
