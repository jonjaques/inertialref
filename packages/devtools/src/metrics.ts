/*
 * Fixed-capacity sample series, for a performance overlay to plot.
 *
 * Lives here rather than in the client because it is arithmetic, and arithmetic
 * belongs somewhere it can be tested in Node. What the client adds is *what* to
 * sample — frame time, draw calls, the JS heap — all of which are DOM or Three.js
 * facts and none of which may come below `apps/`.
 *
 * Two properties shape the implementation, and both come from where it is used:
 *
 * - **`push` runs once per frame and must not allocate.** An overlay that adds
 *   garbage-collection pressure to the frame it is measuring is measuring
 *   itself. It is a write into a preallocated `Float64Array` and an index bump.
 * - **`summarise` runs at the rate a human reads**, eight times a second, over a
 *   few hundred samples. It sorts, because a p95 wants sorting and 240 elements
 *   is nothing at 8 Hz; the scratch buffer it sorts in is allocated once.
 *
 * The asymmetry is the whole design. Anything clever about incremental
 * percentiles would buy nothing and cost correctness.
 */

export interface SeriesStats {
  /** How many samples the window holds. Below `capacity` until it has filled. */
  readonly count: number
  readonly last: number
  readonly min: number
  readonly max: number
  readonly mean: number
  /**
   * The 95th percentile — nearest-rank, so it is always an observed sample and
   * never an interpolation between two.
   *
   * Frame time is the reason the overlay reports this rather than a maximum: one
   * 90 ms stall in four seconds is a real defect and a mean will not show it,
   * while a maximum shows every one-off and cannot be told apart from a defect.
   */
  readonly p95: number
}

const EMPTY: SeriesStats = {
  count: 0,
  last: 0,
  min: 0,
  max: 0,
  mean: 0,
  p95: 0,
}

export class Series {
  // Not a parameter property: `erasableSyntaxOnly` is on, so there is no such
  // thing here. See AGENTS.md.
  readonly capacity: number
  readonly #samples: Float64Array
  readonly #scratch: Float64Array
  #next = 0
  #count = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.#samples = new Float64Array(capacity)
    this.#scratch = new Float64Array(capacity)
  }

  /** Non-finite samples are dropped. A single NaN otherwise poisons every statistic. */
  push(value: number): void {
    if (!Number.isFinite(value)) return
    this.#samples[this.#next] = value
    this.#next = (this.#next + 1) % this.capacity
    if (this.#count < this.capacity) this.#count += 1
  }

  get count(): number {
    return this.#count
  }

  /**
   * Copy the window into `out`, oldest first, and return how many were written.
   *
   * Oldest-first because a plot reads left to right and the ring does not: the
   * newest sample sits wherever the write cursor happens to be. Takes the buffer
   * rather than returning one so the caller can keep it across frames.
   */
  drain(out: Float64Array): number {
    const written = Math.min(this.#count, out.length)
    // The window starts `count` behind the cursor, wrapped.
    const start = (this.#next - this.#count + this.capacity * 2) % this.capacity
    for (let i = 0; i < written; i += 1) {
      out[i] =
        this.#samples[(start + this.#count - written + i) % this.capacity] ?? 0
    }
    return written
  }

  summarise(): SeriesStats {
    if (this.#count === 0) return EMPTY
    // Reading slots `0..count` covers the window in both states and needs no
    // wrap: before the ring has filled, those are exactly the samples written;
    // once it has, `count === capacity` and every slot is live. Order does not
    // matter to any statistic here — `drain` is where it does.
    const scratch = this.#scratch
    let min = Infinity
    let max = -Infinity
    let total = 0
    /*
     * `Math.min`/`Math.max` rather than `<`/`>`, because the comparisons are
     * not a total order over signed zeros: `-0 < 0` is false, so a running
     * minimum built from `<` keeps whichever zero it saw first. Over a window
     * holding both, `min` came back `+0` where `Math.min` gives `-0` and `max`
     * came back `-0` where `Math.max` gives `+0` — the same defect twice, in
     * opposite directions.
     *
     * The statistic is meant to be the one a caller would compute from a plain
     * array, and "the minimum, except for signed zero" is not a specification
     * anybody can hold in their head. Nothing sampled here is ever a negative
     * zero — these are frame times, draw calls and heap bytes — so the cost is
     * a pair of intrinsic calls in a loop that runs at the rate a human reads,
     * and the gain is a contract with no footnote on it.
     */
    for (let i = 0; i < this.#count; i += 1) {
      const value = this.#samples[i] ?? 0
      scratch[i] = value
      min = Math.min(min, value)
      max = Math.max(max, value)
      total += value
    }
    // `subarray` is a view, so this sorts in place and allocates nothing.
    scratch.subarray(0, this.#count).sort()
    // Nearest-rank: the smallest observed sample at or above the 95th percentile.
    const rank = Math.min(this.#count - 1, Math.ceil(0.95 * this.#count) - 1)
    const last = (this.#next - 1 + this.capacity) % this.capacity
    return {
      count: this.#count,
      last: this.#samples[last] ?? 0,
      min,
      max,
      mean: total / this.#count,
      p95: scratch[Math.max(0, rank)] ?? 0,
    }
  }

  reset(): void {
    this.#next = 0
    this.#count = 0
  }
}
