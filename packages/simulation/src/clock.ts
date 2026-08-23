import {
  invariant,
  type Seconds,
  type Tick,
  tick as asTick,
} from '@inertialref/shared'

/*
 * Simulation time (ADR-0006).
 *
 * The tick rate is 64 Hz, not 60. That is not a performance choice: 1/64 is
 * exactly representable in binary, so `tick / TICK_RATE` is an *exact*
 * conversion at every tick and simulation time never accumulates a rounding
 * residue. At 60 Hz, 1/60 is a repeating binary fraction and two clients that
 * reached tick 10^7 by different routes disagree in the low bits — which is the
 * kind of divergence that only shows up as a desync hours into a session.
 *
 * Canonical state therefore depends only on the integer tick count. Wall clock
 * decides *how many* ticks to run and nothing else; rendering at 144 Hz and at
 * 60 Hz produce the same universe, and `stepExact` lets tests and replays run
 * with no wall clock at all.
 */

export const TICK_RATE = 64
export const TICK_DURATION: Seconds = 1 / TICK_RATE

/** Exact — TICK_DURATION is a power of two, so this never rounds. */
export const timeOfTick = (tick: Tick): Seconds => tick / TICK_RATE

/**
 * How many ticks may be run for a single frame *at 1×* before we give up and let
 * the clock fall behind. Without a cap, a tab that was backgrounded for a minute
 * comes back and tries to run 3,840 ticks in one frame, which freezes the page
 * and then tries again next frame — the classic spiral of death.
 */
export const DEFAULT_MAX_STEPS = 8

/**
 * The ceiling on time warp, as simulated seconds per second of wall clock.
 *
 * A fixed budget of 8 ticks per frame is the right guard against a *stalled*
 * frame and the wrong one for a *deliberate* one, and for a long time this class
 * could not tell the difference. The measurement: at 60 fps a budget of 8
 * delivers 480 ticks per second, which is 7.5× real time — so of the seven
 * detents the dev dock offers, from 1× to 100,000×, everything past 5× was
 * identical and every tick above it went straight into `droppedTicks`. Silently:
 * the clock was scrupulous about reporting the drops and nothing displayed them
 * next to the number they contradicted.
 *
 * 1,920× is 2048 ticks in a 60 Hz frame, which is ~1.6 ms at the ~1.25M ticks/s
 * measured in-browser for one entity — inside a 16.6 ms frame with room for a
 * machine several times slower. It is a measured number and not a principled
 * one; when the benchmark harness can say what a tick costs *here*, this should
 * be derived from a share of the frame rather than pinned.
 *
 * **A rate, and not a count per frame, and that is load-bearing.** The budget
 * used to be a flat 2048 ticks per frame, which meant that once warp saturated
 * it — anything past ~1,920×, so both of the top two detents, always — the
 * clock delivered a *constant* 32 simulated seconds every frame however long
 * the frame took. Simulated time then advanced per frame instead of per second,
 * so its rate was modulated by frame-time noise: ±2 ms of jitter at 60 fps is
 * ±12% of the sim rate, every frame. Everything in the scene inherits that, but
 * what makes it *visible* is a body's speed measured in its own radii, and
 * Phobos and Deimos cover 0.19 and 0.22 of their own radius per second against
 * 0.072 for the next worst (Mimas) and 0.0006 for Luna. They vibrated by a full
 * body width at 10,000× while every other moon in the Solar System held still.
 */
export const MAX_WARP_RATE = 1_920

/**
 * The longest frame the warp rate is honored across, in wall-clock seconds.
 *
 * Past this a frame is a *stall* — a backgrounded tab, a shader compile — not a
 * slow frame, and buying 1,920× of it would be the spiral of death with extra
 * steps. 100 ms keeps the rate honest down to 10 fps, which is below any frame
 * rate worth warping at, and caps a stalled frame's catch-up at
 * `MAX_WARP_STEPS` ticks (~10 ms of work at the rate measured above).
 */
export const MAX_WARP_FRAME: Seconds = 0.1

/** The absolute per-frame ceiling. Derived: the rate, over the longest frame. */
export const MAX_WARP_STEPS = MAX_WARP_RATE * MAX_WARP_FRAME * TICK_RATE

export interface ClockStatus {
  readonly tick: Tick
  readonly time: Seconds
  readonly paused: boolean
  readonly timeScale: number
  /** Fraction of the way into the next tick, for render interpolation. */
  readonly alpha: number
  /** Ticks dropped because the step budget ran out, cumulative. */
  readonly droppedTicks: number
  /**
   * The time scale actually being delivered, as of the last `advance`.
   *
   * Exactly `timeScale` whenever the clock is keeping up — this is a ratio of
   * ticks wanted to ticks run, not a sampled rate, so it does not wobble at 1×.
   * Below it, the step budget is capping and the difference is being dropped.
   * That gap is the number `timeScale` alone cannot tell you, and not showing it
   * is how a 100,000× button that delivers 7.5× survives.
   */
  readonly achievedTimeScale: number
}

export class SimulationClock {
  #tick: Tick = asTick(0)
  #accumulator: Seconds = 0
  #timeScale = 1
  #paused = false
  #droppedTicks = 0
  #achievedTimeScale = 1
  readonly #maxSteps: number

  constructor(options: { startTick?: Tick; maxSteps?: number } = {}) {
    this.#tick = options.startTick ?? asTick(0)
    this.#maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  }

  get tick(): Tick {
    return this.#tick
  }

  get time(): Seconds {
    return timeOfTick(this.#tick)
  }

  get paused(): boolean {
    return this.#paused
  }

  get timeScale(): number {
    return this.#timeScale
  }

  /**
   * The time scale actually being delivered. See `ClockStatus.achievedTimeScale`.
   *
   * A getter beside the one in `status()` because the performance overlay reads
   * it once per frame, and `status()` allocates an object to answer.
   */
  get achievedTimeScale(): number {
    return this.#achievedTimeScale
  }

  /** Interpolation factor in [0, 1) between the last tick and the next. */
  get alpha(): number {
    return this.#paused ? 0 : Math.min(1, this.#accumulator / TICK_DURATION)
  }

  setPaused(paused: boolean): void {
    this.#paused = paused
    if (paused) this.#accumulator = 0
  }

  /**
   * Time warp multiplies how many ticks a second of wall clock buys. The tick
   * *duration* never changes, so warped time is bit-identical to real time run
   * for longer — which is what makes a warped session replayable.
   */
  setTimeScale(scale: number): void {
    invariant(scale > 0 && Number.isFinite(scale), `Bad time scale ${scale}`)
    this.#timeScale = scale
  }

  /**
   * Consume wall-clock time and report how many fixed steps to run.
   *
   * The caller runs exactly that many; nothing about the simulation looks at
   * `realDelta` again.
   */
  advance(realDelta: Seconds): number {
    if (this.#paused || realDelta <= 0) {
      this.#achievedTimeScale = 0
      return 0
    }
    this.#accumulator += realDelta * this.#timeScale
    const wanted = Math.floor(this.#accumulator / TICK_DURATION)
    const steps = Math.min(wanted, this.#stepBudget(realDelta))
    // Ratio rather than a rate, so a frame that wanted one tick and ran one
    // reports 1× and not 0.94× — the accumulator carries the remainder and a
    // sampled rate would oscillate around the truth instead of stating it.
    this.#achievedTimeScale =
      wanted === 0 ? this.#timeScale : (this.#timeScale * steps) / wanted
    if (wanted > steps) {
      // Drop the excess rather than letting the accumulator grow without bound.
      this.#droppedTicks += wanted - steps
      this.#accumulator -= (wanted - steps) * TICK_DURATION
    }
    this.#accumulator -= steps * TICK_DURATION
    return steps
  }

  /**
   * Ticks this frame may run.
   *
   * At 1× this is the stall guard and nothing else — a count, unchanged, so a
   * backgrounded tab behaves exactly as it always has and the minute it was
   * away is honestly reported as dropped rather than simulated.
   *
   * Above 1× the player has asked for more simulation per frame and gets it,
   * bounded two ways. `maxSteps × timeScale` is the same stall guard scaled by
   * what was asked for, so a stall at 1.5× catches up like a stall at 1×. The
   * second bound is the throughput ceiling, and it is `MAX_WARP_RATE` *times
   * this frame's duration*: a rate rather than a count, so that a saturated
   * clock delivers simulated seconds in proportion to wall-clock seconds. A
   * count would fix the delivery per frame and let frame-time noise modulate
   * the rate — see `MAX_WARP_RATE` for what that looked like.
   *
   * At least one tick, so a frame too short to buy one does not instead drop
   * everything the accumulator is holding and freeze the simulation.
   */
  #stepBudget(realDelta: Seconds): number {
    if (this.#timeScale <= 1) return this.#maxSteps
    const usable = Math.min(realDelta, MAX_WARP_FRAME)
    return Math.min(
      Math.ceil(this.#maxSteps * this.#timeScale),
      Math.max(1, Math.floor((MAX_WARP_RATE * usable) / TICK_DURATION)),
    )
  }

  /** Called by the world once per completed tick. */
  commitTick(): Tick {
    this.#tick = asTick(this.#tick + 1)
    return this.#tick
  }

  /** Run n ticks with no wall clock involved. Tests, replay and headless runs. */
  stepExact(count: number): number {
    invariant(
      Number.isInteger(count) && count >= 0,
      `stepExact needs a whole count, got ${count}`,
    )
    return count
  }

  status(): ClockStatus {
    return {
      tick: this.#tick,
      time: this.time,
      paused: this.#paused,
      timeScale: this.#timeScale,
      alpha: this.alpha,
      droppedTicks: this.#droppedTicks,
      achievedTimeScale: this.#achievedTimeScale,
    }
  }

  /** Restore from a save. The accumulator is deliberately not persisted. */
  restore(tick: Tick): void {
    this.#tick = tick
    this.#accumulator = 0
  }
}
