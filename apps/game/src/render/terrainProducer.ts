import type { WebGPURenderer } from 'three/webgpu'
import {
  getLogger,
  getTimer,
  InvariantError,
  type TimingDetail,
} from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import type { JobId } from '@inertialref/protocol'
import {
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type HeightfieldRequest,
  heightfieldStride,
  type KernelSurface,
  MAX_TILE_LEVEL,
  NO_KERNEL_WATER,
  packedStageOn,
  type SurfaceParameters,
  surfaceKernel,
  TILE_STRIDE,
  writeTileFrame,
} from '@inertialref/universe'
import {
  type ArchivedSource,
  HeightfieldUnavailable,
  type HeightfieldResponse,
  type JobLane,
  POOL_ARCHIVE,
} from '@inertialref/workers'
import { timingDetailed } from '../engine/browserTiming.ts'
import { QUERY } from '../pages/paths.ts'
import {
  createTerrainKernel,
  TERRAIN_KERNEL_REVISION,
  type TerrainKernel,
  uploadSurface,
} from './terrainKernel.ts'

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
 * **The ground first.** A batch is drawn from the foreground lane while it
 * holds anything, and from the background lane — the orbital bake's
 * ninety-six tiles — only when it does not, so a bake that starts on a descent
 * waits behind the ground the descent needs rather than ahead of it. The lane
 * picks which waiting tiles the next dispatch takes and nothing else: a
 * tile's answer is a function of its request, so the order cannot reach a
 * value (`JobLane` in `packages/workers`).
 *
 * **One body per batch.** The kernel reads one packed body; a batch is cut at
 * the first request for a different surface, and the body is uploaded only
 * when it changes. A retarget therefore costs one short batch and one upload,
 * and a hover costs no upload at all. "The same body" is the surface object
 * itself, asked for the same side of the sea: it is the identity
 * `surfaceKernel` memoizes its packed record on, a loaded body holds one for
 * its lifetime, and a reseed under the same address makes a new one — so
 * nothing here rebuilds or caches a surface, it keeps the one it was handed.
 *
 * **The pool stays canonical and stays the fallback.** A kernel that will not
 * build, a device the browser loses: `available` goes false, everything
 * queued or in flight rejects with `HeightfieldUnavailable`, and `Heightfields`
 * retries those requests on the pool. A body the kernel cannot pack is that
 * body's alone: its requests go to the pool and the GPU keeps every other
 * body's. Nothing here is the field the contact
 * test integrates — that is `elevationAt` on the CPU, always — and nothing
 * here moves a canonical version, because the divergence from the CPU tile is
 * a measured bound (`terrainKernel.gpu.test.ts`) rather than a change to the
 * ground. What the archive keeps its tiles under is the kernel's own
 * revision, `TERRAIN_KERNEL_REVISION`, beside the graph it describes, joined
 * to the pool's: the kernel's records are packed on the CPU from the same
 * sketch, micro levels and drainage graph the pool's tile reads, so a change
 * there that spends the pool a version retires the GPU's tiles with it.
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
  /** Bodies the kernel could not pack, whose tiles the pool makes instead. */
  readonly refused: number
  /** Rolling mean, dispatch to readback in hand, milliseconds. */
  readonly meanBatchMs: number
}

export interface TileProducer extends ArchivedSource {
  readonly kind: 'gpu'
  /** `MAX_TILE_LEVEL`: the frame is exact through 23, and deeper is the pool's. */
  readonly maxLevel: number
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
  readonly surface: SurfaceParameters
  readonly request: HeightfieldRequest
  readonly lane: JobLane
  readonly resolve: (response: HeightfieldResponse) => void
  readonly reject: (cause: Error) => void
  canceled: boolean
}

/**
 * Whether two queued requests can share a dispatch: one body, one side of
 * the sea. The flag is half of it because it is half of the packed record —
 * a body asked for both ways is two records and two uploads, not one record
 * answering both — and an omitted flag is the clamped side, as
 * `generateHeightfield` reads it.
 */
const sameBody = (a: Queued, b: Queued): boolean =>
  a.surface === b.surface &&
  (a.request.seabed ?? false) === (b.request.seabed ?? false)

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
   * The packed record the kernel's buffers hold. `surfaceKernel` memoizes one
   * record per surface and side of the sea, so the record's identity is the
   * body's. Holding the head job instead would keep its surface — the
   * `WeakMap` key under both of that body's records — and, through its
   * settled promise, one tile's response, for as long as the producer lives.
   */
  let uploaded: KernelSurface | null = null
  /*
   * Bodies the kernel cannot pack — a drainage graph past the buffers' caps,
   * or any other invariant the packer holds. A refusal is about the body, not
   * the device: that body's requests go to the pool, and every other body's
   * keep the GPU. Weak, because the surface object is the body's identity
   * (`surfaceKernel` memoizes on it) and a reseed makes a new one.
   */
  const refused = new WeakSet<SurfaceParameters>()
  /*
   * The one switch. `fail` turns it off for a device that stopped answering
   * and `dispose` for a producer that is being retired, and every guard
   * below reads it alone; `disposed` only keeps the retirement from running
   * twice.
   */
  let available = true
  let scheduled = false
  let disposed = false
  let nextId: JobId = 1
  /** Tiles in the batch on the GPU, which is also whether one is there. */
  let inFlight = 0
  let batches = 0
  let tiles = 0
  let refusals = 0
  const batchMs: number[] = []

  /**
   * The kernel cannot pack this body. Its jobs, taken and queued, go back to
   * `Heightfields` as unavailable, which retries each on the pool; the
   * producer stays available for every other body.
   */
  function refuse(
    surface: SurfaceParameters,
    taken: readonly Queued[],
    cause: unknown,
  ): void {
    refused.add(surface)
    refusals += 1
    log.warn('the GPU tile producer cannot pack this body; the pool takes it', {
      seed: formatSeed(surface.seed),
      cause: String(cause),
    })
    for (const job of taken) job.reject(new HeightfieldUnavailable())
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const job = queue[i] as Queued
      if (job.surface !== surface) continue
      queue.splice(i, 1)
      job.reject(new HeightfieldUnavailable())
    }
  }

  /**
   * The device or the pipeline stopped answering: nothing it runs can be
   * trusted, so the producer retires for the session and the pool takes
   * everything.
   */
  function fail(cause: unknown): void {
    if (!available) return
    available = false
    // The streamer keeps a stopped producer for the session and routes on
    // `available`; nothing else would ever let go of the last body's record.
    uploaded = null
    log.error('the GPU tile producer stopped; the pool takes over', {
      cause: String(cause),
    })
    for (const job of queue.splice(0)) {
      job.reject(new HeightfieldUnavailable())
    }
  }

  /** Take the next batch, dispatch it, read it back, deliver it. */
  async function pump(): Promise<void> {
    scheduled = false
    if (inFlight > 0 || !available) return
    // Drop what was canceled while queued; a batch of nothing is no batch.
    while (queue.length > 0 && (queue[0] as Queued).canceled) queue.shift()
    if (queue.length === 0) return
    // The oldest foreground job when there is one; the oldest of all when
    // there is not, which is then a background one. See the header.
    const head =
      queue.find((job) => !job.canceled && job.lane === 'foreground') ??
      (queue[0] as Queued)
    const taken: Queued[] = []
    let cursor = 0
    while (taken.length < batch && cursor < queue.length) {
      const job = queue[cursor] as Queued
      if (job.canceled) {
        queue.splice(cursor, 1)
        continue
      }
      if (job.lane !== head.lane || !sameBody(job, head)) {
        cursor += 1
        continue
      }
      taken.push(job)
      queue.splice(cursor, 1)
    }
    inFlight = taken.length
    const started = performance.now()
    /*
     * Packed apart from the dispatch, because the two fail for different
     * reasons. A packer invariant is about one body and says nothing about
     * the device. Anything else thrown here is a defect in the packing code,
     * which would refuse every body in turn while `ir.terrain()` still
     * reported the GPU, so it retires the producer as loudly as a lost device.
     */
    let packed: KernelSurface
    try {
      packed = surfaceKernel(head.surface, head.request.seabed)
    } catch (cause) {
      inFlight = 0
      if (cause instanceof InvariantError) {
        refuse(head.surface, taken, cause)
        schedule()
      } else {
        fail(cause)
        for (const job of taken) job.reject(new HeightfieldUnavailable())
      }
      return
    }
    try {
      if (packed !== uploaded) {
        uploadSurface(kernel, packed)
        uploaded = packed
      }
      const frames = kernel.tiles.array as Float32Array
      taken.forEach((job, i) => {
        writeTileFrame(packed, job.request.region, frames, i * TILE_STRIDE * 4)
      })
      kernel.tiles.needsUpdate = true
      kernel.total.value = taken.length * kernel.samples
      renderer.compute(kernel.compute, taken.length * kernel.samples)
      /*
       * A body that drains is the only one whose water is anything but
       * "none": with the drainage stage's gate closed the kernel writes the
       * sentinel at every vertex, and the whole buffer — 270 KB at sixteen
       * tiles of 4,225 vertices, copied, mapped and then scanned a tile at
       * a time — would come back to be turned into NaN. So a dry body's copy
       * is never queued, and its tiles get the NaN the scan would have made.
       * The gate is the one every reader of the drainage buffer tests
       * (`uploadSurface` says why).
       */
      const wet = packedStageOn(packed, 'drainage')
      // Every copy on the queue before any is waited for: each readback is
      // its own staging buffer and command buffer, so issued together they
      // share one fence, and issued in turn the cover's copy is not even
      // encoded until the elevations' map has resolved — two round trips
      // where one covers all.
      const [elevationBytes, coverBytes, waterBytes] = await Promise.all([
        renderer.getArrayBufferAsync(kernel.elevations),
        renderer.getArrayBufferAsync(kernel.cover),
        wet ? renderer.getArrayBufferAsync(kernel.water) : null,
      ])
      const elevations = new Float32Array(elevationBytes)
      const cover = new Uint8Array(coverBytes)
      const water = waterBytes === null ? null : new Float32Array(waterBytes)
      const finished = performance.now()
      batches += 1
      tiles += taken.length
      batchMs.push(finished - started)
      if (batchMs.length > 32) batchMs.shift()
      // The properties behind `timingDetailed()` as well as `timer.on`: they
      // exist only at `full`, and a string built for a level that discards
      // it is a string built for nothing, once a batch.
      if (timer.on) {
        timer.measure(
          'gpu heightfields',
          started,
          finished,
          timingDetailed()
            ? {
                ...BATCH_DETAIL,
                properties: [['tiles', String(taken.length)]],
              }
            : BATCH_DETAIL,
        )
      }
      taken.forEach((job, i) => {
        if (job.canceled) {
          job.reject(new Error('canceled'))
          return
        }
        job.resolve(
          unpack(
            job.request,
            elevations.slice(i * kernel.samples, (i + 1) * kernel.samples),
            cover.slice(
              i * kernel.interior * COVER_CHANNELS,
              (i + 1) * kernel.interior * COVER_CHANNELS,
            ),
            water === null
              ? null
              : water.slice(i * kernel.interior, (i + 1) * kernel.interior),
          ),
        )
      })
    } catch (cause) {
      fail(cause)
      for (const job of taken) job.reject(new HeightfieldUnavailable())
    } finally {
      inFlight = 0
    }
    schedule()
  }

  function schedule(): void {
    if (scheduled || inFlight > 0 || !available) return
    scheduled = true
    void Promise.resolve().then(pump)
  }

  /**
   * A tile's response, as the worker task shapes it.
   *
   * The extremes are read off the float32 array the mesh will be built from,
   * for the reason `generateHeightfield` gives: a bounding volume sized from
   * a value the mesh does not contain can be a rounding step too small.
   *
   * `water` is the kernel's slice, or null for a dry body's tile, whose
   * slice was not read back: NaN at every vertex, which is what the kernel's
   * sentinel would have come to.
   */
  function unpack(
    request: HeightfieldRequest,
    elevations: Float32Array,
    cover: Uint8Array,
    slice: Float32Array | null,
  ): HeightfieldResponse {
    const { resolution, border } = kernel.layout
    const stride = heightfieldStride(kernel.layout)
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
    let water: Float32Array
    if (slice === null) {
      water = new Float32Array(resolution * resolution).fill(Number.NaN)
    } else {
      // The kernel's "no water" is a sentinel below any ground; the field's
      // is NaN, which WGSL cannot write as a constant. One convention past
      // here.
      water = slice
      for (let i = 0; i < water.length; i += 1) {
        if ((water[i] as number) <= NO_KERNEL_WATER / 2) water[i] = Number.NaN
      }
    }
    return {
      region: request.region,
      resolution,
      border,
      elevations,
      cover,
      water,
      minElevation: min,
      maxElevation: max,
    }
  }

  return {
    kind: 'gpu',
    archive: `gpu:terrain-tsl@${TERRAIN_KERNEL_REVISION}+${POOL_ARCHIVE}`,
    maxLevel: MAX_TILE_LEVEL,
    get available() {
      return available
    },
    supports: (request) =>
      request.resolution === kernel.layout.resolution &&
      (request.border ?? HEIGHTFIELD_BORDER) === kernel.layout.border,
    submit(surface, request, lane = 'foreground') {
      const id = nextId++
      let resolve!: (response: HeightfieldResponse) => void
      let reject!: (cause: Error) => void
      const result = new Promise<HeightfieldResponse>((res, rej) => {
        resolve = res
        reject = rej
      })
      const job: Queued = {
        surface,
        request,
        lane,
        resolve,
        reject,
        canceled: false,
      }
      // A refused request is this request's alone: it never reaches `pump`,
      // whose failure path retires the producer for the session. Heightfields
      // checks maxLevel and supports before submitting; this also guards
      // callers using the adapter directly.
      if (
        request.resolution !== kernel.layout.resolution ||
        (request.border ?? HEIGHTFIELD_BORDER) !== kernel.layout.border ||
        request.region.level > MAX_TILE_LEVEL
      ) {
        reject(new RangeError('unsupported heightfield request'))
        return { id, result, cancel() {} }
      }
      if (!available || refused.has(surface)) {
        reject(new HeightfieldUnavailable())
        return { id, result, cancel() {} }
      }
      queue.push(job)
      schedule()
      return {
        id,
        result,
        cancel() {
          if (job.canceled) return
          job.canceled = true
          const at = queue.indexOf(job)
          // Still queued: gone before it costs anything. Dispatched: the
          // kernel runs it anyway, and the answer is discarded on arrival.
          if (at >= 0) {
            queue.splice(at, 1)
            job.reject(new Error('canceled'))
          }
        },
      }
    },
    stats() {
      let total = 0
      for (const ms of batchMs) total += ms
      return {
        available,
        queued: queue.length,
        inFlight,
        batches,
        tiles,
        refused: refusals,
        meanBatchMs: batchMs.length === 0 ? 0 : total / batchMs.length,
      }
    },
    async warm() {
      if (!available) return false
      /*
       * An empty dispatch: the pipeline is built and nothing is written. The
       * validation scope is what turns a kernel Tint refuses into a `false`
       * here rather than a silent broken pipeline — the backend reports the
       * failure through its console sink and marks the pipeline, and a later
       * dispatch would produce nothing and reject nothing.
       *
       * Pushed and popped in one task, around the dispatch alone. Error
       * scopes are one stack on the device, and the frame loop shares the
       * device: three brackets an async render pipeline in a scope of its
       * own that it pops only once the pipeline resolves, so a scope held
       * here across the readback's await would interleave with it — this
       * pop taking the frame's scope, and a kernel Tint refused passing as
       * built, or the frame's pop taking this one and a material's error
       * retiring the ground producer. `compute` builds the pipeline and
       * submits synchronously, so its error is in the scope before the pop
       * is asked for, and the readback that follows needs no scope: it is
       * the wait for the compile, not a test of it.
       */
      const device = (renderer.backend as { device?: GPUDevice }).device
      device?.pushErrorScope('validation')
      let dispatched = false
      try {
        kernel.total.value = 0
        renderer.compute(kernel.compute, WORKGROUP)
        dispatched = true
      } catch (cause) {
        fail(cause)
      }
      const scoped = device?.popErrorScope() ?? Promise.resolve(null)
      if (!dispatched) {
        await scoped.catch(() => null)
        return false
      }
      try {
        const [error] = await Promise.all([
          scoped,
          renderer.getArrayBufferAsync(kernel.elevations),
        ])
        if (error !== null) {
          fail(error.message)
          return false
        }
      } catch (cause) {
        fail(cause)
        return false
      }
      return true
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Unavailable before anything else. The retirement runs ahead of a
      // renderer rebuild, whose first act destroys this device, and a batch
      // in flight on it rejects into `pump`'s catch — which then reaches
      // `fail`'s early return rather than logging that the producer stopped.
      available = false
      uploaded = null
      for (const job of queue.splice(0)) {
        job.reject(new HeightfieldUnavailable())
      }
      kernel.dispose()
    },
  }
}
