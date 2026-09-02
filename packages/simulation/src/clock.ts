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
 * The ceiling on *integration*, as simulated seconds per second of wall clock.
 *
 * Not the ceiling on time warp: a tick every entity coasts through is
 * propagated from an epoch and jumped rather than stepped (ADR-0025), and there
 * is no rate at which that can be too fast. What this bounds is the ticks a
 * frame runs one at a time — a thrusting ship, a descent through air.
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

/**
 * How a frame's wall clock is to be spent: what it bought, and how much of that
 * may be integrated.
 *
 * Two numbers because two things cost differently. A tick that is integrated
 * — a thrusting ship, a descent through air — costs a microsecond and is what
 * the stall guard and the rate ceiling are about. A tick that every entity
 * coasts over on rails (ADR-0025) costs nothing at all, and there is no reason
 * to deliver fewer of them than the player asked for. So `wanted` is what the
 * accumulator holds, bounded only by the stall guards, and `budget` is how many
 * of those the world may take one at a time; the world runs the rest by
 * jumping, or drops them.
 */
export interface FramePlan {
  readonly wanted: number
  readonly budget: number
}

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

  /**
   * The instant presentation is drawn at — one tick behind, plus the alpha.
   *
   * **Everything that places something in a frame must agree on this number**,
   * and it lives here because the clock owns both halves of it. It was
   * previously written out only inside `snapshot`, so anything else that wanted
   * "now" for presentation reached for `time` instead — which is the *tick*, a
   * quantity that only moves in 1/64 s steps.
   *
   * The gap between the two is at most one tick, which sounds harmless and is
   * not. A body drawn at `renderTime` while the camera pointed at it is placed
   * at `time` disagree by that body's velocity times up to 15.6 ms, and the gap
   * sawtooths as alpha sweeps and resets — so the error is not a constant
   * offset, it is a vibration at the beat between the frame rate and the tick
   * rate. What that costs is the error in units of the thing's own radius, and
   * Phobos and Deimos are 11.3 km and 6.2 km of radius carried around the Sun
   * at 24 km/s: 400 m of it, which is 3.5% and 6.6% of their own radius. Framed
   * in the planetarium they vibrated by 11 and 19 pixels while Mars, Luna and Io
   * — three orders of magnitude larger against the same 400 m — held still
   * inside a twentieth of a pixel.
   *
   * `terrainStreamer` already had to learn this ("terrain that disagrees with
   * the ship about what time it is drifts from under it"). This is the same
   * mistake in the camera, and having one definition is what stops it being
   * made a third time.
   */
  get renderTime(): Seconds {
    return this.renderTimeAt(this.alpha)
  }

  /** `renderTime` for an alpha the caller supplies. `snapshot` takes one. */
  renderTimeAt(alpha: number): Seconds {
    return this.time - (1 - alpha) * TICK_DURATION
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
   * `realDelta` again. `plan` and `settle` are the two halves of this for a
   * caller that can jump — the world — and this is the pair composed for one
   * that steps every tick it is given.
   */
  advance(realDelta: Seconds): number {
    const { wanted, budget } = this.plan(realDelta)
    const steps = Math.min(wanted, budget)
    this.settle(steps)
    return steps
  }

  /**
   * Ticks the accumulator asked for on the frame being planned, for `settle`.
   * Null between frames and for a frame that bought nothing — paused, or no
   * wall clock passed — so `settle` can tell "asked for nothing and ran it"
   * (a sub-tick frame, delivered in full) from "not running at all".
   */
  #asked: number | null = null

  /**
   * Consume wall-clock time and say what this frame may do with it.
   *
   * At 1× and below the stall guard is the whole story: a backgrounded minute
   * comes back as eight ticks and a dropped count, whether the ship is coasting
   * or not, so the world a player returns to is the one they left. Above 1×
   * the player has asked for more simulation per frame, and `wanted` is what
   * the frame bought at the requested rate over at most `MAX_WARP_FRAME` of
   * it — never less than the integration budget, so a stall at 100× catches
   * up exactly as it did when integration was the only way to run a tick.
   */
  plan(realDelta: Seconds): FramePlan {
    if (this.#paused || realDelta <= 0) {
      this.#asked = null
      this.#achievedTimeScale = 0
      return { wanted: 0, budget: 0 }
    }
    this.#accumulator += realDelta * this.#timeScale
    const asked = Math.floor(this.#accumulator / TICK_DURATION)
    this.#asked = asked
    const budget = this.#stepBudget(realDelta)
    if (this.#timeScale <= 1) return { wanted: Math.min(asked, budget), budget }
    const usable = Math.min(realDelta, MAX_WARP_FRAME)
    const ceiling = Math.max(
      1,
      Math.ceil((this.#timeScale * usable) / TICK_DURATION),
    )
    return { wanted: Math.min(asked, Math.max(budget, ceiling)), budget }
  }

  /**
   * Record how many of the planned ticks actually ran, and drop the rest.
   *
   * Ratio rather than a rate, so a frame that wanted one tick and ran one
   * reports 1× and not 0.94× — the accumulator carries the remainder and a
   * sampled rate would oscillate around the truth instead of stating it.
   */
  settle(ran: number): void {
    const asked = this.#asked
    this.#asked = null
    // A frame that bought nothing has nothing to settle, and its 0× stands:
    // the `asked === 0` case below is a sub-tick frame, not a paused one.
    if (asked === null) return
    this.#achievedTimeScale =
      asked === 0 ? this.#timeScale : (this.#timeScale * ran) / asked
    if (asked > ran) {
      // Drop the excess rather than letting the accumulator grow without bound.
      this.#droppedTicks += asked - ran
    }
    this.#accumulator -= asked * TICK_DURATION
  }

  /**
   * Ticks this frame may *integrate*. What it coasts through is not bounded
   * here — that is `plan`'s `wanted`, and the world jumps it.
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

  /** Called by the world once per jump over a coast: `count` ticks at once. */
  commitTicks(count: number): Tick {
    invariant(
      Number.isInteger(count) && count > 0,
      `commitTicks needs a positive whole count, got ${count}`,
    )
    this.#tick = asTick(this.#tick + count)
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
