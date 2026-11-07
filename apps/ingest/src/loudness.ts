import { CONTOUR_FLOOR, CONTOUR_POINTS } from '@inertialref/protocol'

/*
 * What ffmpeg's loudness and silence filters print, read back as numbers, and
 * the one decision made from them: how much gain a track gets.
 *
 * Pure, so the arithmetic is testable without ffmpeg on the machine — CI's
 * runner has none, and the encode is not something the suite should depend on.
 * `audio.ts` runs the filters and hands their logs here.
 *
 * **Gain only, and never a limiter.** Every track is moved toward one
 * integrated loudness by a single linear gain, and a track whose peaks would
 * cross the ceiling first is given less gain rather than compressed. A limiter
 * changes the dynamics, and whether two decibels of limiting on a Satie
 * recording is transparent is a question for ears this pipeline does not have;
 * a gain is provably transparent. The cost is that a few very dynamic pieces
 * play a little under the target, and `manifest.json` names them.
 */

/** EBU R128, as `ebur128=peak=true` reports it over a whole file. */
export interface LoudnessSummary {
  /** Integrated loudness, LUFS. */
  readonly integrated: number
  /** Loudness range, LU. */
  readonly range: number
  /** True peak, dBTP — the oversampled peak, not the sample peak. */
  readonly truePeak: number
}

/** One momentary/short-term reading from the filter's frame log. */
export interface LoudnessFrame {
  /** Seconds from the start. */
  readonly t: number
  /** Short-term loudness (3 s window), LUFS. */
  readonly shortTerm: number
}

const number = (text: string | undefined): number => {
  if (text === undefined) return Number.NaN
  if (/^-?inf$/i.test(text.trim())) return Number.NEGATIVE_INFINITY
  return Number(text)
}

/**
 * The summary block ffmpeg prints when `ebur128` finishes.
 *
 * Read from the *last* summary in the log rather than the first match of each
 * label, because a filter graph with two scanners prints two summaries and the
 * frame log lines carry an `I:` of their own on every line.
 */
export function parseLoudnessSummary(log: string): LoudnessSummary {
  const at = log.lastIndexOf('Summary:')
  if (at < 0) throw new Error('ebur128 printed no summary')
  const summary = log.slice(at)
  const integrated = number(/I:\s+(-?[\d.]+|-?inf)\s+LUFS/.exec(summary)?.[1])
  const range = number(/LRA:\s+(-?[\d.]+|-?inf)\s+LU\b/.exec(summary)?.[1])
  const truePeak = number(/Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/.exec(summary)?.[1])
  if (![integrated, range, truePeak].every((value) => !Number.isNaN(value))) {
    throw new Error(`ebur128 summary did not parse:\n${summary.slice(0, 400)}`)
  }
  return { integrated, range, truePeak }
}

/**
 * The frame log `ebur128=framelog=verbose` prints, ten lines a second.
 *
 * `S:` is the short-term loudness, which is the contour's unit: momentary
 * (400 ms) is too twitchy to draw at 64 points, and the integrated value on the
 * same line is gated and cumulative — the loudness *so far*, not *here*.
 */
export function parseLoudnessFrames(log: string): readonly LoudnessFrame[] {
  const frames: LoudnessFrame[] = []
  const line = /\bt:\s*([\d.]+)\s+TARGET:.*?\bS:\s*(-?[\d.]+|-?inf)/g
  for (const match of log.matchAll(line)) {
    frames.push({ t: Number(match[1]), shortTerm: number(match[2]) })
  }
  return frames
}

/**
 * Short-term loudness across a track, `points` integers in LUFS.
 *
 * Each point is the power mean of the frames in its slice of the track — the
 * loudness of that stretch as a whole, which is what a scrubber's silhouette
 * should show and what a transition hunting for a quiet entry should read. The
 * floor stands in for silence: −∞ is not a number a chart or a JSON file can
 * hold, and nothing below about −60 is audible over a room.
 */
export function contourOf(
  frames: readonly LoudnessFrame[],
  duration: number,
  points = CONTOUR_POINTS,
  floor = CONTOUR_FLOOR,
): readonly number[] {
  const power = new Float64Array(points)
  const count = new Uint32Array(points)
  for (const frame of frames) {
    if (!(duration > 0)) break
    const slot = Math.min(points - 1, Math.floor((frame.t / duration) * points))
    if (slot < 0) continue
    const level = Number.isFinite(frame.shortTerm) ? frame.shortTerm : floor
    power[slot] = power[slot]! + 10 ** (Math.max(level, floor) / 10)
    count[slot] = count[slot]! + 1
  }
  const contour: number[] = []
  for (let slot = 0; slot < points; slot += 1) {
    const mean = count[slot] === 0 ? 0 : power[slot]! / count[slot]!
    const level = mean > 0 ? 10 * Math.log10(mean) : floor
    contour.push(Math.round(Math.min(0, Math.max(floor, level))))
  }
  // A slot no frame landed in — a track shorter than its contour has slots,
  // or a log that ended early — takes its neighbor's value rather than the
  // floor, which would draw a fault into the silhouette that is not there.
  for (let slot = 1; slot < points; slot += 1) {
    if (count[slot] === 0 && count[slot - 1] !== 0) {
      contour[slot] = contour[slot - 1]!
      count[slot] = 1
    }
  }
  return contour
}

/**
 * Where the music starts and stops, from `silencedetect`'s log.
 *
 * A stretch of silence that begins at (or within a few milliseconds of) zero
 * is the lead-in, and one that never ends — or ends at the end of the file —
 * is the tail. Silences in the middle of a piece are part of the piece and are
 * left alone: a rest is not a gap.
 */
export function parseSilenceCues(
  log: string,
  duration: number,
): { readonly start: number; readonly end: number } {
  const starts = [...log.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) =>
    Number(m[1]),
  )
  const ends = [...log.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) =>
    Number(m[1]),
  )
  let start = 0
  let end = duration
  // The lead-in: a silence that starts at the top of the file.
  if (starts.length > 0 && starts[0]! <= 0.05) {
    start = ends.length > 0 ? Math.min(ends[0]!, duration) : duration
  }
  // The tail: the last silence that starts and is never ended, or ends at EOF.
  const lastStart = starts.at(-1)
  if (lastStart !== undefined && lastStart > start) {
    const ended = ends.find((value) => value >= lastStart)
    if (ended === undefined || ended >= duration - 0.05) end = lastStart
  }
  if (!(end > start)) return { start: 0, end: duration }
  return { start: round3(start), end: round3(end) }
}

export interface GainPlan {
  /** dB, to two places. Negative turns the track down. */
  readonly gain: number
  /** Whether the true-peak ceiling, not the loudness target, set the gain. */
  readonly capped: boolean
}

/**
 * The gain that moves a track to `target` without its true peak passing
 * `ceiling`.
 *
 * `margin` is room for the encoder: a lossy codec rebuilds the waveform from
 * quantized coefficients and the rebuilt peaks land a little above the
 * originals, typically a few tenths of a decibel. The delivered files are
 * measured again afterward and turned down by any overshoot that remains.
 */
export function planGain(
  measured: Pick<LoudnessSummary, 'integrated' | 'truePeak'>,
  target: { readonly integrated: number; readonly truePeak: number },
  margin = 0.3,
): GainPlan {
  const wanted = target.integrated - measured.integrated
  const headroom = target.truePeak - margin - measured.truePeak
  const capped = wanted > headroom
  const gain = capped ? headroom : wanted
  return { gain: Math.round(gain * 100) / 100, capped }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000
