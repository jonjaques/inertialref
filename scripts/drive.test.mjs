import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
const run = (args, options = {}) =>
  promisify(execFile)(
    process.execPath,
    [DRIVE, '--port', '9', '--url', 'http://127.0.0.1:9/', ...args],
    options,
  ).then(
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

  it('takes --tree as a session flag, before anything starts', async () => {
    const { code, stdout } = await run([
      '--tree',
      '/Users/agent/inertialref',
      '--print-url',
    ])
    expect(code).toBe(0)
    expect(stdout).toMatch(
      /^http:\/\/127\.0\.0\.1:9\/\?presentation=occluded$/m,
    )
  })

  /*
   * `path.resolve('')` is the shell's directory, so an unset variable in
   * `--tree "$TREE"` would hold the page against wherever the shell is: a
   * false refusal from a scratch thread, a false match from a sibling.
   */
  it('refuses an empty --tree before anything starts', async () => {
    const { code, stderr } = await run([
      '--no-serve',
      '--tree',
      '',
      '--js',
      '1',
    ])
    expect(code).toBe(1)
    expect(stderr).toContain(
      "--tree takes the checkout --url must be served from, and '' names none; leave it out to hold the page against this checkout",
    )
  })

  it("reads its own checkout's lock when the shell is outside every repository", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'ir-drive-'))
    try {
      const { code, stdout } = await run(['--status'], { cwd: outside })
      expect(code).toBe(0)
      expect(stdout).toMatch(
        /^gpu {7}(free|held for this rig\.|held by another job\.)/m,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
