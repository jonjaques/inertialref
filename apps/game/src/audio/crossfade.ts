/*
 * The shape of a fade, and how it is put on an `AudioParam`.
 *
 * **Equal power, not equal gain.** Two unrelated pieces of music add as power,
 * not as amplitude, so a linear crossfade — one gain falling as the other
 * rises, summing to one — dips by 3 dB at the midpoint, which is a hole in
 * the middle of every transition. Sine and cosine quarter-cycles keep
 * `out² + in²` at one throughout, so the total is level while the pieces
 * change places. That is the property `crossfade.test.ts` holds, and the one
 * `pnpm drive` renders through a real `OfflineAudioContext` to measure.
 *
 * **A fade starts from wherever the gain is.** A skip pressed in the middle
 * of a crossfade, or a pause during a fade-in, has a gain somewhere between
 * the ends, and a curve that began at its nominal value would jump there
 * first — a click, at full scale, on the louder of the two pieces. So each
 * curve is the equal-power quarter-cycle re-entered at the angle the current
 * gain sits at.
 *
 * Pure, and the `AudioParam` is a structural type, so all of this runs in a
 * Node test with a fake param that records what it was told.
 */

/** As much of an `AudioParam` as a fade uses. */
export interface FadeParam {
  readonly value: number
  cancelScheduledValues(time: number): unknown
  setValueAtTime(value: number, time: number): unknown
  setValueCurveAtTime(
    curve: Float32Array,
    time: number,
    duration: number,
  ): unknown
  /** Absent before Firefox 136; `scheduleFade` falls back without it. */
  cancelAndHoldAtTime?: (time: number) => unknown
}

/**
 * Points per second of curve. `setValueCurveAtTime` interpolates linearly
 * between points, and at 50 a second the worst chord error on a quarter sine is
 * far below anything audible; more is memory per fade for nothing.
 */
const POINTS_PER_SECOND = 50

/**
 * An equal-power curve from `from` to `to`, `points` long.
 *
 * Both ends are angles on the same quarter circle: a gain `g` sits at
 * `asin(g)` on the way in. Interpolating the angle rather than the gain is
 * what keeps a partial fade on the equal-power path. Gains are clamped to
 * [0, 1], which is the only range this module is ever asked about.
 */
export function equalPowerCurve(
  from: number,
  to: number,
  points: number,
): Float32Array {
  const count = Math.max(2, Math.round(points))
  const start = Math.asin(clamp(from))
  const end = Math.asin(clamp(to))
  const curve = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1)
    curve[i] = Math.sin(start + (end - start) * t)
  }
  // Exactly the target at the end, so a fade to silence is silence and not
  // 1e-17 of the outgoing track for the rest of its life.
  curve[count - 1] = clamp(to)
  return curve
}

/**
 * Move `param` from its present value to `to` over `seconds`, starting at
 * `at` on the context clock.
 *
 * Every earlier automation is cancelled first, because
 * `setValueCurveAtTime` throws on a curve that overlaps another event — and
 * a fade replacing a fade is the ordinary case, not the edge one. The value
 * held is the value the param has *now*: `cancelAndHoldAtTime` reads it from
 * the automation itself, and where that is missing `param.value` is the same
 * number one render quantum stale, which is 3 ms of a multi-second fade.
 *
 * A zero-length fade is a cut, set on the next quantum.
 */
export function scheduleFade(
  param: FadeParam,
  to: number,
  seconds: number,
  at: number,
): void {
  if (param.cancelAndHoldAtTime !== undefined) param.cancelAndHoldAtTime(at)
  else {
    param.cancelScheduledValues(at)
    param.setValueAtTime(param.value, at)
  }
  if (!(seconds > 0)) {
    param.setValueAtTime(clamp(to), at)
    return
  }
  const curve = equalPowerCurve(
    param.value,
    to,
    Math.max(2, seconds * POINTS_PER_SECOND),
  )
  param.setValueCurveAtTime(curve, at, seconds)
}

/**
 * How long a transition takes, given how much of each piece there is to fade
 * over.
 *
 * The preference is an upper bound, not a promise. Half of either piece is the
 * most a fade may take — a two-minute track does not spend a minute of itself
 * fading — and a skip is never slower than `skip`, because somebody who
 * pressed Next wanted the next thing, not a slow dissolve into it.
 */
export function transitionSeconds(
  preferred: number,
  outgoingLeft: number,
  incomingLength: number,
  skip: number | null = null,
): number {
  const ceiling = Math.min(outgoingLeft, incomingLength / 2)
  const wanted = skip === null ? preferred : Math.min(preferred, skip)
  return Math.max(0, Math.min(wanted, ceiling))
}

const clamp = (gain: number): number => Math.min(1, Math.max(0, gain))
