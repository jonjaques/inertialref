import { useState } from 'react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from './Action.tsx'
import { Section } from './Section.tsx'

/**
 * The author's own verbs: scripted scenes, scenarios, and the self test.
 *
 * Where the deleted Navigate panel's author-only half landed. Navigate was two
 * things wearing one title — the product's navigation, filed under the
 * instruments, plus three sections nobody but the author ever presses — and it
 * was wrong about both. Going places is the Catalog, which every mode's
 * workspace now carries with a verb that depends on the mode. These three are
 * scaffolding and belong behind the disclosure that says so.
 *
 * Everything here is a harness call, which is the rule the panel it came from
 * was written under and the reason it survives the move unchanged: nothing a
 * button does may be unreachable from the console and from a headless test.
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

  const run = (label: string, action: () => void): void => {
    try {
      action()
      onNotice(label)
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const awaited = (label: string, action: () => Promise<string>): void => {
    if (pending !== null) return
    setPending(label)
    void action()
      .then(onNotice)
      .catch((cause: unknown) =>
        onNotice(cause instanceof Error ? cause.message : String(cause)),
      )
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
