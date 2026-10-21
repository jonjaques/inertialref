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
import { WebGPUCoordinateSystem, type WebGPURenderer } from 'three/webgpu'
import { createOrbitalBaker } from './orbitalBake.ts'
import type { TerrainMaterial } from './terrain.ts'

const ADDRESS = 'g:milky-way/s:SOL/b:2'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

/**
 * `tick` ms a clock read: the bake reads its clock once a build, so this is
 * what each build appears to cost.
 */
function fixture(tick = 1) {
  const session = openSession({ seed: 'inertialref' })
  cleanups.push(() => session.dispose())
  const original = session.world.bodyAt(bodyFrameId(parseAddress(ADDRESS)))!
  let body: Body | null = original
  const jobs: {
    lane: string | undefined
    cancel: ReturnType<typeof vi.fn>
    reject: (reason: Error) => void
    complete(): void
  }[] = []
  const source: HeightfieldSource = {
    kind: 'delayed',
    available: true,
    submit(_surface, request, lane) {
      let resolve!: (field: HeightfieldResponse) => void
      let reject!: (reason: Error) => void
      const result = new Promise<HeightfieldResponse>((done, fail) => {
        resolve = done
        reject = fail
      })
      const cancel = vi.fn(() => reject(new Error('canceled')))
      jobs.push({
        lane,
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
            // Dry is NaN; a zeroed `water` is standing water at the datum.
            water: new Float32Array(request.resolution ** 2).fill(Number.NaN),
            minElevation: 0,
            maxElevation: 0,
          })
        },
      })
      return { id: jobs.length, result, cancel }
    },
  }
  const heightfields = new Heightfields(source)
  /*
   * A renderer that records what it was asked to draw, and a ground material
   * that records its bake mode: what a face draw is, without a device. The
   * mode is read at the draw, so a face drawn in the wrong mode shows.
   */
  const draws: { face: number; mode: number }[] = []
  let mode = 0
  let face = 0
  let bound: unknown = null
  let lost = false
  const renderer = {
    coordinateSystem: WebGPUCoordinateSystem,
    // What `CubeCamera.update` reads as well, so a bake drawn all at once
    // through it would be recorded rather than throw.
    xr: { enabled: false },
    reversedDepthBuffer: true,
    autoClear: true,
    getRenderTarget: () => bound,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(target: unknown, active = 0) {
      bound = target
      face = active
    },
    clearDepth() {},
    render() {
      if (lost) throw new Error('device lost')
      draws.push({ face, mode })
    },
  }
  const terrain = {
    material: {},
    setPalette() {},
    setAlbedoMap() {},
    setQuality() {},
    setPixelAngle() {},
    setBakeMode(next: number) {
      mode = next
    },
  }
  let clock = 0
  const baker = createOrbitalBaker({
    renderer: renderer as unknown as WebGPURenderer,
    terrain: terrain as unknown as TerrainMaterial,
    bodyFor: () => body,
    heightfields,
    now: () => (clock += tick),
  })
  cleanups.push(() => baker.dispose())
  return {
    baker,
    heightfields,
    jobs,
    draws,
    mode: () => mode,
    loseDevice: () => {
      lost = true
    },
    original,
    replace: (next: Body | null) => {
      body = next
    },
  }
}

/** Every tile answered, and the answers' continuations run. */
async function arrive(jobs: { complete(): void }[]): Promise<void> {
  for (const job of jobs) job.complete()
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
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

  it('asks for every tile in the background lane, behind the ground', () => {
    // The streamer's ground and the bake share a producer; a bake that
    // starts on a descent must not hold the ground the descent needs.
    const { baker, jobs } = fixture()
    baker.textureFor(ADDRESS)
    expect(jobs).toHaveLength(96)
    expect(new Set(jobs.map((job) => job.lane))).toEqual(
      new Set(['background']),
    )
  })

  it('builds and draws nothing in the task its tiles arrive in', async () => {
    // The tiles land whenever the producer answers, which is no frame's
    // business: a bake drawn there is the hitch this module spreads.
    const { baker, jobs, draws } = fixture()
    baker.textureFor(ADDRESS)
    await arrive(jobs)
    expect(draws).toEqual([])
    expect(baker.textureFor(ADDRESS)).toBeNull()
  })

  it('builds for two milliseconds a frame, then draws one face a frame, and hands over only the whole', async () => {
    // A millisecond a build: two fit in the budget, the third would not.
    const { baker, jobs, draws, mode } = fixture(1)
    baker.textureFor(ADDRESS)
    await arrive(jobs)
    // Ninety-six patches at two a frame: forty-eight frames, nothing drawn.
    for (let frame = 0; frame < 47; frame += 1) baker.advance()
    expect(baker.targetFor(ADDRESS)).not.toBeNull()
    baker.advance()
    expect(draws).toEqual([])
    for (let frame = 0; frame < 12; frame += 1) {
      // Not one face of a half-drawn target reaches the sphere.
      expect(baker.textureFor(ADDRESS)).toBeNull()
      baker.advance()
      expect(draws).toHaveLength(frame + 1)
      // The material is put back to the ground's own mode every frame.
      expect(mode()).toBe(0)
    }
    expect(draws).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((face) => ({ face, mode: 1 })),
      ...[0, 1, 2, 3, 4, 5].map((face) => ({ face, mode: 2 })),
    ])
    expect(baker.textureFor(ADDRESS)).not.toBeNull()
    expect(baker.report()).toEqual([
      { address: ADDRESS, ready: true, failed: false },
    ])
    baker.advance()
    expect(draws).toHaveLength(12)
  })

  it('builds one patch a frame on a machine where one overruns the budget', async () => {
    const { baker, jobs, draws } = fixture(5)
    baker.textureFor(ADDRESS)
    await arrive(jobs)
    for (let frame = 0; frame < 96; frame += 1) baker.advance()
    expect(draws).toEqual([])
    baker.advance()
    expect(draws).toHaveLength(1)
  })

  it('fails a bake whose face will not draw, and keeps the frame loop', async () => {
    const { baker, jobs, draws, mode, loseDevice } = fixture()
    baker.textureFor(ADDRESS)
    await arrive(jobs)
    for (let frame = 0; frame < 48; frame += 1) baker.advance()
    loseDevice()
    expect(() => baker.advance()).not.toThrow()
    expect(mode()).toBe(0)
    expect(baker.report()).toEqual([
      { address: ADDRESS, ready: false, failed: true },
    ])
    baker.advance()
    expect(draws).toEqual([])
  })

  it('stops drawing a bake its body left mid-way, and retires its targets', async () => {
    const { baker, jobs, draws, original, replace } = fixture()
    baker.textureFor(ADDRESS)
    const target = baker.targetFor(ADDRESS)!
    const retired = vi.fn()
    target.albedo.addEventListener('dispose', retired)
    target.relief.addEventListener('dispose', retired)
    await arrive(jobs)
    for (let frame = 0; frame < 51; frame += 1) baker.advance()
    expect(draws).toHaveLength(3)
    replace({ ...original, surface: { ...original.surface } })
    baker.advance()
    expect(draws).toHaveLength(3)
    expect(retired).toHaveBeenCalledTimes(2)
    expect(baker.report()).toEqual([])
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
