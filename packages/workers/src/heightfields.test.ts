import { expect, it, vi } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import {
  regionAddress,
  surfaceGrammar,
  type HeightfieldRequest,
} from '@inertialref/universe'
import { Heightfields, HeightfieldUnavailable } from './heightfields.ts'
import type { HeightfieldResponse, HeightfieldSource } from './tasks.ts'

const seed = rootSeed('heightfields')
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
const request: HeightfieldRequest = {
  region: regionAddress(0, 2, 0, 0),
  resolution: 2,
  border: 0,
}
const field: HeightfieldResponse = {
  ...request,
  border: 0,
  elevations: new Float32Array(4),
  cover: new Uint8Array(32),
  minElevation: 0,
  maxElevation: 0,
}
function delayed(kind: string) {
  const jobs: {
    resolve: (value: HeightfieldResponse) => void
    reject: (reason: Error) => void
    cancel: ReturnType<typeof vi.fn>
  }[] = []
  const source: HeightfieldSource = {
    kind,
    available: true,
    submit: vi.fn(() => {
      let resolve!: (value: HeightfieldResponse) => void
      let reject!: (reason: Error) => void
      const result = new Promise<HeightfieldResponse>((yes, no) => {
        resolve = yes
        reject = no
      })
      const cancel = vi.fn(() => reject(new Error('cancelled')))
      jobs.push({ resolve, reject, cancel })
      return { id: jobs.length, result, cancel }
    }),
  }
  return { source, jobs }
}

it('routes by capability without copying the surface or the request', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = { ...gpu.source, maxLevel: 1 }
  const job = fields.submit(surface, request)!
  expect(gpu.source.submit).not.toHaveBeenCalled()
  expect(pool.source.submit).toHaveBeenCalledWith(surface, request)
  expect(vi.mocked(pool.source.submit).mock.calls[0]![0] === surface).toBe(true)
  expect(vi.mocked(pool.source.submit).mock.calls[0]![1] === request).toBe(true)
  pool.jobs[0]!.resolve(field)
  await expect(job.result).resolves.toBe(field)
})

it('routes request shapes that the preferred adapter does not support', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = { ...gpu.source, supports: (r) => r.resolution === 65 }
  const job = fields.submit(surface, request)!
  expect(gpu.source.submit).not.toHaveBeenCalled()
  pool.jobs[0]!.resolve(field)
  await expect(job.result).resolves.toBe(field)
})

it('finishes an in-flight request on the fallback after the preferred adapter retires', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = gpu.source
  const job = fields.submit(surface, request)!
  expect(fields.kind).toBe('gpu')
  gpu.jobs[0]!.reject(new HeightfieldUnavailable())
  await Promise.resolve()
  expect(pool.jobs).toHaveLength(1)
  pool.jobs[0]!.resolve(field)
  await expect(job.result).resolves.toBe(field)
})

it('does not retry cancellation, including one between rejection and fallback', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = gpu.source
  const job = fields.submit(surface, request)!
  gpu.jobs[0]!.reject(new HeightfieldUnavailable())
  job.cancel()
  job.cancel()
  await expect(job.result).rejects.toThrow('cancelled')
  expect(gpu.jobs[0]!.cancel).toHaveBeenCalledTimes(1)
  expect(pool.jobs).toHaveLength(0)
})

it('cancels the fallback after a request changes adapters', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = gpu.source
  const job = fields.submit(surface, request)!
  gpu.jobs[0]!.reject(new HeightfieldUnavailable())
  await Promise.resolve()
  job.cancel()
  await expect(job.result).rejects.toThrow('cancelled')
  expect(pool.jobs[0]!.cancel).toHaveBeenCalledTimes(1)
})

it('reports absence when no adapter can answer instead of submitting a refusal', async () => {
  const gpu = delayed('gpu')
  const fields = new Heightfields(null)
  fields.preferred = { ...gpu.source, maxLevel: 1 }
  expect(fields.submit(surface, request)).toBeNull()
  expect(gpu.jobs).toHaveLength(0)
  fields.preferred = gpu.source
  const job = fields.submit(surface, request)!
  gpu.jobs[0]!.reject(new HeightfieldUnavailable())
  await expect(job.result).resolves.toBeNull()
})

it('propagates ordinary failures once and contains synchronous adapter throws', async () => {
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = {
    kind: 'broken',
    available: true,
    submit() {
      throw new Error('bad terrain')
    },
  }
  await expect(fields.submit(surface, request)!.result).rejects.toThrow(
    'bad terrain',
  )
  expect(pool.jobs).toHaveLength(0)
  fields.preferred = {
    kind: 'retired',
    available: true,
    submit() {
      throw new HeightfieldUnavailable()
    },
  }
  const job = fields.submit(surface, request)!
  pool.jobs[0]!.resolve(field)
  await expect(job.result).resolves.toBe(field)
})

it('reads availability and the preferred adapter for each new request', async () => {
  const gpu = delayed('gpu')
  const pool = delayed('pool')
  const fields = new Heightfields(pool.source)
  fields.preferred = { ...gpu.source, available: false }
  expect(fields.kind).toBe('pool')
  const job = fields.submit(surface, request)!
  pool.jobs[0]!.resolve(field)
  await job.result
  fields.preferred = gpu.source
  expect(fields.kind).toBe('gpu')
})
