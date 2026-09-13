import {
  decodeTourPlan,
  type TourCommand,
  type TourPlan,
  type TourStop,
} from '@inertialref/protocol'

export interface TourRunnerStatus {
  readonly state: 'idle' | 'traveling' | 'viewing' | 'paused' | 'ended'
  readonly index: number
  readonly stopId: string | null
  readonly planId: string | null
  readonly arrived: boolean
  readonly completedNarration: boolean
  readonly reason: string | null
  readonly elapsedSeconds: number
}
export interface TourRunnerOptions {
  /** Monotonic milliseconds, injected by the host. */
  readonly now: () => number
  readonly automatic?: boolean
  readonly onStop: (stop: TourStop) => void
  readonly onChange?: () => void
}

export class TourRunner {
  readonly #options: TourRunnerOptions
  #plan: TourPlan | null = null
  #index = -1
  #state: TourRunnerStatus['state'] = 'idle'
  #arrival: { time: number; revision: number } | null = null
  #narration = false
  #narrationAt: number | null = null
  #reason: string | null = null
  #pausedAt: number | null = null

  constructor(options: TourRunnerOptions) {
    this.#options = options
  }

  status(): TourRunnerStatus {
    return {
      state: this.#state,
      index: this.#index,
      stopId: this.#stop?.id ?? null,
      planId: this.#plan?.id ?? null,
      arrived: this.#arrival !== null,
      completedNarration: this.#narration,
      reason: this.#reason,
      elapsedSeconds:
        this.#arrival === null
          ? 0
          : Math.max(
              0,
              ((this.#pausedAt ?? this.#options.now()) - this.#arrival.time) /
                1000,
            ),
    }
  }
  get #stop(): TourStop | null {
    return this.#plan?.stops[this.#index] ?? null
  }
  start(plan: TourPlan): void {
    if (!decodeTourPlan(plan, 'plan').ok) throw new Error('Invalid tour plan.')
    this.#plan = plan
    this.#index = 0
    this.#enter()
  }
  #enter(): void {
    this.#arrival = null
    this.#narration = false
    this.#narrationAt = null
    this.#reason = null
    this.#pausedAt = null
    const stop = this.#stop
    this.#state = stop === null ? 'ended' : 'traveling'
    this.#options.onChange?.()
    if (stop !== null) this.#options.onStop(stop)
  }
  command(command: TourCommand): void {
    if (command === 'end') {
      this.#state = 'ended'
      this.#arrival = null
      this.#options.onChange?.()
      return
    }
    if (this.#plan === null || this.#state === 'ended') return
    if (command === 'pause') {
      this.fail(null)
      return
    }
    if (command === 'resume') {
      if (this.#state !== 'paused') return
      if (this.#arrival === null) {
        this.#enter()
        return
      }
      const pausedFor = Math.max(
        0,
        this.#options.now() - (this.#pausedAt ?? this.#options.now()),
      )
      this.#arrival.time += pausedFor
      if (this.#narrationAt !== null) this.#narrationAt += pausedFor
      this.#pausedAt = null
      this.#state = 'viewing'
      this.#reason = null
      this.#options.onChange?.()
      return
    }
    if (command === 'next' || command === 'back') {
      this.#index =
        command === 'next' ? this.#index + 1 : Math.max(0, this.#index - 1)
      this.#enter()
    }
  }
  fail(reason: string | null): void {
    if (this.#state === 'ended' || this.#state === 'idle') return
    if (this.#state !== 'paused') this.#pausedAt = this.#options.now()
    this.#state = 'paused'
    this.#reason = reason
    this.#options.onChange?.()
  }
  resumeAt(viewRevision: number): void {
    if (this.#state !== 'paused') return
    if (this.#arrival === null) {
      this.#enter()
      return
    }
    this.#arrival = { time: this.#options.now(), revision: viewRevision }
    this.#narration = false
    this.#narrationAt = null
    this.#pausedAt = null
    this.#reason = null
    this.#state = 'viewing'
    this.#options.onChange?.()
  }
  arrived(stopId: string, viewRevision: number): void {
    if (
      this.#stop?.id !== stopId ||
      this.#state !== 'traveling' ||
      this.#arrival !== null
    )
      return
    this.#arrival = { time: this.#options.now(), revision: viewRevision }
    this.#state = 'viewing'
    this.#options.onChange?.()
  }
  narrationEnded(stopId: string, viewRevision: number): void {
    if (
      this.#stop?.id !== stopId ||
      this.#arrival?.revision !== viewRevision ||
      this.#state !== 'viewing'
    )
      return
    this.#narration = true
    this.#narrationAt ??= this.#options.now()
    this.#options.onChange?.()
  }
  tick(): void {
    if (
      !this.#options.automatic ||
      this.#state !== 'viewing' ||
      !this.#narration ||
      this.#arrival === null ||
      this.#stop === null
    )
      return
    if (
      this.#options.now() - this.#arrival.time >=
        this.#stop.minimumViewSeconds * 1000 &&
      this.#narrationAt !== null &&
      this.#options.now() - this.#narrationAt >=
        (this.#stop.lookSeconds ?? 0) * 1000
    )
      this.command('next')
  }
}
