import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOKEN_ENV, acquire, release } from './gpuLock.mjs'
import {
  adopt,
  closeChrome,
  driver,
  drivers,
  gpuLine,
  keep,
  launched,
  readSession,
  rigLeft,
  sessionPath,
  takeGpu,
} from './driveLock.mjs'

/** Every stand-in carries this in its argv, so `pgrep -f` can prove that none
 *  of them outlived the file. */
const MARK = `drivelock-test-${process.pid}`
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let dir
const file = () => path.join(dir, 'inertialref-gpu.lock')
const read = () => JSON.parse(readFileSync(file(), 'utf8'))
const pids = () => read().processes.map((entry) => entry.pid)
const standIns = new Set()

/**
 * A detached process standing in for the rig's Chrome, once it is running.
 * `stubborn` ignores SIGTERM, as a wedged Chrome can, so only SIGKILL ends
 * it. It says so once its listener is set: a SIGTERM that lands before node
 * has run a line kills it however stubborn it was asked to be.
 */
async function chrome({ stubborn = false } = {}) {
  const body = `${stubborn ? "process.on('SIGTERM', () => {});" : ''}process.stdout.write('up\\n');setInterval(() => {}, 1e9)`
  const child = spawn(process.execPath, ['-e', body, MARK], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  standIns.add(child.pid)
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', reject)
  })
  child.stdout.destroy()
  child.unref()
  return child.pid
}

/** The start time the way the lock and the session record it, in the pinned
 *  locale and zone. */
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

/**
 * What a drive.mjs invocation leaves when it exits: a lock naming only the
 * Chrome it recorded, under the token its session state keeps.
 */
async function rigLeftUp(options) {
  const pid = await chrome(options)
  const lock = await acquire('drive.mjs (port 9400)', { path: file() })
  lock.record(pid)
  lock.release()
  expect(pids()).toEqual([pid])
  return { chrome: pid, token: lock.token }
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

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ir-drivelock-'))
})

afterEach(async () => {
  release()
  for (const pid of standIns) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  standIns.clear()
  rmSync(dir, { recursive: true, force: true })
})

afterAll(async () => {
  for (let i = 0; i < 100 && leftovers().length > 0; i += 1) await sleep(20)
  expect(leftovers()).toEqual([])
})

describe('the rig and the GPU lock', () => {
  it('takes a free lock for the invocation, naming the rig and its worktree', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      env: {},
    })
    expect(lock.joined).toBe(false)
    expect(read()).toMatchObject({
      holder: 'drive.mjs (port 9400)',
      pid: process.pid,
      worktree: ROOT,
      token: lock.token,
    })
  })

  it("joins the lock its port's session recorded, so a second invocation is not refused by the first", async () => {
    const rig = await rigLeftUp()
    // A token left in the shell's environment by something else is no
    // reason to refuse the rig its own lock.
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      state: { chromePid: rig.chrome, gpuToken: rig.token },
      env: { [TOKEN_ENV]: 'e'.repeat(32) },
    })
    expect(lock).toMatchObject({ joined: true, token: rig.token })
    expect(pids()).toEqual([rig.chrome, process.pid])
    // The invocation's exit drops its own entry and never the Chrome.
    lock.release()
    expect(pids()).toEqual([rig.chrome])
  })

  it("joins a parent's lock under the token it handed down, past a session token from a rig long gone", async () => {
    // The parent's lock, as a preset command holds it while its first
    // capture's Chrome is up.
    const parent = await rigLeftUp()
    const child = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      state: { gpuToken: 'f'.repeat(32) },
      env: { [TOKEN_ENV]: parent.token },
    })
    expect(child).toMatchObject({ joined: true, token: parent.token })
    expect(pids()).toEqual([parent.chrome, process.pid])
  })

  it('takes the lock fresh when the session names a lock that is gone, and never under that token', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      state: { gpuToken: 'f'.repeat(32) },
      env: {},
    })
    expect(lock.joined).toBe(false)
    expect(lock.token).not.toBe('f'.repeat(32))
  })

  it('refuses beside another job, naming it with the way to queue, even holding a token of its own', async () => {
    const other = await rigLeftUp()
    const asked = Date.now()
    const error = await takeGpu('drive.mjs (port 9401)', {
      path: file(),
      state: { gpuToken: 'f'.repeat(32) },
      env: { [TOKEN_ENV]: 'e'.repeat(32) },
      hint: '--gpu-wait <seconds> queues for it.',
    }).catch((e) => e)
    expect(Date.now() - asked).toBeLessThan(1000)
    expect(error.code).toBe('busy')
    expect(error.message).toContain('drive.mjs (port 9400)')
    expect(error.message).toContain(`pid ${other.chrome} (chrome`)
    expect(error.message).toMatch(/--gpu-wait <seconds> queues for it\.$/)
    expect(error.message).not.toContain('--down')
    expect(pids()).toEqual([other.chrome])
  })

  it('keeps the lock for a Chrome past the invocation, and fails loudly when the lock is no longer its own', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      env: {},
    })
    const pid = await chrome()
    keep(lock, pid)
    expect(pids()).toEqual([process.pid, pid])
    lock.release()
    expect(pids()).toEqual([pid])
    // Another lock where this one was: a Chrome recorded into nothing would
    // render unlocked, so the rig hears about it rather than carrying on.
    writeFileSync(
      file(),
      `${JSON.stringify({ ...read(), token: 'e'.repeat(32) })}\n`,
    )
    expect(() => keep(lock, pid)).toThrow(/GPU lock .* no longer this rig's/)
  })

  it('takes over the Chrome of a rig that predates the lock, and holds for it until --down', async () => {
    // What a drive.mjs from before the lock leaves on a port: a Chrome up,
    // and a session naming it with no token.
    const old = await chrome()
    const state = { chromePid: old, colorProfile: null }
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      state,
      env: {},
    })
    expect(lock.joined).toBe(false)
    expect(adopt(lock, state)).toMatchObject({ chromePid: old })
    expect(pids()).toEqual([process.pid, old])
    // The invocation exits; the Chrome it took over keeps the lock.
    lock.release()
    expect(pids()).toEqual([old])
    expect(gpuLine({ gpuToken: lock.token }, { path: file() })).toMatch(
      /^held for this rig\./,
    )
    expect(
      await closeChrome(old, { path: file(), token: lock.token }),
    ).toMatchObject({ closed: true, released: true })
    expect(existsSync(file())).toBe(false)
  })

  it('holds for an attach with no recorded pid only while the invocation runs', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      env: {},
    })
    expect(adopt(lock, {})).toMatchObject({ chromePid: null })
    expect(pids()).toEqual([process.pid])
  })

  it('ends a Chrome it launched that the lock will not record, rather than leave it rendering unlocked', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      env: {},
    })
    const pid = await chrome()
    expect(launched(lock, pid)).toMatchObject({
      chromePid: pid,
      gpuToken: lock.token,
    })
    expect(pids()).toEqual([process.pid, pid])
    // Another lock where this one was, before the next launch records into it.
    const next = await chrome()
    writeFileSync(
      file(),
      `${JSON.stringify({ ...read(), token: 'e'.repeat(32) })}\n`,
    )
    expect(() => launched(lock, next)).toThrow(/no longer this rig's/)
    for (let i = 0; i < 100 && exists(next); i += 1) await sleep(20)
    expect(exists(next)).toBe(false)
  })

  it('closes the Chrome before releasing it, so the GPU is free when the lock says so', async () => {
    const rig = await rigLeftUp({ stubborn: true })
    const closing = closeChrome(rig.chrome, {
      path: file(),
      token: rig.token,
      start: startOf(rig.chrome),
      graceMs: 400,
    })
    await sleep(200)
    // Still inside the grace: SIGTERM was ignored, and the lock still holds.
    expect(exists(rig.chrome)).toBe(true)
    expect(pids()).toEqual([rig.chrome])
    expect(await closing).toEqual({
      closed: true,
      released: true,
      reused: false,
    })
    expect(exists(rig.chrome)).toBe(false)
    expect(existsSync(file())).toBe(false)
  })

  it('signals nothing whose pid now names another process, and only drops it from the lock', async () => {
    // The session's start time is not the one its pid has now: the machine
    // rebooted, or the Chrome died and its pid went to something else.
    const rig = await rigLeftUp()
    const result = await closeChrome(rig.chrome, {
      path: file(),
      token: rig.token,
      start: 'Thu Jan 1 00:00:00 1970',
      graceMs: 200,
    })
    await sleep(100)
    expect(exists(rig.chrome)).toBe(true)
    expect(result).toMatchObject({ closed: false, released: true })
    expect(existsSync(file())).toBe(false)
  })

  it('kills only a Chrome whose start time the session recorded, and the lock holds while one lives', async () => {
    // A session with no start time gets the SIGTERM a drive.mjs from before
    // the lock sent, and never the SIGKILL after it: its pid is unproven.
    const rig = await rigLeftUp({ stubborn: true })
    const result = await closeChrome(rig.chrome, {
      path: file(),
      token: rig.token,
      graceMs: 300,
    })
    expect(exists(rig.chrome)).toBe(true)
    expect(result).toMatchObject({ closed: false, released: false })
    expect(pids()).toEqual([rig.chrome])
  })

  it('records when the Chrome it holds for started, so --down can tell it from a reused pid', async () => {
    const lock = await takeGpu('drive.mjs (port 9400)', {
      path: file(),
      env: {},
    })
    const fresh = await chrome()
    expect(launched(lock, fresh)).toEqual({
      chromePid: fresh,
      chromeStart: startOf(fresh),
      gpuToken: lock.token,
    })
    // A session from before this field gets it when its Chrome is taken
    // over, and a session that has it keeps the one it has.
    const old = await chrome()
    expect(adopt(lock, { chromePid: old })).toEqual({
      chromePid: old,
      chromeStart: startOf(old),
    })
    expect(adopt(lock, { chromePid: old, chromeStart: 'kept' })).toEqual({
      chromePid: old,
      chromeStart: 'kept',
    })
  })

  it('is never refused: it closes its Chrome beside another job and leaves that lock alone', async () => {
    const other = await rigLeftUp()
    const before = readFileSync(file(), 'utf8')
    const mine = await chrome()
    expect(
      await closeChrome(mine, { path: file(), token: 'f'.repeat(32) }),
    ).toEqual({ closed: true, released: false, reused: false })
    expect(exists(mine)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(exists(other.chrome)).toBe(true)
  })

  it('closes the Chrome of a rig that predates the lock and touches no lock', async () => {
    const other = await rigLeftUp()
    const before = readFileSync(file(), 'utf8')
    const old = await chrome()
    expect(await closeChrome(old, { path: file() })).toEqual({
      closed: true,
      released: false,
      reused: false,
    })
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(await closeChrome(old, { path: file() })).toEqual({
      closed: false,
      released: false,
      reused: false,
    })
    expect(exists(other.chrome)).toBe(true)
  })

  it("says whether the GPU is free, this rig's, or another job's", async () => {
    expect(gpuLine({}, { path: file() })).toBe('free')
    const rig = await rigLeftUp()
    const ours = gpuLine({ gpuToken: rig.token }, { path: file() })
    expect(ours).toMatch(
      /^held for this rig\. drive\.mjs \(port 9400\) has held/,
    )
    const theirs = gpuLine({ gpuToken: 'f'.repeat(32) }, { path: file() })
    expect(theirs).toMatch(/^held by another job\. drive\.mjs \(port 9400\)/)
    expect(theirs).toContain(`pid ${rig.chrome}`)
    expect(theirs).not.toContain('--down')
  })

  it('says a rig left up holds the lock, for a command that drove it, and nothing when none does', async () => {
    const rig = path.join(dir, 'drive')
    mkdirSync(rig)
    const left = () => rigLeft(9400, { rig, path: file() })
    const session = (fields) =>
      writeFileSync(sessionPath(9400, rig), `${JSON.stringify(fields)}\n`)
    expect(await left()).toBeNull()
    const up = await rigLeftUp()
    session({
      chromePid: up.chrome,
      chromeStart: startOf(up.chrome),
      gpuToken: up.token,
    })
    expect(await left()).toBe(
      'The rig on port 9400 holds the GPU lock until node scripts/drive.mjs --port 9400 --down.',
    )
    // A session whose token is not the live lock's claims nothing.
    session({ chromePid: up.chrome, gpuToken: 'f'.repeat(32) })
    expect(await left()).toBeNull()
    // Nor does one whose Chrome has exited, which leaves the lock stale.
    session({ chromePid: up.chrome, gpuToken: up.token })
    process.kill(up.chrome, 'SIGKILL')
    for (let i = 0; i < 100 && exists(up.chrome); i += 1) await sleep(20)
    expect(await left()).toBeNull()
  })

  it('reads a session by port, and none for a port no rig has used', async () => {
    const rig = path.join(dir, 'drive')
    expect(sessionPath(9400, rig)).toBe(path.join(rig, 'session-9400.json'))
    expect(await readSession(9400, rig)).toBeNull()
    mkdirSync(rig)
    writeFileSync(sessionPath(9400, rig), '{"gpuToken":"abc","chromePid":7}\n')
    expect(await readSession(9400, rig)).toEqual({
      gpuToken: 'abc',
      chromePid: 7,
    })
  })
})

/*
 * `--status` sets the page's metrics and, when its socket closes, Chrome
 * clears the page's device emulation for every session, so it must know
 * whether an invocation is driving the page before it touches it.
 */
describe('the invocations driving the rig’s page', () => {
  it('lists this process with the start time --down checks a pid by', () => {
    expect(driver()).toEqual({ pid: process.pid, start: startOf(process.pid) })
  })

  it('keeps a driver that is still running and drops one that has exited or whose pid is reused', async () => {
    const running = await chrome()
    const exited = await chrome()
    process.kill(exited, 'SIGKILL')
    for (let i = 0; i < 100 && exists(exited); i += 1) await sleep(20)
    const state = {
      drivers: [
        { pid: running, start: startOf(running) },
        { pid: exited, start: 'Sat Nov  7 20:00:00 2026' },
        // A pid that names another process now: a crashed invocation's,
        // given to whatever started after it.
        { pid: process.pid, start: 'Thu Jan  1 00:00:00 1970' },
      ],
    }
    expect(drivers(state)).toEqual([{ pid: running, start: startOf(running) }])
    expect(drivers({})).toEqual([])
    expect(drivers(null)).toEqual([])
  })
})
