import { useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTravelTargets } from '../hud/useTravelTargets.ts'
import { CatalogueRow } from './CatalogueRow.tsx'
import type { PlanetariumContext } from './context.ts'

/*
 * Everything within reach, nearest first.
 *
 * A thin reading of the harness — `ir.targets()` — and nothing here holds a
 * fact the engine does not already own. That is the rule every panel in this
 * mode follows and it is worth restating because a planetarium is exactly the
 * kind of interface that grows a parallel model of the universe in component
 * state: a cached list of systems that is one jump out of date, a selected
 * object that disagrees with the camera. The panels poll; the harness answers.
 */

/** How far the survey reaches when nothing has been typed. */
const SURVEY_LIGHT_YEARS = 16

export function CataloguePanel({ engine, target, focus }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  /*
   * Two questions, one hook (`hud/useTravelTargets.ts`).
   *
   * Empty: the survey, centered on the camera, not on the ship. `look` moves a
   * camera and nothing else, which is the planetarium's whole verb — so "you"
   * in this mode is the eye, and it can be four light years from the hull.
   * Centered on the player, this list opened at Alpha Centauri still ordered by
   * distance from Earth: Sol's moons at the top, and the star filling the frame
   * reported as 4.4 ly away, twenty rows down.
   *
   * Typed: the catalog's own index, over all 150 light years. This used to
   * filter the survey's result with `.includes()`, so the search box could only
   * find what was already within sixteen light years of the camera — a star
   * ninety light years out was not merely hard to find, it was unreachable by
   * name.
   */
  const { rows, ready } = useTravelTargets(engine, {
    lightYears: SURVEY_LIGHT_YEARS,
    origin: 'observer',
    query,
    refreshMs: 500,
  })

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <label className="flex items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 focus-within:border-sky-500/60">
        <Search aria-hidden className="size-3 shrink-0 text-slate-400" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or address"
          aria-label="Search the catalog"
          // `md:type-readout` beside the bare step: the Input base carries
          // `md:text-sm`, which only merges against an equally modified class.
          // `lib/utils.ts` has the whole story.
          className="type-readout md:type-readout h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <span className="type-micro shrink-0 text-slate-400">
          {rows.length}
        </span>
      </label>

      <ul className="flex flex-col">
        {rows.map((row) => (
          <CatalogueRow
            key={row.address}
            row={row}
            selected={row.address === target}
            onFocus={() => focus(row.address)}
          />
        ))}
        {rows.length === 0 && (
          /*
           * Three different answers, not one. "Surveying…" and "there is
           * nothing here" have different next steps, and the empty state used
           * to give the second for both. The typed case is a third: it is the
           * whole catalog now, so "no star is called that" is a fact rather
           * than a statement about how far the survey reached.
           */
          <li className="px-1 py-2 text-slate-400">
            {!ready
              ? 'surveying…'
              : query.trim() === ''
                ? `nothing within ${SURVEY_LIGHT_YEARS} ly`
                : 'no cataloged star is called that'}
          </li>
        )}
      </ul>
    </div>
  )
}
