import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GpuLockError,
  TOKEN_ENV,
  acquire,
  forget,
  holding,
  lockPath,
  release,
  parseWait,
} from './gpuLock.mjs'

/** Every process a test starts carries this in its argv, so `pgrep -f` can
 *  prove that none of them outlived the file. */
const MARK = `gpulock-test-${process.pid}`
const MODULE = new URL('./gpuLock.mjs', import.meta.url).href
const SLEEPER = 'setInterval(() => {}, 1e9)'

/*
 * One holder program, run as a process of its own, so the lock is held by a
 * pid a test can signal and kill rather than by the vitest worker. The plan in
 * its environment says what it does once it holds the lock: launch a detached
 * Chrome stand-in and record it, start a worker of its own as vitest starts a
 * fork, run a nested child under its token, then hold until stdin closes —
 * releasing first, as a teardown does, or not — or exit at once. The barrier is polled asynchronously: a
 * pipe to the parent is asynchronous on macOS, so a synchronous spin would sit
 * on the `waiting` line the test is waiting for.
 */
const PROGRAM = `
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
const { acquire } = await import(process.env.GPU_LOCK_MODULE)
const plan = JSON.parse(process.env.GPU_LOCK_PLAN)
if (typeof plan.path !== 'string') throw new Error('a test holder takes its lock path explicitly, never the shared one')
const tell = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
if (plan.go !== undefined) {
  tell({ waiting: process.pid })
  while (!existsSync(plan.go)) await new Promise((resolve) => setTimeout(resolve, 1))
  await new Promise((resolve) => setTimeout(resolve, plan.delay ?? 0))
}
let lock
try {
  lock = await acquire(plan.holder, { path: plan.path, waitMs: plan.waitMs ?? 0, pollMs: 20, keepChildren: plan.keepChildren, say: () => {} })
} catch (error) {
  tell({ busy: error.message, code: error.code })
  process.exit(1)
}
tell({ acquired: process.pid, joined: lock.joined })
if (plan.chrome) {
  const chrome = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER)}, process.argv[1], 'chrome'], { detached: true, stdio: 'ignore' })
  chrome.unref()
  lock.record(chrome.pid)
  tell({ chrome: chrome.pid })
}
if (plan.worker) {
  const worker = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER)}, process.argv[1], 'worker'], { stdio: 'ignore' })
  tell({ worker: worker.pid })
}
if (plan.child !== undefined) {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
    env: { ...process.env, ...lock.env, GPU_LOCK_PLAN: JSON.stringify(plan.child) },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  tell({ childExited: await new Promise((resolve) => child.on('exit', resolve)) })
}
tell({ ready: process.pid })
if (plan.hold) {
  process.stdin.on('end', () => {
    if (plan.releaseFirst) lock.release()
    process.exit(0)
  })
  process.stdin.resume()
}
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let dir
const file = () => path.join(dir, 'inertialref-gpu.lock')
const read = () => JSON.parse(readFileSync(file(), 'utf8'))
const pids = (record) => record.processes.map((entry) => entry.pid)
const holders = new Set()
const standIns = new Set()

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

/** The start time the way a second reader sees it, in the pinned locale and
 *  zone the lock records. */
function startOf(pid) {
  return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })
    .trim()
    .replace(/\s+/g, ' ')
}

/** Whether a pid names a process that has not exited: a zombie has. */
function exists(pid) {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return stat !== '' && !stat.startsWith('Z')
  } catch {
    return false
  }
}

/** A SIGKILL is delivered asynchronously, and an orphan is reaped by init. */
async function gone(pid) {
  for (let i = 0; i < 300; i += 1) {
    if (!exists(pid)) return
    await sleep(10)
  }
  throw new Error(`pid ${pid} outlived its SIGKILL`)
}

function leftovers() {
  try {
    return execFileSync('pgrep', ['-f', MARK], { encoding: 'utf8' })
      .trim()
      .split('\n')
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
}

/** A process that ran and exited: its pid is free, or someone else's. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '', MARK], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('close', resolve))
  return child.pid
}

/** A lock in the module's own format, naming `processes` and nothing alive
 *  beyond what the test put there. */
function writeLock(processes) {
  const [first] = processes
  writeFileSync(
    file(),
    `${JSON.stringify({
      version: 1,
      token: 'f'.repeat(32),
      holder: 'old-job',
      pid: first.pid,
      cwd: ROOT,
      worktree: ROOT,
      startedAt: new Date().toISOString(),
      processStart: first.processStart,
      processes: processes.map((entry) => ({
        role: 'holder',
        holder: 'old-job',
        since: new Date().toISOString(),
        ...entry,
      })),
    })}\n`,
  )
}

/** `plan` and every nested child's plan, pointed at this test's lock. A child
 *  plan without a path would take the shared lock in the main checkout. */
const scoped = (plan) =>
  plan === undefined
    ? undefined
    : { path: file(), ...plan, child: scoped(plan.child) }

/** Runs `PROGRAM` with `plan`, and reads back what it says, line by line. */
function holder(plan, env = {}) {
  const { [TOKEN_ENV]: _inherited, ...base } = process.env
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', PROGRAM, MARK],
    {
      env: {
        ...base,
        GPU_LOCK_MODULE: MODULE,
        GPU_LOCK_PLAN: JSON.stringify(scoped(plan)),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  holders.add(child)
  const messages = []
  let waiters = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const message = JSON.parse(line)
      if (message.chrome !== undefined) standIns.add(message.chrome)
      if (message.worker !== undefined) standIns.add(message.worker)
      messages.push(message)
    }
    const woken = waiters
    waiters = []
    for (const wake of woken) wake(false)
  })
  const closed = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      holders.delete(child)
      resolve({ code, signal })
    }),
  )
  const find = (keys) =>
    messages.find((message) => keys.some((key) => key in message))
  /** The first message carrying any of `keys`; the holder ending without one
   *  fails. */
  const heard = async (...keys) => {
    for (;;) {
      if (find(keys) !== undefined) return find(keys)
      const ended = await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        closed.then(() => true),
      ])
      if (ended && find(keys) === undefined)
        throw new Error(
          `holder ended without ${keys.join(' or ')}: ${JSON.stringify(messages)}`,
        )
    }
  }
  /** The value of the first message carrying `key`. */
  const said = async (key) => (await heard(key))[key]
  return { child, messages, heard, said, closed }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ir-gpulock-'))
})

afterEach(async () => {
  release()
  for (const child of holders) child.kill('SIGKILL')
  for (const pid of standIns) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await Promise.all([...standIns].map(gone))
  standIns.clear()
  rmSync(dir, { recursive: true, force: true })
})

afterAll(async () => {
  for (let i = 0; i < 100 && leftovers().length > 0; i += 1) await sleep(20)
  expect(leftovers()).toEqual([])
})

describe('the GPU lock', () => {
  it('lives in the common dir, which every worktree and subdirectory resolves to', () => {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim()
    const expected = path.join(path.resolve(common), 'inertialref-gpu.lock')
    expect(lockPath()).toBe(expected)
    expect(lockPath(path.join(ROOT, 'scripts'))).toBe(expected)
    expect(path.isAbsolute(expected)).toBe(true)
  })

  it('creates the lock naming this process, and release removes it', async () => {
    const listening = process.listenerCount('SIGTERM')
    const lock = await acquire('vitest', { path: file() })
    const record = read()
    expect(record).toMatchObject({
      pid: process.pid,
      holder: 'vitest',
      cwd: process.cwd(),
      worktree: ROOT,
      processStart: startOf(process.pid),
    })
    expect(Date.now() - Date.parse(record.startedAt)).toBeLessThan(60_000)
    expect(record.processes).toEqual([
      expect.objectContaining({ pid: process.pid, role: 'holder' }),
    ])
    expect(record.token).toMatch(/^[0-9a-f]{32}$/)
    expect(lock).toMatchObject({
      path: file(),
      joined: false,
      env: { [TOKEN_ENV]: record.token },
    })
    expect(process.listenerCount('SIGTERM')).toBe(listening + 1)
    lock.release()
    expect(existsSync(file())).toBe(false)
    expect(process.listenerCount('SIGTERM')).toBe(listening)
  })

  it('refuses a second job at once, naming holder, pid, age and worktree', async () => {
    const other = holder({ holder: 'presets:compare', hold: true })
    const pid = await other.said('acquired')
    const asked = Date.now()
    const error = await acquire('test:gpu', { path: file() }).catch((e) => e)
    // P01's success line: a refused `test:gpu` exits within a second.
    expect(Date.now() - asked).toBeLessThan(1000)
    expect(error).toBeInstanceOf(GpuLockError)
    expect(error.code).toBe('busy')
    expect(error.message).toContain('presets:compare')
    expect(error.message).toContain(`pid ${pid}`)
    expect(error.message).toMatch(/for \d+ s\b/)
    expect(error.message).toContain(ROOT)
    expect(error.message).toMatch(/wait/i)
    expect(error.message).toMatch(/ask/i)
    expect(error.message).not.toContain('--down')
    expect(read().pid).toBe(pid)
  })

  it('reclaims a lock whose holder has exited', async () => {
    const dead = await deadPid()
    writeLock([{ pid: dead, processStart: 'Thu Jan 1 00:00:00 1970' }])
    const lock = await acquire('test:gpu', { path: file() })
    expect(read()).toMatchObject({ pid: process.pid, token: lock.token })
    expect(lock.token).not.toBe('f'.repeat(32))
  })

  it('reclaims a lock whose pid now belongs to another process', async () => {
    // This process is alive; only its recorded start time differs.
    writeLock([{ pid: process.pid, processStart: startOf(process.pid) }])
    const same = await acquire('test:gpu', { path: file() }).catch((e) => e)
    expect(same.code).toBe('busy')
    writeLock([{ pid: process.pid, processStart: 'Thu Jan 1 00:00:00 1970' }])
    const lock = await acquire('test:gpu', { path: file() })
    expect(read().token).toBe(lock.token)
  })

  it('refuses a lock in another format version rather than judging it stale', async () => {
    // A worktree on another branch can run another revision of the module
    // against the same file. Its processes cannot be named here, so a lock
    // older than the grace is still not this revision's to delete.
    const foreign = `${JSON.stringify({ version: 2, token: 'x', entries: [] })}\n`
    writeFileSync(file(), foreign)
    const past = Date.now() / 1000 - 60
    utimesSync(file(), past, past)
    const error = await acquire('test:gpu', { path: file() }).catch((e) => e)
    expect(error).toBeInstanceOf(GpuLockError)
    expect(error.code).toBe('busy')
    expect(error.message).toContain('format version 2')
    expect(readFileSync(file(), 'utf8')).toBe(foreign)
  })

  /*
   * A clock stepped back after a file was written leaves its mtime in the
   * future. Both waits spin synchronously, so a regression hangs the process
   * that takes the lock; it runs as a holder, which the test's timeout and
   * `afterEach` can end.
   */
  it.each([
    ['a torn lock', () => writeFileSync(file(), '')],
    [
      'a dead mutex beside a stale lock',
      async () => {
        writeLock([{ pid: await deadPid(), processStart: null }])
        writeFileSync(`${file()}.edit`, '')
        return `${file()}.edit`
      },
    ],
  ])('reclaims %s whose mtime is in the future', async (_what, setup) => {
    const target = (await setup()) ?? file()
    const future = Date.now() / 1000 + 3600
    utimesSync(target, future, future)
    const job = holder({ holder: 'test:gpu', hold: true })
    expect(await job.said('acquired')).toBe(job.child.pid)
    expect(pids(read())).toEqual([job.child.pid])
    job.child.stdin.end()
    await job.closed
  })

  it.each([
    ['a normal exit', null],
    ['SIGINT', 'SIGINT'],
    ['SIGTERM', 'SIGTERM'],
  ])(
    'is released on %s, and the holder still dies of its signal',
    async (_how, signal) => {
      const job = holder({ holder: 'test:gpu', hold: true })
      await job.said('ready')
      expect(read().pid).toBe(await job.said('acquired'))
      if (signal === null) job.child.stdin.end()
      else job.child.kill(signal)
      expect(await job.closed).toEqual(
        signal === null ? { code: 0, signal: null } : { code: null, signal },
      )
      expect(existsSync(file())).toBe(false)
    },
  )

  it.each([
    ['a free lock', async () => 0],
    [
      'a stale lock',
      async () => {
        writeLock([{ pid: await deadPid(), processStart: null }])
        return 0
      },
    ],
    /*
     * The interleaving a reclaim has to survive: the second racer reads the
     * stale lock, and by the time it has judged it, the first has deleted it
     * and created its own. A lock naming a hundred reused pids makes the
     * judgment a hundred `ps` calls long, and the second racer starts half a
     * judgment late, measured here so the margins scale with the machine.
     * Deleting without re-reading takes the first racer's lock and makes two
     * holders.
     */
    [
      'a stale lock one racer judges after the other replaced it',
      async () => {
        const reused = { pid: process.pid, processStart: 'Thu Jan 1 1970' }
        writeLock(Array.from({ length: 100 }, () => reused))
        const begun = process.hrtime.bigint()
        for (let i = 0; i < 10; i += 1) startOf(process.pid)
        const perPs = Number(process.hrtime.bigint() - begun) / 1e6 / 10
        return Math.round((100 * perPs) / 2)
      },
    ],
  ])(
    'lets exactly one of two racing processes take %s',
    async (_what, setup) => {
      const delay = await setup()
      const go = path.join(dir, 'go')
      const racers = [0, delay].map((wait, i) =>
        holder({ holder: `racer-${i}`, hold: true, go, delay: wait }),
      )
      await Promise.all(racers.map((racer) => racer.said('waiting')))
      writeFileSync(go, '')
      const outcomes = await Promise.all(
        racers.map((racer) => racer.heard('acquired', 'busy')),
      )
      expect(outcomes.filter((outcome) => 'acquired' in outcome)).toHaveLength(
        1,
      )
      const winner = racers[outcomes.findIndex((o) => 'acquired' in o)]
      const loser = racers.find((racer) => racer !== winner)
      expect(await loser.said('code')).toBe('busy')
      expect(await loser.said('busy')).toContain(`pid ${winner.child.pid}`)
      expect((await loser.closed).code).toBe(1)
      expect(pids(read())).toEqual([winner.child.pid])
      winner.child.stdin.end()
      await winner.closed
      expect(existsSync(file())).toBe(false)
    },
  )

  it('lets a child carrying the holder token in, and refuses any other token', async () => {
    const lock = await acquire('presets:compare', { path: file() })
    const child = holder(
      { holder: 'drive.mjs', chrome: true, hold: true },
      lock.env,
    )
    expect(await child.said('joined')).toBe(true)
    const chrome = await child.said('chrome')
    await child.said('ready')
    expect(read().token).toBe(lock.token)
    expect(pids(read())).toEqual([process.pid, child.child.pid, chrome])
    child.child.stdin.end()
    await child.closed
    // The child's exit removes its own entry, never the Chrome it launched.
    expect(pids(read())).toEqual([process.pid, chrome])

    const forged = holder(
      { holder: 'drive.mjs' },
      { [TOKEN_ENV]: '0'.repeat(32) },
    )
    const plain = holder({ holder: 'drive.mjs' })
    for (const refused of [forged, plain]) {
      expect(await refused.said('code')).toBe('busy')
      expect(await refused.said('busy')).toContain(`pid ${process.pid}`)
      expect((await refused.closed).code).toBe(1)
    }
    expect(pids(read())).toEqual([process.pid, chrome])

    lock.release()
    expect(pids(read())).toEqual([chrome])
    expect(forget(chrome, { path: file(), token: lock.token })).toBe(true)
    expect(existsSync(file())).toBe(false)
  })

  it('stays held for a Chrome that outlives its killed holder', async () => {
    const job = holder({ holder: 'drive.mjs', chrome: true, hold: true })
    const chrome = await job.said('chrome')
    await job.said('ready')
    job.child.kill('SIGKILL')
    await job.closed
    const error = await acquire('test:gpu', { path: file() }).catch((e) => e)
    expect(error.code).toBe('busy')
    expect(error.message).toContain(`pid ${chrome}`)
    process.kill(chrome, 'SIGKILL')
    await gone(chrome)
    const lock = await acquire('test:gpu', { path: file() })
    expect(read()).toMatchObject({ pid: process.pid, token: lock.token })
  })

  /*
   * vitest's main process holds the lock for `pnpm test:gpu`, and its fork
   * workers hold the Dawn devices. A fork outlives a SIGTERM or SIGKILL of
   * the main process by seconds — about 20 s, running a 30 s test — so a
   * holder ended without its teardown has to leave the lock to them.
   */
  it.each([
    ['SIGTERM', 'SIGTERM'],
    ['SIGINT', 'SIGINT'],
    ['an exit before its release', null],
  ])(
    'keeps the lock for the workers of a holder ended by %s',
    async (_how, signal) => {
      const job = holder({
        holder: 'test:gpu',
        keepChildren: true,
        worker: true,
        hold: true,
      })
      const worker = await job.said('worker')
      await job.said('ready')
      if (signal === null) job.child.stdin.end()
      else job.child.kill(signal)
      expect(await job.closed).toEqual(
        signal === null ? { code: 0, signal: null } : { code: null, signal },
      )
      expect(pids(read())).toEqual([worker])
      const error = await acquire('test:gpu', { path: file() }).catch((e) => e)
      expect(error.code).toBe('busy')
      expect(error.message).toContain(
        `pid ${worker} (child, recorded by test:gpu)`,
      )
      process.kill(worker, 'SIGKILL')
      await gone(worker)
      const lock = await acquire('test:gpu', { path: file() })
      expect(read().token).toBe(lock.token)
    },
  )

  it('lets go entirely when the holder releases before it exits, whatever its workers do', async () => {
    const job = holder({
      holder: 'test:gpu',
      keepChildren: true,
      worker: true,
      hold: true,
      releaseFirst: true,
    })
    const worker = await job.said('worker')
    await job.said('ready')
    job.child.stdin.end()
    expect(await job.closed).toEqual({ code: 0, signal: null })
    expect(existsSync(file())).toBe(false)
    expect(exists(worker)).toBe(true)
  })

  it.each([
    ['exits normally', null],
    ['is sent SIGTERM', 'SIGTERM'],
  ])(
    'outlives a parent that %s while its child Chrome is up',
    async (_how, signal) => {
      const parent = holder({
        holder: 'presets:plates',
        hold: signal !== null,
        child: { holder: 'drive.mjs', chrome: true },
      })
      const chrome = await parent.said('chrome')
      expect(await parent.said('childExited')).toBe(0)
      expect(parent.messages).toContainEqual({
        acquired: expect.any(Number),
        joined: true,
      })
      if (signal !== null) parent.child.kill(signal)
      expect(await parent.closed).toEqual(
        signal === null ? { code: 0, signal: null } : { code: null, signal },
      )
      expect(pids(read())).toEqual([chrome])
      const error = await acquire('test:gpu', { path: file() }).catch((e) => e)
      expect(error.code).toBe('busy')
      expect(error.message).toContain(`pid ${chrome}`)
      process.kill(chrome, 'SIGKILL')
      await gone(chrome)
      const lock = await acquire('test:gpu', { path: file() })
      expect(read().token).toBe(lock.token)
    },
  )

  it('queues under waitMs, reprints the holder, and starts within a poll of its release', async () => {
    const other = holder({ holder: 'presets:compare', hold: true })
    const pid = await other.said('acquired')
    const lines = []
    const waiting = acquire('test:gpu', {
      path: file(),
      waitMs: 10_000,
      pollMs: 20,
      reprintMs: 100,
      say: (line) => lines.push(line),
    })
    await sleep(450)
    other.child.stdin.end()
    const freed = other.closed.then(() => Date.now())
    const lock = await waiting
    const started = Date.now()
    expect(read().token).toBe(lock.token)
    // Twenty-millisecond polls; the second is the slack a loaded suite needs
    // between the holder's release and its `close` reaching this process.
    expect(Math.abs(started - (await freed))).toBeLessThan(1000)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(line).toContain(`pid ${pid}`)
      expect(line).not.toContain('--down')
    }
  })

  it('names the holder without taking the lock, and reads a free or stale one as nobody', async () => {
    expect(holding({ path: file() })).toBeNull()
    // A read reclaims nothing: deleting a stale lock outside the edit mutex
    // is the race the mutex exists to close.
    writeLock([{ pid: await deadPid(), processStart: null }])
    const stale = readFileSync(file(), 'utf8')
    expect(holding({ path: file() })).toBeNull()
    expect(readFileSync(file(), 'utf8')).toBe(stale)
    // Between a create's open and its write the file is empty, and inside the
    // grace that is a job taking the lock, not nobody.
    writeFileSync(file(), '')
    expect(holding({ path: file() })).toEqual({
      token: null,
      text: expect.stringContaining('being taken'),
    })
    rmSync(file())

    const other = holder({ holder: 'presets:compare', hold: true })
    const pid = await other.said('acquired')
    const before = readFileSync(file(), 'utf8')
    const held = holding({ path: file() })
    expect(held.token).toBe(read().token)
    expect(held.text).toContain('presets:compare')
    expect(held.text).toContain(`pid ${pid}`)
    expect(held.text).toContain(ROOT)
    expect(held.text).not.toContain('--down')
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('reads a wait in seconds, and refuses anything that is not a count of them', () => {
    expect(parseWait(undefined, '--gpu-wait')).toBe(0)
    expect(parseWait('', 'IR_GPU_WAIT')).toBe(0)
    expect(parseWait('0', '--gpu-wait')).toBe(0)
    expect(parseWait('90', '--gpu-wait')).toBe(90_000)
    expect(parseWait('2.5', '--gpu-wait')).toBe(2_500)
    // `1e3` and `5s` are the two a person types expecting a unit: refused, so
    // a wait is never a thousand times what was meant.
    for (const bad of ['-1', 'ten', '1e3', '5s', 'Infinity', ' '])
      expect(() => parseWait(bad, 'IR_GPU_WAIT')).toThrow(
        new RegExp(`IR_GPU_WAIT takes seconds.*'${bad}'`),
      )
  })

  it("puts the caller's way to queue in a refusal, and never --down", async () => {
    const other = holder({ holder: 'drive.mjs (port 9333)', hold: true })
    await other.said('acquired')
    const error = await acquire('test:gpu', {
      path: file(),
      hint: 'IR_GPU_WAIT=<seconds> pnpm test:gpu queues for it.',
    }).catch((e) => e)
    expect(error.code).toBe('busy')
    expect(error.message).toContain('drive.mjs (port 9333)')
    expect(error.message.split('\n').at(-1)).toBe(
      'IR_GPU_WAIT=<seconds> pnpm test:gpu queues for it.',
    )
    expect(error.message).not.toContain('--down')
  })

  it('gives up when waitMs runs out, still naming the holder', async () => {
    const other = holder({ holder: 'presets:compare', hold: true })
    const pid = await other.said('acquired')
    const asked = Date.now()
    const error = await acquire('test:gpu', {
      path: file(),
      waitMs: 200,
      pollMs: 20,
      say: () => {},
    }).catch((e) => e)
    expect(Date.now() - asked).toBeGreaterThanOrEqual(200)
    expect(error.code).toBe('busy')
    expect(error.message).toContain(`pid ${pid}`)
    expect(error.message).toMatch(/waited 0\.2 s/i)
  })

  it('fails closed, naming the cause, when the lock cannot be created', async () => {
    const missing = path.join(dir, 'no-such-dir', 'inertialref-gpu.lock')
    const error = await acquire('test:gpu', { path: missing }).catch((e) => e)
    expect(error).toBeInstanceOf(GpuLockError)
    expect(error.code).toBe('unwritable')
    expect(error.message).toContain('ENOENT')
    expect(error.message).toContain(missing)
  })

  // Root ignores the mode bits, so the case only means something as a user.
  it.skipIf(process.getuid?.() === 0)(
    'fails closed on a common dir it cannot write',
    async () => {
      const readOnly = path.join(dir, 'read-only')
      mkdirSync(readOnly)
      chmodSync(readOnly, 0o500)
      try {
        const target = path.join(readOnly, 'inertialref-gpu.lock')
        const error = await acquire('test:gpu', { path: target }).catch(
          (e) => e,
        )
        expect(error.code).toBe('unwritable')
        expect(error.message).toContain('EACCES')
        expect(error.message).toContain(target)
      } finally {
        chmodSync(readOnly, 0o700)
      }
    },
  )
})
