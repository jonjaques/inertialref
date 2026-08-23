import { useEffect, useState } from 'react'
import type { TravelTarget } from '@inertialref/devtools'
import { Separator } from '@/components/ui/separator'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'
import { AddressForm } from './AddressForm.tsx'
import { type Failure, NavFailure } from './NavFailure.tsx'
import { Section } from './Section.tsx'
import { TargetActions } from './TargetActions.tsx'
import { TargetRow } from './TargetRow.tsx'

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
 *
 * What is left in this file is the state machine — the survey, the selection,
 * the one-at-a-time guard and the two report paths. Everything it draws is a
 * component beside it, because that state machine is the part worth reading
 * without four hundred lines of buttons around it.
 */

/** How often the listing re-reads distances. A survey is not free; 1 Hz is plenty. */
const REFRESH_MS = 1_000
/** Survey radius for the star listing. Holds the nearest half-dozen systems. */
const SURVEY_LIGHT_YEARS = 8

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

  const goTo = (): void =>
    run(`go to ${query}`, () => engine.harness.goTo(query))

  return (
    <div>
      {failure !== null && (
        <NavFailure failure={failure} onDismiss={() => setFailure(null)} />
      )}

      <Section id="nav.go" title="Go to">
        <AddressForm query={query} onQuery={setQuery} onSubmit={goTo} />
      </Section>

      <Section
        id="nav.targets"
        title="Destinations"
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
            <div className="px-2 py-1 text-slate-400">
              {surveyed
                ? `no systems within ${SURVEY_LIGHT_YEARS} ly — fly somewhere, or type an address above`
                : 'surveying…'}
            </div>
          )}
        </div>

        <div className="mt-1 min-h-[2.75rem] rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1">
          {target === null ? (
            <span className="text-slate-400">select a destination</span>
          ) : (
            <>
              <div
                className="truncate text-slate-300"
                title={`${target.name} · ${target.address}`}
              >
                {target.name}{' '}
                <span className="text-slate-400">{target.address}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <TargetActions engine={engine} target={target} run={run} />
              </div>
            </>
          )}
        </div>
      </Section>

      <Section
        id="nav.shots"
        title="Shots"
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
        <div className="flex flex-wrap items-center gap-1">
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
          <Separator
            orientation="vertical"
            className="mx-1 !h-3 bg-slate-800"
          />
          <Action
            label={shipShown ? 'Hide Ship' : 'Show Ship'}
            title="Draw the debug ship and reference props, or keep them out of the frame"
            onClick={() => {
              engine.showShip = !engine.showShip
              setShipShown(engine.showShip)
            }}
          />
        </div>
      </Section>

      <Section id="nav.cutscenes" title="Cutscenes">
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
            label="Stop"
            title="Stop the running cutscene and restore the ship"
            onClick={() =>
              run('cutscene stopped', () => engine.harness.stopCutscene())
            }
          />
        </div>
      </Section>

      <Section
        id="nav.scenarios"
        title="Scenarios"
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
            label={pending === 'self test' ? 'Self Test…' : 'Self Test'}
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

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
