import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openSession, measureHeightfieldSource } from '@inertialref/devtools'
import {
  findBody,
  generateHeightfield,
  parseAddress,
  regionAddress,
} from '@inertialref/universe'
import { HeightfieldArchive } from '@inertialref/workers'
import { loadStarCatalog } from './catalog.ts'
import { DiskHeightfieldStore } from '@inertialref/workers/node'

it('replays canonical terrain outside Sol from disk without touching the world or generator', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ir-generated-terrain-'))
  const session = openSession({
    seed: 'inertialref',
    catalog: loadStarCatalog(),
    workers: null,
  })
  const store = new DiskHeightfieldStore({ directory })
  const restored = new DiskHeightfieldStore({ directory })
  try {
    const parsed = parseAddress('g:milky-way/s:HIP70890/b:0')
    if (parsed.kind !== 'body') throw new Error('body fixture')
    const body = findBody(session.world.loadSystem(parsed.system), parsed.body)!
    const hash = session.world.stateHash()
    const generate = vi.fn((surface, request) => ({
      id: 1,
      result: Promise.resolve(generateHeightfield(surface, request)),
      cancel() {},
    }))
    const source = {
      kind: 'pool',
      archive: 'cpu@test',
      available: true,
      submit: generate,
    }
    const coldArchive = new HeightfieldArchive(store)
    const cold = coldArchive.wrap(source)
    const regions = [regionAddress(0, 6, 0, 0), regionAddress(1, 6, 0, 0)]
    let clock = 0
    const report = await measureHeightfieldSource(
      body,
      regions,
      () => ++clock,
      cold,
      3,
    )
    await coldArchive.close()
    expect(report).toMatchObject({ patches: 2, totalMs: 1, samples: 98 })
    expect(generate).toHaveBeenCalledTimes(2)
    // A second process: a new archive over the same file.
    const warmArchive = new HeightfieldArchive(restored)
    const warm = warmArchive.wrap(source)
    await measureHeightfieldSource(body, regions, () => ++clock, warm, 3)
    expect(warmArchive.stats()).toMatchObject({ hits: 2, misses: 0 })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(session.world.stateHash()).toBe(hash)
  } finally {
    store.close()
    restored.close()
    session.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
