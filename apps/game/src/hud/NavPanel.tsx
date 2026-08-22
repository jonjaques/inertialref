import { useEffect, useState } from 'react'
import type { TravelTarget } from '@inertialref/devtools'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING, releaseFocus } from './focus.ts'
import { Action, Section } from './widgets.tsx'

/*
 * Going places.
 *
 * The alpha's answer to "I am parked above the first planet of Sol and there is
 * no way to get anywhere else". Everything here is the harness — `ir.targets()`
 * and `ir.goTo()` — with a list drawn around it, which is deliberate: the panel
 * must not be able to reach somewhere the console and the headless runner
 * cannot, or the thing an author demonstrates in the browser stops being the
 * thing a test can replay.
 *
 * This is a *dev* surface, not the cockpit. The shipping interface is the system
 * and galaxy maps in `docs/design/ux.md`, which are diegetic, drawn on the
 * canopy, and constrained by fuel and jump range. None of that applies to a
 * teleport, and pretending otherwise would build the wrong thing twice.
 */

/** How often the listing re-reads distances. A survey is not free; 1 Hz is plenty. */
const REFRESH_MS = 1_000
/** Survey radius for the star listing. Holds the nearest half-dozen systems. */
const SURVEY_LIGHT_YEARS = 8

/**
 * Where `land` puts you when nobody says otherwise.
 *
 * The same site the `surface` scenario uses, so what the button does and what
 * `pnpm sim --scenario surface` does are the same landing, on purpose: a
 * discrepancy between them would be invisible and would waste an afternoon.
 */
const DEBUG_LANDING_SITE = { latitude: 0.35, longitude: -1.1 }

/**
 * A ceiling on the address field.
 *
 * Not validation — the harness owns what an address means, and duplicating its
 * grammar here is how the two drift apart. It is a bound on what a paste can do
 * to the layout: the field's contents are echoed into the notice at the bottom
 * of the screen, and an unbounded one turns a transient message into a wall.
 */
const MAX_ADDRESS_LENGTH = 200

/** What went wrong, and which verb it went wrong for. */
interface Failure {
  readonly action: string
  readonly message: string
}

export function NavPanel({
  engine,
  onNotice,
}: {
  engine: GameEngine
  onNotice: (message: string) => void
}) {
  const [targets, setTargets] = useState<readonly TravelTarget[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  /*
   * Whether the survey has completed once.
   *
   * "surveying…" and "there is nothing here" are different answers and the
   * panel used to give the first one for both — so flying out past the survey
   * radius produced a list that looked permanently mid-load. Only one of the
   * two has a next step, and it is the one that was being hidden.
   */
  const [surveyed, setSurveyed] = useState(false)
  /*
   * The scenario currently running, if any. The scenarios are seconds long and
   * their buttons had no busy state at all, so ten impatient clicks were ten
   * concurrent scenarios racing to teleport the same ship.
   */
  const [pending, setPending] = useState<string | null>(null)
  // Mirrors `engine.showShip`, which is a plain field on purpose — this state
  // exists only so the button's label re-renders when it is clicked.
  const [shipShown, setShipShown] = useState(engine.showShip)
  // Bumped by every action, so the listing refreshes on the spot rather than
  // showing where you used to be until the next poll.
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const read = (): void => {
      try {
        setTargets(engine.harness.targets({ lightYears: SURVEY_LIGHT_YEARS }))
        setSurveyed(true)
        // Identical state bails out of the re-render, so this is free on the
        // ordinary path — every second, forever, with nothing wrong.
        setFailure((current) =>
          current?.action === 'the survey' ? null : current,
        )
      } catch (cause) {
        const detail = message(cause)
        setFailure((current) =>
          current !== null && current.message === detail
            ? current
            : { action: 'the survey', message: detail },
        )
      }
    }
    read()
    const timer = window.setInterval(read, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [engine, generation])

  const target =
    targets.find((candidate) => candidate.address === selected) ?? null

  const run = (label: string, action: () => void): void => {
    try {
      action()
      setFailure(null)
      onNotice(label)
    } catch (cause) {
      setFailure({ action: label, message: message(cause) })
    }
    setGeneration((n) => n + 1)
  }

  /**
   * The same, for the verbs that finish later: the notice is what they return.
   *
   * One at a time. These reach into the same world through the same harness,
   * and two of them interleaved is not a slower answer, it is a different one.
   */
  const awaited = (label: string, action: () => Promise<string>): void => {
    if (pending !== null) return
    setPending(label)
    void action()
      .then((detail) => {
        setFailure(null)
        onNotice(detail)
      })
      .catch((cause: unknown) =>
        setFailure({ action: label, message: message(cause) }),
      )
      .finally(() => {
        setPending(null)
        setGeneration((n) => n + 1)
      })
  }

  return (
    <div>
      {/*
       * Above the sections, not inside one.
       *
       * This used to live inside `nav.go`, whose open state is remembered — so
       * a collapsed section swallowed the only report a failed `land`, `burn`
       * or scenario ever made, and the button read as having done nothing.
       * Every verb in this panel reports here, and says which verb it was.
       */}
      {failure !== null && (
        <div className="mb-2 rounded border border-rose-400/40 bg-slate-950/60 px-2 py-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-rose-300">
              {failure.action} failed
            </span>
            <Action
              label="dismiss"
              title="Clear this. The next action that succeeds clears it too."
              onClick={() => setFailure(null)}
            />
          </div>
          <div className="mt-0.5 max-h-24 overflow-auto break-words text-slate-400">
            {failure.message}
          </div>
        </div>
      )}

      <Section id="nav.go" title="go to">
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            run(`go to ${query}`, () => engine.harness.goTo(query))
          }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="SOL · b:2 · g:milky-way/s:HIP71683/b:3.0"
            spellCheck={false}
            maxLength={MAX_ADDRESS_LENGTH}
            autoComplete="off"
            aria-label="Universe address"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-[11px] text-slate-200 caret-sky-300 placeholder:text-slate-600 focus:border-sky-500/60 focus:outline-none"
          />
          <Action
            label="go"
            tone="primary"
            onClick={() =>
              run(`go to ${query}`, () => engine.harness.goTo(query))
            }
          />
        </form>
      </Section>

      <Section
        id="nav.targets"
        title="destinations"
        trailing={`${targets.length}`}
      >
        <div className="max-h-64 overflow-auto rounded border border-slate-800/80">
          {targets.map((candidate) => (
            <TargetRow
              key={candidate.address}
              target={candidate}
              selected={candidate.address === selected}
              onSelect={() => setSelected(candidate.address)}
            />
          ))}
          {targets.length === 0 && (
            <div className="px-2 py-1 text-slate-500">
              {surveyed
                ? `no systems within ${SURVEY_LIGHT_YEARS} ly — fly somewhere, or type an address above`
                : 'surveying…'}
            </div>
          )}
        </div>

        <div className="mt-1 min-h-[2.75rem] rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1">
          {target === null ? (
            <span className="text-slate-500">select a destination</span>
          ) : (
            <>
              <div
                className="truncate text-slate-300"
                title={`${target.name} · ${target.address}`}
              >
                {target.name}{' '}
                <span className="text-slate-600">{target.address}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {target.kind === 'system' ? (
                  <>
                    <Action
                      label="travel"
                      tone="primary"
                      title="Orbit this system's star, looking at it"
                      onClick={() =>
                        run(`travelling to ${target.name}`, () =>
                          engine.harness.goTo(target.address),
                        )
                      }
                    />
                    <Action
                      label="generate"
                      disabled={target.loaded}
                      title="Generate the system and list its bodies without going there"
                      onClick={() =>
                        run(`generated ${target.name}`, () => {
                          engine.harness.loadSystem(target.system)
                        })
                      }
                    />
                  </>
                ) : (
                  <>
                    <Action
                      label="orbit"
                      tone="primary"
                      title="Circular orbit at an altitude that frames the body"
                      onClick={() =>
                        run(`orbiting ${target.name}`, () =>
                          engine.harness.goTo(target.address),
                        )
                      }
                    />
                    <Action
                      label="land"
                      disabled={!target.landable}
                      title={
                        target.landable
                          ? 'Park on the surface'
                          : 'Not solid ground'
                      }
                      onClick={() =>
                        run(`landing on ${target.name}`, () =>
                          engine.harness.land(
                            target.address,
                            DEBUG_LANDING_SITE.latitude,
                            DEBUG_LANDING_SITE.longitude,
                          ),
                        )
                      }
                    />
                    <Action
                      label="face"
                      title="Point the nose at it without touching the trajectory"
                      onClick={() =>
                        run(`facing ${target.name}`, () =>
                          engine.harness.face(target.address),
                        )
                      }
                    />
                    <Action
                      label="burn"
                      title="Aim at it and light the main drive"
                      onClick={() =>
                        run(`burning toward ${target.name}`, () =>
                          engine.harness.burnToward(target.address),
                        )
                      }
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </Section>

      <Section
        id="nav.shots"
        title="shots"
        trailing={target?.kind === 'body' ? target.name : 'current body'}
      >
        {/*
         * Camera bookmarks: `ir.shot(name, address?)` with a button per
         * composition. They act on the selected body when one is selected and
         * on the body you are at otherwise, so "frame the thing I am looking
         * at" is one click. The ship toggle lives here because the bookmarks
         * are why it exists: a debug cone parked dead centre ruins every
         * composition it appears in.
         */}
        <div className="flex flex-wrap gap-1">
          {engine.harness.shots().map(({ name, description }) => (
            <Action
              key={name}
              label={name}
              title={description}
              onClick={() =>
                run(`shot ${name}`, () => {
                  engine.harness.shot(
                    name,
                    target?.kind === 'body' ? target.address : undefined,
                  )
                })
              }
            />
          ))}
          <span className="mx-1 h-3 w-px bg-slate-800" />
          <Action
            label={shipShown ? 'hide ship' : 'show ship'}
            title="Draw the debug ship and reference props, or keep them out of the frame"
            onClick={() => {
              engine.showShip = !engine.showShip
              setShipShown(engine.showShip)
            }}
          />
        </div>
      </Section>

      <Section id="nav.cutscenes" title="cutscenes">
        {/*
         * Scripted scenes: `ir.play(id)` with a button per script, and a stop
         * that is safe to press at any time. The game never plays one on its
         * own — this section and the console are the only ways in — and Esc
         * skips a running scene, restoring the ship where it was.
         */}
        <div className="flex flex-wrap gap-1">
          {engine.harness.cutscenes().map(({ id, description, seconds }) => (
            <Action
              key={id}
              label={`▶ ${id}`}
              title={`${description} — ${Math.round(seconds)} s. Esc skips.`}
              onClick={() =>
                run(`playing ${id}`, () => engine.harness.play(id))
              }
            />
          ))}
          <Action
            label="stop"
            title="Stop the running cutscene and restore the ship"
            onClick={() =>
              run('cutscene stopped', () => engine.harness.stopCutscene())
            }
          />
        </div>
      </Section>

      <Section
        id="nav.scenarios"
        title="scenarios"
        trailing={pending === null ? undefined : `${pending} running…`}
      >
        <div className="flex flex-wrap gap-1">
          {engine.harness.scenarios().map((name) => (
            <Action
              key={name}
              label={pending === name ? `${name}…` : name}
              disabled={pending !== null}
              title={
                pending === null
                  ? `Run the ${name} scenario`
                  : `${pending} is running`
              }
              onClick={() =>
                awaited(name, async () => {
                  const result = await engine.harness.scenario(name)
                  return result.detail
                })
              }
            />
          ))}
          <Action
            label={pending === 'self test' ? 'self test…' : 'self test'}
            disabled={pending !== null}
            title="The twelve milestone capability checks, against this build"
            onClick={() =>
              awaited('self test', async () => {
                const report = await engine.harness.selfTest()
                console.info(report.report)
                return `${report.passed}/${report.total} capabilities · report in the console`
              })
            }
          />
        </div>
      </Section>
    </div>
  )
}

/**
 * One row of the listing.
 *
 * Exported so the overlay's smoke test can render real targets through it —
 * the panel itself only fills its list from an effect, and effects do not run
 * when the tree is rendered to static markup in Node.
 */
export function TargetRow({
  target,
  selected,
  onSelect,
}: {
  target: TravelTarget
  selected: boolean
  onSelect: () => void
}) {
  // Depth is 0, 1 or 2 — system, planet, moon — and the indent is what makes the
  // flat list read as the containment tree the addresses already describe.
  const indent = ['pl-1', 'pl-4', 'pl-7'][target.depth] ?? 'pl-7'
  return (
    <button
      type="button"
      onClick={(event) => {
        releaseFocus(event)
        onSelect()
      }}
      title={`${target.name} · ${target.address}`}
      aria-pressed={selected}
      className={`flex w-full items-baseline gap-2 py-[1px] pr-1.5 text-left ${indent} ${FOCUS_RING} ${
        selected ? 'bg-sky-500/20 text-sky-100' : 'hover:bg-slate-800/60'
      }`}
    >
      <span
        className={
          target.kind === 'system'
            ? 'shrink-0 text-amber-300/80'
            : 'shrink-0 text-slate-600'
        }
      >
        {target.kind === 'system' ? '★' : target.landable ? '◍' : '·'}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {target.name}
        <span className="ml-1.5 text-slate-600">{target.detail}</span>
      </span>
      <span
        className={`shrink-0 tabular-nums ${target.loaded ? 'text-slate-400' : 'text-slate-600'}`}
      >
        {target.distanceText}
      </span>
    </button>
  )
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
