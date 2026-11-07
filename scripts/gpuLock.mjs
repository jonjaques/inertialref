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
 * only its own entry. A holder whose GPU work runs in its own children
 * (`keepChildren`: vitest's main process, whose fork workers hold the
 * devices) leaves the lock to the ones still running when it ends without
 * releasing. Anything that cannot prove a process gone counts it
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
/** The file's format. Every worktree of the clone shares the one file, and a
 *  worktree on another branch can run another revision of this module. */
const VERSION = 1
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

/*
 * The distance from the file's mtime, in either direction. A clock stepped
 * back after the file was written leaves its mtime in the future, and a
 * signed age there stays under the grace for as long as the step: an
 * unreadable lock would read as `opening` and a dead mutex as held, and both
 * waits spin synchronously, so no `waitMs` can end them.
 */
const ageOf = (file) => {
  try {
    return Math.abs(Date.now() - statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** The file's text, the lock it parses to, which is null for a file torn or
 *  empty, and the format version it declares; null for no file at all. */
function load(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw unwritable(file, error)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text, lock: null, version: null }
  }
  const version = typeof parsed?.version === 'number' ? parsed.version : null
  const lock =
    version === VERSION && Array.isArray(parsed.processes) ? parsed : null
  return { text, lock, version }
}

/**
 * What is at `file`: nothing, a lock held by a live process, a stale one, one
 * being written, or one in another format. `openSync('wx')` and the write
 * after it are two calls, so a reader can find the file empty between them;
 * that is a job taking the lock, not a dead one, until it has stayed
 * unreadable past the grace. An unreadable lock names no process, so past the
 * grace every process it names is gone.
 *
 * A lock that declares another version is not unreadable: it is a worktree on
 * another branch, whose processes this revision cannot name and so cannot
 * prove gone. Judged stale, it would be deleted under a job that is running.
 */
function inspect(file) {
  const found = load(file)
  if (found === null) return { kind: 'free' }
  const { text, lock, version } = found
  if (version !== null && version !== VERSION)
    return { kind: 'foreign', text, version }
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
    version: VERSION,
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
/** Lock path to holder, for the locks whose GPU work runs in this process's
 *  own children (`keepChildren`). */
const parents = new Map()

/** This process's live children; none when `pgrep` cannot say. */
function children() {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * The holder ending without having released: a signal, or an exit that came
 * first. A holder that asked for `keepChildren` leaves the lock to whichever
 * of its children still run, then drops its own entry as a release does.
 * vitest's fork workers are the case: they hold the Dawn devices, and they
 * outlive a SIGTERM of the main process by seconds, so a lock released with
 * the main process alone would let the next job start beside them. A
 * recording that fails still releases; what it leaves is stale once the
 * children are gone.
 */
function abandon() {
  try {
    const kids = parents.size > 0 ? children() : []
    for (const [file, holder] of parents) {
      const token = held.get(file)
      if (token !== undefined && kids.length > 0)
        edit(file, token, (lock) =>
          kids.reduce(
            (next, pid) => adding(entry(pid, 'child', holder))(next),
            lock,
          ),
        )
    }
  } catch (error) {
    process.stderr.write(`gpuLock: ${error.message}\n`)
  }
  release()
}

/**
 * Re-raised once this listener is gone, because a listener replaces Node's
 * default for the signal: without it the holder would release the lock and
 * keep running, and its parent would never see it die of the signal it sent.
 * Another listener means someone else owns the process's response.
 */
const onSignal = (signal) => {
  // A release that throws must not keep the process alive past its signal,
  // and an exception thrown from here would end it with exit code 1 rather
  // than the signal its parent sent. What a failed release leaves is stale
  // once this process is gone.
  try {
    abandon()
  } catch (error) {
    process.stderr.write(`gpuLock: ${error.message}\n`)
  }
  for (const each of SIGNALS) process.removeListener(each, listeners[each])
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}
const listeners = Object.fromEntries(
  SIGNALS.map((signal) => [signal, () => onSignal(signal)]),
)

function hold(file, token, holder, joined, keepChildren) {
  if (held.size === 0) {
    process.on('exit', abandon)
    for (const signal of SIGNALS) process.on(signal, listeners[signal])
  }
  held.set(file, token)
  if (keepChildren) parents.set(file, holder)
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
  parents.delete(file)
  if (held.size === 0) {
    process.removeListener('exit', abandon)
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
  if (found.kind === 'opening')
    return `the GPU lock ${file} is being taken by a job that has not written its name yet.`
  if (found.kind === 'foreign')
    return (
      `the GPU lock ${file} is format version ${found.version}, and this checkout's ` +
      `gpuLock.mjs reads version ${VERSION}. A worktree on another branch may hold it, ` +
      'so this job does not judge it stale; a job on that branch does.'
    )
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
 * Who holds the GPU, without taking it: `--status`, and a caller choosing
 * which of the tokens it was handed to join with. Null when nothing live
 * holds it. A stale lock is left for the next acquire to reclaim, because a
 * read that deleted one would race the edit mutex it does not take.
 *
 * @returns {{token: string | null, text: string} | null}
 */
export function holding({ path: file = lockPath() } = {}) {
  const found = inspect(file)
  if (found.kind === 'free' || found.kind === 'stale') return null
  return { token: found.lock?.token ?? null, text: describe(file, found) }
}

/**
 * `--gpu-wait <s>` or `IR_GPU_WAIT`, as the milliseconds `acquire` takes.
 * Seconds, because a bound on a queue is minutes and drive.mjs's `--wait` is
 * already milliseconds of page delay. A plain count only: `1e3` and `5s` are
 * what a person types expecting a unit, and either read as a number is a wait
 * a thousand times, or nothing like, what was meant. Unset or empty is no wait.
 */
export function parseWait(seconds, source) {
  if (seconds === undefined || seconds === '') return 0
  if (!/^\d+(\.\d+)?$/.test(seconds))
    throw new Error(
      `${source} takes seconds to wait for the GPU, as a plain number, not '${seconds}'`,
    )
  return Math.round(Number(seconds) * 1000)
}

/**
 * One pass at the lock: join it, take it, or say who has it. A lock still
 * being written is waited out rather than refused, because a refusal has to
 * name its holder and that one cannot be read yet; `inspect` turns it stale
 * past the grace, so the wait is bounded. A few rounds absorb the other races
 * — a create that loses, a reclaim another process got to first.
 */
function attempt(file, holder, token, keepChildren) {
  for (let tries = 0; tries < 4;) {
    const found = inspect(file)
    if (found.kind === 'opening') {
      sleepSync(2)
      continue
    }
    tries += 1
    if (found.kind === 'foreign') return { busy: found }
    if (
      found.kind === 'held' &&
      token !== undefined &&
      found.lock.token === token
    ) {
      if (edit(file, token, adding(entry(process.pid, 'holder', holder))))
        return { lock: hold(file, token, holder, true, keepChildren) }
      continue
    }
    if (found.kind === 'held') return { busy: found }
    if (found.kind === 'stale') {
      reclaim(file, found.text)
      continue
    }
    const created = create(file, holder)
    if (created !== null)
      return { lock: hold(file, created.token, holder, false, keepChildren) }
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
 * @param {string} [options.hint]  the caller's own way to queue, as the refusal's last line
 * @param {boolean} [options.keepChildren]  ended by a signal, or by an exit
 *   before its release, this process leaves the lock to its live children
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
    hint,
    keepChildren = false,
    say = (line) => process.stderr.write(`${line}\n`),
  } = {},
) {
  const begun = Date.now()
  let printed = -Infinity
  for (;;) {
    const got = attempt(file, holder, token, keepChildren)
    if (got.lock !== undefined) return got.lock
    const now = Date.now()
    if (now - begun >= waitMs) {
      const waited =
        waitMs > 0 ? `\nWaited ${(waitMs / 1000).toFixed(1)} s.` : ''
      throw new GpuLockError(
        `GPU busy. ${describe(file, got.busy)}${waited}\n` +
          'One GPU job runs on this machine at a time. Wait for it to finish, ' +
          `or ask whoever is working in that checkout.\nLock: ${file}` +
          (hint === undefined ? '' : `\n${hint}`),
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
