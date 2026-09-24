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
  /** Every pass's own duration summed, per frame. */
  readonly busyMs: number
  readonly passes: readonly {
    readonly label: string
    readonly kind: 'render' | 'compute'
    readonly count: number
    readonly ms: number
  }[]
  /** Negative where two passes overlap, which a tiled GPU does. */
  readonly gaps: readonly {
    readonly after: string
    readonly before: string
    readonly ms: number
  }[]
  readonly dropped: number
}
