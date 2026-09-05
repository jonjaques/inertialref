import { Heightfields, HeightfieldUnavailable } from '@inertialref/workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSession } from '@inertialref/devtools'
import {
  bodyFrameId,
  parseAddress,
  heightfieldStride,
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  type Body,
} from '@inertialref/universe'
import type {
  HeightfieldResponse,
  HeightfieldSource,
} from '@inertialref/workers'
import type { WebGPURenderer } from 'three/webgpu'
import { createOrbitalBaker } from './orbitalBake.ts'
import type { TerrainMaterial } from './terrain.ts'

const ADDRESS = 'g:milky-way/s:SOL/b:2'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

function fixture() {
  const session = openSession({ seed: 'inertialref' })
  cleanups.push(() => session.dispose())
  const original = session.world.bodyAt(bodyFrameId(parseAddress(ADDRESS)))!
  let body: Body | null = original
  const jobs: {
    cancel: ReturnType<typeof vi.fn>
    reject: (reason: Error) => void
    complete(): void
  }[] = []
  const source: HeightfieldSource = {
    kind: 'delayed',
    available: true,
    submit(_surface, request) {
      let resolve!: (field: HeightfieldResponse) => void
      let reject!: (reason: Error) => void
      const result = new Promise<HeightfieldResponse>((done, fail) => {
        resolve = done
        reject = fail
      })
      const cancel = vi.fn(() => reject(new Error('cancelled')))
      jobs.push({
        cancel,
        reject,
        complete() {
          const border = request.border ?? HEIGHTFIELD_BORDER
          const stride = heightfieldStride({
            resolution: request.resolution,
            border,
          })
          resolve({
            ...request,
            border,
            elevations: new Float32Array(stride * stride),
            cover: new Uint8Array(request.resolution ** 2 * COVER_CHANNELS),
            minElevation: 0,
            maxElevation: 0,
          })
        },
      })
      return { id: jobs.length, result, cancel }
    },
  }
  const heightfields = new Heightfields(source)
  const baker = createOrbitalBaker({
    // No draw is submitted until the delayed tiles resolve.
    renderer: {} as WebGPURenderer,
    terrain: {} as TerrainMaterial,
    bodyFor: () => body,
    heightfields,
  })
  cleanups.push(() => baker.dispose())
  return {
    baker,
    heightfields,
    jobs,
    original,
    replace: (next: Body | null) => {
      body = next
    },
  }
}

describe('the orbital bake lifetime', () => {
  it('reuses an unchanged body and retires a replaced body at the same address', async () => {
    const { baker, jobs, original, replace } = fixture()
    baker.textureFor(ADDRESS)
    const first = baker.targetFor(ADDRESS)!
    const count = jobs.length
    expect(count).toBeGreaterThan(0)
    baker.textureFor(ADDRESS)
    expect(baker.targetFor(ADDRESS)?.albedo).toBe(first.albedo)
    expect(jobs).toHaveLength(count)

    const disposed = vi.fn()
    first.albedo.addEventListener('dispose', disposed)
    first.relief.addEventListener('dispose', disposed)
    replace({ ...original, surface: { ...original.surface } })
    baker.textureFor(ADDRESS)
    expect(baker.targetFor(ADDRESS)?.albedo).not.toBe(first.albedo)
    expect(disposed).toHaveBeenCalledTimes(2)
    expect(
      jobs.slice(0, count).every((job) => job.cancel.mock.calls.length === 1),
    ).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(baker.report()).toEqual([
      { address: ADDRESS, ready: false, failed: false },
    ])
  })

  it('does not carry a flat-body verdict across a body replacement', () => {
    const { baker, jobs, original, replace } = fixture()
    replace({ ...original, surface: { ...original.surface, maxElevation: 0 } })
    baker.textureFor(ADDRESS)
    expect(jobs).toHaveLength(0)
    replace(original)
    baker.textureFor(ADDRESS)
    expect(jobs.length).toBeGreaterThan(0)
  })

  it('drops removed bodies from inspection as well as from drawing', () => {
    const { baker, jobs, replace } = fixture()
    baker.textureFor(ADDRESS)
    replace(null)
    expect(baker.targetFor(ADDRESS)).toBeNull()
    expect(baker.report()).toEqual([])
    expect(jobs.every((job) => job.cancel.mock.calls.length === 1)).toBe(true)
  })

  it('cancels pending jobs once on disposal and refuses further requests', async () => {
    const { baker, jobs } = fixture()
    baker.textureFor(ADDRESS)
    const count = jobs.length
    baker.dispose()
    baker.dispose()
    expect(jobs.every((job) => job.cancel.mock.calls.length === 1)).toBe(true)
    expect(baker.textureFor(ADDRESS)).toBeNull()
    expect(jobs).toHaveLength(count)
    await Promise.resolve()
    expect(baker.report()).toEqual([])
  })
  it('retires a stale completion before it can draw, without another request', async () => {
    const { baker, jobs, original, replace } = fixture()
    baker.textureFor(ADDRESS)
    const target = baker.targetFor(ADDRESS)!
    const retired = vi.fn()
    target.albedo.addEventListener('dispose', retired)
    target.relief.addEventListener('dispose', retired)
    replace({ ...original, surface: { ...original.surface } })
    for (const job of jobs) job.complete()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(retired).toHaveBeenCalledTimes(2)
    expect(baker.report()).toEqual([])
  })

  it('keeps an in-flight bake while its tile requests recover on the fallback', async () => {
    const { baker, heightfields, jobs } = fixture()
    heightfields.preferred = {
      kind: 'retiring',
      available: true,
      submit() {
        return {
          id: 1,
          result: Promise.reject(new HeightfieldUnavailable()),
          cancel() {},
        }
      },
    }
    baker.textureFor(ADDRESS)
    const target = baker.targetFor(ADDRESS)!
    expect(jobs).toHaveLength(0)
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(jobs.length).toBeGreaterThan(0)
    expect(baker.targetFor(ADDRESS)?.albedo === target.albedo).toBe(true)
    expect(baker.report()).toEqual([
      { address: ADDRESS, ready: false, failed: false },
    ])
  })

  it('cancels the remaining tiles when one fails without a recovery path', async () => {
    const { baker, jobs } = fixture()
    baker.textureFor(ADDRESS)
    jobs[0]!.reject(new Error('malformed tile'))
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
    expect(
      jobs.slice(1).every((job) => job.cancel.mock.calls.length === 1),
    ).toBe(true)
    expect(baker.report()).toEqual([
      { address: ADDRESS, ready: false, failed: true },
    ])
    const count = jobs.length
    baker.textureFor(ADDRESS)
    expect(jobs).toHaveLength(count)
  })
})
