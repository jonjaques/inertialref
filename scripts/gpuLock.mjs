/*
 * One GPU job at a time on this machine, across every checkout of the clone.
 *
 * Two overlapping GPU jobs have crashed macOS twice. Vitest's and Playwright's
 * own locks coordinate inside one run, so neither sees `pnpm test:gpu`, a
 * drive.mjs rig, or the same command in another worktree. This file is the
 * one place they all meet: `$(git rev-parse --git-common-dir)`, which every
 * worktree of the clone resolves to the main checkout's `.git`.
 *
 *     const lock = await acquire('test:gpu', { waitMs })   // or GpuLockError
 *     spawn(cmd, args, { env: { ...process.env, ...lock.env } })  // a child joins
 *     lock.record(chrome.pid)                    // the lock outlives this process
 *     forget(chromePid, { token })               // `--down`, from a later process
 *
 * The file names every process the lock is held for: the holder, any child
 * that joined it under the holder's token, and any process a holder recorded
 * because it outlives the holder (drive.mjs's detached Chrome). It is stale
 * only when every one of them is gone, so a killed rig whose Chrome still
 * renders keeps it, and a holder's exit — normal, SIGINT or SIGTERM — removes
 * only its own entry. Anything that cannot prove a process gone counts it
 * alive, and a lock that cannot be created refuses the job: a GPU job never
 * starts unlocked, and there is no environment switch that lets one.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

/** How a parent hands its token to the processes it spawns. A token is not a
 *  bypass: one that does not match the live lock file buys nothing. */
export const TOKEN_ENV = 'IR_GPU_LOCK_TOKEN'

const NAME = 'inertialref-gpu.lock'
/** An edit is a read and a rename, and a create is an open and one write, so a
 *  mutex or an unreadable lock older than this belongs to a process that died
 *  inside one. */
const GRACE_MS = 2_000
const SIGNALS = ['SIGINT', 'SIGTERM']

export class GpuLockError extends Error {
  /** `code` is `busy` (held by a live job) or `unwritable` (fails closed). */
  constructor(message, { code, lock = null, cause } = {}) {
    super(message, { cause })
    this.name = 'GpuLockError'
    this.code = code
    this.lock = lock
  }
}

const unwritable = (file, error) =>
  new GpuLockError(
    `cannot write the GPU lock ${file}: ${error.code ?? 'error'} (${error.message}). ` +
      'No GPU job starts without the lock, so this one does not either.',
    { code: 'unwritable', cause: error },
  )

const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

/** The lock every checkout of this clone shares, as an absolute path. */
export function lockPath(cwd = process.cwd()) {
  try {
    return path.join(
      path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])),
      NAME,
    )
  } catch (error) {
    throw new GpuLockError(
      `no git common dir from ${cwd}, so no GPU lock to take: ${error.stderr ?? error.message}`.trim(),
      { code: 'unwritable', cause: error },
    )
  }
}

/* ------------------------------------------------------------ processes ---- */

/**
 * When `pid` started, as `ps -o lstart=` prints it, or null when no process
 * has that pid. `ps` because it reads the same on macOS and on Linux, and
 * `/proc` exists only on Linux. One `-o` per column: POSIX makes everything
 * after `=` the header, so `-o stat=,lstart=` prints no start time under
 * Linux's procps, though macOS's ps splits it. The locale and zone are
 * pinned: `lstart` is local time, and two readers under different `TZ` would
 * disagree about one process and call it reused. A zombie has exited and only
 * waits for a parent to reap it, which an orphan in a CI container may never
 * get. Throws when `ps` itself cannot run.
 */
function startOf(pid) {
  let out
  try {
    out = execFileSync(
      'ps',
      ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
  } catch (error) {
    if (error.status === 1) return null
    throw error
  }
  const [stat = '', ...start] = out.trim().split(/\s+/)
  return stat === '' || stat.startsWith('Z') ? null : start.join(' ')
}

const startOrNull = (pid) => {
  try {
    return startOf(pid)
  } catch {
    return null
  }
}

/**
 * Whether the process an entry names is still the one it recorded. A pid of
 * 0 or below is refused first: `kill(0, 0)` addresses this process's whole
 * group and always succeeds. EPERM means the pid exists under another user.
 * A start time that differs is pid reuse; one that cannot be read is not
 * proof of anything, so the entry stays alive.
 */
function running({ pid, processStart }) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return false
  }
  let now
  try {
    now = startOf(pid)
  } catch {
    return true
  }
  if (now === null) return false
  return processStart == null || now === processStart
}

const entry = (pid, role, holder) => ({
  pid,
  role,
  holder,
  processStart: startOrNull(pid),
  since: new Date().toISOString(),
})

/* ----------------------------------------------------------------- file ---- */

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const ageOf = (file) => {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** The file's text and the lock it parses to, which is null for a file torn
 *  or empty; null for no file at all. */
function load(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw unwritable(file, error)
  }
  try {
    const lock = JSON.parse(text)
    return { text, lock: Array.isArray(lock?.processes) ? lock : null }
  } catch {
    return { text, lock: null }
  }
}

/**
 * What is at `file`: nothing, a lock held by a live process, a stale one, or
 * one being written. `openSync('wx')` and the write after it are two calls, so
 * a reader can find the file empty between them; that is a job taking the
 * lock, not a dead one, until it has stayed unreadable past the grace. An
 * unreadable lock names no process, so past the grace every process it names
 * is gone.
 */
function inspect(file) {
  const found = load(file)
  if (found === null) return { kind: 'free' }
  const { text, lock } = found
  if (lock === null)
    return { kind: ageOf(file) < GRACE_MS ? 'opening' : 'stale', text }
  const live = lock.processes.filter(running)
  return { kind: live.length > 0 ? 'held' : 'stale', text, lock, live }
}

/**
 * Every change to a lock that exists — a child joining it, a process
 * recorded or forgotten, a stale lock reclaimed — runs inside `<lock>.edit`,
 * created the same exclusive way. Two reclaimers that each judged one dead
 * lock stale would otherwise each delete it, and the slower would delete the
 * lock the faster had just created: two holders. A mutex past the grace was
 * left by a process that died inside an edit.
 */
function exclusive(file, change) {
  const mutex = `${file}.edit`
  for (;;) {
    try {
      closeSync(openSync(mutex, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw unwritable(mutex, error)
      if (ageOf(mutex) > GRACE_MS) rmSync(mutex, { force: true })
      else sleepSync(2)
    }
  }
  try {
    return change()
  } finally {
    rmSync(mutex, { force: true })
  }
}

/** Rewrites the lock carrying `token` through `change`, deleting it when no
 *  process is left; false when the file holds another lock or none. Written
 *  beside it and renamed over it, so a reader never sees half a rewrite. */
function edit(file, token, change) {
  return exclusive(file, () => {
    const found = load(file)
    if (found?.lock == null || found.lock.token !== token) return false
    const next = change(found.lock)
    if (next.processes.length === 0) {
      rmSync(file, { force: true })
      return true
    }
    const scratch = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(scratch, `${JSON.stringify(next, null, 2)}\n`)
      renameSync(scratch, file)
    } catch (error) {
      rmSync(scratch, { force: true })
      throw unwritable(file, error)
    }
    return true
  })
}

/** Deletes the stale lock read as `text`, unless it changed since. */
const reclaim = (file, text) =>
  exclusive(file, () => {
    if (load(file)?.text === text) rmSync(file, { force: true })
  })

const adding = (next) => (lock) =>
  lock.processes.some((p) => p.pid === next.pid)
    ? lock
    : { ...lock, processes: [...lock.processes, next] }

const without = (pid) => (lock) => ({
  ...lock,
  processes: lock.processes.filter((p) => p.pid !== pid),
})

/** The lock created for `holder`, or null when another process got there. */
function create(file, holder) {
  const self = entry(process.pid, 'holder', holder)
  const cwd = process.cwd()
  let worktree = null
  try {
    worktree = git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    /* not inside a checkout */
  }
  const lock = {
    version: 1,
    token: randomBytes(16).toString('hex'),
    holder,
    pid: process.pid,
    cwd,
    worktree,
    startedAt: self.since,
    processStart: self.processStart,
    processes: [self],
  }
  let fd
  try {
    fd = openSync(file, 'wx')
  } catch (error) {
    if (error.code === 'EEXIST') return null
    throw unwritable(file, error)
  }
  try {
    writeSync(fd, `${JSON.stringify(lock, null, 2)}\n`)
  } catch (error) {
    rmSync(file, { force: true })
    throw unwritable(file, error)
  } finally {
    closeSync(fd)
  }
  return lock
}

/* ------------------------------------------------------------- holding ---- */

/** Lock path to token, for every lock this process has an entry in. */
const held = new Map()

/**
 * Re-raised once this listener is gone, because a listener replaces Node's
 * default for the signal: without it the holder would release the lock and
 * keep running, and its parent would never see it die of the signal it sent.
 * Another listener means someone else owns the process's response.
 */
const onSignal = (signal) => {
  release()
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}
const listeners = Object.fromEntries(
  SIGNALS.map((signal) => [signal, () => onSignal(signal)]),
)

function hold(file, token, holder, joined) {
  if (held.size === 0) {
    process.on('exit', release)
    for (const signal of SIGNALS) process.on(signal, listeners[signal])
  }
  held.set(file, token)
  return {
    path: file,
    token,
    holder,
    joined,
    /** Merge into a child's environment, and the child joins this lock. */
    env: { [TOKEN_ENV]: token },
    /** Hold the lock for `pid` too, past this process's exit; `forget` ends it. */
    record: (pid, role = 'chrome') =>
      edit(file, token, adding(entry(pid, role, holder))),
    release: () => releaseOne(file),
  }
}

function releaseOne(file) {
  const token = held.get(file)
  if (token === undefined) return
  held.delete(file)
  if (held.size === 0) {
    process.removeListener('exit', release)
    for (const signal of SIGNALS)
      process.removeListener(signal, listeners[signal])
  }
  edit(file, token, without(process.pid))
}

/** Removes this process's own entry from every lock it holds. What it
 *  recorded stays, and so does the lock while any of that runs. */
export function release() {
  for (const file of [...held.keys()]) releaseOne(file)
}

/** Ends the lock's hold on a recorded process — drive.mjs's `--down`, run in a
 *  process that did not record it. False when the file is another lock. */
export function forget(pid, { path: file = lockPath(), token } = {}) {
  return edit(file, token, without(pid))
}

/* ------------------------------------------------------------- acquire ---- */

const elapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`
}

/** Who has the GPU, for a person deciding whether to wait. Never names
 *  `--down`: that is another agent's rig, and closing it ends their session. */
function describe(file, found) {
  if (found.lock === undefined)
    return `the GPU lock ${file} changed hands while this job tried to take it.`
  const { lock, live } = found
  const exited = live.some((p) => p.pid === lock.pid) ? '' : ', exited'
  const others = live
    .filter((p) => p.pid !== lock.pid)
    .map((p) =>
      p.role === 'holder'
        ? `pid ${p.pid} (${p.holder})`
        : `pid ${p.pid} (${p.role}, recorded by ${p.holder})`,
    )
  return [
    `${lock.holder} has held the GPU for ${elapsed(Date.now() - Date.parse(lock.startedAt))} ` +
      `(pid ${lock.pid}${exited}), from ${lock.worktree ?? lock.cwd}.`,
    ...(others.length > 0 ? [`It is held for ${others.join(', ')}.`] : []),
  ].join('\n')
}

/**
 * One pass at the lock: join it, take it, or say who has it. A lock still
 * being written is waited out rather than refused, because a refusal has to
 * name its holder and that one cannot be read yet; `inspect` turns it stale
 * past the grace, so the wait is bounded. A few rounds absorb the other races
 * — a create that loses, a reclaim another process got to first.
 */
function attempt(file, holder, token) {
  for (let tries = 0; tries < 4;) {
    const found = inspect(file)
    if (found.kind === 'opening') {
      sleepSync(2)
      continue
    }
    tries += 1
    if (
      found.kind === 'held' &&
      token !== undefined &&
      found.lock.token === token
    ) {
      if (edit(file, token, adding(entry(process.pid, 'holder', holder))))
        return { lock: hold(file, token, holder, true) }
      continue
    }
    if (found.kind === 'held') return { busy: found }
    if (found.kind === 'stale') {
      reclaim(file, found.text)
      continue
    }
    const created = create(file, holder)
    if (created !== null)
      return { lock: hold(file, created.token, holder, false) }
  }
  return { busy: inspect(file) }
}

/**
 * Takes the GPU for `holder`, or joins the lock whose token this process was
 * handed. Fails at once by default; `waitMs` queues for that long, polling
 * every `pollMs` and saying who holds it every `reprintMs`.
 *
 * @param {string} holder  what is asking, as a person would name it: `test:gpu`
 * @param {object} [options]
 * @param {number} [options.waitMs]
 * @param {string} [options.path]   the lock file; the shared one by default
 * @param {string} [options.token]  a parent's token; `IR_GPU_LOCK_TOKEN` by default
 * @param {number} [options.pollMs]
 * @param {number} [options.reprintMs]
 * @param {(line: string) => void} [options.say]
 */
export async function acquire(
  holder,
  {
    waitMs = 0,
    path: file = lockPath(),
    token = process.env[TOKEN_ENV],
    pollMs = 500,
    reprintMs = 10_000,
    say = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  const begun = Date.now()
  let printed = -Infinity
  for (;;) {
    const got = attempt(file, holder, token)
    if (got.lock !== undefined) return got.lock
    const now = Date.now()
    if (now - begun >= waitMs) {
      const waited =
        waitMs > 0 ? `\nWaited ${(waitMs / 1000).toFixed(1)} s.` : ''
      throw new GpuLockError(
        `GPU busy. ${describe(file, got.busy)}${waited}\n` +
          'One GPU job runs on this machine at a time. Wait for it to finish, ' +
          `or ask whoever is working in that checkout.\nLock: ${file}`,
        { code: 'busy', lock: got.busy.lock ?? null },
      )
    }
    if (now - printed >= reprintMs) {
      say(`Waiting for the GPU. ${describe(file, got.busy)}\nLock: ${file}`)
      printed = now
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, begun + waitMs - now)),
    )
  }
}
