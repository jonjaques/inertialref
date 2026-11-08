/*
 * The machine's GPU lock, as the rig holds it.
 *
 * drive.mjs leaves its Chrome running between invocations, detached, so the
 * GPU job is that Chrome and not any one invocation. The lock is taken before
 * the first Chrome launches, kept for the Chrome past the invocation's exit,
 * and dropped by `--down` once the Chrome is gone. A later invocation on the
 * port joins it under the token the port's session recorded, and the
 * drive.mjs children of a preset command join under the token their parent
 * hands down. `scripts/gpuLock.mjs` is the lock itself, and says why a
 * recorded Chrome keeps it held after everything else has exited.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TOKEN_ENV,
  acquire,
  forget,
  holding,
  processStart,
} from './gpuLock.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Where shots land when the path has no directory in it, and where the rig
 *  records what it started. `.data/` is git-ignored; nothing here is source. */
export const RIG = path.join(ROOT, '.data/drive')

/** What the rig on `port` started, and the GPU lock token it holds. */
export const sessionPath = (port, rig = RIG) =>
  path.join(rig, `session-${port}.json`)

export async function readSession(port, rig = RIG) {
  return await readFile(sessionPath(port, rig), 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Takes the GPU for one invocation on a rig, or for a preset command that
 * drives one. It joins whichever lock it was handed that is still live — the
 * one a parent put in `IR_GPU_LOCK_TOKEN`, or the one the port's session
 * recorded — and otherwise acquires, failing at once unless `waitMs` queues
 * it. Both tokens are checked against the live lock first because either can
 * be stale: a session outlives a rig whose Chrome died, and a shell can carry
 * a token from a command long finished. Offering the stale one would have the
 * rig refused by the lock its own Chrome holds.
 *
 * @param {string} holder  `drive.mjs (port 9333)`, `presets:compare`
 * @param {object} [options]
 * @param {{gpuToken?: string} | null} [options.state]  the port's session
 * @param {number} [options.waitMs]
 * @param {string} [options.hint]  the caller's way to queue, for the refusal
 * @param {string} [options.path]  the lock file; the shared one by default
 * @param {Record<string, string | undefined>} [options.env]
 */
export async function takeGpu(
  holder,
  { state = null, waitMs = 0, hint, path: file, env = process.env } = {},
) {
  const live = holding({ path: file })?.token
  const token = [env[TOKEN_ENV], state?.gpuToken].find(
    (one) => one !== undefined && one === live,
  )
  // `null`, not `undefined`: acquire reads an absent token from this
  // process's environment, which is the one already judged above.
  return await acquire(holder, {
    waitMs,
    path: file,
    token: token ?? null,
    hint,
  })
}

/**
 * Holds the lock for the rig's Chrome past this invocation's exit, so the
 * lock is not stale until that Chrome is gone. A record the file refuses
 * means the file no longer holds this lock, and a Chrome recorded into
 * nothing renders unlocked, so that throws.
 */
export function keep(lock, pid) {
  if (!Number.isInteger(pid)) return
  if (!lock.record(pid))
    throw new Error(
      `the GPU lock ${lock.path} is no longer this rig's, so its Chrome (pid ${pid}) would run unlocked`,
    )
}

/** `pid`'s start time as the lock records it, or null when it has exited or
 *  `ps` cannot say. */
const startOf = (pid) => {
  try {
    return processStart(pid)
  } catch {
    return null
  }
}

/**
 * Holds the lock for a Chrome already up on the port — an attach — and
 * returns the session fields that record it. A session written by a
 * drive.mjs from before the lock has no token, so the lock this invocation
 * took becomes the one that holds that Chrome, and no start time, so it is
 * read now and `--down` can tell that Chrome from a process given its pid
 * later. A session with no pid names nothing to keep, and the lock then
 * holds for the Chrome only while this invocation runs.
 *
 * @param {{record: (pid: number) => boolean, path: string}} lock
 * @param {{chromePid?: number | null, chromeStart?: string | null}} state  the port's session
 */
export function adopt(lock, state) {
  const chromePid = state.chromePid ?? null
  keep(lock, chromePid)
  return {
    chromePid,
    chromeStart:
      state.chromeStart ?? (chromePid === null ? null : startOf(chromePid)),
  }
}

/**
 * Holds the lock for a Chrome this invocation just spawned, and returns the
 * session fields that record it, its start time among them. A Chrome the
 * lock cannot record is ended here: it would render unlocked from the
 * moment the invocation exits.
 *
 * @param {{record: (pid: number) => boolean, path: string, token: string}} lock
 * @param {number} pid
 */
export function launched(lock, pid) {
  try {
    keep(lock, pid)
  } catch (error) {
    signal(pid, 'SIGTERM')
    throw error
  }
  return {
    chromePid: pid ?? null,
    chromeStart: Number.isInteger(pid) ? startOf(pid) : null,
    gpuToken: lock.token,
  }
}

/** EPERM is a live process under another user; anything else is gone. */
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const signal = (pid, name) => {
  try {
    process.kill(pid, name)
  } catch {
    /* it never started, or has already exited */
  }
}

async function exited(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50))
    if (!alive(pid)) return true
  return !alive(pid)
}

/**
 * Whether `pid` is still the Chrome the session recorded starting at
 * `start`: `same`; `reused`, when the pid now names another process, which a
 * reboot or a crashed Chrome leaves a surviving session pointing at; `gone`;
 * or `unknown`, when the session recorded no start time or `ps` cannot say.
 */
function identify(pid, start) {
  if (!alive(pid)) return 'gone'
  if (typeof start !== 'string') return 'unknown'
  let now
  try {
    now = processStart(pid)
  } catch {
    return 'unknown'
  }
  if (now === null) return 'gone'
  return now === start ? 'same' : 'reused'
}

/**
 * Closes the rig's Chrome, then drops it from the lock: `--down`, which the
 * lock never refuses. The drop waits for the exit, because a Chrome still
 * tearing down its GPU process is still a GPU job, and a job queued on the
 * lock starts within one poll of the drop.
 *
 * Nothing is signaled until the pid is shown to be that Chrome by the start
 * time the session recorded: a session outlives a reboot, and its pid can
 * by then name any process of this user's. A pid that names another process
 * is left alone and only dropped from the lock. A Chrome that ignores
 * SIGTERM past `graceMs` is killed only when its start time matches; one
 * with no start time recorded gets SIGTERM alone, and while it runs the lock
 * keeps holding for it. Without a token — a rig that predates the lock — or
 * with one the file does not hold, no lock is touched, so closing a rig
 * beside another job's lock leaves that lock alone.
 *
 * @returns {Promise<{closed: boolean, released: boolean, reused: boolean}>}
 */
export async function closeChrome(
  pid,
  { token, start, path: file, graceMs = 10_000 } = {},
) {
  const was = identify(pid, start)
  const ours = was === 'same' || was === 'unknown'
  if (ours) {
    signal(pid, 'SIGTERM')
    if (!(await exited(pid, graceMs)) && identify(pid, start) === 'same') {
      signal(pid, 'SIGKILL')
      await exited(pid, 2_000)
    }
  }
  const now = identify(pid, start)
  const released =
    token !== undefined &&
    Number.isInteger(pid) &&
    (now === 'gone' || now === 'reused') &&
    forget(pid, { path: file, token })
  return { closed: ours && now === 'gone', released, reused: was === 'reused' }
}

/**
 * This process as the session lists an invocation driving the rig's page:
 * its pid, and its start time, so a pid a crashed invocation left behind is
 * not read as a later process that was given it.
 */
export const driver = (pid = process.pid) => ({ pid, start: startOf(pid) })

/**
 * The invocations the session lists as driving the rig's page that are still
 * running. An invocation takes itself off the list when it exits, and one
 * that was killed cannot, so every reader filters the list instead of
 * trusting it. A start time that cannot be read is no proof the pid was
 * reused, so that entry stays, as a Chrome's does in `rigLeft`.
 *
 * @param {{drivers?: {pid: number, start: string | null}[]} | null} state
 */
export function drivers(state) {
  const listed = Array.isArray(state?.drivers) ? state.drivers : []
  return listed.filter(({ pid, start }) => {
    const who = identify(pid, start)
    return who === 'same' || who === 'unknown'
  })
}

/**
 * `--status`'s answer: the GPU free, held for this rig, or held by another
 * job, named the way a refusal names it. A status that cannot read the lock
 * says so rather than failing the command.
 */
export function gpuLine(state, { path: file } = {}) {
  let held
  try {
    held = holding({ path: file })
  } catch (error) {
    return `unknown: ${error.message}`
  }
  if (held === null) return 'free'
  const ours = held.token !== null && held.token === state?.gpuToken
  return `${ours ? 'held for this rig' : 'held by another job'}. ${held.text}`
}

/**
 * The line a command that drove the rig on `port` ends with, whether it
 * finished or threw. The Chrome it left up holds the GPU lock until
 * `--down`, and a command that failed partway has left that Chrome up just
 * the same: every other worktree's suite and rig is refused until someone
 * closes it, and the error is all the person sees. Null when no Chrome of
 * that session is up, or the live lock is not held under its token.
 *
 * @param {string | number} port
 * @param {object} [options]
 * @param {string} [options.rig]   where sessions live; `.data/drive` by default
 * @param {string} [options.path]  the lock file; the shared one by default
 */
export async function rigLeft(port, { rig, path: file } = {}) {
  const state = await readSession(port, rig)
  const who = identify(state?.chromePid, state?.chromeStart)
  if (who !== 'same' && who !== 'unknown') return null
  let held
  try {
    held = holding({ path: file })
  } catch {
    return null
  }
  if (held?.token == null || held.token !== state.gpuToken) return null
  return `The rig on port ${port} holds the GPU lock until node scripts/drive.mjs --port ${port} --down.`
}
