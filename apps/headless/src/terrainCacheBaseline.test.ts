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
import { CachedHeightfieldSource } from '@inertialref/workers'
import { loadStarCatalog } from './catalog.ts'
import { DiskHeightfieldStore } from './heightfieldStore.ts'

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
    const source = { kind: 'pool', available: true, submit: generate }
    const cold = new CachedHeightfieldSource(source, store, 'cpu')
    const regions = [regionAddress(0, 6, 0, 0), regionAddress(1, 6, 0, 0)]
    let clock = 0
    const report = await measureHeightfieldSource(
      body,
      regions,
      () => ++clock,
      cold,
      3,
    )
    await cold.flush()
    expect(report).toMatchObject({ patches: 2, totalMs: 1, samples: 98 })
    expect(generate).toHaveBeenCalledTimes(2)
    store.close()
    const warm = new CachedHeightfieldSource(source, restored, 'cpu')
    await measureHeightfieldSource(body, regions, () => ++clock, warm, 3)
    expect(warm.stats()).toMatchObject({ hits: 2, misses: 0 })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(session.world.stateHash()).toBe(hash)
  } finally {
    store.close()
    restored.close()
    session.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
