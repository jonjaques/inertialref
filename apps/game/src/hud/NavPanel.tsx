import { useEffect, useRef, useState } from 'react'
import { Separator } from '@/components/ui/separator'
import { useEngine } from '../state/engineStore.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { StanceHandle } from '../engine/presentation.ts'
import { Action } from './Action.tsx'
import { AddressForm } from './AddressForm.tsx'
import { type Failure, NavFailure } from './NavFailure.tsx'
import { Section } from './Section.tsx'
import { TargetActions } from './TargetActions.tsx'
import { TargetRow } from './TargetRow.tsx'
import { useTravelTargets } from './useTravelTargets.ts'

/*
 * Going places.
 *
 * The alpha's answer to "I am parked above the first planet of Sol and there is
 * no way to get anywhere else". Everything here is the harness — `ir.targets()`,
 * `ir.search()` and `ir.goTo()` — with a list drawn around it, which is
 * deliberate: the panel
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

/** Survey radius for the star listing. Holds the nearest half-dozen systems. */
const SURVEY_LIGHT_YEARS = 8

export function NavPanel({
  engine,
  onNotice,
}: {
  engine: GameEngine
  onNotice: (message: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  /*
   * The scenario currently running, if any. The scenarios are seconds long and
   * their buttons had no busy state at all, so ten impatient clicks were ten
   * concurrent scenarios racing to teleport the same ship.
   */
  const [pending, setPending] = useState<string | null>(null)
  /*
   * The engine's answer, not this panel's memory of what it asked for.
   *
   * This used to be a `useState` mirroring `engine.showShip`, and it disagreed
   * with `PlanetariumMode` the moment either acted: the mode's effect restored
   * the field on the way out and nothing told the button. A published boolean
   * bails out of the re-render with `Object.is`, so subscribing costs less than
   * the mirror did.
   */
  const shipShown = useEngine((snapshot) => snapshot.presentation.showShip)
  /*
   * The user's override, on top of whatever the mode asked for.
   *
   * This is the case that decided the stance's shape (`engine/presentation.ts`):
   * a *panel* wanting a different answer than its mode. As a push it composes
   * for free and needs no channel of its own — the mode below is untouched, and
   * releasing this hands the answer straight back to it.
   */
  const override = useRef<StanceHandle | null>(null)
  useEffect(() => () => override.current?.release(), [])
  const toggleShip = (): void => {
    if (override.current !== null) {
      override.current.release()
      override.current = null
      return
    }
    override.current = engine.presentation.push({ showShip: !shipShown })
  }
  // Bumped by every action, so the listing refreshes on the spot rather than
  // showing where you used to be until the next poll.
  const [generation, setGeneration] = useState(0)

  /*
   * The listing, which this panel and the planetarium's catalog share
   * (`hud/useTravelTargets.ts`).
   *
   * Both owned a copy of the same poll, try/catch and empty-state flag, and
   * they had drifted to two radii and two rates. The address field doubles as
   * the search box now: typing goes to `StarCatalog.search` over the whole
   * catalog rather than filtering the survey, so a star ninety light years out
   * is reachable by name instead of only by address.
   */
  const {
    rows: targets,
    ready: surveyed,
    failure: surveyFailure,
  } = useTravelTargets(engine, {
    lightYears: SURVEY_LIGHT_YEARS,
    query,
    generation,
  })

  useEffect(() => {
    setFailure((current) => {
      if (surveyFailure === null) {
        return current?.action === 'the survey' ? null : current
      }
      return current !== null && current.message === surveyFailure
        ? current
        : { action: 'the survey', message: surveyFailure }
    })
  }, [surveyFailure])

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
              {!surveyed
                ? 'surveying…'
                : query.trim() !== ''
                  ? 'no cataloged star is called that — an address still works'
                  : `no systems within ${SURVEY_LIGHT_YEARS} ly — fly somewhere, or type an address above`}
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
         * are why it exists: a debug cone parked dead center ruins every
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
            onClick={toggleShip}
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
