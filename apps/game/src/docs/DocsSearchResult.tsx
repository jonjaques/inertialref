import { CornerDownLeft } from 'lucide-react'
import type { SearchHit } from './search.ts'

/**
 * One result: where it is, what it is called, and which part of it matched.
 *
 * The section line is the half that earns the row. A search for "quadtree"
 * returns `Terrain level of detail`, which is correct and not yet useful — the
 * document is four thousand words long. Naming the heading that matched, and
 * linking to it rather than to the top of the page, is the difference between a
 * result and an answer.
 *
 * A `div` with a role rather than a link, because the field owns the focus for
 * the whole interaction: `aria-activedescendant` on the input points here, and
 * an anchor would be a tab stop competing with it. Enter in the field follows
 * this row, which is the same navigation by a shorter path.
 */
export function DocsSearchResult({
  hit,
  wing,
  id,
  active,
  onHover,
  onPick,
}: {
  hit: SearchHit
  /** Which wing it is in, named the way the rail names it. */
  wing: string
  id: string
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      // `onMouseDown` rather than `onClick`: the field's blur fires first and
      // would close this list out from under the click.
      onMouseDown={(event) => {
        event.preventDefault()
        onPick()
      }}
      className={`flex cursor-pointer items-baseline gap-2.5 px-3 py-1.5 ${
        active ? 'bg-sky-500/15' : ''
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={`type-ui truncate ${active ? 'text-sky-200' : 'text-slate-200'}`}
          >
            {hit.title}
          </span>
          {/* Which wing, named the way the rail names it. Not a coloured
              chip: five wings' worth of colour in a dropdown is five colours
              this system does not have, and the word is the information. */}
          <span className="type-label shrink-0 text-slate-400">{wing}</span>
        </span>
        <span className="type-micro mt-0.5 block truncate text-slate-400">
          {hit.section?.text ?? hit.lead}
        </span>
      </span>
      {active && (
        <CornerDownLeft
          aria-hidden
          className="size-3 shrink-0 text-sky-300/70"
        />
      )}
    </div>
  )
}
