/*
 * Take every cornerstone, in its arms, and the scripted casts: the media a
 * weather pull request carries (phase 1 design §3.6).
 *
 *   pnpm build && pnpm preview &          # 8787; refused if nothing answers
 *   node scripts/weather/capture.mjs --phase 1 --url http://localhost:8787/ --gpu-wait 1800
 *     --only e1,g6        a subset, by the id's picture tag
 *     --twice             each still from two boots, and the pair's difference
 *     --cut e1            one still a third way, by a cut inside a boot
 *     --base <dir|record> the last phase's plates, for the sheets
 *     --no-casts          the stills alone
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
 * **A still** waits on `ir.settled()`, which now waits on the clouds' history
 * and caches as well, then reads back what the page drew and shoots. A take
 * whose settle did not finish, whose renderer is not in standard SDR, or
 * whose weather is not its arm's is refused, never kept: a plate of a
 * history halfway converged, or of the deck where the volume was meant, is
 * the quiet drift this exists to prevent.
 *
 * **Arms.** Every still has a `volume` arm, taken with `?clouds=1`, whose
 * picture must report its weather drawn. E1 to E3 also have a `deck` arm,
 * taken without the flag, whose weather must be unavailable: Earth then
 * draws its textured deck, which is what the volume is judged beside until
 * it retires.
 *
 * **A cast** is a path of `descent.mjs`'s, recorded over a screencast with
 * the clouds on and again with them off. The page's own log carries a
 * timestamp a frame, and the cast's rate is the median interval over its
 * whole path. Until the rig can hold 60 Hz on demand, a cast at another
 * rate is kept and its rate recorded beside it (rubric §4); `CAST_RATE.held`
 * is the switch that refuses it outside 58 to 62 Hz once it can. The path
 * advances a step a frame, so at another rate the same path runs in other
 * seconds, which is what the recorded rate tells a reader. What is refused
 * at any rate is a run that dropped a frame: an interval twice the median
 * or longer anywhere on the path is a frame the page did not present, and
 * a reading of continuity across it reads a gap.
 *
 * Output goes to the main checkout's `.data/weather/phase-<n>/`, found from
 * the clone's common git directory as the GPU lock is, so every worktree of
 * every phase writes one place and a removed worktree takes no plate with
 * it: `<id>-<arm>.png`, `<id>-<speed>-<on|off>/` with the cast's frames, its
 * clip and its log, and `record.json`, which names the commit and every
 * file's SHA-256. A still's record carries its cloud texel share, from
 * `ir.cloudRadiance()`: the share of the trace's texels whose history holds
 * cloud, which is what tells a sheet of the sky from a sheet of cloud.
 */
import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CORNERSTONES } from '../../packages/devtools/src/index.ts'
import { rigLeft, takeGpu } from '../driveLock.mjs'
import {
  castName,
  CASTS,
  INSTALL_PATH,
  startPath,
  stopPath,
} from './descent.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DRIVE = path.join(ROOT, 'scripts/drive.mjs')

/** The rubric's rig (§3.2 there). */
export const RIG = Object.freeze({
  width: 1440,
  height: 900,
  dpr: 2,
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
 * band refuses again. `dropped` is the interval, in medians, past which a
 * frame was not presented.
 */
export const CAST_RATE = Object.freeze({
  low: 58,
  high: 62,
  frames: 30,
  held: false,
  dropped: 2,
})
/** Boots a cast may take before a dropped frame refuses it. */
export const CAST_ATTEMPTS = 3
/** Frames a cast records past its path's end, so the end is in the clip. */
export const CAST_TAIL = 90
/** Below this share of its path's frames a screencast is subsampling it. */
export const CAST_COVERAGE = 2 / 3
/** The presets' per-pixel level against a PNG (`scripts/presets/compare.mjs`). */
export const SAME_LEVEL = '3%'

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
  tagOf(id).startsWith('e') ? ['volume', 'deck'] : ['volume']

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
      cut: { type: 'string', multiple: true },
      base: { type: 'string' },
      casts: { type: 'boolean', default: true },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowNegative: true,
  })
  if (values.help) return { help: true }
  if (values.phase === undefined || !/^\d+$/.test(values.phase))
    throw new Error('--phase <n> names the phase the plates are of')
  if (values.url === undefined)
    throw new Error(
      '--url names the production preview to photograph, e.g. http://localhost:8787/',
    )
  const wait = Number(values['gpu-wait'])
  if (!Number.isFinite(wait) || wait < 0)
    throw new Error('--gpu-wait takes seconds, zero or more')
  const tags = values.only === undefined ? null : values.only.split(',')
  const known = CORNERSTONES.map((one) => tagOf(one.id))
  for (const tag of [...(tags ?? []), ...(values.cut ?? [])])
    if (!known.includes(tag))
      throw new Error(`no cornerstone tagged ${tag}; tags: ${known.join(', ')}`)
  for (const tag of values.cut ?? [])
    if (!STILLS.some((id) => tagOf(id) === tag))
      throw new Error(`--cut ${tag} names a cast, not a still`)
  const wanted = (id) => tags === null || tags.includes(tagOf(id))
  return {
    help: false,
    phase: Number(values.phase),
    url: new URL(values.url).toString(),
    gpuWaitMs: wait * 1000,
    port: values.port,
    stills: STILLS.filter(wanted),
    twice: values.twice,
    cuts: (values.cut ?? []).map((tag) =>
      STILLS.find((id) => tagOf(id) === tag),
    ),
    casts: values.casts ? CASTS.filter((cast) => wanted(cast.id)) : [],
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

/**
 * What a still reads back before its shot. The weather is the engine's hold:
 * what became of the picture's weather, after the clouds' chunk arrived.
 */
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
  return { mode: engine.gl.description.mode, chrome: engine.chrome, lens: engine.lens, time: ir.observatory.time, light: ir.light(), settled: ir.settled(), clouds: ir.clouds(), cloud, weather: engine.pictureWeather.outcome, build: ir.build() }
})()`

/** One still: a fresh boot at the picture, settled, read and shot. */
export const stillArgs = (id, arm, file) => [
  '--preset',
  id,
  ...plateQueries(arm === 'volume'),
  '--settle',
  String(SETTLE_BUDGET),
  '--wait',
  String(SETTLE_QUIET),
  '--js',
  READ,
  '--shot',
  file,
]

/**
 * A cut: boot at another picture on another body, settle, take the
 * cornerstone inside the same boot, settle and shoot. Every cache is kept
 * through a cut on purpose, and this is the check that the kept caches are
 * the right ones.
 */
export const cutArgs = (from, id, file) => [
  '--preset',
  from,
  ...plateQueries(true),
  '--settle',
  String(SETTLE_BUDGET),
  '--js',
  `ir.preset(${JSON.stringify(id)}).weather`,
  '--settle',
  String(SETTLE_BUDGET),
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

/** One cast: the picture, settled, the path, the screencast, the log. */
export const castArgs = (cast, clouds) => [
  '--preset',
  cast.id,
  ...plateQueries(true),
  '--settle',
  String(SETTLE_BUDGET),
  ...(clouds
    ? []
    : [
        '--js',
        'engine.clouds = { ...engine.clouds, on: false }',
        '--settle',
        String(SETTLE_BUDGET),
      ]),
  '--js',
  INSTALL_PATH,
  '--js',
  `engine.pictureWeather.outcome`,
  '--js',
  startPath(cast.path),
  '--cast',
  String(cast.frames + CAST_TAIL),
  '--js',
  stopPath(),
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
  return read
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
 * Read a cast's rate over its whole path, and refuse a run that dropped a
 * frame anywhere on it. The band refuses only where `held` says the rig can
 * hold 60 Hz; until then the rate is what the record says beside the cast.
 */
export function checkCast(name, log, captured, cast, held = CAST_RATE.held) {
  const pathFrames = Math.min(log.length, cast.frames + CAST_TAIL)
  const intervals = intervalsOf(log, pathFrames)
  const median = medianOf(intervals)
  if (median === null || !(median > 0))
    throw new Error(`${name}: presented at no measurable rate; refused`)
  const hz = 1000 / median
  const longest = Math.max(...intervals)
  /*
   * Twice the median, not a share over it: at 42.6 Hz on a 120 Hz panel
   * the page presents on a mix of 25 and 33.3 ms intervals, and a line at
   * 1.5 medians would read that cadence as drops. An interval of two
   * medians is a frame that did not present.
   */
  const dropped = intervals.filter(
    (interval) => interval >= CAST_RATE.dropped * median,
  ).length
  if (dropped > 0)
    throw Object.assign(
      new Error(
        `${name}: ${dropped} interval${dropped === 1 ? '' : 's'} of at least ${CAST_RATE.dropped} × the median ${median.toFixed(1)} ms, the longest ${longest.toFixed(1)} ms: a frame was dropped mid-run; take it again`,
      ),
      { dropped },
    )
  const atSixty = hz >= CAST_RATE.low && hz <= CAST_RATE.high
  if (held && !atSixty)
    throw new Error(
      `${name}: presented at ${hz.toFixed(1)} Hz, outside ${CAST_RATE.low}–${CAST_RATE.high}; the path is scheduled by frame and must be taken at 60 Hz`,
    )
  const coverage = pathFrames > 0 ? captured / pathFrames : 0
  return {
    hz,
    atSixty,
    first: presentationRate(log),
    longest,
    coverage,
    retake: coverage < CAST_COVERAGE,
  }
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

/* --------------------------------------------------------------- main --- */

async function main() {
  const options = parseCapture(process.argv.slice(2))
  if (options.help) {
    console.log(
      'node scripts/weather/capture.mjs --phase <n> --url <preview> [--gpu-wait <s>] [--only e1,g6] [--twice] [--cut e1] [--base <dir|record>] [--no-casts]',
    )
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
  const lastJs = (result) =>
    result.results.findLast((one) => one.step === 'js')?.value

  const record = {
    phase: options.phase,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    clean:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim() === '',
    url: options.url,
    rig: RIG,
    references: existsSync(
      path.join(ROOT, 'design/plans/weather/references.md'),
    )
      ? await sha256(path.join(ROOT, 'design/plans/weather/references.md'))
      : null,
    base: options.base,
    build: null,
    chrome: null,
    stills: [],
    twice: [],
    cuts: [],
    casts: [],
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

    const still = async (id, arm, file) => {
      const result = await drive(stillArgs(id, arm, file))
      const read = checkStill(id, arm, lastJs(result))
      record.build ??= read.build
      return {
        id,
        arm,
        file: path.basename(file),
        sha256: await sha256(file),
        read,
      }
    }

    for (const id of options.stills)
      for (const arm of armsOf(id)) {
        const file = path.join(out, `${id}-${arm}.png`)
        say(`${id} (${arm})`)
        const take = await still(id, arm, file)
        record.stills.push(take)
        if (options.twice) {
          const again = path.join(out, `${id}-${arm}.again.png`)
          const second = await still(id, arm, again)
          const changed = await changedPixels(file, again)
          say(`  two boots differ at ${changed} pixels`)
          record.twice.push({
            id,
            arm,
            changed,
            again: second.file,
            sha256: second.sha256,
          })
        }
      }

    for (const id of options.cuts) {
      const from = cutFrom(id)
      const file = path.join(out, `${id}-volume.cut.png`)
      say(`${id} by a cut from ${from}`)
      const result = await drive(cutArgs(from, id, file))
      const read = checkStill(id, 'volume', lastJs(result))
      const fresh = path.join(out, `${id}-volume.png`)
      const changed = existsSync(fresh)
        ? await changedPixels(fresh, file)
        : null
      say(
        `  the cut differs from its fresh boot at ${changed ?? '(no fresh plate)'} pixels`,
      )
      record.cuts.push({
        id,
        from,
        file: path.basename(file),
        sha256: await sha256(file),
        changed,
        read,
      })
    }

    for (const cast of options.casts)
      for (const clouds of [true, false]) {
        const name = castName(cast, clouds)
        say(`${name}: ${cast.why}`)
        let result
        let castStep
        let stop
        let verdict
        // A dropped frame is taken again, from a fresh boot, before the run
        // gives up on the cast: the rubric retakes a cast with a gap rather
        // than reading continuity across it.
        for (let attempt = 1; verdict === undefined; attempt += 1) {
          result = await drive(castArgs(cast, clouds))
          castStep = result.results.find((one) => one.step === 'cast')
          stop = lastJs(result)
          // The steps' last four evaluations are the install, the weather,
          // the start and the stop; the control's levers come before them.
          const evaluations = result.results.filter((one) => one.step === 'js')
          const outcome = evaluations.at(-3)?.value
          if (outcome !== 'drawn')
            throw new Error(
              `${name}: the picture's weather is ${String(outcome)}, not drawn; refused`,
            )
          try {
            verdict = checkCast(name, stop.log, castStep?.frames ?? 0, cast)
          } catch (error) {
            if (error.dropped === undefined || attempt >= CAST_ATTEMPTS)
              throw error
            say(`  ${error.message}`)
          }
        }
        const dir = path.join(out, name)
        await rm(dir, { recursive: true, force: true })
        await cp(path.join(ROOT, castStep.dir), dir, { recursive: true })
        await writeFile(
          path.join(dir, 'log.json'),
          `${JSON.stringify(stop, null, 1)}\n`,
        )
        const clip = path.join(dir, 'cast.mp4')
        say(
          `  ${castStep.frames} frames at ${verdict.hz.toFixed(1)} Hz${verdict.atSixty ? '' : ' (not held at 60 Hz)'}, ${(verdict.coverage * 100).toFixed(0)}% of the path${verdict.retake ? ' — under two thirds: take it again' : ''}`,
        )
        record.casts.push({
          name,
          id: cast.id,
          speed: cast.speed,
          clouds,
          frames: castStep.frames,
          pathFrames: cast.frames,
          stopAt: stop.stopAt,
          ...verdict,
          // The rate the clip is written at: the screencast's own frames
          // over their span, so it plays at the speed it was taken.
          clipFps: castStep.fps ?? null,
          isolated: castStep.isolated?.length ?? null,
          clip: existsSync(clip)
            ? { file: `${name}/cast.mp4`, sha256: await sha256(clip) }
            : null,
        })
      }
  } finally {
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
  say(
    `\n${record.stills.length} stills and ${record.casts.length} casts in ${out}`,
  )
  const { buildSheets } = await import('./sheet.mjs')
  await buildSheets({ dir: out, base: options.base }).catch((error) =>
    console.error(`the sheets were not built: ${error.message}`),
  )
}

if (import.meta.main)
  await main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
