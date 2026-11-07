import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { release } from './gpuLock.mjs'
import { holdForSuite, suiteSetup } from './gpuSuiteLock.mjs'

const MODULE = new URL('./gpuLock.mjs', import.meta.url).href
const SUITE = new URL('./gpuSuiteLock.mjs', import.meta.url).href
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

let dir
const file = () => path.join(dir, 'inertialref-gpu.lock')
const read = () => JSON.parse(readFileSync(file(), 'utf8'))
const others = new Set()
const workers = new Set()

/** Another job on the GPU, as a process of its own, holding the test's lock
 *  until its stdin closes. */
async function otherJob(holder) {
  const program = `
    const { acquire } = await import(${JSON.stringify(MODULE)})
    await acquire(${JSON.stringify(holder)}, { path: ${JSON.stringify(file())} })
    process.stdout.write('held\\n')
    process.stdin.on('end', () => process.exit(0))
    process.stdin.resume()`
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', program],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  others.add(child)
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', reject)
  })
  const closed = new Promise((resolve) => child.once('exit', resolve))
  return { pid: child.pid, finish: () => (child.stdin.end(), closed) }
}

/**
 * The suite's main process as a process of its own, with one fork worker,
 * so a test can end it the way a timeout does and see what the lock keeps.
 */
async function suite() {
  const program = `
    import { spawn } from 'node:child_process'
    const { holdForSuite } = await import(${JSON.stringify(SUITE)})
    await holdForSuite({ path: ${JSON.stringify(file())}, env: {} })
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' })
    process.stdout.write(worker.pid + '\\n')
    setInterval(() => {}, 1e9)`
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', program],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  others.add(child)
  const worker = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk))))
    child.once('exit', reject)
  })
  workers.add(worker)
  const closed = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  )
  return { child, worker, closed }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ir-gpusuite-'))
})

afterEach(() => {
  release()
  for (const child of others) child.kill('SIGKILL')
  others.clear()
  for (const pid of workers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  workers.clear()
  rmSync(dir, { recursive: true, force: true })
})

describe("pnpm test:gpu's hold on the GPU lock", () => {
  it('takes the lock as test:gpu, from its worktree, and its teardown releases it', async () => {
    const teardown = await holdForSuite({ path: file(), env: {} })
    expect(read()).toMatchObject({
      holder: 'test:gpu',
      pid: process.pid,
      worktree: ROOT,
    })
    teardown()
    expect(existsSync(file())).toBe(false)
  })

  it('fails fast beside another job, naming it and the variable that queues', async () => {
    const rig = await otherJob('drive.mjs (port 9333)')
    const asked = Date.now()
    const error = await holdForSuite({ path: file(), env: {} }).catch((e) => e)
    expect(Date.now() - asked).toBeLessThan(1000)
    expect(error.code).toBe('busy')
    expect(error.message).toContain(`drive.mjs (port 9333) has held the GPU`)
    expect(error.message).toContain(`pid ${rig.pid}`)
    expect(error.message).toMatch(
      /IR_GPU_WAIT=<seconds> pnpm test:gpu queues for it\.$/,
    )
    expect(error.message).not.toContain('--down')
  })

  it('queues under IR_GPU_WAIT and starts within one poll of the release', async () => {
    const rig = await otherJob('drive.mjs (port 9333)')
    let started = null
    const lines = []
    const waiting = holdForSuite({
      path: file(),
      env: { IR_GPU_WAIT: '20' },
      say: (line) => lines.push(line),
    }).then((teardown) => {
      started = Date.now()
      return teardown
    })
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(started).toBeNull()
    expect(lines[0]).toContain(`drive.mjs (port 9333) has held the GPU`)
    await rig.finish()
    const freed = Date.now()
    const teardown = await waiting
    // The default poll is 500 ms; the rest is a loaded suite's slack.
    expect(started - freed).toBeLessThan(1000)
    expect(read()).toMatchObject({ holder: 'test:gpu', pid: process.pid })
    teardown()
    expect(existsSync(file())).toBe(false)
  })

  /*
   * vitest reports a throw from globalSetup as "No test files found", with
   * the include pattern, then the error with the lock serialized under it:
   * a reader is sent to the config. The refusal is the whole answer.
   */
  it('ends the run with the refusal alone, and passes any other failure to vitest', async () => {
    await otherJob('drive.mjs (port 9333)')
    const written = []
    const exits = []
    const outcome = await suiteSetup({
      path: file(),
      env: {},
      write: (text) => written.push(text),
      exit: (code) => exits.push(code),
    })
    expect(outcome).toBeUndefined()
    expect(exits).toEqual([1])
    expect(written.join('')).toMatch(
      /^\nGPU busy\. drive\.mjs \(port 9333\) has held the GPU[^]*queues for it\.\n$/,
    )
    await expect(
      suiteSetup({
        path: file(),
        env: { IR_GPU_WAIT: '2m' },
        write: (text) => written.push(text),
        exit: (code) => exits.push(code),
      }),
    ).rejects.toThrow('IR_GPU_WAIT takes seconds')
    expect(exits).toEqual([1])
  })

  it('leaves the lock to its fork workers when a timeout ends it with SIGTERM', async () => {
    const run = await suite()
    run.child.kill('SIGTERM')
    expect(await run.closed).toEqual({ code: null, signal: 'SIGTERM' })
    expect(read().processes.map((entry) => entry.pid)).toEqual([run.worker])
    const error = await holdForSuite({ path: file(), env: {} }).catch((e) => e)
    expect(error.message).toContain(
      `pid ${run.worker} (child, recorded by test:gpu)`,
    )
  })

  it('refuses an IR_GPU_WAIT that is not seconds before it asks for the lock', async () => {
    const error = await holdForSuite({
      path: file(),
      env: { IR_GPU_WAIT: '2m' },
    }).catch((e) => e)
    expect(error.message).toContain('IR_GPU_WAIT takes seconds')
    expect(existsSync(file())).toBe(false)
  })
})
