import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capturePlates } from './capture.mjs'

/*
 * The capture's one precondition, checked without a browser. A capture with
 * no lock of its caller's would spawn drive.mjs children that each take the
 * machine's lock on their own, so the refusal has to come before the first
 * spawn and before the output directory exists.
 */
let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ir-capture-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('capturePlates and the GPU lock', () => {
  it("refuses to drive anything without its caller's lock", async () => {
    const out = path.join(dir, 'plates')
    await expect(
      capturePlates({
        origin: 'http://127.0.0.1:9/',
        port: '9',
        out,
        pictures: [],
      }),
    ).rejects.toThrow(/runs under its caller's GPU lock/)
    expect(existsSync(out)).toBe(false)
  })
})

/*
 * Each drive.mjs child holds the page against the tree it is given, so a
 * capture that named none would hold the base tree's page against this
 * driver's own checkout and refuse every `--base` plate, or, given a default,
 * hold it against the wrong one silently.
 */
describe('capturePlates and the served tree', () => {
  it('refuses to drive anything without the tree its origin serves', async () => {
    const out = path.join(dir, 'plates')
    await expect(
      capturePlates({
        origin: 'http://127.0.0.1:9/',
        port: '9',
        out,
        pictures: [],
        lock: { env: {} },
      }),
    ).rejects.toThrow(/needs the tree its origin serves/)
    expect(existsSync(out)).toBe(false)
  })
})
