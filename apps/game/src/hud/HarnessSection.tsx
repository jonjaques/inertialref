import { useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'
import { attempt, describeCause } from './notice.ts'
import { Section } from './Section.tsx'

/**
 * The author's own verbs: scripted scenes, scenarios, and the self test.
 *
 * Behind a disclosure, because these three are scaffolding and nobody but the
 * author presses them. Going places is not filed here: that is the Catalog,
 * which every mode's workspace carries with a verb that depends on the mode.
 * Mixing the two under one title would file the product's navigation under the
 * instruments and hide the author's tools in plain sight.
 *
 * Everything here is a harness call, and that is a rule rather than an
 * observation: nothing a button does may be unreachable from the console and
 * from a headless test.
 */
export function HarnessSection({
  engine,
  onNotice,
}: {
  readonly engine: GameEngine
  readonly onNotice: (message: string) => void
}) {
  /*
   * The scenario currently running, if any.
   *
   * The scenarios are seconds long and their buttons had no busy state at all,
   * so ten impatient clicks were ten concurrent scenarios racing to teleport
   * the same ship. One at a time: these reach the same world through the same
   * harness, and two of them interleaved is not a slower answer, it is a
   * different one.
   */
  const [pending, setPending] = useState<string | null>(null)

  const run = (label: string, action: () => void): void =>
    attempt(onNotice, label, action)

  const awaited = (label: string, action: () => Promise<string>): void => {
    if (pending !== null) return
    setPending(label)
    void action()
      .then(onNotice)
      .catch((cause: unknown) => onNotice(describeCause(cause)))
      .finally(() => setPending(null))
  }

  return (
    <>
      <Section id="controls.cutscenes" title="Cutscenes">
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
              title={`${description} — ${Math.round(seconds)} s`}
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
        id="controls.scenarios"
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
    </>
  )
}
