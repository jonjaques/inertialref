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
import { TOKEN_ENV, acquire, forget, holding } from './gpuLock.mjs'

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

async function exited(pid, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50))
    if (!alive(pid)) return true
  return !alive(pid)
}

/**
 * Closes the rig's Chrome, then drops it from the lock: `--down`, which the
 * lock never refuses. The drop waits for the exit, because a Chrome still
 * tearing down its GPU process is still a GPU job, and a job queued on the
 * lock starts within one poll of the drop. A Chrome that ignores SIGTERM past
 * `graceMs` is killed. Without a token — a rig that predates the lock — or
 * with one the file does not hold, no lock is touched, so closing a rig
 * beside another job's lock leaves that lock alone.
 *
 * @returns {Promise<{closed: boolean, released: boolean}>}
 */
export async function closeChrome(
  pid,
  { token, path: file, graceMs = 10_000 } = {},
) {
  const closed = alive(pid)
  if (closed) {
    process.kill(pid, 'SIGTERM')
    if (!(await exited(pid, graceMs))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* it exited between the check and the kill */
      }
      await exited(pid, 2_000)
    }
  }
  const released =
    token !== undefined &&
    Number.isInteger(pid) &&
    forget(pid, { path: file, token })
  return { closed, released }
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
