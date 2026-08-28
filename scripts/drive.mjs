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
 *  - Readiness is `window.engine.gl`. `window.ir` is the harness and appears
 *    seconds earlier; a probe on it screenshots an unlit canvas.
 *  - A real window, not `--headless`. Headless macOS Chrome falls back to a
 *    software WebGPU adapter, and a software adapter is not the thing under test.
 *
 * The expensive thing here is boot — about eleven seconds of shader warm and
 * body build, on top of the dev server's own start. So Chrome is left running
 * between invocations and a second call attaches to the booted page instead of
 * reloading it: measured, 17 s cold against 70 ms warm. That is what makes a
 * batch of steps worth writing on one command line:
 *
 *     node scripts/drive.mjs --js "ir.look('g:milky-way/s:SOL/b:2')" \
 *                            --wait 2000 --shot earth.jpg
 *     node scripts/drive.mjs --js "ir.terrain()"        # 70 ms, page still hot
 *     node scripts/drive.mjs --down                     # when finished
 *
 * Steps run in the order they are written, so one process does a whole
 * verification. `--help` lists them.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Where shots land when the path has no directory in it, and where the rig
 *  records what it started. `.data/` is git-ignored; nothing here is source. */
const RIG = path.join(ROOT, '.data/drive')

const OPTIONS = {
  /* Session — these describe the browser, not a step. */
  url: { type: 'string', default: 'http://localhost:5173/' },
  /** Keys the Chrome profile directory as well as the debugging port, so two
   *  agents on different ports cannot fight over one profile. */
  port: { type: 'string', default: '9333' },
  width: { type: 'string', default: '1600' },
  height: { type: 'string', default: '900' },
  dpr: { type: 'string', default: '1' },
  /** Reload and re-boot even when the attached page is already rendering. */
  fresh: { type: 'boolean', default: false },
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
  help: { type: 'boolean', default: false },

  /* Steps, in the order written. */
  js: { type: 'string', multiple: true },
  file: { type: 'string', multiple: true },
  wait: { type: 'string', multiple: true },
  shot: { type: 'string', multiple: true },
  sample: { type: 'string', multiple: true },
  'sample-js': { type: 'string', default: 'ir.terrain()' },
  logs: { type: 'boolean', multiple: true },
  reload: { type: 'boolean', multiple: true },

  /* Output. */
  quiet: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
}

const STEPS = new Set([
  'js',
  'file',
  'wait',
  'shot',
  'sample',
  'logs',
  'reload',
])

const HELP = `pnpm drive — drive InertialRef in Chrome over the DevTools Protocol

  node scripts/drive.mjs [session flags] [steps...]

Steps run in the order they are written, in one browser session:

  --js <expr>        evaluate in the page. A bare expression is returned, so
                     --js "ir.terrain()" prints the report. Write an explicit
                     \`return\` for a multi-statement body; \`await\` works.
  --file <path>      evaluate a local .js/.mjs file in the page, for anything
                     too long or too quote-heavy for a shell argument
  --wait <ms>        settle. Textures stream in asynchronously after a seek
  --shot <path>      screenshot. A bare filename lands in .data/drive/;
                     a .jpg extension captures JPEG, which is what to read
  --sample <n>       n consecutive rAF frames of --sample-js, with a per-field
                     min..max summary. A still cannot show a strobe
  --logs             console output and page errors buffered so far
  --reload           hard reload, then wait for the renderer

Session flags:

  --url <url>        default http://localhost:5173/
  --port <n>         default 9333; also keys the Chrome profile, so parallel
                     agents must differ
  --width/--height   viewport, default 1600x900
  --dpr <n>          device scale factor, default 1
  --fresh            re-boot even if the attached page is already rendering
  --no-serve         fail instead of starting \`pnpm dev\` when nothing answers
  --max-px <n>       longest edge of a written shot, default 1568; 0 for native
  --quality <n>      JPEG quality, default 88
  --json             one JSON object of every step result, instead of lines
  --quiet            step results only — no progress narration

Lifecycle:

  --status           what this rig has running
  --down             close the Chrome and the dev server this rig started

Chrome stays up between invocations and the next call attaches to the booted
page: 17 s cold, 70 ms warm. --down when you are finished.`

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
const URL_ = String(values.url)
const WIDTH = Number(values.width)
const HEIGHT = Number(values.height)
const DPR = Number(values.dpr)
const MAX_PX = Number(values['max-px'])
const QUALITY = Number(values.quality)
const SERVE = values.serve === true
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

/*
 * `parseArgs` returns values as a map, which loses the interleaving — and the
 * interleaving is the whole point of a step list. `tokens: true` gives them
 * back in source order.
 *
 * The `--no-` filter is not defensive tidying. `allowNegative` is on for
 * `--no-serve`, but it applies to every boolean in `OPTIONS`, and two of the
 * steps are booleans: `--no-reload` parses to a token named `reload` and would
 * otherwise re-boot the page — the negation running the very step it denies.
 */
const script = tokens
  .filter(
    (t) =>
      t.kind === 'option' &&
      STEPS.has(t.name) &&
      !String(t.rawName).startsWith('--no-'),
  )
  .map((t) => ({ step: t.name, arg: t.value }))

/** A step argument that has to be a number. `Number('soon')` is `NaN`, and a
 *  `NaN` reaches `setTimeout` as 0 — a `--wait` that silently does not wait. */
const count = (arg, flag, least) => {
  const n = Number(arg)
  if (!Number.isFinite(n) || n < least)
    throw new Error(`--${flag} wants a number ≥ ${least}, not ${String(arg)}`)
  return n
}

/** Every numeric step argument, checked before the dev server, Chrome and an
 *  eleven-second boot: a typo'd `--wait` should cost a line of output, not the
 *  whole start-up it sits behind. */
function checkScript() {
  for (const { step, arg } of script) {
    if (step === 'wait') count(arg, 'wait', 0)
    if (step === 'sample') count(arg, 'sample', 1)
  }
}

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
  // purpose, and `--down` kills the group so wrangler goes with vite.
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
      URL_,
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
    const page = list.find(
      (t) => t.type === 'page' && String(t.url).startsWith('http'),
    )
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    await sleep(500)
  }
  throw new Error(`no page target on port ${PORT}`)
}

/* ------------------------------------------------------------------ cdp ---- */

function connect(ws) {
  let next = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === undefined) {
      events.push(msg)
      return
    }
    const entry = pending.get(msg.id)
    if (entry === undefined) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
    else entry.resolve(msg.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++
      // Cleared on the reply, and `unref`d besides. A two-minute timer left
      // armed on every command holds the event loop open, so an invocation
      // that finished its work in one second still took two minutes to exit —
      // which reads as a hung driver and is a forgotten timer.
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 120_000)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  // A socket that goes away takes every command in flight with it, and those
  // timers are `unref`d — so without this the process drains its event loop
  // and exits 0 having answered nothing, which reads as a passing run against
  // a Chrome that crashed. `pending` is empty by the time `main` closes the
  // socket itself, so the ordinary shutdown lands here as a no-op.
  const abandon = (why) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(new Error(why))
    }
  }
  ws.addEventListener('close', () => abandon('the CDP socket closed'))
  ws.addEventListener('error', () => abandon('the CDP socket errored'))
  return { send, events }
}

/**
 * A bare expression is the common case and writing `return` around it on every
 * command line is noise, so one is added when the text has no statement in it.
 * The async wrapper is what makes `await ir.selfTest()` work from the shell.
 */
function body(expression) {
  const bare = !/\breturn\b|;|\n/.test(expression)
  return bare ? `return (${expression})` : expression
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${body(expression)} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        JSON.stringify(result.exceptionDetails),
    )
  }
  return result.result.value
}

const READY = 'return Boolean(window.ir && window.engine && window.engine.gl)'

async function boot(send, { force }) {
  const ready = await evaluate(send, READY).catch(() => false)
  // The mode is a function of the path, so a booted page on `/` is not a
  // booted page on `/planetarium` — attaching to it regardless produced a
  // screenshot of the home poster captioned as the planetarium. The query is
  // half of that contract and carries the same weight: `?at=` is the body the
  // planetarium opens on, `?t=` the cutscene frame, `?seed=` the universe.
  //
  // Asked-for keys only, never the whole search string. The app writes those
  // same keys back as it plays — `CinemaPlayer` replaces `t` on every frame,
  // `PlanetariumMode` replaces `at` on every target — so an exact comparison
  // would miss on a page that is already showing exactly what was asked for,
  // and turn every warm attach into an eleven-second re-boot.
  const wanted = new URL(URL_)
  const here = await evaluate(
    send,
    'return location.pathname + location.search',
  ).catch(() => '')
  const at = new URL(here, wanted.origin)
  const showing =
    at.pathname === wanted.pathname &&
    [...wanted.searchParams].every(
      ([key, value]) => at.searchParams.get(key) === value,
    )
  if (ready && !force && showing) {
    note('attached to a booted page')
    return
  }
  // Always a full navigate, never HMR: a WebGPURenderer does not survive a
  // dozen hot reloads, and a tab that has had them draws its HUD with
  // `engine.gl` null — which reads as a rendering bug and is not one.
  await send('Page.navigate', { url: URL_ })
  const started = Date.now()
  for (let i = 0; ; i += 1) {
    await sleep(500)
    if (await evaluate(send, READY).catch(() => false)) break
    if (i === 200) throw new Error('renderer never became ready')
  }
  // The boot cover lifts on the presentation watchdog, which needs a frame
  // after `engine.gl` appears. Poll for its removal rather than sleeping a
  // guessed interval, and give up rather than block: the scene underneath is
  // already rendering, so a stuck cover is a HUD question, not a render one.
  for (let i = 0; i < 24; i += 1) {
    const covered = await evaluate(
      send,
      "return document.querySelector('.hud-bleed.z-50.bg-black') !== null",
    ).catch(() => false)
    if (!covered) break
    await sleep(500)
  }
  note(`renderer ready in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

/* ---------------------------------------------------------------- steps ---- */

async function capture(send, target) {
  const out = target.includes('/') ? target : path.join(RIG, target)
  const jpeg = /\.jpe?g$/i.test(out)
  const format = jpeg ? { format: 'jpeg', quality: QUALITY } : { format: 'png' }
  // Twice, with a pause. The first capture is what activates the page and
  // draws the frame; taken alone it shows whatever was on screen before the
  // step that preceded it. The second one is the evidence.
  await send('Page.captureScreenshot', format)
  await sleep(700)
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

async function sampleFrames(send, count, expression) {
  // One reading per rAF from inside the page. A `--js` call per frame would be
  // a round trip per frame, and the round trip is longer than the frame.
  const samples = await evaluate(
    send,
    `const out = []
     await new Promise((done) => {
       const tick = () => {
         out.push(${expression})
         if (out.length < ${count}) requestAnimationFrame(tick)
         else done()
       }
       requestAnimationFrame(tick)
     })
     return out`,
  )
  const numeric = {}
  for (const s of samples)
    if (s !== null && typeof s === 'object')
      for (const [k, v] of Object.entries(s))
        if (typeof v === 'number' || typeof v === 'boolean')
          (numeric[k] ??= []).push(Number(v))
  const spans = Object.fromEntries(
    Object.entries(numeric).map(([k, v]) => [
      k,
      `${Math.min(...v)}..${Math.max(...v)}`,
    ]),
  )
  return { frames: samples.length, spans, samples }
}

function drainLogs(events) {
  const lines = []
  for (const event of events.splice(0)) {
    if (event.method === 'Runtime.consoleAPICalled') {
      const text = event.params.args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
      lines.push(`${event.params.type}: ${text}`)
    } else if (event.method === 'Runtime.exceptionThrown') {
      lines.push(
        `exception: ${
          event.params.exceptionDetails.exception?.description ??
          event.params.exceptionDetails.text
        }`,
      )
    }
  }
  return lines
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
    // The negative pid is the process group: `scripts/dev.mjs` has two
    // children, and killing only the parent leaves wrangler holding 8787.
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

async function main() {
  if (values.down === true) return await down()
  if (values.status === true) return await status()
  checkScript()

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
  const { send, events } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: DPR,
    mobile: false,
  })
  await send('Page.bringToFront')
  await boot(send, { force: values.fresh === true })

  const results = []
  for (const { step, arg } of script) {
    switch (step) {
      case 'js':
      case 'file': {
        const expression =
          step === 'file' ? await readFile(arg, 'utf8') : String(arg)
        const value = await evaluate(send, expression)
        results.push({ step, value })
        say(`js: ${JSON.stringify(value ?? null)}`)
        break
      }
      case 'wait': {
        const ms = count(arg, 'wait', 0)
        await sleep(ms)
        results.push({ step, ms })
        break
      }
      case 'reload': {
        await boot(send, { force: true })
        results.push({ step })
        break
      }
      case 'shot': {
        const shot = await capture(send, String(arg))
        results.push({ step, ...shot })
        say(`shot: ${shot.path} (${(shot.bytes / 1024).toFixed(0)} KB)`)
        break
      }
      case 'sample': {
        const out = await sampleFrames(
          send,
          count(arg, 'sample', 1),
          String(values['sample-js']),
        )
        results.push({ step, ...out })
        say(
          `sample: ${out.frames} frames — ` +
            Object.entries(out.spans)
              .map(([k, v]) => `${k} ${v}`)
              .join(' | '),
        )
        break
      }
      case 'logs': {
        const lines = drainLogs(events)
        results.push({ step, lines })
        for (const line of lines) say(`  ${line}`)
        break
      }
    }
  }

  // Page errors are reported whether or not they were asked for. A driver that
  // swallows an uncaught exception makes a broken page look like a blank shot.
  const trailing = drainLogs(events).filter((l) => /^(error|exception)/.test(l))
  for (const line of trailing) process.stderr.write(`${line}\n`)

  if (values.json === true)
    process.stdout.write(
      `${JSON.stringify({ results, errors: trailing }, null, 2)}\n`,
    )
  ws.close()
}

await main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
