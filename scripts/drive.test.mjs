import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/*
 * The command line, run as a process. Neither case launches Chrome or takes
 * the lock: a wait that is not seconds is refused before the lock is asked
 * for, and `--status` only reads it. Port 9 and its URL answer nothing, so
 * no rig of anyone's is attached to.
 */
const DRIVE = fileURLToPath(new URL('./drive.mjs', import.meta.url))
const run = (args) =>
  promisify(execFile)(process.execPath, [
    DRIVE,
    '--port',
    '9',
    '--url',
    'http://127.0.0.1:9/',
    ...args,
  ]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  )

describe('drive.mjs and the GPU lock', () => {
  it('refuses a --gpu-wait that is not seconds, before anything starts', async () => {
    const { code, stderr } = await run([
      '--no-serve',
      '--gpu-wait',
      '5s',
      '--js',
      '1',
    ])
    expect(code).toBe(1)
    expect(stderr).toContain(
      "--gpu-wait takes seconds to wait for the GPU, as a plain number, not '5s'",
    )
  })

  it('names who holds the GPU in --status', async () => {
    const { code, stdout } = await run(['--status'])
    expect(code).toBe(0)
    expect(stdout).toMatch(
      /^gpu {7}(free|held for this rig\.|held by another job\.)/m,
    )
  })
})
