import { Droplets, Mountain, Wind } from 'lucide-react'
import { formatReading } from '@inertialref/shared'
import type { WorldMatch } from '@inertialref/universe'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { iconForKind } from './kinds.ts'

/**
 * One world a search found.
 *
 * Taller than a navigator row and deliberately: that list is a tree somebody
 * is scanning for a name they already know, and this is a list of places
 * somebody has never heard of, where the whole value is in the second line.
 * A row that said only "P221_4_0_a II" would be a search that found something
 * and refused to say what.
 *
 * The second line is what the query could have asked for and the reader can
 * see it did not have to: the star's class, how far, and the two or three
 * facts that make a world worth pressing. Icons rather than words for those,
 * because the same three appear on every row and three columns of prose is a
 * table where a glance should do.
 */
export function WorldRow({
  match,
  selected,
  onFocus,
}: {
  readonly match: WorldMatch
  readonly selected: boolean
  readonly onFocus: () => void
}) {
  const Glyph = iconForKind(match.kind)
  return (
    <button
      type="button"
      aria-current={selected}
      data-world-row=""
      title={match.address}
      onClick={(event) => {
        releaseFocus(event)
        onFocus()
      }}
      className={`flex w-full min-w-0 items-start gap-2.5 rounded px-1.5 py-1.5 text-left transition-colors ${FOCUS_RING} ${
        selected
          ? 'bg-sky-500/15 text-sky-100'
          : 'text-slate-300 hover:bg-slate-800/60 hover:text-sky-100'
      }`}
    >
      <Glyph aria-hidden className="mt-0.5 size-4 shrink-0 text-sky-400/80" />
      <span className="min-w-0 flex-1">
        <span className="type-ui block truncate">{match.name}</span>
        <span className="type-micro flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-400">
          {/* The system, because a world's name is only half an address and
              the reader may want the star rather than the planet. */}
          <span className="truncate">{match.systemName}</span>
          <span className="tabular-nums">{match.spectralType}</span>
          <span className="tabular-nums">{match.lightYears.toFixed(1)} ly</span>
          <span className="tabular-nums">{formatReading(match.radius)}</span>
          {match.hasAtmosphere && (
            <Wind aria-label="Has an atmosphere" className="size-3" />
          )}
          {match.hasSea && (
            <Droplets aria-label="Has a sea" className="size-3" />
          )}
          {match.landable && (
            <Mountain aria-label="Landable" className="size-3" />
          )}
          {match.moons > 0 && (
            <span className="tabular-nums">
              {match.moons} {match.moons === 1 ? 'moon' : 'moons'}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
