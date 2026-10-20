#!/usr/bin/env node
/*
 * `pnpm drive` — the browser, over the DevTools Protocol, from a terminal.
 *
 * All agent browser work on this project goes through here. The Claude-in-Chrome
 * extension drives the *human's* Chrome: its screenshots take focus, which is a
 * problem in both directions — the page it steals focus from stops rendering,
 * and the person it steals focus from is trying to use their computer. Worse,
 * two tabs on `localhost:5173` are indistinguishable to it, so it can drive the
 * wrong one. This launches its own Chrome, on its own profile and port, and
 * needs no focus at all.
 *
 * Four things make it work rather than hang. Each cost a round trip to find:
 *
 *  - `Emulation.setFocusEmulationEnabled` plus `Page.bringToFront`, or rAF stays
 *    suspended while the window is occluded, boot never leaves "first light…",
 *    and every screenshot is the boot cover.
 *  - `Page.captureScreenshot`, never a canvas readback. The renderer is WebGPU
 *    and the swap-chain texture is invalidated at the end of the task that drew
 *    it, so `toDataURL` returns transparent black long before page script can
 *    copy it. The composited screenshot also picks up the DOM HUD, which is the
 *    half a canvas dump could never show.
 *  - Readiness is `ir.status().boot`, which the app answers: `drawing` once a
 *    renderer exists, `booted` once the boot cover has lifted. `window.ir`
 *    alone appears seconds earlier, and a probe on it screenshots an unlit
 *    canvas. The driver names no field and no markup of the app's own, so a
 *    rename there cannot turn a cold boot into twelve silent seconds.
 *  - A real window, not `--headless`. Not for the adapter — headless Chrome keeps
 *    the physical GPU on macOS, measured as `apple` / `metal-3` with and without
 *    a window, because SwiftShader has no macOS build to fall back to — but
 *    because `--cast` records what a compositor presented, and a headless one
 *    presents nothing. For a shader question that needs no compositor at all,
 *    one `*.gpu.test.ts` named on the command line answers in a second or two
 *    without this file; the whole `pnpm test:gpu` suite is eighteen, nearly all
 *    of it the terrain kernel.
 *
 * The expensive thing here is boot — about five seconds of shader warm and body
 * build, on top of the dev server's own start. So Chrome is left running
 * between invocations. Each call starts with clean local storage and cookies;
 * --keep-storage opts into attaching to the booted page instead of reloading
 * it: measured, 6 s cold against 80 ms warm. Most of that cold figure
 * is the dev server and Chrome rather than the page — `?presentation=occluded`
 * below is what keeps the page's own boot to one warm-up census. That is what
 * makes a batch of steps worth writing on one command line:
 *
 *     node scripts/drive.mjs --js "ir.look('g:milky-way/s:SOL/b:2')" \
 *                            --wait 2000 --shot earth.jpg
 *     node scripts/drive.mjs --keep-storage --js "ir.terrain()" # page still hot
 *     node scripts/drive.mjs --down                     # when finished
 *
 * Steps run in the order they are written, so one process does a whole
 * verification. `--help` lists them.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { analyzeFrames, differenceMap, reportFrames } from './frameDiff.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { driveUrl } from './driveUrl.mjs'
import { castFrames, connect, drainLogs, evaluate, traceFor } from './cdp.mjs'
import { boot, clearStorage } from './drivePage.mjs'
import {
  checkSteps,
  jsonReport,
  planSteps,
  runSteps,
  sampleFrames,
} from './driveSteps.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Where shots land when the path has no directory in it, and where the rig
 *  records what it started. `.data/` is git-ignored; nothing here is source. */
const RIG = path.join(ROOT, '.data/drive')
/** Longest edge a cast frame is captured at; see `castFrames`. */
const CAST_PX = 1280

const OPTIONS = {
  /* Session — these describe the browser, not a step. */
  url: { type: 'string', default: 'http://localhost:5173/' },
  /** Planetarium fixtures use the public URL codec and the page's restore path. */
  preset: { type: 'string' },
  picture: { type: 'string' },
  query: { type: 'string', multiple: true },
  /** Keys the Chrome profile directory as well as the debugging port, so two
   *  agents on different ports cannot fight over one profile. */
  port: { type: 'string', default: '9333' },
  width: { type: 'string', default: '1600' },
  height: { type: 'string', default: '900' },
  dpr: { type: 'string', default: '1' },
  /** Reload and re-boot even when the attached page is already rendering. */
  fresh: { type: 'boolean', default: false },
  /** Preserve local storage and cookies, and permit a warm attach. */
  'keep-storage': { type: 'boolean', default: false },
  /** Explicit script steps can exercise APIs gated on visitor activation. */
  'user-gesture': { type: 'boolean', default: false },
  /** Public HTML can be inspected before a runtime exists or when it fails. */
  document: { type: 'boolean', default: false },
  javascript: { type: 'boolean', default: true },
  'block-url': { type: 'string', multiple: true },
  /** Start `pnpm dev` when nothing answers `--url`; `--no-serve` to fail
   *  instead, which `allowNegative` gives for free. */
  serve: { type: 'boolean', default: true },
  /** Longest edge of a written shot, in pixels; 0 keeps the native capture. */
  'max-px': { type: 'string', default: '1568' },
  /** JPEG quality, for a `--shot` whose path ends in `.jpg`. */
  quality: { type: 'string', default: '88' },

  /* Lifecycle — each exits without running steps. */
  down: { type: 'boolean', default: false },
  status: { type: 'boolean', default: false },
  'print-url': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },

  /* Steps, in the order written. */
  js: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
  wait: { type: 'string', multiple: true },
  settle: { type: 'string', multiple: true },
  shot: { type: 'string', multiple: true },
  sample: { type: 'string', multiple: true },
  'sample-js': { type: 'string', default: 'ir.terrain()' },
  /** A burst of *rendered* frames, differenced — the only step that can see a
   *  strobe. `--shot` cannot: it draws its own frame. */
  cast: { type: 'string', multiple: true },
  /** Record a Chrome trace for <ms>, written beside the shots for
   *  `scripts/timing.mjs`. The only step that captures the custom tracks. */
  trace: { type: 'string', multiple: true },
  logs: { type: 'boolean', multiple: true },
  reload: { type: 'boolean', multiple: true },

  /* Output. */
  quiet: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
}

const HELP = `pnpm drive — drive InertialRef in Chrome over the DevTools Protocol

  node scripts/drive.mjs [session flags] [steps...]

Steps run in the order they are written, in one browser session:

  --js <expr>        evaluate in the page. A bare expression is returned, so
                     --js "ir.terrain()" prints the report. Write an explicit
                     \`return\` for a multi-statement body; \`await\` works.
  --file <path>      evaluate a local .js/.mjs file in the page, for anything
                     too long or too quote-heavy for a shell argument
  --wait <ms>        a fixed pause. Textures stream in asynchronously after a seek
  --settle <ms>      wait until ir.settled() says the sky and the ground have
                     stopped arriving, for at most <ms>; reports what was still
                     pending if it ran out. What a plate waits for
  --shot <path>      screenshot. A bare filename lands in .data/drive/;
                     a .jpg extension captures JPEG, which is what to read
  --sample <n>       n consecutive rAF frames of --sample-js, with a per-field
                     min..max summary. A still cannot show a strobe
  --cast <n>         n rendered frames over a screencast, written to
                     .data/drive/cast/ and differenced: reports the frames that
                     differ from both neighbors while the neighbors match each
                     other, their period, and the rate in Hz. That shape is a
                     strobe; motion produces none. Writes cast.mp4 when ffmpeg
                     is installed, which is the artifact worth attaching
  --trace <ms>       record a Chrome trace for <ms> and write it to
                     .data/drive/trace.json. Pair it with ?timing=trace on the
                     --url, or ir.timing('trace'), or the tracks are empty.
                     Read it back with: node scripts/timing.mjs
  --logs             console output and page errors buffered so far
  --reload           hard reload, then wait for the selected readiness mode

Session flags:

  --url <url>        default http://localhost:5173/
  --preset <id>      bundled planetarium shot, expanded into a full shot URL
  --picture <path>   JSON export containing one planetarium shot; excludes --preset
  --query <key=value> override a query field; repeat for more fields, last wins.
                     Quote raw text, without URL encoding: --query 'label=Sea + sky'
                     Applied after --preset/--picture; presentation stays occluded.
  --port <n>         default 9333; also keys the Chrome profile, so parallel
                     agents must differ
  --width/--height   viewport, default 1600x900
  --dpr <n>          device scale factor, default 1
  --fresh            re-boot even if the attached page is already rendering
  --keep-storage     retain local storage/cookies and allow a warm attach;
                     default clears both before booting the requested page
  --user-gesture     activate only --js/--file evaluations as user gestures;
                     opt in to test audio or other activation-gated actions
  --document         wait for HTML readiness, without waiting for the renderer
  --no-javascript    disable page scripts before navigation; implies --document.
                     --js still evaluates inspection expressions through CDP.
  --block-url <glob> block matching requests before navigation; repeat for more.
                     Pair with --document to inspect a failed runtime startup.
  --no-serve         fail instead of starting \`pnpm dev\` when nothing answers
  --max-px <n>       longest edge of a written shot, default 1568; 0 for native
  --quality <n>      JPEG quality, default 88
  --json             one JSON object of every step result, instead of lines
  --quiet            step results only — no progress narration

Lifecycle:

  --status           what this rig has running
  --print-url        print the resolved URL without starting Chrome or a server
  --down             close the Chrome and the dev server this rig started

Chrome stays up between invocations. Each call clears local storage and cookies
and reboots the page unless --keep-storage is given. --down when finished.

Photographic fixtures (session flags, before all measurement steps):

  node scripts/drive.mjs --preset earthrise --wait 2000 --shot earthrise.jpg
  node scripts/drive.mjs --picture shot.json --query 'lens.zoom=2' --shot detail.jpg
  node scripts/drive.mjs --picture shot.json --query 'save=1' --logs

--preset and --picture select /planetarium on --url's host. To test the built-in
alias itself, use --url 'http://localhost:5173/planetarium?preset=earthrise'.
Three query fields carry the rest of a plate's state, so a fixture is one
navigation and a settle: --query chrome=0 clears the interface, --query layers=0
takes the names and traces with it, --query output=standard is SDR for the
page's lifetime.`

const { values, tokens } = parseArgs({
  options: OPTIONS,
  tokens: true,
  allowNegative: true,
})

if (values.help === true) {
  console.log(HELP)
  process.exit(0)
}

const PORT = Number(values.port)
/*
 * The asked-for URL, plus the one thing this rig has to tell the page about
 * itself.
 *
 * This Chrome is occluded — it is behind whatever the human is doing — and
 * focus emulation is what makes it run animation frames anyway. The side
 * effect is that `document.visibilityState` reports `visible` for a window
 * that never composites, so the presentation watchdog's pixel readback comes
 * back transparent black for a renderer that is fine, climbs its whole
 * recovery ladder, and rebuilds the canvas: a second full preload and warm-up
 * census 4.5 s after the first, roughly 6.5 s of every boot here, and an
 * uncaught dispose from inside Three on the remount. No player pays it, and
 * every boot figure taken from this rig did.
 *
 * `?presentation=occluded` tells the page the probe is unreadable rather than
 * black — `QUERY.presentation` in `apps/game/src/pages/paths.ts` carries the
 * argument. It is added to whatever `--url` asks for, and the attach check
 * below compares asked-for keys only, so it does not disturb the match.
 */
const URL_ = driveUrl({
  url: values.url,
  preset: values.preset,
  picture:
    values.picture === undefined
      ? undefined
      : JSON.parse(await readFile(values.picture, 'utf8')),
  query: values.query,
})
if (values['print-url'] === true) {
  console.log(URL_)
  process.exit(0)
}
const WIDTH = Number(values.width)
const HEIGHT = Number(values.height)
const DPR = Number(values.dpr)
const MAX_PX = Number(values['max-px'])
const QUALITY = Number(values.quality)
const SERVE = values.serve === true
const JAVASCRIPT = values.javascript === true
const DOCUMENT = values.document === true || !JAVASCRIPT
const BLOCKED_URLS = values['block-url'] ?? []
const STATE = path.join(RIG, `session-${PORT}.json`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Two channels, because they answer to different flags. `say` is what a step
 * returned and is the reason the command was run; `note` is the rig narrating
 * itself, which `--quiet` exists to silence. Routing both through one writer
 * made `--quiet` swallow the answer as well as the narration.
 */
const say = (line) => {
  if (!values.json) process.stdout.write(`${line}\n`)
}
const note = (line) => {
  if (!values.quiet) say(line)
}

/** The steps, in the order written; `planSteps` says why the order survives. */
const script = planSteps(tokens)

/* ------------------------------------------------------------------ rig ---- */

async function readState() {
  return await readFile(STATE, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
}

/** A patch, merged over what is already recorded rather than replacing it, so
 *  a pid written the moment its process was spawned survives the fuller write
 *  at the end of start-up. */
async function writeState(patch) {
  await mkdir(RIG, { recursive: true })
  const prior = (await readState()) ?? {}
  await writeFile(STATE, `${JSON.stringify({ ...prior, ...patch }, null, 2)}\n`)
}

const alive = (pid) => {
  if (typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const answers = async (url) =>
  Boolean(await fetch(url, { method: 'HEAD' }).catch(() => null))

async function serve(state) {
  if (await answers(URL_)) return state.serverPid ?? null
  if (!SERVE) throw new Error(`nothing is serving ${URL_}; run \`pnpm dev\``)
  note(
    `starting pnpm dev — log: ${path.relative(ROOT, path.join(RIG, 'dev.log'))}`,
  )
  await mkdir(RIG, { recursive: true })
  const log = await import('node:fs').then((fs) =>
    fs.openSync(path.join(RIG, 'dev.log'), 'a'),
  )
  // Detached and in its own process group: this outlives the invocation on
  // purpose, and `--down` kills the group so the Worker goes with vite.
  const child = spawn('node', ['scripts/dev.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    detached: true,
  })
  child.unref()
  // Recorded now, not on the way out. A dev server that never starts serving
  // still has a process group holding 5173 and 8787, and a pid that only lands
  // in the state file on success is a pid `--down` can never kill.
  await writeState({ serverPid: child.pid ?? null, startedServer: true })
  for (let i = 0; i < 120; i += 1) {
    await sleep(500)
    if (await answers(URL_)) return child.pid ?? null
    // `dev.mjs` refuses a taken port in milliseconds; polling the full sixty
    // seconds for a process that has already exited is the wait nobody can
    // explain. `unref` drops the loop reference only — exitCode still lands.
    if (child.exitCode !== null) {
      throw new Error(
        `pnpm dev exited (code ${child.exitCode}) without serving ${URL_} — see .data/drive/dev.log`,
      )
    }
  }
  throw new Error(
    `pnpm dev did not start serving ${URL_} — see .data/drive/dev.log`,
  )
}

async function launchChrome(state) {
  const up = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(
    () => null,
  )
  if (up?.ok) return state.chromePid ?? null
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}`)
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(RIG, `profile-${PORT}`)}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      // Off-screen to the right rather than hidden: focus emulation keeps it
      // rendering, and a window nobody can see is a window nobody clicks in.
      `--window-size=${WIDTH},${HEIGHT + 120}`,
      '--window-position=2400,60',
      // A proof with scripts disabled or requests blocked must not execute
      // the requested page before the DevTools controls reach this target.
      DOCUMENT || BLOCKED_URLS.length > 0 ? 'about:blank' : URL_,
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  // Same reason as the dev server above: a Chrome that never opens its
  // debugging port is still a Chrome, and `--down` can only kill what it knows.
  await writeState({ chromePid: child.pid ?? null })
  for (let i = 0; i < 80; i += 1) {
    await sleep(500)
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(
      () => null,
    )
    if (r?.ok) return child.pid ?? null
  }
  throw new Error('Chrome did not open a debugging port')
}

async function pageTarget() {
  for (let i = 0; i < 60; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page =
      list.find((t) => t.type === 'page' && String(t.url).startsWith('http')) ??
      list.find((t) => t.type === 'page' && t.url === 'about:blank')
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    await sleep(500)
  }
  throw new Error(`no page target on port ${PORT}`)
}

/* ---------------------------------------------------------------- steps ---- */

async function capture(send, target) {
  const out = target.includes('/') ? target : path.join(RIG, target)
  const jpeg = /\.jpe?g$/i.test(out)
  const format = jpeg ? { format: 'jpeg', quality: QUALITY } : { format: 'png' }
  // Twice, with a pause. The first capture is what activates the page and
  // draws the frame; taken alone it shows whatever was on screen before the
  // step that preceded it. The second one is the evidence.
  if (!DOCUMENT) {
    await send('Page.captureScreenshot', format)
    await sleep(700)
  }
  const shot = await send('Page.captureScreenshot', format)
  let bytes = Buffer.from(shot.data, 'base64')
  if (MAX_PX > 0 && Math.max(WIDTH, HEIGHT) * DPR > MAX_PX) {
    // Claude downsamples any image whose long edge exceeds 1568 px, so beyond
    // that a larger file is bytes and tokens spent on pixels the reader never
    // sees. `--max-px 0` keeps the native capture for a plate that gets published.
    const sharp = await import('sharp').then((m) => m.default).catch(() => null)
    // Both edges and `fit: 'inside'`, because the bound is on the *long* edge
    // and the long edge is not always the width: a portrait viewport capped by
    // width alone comes back untouched — `withoutEnlargement` sees 900 px of
    // width under the cap and leaves the 1600 px of height it was called about.
    if (sharp !== null)
      bytes = await sharp(bytes)
        .resize({
          width: MAX_PX,
          height: MAX_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .toBuffer()
  }
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, bytes)
  return { path: path.relative(ROOT, out), bytes: bytes.length }
}

/**
 * The cast, as something to attach to a pull request.
 *
 * A strobe argued in prose is a paragraph; the same strobe as five seconds of
 * video is the argument. Written at the rate the frames were captured at, so
 * the recurrence plays back at the rate it happens. Absent ffmpeg this is
 * skipped rather than fatal — the frames and the analysis are the finding, and
 * the clip is how it travels.
 */
async function castClip(dir, fps) {
  const out = path.join(dir, 'cast.mp4')
  try {
    await promisify(execFile)(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(Math.max(1, Math.round(fps || 60))),
        '-i',
        path.join(dir, '%04d.jpg'),
        // yuv420p and an even-dimension pad, because a capture whose width is
        // odd encodes to a file QuickTime and GitHub both refuse to play.
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
      ],
      { maxBuffer: 1 << 24 },
    )
    return out
  } catch {
    return null
  }
}

/* ----------------------------------------------------------------- main ---- */

async function down() {
  const state = await readState()
  if (state === null) {
    say(`nothing recorded for port ${PORT}`)
    return
  }
  if (alive(state.chromePid)) {
    process.kill(state.chromePid, 'SIGTERM')
    say(`closed Chrome (pid ${state.chromePid})`)
  }
  if (state.startedServer === true && alive(state.serverPid)) {
    // `dev.mjs` is a group leader (`detached`, in serve()) that starts vite and
    // `cf dev` in groups of their own, so the signal reaches them through its
    // SIGTERM handler, which relays to both. The fallback is for a recorded pid
    // that leads no group.
    try {
      process.kill(-state.serverPid, 'SIGTERM')
    } catch {
      process.kill(state.serverPid, 'SIGTERM')
    }
    say(`stopped pnpm dev (pid ${state.serverPid})`)
  }
  await rm(STATE, { force: true })
}

async function status() {
  const state = (await readState()) ?? {}
  const chrome = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then((r) => r.ok)
    .catch(() => false)
  console.log(
    [
      `port      ${PORT}`,
      `url       ${URL_} ${(await answers(URL_)) ? '(answering)' : '(down)'}`,
      `chrome    ${chrome ? `listening, pid ${state.chromePid ?? '?'}` : 'not running'}`,
      `dev       ${
        state.startedServer === true
          ? `started by this rig, pid ${state.serverPid ?? '?'}`
          : 'not started by this rig'
      }`,
    ].join('\n'),
  )
}

/** A cast written to `.data/drive/cast/`, differenced, and clipped, as the
 *  step's result and the lines it says. */
async function cast(wire, n) {
  const dir = path.join(RIG, 'cast')
  await rm(dir, { recursive: true, force: true })
  const frames = await castFrames(wire, n, { maxPx: CAST_PX })
  await mkdir(dir, { recursive: true })
  const paths = []
  for (const [i, frame] of frames.entries()) {
    const file = path.join(dir, `${String(i).padStart(4, '0')}.jpg`)
    await writeFile(file, Buffer.from(frame.data, 'base64'))
    paths.push(file)
  }
  const at = frames.map((f) => f.at)
  const span = at.length > 1 ? at[at.length - 1] - at[0] : 0
  const fps = span > 0 ? at.length / span : 0
  const analysis = await analyzeFrames(paths, at)
  // The map is the answer to "where", which the counts never give. Only
  // for the first isolated frame: one picture makes the point and a
  // hundred is a directory nobody opens.
  const first = analysis.isolated[0]
  const map =
    first === undefined
      ? null
      : await differenceMap(
          paths[first.frame - 1],
          paths[first.frame],
          path.join(dir, 'difference.png'),
        )
  const clip = await castClip(dir, fps)
  const lines = [
    `cast: ${paths.length} frames in ${span.toFixed(2)}s ` +
      `(${fps.toFixed(1)} fps) -> ${path.relative(ROOT, dir)}`,
    ...reportFrames(analysis, fps)
      .split('\n')
      .map((line) => `  ${line}`),
  ]
  if (map !== null) lines.push(`  where: ${path.relative(ROOT, map)}`)
  if (clip !== null) lines.push(`  clip:  ${path.relative(ROOT, clip)}`)
  return {
    result: { dir: path.relative(ROOT, dir), ...analysis, map, clip },
    lines,
  }
}

/** A trace written beside the shots, where `scripts/timing.mjs` reads it. */
async function trace(wire, ms) {
  const out = path.join(RIG, 'trace.json')
  const events = await traceFor(wire, ms)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({ traceEvents: events }))
  const { size } = await stat(out)
  return { path: path.relative(ROOT, out), events: events.length, bytes: size }
}

async function main() {
  if (values.down === true) return await down()
  if (values.status === true) return await status()
  checkSteps(script, {
    userGesture: values['user-gesture'] === true,
    javascript: JAVASCRIPT,
  })

  const prior = (await readState()) ?? {}
  const wasServing = await answers(URL_)
  const serverPid = await serve(prior)
  const chromePid = await launchChrome(prior)
  await writeState({
    port: PORT,
    url: URL_,
    chromePid,
    serverPid,
    startedServer: prior.startedServer === true || !wasServing,
  })

  const ws = new WebSocket(await pageTarget())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const wire = connect(ws)
  const { send, events } = wire
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setScriptExecutionDisabled', { value: !JAVASCRIPT })
  await send('Network.enable')
  await send('Network.setBlockedURLs', { urls: BLOCKED_URLS })
  // A service worker can satisfy a request without the network blocker seeing
  // it. Failure proofs bypass it; ordinary runs restore its offline behavior.
  await send('Network.setBypassServiceWorker', {
    bypass: BLOCKED_URLS.length > 0,
  })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DPR,
    mobile: false,
  })
  await send('Page.bringToFront')
  const page = { url: URL_, document: DOCUMENT, note, sleep, now: Date.now }
  if (values['keep-storage'] !== true) await clearStorage(send, page)
  await boot(
    send,
    {
      force:
        values.fresh === true ||
        (prior.javascript ?? true) !== JAVASCRIPT ||
        JSON.stringify(prior.blockedUrls ?? []) !==
          JSON.stringify(BLOCKED_URLS),
    },
    page,
  )
  // Record the controls only once this navigation succeeds. A failed boot
  // must not make the next warm attach trust a page from a different mode.
  await writeState({ javascript: JAVASCRIPT, blockedUrls: BLOCKED_URLS })

  const run = (expression, userGesture) =>
    evaluate(send, expression, userGesture)
  const results = await runSteps(script, {
    evaluate: run,
    userGesture: values['user-gesture'] === true,
    sleep,
    now: () => performance.now(),
    read: (file) => readFile(file, 'utf8'),
    capture: (target) => capture(send, target),
    cast: (n) => cast(wire, n),
    trace: (ms) => trace(wire, ms),
    sample: (n) => sampleFrames(run, n, String(values['sample-js'])),
    logs: () => drainLogs(events),
    reboot: () => boot(send, { force: true }, page),
    say,
    warn: (line) => process.stderr.write(`${line}\n`),
  })

  // Page errors are reported whether or not they were asked for. A driver that
  // swallows an uncaught exception makes a broken page look like a blank shot.
  const trailing = drainLogs(events).filter((l) => /^(error|exception)/.test(l))
  for (const line of trailing) process.stderr.write(`${line}\n`)

  if (values.json === true) process.stdout.write(jsonReport(results, trailing))
  ws.close()
}

await main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
