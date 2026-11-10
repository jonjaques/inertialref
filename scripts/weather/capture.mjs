/*
 * Take every cornerstone, in its arms, the scripted casts and the settled
 * stills along their paths: the media a weather pull request carries, and
 * the record a panel, the step detector and the sheets read (phase 1 design
 * §3.6 and §3.8).
 *
 *   pnpm build && pnpm preview &          # 8787; refused if nothing answers
 *   node scripts/weather/capture.mjs --phase 1 --url http://localhost:8787/ --gpu-wait 1800
 *     --only e1,g6        a subset, by the id's picture tag
 *     --twice             each still from two boots, and the pair's difference
 *     --pairs <n>         each still from 2n boots, two at a time: the noise floor
 *     --cut e1            one still a third way, by a cut inside a boot
 *     --samples <cast>:<a>..<b>   settled stills at a path's frames a to b
 *     --role <role>       the volume arm's role: candidate, low-anchor, last-accepted
 *     --base <dir|record> the last phase's plates, for the sheets
 *     --no-casts --no-samples --baseline-casts
 *     --dry-run           print every take, its preset, role, arm and frames
 *
 * The rig is the rubric's: one session of `scripts/drive.mjs` at 1440 × 900
 * and DPR 2, sRGB, SDR, no interface and no names, against a production
 * preview it is told not to start. Every capture is one invocation, so every
 * still is a fresh boot of the page, and one hold on the machine's GPU lock
 * covers the run: each drive.mjs child joins it by the token in its
 * environment, as `scripts/presets/capture.mjs`'s do, and the rig comes down
 * in a `finally`, because a Chrome left up holds the lock against every other
 * job on the machine.
 *
 * **A still** waits on `ir.settled()`, which waits on the clouds' history and
 * caches as well, then reads back what the page drew and shoots. A take whose
 * settle did not finish, whose renderer is not in standard SDR, whose weather
 * is not its arm's, or whose volume serves no body is refused, never kept: a
 * plate of a history halfway converged, or of the deck where the volume was
 * meant, is the quiet drift this exists to prevent.
 *
 * **Every take carries its provenance and a role** (§3.8): the commit and a
 * clean tree, the stance as the page resolved it, the fixtures' hashes, the
 * processing mode, the hash of the cloud levers at the capture's size, and a
 * role naming the differences the comparison it serves exists to make; a
 * cast adds its rate. `sheet.mjs` holds the list, and a reader refuses a
 * take without one.
 *
 * **A cast** is a path of `descent.mjs`'s, recorded over a screencast with
 * the clouds on and, unless it names another cast's control, with them off.
 * The page's log carries a timestamp a frame, and the cast's rate is the
 * median interval over its whole path. Until the rig can hold 60 Hz on
 * demand a cast at another rate is kept and its rate recorded (rubric §4);
 * `CAST_RATE.held` is the switch that refuses it outside 58 to 62 Hz once it
 * can. A dropped frame is listed, not refused: the descent drops frames in
 * the same bands with the clouds off, so a refusal for any drop kept no
 * descent at all. `CAST_DROPS` says when drops refuse a cast, and which of
 * them the clouds alone caused.
 *
 * Output goes to the main checkout's `.data/weather/phase-<n>/`, found from
 * the clone's common git directory as the GPU lock is, so every worktree of
 * every phase writes one place and a removed worktree takes no plate with
 * it: `<id>-<arm>.png`, `<id>-<speed>-<on|off>/` with the cast's frames, its
 * clip and its log, `samples/`, `pairs/` and `floor.json` for the noise
 * floor, and `record.json`, which names the commit and every file's SHA-256.
 */
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CORNERSTONES } from '../../packages/devtools/src/index.ts'
import { rigLeft, takeGpu } from '../driveLock.mjs'
import {
  armsOfCast,
  castByKey,
  castName,
  castPath,
  CASTS,
  cutCast,
  HELD,
  INSTALL_PATH,
  SAMPLES,
  seekPath,
  setLevers,
  spansReduction,
  startPath,
  stopPath,
} from './descent.mjs'
import { checkRecord, PLATE, provenance, role, sunInFrame } from './sheet.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DRIVE = path.join(ROOT, 'scripts/drive.mjs')

/** The rubric's rig (§3.2 there). */
export const RIG = Object.freeze({
  ...PLATE,
  colorProfile: 'srgb',
  queries: ['chrome=0', 'layers=0', 'output=standard'],
})
/**
 * How long a picture may take to settle, and the quiet after it does.
 *
 * Earth's ground from low orbit settles last: its deposit slope table is
 * measured on one worker once the tiles are in, and lands 50–53 s after the
 * boot on an M6 Mac mini with the clouds on or off, with every tile long
 * since drawn. Half a minute refused E1 for that alone.
 */
export const SETTLE_BUDGET = 120_000
export const SETTLE_QUIET = 1_000
/**
 * The presentation rate a cast is held to, Hz. `held` is whether the rig can
 * hold 60 Hz on demand: the clouds-on descent presents at 42.6 Hz at 2880 ×
 * 1800 on the M6, and until a hold exists a cast outside the band is kept
 * with its rate (rubric §4). The commit that lands the hold sets it, and the
 * band refuses again.
 */
export const CAST_RATE = Object.freeze({
  low: 58,
  high: 62,
  frames: 30,
  held: false,
})
/**
 * Where a gap in a cast's log is a frame the page did not present: half the
 * shortest normal interval over the longest, the normal ones being the
 * cast's own 10th and 90th percentiles.
 *
 * Two medians, the obvious line, is exactly what one missed frame measures,
 * and the instants are callback times, so one missed frame read as kept
 * about half the time; a single float64 step at 10¹² ms is enough. The line
 * sits midway instead: 1.5 periods at a steady rate, and 45.8 ms in the 25
 * and 33.3 ms cadence a 120 Hz panel gives a 40 Hz page, between its 33.3
 * and the 50 of one missed 25 ms slot. Percentiles, not the extremes, so
 * the 3% of drops a kept cast may hold never move the line.
 */
export const CAST_GAP = Object.freeze({ normal: 0.9, short: 0.1 })
/**
 * When dropped frames refuse a cast, and which the clouds alone caused.
 *
 * Provisional, from the baseline at `4a8244e0` on the M6 (README, the
 * cornerstones' record): every G6 arm dropped 5 to 15 frames of its 300 or
 * 1,012, at the same heights with the clouds off, about 50 to 20 km up, so
 * a cast is refused past 3% of its path's frames, which is twice the worst
 * arm's 1.5%, or for three missed in a row, which is a third of a 60 Hz
 * cast's twentieth of a second and long enough to read as a cut. A drop in
 * the clouds-on arm with none in its control within `near` path frames is
 * the clouds' own (`cloudsOnly`), and package I's classifier reports each as
 * a finding. Window 2's casts move these with a figure.
 */
export const CAST_DROPS = Object.freeze({ share: 0.03, run: 3, near: 10 })
/** Boots a cast may take before its drops refuse it. */
export const CAST_ATTEMPTS = 3
/** Frames a cast records past its path's end, so the end is in the clip. */
export const CAST_TAIL = 90
/** Below this share of its path's frames a screencast is subsampling it. */
export const CAST_COVERAGE = 2 / 3
/** The presets' per-pixel level against a PNG (`scripts/presets/compare.mjs`). */
export const SAME_LEVEL = '3%'
/** Over this RMSE between two boots of one still, the rig is broken (rubric §3.2). */
export const FLOOR_RMSE = 0.005
/** Settled stills a boot takes before the next, so one hitch costs a batch. */
export const SAMPLE_BATCH = 50

/** What a cornerstone's picture must report in each arm. */
export const ARM_WEATHER = Object.freeze({
  volume: 'drawn',
  deck: 'unavailable',
})

/** The tag a cornerstone is named by: `e1` for `weather-e1-cumulus-orbit`. */
export const tagOf = (id) => id.split('-')[1]

/** The stills: every cornerstone that is not only a cast's start pose. */
export const STILLS = Object.freeze(
  CORNERSTONES.map((one) => one.id).filter(
    (id) => !['g5', 'g6'].includes(tagOf(id)),
  ),
)

/** The arms a still is taken in: the deck beside the volume on Earth. */
export const armsOf = (id) =>
  tagOf(id).startsWith('e') || tagOf(id) === 'guard'
    ? ['volume', 'deck']
    : ['volume']

/** A still's role in its arm: the deck is the deck, the guard a guard pair. */
export const roleOf = (id, arm, volume = 'candidate') =>
  arm === 'deck' ? 'deck' : tagOf(id) === 'guard' ? 'guard-pair' : volume

/**
 * The main checkout's `.data/weather/`, from the clone's common git
 * directory: the same in every worktree of the clone.
 */
export function dataRoot(cwd = ROOT) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  return path.join(path.dirname(path.resolve(cwd, common)), '.data/weather')
}

/** `<cast>:<a>..<b>` as a sample over a cast's frames a to b. */
function parseSample(text) {
  const match = /^(.+):(\d+)\.\.(\d+)$/.exec(text)
  const cast = match === null ? undefined : castByKey(match[1])
  if (cast === undefined || match === null)
    throw new Error(
      `--samples ${text}: want <id>-<speed>:<a>..<b>, as weather-g6-descent-slow:400..420`,
    )
  const [a, b] = [Number(match[2]), Number(match[3])]
  if (b < a || b > cast.frames)
    throw new Error(`--samples ${text}: frames outside 0..${cast.frames}`)
  return {
    cast: match[1],
    frames: Array.from({ length: b - a + 1 }, (_, i) => a + i),
    checks: ['§4'],
    why: 'settled stills around a flagged step, for its classification',
  }
}

export function parseCapture(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      phase: { type: 'string' },
      url: { type: 'string' },
      'gpu-wait': { type: 'string', default: '0' },
      port: { type: 'string', default: '9350' },
      only: { type: 'string' },
      twice: { type: 'boolean', default: false },
      pairs: { type: 'string' },
      cut: { type: 'string', multiple: true },
      samples: { type: 'string', multiple: true },
      role: { type: 'string', default: 'candidate' },
      base: { type: 'string' },
      casts: { type: 'boolean', default: true },
      'baseline-casts': { type: 'boolean', default: false },
      'default-samples': { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowNegative: true,
  })
  if (values.help) return { help: true }
  const dryRun = values['dry-run']
  if (values.phase === undefined || !/^\d+$/.test(values.phase))
    throw new Error('--phase <n> names the phase the plates are of')
  if (values.url === undefined && !dryRun)
    throw new Error(
      '--url names the production preview to photograph, e.g. http://localhost:8787/',
    )
  const wait = Number(values['gpu-wait'])
  if (!Number.isFinite(wait) || wait < 0)
    throw new Error('--gpu-wait takes seconds, zero or more')
  const pairs = values.pairs === undefined ? 0 : Number(values.pairs)
  if (!Number.isSafeInteger(pairs) || pairs < 0)
    throw new Error('--pairs takes a whole number of pairs')
  if (!['candidate', 'low-anchor', 'last-accepted'].includes(values.role))
    throw new Error(
      '--role is the volume arm’s: candidate, low-anchor or last-accepted',
    )
  const tags = values.only === undefined ? null : values.only.split(',')
  const known = CORNERSTONES.map((one) => tagOf(one.id))
  for (const tag of [...(tags ?? []), ...(values.cut ?? [])])
    if (!known.includes(tag))
      throw new Error(`no cornerstone tagged ${tag}; tags: ${known.join(', ')}`)
  for (const tag of values.cut ?? [])
    if (!STILLS.some((id) => tagOf(id) === tag))
      throw new Error(`--cut ${tag} names a cast, not a still`)
  const wanted = (id) => tags === null || tags.includes(tagOf(id))
  // `--cut <tag>` is C9's cut to that still, as a cast that keeps its
  // frames; E1's is in the set already, and asking for it again adds none.
  const cuts = (values.cut ?? [])
    .map((tag) => STILLS.find((id) => tagOf(id) === tag))
    .map((id) => cutCast(id, cutFrom(id)))
  const casts = values.casts
    ? [...CASTS, ...HELD].filter(
        (cast) =>
          wanted(cast.id) &&
          (cast.checks.length > 0 || values['baseline-casts']),
      )
    : []
  for (const cut of cuts)
    if (!casts.some((one) => castName(one, true) === castName(cut, true)))
      casts.push(cut)
  const samples = [
    ...(values['default-samples'] ? SAMPLES : []),
    ...(values.samples ?? []).map(parseSample),
  ].filter((one) => wanted(castByKey(one.cast).id))
  return {
    help: false,
    dryRun,
    phase: Number(values.phase),
    url: values.url === undefined ? null : new URL(values.url).toString(),
    gpuWaitMs: wait * 1000,
    port: values.port,
    stills: STILLS.filter(wanted),
    twice: values.twice,
    pairs,
    role: values.role,
    casts,
    samples,
    base: values.base ?? null,
    out: values.out ?? null,
  }
}

/** The flags every invocation shares: the rig, the server, one result as JSON. */
export const rigArgs = (options) => [
  '--port',
  options.port,
  '--no-serve',
  '--url',
  options.url,
  '--tree',
  ROOT,
  '--width',
  String(RIG.width),
  '--height',
  String(RIG.height),
  '--dpr',
  String(RIG.dpr),
  '--color-profile',
  RIG.colorProfile,
  '--max-px',
  '0',
  '--quiet',
  '--json',
]

const plateQueries = (clouds) =>
  [...RIG.queries, ...(clouds ? ['clouds=1'] : [])].flatMap((q) => [
    '--query',
    q,
  ])

const settle = ['--settle', String(SETTLE_BUDGET)]

/**
 * What a take reads back of the page: the renderer, the stance as the
 * observatory resolved it, the lens, the instant, the processing mode, the
 * settle, the clouds' report with its levers and extents, and what became
 * of the picture's weather after the clouds' chunk arrived.
 */
export const STATE = `({ mode: engine.gl.description.mode, chrome: engine.chrome, lens: engine.lens, time: ir.observatory.time, stance: (() => { const s = ir.observatory.status(); return { address: s.target?.address ?? null, state: s.state, look: s.look, surface: s.surface?.stance ?? null } })(), processing: engine.sensorSettings.mode, sun: (() => { const s = ir.observatory.status(); if (s.surface === null || s.target === null) return null; const at = s.surface.stance; return ir.sun(s.target.address, { latitude: (at.latitude * 180) / Math.PI, longitude: (at.longitude * 180) / Math.PI }) })(), light: ir.light(), settled: ir.settled(), clouds: ir.clouds(), weather: engine.pictureWeather.outcome, build: ir.build() })`

/** A still's read: the state, and the share of the trace's texels holding cloud. */
export const READ = `(async () => {
  const capture = await ir.cloudRadiance()
  let cloud = null
  if (capture !== null) {
    let held = 0
    let lit = 0
    let clear = 0
    for (let i = 0; i < capture.cloud.length; i += 1)
      if (capture.cloud[i]) {
        held += 1
        lit += capture.luminance[i]
      } else clear += capture.luminance[i]
    const texels = capture.cloud.length
    cloud = {
      texels,
      share: held / texels,
      meanCloud: held > 0 ? lit / held : null,
      meanClear: texels > held ? clear / (texels - held) : null,
    }
  }
  return { ...${STATE}, cloud }
})()`

/** One still: a fresh boot at the picture, settled, read and shot. */
export const stillArgs = (id, arm, file) => [
  '--preset',
  id,
  ...plateQueries(arm === 'volume'),
  ...settle,
  '--wait',
  String(SETTLE_QUIET),
  '--js',
  READ,
  '--shot',
  file,
]

/** The picture a cut comes from: a cornerstone on the other body. */
export const cutFrom = (id) =>
  STILLS.find((other) => tagOf(other)[0] !== tagOf(id)[0])

const pictureOf = (id) => CORNERSTONES.find((one) => one.id === id)

/** What a cast evaluates before its path: a scrub boots three hours early. */
const castBefore = (cast) =>
  cast.scrub === undefined
    ? []
    : [
        '--js',
        `ir.observatory.setTime(${pictureOf(cast.id).time - cast.scrub})`,
        ...settle,
      ]

/**
 * One cast: the picture, settled, its control's lever or its own, the
 * path, the screencast, the log, and for a cut or a scrub the settled
 * plate after. The `--js` steps run in order and each answers in the
 * result's `js` entries in that order; `castReads` finds them by place.
 */
export const castArgs = (cast, clouds, file = null) => [
  '--preset',
  cast.boot ?? cast.id,
  ...plateQueries(true),
  ...settle,
  ...(clouds
    ? []
    : ['--js', 'engine.clouds = { ...engine.clouds, on: false }', ...settle]),
  ...(cast.levers === undefined
    ? []
    : ['--js', setLevers(cast.levers), ...settle]),
  ...castBefore(cast),
  // The path's first frame, settled and quiet, before the screencast: a
  // cast started on a picture still converging reads its first frames as
  // steps, as the baseline's G5 off arm did over its frames 0 to 4.
  '--js',
  INSTALL_PATH,
  '--js',
  seekPath(castPath(cast), 0),
  ...settle,
  '--wait',
  String(SETTLE_QUIET),
  '--js',
  STATE,
  '--js',
  startPath(castPath(cast)),
  '--cast',
  String(cast.frames + CAST_TAIL),
  '--js',
  stopPath(),
  ...(cast.settled
    ? [...settle, '--wait', String(SETTLE_QUIET), '--js', READ, '--shot', file]
    : []),
]

/** A cast's `--js` answers by what each asked: the levers, the state, the stop, the read. */
export function castReads(cast, clouds, result) {
  const js = result.results.filter((one) => one.step === 'js')
  const at = (n) => js.at(n)?.value
  const settled = cast.settled ? 1 : 0
  return {
    levers:
      cast.levers === undefined ? 'set' : (at(clouds ? 0 : 1) ?? 'unavailable'),
    state: at(-3 - settled),
    stop: at(-1 - settled),
    read: settled === 1 ? at(-1) : null,
  }
}

/**
 * Settled stills along a path, `SAMPLE_BATCH` to a boot: the picture,
 * settled, then for each frame the path's seek, a settle, the read and the
 * shot. The eye never moves by more than the path's own step between two
 * of them, so a settle after a seek is a history's 32 frames, not a boot.
 */
export const sampleArgs = (cast, frames, files) => [
  '--preset',
  cast.id,
  ...plateQueries(true),
  ...settle,
  '--js',
  INSTALL_PATH,
  ...frames.flatMap((k, i) => [
    '--js',
    seekPath(castPath(cast), k),
    ...settle,
    '--wait',
    String(SETTLE_QUIET),
    '--js',
    READ,
    '--shot',
    files[i],
  ]),
]

/** Refuse a still the page did not take as its arm asks. */
export function checkStill(id, arm, read) {
  const refuse = (why) => {
    throw new Error(`${id} (${arm}): ${why}; refused`)
  }
  if (read === undefined || read === null) refuse('the page read nothing back')
  if (read.mode !== 'standard')
    refuse(`taken in ${String(read.mode)}, not standard SDR`)
  if (read.chrome !== false) refuse('taken with the interface up')
  if (read.settled?.ok !== true)
    refuse(`not settled: ${JSON.stringify(read.settled)}`)
  if (read.weather !== ARM_WEATHER[arm])
    refuse(
      `its weather is ${String(read.weather)}, where the ${arm} arm wants ${ARM_WEATHER[arm]}`,
    )
  if (arm === 'volume') {
    checkServed(id, read, refuse)
    if (read.cloud == null) refuse('its trace read back nothing')
  }
  return read
}

/**
 * Refuse a take whose page was built from another commit than the record
 * names, or from an edited tree.
 *
 * The capture photographs a preview it does not start, and `drive.mjs`
 * cannot hold a production build to a tree: it names none. The page's
 * build id is `git describe --always --dirty --abbrev=8` at build time
 * (`apps/game/vite.config.ts`), which holds the commit's first eight
 * characters, or `<branch>@<eight>` on CI. Without this a record said one
 * commit for plates of another: the baseline's E1 and E2 were recorded at
 * `ab301957` from a build of `23f173bc`. Every take is held to the one
 * commit, so a run cannot mix two builds either.
 */
export function checkBuild(name, read, commit) {
  const id = read?.build?.id
  if (typeof id !== 'string')
    throw new Error(`${name}: the page names no build; refused`)
  if (id.endsWith('-dirty') || !id.includes(commit.slice(0, 8)))
    throw new Error(
      `${name}: the page was built as ${id}, not from ${commit.slice(0, 8)} clean; build the preview from the commit the record names; refused`,
    )
  return id
}

/**
 * The body a cornerstone's clouds are served on, by full address: its own,
 * or for a station's picture the body the station goes round.
 */
export function servedAddress(id) {
  const address = pictureOf(id).address
  const full = address.startsWith('g:') ? address : `g:milky-way/${address}`
  return full.replace(/\/a:[^/]+$/, '')
}

/**
 * Refuse a take whose frame did not draw its picture's volume. `weather` is
 * what the levers were told, `drawn` once they were written; whether the
 * frame then served that body is the clouds' own report. A forced address
 * no body has serves nothing, the report says `on: false`, the settle has
 * nothing to wait for, and the plate is the textured deck, kept as the
 * volume arm.
 */
export function checkServed(id, read, refuse) {
  if (read.clouds?.on !== true) refuse('its clouds report nothing drawn')
  if (read.clouds.served !== servedAddress(id))
    refuse(
      `its clouds serve ${String(read.clouds.served)}, not ${servedAddress(id)}`,
    )
}

/** Where a shot lands before it is checked: beside its name, never on it. */
export const takeOf = (file) => file.replace(/\.png$/, '.take.png')

/**
 * Keep a shot under its name once `check` passes, and remove it when the
 * check refuses it. A shot taken straight to its name overwrote the last
 * good plate before anything had read the page, and a refused take then
 * stood on disk where the next phase's sheet reads its base.
 */
export async function keepShot(take, file, check) {
  let value
  try {
    value = await check()
  } catch (error) {
    await rm(take, { force: true })
    throw error
  }
  await rename(take, file)
  return value
}

/**
 * The fresh plate this run took of a picture, its volume arm, by its file
 * in the record; null where this run took none. A cut is compared with
 * this and only this, never with a plate an earlier run left on disk.
 */
export function freshPlate(record, id) {
  const kept = record.stills.find(
    (one) =>
      one.id === id &&
      one.arm === 'volume' &&
      one.role?.name !== 'reference-run',
  )
  return kept?.file ?? null
}

/** The intervals between a log's first `entries`, milliseconds. */
function intervalsOf(log, entries) {
  const at = log.slice(0, entries).map((entry) => entry.at)
  const intervals = []
  for (let i = 1; i < at.length; i += 1) intervals.push(at[i] - at[i - 1])
  return intervals
}

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The presentation rate over a log's first `frames`, from the page's log. */
export function presentationRate(log, frames = CAST_RATE.frames) {
  const median = medianOf(intervalsOf(log, frames + 1))
  return median !== null && median > 0 ? 1000 / median : null
}

/**
 * The frames a cast's page did not present: one entry a gap, at the path
 * frame after it, with how many frames it missed, the height, and for a
 * flight the distance along the path.
 *
 * A gap is one past `gapLine`; it missed its length in medians, rounded,
 * less one, and never fewer than one, so one gap of four medians is three
 * missed in a row.
 */
export function dropsOf(log, frames, median, path = null) {
  const intervals = intervalsOf(log, frames)
  const line = gapLine(intervals)
  return intervals.flatMap((interval, i) => {
    if (interval <= line) return []
    const entry = log[i + 1]
    const frame = entry.k ?? i + 1
    return [
      {
        frame,
        ms: interval,
        missed: Math.max(1, Math.round(interval / median) - 1),
        height: entry.height ?? null,
        distance:
          path?.kind === 'fly'
            ? path.metersAFrame * Math.min(frame, path.stopAt ?? Infinity)
            : null,
        resets: entry.resets ?? null,
      },
    ]
  })
}

/** The value at a share of a list's sorted order, by the nearest rank. */
function quantileOf(values, share) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
}

/** The interval past which a gap is a missed frame (`CAST_GAP`). */
export function gapLine(intervals) {
  return (
    quantileOf(intervals, CAST_GAP.normal) +
    quantileOf(intervals, CAST_GAP.short) / 2
  )
}

/** The longest run of frames missed in a row: adjacent gaps add. */
function longestRun(drops) {
  let longest = 0
  let run = 0
  let last = null
  for (const drop of drops) {
    run =
      last !== null && drop.frame === last + 1 ? run + drop.missed : drop.missed
    longest = Math.max(longest, run)
    last = drop.frame
  }
  return longest
}

/**
 * Why a cast's path did not run to its end, or null. A path that throws in
 * a frame ends its loop there while the screencast records a still page on,
 * and the intervals it did log are clean: the log's length, and a
 * descent's height at its last frame, are what say it stopped.
 */
export function shortPath(log, cast) {
  if (log.length < cast.frames + 1)
    return `the path stopped at frame ${log.length} of ${cast.frames}`
  const last = log[cast.frames]?.height
  if (cast.path?.kind === 'descent' && !(last <= 2 + 1e-6))
    return `the descent stood at ${String(last)} m at its last frame, not 2 m`
  return null
}

/**
 * Read a cast's rate over its whole path, list its drops, and refuse it
 * where `CAST_DROPS` says. The band refuses only where `held` says the rig
 * can hold 60 Hz; until then the rate is what the record says beside it.
 */
export function checkCast(name, log, instants, cast, held = CAST_RATE.held) {
  const pathFrames = Math.min(log.length, cast.frames + CAST_TAIL)
  const median = medianOf(intervalsOf(log, pathFrames))
  if (median === null || !(median > 0))
    throw new Error(`${name}: presented at no measurable rate; refused`)
  const hz = 1000 / median
  const short = shortPath(log, cast)
  if (short !== null)
    throw Object.assign(new Error(`${name}: ${short}; refused`), {
      dropped: [],
      hz,
    })
  const drops = dropsOf(log, pathFrames, median, cast.path)
  const missed = drops.reduce((sum, one) => sum + one.missed, 0)
  const run = longestRun(drops)
  if (missed > CAST_DROPS.share * pathFrames || run >= CAST_DROPS.run)
    throw Object.assign(
      new Error(
        `${name}: ${missed} frame${missed === 1 ? '' : 's'} missed of ${pathFrames} (${((missed / pathFrames) * 100).toFixed(1)}%), ${run} in a row, at frame${drops.length === 1 ? '' : 's'} ${drops.map((one) => one.frame).join(', ')}: past ${CAST_DROPS.share * 100}% or ${CAST_DROPS.run} in a row`,
      ),
      { dropped: drops, hz },
    )
  const atSixty = hz >= CAST_RATE.low && hz <= CAST_RATE.high
  if (held && !atSixty)
    throw new Error(
      `${name}: presented at ${hz.toFixed(1)} Hz, outside ${CAST_RATE.low}–${CAST_RATE.high}; the path is scheduled by frame and must be taken at 60 Hz`,
    )
  const coverage = coverageOf(instants, log, cast.frames)
  return {
    hz,
    atSixty,
    first: presentationRate(log),
    longest: Math.max(...intervalsOf(log, pathFrames)),
    dropped: drops,
    coverage,
    retake: coverage !== null && coverage < CAST_COVERAGE,
  }
}

/**
 * The share of a path's frames the screencast holds: its frames whose
 * instant, epoch seconds as `timestamps.json` keeps them, falls between the
 * path's first frame and its last in the page's log, over the path's
 * frames. Null without the instants.
 *
 * Not the frames captured over the frames asked for: the screencast stops
 * once it holds the count asked for, so that share is one unless its
 * deadline lapses, and a stream encoded at a third of the page's rate
 * read as the whole path while its clip held every third frame of it.
 */
export function coverageOf(instants, log, frames) {
  if (instants === null || log.length < 2) return null
  const last = Math.min(frames, log.length - 1)
  const [from, to] = [log[0].at, log[last].at]
  const inside = instants.filter((s) => s * 1000 >= from && s * 1000 < to)
  return inside.length / last
}

/**
 * Mark each drop of a clouds-on arm the clouds alone caused: no drop in its
 * control within `CAST_DROPS.near` path frames. Null where the control has
 * no drops on record to compare with.
 */
export function markCloudsOnly(drops, control) {
  return drops.map((drop) => ({
    ...drop,
    cloudsOnly:
      control === null
        ? null
        : !control.some(
            (one) => Math.abs(one.frame - drop.frame) <= CAST_DROPS.near,
          ),
  }))
}

export async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

const run = promisify(execFile)

/** Pixels two plates differ at past the presets' level, by ImageMagick. */
export async function changedPixels(a, b, level = SAME_LEVEL) {
  const { stdout } = await run(
    'magick',
    [
      a,
      b,
      '-compose',
      'difference',
      '-composite',
      '-colorspace',
      'Gray',
      '-threshold',
      level,
      '-format',
      '%[fx:int(mean*w*h+0.5)]',
      'info:',
    ],
    { maxBuffer: 1 << 24 },
  )
  return Number(stdout.trim())
}

/**
 * The RMSE of two plates as a share of full scale: ImageMagick's
 * normalized figure, the parenthesized one `compare` prints on stderr. It
 * exits 1 for any two plates that differ, which is the expected case.
 */
export async function rmseOf(a, b) {
  const text = await run('magick', [
    'compare',
    '-metric',
    'RMSE',
    a,
    b,
    'null:',
  ])
    .then(({ stderr }) => stderr)
    .catch((error) => {
      if (error.code === 1) return error.stderr
      throw error
    })
  const match = /\(([\d.e+-]+)\)/.exec(text)
  if (match === null) throw new Error(`no RMSE in ${JSON.stringify(text)}`)
  return Number(match[1])
}

/* ------------------------------------------------------------- the plan --- */

/*
 * Wall time a take is planned at, seconds, for scheduling a window: not
 * measured, and no figure here is one. A boot and a settle is Earth's 50 to
 * 53 s slope table on the M6 and a generated world's tiles; a cast runs at
 * the clouds-on descent's 42.6 Hz; a settled still after a seek waits on the
 * history's 32 frames, the second's quiet and a Retina PNG.
 */
export const PLAN_SECONDS = Object.freeze({
  bootEarth: 75,
  bootWorld: 40,
  hz: 42.6,
  castAfter: 20,
  sample: 4,
})

const bootSeconds = (id) =>
  pictureOf(id).address.includes('SOL')
    ? PLAN_SECONDS.bootEarth
    : PLAN_SECONDS.bootWorld

/** Every take a run makes, in order, with its preset, role, arm and frames. */
export function planOf(options) {
  const plan = []
  const boots = options.pairs > 0 ? 2 * options.pairs : options.twice ? 2 : 1
  for (const id of options.stills)
    for (const arm of armsOf(id))
      plan.push({
        kind: options.pairs > 0 ? 'pairs' : 'still',
        preset: id,
        role:
          options.pairs > 0 || options.twice
            ? 'reference-run'
            : roleOf(id, arm, options.role),
        arm,
        frames: boots,
        seconds: boots * bootSeconds(id),
      })
  for (const cast of options.casts)
    for (const arm of armsOfCast(cast))
      plan.push({
        kind: 'cast',
        preset: `${cast.id} ${cast.speed}${cast.boot ? ` (from ${cast.boot})` : ''}`,
        role: arm === 'off' ? 'clouds-off' : (cast.role ?? 'candidate'),
        arm,
        frames: cast.frames + CAST_TAIL,
        seconds: Math.round(
          bootSeconds(cast.boot ?? cast.id) +
            (cast.frames + CAST_TAIL) / PLAN_SECONDS.hz +
            PLAN_SECONDS.castAfter +
            (cast.settled ? bootSeconds(cast.id) : 0),
        ),
      })
  for (const sample of options.samples) {
    const cast = castByKey(sample.cast)
    plan.push({
      kind: 'samples',
      preset: `${sample.cast} @ ${sample.frames[0]}..${sample.frames.at(-1)}`,
      role: 'settled-sample',
      arm: 'on',
      frames: sample.frames.length,
      seconds:
        Math.ceil(sample.frames.length / SAMPLE_BATCH) * bootSeconds(cast.id) +
        sample.frames.length * PLAN_SECONDS.sample,
    })
  }
  return plan
}

/** The plan as a table, with its totals: what `--dry-run` prints. */
export function planTable(plan) {
  const rows = plan.map(
    (one) =>
      `${one.kind.padEnd(7)} ${one.preset.padEnd(58)} ${one.role.padEnd(15)} ${one.arm.padEnd(6)} ${String(one.frames).padStart(5)} ${String(one.seconds).padStart(6)} s`,
  )
  const frames = plan.reduce((sum, one) => sum + one.frames, 0)
  const seconds = plan.reduce((sum, one) => sum + one.seconds, 0)
  return [
    `${'kind'.padEnd(7)} ${'preset'.padEnd(58)} ${'role'.padEnd(15)} ${'arm'.padEnd(6)} frames   wall`,
    ...rows,
    `${plan.length} takes, ${frames} frames, about ${(seconds / 3600).toFixed(1)} h (planned, not measured)`,
  ].join('\n')
}

/* --------------------------------------------------------------- main --- */

async function main() {
  const options = parseCapture(process.argv.slice(2))
  if (options.help) {
    console.log(
      'node scripts/weather/capture.mjs --phase <n> --url <preview> [--gpu-wait <s>] [--only e1,g6] [--twice | --pairs <n>] [--cut e1] [--samples <cast>:<a>..<b>] [--role <role>] [--base <dir|record>] [--no-casts] [--no-default-samples] [--baseline-casts] [--dry-run]',
    )
    return
  }
  if (options.dryRun) {
    console.log(planTable(planOf(options)))
    return
  }
  const answers = await fetch(options.url).then(
    (response) => response.ok,
    () => false,
  )
  if (!answers)
    throw new Error(
      `nothing answers at ${options.url}: run \`pnpm build && pnpm preview\` first; this tool starts no server`,
    )
  const out = options.out ?? path.join(dataRoot(), `phase-${options.phase}`)
  await mkdir(out, { recursive: true })
  const say = (line) => console.log(line)

  const gpu = await takeGpu('weather:capture', {
    waitMs: options.gpuWaitMs,
    hint: '--gpu-wait <seconds> queues for it.',
  })
  const drive = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [DRIVE, ...rigArgs(options), ...args],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'inherit'],
          env: { ...process.env, ...gpu.env },
        },
      )
      let text = ''
      child.stdout.on('data', (chunk) => {
        text += chunk
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code !== 0)
          return reject(new Error(`drive exited ${code ?? 'on a signal'}`))
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`drive printed no result: ${text.slice(-400)}`))
        }
      })
    })
  const jsValues = (result) =>
    result.results.filter((one) => one.step === 'js').map((one) => one.value)

  const git = (...args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const fixture = async (file) =>
    existsSync(path.join(ROOT, file)) ? sha256(path.join(ROOT, file)) : null
  const record = {
    phase: options.phase,
    commit: git('rev-parse', 'HEAD'),
    clean: git('status', '--porcelain') === '',
    url: options.url,
    rig: RIG,
    fixtures: {
      references: await fixture('design/plans/weather/references.md'),
      cornerstones: await fixture('packages/devtools/src/cornerstones.json'),
    },
    base: options.base,
    build: null,
    chrome: null,
    stills: [],
    twice: [],
    casts: [],
    samples: [],
    refused: [],
    unavailable: [],
  }
  const floor = {
    commit: record.commit,
    rig: RIG,
    pairs: options.pairs,
    pictures: {},
  }

  try {
    // One boot before the first still brings the rig's Chrome up under the
    // lock and the preview's bundle into its cache.
    await drive([
      '--url',
      new URL('/planetarium', options.url).toString(),
      '--wait',
      '4000',
    ])
    record.chrome = await fetch(`http://127.0.0.1:${options.port}/json/version`)
      .then((response) => response.json())
      .then((version) => version.Browser ?? null)
      .catch(() => null)

    const still = async (id, arm, file, as) => {
      const take = takeOf(file)
      const result = await drive(stillArgs(id, arm, take))
      const read = await keepShot(take, file, () => {
        const checked = checkStill(id, arm, jsValues(result).at(-1))
        checkBuild(`${id} (${arm})`, checked, record.commit)
        return checked
      })
      record.build ??= read.build
      return {
        id,
        arm,
        file: path.relative(out, file),
        sha256: await sha256(file),
        read,
        glory: sunInFrame(read),
        ...provenance(record, id, read, as),
      }
    }

    for (const id of options.stills)
      for (const arm of armsOf(id)) {
        if (options.pairs > 0) {
          await mkdir(path.join(out, 'pairs'), { recursive: true })
          const pairs = []
          for (let i = 0; i < options.pairs; i += 1) {
            const [a, b] = ['a', 'b'].map((side) =>
              path.join(out, 'pairs', `${id}-${arm}-${i}${side}.png`),
            )
            say(`${id} (${arm}) pair ${i + 1} of ${options.pairs}`)
            for (const file of [a, b])
              record.stills.push(
                await still(
                  id,
                  arm,
                  file,
                  role('reference-run', [`pair ${i}`]),
                ),
              )
            pairs.push({
              changed: await changedPixels(a, b),
              rmse: await rmseOf(a, b),
            })
            say(`  ${pairs.at(-1).changed} px, RMSE ${pairs.at(-1).rmse}`)
          }
          floor.pictures[`${id}-${arm}`] = {
            pairs,
            changed: Math.max(...pairs.map((one) => one.changed)),
            rmse: Math.max(...pairs.map((one) => one.rmse)),
          }
          // The rig against itself, over the cap: no review counts until
          // it is repaired (rubric §3.2), so nothing more is taken on it.
          if (floor.pictures[`${id}-${arm}`].rmse > FLOOR_RMSE)
            throw new Error(
              `${id} (${arm}): two boots differ by an RMSE of ${floor.pictures[`${id}-${arm}`].rmse}, over ${FLOOR_RMSE}; the rig is repaired before any review counts`,
            )
          continue
        }
        const file = path.join(out, `${id}-${arm}.png`)
        say(`${id} (${arm})`)
        record.stills.push(
          await still(id, arm, file, role(roleOf(id, arm, options.role))),
        )
        if (options.twice) {
          const again = path.join(out, `${id}-${arm}.again.png`)
          const second = await still(id, arm, again, role('reference-run'))
          const changed = await changedPixels(file, again)
          say(`  two boots differ at ${changed} pixels`)
          record.twice.push({ ...second, changed })
        }
      }

    await takeCasts({ options, out, record, drive, say })
    await takeSamples({ options, out, record, drive, say, jsValues })
  } finally {
    if (options.pairs > 0)
      await writeFile(
        path.join(out, 'floor.json'),
        `${JSON.stringify(floor, null, 1)}\n`,
      )
    await writeFile(
      path.join(out, 'record.json'),
      `${JSON.stringify(record, null, 1)}\n`,
    )
    gpu.release()
    // The rig comes down whatever happened: its Chrome holds the GPU lock.
    await promisify(execFile)(
      process.execPath,
      [DRIVE, '--port', options.port, '--down'],
      { cwd: ROOT },
    ).catch(() => {})
    const left = await rigLeft(options.port)
    if (left !== null) console.error(left)
  }
  checkRecord(record)
  say(
    `\n${record.stills.length} stills, ${record.casts.length} casts and ${record.samples.length} settled stills in ${out}`,
  )
  const { buildSheets } = await import('./sheet.mjs')
  await buildSheets({ dir: out, base: options.base }).catch((error) =>
    console.error(`the sheets were not built: ${error.message}`),
  )
}

/** A cast directory's screencast instants, or null where it kept none. */
async function instantsOf(dir) {
  const file = path.join(dir, 'timestamps.json')
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null
}

/** What a cast's path does beyond its picture: its levers, its boot, its scrub. */
const castDifferences = (cast) => [
  ...(cast.levers === undefined
    ? []
    : [`levers ${JSON.stringify(cast.levers)}`]),
  ...(cast.boot === undefined ? [] : [`booted at ${cast.boot} and cut`]),
  ...(cast.scrub === undefined
    ? []
    : [`booted ${cast.scrub} s early and scrubbed`]),
]

/**
 * A cut's or a scrub's settled plate, against the fresh boot's plate of the
 * same picture where this run took one: C9's first reading, by changed
 * pixels and RMSE, which the noise floor judges.
 */
async function settledPlate(out, record, cast, plate, read) {
  const kept = freshPlate(record, cast.id)
  const fresh = kept === null ? null : path.join(out, kept)
  const against = fresh !== null && existsSync(fresh)
  return {
    file: path.basename(plate),
    sha256: await sha256(plate),
    read,
    fresh: against ? kept : null,
    changed: against ? await changedPixels(fresh, plate) : null,
    rmse: against ? await rmseOf(fresh, plate) : null,
  }
}

/** One cast in one arm: kept, refused at every boot, or its lever unavailable. */
async function takeCast({ cast, clouds, out, record, drive, say }) {
  const name = castName(cast, clouds)
  say(`${name}: ${cast.why}`)
  const plate = cast.settled ? path.join(out, `${name}.settled.png`) : null
  // An earlier run's frames, clip and plate go before the first boot, so a
  // cast refused now leaves nothing of its own name for the sheet to pair.
  await rm(path.join(out, name), { recursive: true, force: true })
  if (plate !== null) await rm(plate, { force: true })
  const attempts = []
  for (let boot = 1; boot <= CAST_ATTEMPTS; boot += 1) {
    const result = await drive(
      castArgs(cast, clouds, plate === null ? null : takeOf(plate)),
    )
    const reads = castReads(cast, clouds, result)
    if (reads.levers !== 'set') {
      record.unavailable.push({
        name,
        id: cast.id,
        speed: cast.speed,
        clouds,
        levers: cast.levers,
        reason: reads.levers,
      })
      say(`  ${reads.levers}`)
      return
    }
    const refuse = (why) => {
      throw new Error(`${name}: ${why}; refused`)
    }
    if (reads.state?.weather !== 'drawn')
      refuse(
        `the picture's weather is ${String(reads.state?.weather)}, not drawn`,
      )
    // The control's clouds are off by its own lever, and serve nothing. A
    // cut's state is read where it boots, before the cut; its settled plate
    // after the cut is the cornerstone's own, and held as a still is.
    if (clouds) checkServed(cast.boot ?? cast.id, reads.state, refuse)
    checkBuild(name, reads.state, record.commit)
    if (cast.settled) checkStill(cast.id, 'volume', reads.read)
    const castStep = result.results.find((one) => one.step === 'cast')
    let verdict
    try {
      verdict = checkCast(
        name,
        reads.stop.log,
        await instantsOf(path.join(ROOT, castStep.dir)),
        cast,
      )
    } catch (error) {
      if (error.dropped === undefined) throw error
      say(`  ${error.message}`)
      attempts.push({
        hz: error.hz,
        dropped: error.dropped,
        why: error.message,
      })
      continue
    }
    const as = clouds
      ? role(cast.role ?? 'candidate', castDifferences(cast))
      : role('clouds-off', castDifferences(cast))
    if (plate !== null) await rename(takeOf(plate), plate)
    const dir = path.join(out, name)
    await cp(path.join(ROOT, castStep.dir), dir, { recursive: true })
    await writeFile(
      path.join(dir, 'log.json'),
      `${JSON.stringify(reads.stop, null, 1)}\n`,
    )
    const clip = path.join(dir, 'cast.mp4')
    say(
      `  ${castStep.frames} frames at ${verdict.hz.toFixed(1)} Hz${verdict.atSixty ? '' : ' (not held at 60 Hz)'}, ${verdict.dropped.length} drops, ${verdict.coverage === null ? 'no instants' : `${(verdict.coverage * 100).toFixed(0)}% of the path`}, boot ${boot}${verdict.retake ? ' — under two thirds: take it again' : ''}`,
    )
    record.casts.push({
      name,
      id: cast.id,
      speed: cast.speed,
      clouds,
      checks: cast.checks,
      control: clouds ? (cast.control ?? castName(cast, false)) : null,
      frames: castStep.frames,
      pathFrames: cast.frames,
      stopAt: reads.stop.stopAt,
      boots: boot,
      attempts,
      ...verdict,
      reduction: spansReduction(cast, reads.stop.log),
      settled:
        plate === null
          ? null
          : await settledPlate(out, record, cast, plate, reads.read),
      // The rate the clip is written at: the screencast's own frames
      // over their span, so it plays at the speed it was taken.
      clipFps: castStep.fps ?? null,
      isolated: castStep.isolated?.length ?? null,
      clip: existsSync(clip)
        ? { file: `${name}/cast.mp4`, sha256: await sha256(clip) }
        : null,
      ...provenance(record, cast.id, reads.state, as, {
        hz: verdict.hz,
        held: CAST_RATE.held,
        atSixty: verdict.atSixty,
      }),
    })
    return
  }
  // Refused at every boot: recorded with where each boot dropped, and the
  // run goes on to the next cast rather than losing them all.
  record.refused.push({
    name,
    id: cast.id,
    speed: cast.speed,
    clouds,
    attempts,
  })
}

async function takeCasts({ options, out, record, drive, say }) {
  for (const cast of options.casts)
    for (const arm of armsOfCast(cast))
      await takeCast({ cast, clouds: arm === 'on', out, record, drive, say })
  // The clouds' own drops: each on arm against its control's, once both
  // are on record, whichever cast took the control.
  for (const one of record.casts.filter((cast) => cast.clouds)) {
    const control = record.casts.find((cast) => cast.name === one.control)
    one.dropped = markCloudsOnly(one.dropped, control?.dropped ?? null)
    // C7's drift reads the field's motion over cloud pixels only, which it
    // finds against a clouds-off frame of the same held pose.
    if (one.reduction !== null && control !== undefined)
      one.controlFrame = `${control.name}/0000.jpg`
  }
}

/*
 * Settled stills along a path, as a cast's directory is laid out, so the
 * classifier reads them as it reads a cast: `0123.png` by path frame,
 * `stills.json` from path frame to its file and the opacity its read
 * served, and `log.json` with a row a still, the seek's reading of the eye.
 * Two sample sets on one path share its directory and its index.
 */
async function takeSamples({ options, out, record, drive, say, jsValues }) {
  const indexes = new Map()
  for (const sample of options.samples) {
    const cast = castByKey(sample.cast)
    const dir = path.join(out, 'samples', sample.cast)
    // An earlier run's stills go before this run's first set on the path.
    if (!indexes.has(dir)) {
      await rm(dir, { recursive: true, force: true })
      indexes.set(dir, { cast, stills: {}, log: [] })
    }
    await mkdir(dir, { recursive: true })
    const index = indexes.get(dir)
    for (let i = 0; i < sample.frames.length; i += SAMPLE_BATCH) {
      const frames = sample.frames.slice(i, i + SAMPLE_BATCH)
      const files = frames.map((k) =>
        path.join(dir, `${String(k).padStart(4, '0')}.png`),
      )
      say(`${sample.cast}: settled stills at ${frames[0]}..${frames.at(-1)}`)
      const result = await drive(sampleArgs(cast, frames, files.map(takeOf)))
      // After the install each frame answers a seek, then a read.
      const answers = jsValues(result).slice(1)
      for (const [n, k] of frames.entries()) {
        const read = await keepShot(takeOf(files[n]), files[n], () => {
          const checked = checkStill(cast.id, 'volume', answers[2 * n + 1])
          checkBuild(`${sample.cast} @ ${k}`, checked, record.commit)
          return checked
        })
        index.stills[k] = {
          file: path.basename(files[n]),
          opacity: read.clouds?.opacity ?? null,
        }
        index.log.push(answers[2 * n])
        record.samples.push({
          cast: sample.cast,
          frame: k,
          checks: sample.checks,
          file: path.relative(out, files[n]),
          sha256: await sha256(files[n]),
          read,
          ...provenance(
            record,
            cast.id,
            read,
            role('settled-sample', [`path frame ${k}`]),
          ),
        })
      }
    }
  }
  for (const [dir, index] of indexes) {
    await writeFile(
      path.join(dir, 'stills.json'),
      `${JSON.stringify(index.stills, null, 1)}\n`,
    )
    const log = [...index.log].sort((a, b) => a.k - b.k)
    await writeFile(
      path.join(dir, 'log.json'),
      `${JSON.stringify({ path: castPath(index.cast), stopAt: index.cast.path.stopAt ?? null, frames: log.length, log }, null, 1)}\n`,
    )
  }
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
