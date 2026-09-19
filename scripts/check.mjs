#!/usr/bin/env node
/*
 * `pnpm check` — every check the repository makes, as one graph.
 *
 *     pnpm check                       the whole gate, in parallel
 *     pnpm check --only gate           what the Stop hook runs: graph, lint, typecheck, test
 *     pnpm check --only typecheck      the six type projects — what `pnpm typecheck` is
 *     pnpm check --skip slow,bundle    everything but the named stages
 *     pnpm check --force               ignore the stamps and run everything
 *     pnpm check --list                the stages, their needs and their weights
 *
 * One list of stages, run here rather than chained with `&&` in package.json,
 * for three reasons that are each measured.
 *
 * **Most of the gate is independent, and a chain pays for that in wall
 * clock.** Sequentially the ten stages cost 244 s on a ten-core M5 with a cold
 * terrain archive — 96 s of `test:slow`, 69 s of `build`, 27 s of `test`, 25 s
 * of `spelling:check` on one core — and nothing in that list needs the one
 * before it except the bundle, which needs the documentation staged. Run as a
 * graph the wall clock is the longest stage plus whatever cannot fit beside
 * it, and the table this prints says which.
 *
 * **`pnpm build` type-checks, and so does the stage before it.** `build` runs
 * `pnpm typecheck` because Workers Builds calls it alone and a deploy must not
 * bundle a tree that does not type. Inside the gate that is 19 s of the same
 * six `tsc` runs twice. Here the bundle is its own stage and typecheck is six
 * stages that run beside each other, so the six projects cost what the
 * slowest one costs rather than their sum.
 *
 * **The Stop hook and `/ship` run the same stages on the same tree, minutes
 * apart.** A stage that passed is stamped with a key made of the working
 * tree's content — every tracked and untracked file, hashed — and the Node
 * version and the stage's own command line. A later run on a byte-identical
 * tree reuses the stamp and says so. A single edit anywhere changes the key,
 * so this never skips a stage against a tree it did not see, and `--force` runs
 * everything regardless. CI has no `.data/check/` and therefore no stamps.
 *
 * Every stage is a package.json script or a binary the scripts already use,
 * named here by its command line, so what this runs and what a developer runs
 * by hand cannot drift apart. `.github/workflows/check.yml` runs this one
 * command and nothing else, which is the same guarantee for CI.
 *
 * The core budget is what keeps parallel from meaning contended. A stage
 * declares the cores it takes — vitest its worker count, the descent one — and
 * the scheduler starts a ready stage only while the running weights fit inside
 * `availableParallelism()`. A test suite started beside three other suites
 * stops measuring the code and starts measuring the machine; the 20 s vitest
 * timeout is sized for a suite that got its cores. `IR_CHECK_JOBS` overrides
 * the budget, `--serial` sets it to one.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * How many files vitest runs at once, from `vitest.config.ts`.
 *
 * Repeated rather than imported because that file is TypeScript under vitest's
 * loader and this one runs under bare Node before anything is installed. The
 * two must agree: a `test` stage weighted below the workers it starts is the
 * contention this budget exists to prevent.
 */
const VITEST_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1))

/**
 * The stages.
 *
 * `cost` is the measured wall clock in seconds on the M5, cold, used only to
 * order the ready set — longest first, so the descent starts at t=0 and the
 * short stages fill the cores around it. It is a hint, not a budget; `timeout`
 * is the budget, and it guards a hang rather than a slow run, so every one is
 * a large multiple of the cost.
 *
 * `weight` is cores. `needs` are stages that must have passed first.
 */
const STAGES = [
  {
    name: 'graph',
    why: 'layering or a cycle in packages/*',
    argv: ['pnpm', 'graph'],
    weight: 1,
    cost: 0.4,
    timeout: 60_000,
  },
  {
    name: 'lint',
    why: 'oxlint',
    argv: ['pnpm', 'lint'],
    weight: 1,
    cost: 0.1,
    timeout: 60_000,
  },
  {
    name: 'format',
    why: 'prettier --check',
    argv: ['pnpm', 'format:check'],
    weight: 2,
    cost: 7,
    timeout: 300_000,
  },
  {
    name: 'spelling',
    why: 'a British identifier declaration',
    argv: ['pnpm', 'spelling:check'],
    weight: 1,
    cost: 25,
    timeout: 300_000,
  },
  {
    name: 'brand',
    why: 'a generated brand file is stale',
    argv: ['pnpm', 'brand:check'],
    weight: 1,
    cost: 0.2,
    timeout: 120_000,
  },
  {
    name: 'presets',
    why: 'a picture without a plate, or a composition that does not resolve',
    argv: ['pnpm', 'presets:check'],
    weight: 1,
    cost: 0.2,
    timeout: 120_000,
  },
  ...[
    ['core', 'tsconfig.json'],
    ['game', 'apps/game/tsconfig.json'],
    ['headless', 'apps/headless/tsconfig.json'],
    ['server', 'apps/server/tsconfig.json'],
    ['ingest', 'apps/ingest/tsconfig.json'],
  ].map(([project, config]) => ({
    name: `typecheck:${project}`,
    group: 'typecheck',
    why: `tsc -p ${config}`,
    argv: [join(ROOT, 'node_modules/.bin/tsc'), '-p', config],
    weight: 1,
    cost: 6,
    timeout: 180_000,
  })),
  {
    name: 'typecheck:astro',
    group: 'typecheck',
    why: 'astro check over the templates',
    argv: ['pnpm', '--filter', '@inertialref/game', 'check'],
    weight: 1,
    cost: 8,
    timeout: 180_000,
  },
  {
    name: 'test',
    why: 'vitest',
    argv: ['pnpm', 'test'],
    weight: VITEST_WORKERS,
    cost: 27,
    timeout: 600_000,
  },
  {
    name: 'slow',
    why: 'the terrain descent or the galaxy calibration',
    argv: ['pnpm', 'test:slow'],
    // The descent is one core for the whole run; the three galaxy files run
    // beside it, so the suite reads about 150% of a core.
    weight: 2,
    cost: 96,
    timeout: 900_000,
  },
  {
    name: 'sim',
    why: 'one of the twelve capability checks',
    // The bare runner rather than `pnpm sim`, which opens an inspector on
    // 9229 and would refuse to start beside a `pnpm sim` a person has up.
    argv: ['node', 'apps/headless/src/main.ts', '--self-test'],
    weight: 1,
    cost: 0.4,
    timeout: 120_000,
  },
  {
    name: 'media',
    why: 'the optional media pull',
    argv: ['node', 'scripts/media.mjs', 'pull', '--optional'],
    weight: 1,
    cost: 1,
    timeout: 300_000,
  },
  {
    name: 'docs',
    why: 'the documentation build — an unlisted page or a dead link',
    argv: ['pnpm', 'docs:build'],
    weight: 1,
    cost: 15,
    timeout: 300_000,
  },
  {
    name: 'bundle',
    why: 'astro build, or the site check after it',
    argv: ['pnpm', '--filter', '@inertialref/game', 'build'],
    needs: ['media', 'docs'],
    weight: 2,
    cost: 40,
    timeout: 600_000,
  },
]

/** Names a `--only` may use for several stages at once. */
const GROUPS = {
  typecheck: STAGES.filter((s) => s.group === 'typecheck').map((s) => s.name),
  gate: [
    'graph',
    'lint',
    ...STAGES.filter((s) => s.group === 'typecheck').map((s) => s.name),
    'test',
  ],
}

const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    skip: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    serial: { type: 'boolean', default: false },
    'keep-going': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(
    [
      'pnpm check — every check, as one graph',
      '',
      '  --only <stage|group>   run these (repeat, or comma-separate). Groups: gate, typecheck',
      '  --skip <stage>         run everything but these',
      '  --force                ignore the stamps in .data/check and run every stage',
      '  --keep-going           after a failure, let the other stages finish',
      '  --serial               one stage at a time (a core budget of one)',
      '  --json                 one JSON object of the result, for a hook',
      '  --list                 print the stages',
      '',
      'IR_CHECK_JOBS=<n> sets the core budget; the default is availableParallelism().',
    ].join('\n'),
  )
  process.exit(0)
}

const expand = (names = []) =>
  names
    .flatMap((one) => one.split(','))
    .map((one) => one.trim())
    .filter(Boolean)
    .flatMap((one) => {
      if (one in GROUPS) return GROUPS[one]
      if (!STAGES.some((s) => s.name === one))
        throw new Error(
          `no stage called ${one}. Stages: ${STAGES.map((s) => s.name).join(', ')}; groups: ${Object.keys(GROUPS).join(', ')}`,
        )
      return [one]
    })

const only = new Set(expand(values.only))
const skip = new Set(expand(values.skip))
let selected = STAGES.filter(
  (s) => (only.size === 0 || only.has(s.name)) && !skip.has(s.name),
)
/*
 * A selected stage pulls its needs in, because `--only bundle` that silently
 * ran without the documentation staged would fail for a reason the caller did
 * not ask about. The pulled-in stage is reported like any other.
 */
for (;;) {
  const missing = selected
    .flatMap((s) => s.needs ?? [])
    .filter((need) => !selected.some((s) => s.name === need))
  if (missing.length === 0) break
  selected = STAGES.filter(
    (s) => selected.includes(s) || missing.includes(s.name),
  )
}

if (values.list) {
  for (const stage of selected)
    console.log(
      `${stage.name.padEnd(18)} ${String(stage.weight).padStart(2)} core(s)  ${(stage.needs ?? []).join(',').padEnd(12)} ${stage.argv.join(' ')}`,
    )
  process.exit(0)
}

const budget = values.serial
  ? 1
  : Math.max(
      1,
      Number.parseInt(process.env.IR_CHECK_JOBS ?? '', 10) ||
        availableParallelism(),
    )

// --- stamps ------------------------------------------------------------------------

const STAMPS = join(ROOT, '.data/check')

/**
 * A key for the working tree as it is, not as it was committed.
 *
 * `HEAD^{tree}` plus every path `git status` reports as modified, added or
 * untracked, each hashed from the working copy in one `hash-object` call.
 * Ignored files are left out on purpose: `node_modules`, `.data` and `dist`
 * are outputs, and the lockfile that decides the first of them is tracked.
 * Nothing is written to the index and no LFS filter runs — a content id is
 * all this needs, and hashing the working copy of a 15 MB model through
 * `git-lfs clean` on every gate is the cost this avoids.
 */
function treeKey() {
  const git = (args, input) =>
    execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      maxBuffer: 1 << 26,
    })
  const head = git(['rev-parse', 'HEAD^{tree}']).trim()
  const status = git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ])
  const present = []
  const gone = []
  for (const entry of status.split('\0')) {
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (existsSync(join(ROOT, path))) present.push(path)
    else gone.push(path)
  }
  present.sort()
  gone.sort()
  const blobs =
    present.length === 0
      ? []
      : git(
          ['hash-object', '--no-filters', '--stdin-paths'],
          present.join('\n') + '\n',
        )
          .trim()
          .split('\n')
  const hash = createHash('sha256').update(head)
  present.forEach((path, i) => hash.update(`\n${path} ${blobs[i]}`))
  for (const path of gone) hash.update(`\n${path} deleted`)
  return hash.digest('hex')
}

const stampKey = (stage, tree) =>
  createHash('sha256')
    .update(`${tree}\n${process.version}\n${stage.argv.join('\0')}`)
    .digest('hex')

function readStamp(stage) {
  try {
    return JSON.parse(readFileSync(join(STAMPS, `${stage.name}.json`), 'utf8'))
  } catch {
    return null
  }
}

function writeStamp(stage, key, seconds) {
  mkdirSync(STAMPS, { recursive: true })
  writeFileSync(
    join(STAMPS, `${stage.name}.json`),
    JSON.stringify({ key, at: new Date().toISOString(), seconds }),
  )
}

let tree = null
try {
  tree = treeKey()
} catch {
  /* not a git checkout, or git is unavailable: every stage runs */
}

// --- output ------------------------------------------------------------------------

const tty = process.stdout.isTTY && !values.json
const paint = (code, text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text)
const green = (text) => paint('32', text)
const red = (text) => paint('31', text)
const dim = (text) => paint('2', text)
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const say = (line) => {
  if (!values.json) console.log(line)
}

const ago = (iso) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 120) return `${minutes} min ago`
  return `${Math.round(minutes / 60)} h ago`
}

// --- the scheduler -------------------------------------------------------------------

/**
 * No color from a child, whatever the terminal is.
 *
 * Stage output is buffered and printed only on failure, into a hook's report
 * or a CI log, and escape codes there are noise around the file name that
 * matters. `NO_COLOR` is the convention every tool here honors; a `FORCE_COLOR`
 * inherited from the shell would override it, so it is removed rather than set
 * to zero, which some readers take as "force".
 */
function childEnv() {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR
  return env
}

const results = new Map()
const running = new Map()
let failed = false
const startedAt = performance.now()

say(
  dim(
    `check · ${selected.length} stage${selected.length === 1 ? '' : 's'} on a budget of ${budget} core${budget === 1 ? '' : 's'}`,
  ),
)

const passed = (name) => results.get(name)?.status === 'passed'

function ready() {
  return selected
    .filter((s) => !results.has(s.name) && !running.has(s.name))
    .filter((s) => (s.needs ?? []).every(passed))
    .sort((a, b) => b.cost - a.cost)
}

function weightRunning() {
  let total = 0
  for (const stage of running.keys())
    total += selected.find((s) => s.name === stage).weight
  return total
}

function record(stage, result) {
  results.set(stage.name, result)
  running.delete(stage.name)
  const label = stage.name.padEnd(18)
  switch (result.status) {
    case 'passed':
      say(`  ${green('✓')} ${label} ${dim(seconds(result.ms))}`)
      break
    case 'reused':
      say(
        `  ${dim('·')} ${label} ${dim(`passed ${ago(result.at)} on this tree`)}`,
      )
      break
    case 'failed':
      say(
        `  ${red('✗')} ${label} ${dim(seconds(result.ms))}  ${red(stage.why)}`,
      )
      break
    case 'timedOut':
      say(
        `  ${red('✗')} ${label} ${dim(seconds(result.ms))}  ${red(`killed after ${stage.timeout / 1000}s — hung, or outgrown its budget`)}`,
      )
      break
    case 'cancelled':
      say(`  ${dim('–')} ${label} ${dim('not run')}`)
      break
    case 'blocked':
      say(`  ${dim('–')} ${label} ${dim(`needs ${result.needs.join(', ')}`)}`)
      break
  }
}

function start(stage) {
  const key = tree === null ? null : stampKey(stage, tree)
  if (!values.force && key !== null) {
    const stamp = readStamp(stage)
    if (stamp?.key === key) {
      record(stage, { status: 'reused', at: stamp.at, ms: 0 })
      return
    }
  }
  const began = performance.now()
  const chunks = []
  const child = spawn(stage.argv[0], stage.argv.slice(1), {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, stage.timeout)
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.on('data', (chunk) => chunks.push(chunk))
  const done = new Promise((resolve) => {
    child.on('error', (cause) => {
      chunks.push(Buffer.from(String(cause)))
      resolve(null)
    })
    child.on('close', (code) => resolve(code))
  }).then((code) => {
    clearTimeout(timer)
    const ms = performance.now() - began
    const output = Buffer.concat(chunks).toString('utf8').trimEnd()
    if (running.get(stage.name)?.cancelled) {
      record(stage, { status: 'cancelled', ms, output })
      return
    }
    if (timedOut) {
      failed = true
      rmSync(join(STAMPS, `${stage.name}.json`), { force: true })
      record(stage, { status: 'timedOut', ms, output })
      return
    }
    if (code !== 0) {
      failed = true
      // A stamp from an earlier pass on this same tree would otherwise let the
      // next run reuse a result the stage has just contradicted.
      rmSync(join(STAMPS, `${stage.name}.json`), { force: true })
      record(stage, { status: 'failed', ms, output, code })
      return
    }
    if (key !== null) writeStamp(stage, key, ms / 1000)
    record(stage, { status: 'passed', ms })
  })
  running.set(stage.name, { child, done, cancelled: false })
}

for (;;) {
  if (failed && !values['keep-going']) {
    for (const entry of running.values()) {
      entry.cancelled = true
      entry.child.kill('SIGTERM')
    }
    await Promise.all([...running.values()].map((entry) => entry.done))
    for (const stage of selected)
      if (!results.has(stage.name))
        record(stage, { status: 'cancelled', ms: 0 })
    break
  }
  const pending = selected.filter((s) => !results.has(s.name))
  if (pending.length === 0) break
  let launched = false
  for (const stage of ready()) {
    if (running.size > 0 && weightRunning() + stage.weight > budget) continue
    start(stage)
    launched = true
    if (running.size > 0 && weightRunning() >= budget) break
  }
  if (launched) continue
  if (running.size === 0) {
    // Nothing runs and nothing is ready: what is left is behind a failure.
    for (const stage of pending)
      record(stage, {
        status: 'blocked',
        ms: 0,
        needs: (stage.needs ?? []).filter((n) => !passed(n)),
      })
    break
  }
  await Promise.race([...running.values()].map((entry) => entry.done))
}

// --- the report --------------------------------------------------------------------

const wall = performance.now() - startedAt
const ordered = selected.map((s) => ({ name: s.name, ...results.get(s.name) }))
const failures = ordered.filter(
  (r) => r.status === 'failed' || r.status === 'timedOut',
)
const reused = ordered.filter((r) => r.status === 'reused').length
const cpu = ordered.reduce((sum, r) => sum + (r.ms ?? 0), 0)

if (values.json) {
  console.log(
    JSON.stringify({
      ok: failures.length === 0,
      wallSeconds: wall / 1000,
      budget,
      tree,
      stages: ordered.map((r) => ({
        name: r.name,
        why: selected.find((s) => s.name === r.name).why,
        status: r.status,
        seconds: (r.ms ?? 0) / 1000,
        ...(r.output === undefined ? {} : { output: r.output }),
      })),
    }),
  )
} else {
  for (const one of failures) {
    console.log(`\n${red(`── ${one.name} ──`)}`)
    console.log(one.output || dim(`(no output; exit ${one.code})`))
  }
  const summary = `${seconds(wall)} wall, ${seconds(cpu)} of stage time${reused > 0 ? `, ${reused} reused` : ''}`
  if (failures.length === 0) {
    say(`\n${green('check passed')} ${dim(`· ${summary}`)}`)
  } else {
    say(
      `\n${red('check failed')}: ${failures.map((f) => f.name).join(', ')} ${dim(`· ${summary}`)}`,
    )
  }
}

if (failures.length > 0) process.exitCode = 1
