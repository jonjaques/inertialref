import { FOCUS_RING } from '../hud/focus.ts'
import type { DocWing } from './content.ts'

/**
 * One of the five wings, at the top of the rail.
 *
 * Set in the display face, which is the same rule the IR menu follows beside
 * the mark and the mode cards follow on the front door: a wing is a *place*,
 * and naming places is what that face does in this system. It is what keeps the
 * five names from reading as five more entries in the list of pages underneath
 * them.
 *
 * The current one carries an accent bar rather than a fill. A filled row here
 * would be the largest block of colour in the rail and would compete with the
 * selected *page* three lines below it, which is the thing the reader is
 * actually tracking.
 */
export function DocsWingLink({
  wing,
  to,
  current,
}: {
  wing: DocWing
  to: string
  current: boolean
}) {
  return (
    <li>
      <a
        href={to}
        aria-current={current ? 'true' : undefined}
        title={wing.blurb}
        className={`flex items-center gap-2 rounded border-l-2 py-1 pl-2.5 transition-colors ${FOCUS_RING} ${
          current
            ? 'border-sky-400 text-sky-200'
            : 'border-transparent text-slate-300 hover:border-slate-600 hover:text-sky-200'
        }`}
      >
        <span className="type-title text-[0.9375rem]">{wing.label}</span>
      </a>
    </li>
  )
}
