import type { Satellite } from '@inertialref/devtools'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { iconForKind } from './kinds.ts'

/**
 * A body going round this one, as a place you can go.
 *
 * It is the only way to reach a moon drawn *over* its planet: the hit test
 * takes the largest disk the pointer is inside, so a moon in front of Jupiter
 * is not clickable in the sky (`pick.ts` states the trade and why it is the
 * right way round). Which makes this list a navigation control rather than a
 * census, and is why each row is a button and the radius is quoted in
 * kilometers — the number that tells one of Jupiter's ninety-five apart.
 */
export function SatelliteRow({
  moon,
  selected,
  onFocus,
}: {
  moon: Satellite
  selected: boolean
  onFocus: () => void
}) {
  const Glyph = iconForKind(moon.kind)
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={(event) => {
          releaseFocus(event)
          onFocus()
        }}
        className={`flex min-h-7 w-full items-center gap-2 rounded px-1 text-left transition-colors ${FOCUS_RING} ${
          selected
            ? 'bg-sky-500/15 text-sky-100'
            : 'text-slate-300 hover:bg-slate-800/60 hover:text-sky-100'
        }`}
      >
        <Glyph aria-hidden className="size-3.5 shrink-0 text-slate-500" />
        <span className="type-ui min-w-0 flex-1 truncate">{moon.name}</span>
        <span className="type-micro shrink-0 text-slate-500 tabular-nums">
          {Math.round(moon.radius / 1000)} km
        </span>
      </button>
    </li>
  )
}
