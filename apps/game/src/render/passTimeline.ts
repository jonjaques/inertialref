import type { WebGPURenderer } from 'three/webgpu'
import { drainedFrameMs } from './measure.ts'

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
  /** The first of the pass's two query slots. */
  readonly slot: number
}

/** One pass's share of the frame, averaged over the frames measured. */
export interface PassTime {
  readonly label: string
  readonly kind: PassKind
  /** Passes of this name per frame. */
  readonly count: number
  /**
   * GPU milliseconds per frame this pass moved the completion frontier —
   * the latest end any earlier-finishing pass reached — summed over every
   * pass of this name. The shares of a run add up to the time the GPU was
   * busy, which a sum of the raw pairs does not; see `summarize`.
   */
  readonly ms: number
  /** Begin to end of the raw pair, per frame: latency, not cost. */
  readonly latencyMs: number
}

/** Time no pass was running, between the pass that finished and the next to begin. */
export interface PassGap {
  readonly after: string
  readonly before: string
  readonly ms: number
}

export interface PassTimelineResult {
  readonly frames: number
  /** Wall clock per frame across a drained queue — `measureGpuFrameMs`'s figure. */
  readonly wallMs: number
  /** First pass begin to last pass end over the run, per frame. */
  readonly spanMs: number
  /** The shares summed, per frame: the time any timed pass was running. */
  readonly busyMs: number
  /** In the order the first frame encoded them. */
  readonly passes: readonly PassTime[]
  /** Idle gaps of at least `GAP_FLOOR_MS` a frame, largest first. */
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

/** Gaps inside the timestamp quantum are noise, not a finding. */
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
  /** From the drain before the frames to the unmap after them. */
  #measuring = false
  #dropped = 0
  /*
   * The latest timestamp any earlier measurement read back. A query set keeps
   * its values between submissions, so a slot allocated and never written
   * resolves to whatever the last measurement left there rather than to zero;
   * the GPU clock only moves forward, so anything at or before this is stale.
   */
  #floor = 0n
  /*
   * The pass `initTimestampQuery` is about to be called for, kept as the raw
   * context or compute group and labeled only when armed: the hooks run on
   * every pass of every frame, and a label is a string built per pass.
   */
  #nextKind: PassKind | null = null
  #nextSubject: unknown = null
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
      this.#nextKind = 'render'
      this.#nextSubject = context
      try {
        beginRender.call(backend, context)
      } finally {
        this.#nextKind = null
        this.#nextSubject = null
      }
    }
    backend.beginCompute = (group) => {
      this.#nextKind = 'compute'
      this.#nextSubject = group
      try {
        beginCompute.call(backend, group)
      } finally {
        this.#nextKind = null
        this.#nextSubject = null
      }
    }
    backend.initTimestampQuery = (type, uid, descriptor) => {
      const kind = this.#nextKind
      if (this.#armed && kind !== null) {
        const label =
          kind === 'render'
            ? renderLabel(this.#nextSubject as { renderTarget: Target | null })
            : computeLabel(this.#nextSubject)
        const writes = this.#allocate(label, kind)
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
        // Slots are allocated two to a pass, in order.
        const label =
          this.#pending[current.beginningOfPassWriteIndex / 2]?.label
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
    this.#pending.push({ label, kind, slot })
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
    // The whole run, not only the readback: a second call during the first
    // drain would empty `#pending` under the frames the first one submitted.
    if (this.#measuring) throw new Error('A pass timeline is already running')
    this.#measuring = true
    try {
      this.#pending.length = 0
      this.#dropped = 0
      // Armed per frame rather than across the drains, so nothing encoded
      // while the queue drains is taken for one of these frames.
      const wallMs = await drainedFrameMs(
        this.#device,
        () => {
          this.#armed = true
          try {
            draw()
          } finally {
            this.#armed = false
          }
        },
        frames,
      )

      const used = this.#pending.length * 2
      if (used === 0)
        return summarize(
          [],
          new BigUint64Array(0),
          frames,
          wallMs,
          this.#dropped,
        )
      const queue = this.#device.queue
      const encoder = this.#device.createCommandEncoder({
        label: 'pass timeline resolve',
      })
      encoder.resolveQuerySet(this.#querySet, 0, used, this.#resolve, 0)
      encoder.copyBufferToBuffer(this.#resolve, 0, this.#read, 0, used * 8)
      queue.submit([encoder.finish()])
      await this.#read.mapAsync(GPUMapMode.READ, 0, used * 8)
      try {
        const times = new BigUint64Array(this.#read.getMappedRange(0, used * 8))
        const floor = this.#floor
        for (const time of times) if (time > this.#floor) this.#floor = time
        return summarize(
          this.#pending,
          times,
          frames,
          wallMs,
          this.#dropped,
          floor,
        )
      } finally {
        this.#read.unmap()
      }
    } finally {
      this.#measuring = false
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
 * **A raw pair is latency, not cost, on this machine.** Metal samples a
 * pass's timestamps at its stage boundaries, and Apple's GPUs pipeline
 * passes and frames deeply: at the shore at 3 m every pass of the sensor
 * chain, a 60×37 blur level and the canvas quad included, read 23–35 ms
 * begin to end in a frame the drained queue put at 24 ms. So each pass is
 * charged only for how far it moved the completion frontier — passes taken
 * in end order, a pass's share `end − max(frontier, begin)` — which sums to
 * the union of the intervals and puts a stall waiting on an earlier pass on
 * that pass rather than on every pass that overlapped it. Time with no pass
 * running is a gap, charged to neither neighbor.
 *
 * A pass whose end reads before its begin, or whose begin is at or before
 * `floor`, was not written — it allocated slots and then threw before it
 * encoded — and is left out rather than counted. `floor` is zero for a fresh
 * query set and the latest timestamp read back since: an unwritten slot holds
 * what the previous measurement left in it, not zero.
 */
export function summarize(
  pending: readonly Pending[],
  times: BigUint64Array,
  frames: number,
  wallMs: number,
  dropped: number,
  floor = 0n,
): PassTimelineResult {
  const intervals: Interval[] = []
  for (const pass of pending) {
    const begin = times[pass.slot]!
    const end = times[pass.slot + 1]!
    if (end < begin || begin <= floor) continue
    intervals.push({
      label: pass.label,
      kind: pass.kind,
      begin: Number(begin) / 1e6,
      end: Number(end) / 1e6,
    })
  }
  const empty = { frames, wallMs, dropped, gaps: [], passes: [] }
  if (intervals.length === 0) return { ...empty, spanMs: 0, busyMs: 0 }

  // The order a reader expects is the encoding order of the first frame.
  const order: string[] = []
  const totals = new Map<
    string,
    { kind: PassKind; count: number; ms: number; latency: number }
  >()
  for (const interval of intervals) {
    if (!totals.has(interval.label)) {
      order.push(interval.label)
      totals.set(interval.label, {
        kind: interval.kind,
        count: 0,
        ms: 0,
        latency: 0,
      })
    }
    const total = totals.get(interval.label)!
    total.count += 1
    total.latency += interval.end - interval.begin
  }

  /*
   * In end order, a pass is charged from the later of the previous end and
   * the earliest begin of any pass not yet ended — its own or a longer one's
   * that started first — to its own end. Before that earliest begin and after
   * the previous end nothing was running, so that stretch is a gap.
   */
  const byEnd = [...intervals].sort((a, b) => a.end - b.end)
  const earliest = new Array<number>(byEnd.length)
  for (let i = byEnd.length - 1, low = Infinity; i >= 0; i -= 1) {
    low = Math.min(low, byEnd[i]!.begin)
    earliest[i] = low
  }
  const gaps = new Map<
    string,
    { after: string; before: string; total: number }
  >()
  const first = earliest[0]!
  let frontier = first
  let busy = 0
  let previous: Interval | null = null
  byEnd.forEach((interval, i) => {
    const start = Math.max(frontier, earliest[i]!)
    if (previous !== null && start > frontier) {
      const key = `${previous.label}\u0000${interval.label}`
      const gap = gaps.get(key)
      if (gap === undefined)
        gaps.set(key, {
          after: previous.label,
          before: interval.label,
          total: start - frontier,
        })
      else gap.total += start - frontier
    }
    const share = interval.end - start
    totals.get(interval.label)!.ms += share
    busy += share
    frontier = interval.end
    previous = interval
  })

  return {
    ...empty,
    spanMs: (frontier - first) / frames,
    busyMs: busy / frames,
    passes: order.map((label) => {
      const total = totals.get(label)!
      return {
        label,
        kind: total.kind,
        count: total.count / frames,
        ms: total.ms / frames,
        latencyMs: total.latency / frames,
      }
    }),
    gaps: [...gaps.values()]
      .map(({ after, before, total }) => ({
        after,
        before,
        ms: total / frames,
      }))
      .filter((gap) => gap.ms >= GAP_FLOOR_MS)
      .sort((a, b) => b.ms - a.ms),
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
