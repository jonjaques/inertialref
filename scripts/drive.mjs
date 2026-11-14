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
 *  - A real window, not `--headless`, and neither the adapter nor the cast is
 *    the reason. Chrome 157 in new headless, as Playwright launches it, keeps
 *    `apple` / `metal-3` with `timestamp-query`, screencasts 179–180 frames in
 *    3 s, and photographs the two lit plates probed identically to headed
 *    (AE 0); the browser that falls back to SwiftShader is Playwright's
 *    default headless shell.
 *    This file has never launched headless, so those are that browser's
 *    figures and not this file's. The window holds for three things. Pacing:
 *    headless rAF is a fixed 60 Hz clock — a DPR change that raised `ir.gpu`
 *    6.5% moved rAF p95 by 0.00 ms — while a headed page follows its window,
 *    about 60 Hz on the MacBook Air and about 100 irregular frames a second
 *    for this one, off the desktop at x=2400, on the Mac mini's 120 Hz panel.
 *    The extended-range path, which needs a display's color profile:
 *    `(dynamic-range: high)` matches under one and not under forced sRGB. And
 *    the guide's voice, whose level clock needs an audio pipeline that an
 *    off-screen window does not have, so a listening session moves the window
 *    on screen. For a shader question that needs no compositor at all,
 *    one `*.gpu.test.ts` named on the command line answers in a second or two
 *    without this file; the whole `pnpm test:gpu` suite is eighteen, nearly all
 *    of it the terrain kernel.
 *
 * The expensive thing here is boot — about five seconds of shader warm and body
 * build, on top of the dev server's own start. So Chrome is left running
 * between invocations, and it holds the machine's GPU lock from before it
 * launches until `--down` has closed it (`driveLock.mjs`): a detached Chrome
 * is a GPU job whether or not an invocation is driving it, and two GPU jobs at
 * once have crashed macOS. Each call starts with clean local storage and cookies;
 * --keep-storage opts into attaching to the booted page instead of reloading
 * it: measured on the Mac mini, 6 s cold against about 0.2 s warm, the launch
 * guard's read and its two frames included. Most of that cold figure
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
 *
 * None runs until the page is held to its operating point (`enter` in
 * `drivePage.mjs`, over `driveLaunch.mjs`'s guard), because the wrong point
 * boots and answers like the right one. The presentation watchdog's remount
 * rebuilds the canvas at 3200×1800 for a rig asking for 1600×900 at DPR 1, and
 * every terrain figure taken over it is a retina figure under the default
 * window's label.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { analyzeFrames, differenceMap, reportFrames } from './frameDiff.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { driveUrl } from './driveUrl.mjs'
import { castFrames, connect, drainLogs, evaluate, traceFor } from './cdp.mjs'
import {
  RIG,
  adopt,
  closeChrome,
  driver,
  drivers,
  gpuLine,
  launched,
  readSession,
  sessionPath,
  takeGpu,
} from './driveLock.mjs'
import {
  browserVersion,
  clearStorage,
  enter,
  enterSession,
  statusPoint,
} from './drivePage.mjs'
import { parseWait } from './gpuLock.mjs'
import {
  checkSteps,
  jsonReport,
  planSteps,
  runSteps,
  sampleFrames,
} from './driveSteps.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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
  /** Chrome's output color space, `--force-color-profile`. Unset is the
   *  attached display's profile, which is why two machines' plates of one
   *  build differ by a cast; `srgb` makes a plate the build's alone. */
  'color-profile': { type: 'string' },
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
  /** The checkout `--url` must be served from, when it is not this driver's. */
  tree: { type: 'string' },
  /** Seconds to queue for the GPU lock; not `--wait`, the page delay in ms. */
  'gpu-wait': { type: 'string' },
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
                     stopped arriving, and under ?clouds=1 the clouds' caches
                     and their history's 32 frames, for at most <ms>; reports
                     what was still pending if it ran out. What a plate waits
                     for. A forced cloud path never settles
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
  --color-profile <name>
                     Chrome's output color profile (srgb, display-p3-d65, …);
                     default is the attached display's. Applies at launch, so
                     a Chrome already up under another profile is refused
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
  --tree <path>      the checkout --url must be served from; default this
                     driver's own. After every boot and attach the page's
                     ir.build() is held against it, and a page another
                     checkout serves runs no step. A production build names
                     no tree, and is unchecked
  --gpu-wait <s>     queue up to <s> seconds for the machine's GPU lock instead
                     of failing at once while another job holds it. Seconds,
                     unlike --wait
  --max-px <n>       longest edge of a written shot, default 1568; 0 for native
  --quality <n>      JPEG quality, default 88
  --json             one JSON object of every step result, instead of lines
  --quiet            step results only — no progress narration

Lifecycle:

  --status           what this rig has running, who holds the GPU, and the
                     attached page's operating point, read again by the guard
                     a boot runs; non-zero when the guard refuses it. A page
                     another invocation is driving is not read or touched
  --print-url        print the resolved URL without starting Chrome or a server
  --down             close the Chrome and the dev server this rig started, and
                     release the GPU lock its Chrome held; never refused

Chrome stays up between invocations, and holds the machine's GPU lock until
--down: one GPU job runs at a time, so pnpm test:gpu and every other rig wait
for it. A later call on the same --port joins that lock. Each call clears local
storage and cookies and reboots the page unless --keep-storage is given. --down
when finished.

Every boot, attach and --reload holds the page to its operating point before a
step runs: a WebGPU renderer on a hardware adapter, the --width, --height and
--dpr reported back by the page, a drawing buffer of that window × min(DPR, the
pointer's ceiling) × the picture's supersampling, and the --tree checkout
serving it. --document and --no-javascript ask for no renderer and hold the
window and the served tree alone. A page that is not at its point ends the
invocation, non-zero, with the reason. Chrome's version is recorded and
a change warned about, never refused. The record is a line of narration, the
operatingPoint field of --json, and in full in --status.

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
 * (`showing` in `drivePage.mjs`) compares asked-for keys only, so it does not
 * disturb the match.
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
const COLOR_PROFILE = values['color-profile'] ?? null
const MAX_PX = Number(values['max-px'])
const QUALITY = Number(values.quality)
const SERVE = values.serve === true
const JAVASCRIPT = values.javascript === true
const DOCUMENT = values.document === true || !JAVASCRIPT
const BLOCKED_URLS = values['block-url'] ?? []
const STATE = sessionPath(PORT)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The checkout the page must be served from: `--tree`, or this driver's own.
 *
 * A server answering `--url` is not evidence of a tree. A sibling worktree's
 * Vite on 5173 boots the same app under the same build id, and is driven,
 * photographed and measured as this one. git's root rather than `ROOT`, so
 * the default is spelled the way the dev server spells the tree it reports;
 * the comparison resolves symlinks either way. An empty `--tree` is refused
 * rather than resolved: `path.resolve('')` is the shell's directory, which
 * from a sibling checkout is a false match.
 */
function treeUnderTest() {
  if (values.tree === '')
    throw new Error(
      "--tree takes the checkout --url must be served from, and '' names none; leave it out to hold the page against this checkout",
    )
  if (values.tree !== undefined) return path.resolve(values.tree)
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ROOT
  }
}

/**
 * Two channels, because they answer to different flags. `say` is what a step
 * returned and is the reason the command was run; `note` is the rig narrating
 * itself, which `--quiet` exists to silence. One writer for both would make
 * `--quiet` swallow the answer as well as the narration.
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

const readState = () => readSession(PORT)

/** A patch, merged over what is already recorded rather than replacing it, so
 *  a pid written the moment its process was spawned survives the fuller write
 *  at the end of start-up. A function is given the record as it is read here,
 *  for a field another invocation may have changed since this one read it. */
async function writeState(patch) {
  await mkdir(RIG, { recursive: true })
  const prior = (await readState()) ?? {}
  const next = typeof patch === 'function' ? patch(prior) : patch
  await writeFile(STATE, `${JSON.stringify({ ...prior, ...next }, null, 2)}\n`)
}

/**
 * This invocation off the session's list of drivers, as it exits. Synchronous,
 * because it runs on `exit`, where nothing asynchronous finishes, and that is
 * the one place every way out of `main` passes, `process.exit` included. A
 * session `--down` has removed is left removed.
 */
function leave() {
  let state
  try {
    state = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return
  }
  const left = drivers(state).filter(({ pid }) => pid !== process.pid)
  writeFileSync(
    STATE,
    `${JSON.stringify({ ...state, drivers: left }, null, 2)}\n`,
  )
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
    // No Astro dev toolbar: it is a strip of chrome over the bottom of every
    // dev page that `chrome=0` cannot clear, so a local plate carried it and a
    // production plate never did. A dev server this rig did not start keeps
    // whatever its owner chose.
    env: { ...process.env, ASTRO_DEV_TOOLBAR: '0' },
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

/** The rig's Chrome, attached to (`adopt`) or launched (`launched`), and held
 *  under the invocation's GPU lock either way. */
async function launchChrome(state, gpu) {
  const up = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(
    () => null,
  )
  if (up?.ok) {
    // The profile is a launch flag: attaching to a Chrome started under
    // another one would take a plate in a color space nobody asked for and
    // record the one that was asked for beside it.
    const running = state.colorProfile ?? null
    if (running !== COLOR_PROFILE) {
      // A rig with no record of the flag is one an older driver launched, and
      // that driver never forced a profile: the display's, said so.
      const recorded =
        state.colorProfile === undefined
          ? ' (none recorded, so the display)'
          : ''
      throw new Error(
        `Chrome on port ${PORT} runs color profile ${running ?? 'display'}${recorded}, not ${COLOR_PROFILE ?? 'display'}; ` +
          `node scripts/drive.mjs --port ${PORT} --down first`,
      )
    }
    const adopted = adopt(gpu, state)
    if (adopted.chromePid === null)
      process.stderr.write(
        `Chrome on port ${PORT} has no recorded pid, so the GPU lock holds for it only while this invocation runs\n`,
      )
    await writeState(adopted)
    return adopted.chromePid
  }
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
      ...(COLOR_PROFILE === null
        ? []
        : [`--force-color-profile=${COLOR_PROFILE}`]),
      // A proof with scripts disabled or requests blocked must not execute
      // the requested page before the DevTools controls reach this target.
      DOCUMENT || BLOCKED_URLS.length > 0 ? 'about:blank' : URL_,
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  // Same reason as the dev server above: a Chrome that never opens its
  // debugging port is still a Chrome, and `--down` can only kill what it knows.
  // The lock records it first, because a Chrome the lock does not name renders
  // unlocked from the moment this invocation exits.
  await writeState({
    ...launched(gpu, child.pid),
    colorProfile: COLOR_PROFILE,
  })
  for (let i = 0; i < 80; i += 1) {
    await sleep(500)
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(
      () => null,
    )
    if (r?.ok) return child.pid ?? null
  }
  throw new Error('Chrome did not open a debugging port')
}

async function pageTarget(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page =
      list.find((t) => t.type === 'page' && String(t.url).startsWith('http')) ??
      list.find((t) => t.type === 'page' && t.url === 'about:blank')
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    if (i + 1 < tries) await sleep(500)
  }
  throw new Error(`no page target on port ${PORT}`)
}

/** The page target's socket, once open. An Error rather than the socket's
 *  error event, whose message prints as `[object Event]`. */
async function socket(target) {
  const ws = new WebSocket(target)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener(
      'error',
      () => reject(new Error(`the page's socket on port ${PORT} did not open`)),
      { once: true },
    )
  })
  return ws
}

/** What `/json/version` says this port's Chrome is, or null with none up. */
const chromeOnPort = () =>
  fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

const warn = (line) => process.stderr.write(`${line}\n`)

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
 * video is the argument. Written at the rate the frames were captured at, to
 * the millihertz, so the recurrence plays back at the rate it happens: a
 * whole-number rate plays a 42.6 Hz capture 1% fast. Absent ffmpeg this is
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
        (fps > 1 ? fps : 60).toFixed(3),
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
  try {
    // Never refused by the lock: this takes nothing, it only drops the
    // Chrome it closes, once that Chrome has exited.
    const pid = state.chromePid
    const { closed, released, reused } = await closeChrome(pid, {
      token: state.gpuToken,
      start: state.chromeStart,
    })
    if (closed) say(`closed Chrome (pid ${pid})`)
    else if (reused)
      say(
        `pid ${pid} did not start when this rig's Chrome did, so it is another process; left running`,
      )
    else if (alive(pid))
      say(
        `Chrome (pid ${pid}) is still running` +
          (state.gpuToken === undefined
            ? ''
            : ', and the GPU lock holds for it until it exits') +
          (typeof state.chromeStart === 'string'
            ? ''
            : '. No start time was recorded to prove the pid is still that Chrome, so it got SIGTERM and no SIGKILL'),
      )
    if (released) say('released its hold on the GPU lock')
  } finally {
    if (state.startedServer === true && alive(state.serverPid)) {
      // `dev.mjs` is a group leader (`detached`, in serve()) that starts vite
      // and `cf dev` in groups of their own, so the signal reaches them
      // through its SIGTERM handler, which relays to both. The fallback is for
      // a recorded pid that leads no group.
      try {
        process.kill(-state.serverPid, 'SIGTERM')
      } catch {
        process.kill(state.serverPid, 'SIGTERM')
      }
      say(`stopped pnpm dev (pid ${state.serverPid})`)
    }
    await rm(STATE, { force: true })
  }
}

/**
 * The attached page's operating point, read fresh by the same guard a boot
 * runs, without navigating or booting (`statusPoint` in `drivePage.mjs`). It
 * holds the page to the tree the session recorded, unless `--tree` names
 * another.
 */
async function pointOnPort(state, browser) {
  if (browser === null)
    return { lines: [`not read: no Chrome listens on port ${PORT}`] }
  const open = async () => {
    const target = await pageTarget(1).catch(() => {
      throw new Error('Chrome has no page open')
    })
    const ws = await socket(target)
    return { send: connect(ws).send, close: () => ws.close() }
  }
  return await statusPoint(open, {
    state,
    fallback: { width: WIDTH, height: HEIGHT, dpr: DPR },
    tree:
      values.tree === undefined && typeof state.tree === 'string'
        ? state.tree
        : treeUnderTest(),
    browser,
    warn,
    driving: drivers(state),
  })
}

async function status() {
  const state = (await readState()) ?? {}
  const version = await chromeOnPort()
  const browser = version === null ? null : browserVersion(version.Browser)
  const recorded =
    browser !== null &&
    typeof state.browser === 'string' &&
    state.browser !== browser
      ? ` (the session recorded ${state.browser})`
      : ''
  // The rig's lines before the page's, which is the one read that can wait:
  // a page that does not answer still leaves who holds the GPU on screen.
  console.log(
    [
      `port      ${PORT}`,
      `url       ${URL_} ${(await answers(URL_)) ? '(answering)' : '(down)'}`,
      `chrome    ${version !== null ? `listening, pid ${state.chromePid ?? '?'}` : 'not running'}`,
      `browser   ${browser ?? 'not running'}${recorded}`,
      `profile   ${state.colorProfile ?? 'display'}`,
      `dev       ${
        state.startedServer === true
          ? `started by this rig, pid ${state.serverPid ?? '?'}`
          : 'not started by this rig'
      }`,
      `gpu       ${gpuLine(state).replaceAll('\n', '\n          ')}`,
    ].join('\n'),
  )
  const point = await pointOnPort(state, browser)
  console.log(`point     ${point.lines.join('\n          ')}`)
  // A refusal is non-zero wherever the guard runs, so a script can ask
  // --status whether the rig is still at its operating point.
  if (point.refused === true) process.exitCode = 1
}

/**
 * A cast's frames as `0000.jpg` onward, and beside them `timestamps.json`:
 * each frame's screencast instant, seconds since the epoch as Chrome stamps
 * it, in file order. Without it a gap in the stream is invisible in the
 * frames, which are numbered as they arrived; with it a frame finds the
 * page's own log entry, whose instants are the same epoch in milliseconds
 * (`scripts/castSteps.mjs`).
 */
export async function writeCastFrames(dir, frames) {
  await mkdir(dir, { recursive: true })
  const paths = []
  for (const [i, frame] of frames.entries()) {
    const file = path.join(dir, `${String(i).padStart(4, '0')}.jpg`)
    await writeFile(file, Buffer.from(frame.data, 'base64'))
    paths.push(file)
  }
  await writeFile(
    path.join(dir, 'timestamps.json'),
    `${JSON.stringify(frames.map((frame) => frame.at))}\n`,
  )
  return paths
}

/** A cast written to `.data/drive/cast/`, differenced, and clipped, as the
 *  step's result and the lines it says. */
async function cast(wire, n) {
  const dir = path.join(RIG, 'cast')
  await rm(dir, { recursive: true, force: true })
  const frames = await castFrames(wire, n, { maxPx: CAST_PX })
  const paths = await writeCastFrames(dir, frames)
  const at = frames.map((f) => f.at)
  const span = at.length > 1 ? at[at.length - 1] - at[0] : 0
  // Intervals over the span, as `traceFrames.mjs` counts them: n frames
  // bound n − 1 intervals, and counting frames overstates a short cast.
  const fps = span > 0 ? (at.length - 1) / span : 0
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
    result: { dir: path.relative(ROOT, dir), ...analysis, fps, map, clip },
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
  const gpuWait = parseWait(values['gpu-wait'], '--gpu-wait')
  // Before the lock, so a `--tree` that names nothing is refused before it
  // has started a server, a Chrome or a boot.
  const tree = treeUnderTest()
  checkSteps(script, {
    userGesture: values['user-gesture'] === true,
    javascript: JAVASCRIPT,
  })

  const prior = (await readState()) ?? {}
  // The lock before anything it guards, so a refusal starts no dev server and
  // no Chrome. A later call on this port joins under the session's token.
  const gpu = await takeGpu(`drive.mjs (port ${PORT})`, {
    state: prior,
    waitMs: gpuWait,
    hint: '--gpu-wait <seconds> queues for it.',
  })
  const wasServing = await answers(URL_)
  const serverPid = await serve(prior)
  const chromePid = await launchChrome(prior, gpu)
  // Listed as driving the page from before its socket opens until this
  // process exits, so a `--status` beside it reads the page without touching
  // it (`statusPoint`). Same-port invocations are admitted by design, so the
  // list keeps whoever else is on it.
  await writeState((now) => ({
    port: PORT,
    url: URL_,
    chromePid,
    serverPid,
    startedServer: prior.startedServer === true || !wasServing,
    gpuToken: gpu.token,
    drivers: [
      ...drivers(now).filter(({ pid }) => pid !== process.pid),
      driver(),
    ],
  }))
  process.once('exit', leave)

  // Held against the version the session recorded, as a warning and never a
  // refusal: Chrome stable updates itself, and a figure from one version does
  // not compare with a figure from another.
  const browser = browserVersion((await chromeOnPort())?.Browser)
  const hold = {
    // A document is the DOM, with no renderer asked for.
    kind: DOCUMENT ? 'shell' : 'webgpu',
    tree,
    // What `setDeviceMetricsOverride` below asks for, which the page must
    // report back: a page whose emulation another session cleared draws a
    // buffer that agrees with the window it was left at.
    metrics: { width: WIDTH, height: HEIGHT, dpr: DPR },
    browser,
    recorded: typeof prior.browser === 'string' ? prior.browser : null,
    warn,
  }

  const ws = await socket(await pageTarget())
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
  // The boot or the attach, then the guard, before the first step: a page at
  // another operating point, or served from another checkout, is refused
  // before anything is read from it. The session records the controls with
  // the point only once it passes, so a failed boot cannot make the next warm
  // attach trust a page from a different mode.
  const point = await enterSession(
    send,
    {
      force:
        values.fresh === true ||
        (prior.javascript ?? true) !== JAVASCRIPT ||
        JSON.stringify(prior.blockedUrls ?? []) !==
          JSON.stringify(BLOCKED_URLS),
    },
    page,
    hold,
    {
      controls: { javascript: JAVASCRIPT, blockedUrls: BLOCKED_URLS },
      write: writeState,
    },
  )

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
    // The version this invocation read is the one a reload holds against,
    // so a change is warned about once.
    reboot: () =>
      enter(send, { force: true }, page, { ...hold, recorded: browser }),
    say,
    warn,
  })

  // Page errors are reported whether or not they were asked for. A driver that
  // swallows an uncaught exception makes a broken page look like a blank shot.
  const trailing = drainLogs(events).filter((l) => /^(error|exception)/.test(l))
  for (const line of trailing) process.stderr.write(`${line}\n`)

  if (values.json === true)
    process.stdout.write(jsonReport(results, trailing, point))
  ws.close()
}

// Run as a command; imported, as its test imports the cast's writer, it
// launches nothing.
if (import.meta.main)
  await main().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
