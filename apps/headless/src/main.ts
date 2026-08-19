/*
 * Headless runner.
 *
 * Exists to prove a claim that is easy to make and easy to quietly break: the
 * simulation core runs with no DOM, no React and no WebGL. If an import of
 * `window` ever creeps into `packages/simulation` or anything below it, this
 * stops working immediately, and it runs in CI as part of `pnpm check`.
 *
 * It is also the shape a server-authoritative process would take, which is why
 * it drives the same harness the browser does rather than a parallel API.
 *
 *   pnpm sim                       # default scenario
 *   pnpm sim --seed voyager --ticks 6400 --self-test
 */
import { parseArgs } from 'node:util'
import { createConsoleSink, logHub } from '@inertialref/shared'
import { vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import { bodyFrameId, type EntityId, systemId, walkBodies } from '@inertialref/universe'
import { GameHarness, type HarnessHost } from '@inertialref/devtools'
import { createInlineWorker, createTaskRegistry, WorkerPool } from '@inertialref/workers'
import { MemorySaveStore, captureSave, serializeSave } from '@inertialref/persistence'

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

const world = new World({ seed: values.seed ?? 'inertialref' })
const system = world.loadSystem(systemId(values.system ?? 'SOL'))
const target = [...walkBodies(system)].find((body) => body.kind === 'rocky' && body.radius > 1e6)
if (target === undefined) throw new Error(`No solid body in ${system.name}`)

let player: EntityId | null = world.spawnShip(
  'Debug One',
  bodyFrameId(target.address),
  vec3(target.radius * 3, 0, 0),
).id

const registry = createTaskRegistry()
const pool = new WorkerPool({
  // Node has worker_threads, but the point of this runner is the *simulation*,
  // and an in-process pool exercises the identical host loop without the
  // module-resolution ceremony of spawning a worker for a source-only package.
  factory: () => createInlineWorker(registry, () => performance.now()),
  size: 2,
  now: () => performance.now(),
})

const host: HarnessHost = {
  get world() {
    return world
  },
  player: () => player,
  setPlayer: (id) => {
    player = id
  },
  scene: () => null,
  pool: () => pool,
  frameStats: () => null,
  replaceWorld: () => {
    throw new Error('the headless runner does not reload worlds')
  },
}

const harness = new GameHarness(host)

console.log(`InertialRef headless — seed "${world.seedText}", ${system.name}, target ${target.name}`)
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

const store = new MemorySaveStore()
const save = serializeSave(captureSave(world, player))
await store.write('headless', save)
console.log(`save: ${save.length} bytes`)

if (values['self-test'] === true) {
  const report = await harness.selfTest()
  console.log(report.report)
  if (report.passed !== report.total) process.exitCode = 1
}

pool.terminate()
