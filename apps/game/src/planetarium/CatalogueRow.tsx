import { Circle, Globe, Star } from 'lucide-react'
import type { TravelTarget } from '@inertialref/devtools'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'

/** One row of the catalog: a glyph for what it is, a name, a distance. */
export function CatalogueRow({
  row,
  selected,
  onFocus,
}: {
  row: TravelTarget
  selected: boolean
  onFocus: () => void
}) {
  const Glyph = row.kind === 'system' ? Star : row.depth > 1 ? Circle : Globe
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={(event) => {
          releaseFocus(event)
          onFocus()
        }}
        style={{ paddingLeft: `${row.depth * 0.75 + 0.25}rem` }}
        className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left transition-colors ${FOCUS_RING} ${
          selected
            ? 'bg-sky-500/15 text-sky-200'
            : 'text-slate-300 hover:bg-slate-800/60 hover:text-sky-200'
        }`}
      >
        <Glyph
          aria-hidden
          className={`size-3 shrink-0 ${
            // Loaded means the system is generated and its frames installed —
            // the difference between a star you can look at and one that is
            // still a stub in the catalog.
            row.loaded ? 'text-sky-400/80' : 'text-slate-400'
          }`}
        />
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        <span className="type-micro shrink-0 text-slate-400">
          {row.distanceText}
        </span>
      </button>
    </li>
  )
}
