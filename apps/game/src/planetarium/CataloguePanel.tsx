import { useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTravelTargets } from '../hud/useTravelTargets.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { isBoolean, oneOf, usePersistentState } from '../hud/panelState.ts'
import { CatalogueRow } from './CatalogueRow.tsx'
import { NeighbourhoodRail } from './NeighbourhoodRail.tsx'
import type { PlanetariumContext } from './context.ts'
import {
  groupBySystem,
  indentOf,
  measureOf,
  neighbours,
  systemOfAddress,
} from './catalogue.ts'
import { ALL_CLASSES, OBJECT_CLASSES } from './kinds.ts'

/*
 * Everything within reach, and a way through it.
 *
 * A thin reading of the harness — `ir.targets()` — and nothing here holds a
 * fact the engine does not already own. That is the rule every panel in this
 * mode follows and it is worth restating because a planetarium is exactly the
 * kind of interface that grows a parallel model of the universe in component
 * state: a cached list of systems that is one jump out of date, a selected
 * object that disagrees with the camera. The panels poll; the harness answers.
 *
 * What is *not* thin is the arrangement, and it stopped being optional when Sol
 * went from eight bodies to a hundred and twenty-nine. A flat, unfoldable,
 * unfilterable list of everything within sixteen light years puts sixty-six
 * asteroids and comets between the reader and the next star along, in the order
 * the addresses were issued. Three controls fix that and each one earns its
 * height:
 *
 *   the folds     one line per system until you ask for more
 *   the classes   six chips; turning off the rubble is the single most useful
 *                 press in this panel
 *   the radius    how far the survey sweeps, because "what is near me" and
 *                 "what is within fifty light years" are different questions
 *
 * The grouping and the ordering are pure functions in `catalogue.ts` and are
 * tested there. This file is the controls and the layout.
 */

/** How far the survey reaches. The radii a person actually asks for. */
const RADII = ['5', '10', '25', '50'] as const

/** Where it opens: far enough to hold the nearest half-dozen stars. */
const DEFAULT_RADIUS = '10'

/** One allocation for every collapsed group, rather than one per group. */
const NOTHING_VISIBLE: ReadonlySet<string> = new Set()

export function CataloguePanel({ engine, target, focus }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  const [radius, setRadius] = usePersistentState<string>(
    'planetarium.catalogue.radius',
    DEFAULT_RADIUS,
    oneOf(RADII),
  )
  const [classes, setClasses] = usePersistentState<readonly string[]>(
    'planetarium.catalogue.classes',
    ALL_CLASSES,
    // Membership in the live set, not merely "an array of strings". The point
    // of a validator here is the value that survives a *rename* — a stored id
    // no chip answers to parses perfectly and quietly hides a whole class.
    (value): value is readonly string[] =>
      Array.isArray(value) &&
      value.every(
        (one) => typeof one === 'string' && ALL_CLASSES.includes(one),
      ),
  )
  const [filtering, setFiltering] = usePersistentState(
    'planetarium.catalogue.filtering',
    false,
    isBoolean,
  )
  /*
   * The systems the reader has decided about, and what they decided.
   *
   * A map rather than a list of open addresses, so the default keeps applying
   * to everything nobody has touched: the system the camera is in is open,
   * every other is one line, and arriving somewhere new opens it without
   * anything having to notice.
   *
   * A *set of exceptions* is the shape that looks equivalent and is not. Its
   * stored bit is a polarity against a default that moves with the camera, so
   * every recorded exception inverts the moment `opensByDefault` changes:
   * expand Proxima from Sol, click into it, and it collapses on arrival —
   * closing the thing the click was for. An explicit `open`/`closed` means the
   * same on both sides of a jump.
   */
  const [decided, setDecided] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  )

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
   * Typed: the catalog's own index, over all 150 light years. Filtering the
   * survey's result with `.includes()` made the search box a search of a
   * sixteen-light-year bubble, so a star ninety light years out was not merely
   * hard to find, it was unreachable by name.
   */
  const lightYears = Number(radius)
  const { rows, ready, failure } = useTravelTargets(engine, {
    lightYears,
    origin: 'observer',
    query,
    refreshMs: 500,
  })

  const searching = query.trim() !== ''
  /*
   * The chips filter the survey and never the search.
   *
   * `searchTargets` answers with star rows and nothing else — there are no body
   * rows to keep a group alive — so with "Stars" off `groupBySystem` dropped
   * every hit and the panel stated "no charted star is called that" about a
   * star it had just been handed. The copy under the chips already promises
   * this ("a search reaches the whole catalog whatever this says"); the code
   * now agrees with it.
   */
  const groups = groupBySystem(rows, searching ? ALL_CLASSES : classes)
  const near = neighbours(rows, lightYears)
  /*
   * What the filter took, counted against the survey rather than against what
   * survived it: a system whose star *and* whose every body were filtered out
   * is gone from `groups` entirely, so summing over `groups` cannot see it.
   */
  const kept = groups.reduce(
    (total, group) => total + 1 + group.bodies.length,
    0,
  )
  const hidden = rows.length - kept
  const narrowed = classes.length > 0 && classes.length < OBJECT_CLASSES.length

  /*
   * The system the camera is in, taken from the address rather than by scanning
   * the rows that survived the filter — turning off the chip for the class you
   * are looking at must not move where the panel thinks you are standing.
   */
  const homeSystem = systemOfAddress(target)
  const home =
    homeSystem === null
      ? null
      : (groups.find(
          (group) => systemOfAddress(group.system.address) === homeSystem,
        )?.system.address ?? null)
  /* Nothing focused yet — the mode's first `look` has not landed. The nearest
     system is the useful thing to have open, and it is the first row. */
  const opensByDefault = home ?? groups[0]?.system.address ?? null

  /*
   * Whether each group is folded, decided once so the footer and the list
   * cannot disagree. Counting bodies inside a collapsed group as "shown" is
   * what the fold exists to prevent, and it read "137 shown" over nine rows.
   */
  const folded = groups.map((group) => {
    /*
     * Open by default only where the camera is, and never during a search: a
     * search matched the *star*, and expanding every hit would bury the next
     * result under a hundred and twenty-nine bodies.
     */
    const byDefault = !searching && group.system.address === opensByDefault
    return {
      group,
      open:
        group.bodies.length > 0 &&
        (decided.get(group.system.address) ?? byDefault),
    }
  })
  const shown = folded.reduce(
    (total, one) => total + 1 + (one.open ? one.group.bodies.length : 0),
    0,
  )

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 transition-colors focus-within:border-sky-500/60">
          <Search aria-hidden className="size-3 shrink-0 text-slate-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or address"
            aria-label="Search the catalog"
            // `md:type-readout` beside the bare step: the Input base carries
            // `md:text-sm`, which only merges against an equally modified
            // class. `lib/utils.ts` has the whole story.
            className="type-readout md:type-readout h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {searching && (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={(event) => {
                releaseFocus(event)
                setQuery('')
              }}
              className={`-mr-1 flex size-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-sky-300 ${FOCUS_RING}`}
            >
              <X aria-hidden className="size-3" />
            </button>
          )}
        </label>
        {/*
         * The filters are behind a toggle, and the toggle *says when they are
         * on*. Six chips and a radius row is 60 px of chrome above a list, and
         * it is chrome nobody needs on most visits — but a filter that is
         * silently narrowing the list while its own control is hidden is the
         * worst state a disclosure can produce, so the accent is not decoration
         * here, it is the only thing standing between a reader and "why is
         * Europa missing".
         */}
        <button
          type="button"
          aria-expanded={filtering}
          aria-label="Filters"
          title={
            narrowed
              ? `Filters — showing ${classes.length} of ${OBJECT_CLASSES.length} classes`
              : 'Filter by class, and set how far the survey reaches'
          }
          onClick={(event) => {
            releaseFocus(event)
            setFiltering(!filtering)
          }}
          className={`flex size-7 shrink-0 items-center justify-center rounded border transition-colors ${FOCUS_RING} ${
            filtering || narrowed
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-200'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:border-sky-500/60 hover:text-sky-200'
          }`}
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
        </button>
      </div>

      {filtering && (
        <div className="flex flex-col gap-2 rounded border border-slate-800/80 bg-slate-900/40 p-2">
          <div className="flex flex-col gap-1">
            <span className="type-label flex items-baseline justify-between text-sky-400/80">
              Show
              {narrowed && (
                <button
                  type="button"
                  onClick={(event) => {
                    releaseFocus(event)
                    setClasses(ALL_CLASSES)
                  }}
                  className={`type-micro normal-case text-slate-400 transition-colors hover:text-sky-300 ${FOCUS_RING}`}
                >
                  all
                </button>
              )}
            </span>
            {/*
             * `type="multiple"`, and an empty selection is read as *everything*
             * — see `acceptsRow`. A filter whose worst state is an empty list
             * that looks exactly like a failed survey is a control with a trap
             * in it, and the way out is not discoverable from the empty list.
             */}
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              spacing={1}
              value={[...classes]}
              aria-label="Object classes"
              onValueChange={(next) => setClasses(next)}
              className="flex-wrap"
            >
              {OBJECT_CLASSES.map((one) => (
                <ToggleGroupItem
                  key={one.id}
                  value={one.id}
                  onClick={releaseFocus}
                  title={one.label}
                  className={`type-label h-6 gap-1 rounded border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
                >
                  <one.icon aria-hidden className="size-3.5" />
                  {one.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="type-label text-sky-400/80">Survey radius</span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={radius}
              aria-label="Survey radius, light years"
              onValueChange={(next) => {
                if (next !== '') setRadius(next)
              }}
            >
              {RADII.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  onClick={releaseFocus}
                  title={`Sweep ${option} light years around the camera`}
                  className={`type-label h-6 min-w-8 border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p className="type-ui text-pretty text-slate-400">
            A search reaches the whole catalog whatever this says — the radius
            is the sweep that answers “what is near me”.
          </p>
        </div>
      )}

      {/* The rail is context for the survey, so it is absent from a search:
          those results are ranked by name across a hundred and fifty light
          years, and a scale bar under them would be measuring the wrong thing. */}
      {!searching && (
        <NeighbourhoodRail
          stars={near}
          radiusLightYears={lightYears}
          target={home}
          onFocus={focus}
        />
      )}

      <ul className="flex min-h-0 flex-col">
        {folded.map(({ group, open }) => {
          const visible = open
            ? new Set(group.bodies.map((body) => body.address))
            : NOTHING_VISIBLE
          return (
            <li key={group.system.address}>
              <ul className="flex flex-col">
                <CatalogueRow
                  row={group.system}
                  selected={group.system.address === target}
                  indent={0}
                  measure={measureOf(group.system)}
                  {...(group.bodies.length > 0
                    ? {
                        expanded: open,
                        onExpand: () =>
                          setDecided((current) => {
                            // The updater form, and it is required rather than
                            // tidy: a map derived from a captured snapshot
                            // silently discards a second toggle in the same
                            // commit. Same rule `dock/layout.ts` states.
                            const next = new Map(current)
                            next.set(group.system.address, !open)
                            return next
                          }),
                      }
                    : {})}
                  onFocus={() => focus(group.system.address)}
                />
                {open &&
                  group.bodies.map((body) => (
                    <CatalogueRow
                      key={body.address}
                      row={body}
                      selected={body.address === target}
                      indent={indentOf(body, visible)}
                      measure={measureOf(body)}
                      onFocus={() => focus(body.address)}
                    />
                  ))}
                {!open && group.bodies.length > 0 && (
                  <li className="type-micro pl-12 text-slate-400">
                    {group.bodies.length} bodies
                  </li>
                )}
              </ul>
            </li>
          )
        })}

        {groups.length === 0 && (
          /*
           * Four different answers, not one, because each has a different next
           * step. A failed read is the one that must not read as "surveying…":
           * `ready` stays false while the sweep keeps throwing, so without this
           * branch a broken survey says "surveying…" every 500 ms forever with
           * the message sitting unread in the hook's return value. The typed
           * case reaches the whole catalog, so "no star is called that" is a
           * fact rather than a statement about how far the survey got.
           */
          <li className="type-ui px-1 py-2 text-pretty text-slate-400">
            {failure !== null
              ? `the survey did not answer: ${failure}`
              : !ready
                ? 'surveying…'
                : searching
                  ? 'no charted star is called that'
                  : `nothing within ${lightYears} ly`}
          </li>
        )}
      </ul>

      {/* One line, and it only appears when it has something to say: how much
          of the survey is on screen, and how much the chips are holding back.
          A count that was always there would be furniture. */}
      {groups.length > 0 && (
        <p className="type-micro shrink-0 text-slate-400 tabular-nums">
          {shown} shown
          {hidden > 0 && ` · ${hidden} filtered`}
        </p>
      )}
    </div>
  )
}
