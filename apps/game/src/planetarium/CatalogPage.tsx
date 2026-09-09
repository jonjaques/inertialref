'use no memo'
import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Search, X } from 'lucide-react'
import { isEmptyQuery, type WorldQuery } from '@inertialref/universe'
import { Action } from '../hud/Action.tsx'
import type { GameEngine } from '../engine/GameEngine.ts'
import { OverlayPage } from '../pages/OverlayPage.tsx'
import { PLANETARIUM, QUERY } from '../pages/paths.ts'
import { WorldQueryControls } from './WorldQueryControls.tsx'
import { WorldRow } from './WorldRow.tsx'
import { describeQuery } from './worldQuery.ts'
import { withoutPictureLink } from './presetUrl.ts'
import { useWorldSearch } from './useWorldSearch.ts'

/*
 * The catalog, as the question the navigator cannot ask.
 *
 * The navigator answers "where is the thing I can name" — a survey by
 * distance, a fuzzy index over names, both of them instant. This is the other
 * half: *what is out there like this*, over a volume nobody has looked at,
 * which is not a lookup at all. Every system inside the radius has to be built
 * before it can be tested, so the answer arrives over seconds rather than
 * keystrokes, and the interface's whole job is to make that legible instead of
 * hiding it behind a spinner.
 *
 * So it is a dialog rather than a panel. A panel that took four seconds to
 * answer inside a dock column would be a panel that looks broken; a dialog is
 * a thing you opened on purpose, with room for the controls the question needs
 * and for the count that says how far along it is.
 *
 * **The rows are windowed**, for the reason the navigator's are: a fifty
 * light-year sweep can answer with thousands, and reconciling them beside a
 * running renderer is the stutter, not the search.
 *
 * `'use no memo'`: the list reads the virtualizer, whose methods read scroll
 * position — mutable state outside React.
 */

/** The height every result row is assumed to be until it is measured. */
const ROW_HEIGHT = 44

export function CatalogPage({ engine }: { engine: GameEngine }) {
  const [query, setQuery] = useState<WorldQuery>({ kinds: ['rocky'] })
  const [radius, setRadius] = useState('25')
  const search = useWorldSearch(engine)
  const scroller = useRef<HTMLDivElement>(null)
  const [params] = useSearchParams()
  const navigate = useNavigate()

  const rows = useVirtualizer({
    count: search.matches.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    getItemKey: (index) => search.matches[index]?.address ?? index,
  })

  /**
   * Open a result, which means leaving.
   *
   * A search is a way of getting somewhere, so pressing a row points the
   * camera at it and closes the dialog — the alternative is a modal the reader
   * has to dismiss after every result, which turns "look at that one" into two
   * acts. The address goes through the mode's own URL, so the back button
   * still works and the view is still a link.
   */
  const open = (address: string): void => {
    search.stop()
    const next = withoutPictureLink(params)
    next.set(QUERY.at, address)
    void navigate(
      { pathname: PLANETARIUM, search: next.toString() },
      { replace: true },
    )
  }

  const empty = isEmptyQuery(query)
  const found = search.matches.length
  // What the cap is holding back, so a short list is never mistaken for a
  // search that found little.
  const beyond = search.total - found

  return (
    <OverlayPage
      title="Catalog"
      subtitle="Search the volume for worlds by what they are"
      wide
      modal
      fill
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
        {/* The controls scroll on their own where the dialog is short, so a
            phone can reach the radius without the results moving. */}
        <div className="flex shrink-0 flex-col gap-3 overflow-y-auto sm:w-72">
          <WorldQueryControls
            query={query}
            radius={radius}
            onQuery={setQuery}
            onRadius={setRadius}
          />
          <div className="flex items-center gap-2">
            <Action
              label={search.running ? 'Searching…' : 'Search'}
              tone="primary"
              /*
               * Refused rather than hidden, and refused for a reason the
               * tooltip gives: a query asking for nothing matches every body
               * in the volume, which is tens of thousands of rows and mostly
               * rubble. It is a real answer and a useless one.
               */
              disabled={empty || search.running}
              title={
                empty
                  ? 'Choose at least one thing to look for'
                  : `Build and test every system within ${radius} light years`
              }
              onClick={() => search.run(query, Number(radius))}
            />
            {search.running && (
              <Action
                label="Stop"
                title="Stop the sweep"
                onClick={search.stop}
              />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2 border-b border-slate-800 pb-1.5">
            <span className="type-label truncate text-sky-400/80">
              {describeQuery(query)}
            </span>
            {/* The count and the progress in one line, because they are one
                fact: "84 so far, two thirds of the way through 1,378 systems"
                is what a reader needs to know whether to keep waiting. */}
            <span className="type-micro shrink-0 text-slate-400 tabular-nums">
              {search.asked === null
                ? `${search.systems || ''}`
                : `${search.total.toLocaleString('en-US')} found${beyond > 0 ? `, nearest ${found}` : ''} · ${Math.round(search.progress * 100)}% of ${search.systems.toLocaleString('en-US')} systems`}
            </span>
          </div>

          {/* A bar rather than a spinner: a sweep has a known size, and a
              control that says how far along it is lets somebody decide to
              wait. It is `aria-hidden` because the line above already says the
              same thing in words a screen reader can read. */}
          {search.running && (
            <div
              aria-hidden
              className="h-0.5 w-full overflow-hidden rounded-full bg-slate-800"
            >
              <div
                className="h-full rounded-full bg-sky-400/80 transition-[width] duration-200"
                style={{ width: `${Math.round(search.progress * 100)}%` }}
              />
            </div>
          )}

          <div
            ref={scroller}
            className="scroll-cue min-h-48 flex-1 overflow-auto"
          >
            {found === 0 ? (
              <p className="type-ui px-1 py-6 text-pretty text-slate-400">
                {search.asked === null ? (
                  <>
                    <Search aria-hidden className="mr-1.5 inline size-3.5" />
                    Choose what to look for and search. Every system in the
                    radius is generated and tested, so a wide sweep takes a few
                    seconds.
                  </>
                ) : search.running ? (
                  'Building systems…'
                ) : (
                  <>
                    <X aria-hidden className="mr-1.5 inline size-3.5" />
                    Nothing within {radius} light years answers that. Widen the
                    radius, or ask for less.
                  </>
                )}
              </p>
            ) : (
              <ul
                className="relative w-full"
                style={{ height: rows.getTotalSize() }}
              >
                {rows.getVirtualItems().map((item) => {
                  const match = search.matches[item.index]
                  if (match === undefined) return null
                  return (
                    <li
                      key={item.key}
                      data-index={item.index}
                      ref={rows.measureElement}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <WorldRow
                        match={match}
                        selected={false}
                        onFocus={() => open(match.address)}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </OverlayPage>
  )
}
