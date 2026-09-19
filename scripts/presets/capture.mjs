/*
 * Photograph the pictures through the renderer, into a directory.
 *
 * The one capture recipe, shared by `plates.mjs` — which writes the committed
 * thumbnails — and `compare.mjs`, which writes two sets and differences them.
 * Two scripts with their own copies would drift in the one way that matters
 * here: a compare taken with the chrome on, or at a different exposure, would
 * report every plate as moved.
 *
 * A plate is one navigation. The driver's `--preset` expands a picture into
 * the public URL the share button writes — address, framing, lens, held
 * instant — and three query fields carry the rest of the state a plate is
 * defined in: `chrome=0` for no interface, `layers=0` for no names or traces,
 * `output=standard` for SDR, because a plate is a committed file every
 * display has to agree about. Nothing is evaluated in the page to set it up;
 * the page opens in the state and `--settle` waits until the sky's cubes and
 * the ground's patches have stopped arriving, which is what a fixed pause
 * can only guess at. The one `--js` reads back what the renderer says it did,
 * so a plate taken in the wrong mode is an error and not a quiet drift.
 *
 * The rig is `scripts/drive.mjs`, which launches its own Chrome on its own
 * profile and port — see `.claude/rules/browser.md` for why it is never the
 * extension. Each tree a plate is taken from is served here, on a port the
 * caller chose, and never whatever answers on 5173: that port is any
 * project's dev server, and a driver pointed at another repository's Vite
 * waits its whole boot budget for a renderer that never appears.
 */
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PLATE_HEIGHT,
  PLATE_WIDTH,
} from '../../packages/devtools/src/pictures.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DRIVE = path.join(ROOT, 'scripts/drive.mjs')

/**
 * How long a picture may take to converge, and the quiet after it does.
 *
 * The budget is a guard, not a target: a Sol body with its maps warm settles
 * in a few seconds and a generated shore at the far end of the streamer's
 * ring takes longer. The quiet after is for what no readout reports — a
 * texture decoding on the main thread, the last mip arriving — and it is
 * short because `--settle` already waited for everything that does.
 */
export const SETTLE_BUDGET = 30_000
export const SETTLE_QUIET = 1_000

const listening = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Astro on its own port, serving the given checkout.
 *
 * `astro dev` straight from the package rather than `pnpm dev`, which also
 * starts wrangler and needs a `dist/` a fresh worktree does not have. The
 * environment variable is what the package's own `dev` script sets: Astro
 * daemonizes itself when it detects a coding agent, and a detached server is
 * one this cannot stop. The child is its own process group, so the stop
 * reaches the Astro that pnpm spawns as well as pnpm. The documentation
 * manifest is staged first when it is missing, because the shell imports it
 * and a dev server in a tree that has never built stops at that import.
 *
 * @returns {Promise<() => void>} stops the server
 */
export async function serve(tree, port, log) {
  if (!existsSync(path.join(tree, 'apps/game/public/doc-content')))
    execFileSync('pnpm', ['docs:build'], { cwd: tree, stdio: 'ignore' })
  mkdirSync(path.dirname(log), { recursive: true })
  const out = openSync(log, 'w')
  const child = spawn(
    'pnpm',
    ['--filter', '@inertialref/game', 'exec', 'astro', 'dev', '--port', port],
    {
      cwd: tree,
      // No dev toolbar: it is a strip of chrome the address bar cannot clear.
      env: {
        ...process.env,
        ASTRO_DEV_BACKGROUND: '1',
        ASTRO_DEV_TOOLBAR: '0',
      },
      stdio: ['ignore', out, out],
      detached: true,
    },
  )
  const stop = () => {
    if (child.exitCode === null)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
  }
  process.on('exit', stop)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await listening(Number(port))) return stop
    if (child.exitCode !== null)
      throw new Error(
        `the server for ${tree} exited ${child.exitCode}; see ${log}`,
      )
    await sleep(500)
  }
  stop()
  throw new Error(`nothing answered on ${port} after 90 s; see ${log}`)
}

/**
 * @param {object} options
 * @param {string} options.origin      the server, e.g. http://localhost:5183
 * @param {string} options.port        the driver's CDP port; keys its Chrome profile
 * @param {string} options.out         directory the files land in
 * @param {readonly {id: string, why: string}[]} options.pictures
 * @param {'jpg' | 'png'} [options.extension]  jpg for a committed plate, png to difference
 * @param {(line: string) => void} [options.say]
 * @returns {Promise<Map<string, {file: string, settled: boolean, settleMs: number | null, light: object}>>}
 */
export async function capturePlates({
  origin,
  port,
  out,
  pictures,
  extension = 'jpg',
  say = console.log,
}) {
  /**
   * One driver invocation, its step results parsed from `--json`.
   *
   * Parsed rather than watched, because the mode the renderer reports has to
   * be checked, and the driver's narration is for a person.
   */
  const drive = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          DRIVE,
          '--port',
          port,
          '--dpr',
          '1',
          '--no-serve',
          '--url',
          origin,
          '--width',
          String(PLATE_WIDTH),
          '--height',
          String(PLATE_HEIGHT),
          '--max-px',
          '0',
          '--quiet',
          '--json',
          ...args,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'], cwd: ROOT },
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

  await mkdir(out, { recursive: true })

  /*
   * Boot the origin once before the first picture. A fresh Vite discovers the
   * page's dependencies on its first load, pre-bundles them, and reloads the
   * page on its own about four seconds later — which, under a capture, is a
   * renderer restarting between the settle and the shot. The wait covers that
   * reload; the pictures after it are served from a warm bundle.
   */
  await drive([
    '--url',
    new URL('/planetarium', origin).toString(),
    '--wait',
    '4000',
  ])

  const written = new Map()
  for (const picture of pictures) {
    say(`${picture.id} — ${picture.why}`)
    const file = path.join(out, `${picture.id}.${extension}`)
    const result = await drive([
      '--preset',
      picture.id,
      '--query',
      'chrome=0',
      '--query',
      'layers=0',
      '--query',
      'output=standard',
      '--settle',
      String(SETTLE_BUDGET),
      '--wait',
      String(SETTLE_QUIET),
      '--js',
      `({ mode: engine.gl.description.mode, chrome: engine.chrome, lens: engine.lens, time: ir.observatory.time, light: ir.light(), settled: ir.settled() })`,
      '--shot',
      file,
    ])
    const settle = result.results.find((one) => one.step === 'settle')
    const read = result.results.findLast((one) => one.step === 'js')?.value
    if (read?.mode !== 'standard')
      throw new Error(
        `${picture.id} was not taken in standard SDR; the renderer reports ${JSON.stringify(read)}`,
      )
    if (read.chrome !== false)
      throw new Error(`${picture.id} was taken with the interface up`)
    const shine =
      read.light.sun !== null
        ? `sun ${read.light.sun.toFixed(1)}°`
        : `phase ${read.light.phase?.toFixed(0)}°`
    say(
      `  ${settle?.settled ? `settled in ${settle.ms} ms` : `still arriving after ${settle?.ms} ms`}, ${shine} → ${path.relative(ROOT, file)}`,
    )
    written.set(picture.id, {
      file,
      settled: settle?.settled ?? false,
      settleMs: settle?.ms ?? null,
      light: read.light,
    })
  }
  return written
}
