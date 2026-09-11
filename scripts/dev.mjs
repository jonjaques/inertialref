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

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const ENSURE = process.argv.includes('--ensure')
const CLIENT_PORT = 5173
const SERVER_PORT = 8787
/*
 * Astro's own record of a dev server it started for this project — pid, url,
 * and whether it was daemonized. Read only to name the holder of 5173 when the
 * port is taken; Astro reads it too and refuses to start a second server.
 */
const ASTRO_LOCK = new URL('../apps/game/.astro/dev.json', import.meta.url)

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
 *
 * Astro's agent detection, which would daemonize the client child and end it
 * cleanly a second in, is switched off in the game package's own `dev` script
 * rather than here, so it holds on every route into Astro. The development
 * guide has the mechanism.
 */
function childEnv(env) {
  const current = env.NODE_OPTIONS ?? ''
  const cleaned = current
    .replace(/(^|\s)--inspect(?:-brk)?(?:=\S+)?(?=\s|$)/g, ' ')
    .trim()
  const next = { ...env, FORCE_COLOR: '1' }
  if (cleaned === '') delete next.NODE_OPTIONS
  else next.NODE_OPTIONS = cleaned
  return next
}

/*
 * `localhost`, not `127.0.0.1`: Astro binds `::1` alone on this machine, so an
 * IPv4 probe reports the port free while the next `astro dev` refuses it.
 * Node tries both families for a hostname and connects to whichever answers.
 */
function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

const clientUp = await listening(CLIENT_PORT)
const serverUp = await listening(SERVER_PORT)

if (ENSURE && clientUp) {
  // Match the Vite ready line so the editor's problem matcher unblocks,
  // then hold until it stops the task. Do not kill a server we did not start.
  console.log(`Local: http://localhost:${CLIENT_PORT}/`)
  await new Promise((resolve) => {
    // Signal listeners do not keep the event loop alive, and nothing else is
    // pending, so without a handle Node reports an unsettled top-level await
    // and exits 13 before the editor has stopped anything.
    const hold = setInterval(() => {}, 2 ** 31 - 1)
    const stop = () => {
      clearInterval(hold)
      resolve(undefined)
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.on(signal, stop)
  })
  process.exit(0)
}

/*
 * Under `--ensure` a Worker already on 8787 is reused the way 5173 is: only
 * the client starts, and Vite's proxy reaches whichever Worker is there. The
 * editor's task otherwise dies before printing the ready line its problem
 * matcher waits for, in a panel it never reveals.
 */
const reuseServer = ENSURE && serverUp

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const lsof = (port) =>
  `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` names the holder`

/*
 * Astro removes `.astro/dev.json` only from `server.stop()`, which no signal
 * reaches — Vite's SIGTERM handler closes the raw server and exits — so after
 * every Ctrl-C the file survives naming a pid that is gone. Astro checks the
 * pid before trusting it; so does this. The confident sentence and the
 * `astro dev stop` remedy are for a live Astro on this port; anything else on
 * 5173 (another worktree's Vite, most often) gets the honest one.
 */
function clientHolder() {
  let data
  try {
    data = JSON.parse(readFileSync(ASTRO_LOCK, 'utf8'))
  } catch {
    data = null
  }
  const own =
    data !== null &&
    typeof data.pid === 'number' &&
    data.port === CLIENT_PORT &&
    alive(data.pid)
  if (own) {
    return [
      `astro dev, pid ${data.pid}, since ${data.startedAt}`,
      'Stop it with `pnpm --filter @inertialref/game exec astro dev stop`, or reuse it with `--ensure`.',
    ]
  }
  const lock =
    data === null
      ? 'no astro dev this checkout knows about'
      : `not the astro dev in .astro/dev.json, whose pid ${data.pid} is ${alive(data.pid) ? `on ${data.port}` : 'gone'}`
  return [
    `${lock}; ${lsof(CLIENT_PORT)}`,
    'Stop it, then run `pnpm dev` again, or reuse it with `--ensure`.',
  ]
}

/*
 * Both ports, before either child starts. Otherwise wrangler boots, Astro
 * fails on the port, and the "one down means both down" rule below kills
 * wrangler with a 143 — three screens of output whose only real line is the
 * one about the port. Refusing here is also the same rule as `--ensure`: a
 * server this script did not start is not one it kills.
 */
function refuse(label, port, holder, remedy) {
  console.error(
    `${label} port ${port} is already in use (${holder}).\n${remedy}`,
  )
  process.exit(1)
}
if (clientUp) refuse('client', CLIENT_PORT, ...clientHolder())
if (serverUp && !reuseServer) {
  refuse(
    'server',
    SERVER_PORT,
    lsof(SERVER_PORT),
    'Stop it, then run `pnpm dev` again.',
  )
}

if (
  !existsSync(
    fileURLToPath(
      new URL('../apps/game/public/doc-content/manifest.json', import.meta.url),
    ),
  )
) {
  execFileSync('pnpm', ['docs:build'], { cwd: ROOT, stdio: 'inherit' })
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

/*
 * Each child is `pnpm run`, and pnpm does not pass a signal on to the script
 * it runs: SIGTERM kills pnpm and leaves Astro or workerd running, and SIGINT
 * does nothing at all. So each child is started in its own process group
 * (`detached`) and the group is signaled, which reaches the grandchild
 * directly. Ctrl-C still works: the terminal delivers it to this process, and
 * this handler relays it to both groups.
 *
 * The relay is the only route. `detached` is `setsid`, so the children have no
 * controlling terminal and nothing the terminal sends reaches them — not the
 * SIGHUP of a closed window or a dropped ssh session, and not the second
 * Ctrl-C that used to reach a wedged workerd directly. Both are relayed here:
 * SIGHUP as a SIGTERM, and a repeat of any signal as SIGKILL, so a group that
 * ignores the first one still has a keyboard escape. The handlers are
 * installed before the children exist, so a signal in the spawn window cannot
 * end this process by default action with both groups alive.
 */
function signalGroups(signal) {
  for (const child of running.values()) {
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
}

function stop(signal) {
  if (stopping) return
  stopping = true
  signalGroups(signal)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) {
      console.error('\nstill stopping; forcing (SIGKILL).')
      signalGroups('SIGKILL')
      return
    }
    stop(signal === 'SIGHUP' ? 'SIGTERM' : signal)
  })
}

for (const { label, colour, argv } of CHILDREN) {
  if (reuseServer && label === 'server') continue
  const child = spawn('pnpm', argv, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own process group; see stop()
    env: childEnv(process.env),
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
    if (stopping) {
      running.delete(label)
      return
    }
    /*
     * One down means both down. Leaving the survivor running is the worse
     * outcome by a distance: the client keeps serving and every `/api` call
     * fails, which is indistinguishable from the client being broken — the
     * exact confusion this script exists to remove.
     *
     * This child stays in `running` until stop() has signaled its group: pnpm
     * can be gone while its grandchild is not — wrangler dying without reaping
     * workerd, which holds its own pipes and so does not delay this event —
     * and the group is what carries the signal, not the pid that closed.
     */
    const other = running.size > 1 ? '; stopping the other' : ''
    console.error(`\n${label} exited (${signal ?? `code ${code}`})${other}.`)
    process.exitCode = code ?? 1
    stop('SIGTERM')
    running.delete(label)
  })
  running.set(label, child)
}
