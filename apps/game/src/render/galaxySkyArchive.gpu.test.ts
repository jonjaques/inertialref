import { afterAll, beforeAll, expect, it } from 'vitest'
import { vec3 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 as spatialVector } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import { createGalaxyField, SUN_POSITION } from '@inertialref/universe'
import { GalaxySkyCache } from './galaxySkyCache.ts'
import type {
  GalaxySkyArchiveRecord,
  GalaxySkyStore,
} from './galaxySkyArchive.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(8, 8)
})
afterAll(() => gpu.dispose())
it('restores physical rays after retirement and rejects a late archive from another observer', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const options = { faceSize: 32, initialFaceSize: 16, tileSize: 16 }
  let published!: (record: GalaxySkyArchiveRecord) => void
  const saved = new Promise<GalaxySkyArchiveRecord>((resolve) => {
    published = resolve
  })
  const store: GalaxySkyStore = {
    read: async () => null,
    write: async (record) => {
      published(record)
    },
  }
  const first = new GalaxySkyCache(field, options, {}, store)
  let record: GalaxySkyArchiveRecord
  let expected: number[]
  try {
    first.configure(SUN_POSITION, field)
    await first.warm(gpu.renderer)
    while (first.schedule.next() !== null) first.advance(gpu.renderer)
    record = await saved
    expected = (
      await gpu.drawGraph(first.sample(vec3(1, 0.04, 0.3)), { float: true })
    ).at(4, 4)
  } finally {
    first.dispose()
  }
  const restored = new GalaxySkyCache(
    field,
    options,
    {},
    { ...store, read: async () => record },
  )
  try {
    restored.configure(SUN_POSITION, field)
    await restored.warm(gpu.renderer)
    restored.advance(gpu.renderer)
    await expect.poll(() => restored.diagnostics.archive.hits).toBe(1)
    expect(restored.diagnostics.tiles).toBe(1)
    expect(restored.available).toBe(true)
    const actual = (
      await gpu.drawGraph(restored.sample(vec3(1, 0.04, 0.3)), { float: true })
    ).at(4, 4)
    expect(actual).toEqual(expected)
    expect(restored.schedule.next()).toBeNull()
  } finally {
    restored.dispose()
  }
  let release!: (record: GalaxySkyArchiveRecord) => void
  const pending = new Promise<GalaxySkyArchiveRecord>((resolve) => {
    release = resolve
  })
  const late = new GalaxySkyCache(
    field,
    options,
    {},
    { ...store, read: () => pending },
  )
  try {
    late.configure(SUN_POSITION, field)
    await late.warm(gpu.renderer)
    late.advance(gpu.renderer)
    late.configure(
      UV.translate(SUN_POSITION, spatialVector(PARSEC, 0, 0)),
      field,
    )
    late.advance(gpu.renderer)
    release(record)
    await Promise.resolve()
    expect(late.available).toBe(false)
    expect(late.diagnostics.archive.hits).toBe(0)
  } finally {
    late.dispose()
  }
  expect(late.diagnostics.bytes).toBe(0)
})
