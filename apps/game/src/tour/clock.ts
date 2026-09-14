/*
 * The speech clock: when has the guide finished a beat?
 *
 * The provider has no event for the end of spoken output, and on WebRTC the
 * speech is a media track the browser plays, so the browser is the one
 * witness that can measure it. Output audio streams continuously whether or
 * not the guide is talking, so the presence of audio is no signal at all;
 * the level is. The runtime feeds this clock an RMS level from an
 * `AnalyserNode` on the remote track every hundred milliseconds, and the
 * clock says whether the guide is speaking and when a beat has ended.
 *
 * A beat ends after speech has *begun* since the beat's words were returned
 * and then stayed below the floor for `quietMs`. The order matters: Live
 * fills the wait for backend work with an acknowledgment ("Mmm, good
 * question! I'm double checking."), and a clock that measured silence from
 * the end of that filler fired inside the beat it was meant to follow. The
 * numbers are the probe's, tuned against recorded conversations in phase 3.
 */

export interface SpeechClockOptions {
  readonly now: () => number
  /** RMS above which a frame counts as speech. The probe measured silence near 0.001 and speech from 0.02. */
  readonly floor?: number
  /** Quiet after speech that ends a beat. */
  readonly quietMs?: number
}

export type BeatOutcome = 'spoken' | 'silent' | 'canceled'

interface Waiter {
  readonly since: number
  readonly startBy: number
  readonly by: number
  spoke: boolean
  readonly resolve: (outcome: BeatOutcome) => void
}

export class SpeechClock {
  readonly #options: SpeechClockOptions
  #lastLoudAt = -Infinity
  #waiter: Waiter | null = null

  constructor(options: SpeechClockOptions) {
    this.#options = options
  }

  get floor(): number {
    return this.#options.floor ?? 0.01
  }
  get quietMs(): number {
    return this.#options.quietMs ?? 1500
  }
  get speaking(): boolean {
    return this.#options.now() - this.#lastLoudAt < this.quietMs
  }
  get lastLoudAt(): number {
    return this.#lastLoudAt
  }

  /** One level sample from the remote track. Call at a steady rate. */
  sample(level: number): void {
    const now = this.#options.now()
    if (level > this.floor) this.#lastLoudAt = now
    const waiter = this.#waiter
    if (waiter === null) return
    if (!waiter.spoke) {
      if (this.#lastLoudAt >= waiter.since) waiter.spoke = true
      else if (now >= waiter.startBy) this.#settle('silent')
      return
    }
    if (now - this.#lastLoudAt >= this.quietMs) this.#settle('spoken')
    else if (now >= waiter.by) this.#settle('spoken')
  }

  /**
   * Resolve once speech that began after `since` has ended, or when no
   * speech begins within `startTimeoutMs`, or after `maxMs` regardless.
   * A second wait cancels the first.
   */
  waitForBeat(options: {
    since: number
    startTimeoutMs?: number
    maxMs?: number
  }): Promise<BeatOutcome> {
    this.cancel()
    const now = this.#options.now()
    return new Promise((resolve) => {
      this.#waiter = {
        since: options.since,
        startBy: now + (options.startTimeoutMs ?? 8000),
        by: now + (options.maxMs ?? 90_000),
        spoke: this.#lastLoudAt >= options.since,
        resolve,
      }
    })
  }

  cancel(): void {
    this.#settle('canceled')
  }

  #settle(outcome: BeatOutcome): void {
    const waiter = this.#waiter
    if (waiter === null) return
    this.#waiter = null
    waiter.resolve(outcome)
  }
}
