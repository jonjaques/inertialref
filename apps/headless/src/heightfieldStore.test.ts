import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  generateHeightfield,
  regionAddress,
  surfaceGrammar,
} from '@inertialref/universe'
import {
  CachedHeightfieldSource,
  heightfieldCacheRecord,
  validateHeightfieldCacheRecord,
} from '@inertialref/workers'
import { DiskHeightfieldStore } from './heightfieldStore.ts'
const dirs: string[] = []
const stores: DiskHeightfieldStore[] = []
function make(maxEntries = 3, maxBytes = 1_000_000) {
  const directory = mkdtempSync(join(tmpdir(), 'ir-terrain-cache-'))
  dirs.push(directory)
  const store = new DiskHeightfieldStore({ directory, maxEntries, maxBytes })
  stores.push(store)
  return { store, directory }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const seed = rootSeed('outside-sol')
const surface = {
  seed,
  maxElevation: 8000,
  roughness: 3,
  seaLevel: null,
  grammar: surfaceGrammar(seed, {
    mass: 7.35e22,
    meanRadius: 1.737e6,
    atmosphere: null,
    temperature: 270,
    tidalProxy: 0,
    hasOcean: false,
    reliefSpent: 1,
    publishedRelief: 8000,
  }),
}
const request = { region: regionAddress(0, 2, 0, 0), resolution: 3, border: 1 }
const field = generateHeightfield(surface, request)
it('keeps elevations, cover and NaN water over a real database reopen', async () => {
  const { store, directory } = make()
  const record = heightfieldCacheRecord('tile', field)
  await store.write(record)
  store.close()
  const reopened = new DiskHeightfieldStore({ directory })
  stores.push(reopened)
  expect(
    validateHeightfieldCacheRecord(
      await reopened.read('tile'),
      'tile',
      request,
    ),
  ).toEqual(record)
})
it('evicts least recently read tiles and bounds total payload bytes', async () => {
  const { store } = make(2)
  await store.write(heightfieldCacheRecord('a', field))
  await store.write(heightfieldCacheRecord('b', field))
  await store.read('a')
  await store.write(heightfieldCacheRecord('c', field))
  expect(await store.read('b')).toBeNull()
  expect(await store.stats()).toMatchObject({ entries: 2 })
  const small = make(100, 1200).store
  for (let i = 0; i < 10; i++)
    await small.write(heightfieldCacheRecord(String(i), field))
  expect((await small.stats()).bytes).toBeLessThanOrEqual(1200)
  await store.clear()
  expect((await store.stats()).entries).toBe(0)
})
it('storage absence is a generated tile, never a failed source', async () => {
  const { directory } = make()
  const file = join(directory, 'not-a-directory')
  writeFileSync(file, 'occupied')
  const store = new DiskHeightfieldStore({ directory: file })
  stores.push(store)
  const source = new CachedHeightfieldSource(
    {
      kind: 'pool',
      available: true,
      submit: () => ({ id: 1, result: Promise.resolve(field), cancel() {} }),
    },
    store,
    'cpu',
  )
  await expect(source.submit(surface, request).result).resolves.toEqual(field)
  await source.flush()
  expect(source.stats()).toMatchObject({ readErrors: 1, writeErrors: 1 })
})

it('reports a quota refusal without claiming a persisted tile', async () => {
  const { store } = make(0)
  expect(await store.write(heightfieldCacheRecord('no-room', field))).toBe(
    false,
  )
  expect((await store.stats()).entries).toBe(0)
})

it('stops evicting when the tally disagrees with the table', async () => {
  // The exit condition reads the triggers' running total and the progress
  // comes from deleting rows. A tally left over budget above an empty table
  // makes the subquery NULL, the delete match nothing, and the loop spin —
  // synchronously, inside an open transaction, where no test timeout can
  // reach it. So the check runs in a child process that can be killed.
  const { directory, store } = make(1)
  await store.write(heightfieldCacheRecord('first', field))
  store.close()
  const file = join(directory, 'tiles.sqlite')
  const db = new DatabaseSync(file)
  db.exec('DELETE FROM tiles; UPDATE tally SET entries=99, bytes=999999')
  db.close()
  const script = join(directory, 'evict.mjs')
  writeFileSync(
    script,
    `import { DiskHeightfieldStore } from ${JSON.stringify(
      new URL('./heightfieldStore.ts', import.meta.url).href,
    )}
const store = new DiskHeightfieldStore({ directory: ${JSON.stringify(directory)}, maxEntries: 1 })
await store.write({ key: 'second', bytes: 10, checksum: 0, field: {} })
store.close()`,
  )
  expect(() =>
    execFileSync(process.execPath, [script], { timeout: 20_000 }),
  ).not.toThrow()
  // The tally stays wrong — repairing it is a different question. What the
  // loop owes is termination, having evicted everything it could.
  const check = new DatabaseSync(file)
  expect(check.prepare('SELECT count(*) AS n FROM tiles').get()!.n).toBe(0)
  check.close()
})
