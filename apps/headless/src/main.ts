/*
 * Headless runner.
 *
 * Exists to prove a claim that is easy to make and easy to quietly break: the
 * simulation core runs with no DOM, no React and no WebGL. If an import of
 * `window` ever creeps into `packages/simulation` or anything below it, this
 * stops working immediately. Note it is *not* part of `pnpm check` — that runs
 * the vitest suite, which covers the same boundary from the other direction.
 * This is the one that has to be run by hand, or by whatever eventually runs CI.
 *
 * It is also the shape a server-authoritative process would take, which is why
 * it drives the same harness the browser does rather than a parallel API.
 *
 *   pnpm sim                       # default scenario
 *   pnpm sim --seed voyager --ticks 6400 --self-test
 */
import { parseArgs } from 'node:util'
import { createConsoleSink, logHub } from '@inertialref/shared'
import { openSession } from '@inertialref/devtools'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { captureSave, serializeSave } from '@inertialref/persistence'

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: 'inertialref' },
    system: { type: 'string', default: 'SOL' },
    ticks: { type: 'string', default: '3840' },
    scenario: { type: 'string', default: 'orbit' },
    'self-test': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
})

if (!values.quiet) {
  logHub.addSink(createConsoleSink(console, 'info'))
}

const registry = createTaskRegistry()
const session = openSession({
  ...(values.seed === undefined ? {} : { seed: values.seed }),
  ...(values.system === undefined ? {} : { system: values.system }),
  // Node has worker_threads, but the point of this runner is the *simulation*,
  // and an in-process pool exercises the identical host loop without the
  // module-resolution ceremony of spawning a worker for a source-only package.
  workers: () => createInlineWorker(registry, () => performance.now()),
  now: () => performance.now(),
})
// Note `session.world` rather than a destructured `world`: loading a save
// replaces it, and a captured reference is the exact bug the getter exists for.
const { harness, system, target } = session

console.log(`InertialRef headless — seed "${session.world.seedText}", ${system.name}, target ${target.name}`)
await harness.scenario(values.scenario ?? 'orbit')

const ticks = Number.parseInt(values.ticks ?? '3840', 10)
const started = performance.now()
harness.step(ticks)
const elapsed = performance.now() - started

console.log(harness.summary())
console.log(
  `${ticks} ticks in ${elapsed.toFixed(1)} ms — ${((ticks / elapsed) * 1000).toFixed(0)} ticks/s, ` +
    `${(ticks / 64).toFixed(1)} s of simulation`,
)

const save = serializeSave(captureSave(session.world, session.player()))
await session.store.write('headless', save)
console.log(`save: ${save.length} bytes`)

if (values['self-test'] === true) {
  const report = await harness.selfTest()
  console.log(report.report)
  if (report.passed !== report.total) process.exitCode = 1
}

session.dispose()
