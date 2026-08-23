'use no memo'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { usePolled } from '../hud/usePolled.ts'
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

/** How far the survey reaches. A few hundred rows, re-read every two seconds. */
const SURVEY_LIGHT_YEARS = 16

export function CataloguePanel({ engine, target, focus }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  /*
   * Centered on the camera, not on the ship.
   *
   * `look` moves a camera and nothing else, which is the planetarium's whole
   * verb — so "you" in this mode is the eye, and it can be four light years
   * from the hull. Centered on the player, this list opened at Alpha Centauri
   * still ordered by distance from Earth: Sol's moons at the top, and the star
   * filling the frame reported as 4.4 ly away, twenty rows down. Sorted from
   * the eye, the thing you are looking at is the first thing in the list and
   * its neighbors are the next ones — which is what makes a catalog a way of
   * traveling rather than a table.
   */
  const targets = usePolled(
    () =>
      engine.harness.targets({
        lightYears: SURVEY_LIGHT_YEARS,
        origin: 'observer',
      }),
    2,
  )

  /*
   * Filtered here rather than by the harness, because `travelTargets` is a
   * *survey* — it costs a star sweep — and re-running it per keystroke would
   * put a 16 light-year query behind every letter typed. The list is a few
   * hundred rows; filtering it in the client is free.
   */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return targets
    return targets.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.address.toLowerCase().includes(needle),
    )
  }, [targets, query])

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
          <li className="px-1 py-2 text-slate-400">
            nothing within {SURVEY_LIGHT_YEARS} ly matches that
          </li>
        )}
      </ul>
    </div>
  )
}
