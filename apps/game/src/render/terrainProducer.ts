import type { WebGPURenderer } from 'three/webgpu'
import { getLogger, getTimer, type TimingDetail } from '@inertialref/shared'
import { parseSeed } from '@inertialref/procedural'
import type { JobId } from '@inertialref/protocol'
import {
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  regionAddress,
  type SurfaceParameters,
  surfaceKernel,
  TILE_STRIDE,
  writeTileFrame,
} from '@inertialref/universe'
import type {
  HeightfieldRequestPayload,
  HeightfieldResponse,
  HeightfieldSource,
} from '@inertialref/workers'
import { QUERY } from '../pages/paths.ts'
import { createTerrainKernel, type TerrainKernel } from './terrainKernel.ts'

/*
 * The GPU tile producer: `HeightfieldSource` over `terrainKernel.ts`.
 *
 * The streamer asks for a heightfield and gets the same `HeightfieldResponse`
 * a worker returns — bordered elevations, cover, extremes — and everything
 * downstream of that answer is untouched: the field cache, `buildPatch`, the
 * mesh, the material. What moves is where the 4,761 samples are evaluated.
 * A patch is 22 to 50 ms of one worker's time across the zoo, a two-meter
 * stance wants nine hundred to eleven hundred of them, and a pool of eight
 * does not divide 67 s of single-core work far enough; the kernel evaluates
 * a batch of tiles in one dispatch and the readback is a copy.
 *
 * **Batches, one at a time.** Requests queue, and the next dispatch is taken
 * on a microtask so that a frame's whole request list — up to
 * `REQUESTS_PER_FRAME` of them — lands in one batch rather than one dispatch
 * each. One batch is in flight at a time: the kernel binds one set of buffers,
 * and a second dispatch into them before the first was read back would race
 * the copy. The wait is a readback's latency, which is a frame or two, and
 * at a batch of sixteen that is still an order of magnitude past the pool.
 *
 * **One body per batch.** The kernel reads one packed body; a batch is cut at
 * the first request for a different surface, and the body is uploaded only
 * when it changes. A retarget therefore costs one short batch and one upload,
 * and a hover costs no upload at all.
 *
 * **The pool stays canonical and stays the fallback.** A kernel that will not
 * build, a device the browser loses: `available` goes false, everything
 * queued or in flight rejects with `producer unavailable`, and the streamer
 * routes the next request to the pool. Nothing here is the field the contact
 * test integrates — that is `elevationAt` on the CPU, always — and nothing
 * here is versioned, because the divergence from the CPU tile is a measured
 * bound (`terrainKernel.gpu.test.ts`) rather than a change to the ground.
 */

const log = getLogger('game.terrain.gpu')
const timer = getTimer('game.terrain.gpu')

/*
 * On the Terrain track beside the streamer's own phases, because a batch is
 * the other half of the same question those phases ask — how long the ground
 * takes to arrive — and the one half the CPU phases cannot see.
 */
const BATCH_DETAIL: TimingDetail = Object.freeze({
  track: 'Terrain',
  color: 'secondary-dark',
})

/**
 * Tiles per dispatch.
 *
 * Sixteen is two thirds of `REQUESTS_PER_FRAME`, so a frame's request list
 * takes two dispatches and a hover's top-up takes one. Measured on an Apple
 * M5 through Dawn: a batch of sixteen Luna tiles at level 17 is about 12 ms
 * from dispatch to readback, against 16 × 43 ms on one core. The ceiling on
 * it is the frame: the dispatch shares the GPU with the frame's own draw,
 * and a batch that runs longer than a frame's slack is a hitch on the
 * compositor rather than a queue on a worker.
 */
export const TILES_PER_BATCH = 16

/** Invocations a compute node dispatches at a time; the guard's granularity. */
const WORKGROUP = 64

export interface TileProducerStats {
  readonly available: boolean
  readonly queued: number
  readonly inFlight: number
  /** Batches dispatched since the producer was made. */
  readonly batches: number
  /** Tiles delivered since it was made. */
  readonly tiles: number
  /** Rolling mean, dispatch to readback in hand, milliseconds. */
  readonly meanBatchMs: number
}

export interface TileProducer extends HeightfieldSource {
  readonly kind: 'gpu'
  stats(): TileProducerStats
  /**
   * Build the pipeline now, so no frame has to.
   *
   * The compute pipeline is built synchronously on the first dispatch, and a
   * kernel this size is a noticeable compile; boot pays it behind the cover.
   * Resolves `false` when the kernel does not build — a validation error on
   * the device — after which the source is unavailable and the streamer
   * never sees it.
   */
  warm(): Promise<boolean>
  dispose(): void
}

interface Queued {
  readonly id: JobId
  readonly payload: HeightfieldRequestPayload
  readonly key: string
  readonly resolve: (response: HeightfieldResponse) => void
  readonly reject: (cause: Error) => void
  cancelled: boolean
}

interface Held {
  readonly surface: SurfaceParameters
}

/**
 * Which producer a page asked for. `?producer=cpu` keeps the pool on a WebGPU
 * page, which is the A/B the measurements in `CONTEXT.md` were taken with.
 */
export function producerPreference(search: string): 'gpu' | 'cpu' {
  return new URLSearchParams(search).get(QUERY.producer) === 'cpu'
    ? 'cpu'
    : 'gpu'
}

export function createTileProducer(
  renderer: WebGPURenderer,
  options: { readonly batch?: number } = {},
): TileProducer {
  const batch = options.batch ?? TILES_PER_BATCH
  const kernel: TerrainKernel = createTerrainKernel({
    resolution: HEIGHTFIELD_RESOLUTION,
    border: HEIGHTFIELD_BORDER,
    maxTiles: batch,
  })
  const queue: Queued[] = []
  /*
   * A surface per key, so `surfaceKernel`'s memo hits: the payload arrives
   * as plain fields and a fresh `SurfaceParameters` per request would pack
   * the body once per tile. The key is the seed and the three fields that
   * ride beside the grammar; the grammar itself is a function of the seed
   * and the body's facts, so two requests that agree on the four agree on
   * all of it.
   */
  const held = new Map<string, Held>()
  let uploaded: string | null = null
  let available = true
  let busy = false
  let scheduled = false
  let disposed = false
  let nextId: JobId = 1
  let inFlight = 0
  let batches = 0
  let tiles = 0
  const batchMs: number[] = []

  const keyOf = (payload: HeightfieldRequestPayload): string =>
    `${payload.surfaceSeed}|${payload.maxElevation}|${payload.roughness}|${payload.seaLevel}`

  const surfaceOf = (payload: HeightfieldRequestPayload): SurfaceParameters => {
    const key = keyOf(payload)
    const known = held.get(key)
    if (known !== undefined) return known.surface
    const surface: SurfaceParameters = {
      seed: parseSeed(payload.surfaceSeed),
      maxElevation: payload.maxElevation,
      roughness: payload.roughness,
      seaLevel: payload.seaLevel,
      grammar: payload.grammar,
    }
    // Bounded: a session streams a handful of bodies, and the packed records
    // behind each are a few kilobytes.
    if (held.size >= 64) {
      const oldest = held.keys().next().value
      if (oldest !== undefined) held.delete(oldest)
    }
    held.set(key, { surface })
    return surface
  }

  function fail(cause: unknown): void {
    if (!available) return
    available = false
    log.error('the GPU tile producer stopped; the pool takes over', {
      cause: String(cause),
    })
    for (const job of queue.splice(0)) {
      job.reject(new Error('producer unavailable'))
    }
  }

  /** Take the next batch, dispatch it, read it back, deliver it. */
  async function pump(): Promise<void> {
    scheduled = false
    if (busy || disposed || !available) return
    // Drop what was cancelled while queued; a batch of nothing is no batch.
    while (queue.length > 0 && (queue[0] as Queued).cancelled) queue.shift()
    if (queue.length === 0) return
    const key = (queue[0] as Queued).key
    const taken: Queued[] = []
    let cursor = 0
    while (taken.length < batch && cursor < queue.length) {
      const job = queue[cursor] as Queued
      if (job.cancelled) {
        queue.splice(cursor, 1)
        continue
      }
      if (job.key !== key) {
        cursor += 1
        continue
      }
      taken.push(job)
      queue.splice(cursor, 1)
    }
    busy = true
    inFlight = taken.length
    const started = performance.now()
    try {
      const surface = surfaceOf((taken[0] as Queued).payload)
      const packed = surfaceKernel(surface)
      if (uploaded !== key) {
        ;(kernel.records.array as Float32Array).set(packed.records)
        ;(kernel.words.array as Uint32Array).set(packed.words)
        kernel.records.needsUpdate = true
        kernel.words.needsUpdate = true
        uploaded = key
      }
      const frames = kernel.tiles.array as Float32Array
      taken.forEach((job, i) => {
        const { region } = job.payload
        writeTileFrame(
          packed,
          regionAddress(region.face, region.level, region.i, region.j),
          frames,
          i * TILE_STRIDE * 4,
        )
      })
      kernel.tiles.needsUpdate = true
      kernel.total.value = taken.length * kernel.samples
      renderer.compute(kernel.compute, taken.length * kernel.samples)
      const elevations = new Float32Array(
        await renderer.getArrayBufferAsync(kernel.elevations),
      )
      const cover = new Uint8Array(
        await renderer.getArrayBufferAsync(kernel.cover),
      )
      const finished = performance.now()
      batches += 1
      tiles += taken.length
      batchMs.push(finished - started)
      if (batchMs.length > 32) batchMs.shift()
      if (timer.on) {
        timer.measure('gpu heightfields', started, finished, {
          ...BATCH_DETAIL,
          properties: [['tiles', String(taken.length)]],
        })
      }
      taken.forEach((job, i) => {
        if (job.cancelled) {
          job.reject(new Error('cancelled'))
          return
        }
        job.resolve(
          unpack(
            job.payload,
            elevations.slice(i * kernel.samples, (i + 1) * kernel.samples),
            cover.slice(i * kernel.interior * 4, (i + 1) * kernel.interior * 4),
          ),
        )
      })
    } catch (cause) {
      fail(cause)
      for (const job of taken) job.reject(new Error('producer unavailable'))
    } finally {
      busy = false
      inFlight = 0
    }
    schedule()
  }

  function schedule(): void {
    if (scheduled || busy || disposed || !available) return
    scheduled = true
    void Promise.resolve().then(pump)
  }

  /**
   * A tile's response, as the worker task shapes it.
   *
   * The extremes are read off the float32 array the mesh will be built from,
   * for the reason `generateHeightfield` gives: a bounding volume sized from
   * a value the mesh does not contain can be a rounding step too small.
   */
  function unpack(
    payload: HeightfieldRequestPayload,
    elevations: Float32Array,
    cover: Uint8Array,
  ): HeightfieldResponse {
    const { resolution, border } = kernel.layout
    const stride = resolution + 2 * border
    let min = Infinity
    let max = -Infinity
    for (let row = 0; row < resolution; row += 1) {
      const at = (row + border) * stride + border
      for (let col = 0; col < resolution; col += 1) {
        const elevation = elevations[at + col] as number
        if (elevation < min) min = elevation
        if (elevation > max) max = elevation
      }
    }
    const { region } = payload
    return {
      region: regionAddress(region.face, region.level, region.i, region.j),
      resolution,
      border,
      elevations,
      cover,
      minElevation: min,
      maxElevation: max,
    }
  }

  return {
    kind: 'gpu',
    get available() {
      return available && !disposed
    },
    submit(payload) {
      const id = nextId++
      let resolve!: (response: HeightfieldResponse) => void
      let reject!: (cause: Error) => void
      const result = new Promise<HeightfieldResponse>((res, rej) => {
        resolve = res
        reject = rej
      })
      const job: Queued = {
        id,
        payload,
        key: keyOf(payload),
        resolve,
        reject,
        cancelled: false,
      }
      if (
        !available ||
        disposed ||
        payload.resolution !== kernel.layout.resolution ||
        (payload.border ?? HEIGHTFIELD_BORDER) !== kernel.layout.border
      ) {
        reject(new Error('producer unavailable'))
        return { id, result, cancel() {} }
      }
      queue.push(job)
      schedule()
      return {
        id,
        result,
        cancel() {
          if (job.cancelled) return
          job.cancelled = true
          const at = queue.indexOf(job)
          // Still queued: gone before it costs anything. Dispatched: the
          // kernel runs it anyway, and the answer is discarded on arrival.
          if (at >= 0) {
            queue.splice(at, 1)
            job.reject(new Error('cancelled'))
          }
        },
      }
    },
    stats() {
      let total = 0
      for (const ms of batchMs) total += ms
      return {
        available: available && !disposed,
        queued: queue.length,
        inFlight,
        batches,
        tiles,
        meanBatchMs: batchMs.length === 0 ? 0 : total / batchMs.length,
      }
    },
    async warm() {
      if (disposed || !available) return false
      /*
       * An empty dispatch: the pipeline is built and nothing is written. The
       * validation scope is what turns a kernel Tint refuses into a `false`
       * here rather than a silent broken pipeline — the backend reports the
       * failure through its console sink and marks the pipeline, and a later
       * dispatch would produce nothing and reject nothing.
       */
      const device = (renderer.backend as { device?: GPUDevice }).device
      device?.pushErrorScope('validation')
      try {
        kernel.total.value = 0
        renderer.compute(kernel.compute, WORKGROUP)
        await renderer.getArrayBufferAsync(kernel.elevations)
      } catch (cause) {
        await device?.popErrorScope().catch(() => null)
        fail(cause)
        return false
      }
      const scoped = await device?.popErrorScope()
      if (scoped !== null && scoped !== undefined) {
        fail(scoped.message)
        return false
      }
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const job of queue.splice(0)) {
        job.reject(new Error('producer unavailable'))
      }
      kernel.dispose()
    },
  }
}
