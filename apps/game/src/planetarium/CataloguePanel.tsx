import { useState } from 'react'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTravelTargets } from '../hud/useTravelTargets.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { isBoolean, usePersistentState } from '../hud/panelState.ts'
import { CatalogueRow } from './CatalogueRow.tsx'
import { NeighbourhoodRail } from './NeighbourhoodRail.tsx'
import type { PlanetariumContext } from './context.ts'
import { groupBySystem, indentOf, measureOf, neighbours } from './catalogue.ts'
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

export function CataloguePanel({ engine, target, focus }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  const [radius, setRadius] = usePersistentState<string>(
    'planetarium.catalogue.radius',
    DEFAULT_RADIUS,
    (value): value is string =>
      typeof value === 'string' && (RADII as readonly string[]).includes(value),
  )
  const [classes, setClasses] = usePersistentState<readonly string[]>(
    'planetarium.catalogue.classes',
    ALL_CLASSES,
    (value): value is readonly string[] =>
      Array.isArray(value) && value.every((one) => typeof one === 'string'),
  )
  const [filtering, setFiltering] = usePersistentState(
    'planetarium.catalogue.filtering',
    false,
    isBoolean,
  )
  /*
   * Which systems the reader has *changed*, rather than which are open.
   *
   * The default is a function of where the camera is — the system you are in is
   * open, every other is one line — and that default has to keep applying as
   * the camera moves. A set of open addresses would freeze it: fly to Proxima
   * and Sol is still the expanded one, because that is what was true when the
   * set was written. A set of exceptions re-derives on every render, so
   * arriving somewhere new opens it without anything having to notice.
   */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())

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
  const { rows, ready } = useTravelTargets(engine, {
    lightYears,
    origin: 'observer',
    query,
    refreshMs: 500,
  })

  const searching = query.trim() !== ''
  const groups = groupBySystem(rows, classes)
  const near = neighbours(rows, lightYears)
  const shown = groups.reduce(
    (total, group) => total + 1 + group.bodies.length,
    0,
  )
  const hidden = groups.reduce(
    (total, group) => total + group.total - group.bodies.length,
    0,
  )
  const narrowed = classes.length > 0 && classes.length < OBJECT_CLASSES.length

  /** The system the camera is in, which is the one that opens by default. */
  const home =
    groups.find(
      (group) =>
        group.system.address === target ||
        group.bodies.some((body) => body.address === target),
    )?.system.address ?? null
  /* Nothing focused yet — the mode's first `look` has not landed. The nearest
     system is the useful thing to have open, and it is the first row. */
  const opensByDefault = home ?? groups[0]?.system.address ?? null

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
        {groups.map((group) => {
          /*
           * Open by default only where the camera is, and never during a
           * search: a search matched the *star*, and expanding every hit would
           * bury the next result under a hundred and twenty-nine bodies.
           */
          const byDefault =
            !searching && group.system.address === opensByDefault
          const open =
            group.bodies.length > 0 &&
            (toggled.has(group.system.address) ? !byDefault : byDefault)
          const visible = new Set(
            open ? group.bodies.map((body) => body.address) : [],
          )
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
                          setToggled((current) => {
                            // The updater form, and it is required rather than
                            // tidy: a set derived from a captured snapshot
                            // silently discards a second toggle in the same
                            // commit. Same rule `dock/layout.ts` states.
                            const next = new Set(current)
                            if (next.has(group.system.address))
                              next.delete(group.system.address)
                            else next.add(group.system.address)
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
                  <li className="type-micro pl-12 text-slate-500">
                    {group.bodies.length} bodies
                  </li>
                )}
              </ul>
            </li>
          )
        })}

        {groups.length === 0 && (
          /*
           * Three different answers, not one. "Surveying…" and "there is
           * nothing here" have different next steps, and the empty state used
           * to give the second for both. The typed case is a third: it is the
           * whole catalog now, so "no star is called that" is a fact rather
           * than a statement about how far the survey reached.
           */
          <li className="type-ui px-1 py-2 text-slate-400">
            {!ready
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
        <p className="type-micro shrink-0 text-slate-500 tabular-nums">
          {shown} shown
          {hidden > 0 && ` · ${hidden} filtered`}
        </p>
      )}
    </div>
  )
}
