/**
 * The frame's GPU time by pass, independent of the renderer that timed it —
 * `apps/game/src/render/passTimeline.ts` produces it, `ir.passes()` reports it.
 */
export interface PassReport {
  readonly frames: number
  /** Wall clock per frame across a drained queue — `ir.gpu()`'s figure. */
  readonly wallMs: number
  /** First pass begin to last pass end, per frame. */
  readonly spanMs: number
  /** The passes' shares summed, per frame: time any timed pass ran. */
  readonly busyMs: number
  readonly passes: readonly {
    readonly label: string
    readonly kind: 'render' | 'compute'
    readonly count: number
    /** How far the pass moved the completion frontier — its cost. */
    readonly ms: number
    /** Begin to end of the raw timestamp pair — its latency. */
    readonly latencyMs: number
  }[]
  /** Time between passes with no pass running. */
  readonly gaps: readonly {
    readonly after: string
    readonly before: string
    readonly ms: number
  }[]
  readonly dropped: number
}
