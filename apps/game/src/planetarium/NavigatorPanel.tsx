import { type KeyboardEvent, useRef, useState } from 'react'
import { Search, SlidersHorizontal, Telescope, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTravelTargets } from '../hud/useTravelTargets.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { attempt } from '../hud/notice.ts'
import { useAction } from '../input/useKeymap.ts'
import {
  NAVIGATOR_CLASSES,
  NAVIGATOR_FILTERING,
  NAVIGATOR_RADIUS,
  usePersistentState,
} from '../state/preferences.ts'
import { NavigatorTree } from './NavigatorTree.tsx'
import { NeighbourhoodRail } from './NeighbourhoodRail.tsx'
import type { GameEngine } from '../engine/GameEngine.ts'
import { TargetActions } from '../hud/TargetActions.tsx'
import {
  flattenGroups,
  groupBySystem,
  neighbours,
  searchRows,
  systemOfAddress,
} from './navigator.ts'
import { ALL_CLASSES, OBJECT_CLASSES, RADII } from './kinds.ts'
import { useNavigatorSearch } from './useNavigatorSearch.ts'

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
 * The grouping and the ordering are pure functions in `navigator.ts` and are
 * tested there. The list is windowed in `NavigatorTree.tsx`, so a fifty
 * light-year sweep costs the rows on screen and not the fourteen hundred
 * behind them. This file is the controls and the layout.
 */

export function NavigatorPanel({
  engine,
  target,
  focus,
  onNotice,
  onCatalog,
  verbs = 'look',
}: {
  readonly engine: GameEngine
  /** The address the mode considers current, drawn as selected. */
  readonly target: string | null
  /** What a row does in `look` mode: move the camera, and write the URL. */
  readonly focus: (address: string) => void
  readonly onNotice: (message: string) => void
  /**
   * Open the deep catalog, where present.
   *
   * Absent in flight, and that is the mode's answer rather than this panel's:
   * the dialog is a child of the planetarium's route, so there is nowhere for
   * it to open over from a cockpit.
   */
  readonly onCatalog?: () => void
  /**
   * What a row offers, which depends on the mode rather than on the panel.
   *
   * In the planetarium a row *looks*: the observatory holds the camera, so
   * "go to" would teleport a ship nobody can see and the panel would appear to
   * do nothing. In flight a row offers Orbit and Land, with Face and Burn
   * beside them, because they are the only way to point a hull at a thing.
   *
   * One navigator, two verbs. A second, smaller navigator for the author is
   * the ambiguity ADR-0018 removed.
   */
  readonly verbs?: 'look' | 'travel'
}) {
  const [query, setQuery] = useState('')
  /** The row a traveling reader has picked, and whose verbs are showing. */
  const [selected, setSelected] = useState<string | null>(null)
  /** The search field, for the `nav.goTo` binding to put focus into. */
  const field = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [radius, setRadius] = usePersistentState(NAVIGATOR_RADIUS)
  const [classes, setClasses] = usePersistentState(NAVIGATOR_CLASSES)
  const [filtering, setFiltering] = usePersistentState(NAVIGATOR_FILTERING)
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

  const lightYears = Number(radius)
  const searching = query.trim() !== ''
  /*
   * Two questions, two hooks.
   *
   * Empty: the survey (`hud/useTravelTargets.ts`), centered on the camera, not
   * on the ship. `look` moves a camera and nothing else, which is the
   * planetarium's whole verb — so "you" in this mode is the eye, and it can be
   * four light years from the hull. The poll pauses while a query is typed:
   * the sweep is a cost and nothing on screen is reading it.
   *
   * Typed: the fuzzy index (`useNavigatorSearch.ts`), over every designation
   * in the catalog and every body the world has generated, on the keystroke.
   * Filtering the survey's result with `.includes()` made the search box a
   * search of a sixteen-light-year bubble, so a star ninety light years out
   * was not merely hard to find, it was unreachable by name.
   */
  const survey = useTravelTargets(engine, {
    lightYears,
    origin: 'observer',
    query: '',
    refreshMs: 500,
    paused: searching,
  })
  const found = useNavigatorSearch(engine, query, { origin: 'observer' })

  /**
   * What pressing a row does, which is the mode's answer rather than this
   * panel's. Looking moves a camera; traveling picks a destination and offers
   * the verbs that reach it.
   */
  const act = (address: string): void => {
    if (verbs === 'look') {
      focus(address)
      return
    }
    setSelected(address)
  }

  const rows = searching ? found.rows : survey.rows
  const groups = groupBySystem(survey.rows, classes)
  const chosen = rows.find((row) => row.address === selected) ?? null
  const near = neighbours(survey.rows, lightYears)
  /*
   * What the filter took, counted against the survey rather than against what
   * survived it: a system whose star *and* whose every body were filtered out
   * is gone from `groups` entirely, so summing over `groups` cannot see it.
   */
  const kept = groups.reduce(
    (total, group) => total + 1 + group.bodies.length,
    0,
  )
  const hidden = survey.rows.length - kept
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
  const folded = groups.map((group) => ({
    group,
    open:
      group.bodies.length > 0 &&
      (decided.get(group.system.address) ??
        group.system.address === opensByDefault),
  }))
  /*
   * Search results are their own list: flat, in the matcher's order, every
   * hit a top-level row. Folding them by system would bury the next result
   * under a hundred and twenty-nine bodies, and a body found by name may
   * arrive without its star.
   */
  const listed = searching ? searchRows(found.rows) : flattenGroups(folded)
  const shown = listed.length
  const current = verbs === 'travel' ? selected : target

  const setOpen = (address: string, open: boolean): void =>
    setDecided((held) => {
      // The updater form, and it is required rather than tidy: a map derived
      // from a captured snapshot silently discards a second toggle in the same
      // commit. Same rule `dock/layout.ts` states.
      const next = new Map(held)
      next.set(address, open)
      return next
    })

  /*
   * The field is the top of the list, for a keyboard. Enter takes the first
   * row — the matcher's best answer, which is what a typeahead promises — and
   * `↓` walks into the tree at its one stop, so a reader who typed three
   * letters never has to find the list with Tab.
   */
  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      const first = listed[0]
      if (first === undefined) return
      event.preventDefault()
      act(first.row.address)
    } else if (event.key === 'ArrowDown') {
      const stop = root.current?.querySelector<HTMLButtonElement>(
        '[data-navigator-row][tabindex="0"]',
      )
      if (stop === null || stop === undefined) return
      event.preventDefault()
      stop.focus()
    }
  }

  /*
   * `/` focuses the search, which is what the table has always claimed it does.
   *
   * Registered here because this is the panel that owns the field. The binding
   * is global rather than per-mode: the navigator is in the flight workspace as
   * well as the planetarium's, and "go to" means the same thing in both. It is
   * live only while the panel is drawn, which is the honest scope — the
   * dispatcher declines a chord no handler claims, so `/` stays the browser's
   * in a mode with no navigator on screen.
   */
  useAction('nav.goTo', () => field.current?.focus())

  const ready = searching ? found.ready : survey.ready
  const failure = searching ? null : survey.failure

  return (
    <div ref={root} className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 transition-colors focus-within:border-sky-500/60">
          <Search aria-hidden className="size-3 shrink-0 text-slate-400" />
          <Input
            ref={field}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKeyDown}
            placeholder="Name or address"
            aria-label="Search the navigator"
            autoComplete="off"
            spellCheck={false}
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
        {/*
         * The way into the deep catalog, beside the filters rather than under
         * them. The two controls answer the same shape of question at two
         * scales — "narrow this list" and "search a volume nothing has listed"
         * — and a reader who has just failed to find something in the survey
         * is looking exactly here.
         */}
        <button
          type="button"
          aria-label="Search the whole volume"
          title="Search the volume for worlds by what they are, not by name"
          onClick={(event) => {
            releaseFocus(event)
            onCatalog?.()
          }}
          hidden={onCatalog === undefined}
          className={`flex size-7 shrink-0 items-center justify-center rounded border border-slate-700 bg-slate-800/60 text-slate-400 transition-colors hover:border-sky-500/60 hover:text-sky-200 ${FOCUS_RING}`}
        >
          <Telescope aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          aria-expanded={filtering}
          aria-label="Filters"
          title={
            narrowed
              ? `Filters — showing ${classes.length} of ${OBJECT_CLASSES.length} classes`
              : 'Filter by class, and set how far the list reaches'
          }
          onClick={(event) => {
            releaseFocus(event)
            setFiltering((held) => !held)
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
                  title={`List everything within ${option} light years of the camera`}
                  className={`type-label h-6 min-w-8 border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p className="type-ui text-pretty text-slate-400">
            Search always covers the whole catalog. The radius only sets how far
            the list below reaches.
          </p>
        </div>
      )}

      {/* The rail is context for the survey, so it is absent from a search:
          those results are ranked by how well they match, and a scale bar
          under them would be measuring the wrong thing. */}
      {!searching && (
        <NeighbourhoodRail
          stars={near}
          radiusLightYears={lightYears}
          target={home}
          onFocus={act}
        />
      )}

      {listed.length > 0 ? (
        <NavigatorTree
          rows={listed}
          current={current}
          tabbable={current}
          highlights={searching ? found.highlights : undefined}
          label="Navigator"
          onAct={act}
          onFold={setOpen}
        />
      ) : (
        /*
         * Four different answers, not one, because each has a different next
         * step. A failed read is the one that must not read as "surveying…":
         * `ready` stays false while the sweep keeps throwing, so without this
         * branch a broken survey says "surveying…" every 500 ms forever with
         * the message sitting unread in the hook's return value. The typed
         * case reaches the whole catalog, so "nothing is called that" is a
         * fact rather than a statement about how far the survey got.
         */
        <p className="type-ui px-1 py-2 text-pretty text-slate-400">
          {failure !== null
            ? `The survey did not answer: ${failure}`
            : !ready
              ? searching
                ? 'Searching…'
                : 'Surveying…'
              : searching
                ? 'Nothing in the catalog is called that.'
                : `Nothing within ${lightYears} ly.`}
        </p>
      )}

      {/*
       * The verbs, under the list, for the mode that has any.
       *
       * A fixed slot rather than a row that appears and disappears: the list
       * above scrolls, and a bar that grew into existence on the first click
       * would shift every row under the pointer at the moment somebody was
       * aiming at one.
       */}
      {verbs === 'travel' && (
        <div className="min-h-[2.75rem] shrink-0 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1">
          {chosen === null ? (
            <span className="type-ui text-slate-400">
              Pick somewhere to go.
            </span>
          ) : (
            <>
              <div
                className="truncate text-slate-300"
                title={`${chosen.name} · ${chosen.address}`}
              >
                {chosen.name}{' '}
                <span className="text-slate-400">{chosen.address}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <TargetActions
                  engine={engine}
                  target={chosen}
                  run={(label, action) => attempt(onNotice, label, action)}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* One line, and it only appears when it has something to say: how much
          of the survey is on screen, and how much the chips are holding back.
          A count that was always there would be furniture. */}
      {listed.length > 0 && (
        <p className="type-micro shrink-0 text-slate-400 tabular-nums">
          {searching
            ? `${shown} ${shown === 1 ? 'match' : 'matches'}`
            : `${shown} shown${hidden > 0 ? ` · ${hidden} hidden by filters` : ''}`}
        </p>
      )}
    </div>
  )
}
