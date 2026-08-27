#!/usr/bin/env node
/*
 * `pnpm dev` — the client and the Worker, in one terminal.
 *
 * The two-process split is deliberate and is explained at `server.proxy` in
 * `apps/game/vite.config.ts`: `@cloudflare/vite-plugin` would run the Worker
 * inside the Vite dev server on real workerd, and it would also take over the
 * client build — which here is Vite 8 with the Oxc transform, a Babel pass for
 * the React Compiler, and Tailwind. That build is tuned and load-bearing, and a
 * proxy is not. What was wrong was not the split; it was that it cost a second
 * terminal and a thing to remember, so `/api` came back "no server" for anyone
 * who forgot — a failure that looks exactly like a bug in the client.
 *
 * So: one command, two children, one lifetime. Nothing here changes what either
 * process does.
 *
 *     pnpm dev        vite on 5173, wrangler on 8787, /api and /ws proxied
 *     pnpm dev:client just vite — raw stdio, so its `r`/`o`/`q` keys work
 *     pnpm dev:server just wrangler
 *     pnpm preview    the built bundle served by the real Worker, on 8787
 *     node scripts/dev.mjs --ensure
 *                     the editor's Launch Browser task: reuse 5173 if it is
 *                     already up, otherwise this same two-child start. The
 *                     editor owns the lifetime either way.
 *
 * `preview` is the one that answers "as close to production as possible": the
 * same workerd, the same static asset store, the same `run_worker_first` and
 * SPA fallback, and the service worker actually registers because the build is
 * a production build. `dev` is the fast loop and is a *proxy* — the assets come
 * from Vite, so asset headers and the SPA fallback are Vite's, not
 * Cloudflare's. When a bug is about how something is *served*, reach for
 * `preview`.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENSURE = process.argv.includes('--ensure')
const CLIENT_PORT = 5173

const ESC = '\u001b'
const RESET = `${ESC}[0m`
const DIM = `${ESC}[2m`

/*
 * Prefixes, so two streams in one terminal stay legible.
 *
 * The cost of piping rather than inheriting is Vite's interactive keys — `r` to
 * restart, `o` to open, `q` to quit — which need a TTY it no longer has. That
 * is the reason `dev:client` still exists rather than being a leftover.
 */
const CHILDREN = [
  {
    label: 'client',
    colour: `${ESC}[36m`, // cyan, the accent
    argv: ['--filter', '@inertialref/game', 'run', 'dev'],
  },
  {
    label: 'server',
    colour: `${ESC}[35m`, // magenta — distinct from anything either tool prints
    argv: ['--filter', '@inertialref/server', 'run', 'dev'],
  },
]

/*
 * `--inspect` is for `pnpm sim` (port 9229). Wrangler already opens workerd's
 * inspector on 9230. A leftover `NODE_OPTIONS=--inspect` inherited into both
 * children would fight itself for 9229, and fight the headless runner too.
 */
function withoutInspect(env) {
  const current = env.NODE_OPTIONS ?? ''
  const cleaned = current.replace(/\s*--inspect(-brk)?(=\S+)?/g, '').trim()
  const next = { ...env, FORCE_COLOR: '1' }
  if (cleaned === '') delete next.NODE_OPTIONS
  else next.NODE_OPTIONS = cleaned
  return next
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

if (ENSURE && (await listening(CLIENT_PORT))) {
  // Match the Vite ready line so the editor's problem matcher unblocks,
  // then hold until it stops the task. Do not kill a server we did not start.
  console.log(`Local: http://localhost:${CLIENT_PORT}/`)
  await new Promise((resolve) => {
    const stop = () => resolve(undefined)
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
  })
  process.exit(0)
}

/** One prefixed writer per stream, holding a partial line between chunks. */
function prefixer(label, colour, stream) {
  let pending = ''
  const head = `${colour}${label.padEnd(6)}${RESET} ${DIM}|${RESET} `
  return (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    // The last element is whatever came after the final newline: either '' or
    // half a line still being written. Either way it waits for the next chunk,
    // which is what stops a progress line being split across two prefixes.
    pending = lines.pop() ?? ''
    for (const line of lines) stream.write(`${head}${line}\n`)
  }
}

const running = new Map()
let stopping = false

function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of running.values()) child.kill(signal)
}

for (const { label, colour, argv } of CHILDREN) {
  const child = spawn('pnpm', argv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: withoutInspect(process.env),
  })
  /*
   * Character mode, not Buffer mode, and it is not a formality.
   *
   * Without it each chunk is decoded in isolation by `Buffer#toString('utf8')`
   * when it is appended below — so a codepoint split across a pipe boundary
   * becomes two U+FFFD. Both children print three-byte glyphs in their opening
   * lines (Wrangler's ⛅ and its box rules, Vite's ⚡), which is exactly the
   * output most likely to straddle the first chunk. `setEncoding` installs
   * Node's `StringDecoder`, which holds an incomplete sequence until the rest
   * of it arrives. The line buffering below already does the same job one level
   * up; this is the same idea at codepoint granularity.
   */
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', prefixer(label, colour, process.stdout))
  child.stderr.on('data', prefixer(label, colour, process.stderr))
  child.on('error', (cause) => {
    console.error(`${label} failed to start: ${cause.message}`)
    process.exitCode = 1
    stop('SIGTERM')
  })
  child.on('close', (code, signal) => {
    running.delete(label)
    if (stopping) return
    /*
     * One down means both down. Leaving the survivor running is the worse
     * outcome by a distance: the client keeps serving and every `/api` call
     * fails, which is indistinguishable from the client being broken — the
     * exact confusion this script exists to remove.
     */
    console.error(
      `\n${label} exited (${signal ?? `code ${code}`}); stopping the other.`,
    )
    process.exitCode = code ?? 1
    stop('SIGTERM')
  })
  running.set(label, child)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal))
}
