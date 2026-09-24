import type { WebGPURenderer } from 'three/webgpu'

/*
 * The frame's GPU time, pass by pass, with a name on every pass.
 *
 * `render/measure.ts` is the whole frame across a drained queue, and it is the
 * figure to quote for the frame. This is the attribution under it: which pass
 * the milliseconds are in, and how long the gaps between passes are — a copy,
 * a raw WebGPU pass three does not encode, a clear. It is a measurement taken
 * over a held loop, like `measureGpuFrameMs`, never a per-frame readout.
 *
 * Three's own timestamp tracking does not answer this, for three reasons in
 * r185:
 *
 * - **It has no names.** A pass is keyed `r:<calls>:<contextId>:f<frame>`,
 *   and the context id is a counter; nothing maps it back to a target.
 * - **It loses the part of the scene pass before a framebuffer copy.**
 *   `copyFramebufferToTexture` — the sea's `viewportSharedTexture` — ends the
 *   pass and begins a new one from the same descriptor, whose
 *   `timestampWrites` still name the same two query slots. The second begin
 *   overwrites the first, so the scene pass reads as only what was drawn after
 *   the copy: the sea and what follows it, without the ground under it. The
 *   hooks here give the resumed pass its own pair.
 * - **It keeps every sample.** The pool's `timestamps` map is keyed by frame
 *   number and never pruned.
 *
 * So the timeline owns its query set and its readback, and installs over the
 * backend's `initTimestampQuery` rather than beside it: a pass armed here gets
 * a fresh `timestampWrites` naming this set, and a pass that is not goes to
 * three's own path unchanged. The canvas's render-pass descriptor is cached
 * and never reset, so a pair this timeline set on it is taken back off when
 * the timeline is not armed — otherwise every later frame would keep writing
 * into slots nothing resolves.
 *
 * Chrome quantizes timestamps to 100 µs unless its WebGPU developer features
 * are on. A pass mean over forty frames is still unbiased, because the begin
 * and the end fall at independent phases of the quantum; a single sample of a
 * short pass is not.
 */

/** A pass three encodes: a render pass over a target, or a compute dispatch. */
export type PassKind = 'render' | 'compute'

interface Pending {
  readonly label: string
  readonly kind: PassKind
  readonly frame: number
  /** The first of the pass's two query slots. */
  readonly slot: number
}

/** One pass's share of the frame, averaged over the frames measured. */
export interface PassTime {
  readonly label: string
  readonly kind: PassKind
  /** Passes of this name per frame. */
  readonly count: number
  /** GPU milliseconds per frame, summed over every pass of this name. */
  readonly ms: number
}

/**
 * Time between two consecutive passes that no pass accounts for — or, when
 * negative, how far they overlap.
 */
export interface PassGap {
  readonly after: string
  readonly before: string
  readonly ms: number
}

export interface PassTimelineResult {
  readonly frames: number
  /** Wall clock per frame across a drained queue — `measureGpuFrameMs`'s figure. */
  readonly wallMs: number
  /** First pass begin to last pass end, per frame. */
  readonly spanMs: number
  /**
   * The sum of every pass's own duration, per frame. It can exceed `spanMs`:
   * Apple's tiled GPUs begin a pass's vertex work before the previous pass's
   * fragments finish, so consecutive intervals overlap, and a sum of pass
   * times is not a frame time. `wallMs` is the frame; the passes are shares.
   */
  readonly busyMs: number
  /** In the order the first frame encoded them. */
  readonly passes: readonly PassTime[]
  /** Gaps and overlaps at least `GAP_FLOOR_MS` either way, largest first. */
  readonly gaps: readonly PassGap[]
  /** Passes that found the query set full and went untimed. */
  readonly dropped: number
}

/*
 * WebGPU's ceiling on one query set. At two slots a pass it is 2,048 passes —
 * forty frames of fifty — and a pass past it is counted in `dropped` rather
 * than silently merged into its neighbor's gap.
 */
const QUERY_CAPACITY = 4096

/** Gaps and overlaps inside the timestamp quantum are noise, not a finding. */
const GAP_FLOOR_MS = 0.05

const NAMES = new WeakMap<object, string>()

/**
 * Name the render target a pass draws into, for the timeline.
 *
 * Three names every `PassNode`'s texture `output` and uses those names as
 * MRT keys, so the timeline cannot borrow them; a pass nobody named reads as
 * its texture's name and size, which still separates the passes of a frame.
 */
export function namePass(target: object, label: string): void {
  NAMES.set(target, label)
}

interface Target {
  readonly width: number
  readonly height: number
  readonly samples?: number
  readonly texture?: { readonly name?: string }
}

function renderLabel(context: {
  readonly renderTarget: Target | null
}): string {
  const target = context.renderTarget
  if (target === null) return 'canvas'
  const named = NAMES.get(target)
  if (named !== undefined) return named
  const name = target.texture?.name || 'target'
  const samples = (target.samples ?? 0) > 1 ? ` ×${target.samples}` : ''
  return `${name} ${target.width}×${target.height}${samples}`
}

function computeLabel(group: unknown): string {
  const nodes = Array.isArray(group) ? group : [group]
  const names = nodes
    .map((node) => (node as { name?: string }).name ?? '')
    .filter((name) => name !== '')
  return names.length === 0 ? 'compute' : names.join(' + ')
}

interface TimestampWrites {
  querySet: GPUQuerySet
  beginningOfPassWriteIndex: number
  endOfPassWriteIndex: number
}

/*
 * The four backend members the timeline hooks. `@types/three` declares none of
 * them on `WebGPUBackend`, so the shape is stated once here.
 */
interface Backend {
  device?: GPUDevice
  get(object: object): { descriptor?: { timestampWrites?: TimestampWrites } }
  beginRender(context: object): void
  beginCompute(group: unknown): void
  initTimestampQuery(
    type: string,
    uid: string,
    descriptor: { timestampWrites?: TimestampWrites },
  ): void
  copyFramebufferToTexture(
    texture: unknown,
    context: object,
    rectangle: unknown,
  ): void
}

export class PassTimeline {
  readonly #device: GPUDevice
  readonly #querySet: GPUQuerySet
  readonly #resolve: GPUBuffer
  readonly #read: GPUBuffer
  readonly #pending: Pending[] = []
  #armed = false
  #frame = 0
  #dropped = 0
  /** The pass `initTimestampQuery` is about to be called for. */
  #next: { label: string; kind: PassKind } | null = null
  readonly #restore: () => void

  constructor(backend: Backend, device: GPUDevice) {
    this.#device = device
    this.#querySet = device.createQuerySet({
      label: 'pass timeline',
      type: 'timestamp',
      count: QUERY_CAPACITY,
    })
    this.#resolve = device.createBuffer({
      label: 'pass timeline resolve',
      size: QUERY_CAPACITY * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    })
    this.#read = device.createBuffer({
      label: 'pass timeline read',
      size: QUERY_CAPACITY * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })

    const beginRender = backend.beginRender
    const beginCompute = backend.beginCompute
    const initTimestampQuery = backend.initTimestampQuery
    const copyFramebuffer = backend.copyFramebufferToTexture
    backend.beginRender = (context) => {
      this.#next = {
        label: renderLabel(context as { renderTarget: Target | null }),
        kind: 'render',
      }
      try {
        beginRender.call(backend, context)
      } finally {
        this.#next = null
      }
    }
    backend.beginCompute = (group) => {
      this.#next = { label: computeLabel(group), kind: 'compute' }
      try {
        beginCompute.call(backend, group)
      } finally {
        this.#next = null
      }
    }
    backend.initTimestampQuery = (type, uid, descriptor) => {
      const next = this.#next
      if (this.#armed && next !== null) {
        const writes = this.#allocate(next.label, next.kind)
        if (writes !== null) {
          descriptor.timestampWrites = writes
          return
        }
      }
      if (descriptor.timestampWrites?.querySet === this.#querySet)
        descriptor.timestampWrites = undefined
      initTimestampQuery.call(backend, type, uid, descriptor)
    }
    backend.copyFramebufferToTexture = (texture, context, rectangle) => {
      const descriptor = backend.get(context).descriptor
      const current = descriptor?.timestampWrites
      if (
        this.#armed &&
        descriptor !== undefined &&
        current?.querySet === this.#querySet
      ) {
        const label = this.#pending.find(
          (pass) => pass.slot === current.beginningOfPassWriteIndex,
        )?.label
        const writes = this.#allocate(`${label ?? 'pass'} after copy`, 'render')
        // The resumed pass reads the descriptor inside the original call.
        descriptor.timestampWrites = writes ?? undefined
      }
      copyFramebuffer.call(backend, texture, context, rectangle)
    }
    this.#restore = () => {
      backend.beginRender = beginRender
      backend.beginCompute = beginCompute
      backend.initTimestampQuery = initTimestampQuery
      backend.copyFramebufferToTexture = copyFramebuffer
    }
  }

  #allocate(label: string, kind: PassKind): TimestampWrites | null {
    const slot = this.#pending.length * 2
    if (slot + 2 > QUERY_CAPACITY) {
      this.#dropped += 1
      return null
    }
    this.#pending.push({ label, kind, frame: this.#frame, slot })
    return {
      querySet: this.#querySet,
      beginningOfPassWriteIndex: slot,
      endOfPassWriteIndex: slot + 1,
    }
  }

  /**
   * Submit `frames` frames through `draw` with every pass timed, then read
   * the timeline back.
   *
   * The caller holds the loop, as for `measureGpuFrameMs`: a frame the render
   * loop submits in the middle would be timed as one of these.
   */
  async measure(draw: () => void, frames: number): Promise<PassTimelineResult> {
    if (this.#read.mapState !== 'unmapped')
      throw new Error('A pass timeline is already being read')
    const queue = this.#device.queue
    this.#pending.length = 0
    this.#dropped = 0
    await queue.onSubmittedWorkDone()
    const started = performance.now()
    this.#armed = true
    try {
      for (this.#frame = 0; this.#frame < frames; this.#frame += 1) draw()
    } finally {
      this.#armed = false
    }
    await queue.onSubmittedWorkDone()
    const wallMs = (performance.now() - started) / frames

    const used = this.#pending.length * 2
    if (used === 0)
      return summarize([], new BigUint64Array(0), frames, wallMs, this.#dropped)
    const encoder = this.#device.createCommandEncoder({
      label: 'pass timeline resolve',
    })
    encoder.resolveQuerySet(this.#querySet, 0, used, this.#resolve, 0)
    encoder.copyBufferToBuffer(this.#resolve, 0, this.#read, 0, used * 8)
    queue.submit([encoder.finish()])
    await this.#read.mapAsync(GPUMapMode.READ, 0, used * 8)
    try {
      const times = new BigUint64Array(this.#read.getMappedRange(0, used * 8))
      return summarize(this.#pending, times, frames, wallMs, this.#dropped)
    } finally {
      this.#read.unmap()
    }
  }

  dispose(): void {
    this.#restore()
    this.#querySet.destroy()
    this.#resolve.destroy()
    this.#read.destroy()
  }
}

interface Interval {
  readonly label: string
  readonly kind: PassKind
  readonly begin: number
  readonly end: number
}

/**
 * The per-frame means, from the raw slots. Exported for the test: the
 * arithmetic is the part that can be wrong without a GPU.
 *
 * A pass whose end reads before its begin was not written — a pass that
 * allocated slots and then threw before it encoded — and is left out rather
 * than counted as a negative duration.
 */
export function summarize(
  pending: readonly Pending[],
  times: BigUint64Array,
  frames: number,
  wallMs: number,
  dropped: number,
): PassTimelineResult {
  const byFrame: Interval[][] = Array.from({ length: frames }, () => [])
  for (const pass of pending) {
    const begin = times[pass.slot]!
    const end = times[pass.slot + 1]!
    if (end < begin || begin === 0n) continue
    byFrame[pass.frame]!.push({
      label: pass.label,
      kind: pass.kind,
      begin: Number(begin) / 1e6,
      end: Number(end) / 1e6,
    })
  }

  const order: string[] = []
  const totals = new Map<
    string,
    { kind: PassKind; count: number; ms: number }
  >()
  const gaps = new Map<string, PassGap & { total: number }>()
  let span = 0
  let busy = 0
  for (const intervals of byFrame) {
    if (intervals.length === 0) continue
    // Submission order is the query order; the GPU's is the begin order.
    intervals.sort((a, b) => a.begin - b.begin)
    span += intervals.at(-1)!.end - intervals[0]!.begin
    let previous: Interval | null = null
    for (const interval of intervals) {
      const ms = interval.end - interval.begin
      busy += ms
      const total = totals.get(interval.label)
      if (total === undefined) {
        order.push(interval.label)
        totals.set(interval.label, { kind: interval.kind, count: 1, ms })
      } else {
        total.count += 1
        total.ms += ms
      }
      if (previous !== null) {
        const key = `${previous.label}\u0000${interval.label}`
        const gap = interval.begin - previous.end
        const entry = gaps.get(key)
        if (entry === undefined)
          gaps.set(key, {
            after: previous.label,
            before: interval.label,
            ms: 0,
            total: gap,
          })
        else entry.total += gap
      }
      previous = interval
    }
  }

  return {
    frames,
    wallMs,
    spanMs: span / frames,
    busyMs: busy / frames,
    passes: order.map((label) => {
      const total = totals.get(label)!
      return {
        label,
        kind: total.kind,
        count: total.count / frames,
        ms: total.ms / frames,
      }
    }),
    gaps: [...gaps.values()]
      .map(({ after, before, total }) => ({
        after,
        before,
        ms: total / frames,
      }))
      .filter((gap) => Math.abs(gap.ms) >= GAP_FLOOR_MS)
      .sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms)),
    dropped,
  }
}

const timelines = new WeakMap<WebGPURenderer, PassTimeline>()

/**
 * Install the timeline on a renderer whose device has `timestamp-query`.
 * A no-op on the WebGL backend and on a device without the feature, where
 * `passTimelineOf` answers null.
 */
export function installPassTimeline(renderer: WebGPURenderer): () => void {
  const backend = renderer.backend as unknown as Backend
  const device = backend.device
  if (device === undefined || !device.features.has('timestamp-query'))
    return () => {}
  const timeline = new PassTimeline(backend, device)
  timelines.set(renderer, timeline)
  return () => {
    timelines.delete(renderer)
    timeline.dispose()
  }
}

export function passTimelineOf(renderer: WebGPURenderer): PassTimeline | null {
  return timelines.get(renderer) ?? null
}
