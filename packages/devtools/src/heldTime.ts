/*
 * The photographic instant: the time a planetarium picture is taken at.
 *
 * Either held — a number of seconds past J2000 that a preset names, advanced by
 * the planetarium's own rate while unpaused — or released, in which case it is
 * whatever the live simulation is presenting. Released is not the same as
 * zero: a picture taken without a held instant is a picture of now, and `time`
 * answers with the host's `renderTime` for exactly that reason.
 *
 * Bounded both ways. A rate is in `(0, MAX_TIME_SCALE]`, and an instant within
 * `TIME_LIMIT` of J2000 — a hundred thousand years, past which the ephemerides
 * are fiction. Advancing past the limit pauses rather than overflowing, so a
 * clock left running at the top rate stops at the edge of the model instead of
 * walking the planets somewhere no element set describes.
 */

/** A hundred thousand Julian years, in seconds: the reach of a held instant. */
export const TIME_LIMIT = 3.15576e12

/** The fastest photographic rate, simulated seconds per presented second. */
export const MAX_TIME_SCALE = 100_000

export class HeldTime {
  readonly #live: () => number
  #time: number | null = null
  #paused = true
  #scale = 1

  /** `live` is the instant a released clock answers with — `renderTime`. */
  constructor(live: () => number) {
    this.#live = live
  }

  /** The held instant, or the live presentation time when nothing is held. */
  get time(): number {
    return this.#time ?? this.#live()
  }

  get heldTime(): number | null {
    return this.#time
  }

  get paused(): boolean {
    return this.#paused
  }

  get scale(): number {
    return this.#scale
  }

  setPaused(paused: boolean): void {
    this.#paused = paused
  }

  setScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0 || scale > MAX_TIME_SCALE)
      throw new Error('Invalid photographic time rate.')
    this.#scale = scale
  }

  /**
   * Hold an instant, or release to the live clock with `null`. Either way the
   * clock stops: a preset is a still, and it is the viewer who starts it.
   */
  set(time: number | null): void {
    if (
      time !== null &&
      (!Number.isFinite(time) || Math.abs(time) > TIME_LIMIT)
    )
      throw new Error('Choose a finite time within 100,000 years of J2000.')
    this.#time = time
    this.#paused = true
  }

  /** Let go of the held instant without touching the pause or the rate. */
  release(): void {
    this.#time = null
  }

  /** Run a held, unpaused clock forward by presented seconds. */
  advance(seconds: number): void {
    if (this.#time === null || this.#paused) return
    const next = this.#time + Math.max(0, seconds) * this.#scale
    if (Math.abs(next) <= TIME_LIMIT) this.#time = next
    else this.#paused = true
  }
}
