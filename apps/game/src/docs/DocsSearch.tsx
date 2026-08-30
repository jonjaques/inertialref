import { useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { useAction, useKeyContext } from '../input/useKeymap.ts'
import type { DocWing } from './content.ts'
import { loadSearchIndex, type SearchIndex } from './content.ts'
import { searchDocs, type SearchHit } from './search.ts'
import { DocsSearchResult } from './DocsSearchResult.tsx'

/**
 * Search over nine hundred pages, with no server and no second index.
 *
 * The index is fetched the first time somebody focuses this field, not when the
 * section opens: it is half a megabyte, most readers arrive from a link and
 * leave from a link, and by the time a query exists the file has been in flight
 * for as long as it took to type one. Until it lands the field says so rather
 * than showing an empty result, which is the difference between "loading" and
 * "nothing matches" — two states that look identical if you let them.
 *
 * The list is a `listbox` the field owns rather than a menu the field opens:
 * focus never leaves the input, the arrows move an `aria-activedescendant`, and
 * Enter follows it. That is the pattern a combo box has, and it is what makes
 * the whole interaction one keystroke deep — type, arrow, Enter — instead of
 * type, Tab into a list, arrow, Enter.
 */
export function DocsSearch({ wings }: { wings: readonly DocWing[] }) {
  const field = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<SearchIndex | null>(null)
  const [loading, setLoading] = useState(false)
  const [at, setAt] = useState(0)
  const [open, setOpen] = useState(false)

  const hits: SearchHit[] =
    index === null || query.trim() === ''
      ? []
      : searchDocs(index, query, RESULTS)

  /*
   * Slash focuses the field, the way it does in every documentation site and
   * every code host, and `isTyping` is what stops it stealing the character
   * from anything already being typed into — including this field.
   *
   * Deliberately not a modifier chord. The reading room is a page of text with
   * no flight controls bound over it, so the single key is free here in a way
   * it is not anywhere else in this application.
   */
  /*
   * `/` focuses the field, and the reading room says so by being a context.
   *
   * Two things this replaces. The listener checked for an open dialog on every
   * keystroke, because a slash typed in Settings moved focus to a field behind
   * the scrim and these dialogs deliberately have no focus trap to fight it
   * back; the `dialog` context is more specific than `docs`, so the dispatcher
   * settles it without anybody querying the document. And the shell had to know
   * that this mode exists in order to keep `Space` from pausing the simulation
   * behind the words — that is `mutes` now, said here, once.
   */
  useKeyContext({ context: 'docs', mutes: ['time.pause'] })
  useAction('docs.search', () => field.current?.focus())

  const warm = (): void => {
    if (index !== null || loading) return
    setLoading(true)
    loadSearchIndex().then(
      (value) => {
        setIndex(value)
        setLoading(false)
      },
      () => setLoading(false),
    )
  }

  const go = (hit: SearchHit | undefined): void => {
    if (hit === undefined) return
    setOpen(false)
    setQuery('')
    field.current?.blur()
    window.location.assign(hit.route)
  }

  return (
    <>
      <label className="relative flex min-w-0 shrink items-center">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2 size-3.5 text-slate-400"
        />
        <input
          ref={field}
          type="search"
          role="combobox"
          aria-expanded={open && query.trim() !== ''}
          aria-controls="doc-search-results"
          aria-activedescendant={hits.length > 0 ? `doc-hit-${at}` : undefined}
          aria-label="Search the documentation"
          placeholder="Search"
          value={query}
          onFocus={() => {
            warm()
            setOpen(true)
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setAt(0)
            setOpen(true)
          }}
          /* A blur that lands on a result must not close the list before the
             click does. One frame is enough and does not need a pointer-down
             guard, which is the other way to write this and gets touch wrong. */
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setAt((current) => Math.min(current + 1, hits.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setAt((current) => Math.max(current - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              go(hits[at])
            } else if (event.key === 'Escape') {
              event.preventDefault()
              if (query === '') field.current?.blur()
              setQuery('')
              setOpen(false)
            }
          }}
          className={`type-ui w-28 rounded border border-slate-700 bg-slate-900/80 py-1 pr-2 pl-7 text-slate-200 transition-[width,border-color] focus:w-44 focus:border-sky-500/60 focus:outline-none sm:w-36 sm:focus:w-64 ${FOCUS_RING}`}
        />
      </label>

      {open && query.trim() !== '' && (
        <div
          id="doc-search-results"
          role="listbox"
          aria-label="Results"
          /* Denser than a panel's `/85`, because this one is over the article
             rather than over the scene: at 85% the table of contents behind it
             reads through as a second column of ghost text, and a result list
             you can see another list through is a list you cannot scan. */
          className="absolute top-full right-0 z-40 mt-1 max-h-[26rem] w-[30rem] max-w-full overflow-y-auto rounded-lg border border-slate-700/60 bg-slate-950/98 py-1 shadow-xl backdrop-blur-md"
        >
          {hits.length === 0 ? (
            <p className="type-ui px-3 py-2 text-slate-400">
              {loading
                ? 'Loading the index…'
                : index === null
                  ? 'The index could not be loaded.'
                  : 'Nothing matches every word of that.'}
            </p>
          ) : (
            hits.map((hit, position) => (
              <DocsSearchResult
                key={hit.route}
                hit={hit}
                wing={wings.find((wing) => wing.id === hit.wing)?.label ?? ''}
                id={`doc-hit-${position}`}
                active={position === at}
                onHover={() => setAt(position)}
                onPick={() => go(hit)}
              />
            ))
          )}
        </div>
      )}
    </>
  )
}

/** How many results fit before a list stops being a shortlist. */
const RESULTS = 8
