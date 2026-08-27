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
 *   pnpm sim --targets             # where can this session go?
 *   pnpm sim --goto b:2 --ticks 0  # and go there
 *   pnpm sim --terrain-baseline    # what terrain costs, measured
 */
import { parseArgs } from 'node:util'
import { createConsoleSink, logHub } from '@inertialref/shared'
import { openSession } from '@inertialref/devtools'
import { createInlineWorker, createTaskRegistry } from '@inertialref/workers'
import { loadStarCatalog } from './catalog.ts'
import { captureSave, serializeSave } from '@inertialref/persistence'

const OPTIONS = {
  seed: { type: 'string', default: 'inertialref' },
  system: { type: 'string', default: 'SOL' },
  ticks: { type: 'string', default: '3840' },
  scenario: { type: 'string', default: 'orbit' },
  /** A system designation or a body address, applied after the scenario. */
  goto: { type: 'string' },
  /** Print the travel listing, which is also the answer to "what exists?". */
  targets: { type: 'boolean', default: false },
  'self-test': { type: 'boolean', default: false },
  /**
   * Walk the terrain zoo and print what a descent costs. See TERRAIN-PLAN § 9.
   *
   * Off by default because it generates systems and a few hundred heightfields
   * — a couple of seconds, against the twenty milliseconds an ordinary run
   * takes — and every other flag here is cheap enough to leave on.
   */
  'terrain-baseline': { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const

const { values } = parseArgs({ options: OPTIONS })

if (values.help === true) {
  // The working guide has always said this flag exists; it did not, and
  // `parseArgs` answered it by throwing "Unknown option".
  console.log('pnpm sim — headless InertialRef runner\n')
  for (const [name, option] of Object.entries(OPTIONS)) {
    const fallback =
      'default' in option ? ` (default ${String(option.default)})` : ''
    console.log(
      `  --${name}${option.type === 'string' ? ' <value>' : ''}${fallback}`,
    )
  }
  process.exit(0)
}

if (!values.quiet) {
  logHub.addSink(createConsoleSink(console, 'info'))
}

const registry = createTaskRegistry()
const session = openSession({
  ...(values.seed === undefined ? {} : { seed: values.seed }),
  ...(values.system === undefined ? {} : { system: values.system }),
  catalog: loadStarCatalog(),
  // Node has worker_threads, but the point of this runner is the *simulation*,
  // and an in-process pool exercises the identical host loop without the
  // module-resolution ceremony of spawning a worker for a source-only package.
  workers: () => createInlineWorker(registry, () => performance.now()),
  now: () => performance.now(),
})
// Note `session.world` rather than a destructured `world`: loading a save
// replaces it, and a captured reference is the exact bug the getter exists for.
const { harness, system, target } = session

console.log(
  `InertialRef headless — seed "${session.world.seedText}", ${system.name}, target ${target.name}`,
)
// The detail, not just the side effect. A scenario's return value is its
// sentence — "circular orbit 300 km above b:0" — and for `--scenario descent`
// the detail *is* the whole output, so dropping it leaves the runner silent.
console.log((await harness.scenario(values.scenario ?? 'orbit')).detail)

// After the scenario, not instead of it: a scenario sets up a situation and
// `--goto` says where to watch it from, so the two compose.
if (values.goto !== undefined) {
  harness.goTo(values.goto)
  console.log(`goTo ${values.goto} — ${harness.summary()}`)
}

if (values.targets === true) {
  for (const entry of harness.targets()) {
    const indent = '  '.repeat(entry.depth)
    const mark = entry.kind === 'system' ? '*' : entry.landable ? 'o' : '.'
    console.log(
      `${indent}${mark} ${entry.name.padEnd(24 - indent.length)} ${entry.detail.padEnd(30)} ${entry.distanceText.padStart(12)}  ${entry.address}`,
    )
  }
}

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

if (values['terrain-baseline'] === true) {
  // Order-independent, and that is a property of the zoo rather than of this
  // file: the search anchors at Sol and walks `systemsWithin` in its own sorted
  // order, so the self-test loading Alpha Centauri first cannot change what the
  // baseline finds. It stays above the self-test only because a reader wants
  // the measurement before the twelve-line report, not because it has to.
  console.log(harness.terrainBaseline().text)
}

if (values['self-test'] === true) {
  const report = await harness.selfTest()
  console.log(report.report)
  if (report.passed !== report.total) process.exitCode = 1
}

session.dispose()
