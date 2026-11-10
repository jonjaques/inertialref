#!/usr/bin/env node
/*
 * The weather's measurement campaigns: the runner's batches and the opt-in
 * instruments in order, on a preview this process builds and serves, in a
 * session of its own that nobody has to watch.
 *
 *     node scripts/clouds/campaign.mjs start choices      # detaches; prints where it writes
 *     node scripts/clouds/campaign.mjs status             # one screen, the latest campaign
 *     node scripts/clouds/campaign.mjs stop               # rigs closed, lock and preview released
 *     node scripts/clouds/campaign.mjs start choices --resume   # where a stopped one left off
 *
 * `choices` measures the quality ladders (`images`), then the three GPU
 * instruments: the far atlas, the sun grid and the composite's forms each
 * against its reference (§8.8). `landed` measures the code as it ships:
 * `targets`, `memory`, `error`, always on a fresh build.
 *
 * A campaign takes hours, and whatever starts it does not last that long: a
 * background command in an agent's harness is stopped at two hours, and a
 * closed terminal takes its jobs with it. So `start` checks what it can and
 * hands the work to a detached process under `caffeinate -dims`, which holds
 * the machine awake and a lit display lit. It does not wake a dark one, and
 * `-u`, which would, is left out: an unattended Mac's session is locked, and
 * a lit lock screen over the rig's window paces it at 51–68 Hz, unevenly,
 * where the same stance presents at 115–119 with the display dark, the
 * nearest this machine comes unattended to the panel's 120. The rig is a real
 * window whose frames follow the display (drive.mjs's header), so every row
 * records the rate it presented at (`page.mjs`), and a batch's tables say
 * when its rows disagree. Not a LaunchAgent, which outlives the campaign and
 * is a confirm-first change on this machine.
 *
 * Each batch writes one document, `--resume`d on every attempt, so a stage
 * that stops (exit 1), or ends with runs still marked under load, is
 * continued after `PAUSE_MS` with what it measured kept, up to its
 * `attempts`. A refusal (exit 2) stops the campaign: the
 * runner refuses a row that has failed three times, and the same command would
 * meet the same refusal. The preview is checked before each attempt and served
 * again if it died, and a server on its port that is not this campaign's
 * stops the campaign; it is stopped on every exit, clean or not, and the
 * runner's own exit closes its rigs and releases the GPU lock.
 *
 * Everything lands in `.data/clouds/campaign/`: `<name>.json`, the state,
 * rewritten at every transition; the log and the preview's log; and at the
 * end the summary, every batch's tables and the instruments' paths.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseCapture } from '../weather/capture.mjs'
import { armPlan } from './frame.mjs'
import {
  HELD,
  HOLDS,
  SIZES,
  answers,
  batchRuns,
  boots,
  bundled,
  dryRun,
  git,
  listeners,
  processes,
} from './measure.mjs'
import { CLIPS, BANDS } from './noise.mjs'
import { estimate, measured, minutes, plan, rateNote, tables } from './page.mjs'
import { evaluate, holdAccepted, rulesTable } from './rules.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const MEASURE = path.join(ROOT, 'scripts/clouds/measure.mjs')
const OUT = path.join(ROOT, '.data/clouds')
const HOME = path.join(OUT, 'campaign')
const URL_ = 'http://localhost:8787/'
/** The wait before a stopped stage is tried again: long enough for a stray
 *  build to finish, short against a batch. */
const PAUSE_MS = 120_000
const GPU_WAIT = '1800'

/* -------------------------------------------------------------- the stages ---- */

/**
 * A batch of the runner. Its `minutes` are the runner's own estimate of its
 * rows (`estimate` in `measure.mjs`), which the ETA starts from. `hold` says
 * what a batch that reads a rate does when the hold's acceptance failed:
 * `record`, its rows taken at whatever rate the machine gives and bound by
 * nothing; `require`, not taken. `when` names a start option the stage waits
 * for, so a stage whose subject may not exist is taken only when asked.
 */
const batch = (name, extra = {}) => ({
  name,
  kind: 'batch',
  attempts: 8,
  ...extra,
})

/**
 * The seven opt-in GPU instruments of §7.2, each with the package that
 * builds it (§10.2); the stage takes the ones the tree holds and names the
 * rest with their packages.
 */
export const INSTRUMENT_OWNERS = Object.freeze({
  cloudCumulus: 'N',
  cloudGlory: 'M2',
  cloudHandover: 'X',
  cloudFarCompare: 'phase 0',
  cloudSunAccuracy: 'phase 0',
  cloudCompositeError: 'phase 0',
  cloudPathTrace: 'R2',
})
export const INSTRUMENT_NAMES = Object.freeze(Object.keys(INSTRUMENT_OWNERS))

/** What an instruments stage runs today, and what it waits for and from whom. */
export function instrumentsText(names, exists = existsSync) {
  const on = present(names, exists)
  const off = names.filter((n) => !on.includes(n))
  return [
    `runs ${on.join(', ') || 'none'}`,
    ...(off.length > 0
      ? [
          `not in the tree yet: ${off.map((n) => `${n} (package ${INSTRUMENT_OWNERS[n]})`).join(', ')}`,
        ]
      : []),
  ].join('; ')
}
const instrumentFile = (name) =>
  path.join(ROOT, 'apps/game/src/render', `${name}.gpu.test.ts`)

/** A vitest run of GPU instruments under `IR_CLOUD_MEASURE`, each writing its own document. */
const vitest = (names) => [
  'pnpm',
  'vitest',
  'run',
  '--config',
  'apps/game/vitest.gpu.config.ts',
  ...names,
]

/** The instruments, each against its reference, written to `.data/clouds/` in place. */
const INSTRUMENTS = {
  name: 'instruments',
  kind: 'command',
  // The path tracer runs up to 45 minutes (research §3.3, an estimate).
  minutes: 60,
  // An instrument that fails its sanity bound fails again, so it gets
  // one more try for a crash and no more.
  attempts: 2,
  instruments: INSTRUMENT_NAMES,
  env: { IR_CLOUD_MEASURE: '1', IR_GPU_WAIT: GPU_WAIT },
  outputs: ['farCompare', 'sunAccuracy', 'compositeError'].map((n) =>
    path.join('.data/clouds', `${n}.json`),
  ),
}

/** A cast through the capture at one lever's value: `capture.mjs`'s `--lever`. */
const castAt = (only, lever, value, extra = []) => [
  process.execPath,
  'scripts/weather/capture.mjs',
  ...['--phase', '1', '--url', URL_, '--gpu-wait', GPU_WAIT],
  ...['--only', only, '--no-samples', '--baseline-casts'],
  ...['--lever', `${lever}=${value}`],
  ...extra,
]

/**
 * The casts §7.4's band and clip rules read: the zoom from 400 km and the
 * slow descent at each band, the pass at 2 m and the fast descent at each
 * clip, each with its clouds-off control and the detector's held controls.
 * `castSteps` classifies them in the capture's record.
 */
const CASTS = {
  name: 'casts',
  kind: 'command',
  minutes: 60,
  attempts: 2,
  needs: 'lever',
  commands: [
    ...BANDS.map((b) => castAt('g6', 'handoverBand', b)),
    ...CLIPS.map((c) => castAt('g6,g1', 'clip', c)),
  ],
}

/** The sun's accuracy on the two-level volume, at phase 0's two suns and G3's. */
const SUN = {
  name: 'sun',
  kind: 'command',
  minutes: 10,
  attempts: 2,
  instruments: ['cloudSunAccuracy'],
  env: { IR_CLOUD_MEASURE: '1', IR_GPU_WAIT: GPU_WAIT },
}

/** The wake cast and a cut cast at each `sunRamp`, for the ramp's rule. */
const SUN_CASTS = {
  name: 'sun-casts',
  kind: 'command',
  minutes: 20,
  attempts: 2,
  needs: 'lever',
  commands: [8, 16, 32].map((r) => castAt('g6', 'sunRamp', r, ['--cut', 'e1'])),
}

/**
 * Each campaign: whether it builds always or only a bundle not HEAD's, and
 * its stages (design §7.2). Each begins with its own pacing, one profiled
 * row and its rate, before any batch measures (§7.5). `pace-study` is the
 * study of what sets the rate, which nothing can be held before.
 */
export const CAMPAIGNS = Object.freeze({
  choices: {
    build: 'stale',
    stages: [
      batch('pacing'),
      batch('phase'),
      batch('jitter'),
      batch('handover'),
      batch('clip'),
      batch('transport', { when: 'transport' }),
      CASTS,
      INSTRUMENTS,
      batch('over', { hold: 'record' }),
      batch('reset'),
      SUN,
      SUN_CASTS,
    ],
  },
  landed: {
    build: 'always',
    stages: [
      batch('pacing'),
      batch('ladders'),
      batch('targets'),
      batch('frame'),
      batch('sequences'),
      batch('warp'),
      batch('hold'),
      batch('pace', { hold: 'record' }),
      batch('memory'),
      batch('error'),
    ],
  },
  'pace-study': {
    build: 'stale',
    stages: [batch('study')],
  },
})

/** A batch stage's runs, as the runner would take them with these start options. */
const runsOf = (stage, options = {}) =>
  batchRuns(stage.name, Object.keys(SIZES), HELD, options)

/** A stage's estimate in minutes: a batch's from its runs, a command's as written. */
export function minutesOf(stage, options = {}) {
  if (stage.kind !== 'batch') return stage.minutes
  const booted = new Map()
  const seconds = runsOf(stage, options).reduce(
    (sum, run) =>
      sum + estimate(planOf(run), boots(booted, run) || run.type === 'cold'),
    0,
  )
  return seconds / 60
}

const planOf = (run) => (run.arm == null ? plan(run) : armPlan(run))

/**
 * What a stage's exit means: done, tried again, or the campaign stopped. A
 * batch's 2 is a refusal; any other command's failure is worth a retry. A
 * batch is done when every run is measured quiet, not when it exits 0: the
 * runner exits 0 with a run marked under load on all three of its tries, and
 * the `--resume` of a retry measures again what is marked.
 */
export function outcome(stage, code) {
  if (code === 2 && stage.kind === 'batch') return 'stop'
  const owes = stage.kind === 'batch' && stage.done < stage.total
  if (code === 0 && !owes) return 'done'
  return stage.attempts < stage.allowed ? 'retry' : 'stop'
}

/**
 * When the campaign ends, as epoch milliseconds: a running batch at the rate
 * its rows have landed since this attempt at it began (`from` is what it held
 * then, so a resume hours later does not read the gap as slowness), and every
 * stage still to come at its estimate, less what it already holds.
 */
export function eta(stages, now) {
  let at = now
  for (const s of stages) {
    if (s.status === 'done' || s.status === 'not taken') continue
    const left = s.total ? 1 - s.done / s.total : 1
    const landed = s.done - (s.from ?? 0)
    at +=
      s.status === 'running' && landed > 0
        ? ((now - Date.parse(s.startedAt)) / landed) * (s.total - s.done)
        : s.minutes * 60_000 * left
  }
  return at
}

/* --------------------------------------------------------------- the state ---- */

const statePath = (name) => path.join(HOME, `${name}.json`)
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5)

const readState = (name) => {
  try {
    return JSON.parse(readFileSync(statePath(name), 'utf8'))
  } catch {
    return null
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * A batch's document, or null where none is or the read landed mid-write:
 * the runner rewrites it whole and not atomically.
 */
function documentAt(file) {
  if (file === null || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * A batch's progress from its document: runs measured quiet with every
 * figure they owe (`measured`), of all. A torn read leaves the count from
 * the last read standing.
 */
function progress(stage) {
  if (stage.kind !== 'batch') return
  const doc = documentAt(stage.file)
  if (doc === null) return
  stage.done = new Set(doc.rows.filter(measured).map((r) => r.id)).size
  stage.failures = doc.failures?.length ?? 0
}

function save(state) {
  for (const stage of state.stages) progress(stage)
  state.updatedAt = new Date().toISOString()
  state.eta = new Date(eta(state.stages, Date.now())).toISOString()
  writeFileSync(statePath(state.name), `${JSON.stringify(state, null, 2)}\n`)
}

function initial(name, stamp, head, options) {
  return {
    name,
    head,
    options,
    hold: null,
    pid: process.pid,
    status: 'running',
    reason: null,
    startedAt: new Date().toISOString(),
    log: path.join(HOME, `${name}-${stamp}.log`),
    previewLog: path.join(HOME, `${name}-${stamp}-preview.log`),
    summary: path.join(HOME, `${name}-${stamp}.md`),
    preview: { pid: null, restarts: 0 },
    stages: CAMPAIGNS[name].stages.map((s) => ({
      name: s.name,
      kind: s.kind,
      minutes: minutesOf(s, options),
      allowed: s.attempts,
      status: 'pending',
      attempts: 0,
      exit: null,
      file:
        s.kind === 'batch' ? path.join(OUT, `${s.name}-${stamp}.json`) : null,
      total: s.kind === 'batch' ? runsOf(s, options).length : null,
      done: 0,
      next: 0,
    })),
  }
}

/* ------------------------------------------------------------- the machine ---- */

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * Why a campaign cannot be resumed, or null: there is none, or it was of
 * another commit. Its document is tied to its commit, and `measure.mjs`
 * would refuse it, but only after the run had reset the state's stages and
 * rewritten its summary as failed.
 */
export function resumeRefusal(name, was, head) {
  if (was === null) return `no campaign ${name} to resume`
  if (was.head !== head)
    return `campaign ${name} was of ${was.head.slice(0, 12)}, and HEAD is ${head.slice(0, 12)}; check out its commit to resume it`
  return null
}

/** Why the campaign cannot start, or null: the checks `start` and `run` share. */
async function refusal() {
  if (git('status', '--porcelain') !== '')
    return 'the tree has uncommitted changes, and every figure is tied to a commit'
  for (const name of Object.keys(CAMPAIGNS)) {
    const s = readState(name)
    if (s?.status === 'running' && s.pid !== process.pid && alive(s.pid))
      return `campaign ${name} is running as pid ${s.pid}`
  }
  if (await answers(URL_))
    return `something already answers ${URL_}; stop it, so the campaign serves the build it checked`
  return null
}

/**
 * A child in its own process group, so a stop reaches everything under it
 * (pnpm's vitest and its workers, the runner's drive.mjs). Its stderr is kept
 * as well as logged: its last lines are a stopped stage's reason. None is
 * launched once the campaign is stopping: a signal that lands while the
 * caller awaited the preview finds no child to kill, and the check here is
 * the last one with nothing awaited between it and the spawn.
 */
export function child(command, env, ctx, launch = spawn) {
  if (ctx.stop.signal.aborted)
    return Promise.resolve({ code: 1, tail: 'stopped before it began' })
  return new Promise((resolve) => {
    const proc = launch(command[0], command.slice(1), {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'pipe'],
      detached: true,
    })
    let tail = ''
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      tail = (tail + chunk).slice(-2000)
    })
    ctx.current = proc
    proc.on('error', (error) => resolve({ code: 127, tail: error.message }))
    proc.on('close', (code, signal) => {
      ctx.current = null
      resolve({ code: code ?? 128, tail: tail.trim(), signal })
    })
  })
}

const killGroup = (proc, signal) => {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    /* already gone */
  }
}

/** What listens on the preview's port, each with its process group. */
const listening = () => listeners(URL_)

/**
 * The listeners that descend from `root`, the pnpm this campaign spawned: an
 * answer on 8787 is anyone's, and another worktree's `pnpm dev` answers
 * there as readily as the preview, so the batch would measure its tree under
 * this commit. `table` is `ps`'s, parsed.
 */
export function ours(table, found, root) {
  const parent = new Map(table.map((p) => [p.pid, p.ppid]))
  const descends = (pid) => {
    for (let at = pid; at > 1; at = parent.get(at) ?? 0)
      if (at === root) return true
    return false
  }
  return found.filter((l) => descends(l.pid))
}

/**
 * The groups of the listeners now on the port that serving saw as this
 * campaign's, by pid or group. The stop cannot ask for descent again: pnpm's
 * group goes first, and `cf` and workerd, in a group of their own, are left
 * with no parent to trace.
 */
export const strays = (now, served) => [
  ...new Set(
    now
      .filter((l) => served.some((s) => s.pid === l.pid || s.group === l.group))
      .map((l) => l.group),
  ),
]

/**
 * Whether what listens on the port is this campaign's preview: every
 * listener descends from `root` or was seen as its own when it was served.
 * One stranger is enough to refuse, since `localhost` may reach either of two
 * listeners on one port, one on IPv4 and one on IPv6.
 */
export function owner(table, now, root, served = []) {
  if (now.length === 0) return { up: false }
  const mine = new Set(root == null ? [] : ours(table, now, root))
  const known = new Set(strays(now, served))
  const strangers = now.filter((l) => !mine.has(l) && !known.has(l.group))
  if (strangers.length === 0) return { up: true, ours: true, listeners: now }
  return {
    up: true,
    ours: false,
    why: `pid ${strangers.map((l) => l.pid).join(', ')} listens on ${URL_}, and it is not the preview this campaign served`,
  }
}

const preview = (ctx) =>
  owner(processes(), listening(), ctx.preview?.pid, ctx.served ?? [])

/** Serves the built bundle on 8787 as `pnpm preview` does, without the build. */
async function serve(state, ctx) {
  if (ctx.stop.signal.aborted) throw new Error('stopped before serving')
  const out = openSync(state.previewLog, 'a')
  const proc = spawn(
    'pnpm',
    [
      '--filter',
      '@inertialref/server',
      'exec',
      'cf',
      'dev',
      '--mode',
      'development',
    ],
    { cwd: ROOT, stdio: ['ignore', out, out], detached: true },
  )
  ctx.preview = proc
  state.preview.pid = proc.pid
  for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
    if (await answers(URL_)) {
      const seen = preview(ctx)
      if (!seen.up)
        throw new Error(
          `${URL_} answers and lsof names no listener, so it cannot be shown to be this campaign's preview`,
        )
      if (!seen.ours) throw new Error(seen.why)
      ctx.served = seen.listeners
      return
    }
    if (proc.exitCode !== null) break
    await sleep(2000, ctx.stop.signal)
    // The sleep ends at once under a stop, and without this the loop would
    // poll the port until its deadline, three minutes after the signal.
    if (ctx.stop.signal.aborted) throw new Error('stopped while serving')
  }
  throw new Error(`the preview did not answer ${URL_}; see ${state.previewLog}`)
}

/**
 * Stops the preview this campaign served, and waits for the port rather than
 * the process: `cf` runs in a process group of its own under pnpm's, and
 * pnpm forwards the signal to it, so the group pnpm leads can be gone while
 * `cf` and workerd still hold 8787, which the next campaign would refuse.
 * What still listens after the wait goes only where serving saw it as this
 * campaign's (`strays`); another tree's server on the port is left alone.
 */
async function stopPreview(ctx) {
  const proc = ctx.preview
  if (proc == null) return
  ctx.preview = null
  // What descends from pnpm now, while there is a pnpm to descend from: a
  // stop that lands before `serve` saw an answer has recorded nothing.
  const table = processes()
  const served = [...(ctx.served ?? []), ...ours(table, listening(), proc.pid)]
  ctx.served = null
  killGroup(proc, 'SIGTERM')
  for (let i = 0; i < 40 && strays(listening(), served).length > 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 500))
  killGroup(proc, 'SIGKILL')
  for (const group of strays(listening(), served))
    if (group > 1) killGroup({ pid: group }, 'SIGKILL')
}

/* --------------------------------------------------------------- the run ---- */

const specOf = (state, stage) =>
  CAMPAIGNS[state.name].stages.find((s) => s.name === stage.name)

/** Whether the capture takes a lever's value for its casts, which the cast stages need. */
export function captureTakesLever(parse = parseCapture) {
  try {
    parse(['--phase', '1', '--dry-run', '--lever', 'clip=1.5'])
    return true
  } catch {
    return false
  }
}

/** The instruments the tree holds, of those a stage names. */
const present = (names, exists = existsSync) =>
  names.filter((name) => exists(instrumentFile(name)))

/**
 * Why a stage is not taken in this campaign, or null: a start option it
 * waits for and was not given, a hold it requires that failed, a tool it
 * needs that the tree does not offer, or no instrument of its list on disk.
 */
export function notTaken(spec, state, tools = {}) {
  const lever = tools.lever ?? captureTakesLever
  const exists = tools.exists ?? existsSync
  if (spec.when !== undefined && state.options?.[spec.when] !== true)
    return `taken only when the campaign is started with --${spec.when}`
  if (spec.hold === 'require' && state.hold?.accepted !== true)
    return `the 60 Hz hold was not accepted: ${state.hold?.figures?.join('; ') ?? 'no acceptance stage ran'}`
  if (spec.needs === 'lever' && !lever())
    return 'scripts/weather/capture.mjs takes no --lever, so no cast can be taken at a band, a clip or a ramp'
  if (
    spec.instruments !== undefined &&
    present(spec.instruments, exists).length === 0
  )
    return `none of ${spec.instruments.join(', ')} is in the tree`
  return null
}

/** A stage's commands and their environment, from the one it stopped at. */
function commandsOf(stage, state) {
  const spec = specOf(state, stage)
  if (spec.kind === 'command')
    return {
      commands: spec.instruments
        ? [vitest(present(spec.instruments))]
        : spec.commands,
      env: spec.env ?? {},
    }
  return {
    commands: [
      [
        process.execPath,
        MEASURE,
        ...['--batch', stage.name, '--resume', stage.file],
        ...['--gpu-wait', GPU_WAIT],
        ...['--hold', state.options?.hold ?? 'none'],
        ...(state.options?.refresh ? ['--refresh', state.options.refresh] : []),
      ],
    ],
    // How Chrome was started, which every row records.
    env: { IR_CAMPAIGN: '1' },
  }
}

/**
 * One attempt at a stage: its commands in order from the one it stopped at,
 * until one fails. A batch is one command, run whole every attempt, since
 * its document is what continues it.
 */
async function attemptStage(stage, state, ctx) {
  const { commands, env } = commandsOf(stage, state)
  if (stage.kind === 'batch') return await child(commands[0], env, ctx)
  for (; stage.next < commands.length; stage.next += 1) {
    const result = await child(commands[stage.next], env, ctx)
    if (result.code !== 0) return result
    save(state)
  }
  return { code: 0, tail: '' }
}

/** One stage, attempt after attempt, until it is done or the campaign stops. */
async function runStage(stage, state, ctx) {
  const why = notTaken(specOf(state, stage), state)
  if (why !== null) {
    Object.assign(stage, { status: 'not taken', reason: why })
    console.log(`${new Date().toISOString()} ${stage.name}: not taken, ${why}`)
    return save(state)
  }
  stage.status = 'running'
  progress(stage)
  stage.startedAt = new Date().toISOString()
  stage.from = stage.done
  while (!ctx.stop.signal.aborted) {
    const seen = preview(ctx)
    if (seen.up && !seen.ours) throw new Error(seen.why)
    if (!seen.up || !(await answers(URL_))) {
      console.log(
        `${new Date().toISOString()} the preview is down; serving it again`,
      )
      await stopPreview(ctx)
      state.preview.restarts += 1
      await serve(state, ctx)
    }
    stage.attempts += 1
    save(state)
    console.log(
      `${new Date().toISOString()} ${stage.name}: attempt ${stage.attempts}`,
    )
    const { code, tail } = await attemptStage(stage, state, ctx)
    stage.exit = code
    progress(stage)
    const next = ctx.stop.signal.aborted ? 'stop' : outcome(stage, code)
    console.log(
      `${new Date().toISOString()} ${stage.name}: exit ${code}, ${next}`,
    )
    if (next === 'done') {
      stage.status = 'done'
      stage.finishedAt = new Date().toISOString()
      // What the stages after it that read a rate are bound by.
      if (stage.name === 'hold')
        state.hold = holdAccepted({ hold: documentAt(stage.file) })
      return save(state)
    }
    if (next === 'stop') {
      stage.status = ctx.stop.signal.aborted ? 'stopped' : 'failed'
      stage.reason =
        code === 0
          ? `${stage.done} of ${stage.total} runs measured quiet`
          : tail.split('\n').slice(-3).join('\n')
      return save(state)
    }
    save(state)
    await sleep(PAUSE_MS, ctx.stop.signal)
  }
  stage.status = 'stopped'
  save(state)
}

/** Every batch's tables and the instruments' paths, in the file the
 *  orchestrator reads, written whatever the campaign's end. */
export function summarize(state) {
  const parts = [
    `# Campaign ${state.name} at ${state.head.slice(0, 12)}`,
    `${state.status} at ${state.finishedAt}${state.reason ? `: ${state.reason}` : ''}. Started ${state.startedAt}.`,
  ]
  for (const stage of state.stages) {
    parts.push(
      `## ${stage.name}: ${stage.status}, ${stage.attempts} attempts${stage.status === 'not taken' ? `: ${stage.reason}` : ''}`,
    )
    // The same guarded read as `progress`: this runs in `run`'s `finally`,
    // and a throw here would lose the summary of a campaign that measured.
    const doc = stage.kind === 'batch' ? documentAt(stage.file) : null
    if (stage.kind === 'batch' && doc === null && existsSync(stage.file))
      parts.push(
        `\`${path.relative(ROOT, stage.file)}\` did not parse when this summary was written, so its tables are not here.`,
      )
    if (doc !== null) {
      parts.push(
        `\`${path.relative(ROOT, stage.file)}\`: ${stage.done} of ${stage.total} runs measured quiet, ${doc.failures?.length ?? 0} failures.`,
        tables(doc),
        rateNote(doc.rows),
      )
    }
    const spec = CAMPAIGNS[state.name]?.stages.find(
      (s) => s.name === stage.name,
    )
    if (spec?.instruments) parts.push(instrumentsText(spec.instruments))
    for (const file of spec?.outputs ?? []) {
      const at = path.join(ROOT, file)
      const fresh =
        stage.startedAt !== undefined &&
        existsSync(at) &&
        statSync(at).mtimeMs >= Date.parse(stage.startedAt)
      parts.push(
        `- \`${file}\`${fresh ? '' : ': not written by this campaign'}`,
      )
    }
  }
  const docs = Object.fromEntries(
    state.stages
      .filter((stage) => stage.kind === 'batch')
      .map((stage) => [stage.name, documentAt(stage.file)])
      .filter(([, doc]) => doc !== null),
  )
  parts.push(
    '## The rules, as the runner computes them',
    rulesTable(evaluate(docs, readInputs())),
  )
  writeFileSync(state.summary, `${parts.join('\n\n')}\n`)
}

/**
 * What the rules read that no batch carries, as the orchestrator records it
 * once the casts are classified and the instruments have run:
 * `{ handoverB, chainEqual, leanEqual, casts: { band, clip, ramp } }`, each
 * cast's verdict `'clean'` or `'step'` (`'trail'` for a clip). Absent, the
 * rules that need it say so.
 */
export const INPUTS = path.join(HOME, 'inputs.json')
const readInputs = () => documentAt(INPUTS) ?? {}

/**
 * A campaign's state as a run takes it up: every stage not done is pending
 * again, and keeps its attempts. They bound a stage's whole life; reset on
 * every resume, they bounded nothing, and a stage that failed eight times
 * was given eight more by each resume.
 */
export function resumed(state) {
  for (const stage of state.stages)
    if (stage.status !== 'done') stage.status = 'pending'
  return state
}

/**
 * The run's signal handler: the first signal stops the campaign and passes
 * one SIGTERM to the stage's process group; every later one is let go. The
 * runner closes its rigs and releases the GPU lock on its first signal, and
 * a second one landing mid-close killed it there and orphaned Chrome with
 * the lock held, so a second `stop` waits for the first.
 */
export function stopper(ctx, kill = killGroup) {
  return (signal) => {
    if (ctx.stop.signal.aborted) {
      console.log(
        `${new Date().toISOString()} ${signal}: already stopping; waiting for the stage to close its rigs`,
      )
      return
    }
    console.log(`${new Date().toISOString()} ${signal}: stopping`)
    ctx.stop.abort()
    if (ctx.current) kill(ctx.current, 'SIGTERM')
  }
}

async function run(name, { stamp, resume, ...options }) {
  const ctx = {
    current: null,
    preview: null,
    served: null,
    stop: new AbortController(),
  }
  const head = git('rev-parse', 'HEAD')
  const was = resume ? readState(name) : null
  // Every refusal before the state is touched: past this line the `finally`
  // saves it and rewrites its summary, which for a resume refused is the
  // record of the campaign it was asked to continue.
  const why =
    (resume ? resumeRefusal(name, was, head) : null) ?? (await refusal())
  if (why !== null) {
    console.log(`${new Date().toISOString()} refused: ${why}`)
    return 2
  }
  const state = was ?? initial(name, stamp, head, options)
  Object.assign(state, { pid: process.pid, status: 'running', reason: null })
  resumed(state)
  const stopping = stopper(ctx)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.on(signal, stopping)
  try {
    save(state)
    if (CAMPAIGNS[name].build === 'always' || !bundled()) {
      console.log(`${new Date().toISOString()} building`)
      const { code } = await child(['pnpm', 'build'], {}, ctx)
      if (code !== 0) throw new Error(`pnpm build exited ${code}`)
    }
    await serve(state, ctx)
    for (const stage of state.stages) {
      if (stage.status === 'done') continue
      await runStage(stage, state, ctx)
      if (stage.status !== 'done' && stage.status !== 'not taken')
        throw new Error(`${stage.name} ${stage.status}: ${stage.reason ?? ''}`)
    }
    state.status = 'done'
  } catch (error) {
    state.status = ctx.stop.signal.aborted ? 'stopped' : 'failed'
    state.reason = error.message
  } finally {
    await stopPreview(ctx)
    state.finishedAt = new Date().toISOString()
    save(state)
    summarize(state)
    console.log(
      `${state.finishedAt} ${state.status}${state.reason ? `: ${state.reason}` : ''}`,
    )
  }
  return state.status === 'done' ? 0 : 1
}

/* ------------------------------------------------------------- the command ---- */

/** The start options a campaign's run is handed, as its own arguments. */
const optionArgs = (options) => [
  ...(options.hold ? ['--hold', options.hold] : []),
  ...(options.transport ? ['--transport'] : []),
  ...(options.refresh ? ['--refresh', options.refresh] : []),
]

/**
 * The campaign as it would run, launching nothing: each batch's rows with
 * their stance, lens, levers and seconds (`measure.mjs --dry-run`), each
 * command stage's commands, the stages it would not take and why, and the
 * totals a stage and the campaign. A stage not taken here is not taken on
 * the machine either, except the hold's, which a run decides.
 */
export function planText(name, options = {}) {
  const state = { name, options, hold: null }
  let total = 0
  const parts = [`# Campaign ${name}`]
  for (const spec of CAMPAIGNS[name].stages) {
    const why = notTaken(spec, state)
    if (why !== null) {
      parts.push(`## ${spec.name}: not taken, ${why}`)
      continue
    }
    const seconds = Math.round(minutesOf(spec, options) * 60)
    total += seconds
    if (spec.kind === 'batch') {
      const runs = runsOf(spec, options)
      parts.push(
        `## ${spec.name}: ${runs.length} rows, about ${minutes(seconds)}${spec.hold ? `; at no hold, ${spec.hold}` : ''}`,
        dryRun({ url: URL_, runs }),
      )
    } else {
      const { commands } = commandsOf(
        { name: spec.name, kind: spec.kind },
        state,
      )
      parts.push(
        `## ${spec.name}: ${commands.length} commands, about ${minutes(seconds)} (as written)${spec.instruments ? `; ${instrumentsText(spec.instruments)}` : ''}`,
        ...commands.map((c) => `  ${c.join(' ')}`),
      )
    }
  }
  parts.push(`campaign ${name}: about ${minutes(total)} before any resume`)
  return parts.join('\n\n')
}

async function start(name, resume, options = {}) {
  const why = await refusal()
  if (why !== null) throw new Error(why)
  const was = readState(name)
  if (resume) {
    const refused = resumeRefusal(name, was, git('rev-parse', 'HEAD'))
    if (refused !== null) throw new Error(refused)
  }
  const stamp = resume
    ? path.basename(was.log, '.log').slice(name.length + 1)
    : new Date()
        .toISOString()
        .replaceAll(':', '-')
        .replace(/\.\d+Z$/, 'Z')
  mkdirSync(HOME, { recursive: true })
  const log = path.join(HOME, `${name}-${stamp}.log`)
  const out = openSync(log, 'a')
  const proc = spawn(
    'caffeinate',
    [
      '-dims',
      process.execPath,
      SELF,
      'run',
      name,
      '--stamp',
      stamp,
      ...(resume ? ['--resume'] : []),
      ...optionArgs(options),
    ],
    { cwd: ROOT, stdio: ['ignore', out, out], detached: true },
  )
  proc.unref()
  console.log(`campaign ${name} started under caffeinate (pid ${proc.pid})
state   ${statePath(name)}
log     ${log}
status  node scripts/clouds/campaign.mjs status ${name}`)
}

function status(name) {
  const latest = (name ? [name] : Object.keys(CAMPAIGNS))
    .map(readState)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  if (latest === undefined) return console.log('no campaign has run')
  const s = latest
  for (const stage of s.stages) progress(stage)
  const live = s.status === 'running' && alive(s.pid)
  const ends = live ? `, ends about ${clock(eta(s.stages, Date.now()))}` : ''
  const lines = [
    `${s.name} at ${s.head.slice(0, 12)}: ${s.status}${s.status === 'running' && !live ? ' (but its process is gone)' : ''}, pid ${s.pid}, started ${clock(Date.parse(s.startedAt))}${ends}`,
    ...(s.reason ? [`  ${s.reason}`] : []),
    ...s.stages.map(
      (st) =>
        `  ${st.name.padEnd(12)} ${st.status.padEnd(8)} ${st.total ? `${st.done}/${st.total}`.padEnd(7) : ''.padEnd(7)} attempts ${st.attempts}/${st.allowed}${st.failures ? `, ${st.failures} row failures` : ''}${st.file ? `  ${path.relative(ROOT, st.file)}` : ''}`,
    ),
    `log      ${s.log}`,
    `summary  ${s.summary}`,
    '',
    ...(existsSync(s.log)
      ? readFileSync(s.log, 'utf8').trimEnd().split('\n').slice(-8)
      : []),
  ]
  console.log(lines.join('\n'))
}

function stop(name) {
  const s = (name ? [name] : Object.keys(CAMPAIGNS))
    .map(readState)
    .find((x) => x?.status === 'running' && alive(x.pid))
  if (s === undefined) return console.log('no campaign is running')
  process.kill(s.pid, 'SIGTERM')
  console.log(`stopping ${s.name} (pid ${s.pid}); status shows when it has`)
}

const USAGE = `node scripts/clouds/campaign.mjs <start|status|stop> [${Object.keys(CAMPAIGNS).join('|')}] [options]

  start <name>           build if needed, serve 8787 and run the stages, detached
  start <name> --resume  continue the last campaign of that name at the same commit
  start <name> --dry-run every stage's rows, lens, levers and seconds; launches nothing
    --hold <how>         pace the rows that read a rate: none (default), display, page
    --transport          take the transport batch: O was built
    --refresh <label>    the display's refresh mode, set by hand, for the study's record
  status [name]          the latest campaign, or the one named
  stop [name]            end the running campaign; what it measured is kept`

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stamp: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      hold: { type: 'string', default: 'none' },
      transport: { type: 'boolean', default: false },
      refresh: { type: 'string' },
    },
  })
  if (!HOLDS.includes(values.hold)) {
    console.error(`--hold is one of ${HOLDS.join(', ')}\n\n${USAGE}`)
    return 2
  }
  const options = {
    hold: values.hold,
    transport: values.transport,
    refresh: values.refresh ?? null,
  }
  const [command, name] = positionals
  if (name !== undefined && !Object.hasOwn(CAMPAIGNS, name)) {
    console.error(`no campaign ${name}\n\n${USAGE}`)
    return 2
  }
  if (command === 'status') return status(name) ?? 0
  if (command === 'stop') return stop(name) ?? 0
  if (name === undefined) {
    console.error(USAGE)
    return 2
  }
  if (command === 'run')
    return await run(name, {
      stamp: values.stamp,
      resume: values.resume,
      ...options,
    })
  if (command !== 'start') {
    console.error(USAGE)
    return 2
  }
  if (values['dry-run']) return console.log(planText(name, options)) ?? 0
  return await start(name, values.resume, options).then(
    () => 0,
    (error) => (console.error(`refused: ${error.message}`), 2),
  )
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
