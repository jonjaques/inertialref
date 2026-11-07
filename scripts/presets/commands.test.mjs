import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

/*
 * The two preset commands that photograph, run as processes. A wait that is
 * not seconds is refused before the lock is asked for and before any server
 * or browser starts, so nothing here draws: the refusal comes ahead of
 * compare's own plate reads, which need ImageMagick, and of every capture.
 */
const run = (script, args) =>
  promisify(execFile)(process.execPath, [
    fileURLToPath(new URL(script, import.meta.url)),
    ...args,
  ]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    ({ code, stdout, stderr }) => ({ code, stdout, stderr }),
  )

describe('the preset commands and the GPU lock', () => {
  it.each(['./compare.mjs', './plates.mjs'])(
    '%s refuses a --gpu-wait that is not seconds, before anything starts',
    async (script) => {
      const { code, stdout, stderr } = await run(script, [
        '--gpu-wait',
        '2m',
        'earthrise',
      ])
      expect(code).toBe(1)
      expect(stderr).toContain(
        "--gpu-wait takes seconds to wait for the GPU, as a plain number, not '2m'",
      )
      expect(stdout).toBe('')
    },
  )
})
