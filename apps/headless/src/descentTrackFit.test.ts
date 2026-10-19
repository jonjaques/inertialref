import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Vec } from '@inertialref/spatial'
import {
  type LinePath,
  linePosition,
  lineVelocity,
} from '@inertialref/rendering'
import {
  DESCENT_RAIL,
  fitLinePath,
  screenPositionOf,
  type SubjectTrackRow,
  subjectTrackBeats,
  TNG_HULL_LENGTH,
  TNG_LENS,
} from '@inertialref/devtools'

/*
 * The credit descent, fitted to the reference's per-frame track instead of to
 * its ~20 hand-read beats — a measurement, not a change to the script.
 *
 * `DESCENT_RAIL` misses its own beats by 0.096 and 0.102 of the frame at f1920
 * and f1960. Whether that is the reference refusing a straight line or the
 * beats being read where they were is a question the beats cannot answer, and
 * the 1639-frame track in `data/reference/tng-subject-track.json` can: weight
 * every frame by whether its range is a measurement (`subjectTrackBeats`,
 * which applies `design/plans/tng-intro.md` § 1), fit a free line to all of
 * them, and compare the two lines against the same frames.
 *
 * Measured, f1920–1960, against the track: the track-fitted line runs 0.043 of
 * the frame at worst and 0.038 on average; `DESCENT_RAIL` runs 0.090 and
 * 0.085. The figure holds across the channel rules — moving the edge margin,
 * the step threshold, the transient threshold or the pair's selection gives
 * 0.025 to 0.047. So about half of the residual is the beats; the rest, ~0.04,
 * is the reference's, which over the whole weighted span fits a line at an
 * rms of 0.033.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url))
const track = (
  JSON.parse(
    readFileSync(`${root}/data/reference/tng-subject-track.json`, 'utf8'),
  ) as { track: SubjectTrackRow[] }
).track

const LENS = { fov: TNG_LENS.fov, aspect: TNG_LENS.aspect }
const { beats, pairOverBox } = subjectTrackBeats(track, {
  from: 1758,
  to: 2130,
  hullLength: TNG_HULL_LENGTH,
  ...LENS,
})
const weighted = beats.filter((beat) => (beat.weight ?? 1) > 0)
const fit = fitLinePath(beats, { ...LENS, reach: 60000 })

/** Worst and mean screen distance from a path to the weighted track. */
function against(path: LinePath, from: number, to: number) {
  let worst = 0
  let sum = 0
  let count = 0
  for (const beat of weighted) {
    if (beat.frame < from || beat.frame > to) continue
    const at = screenPositionOf(linePosition(path, beat.frame))
    const error = Math.hypot(at.x - beat.x, at.y - beat.y)
    worst = Math.max(worst, error)
    sum += error
    count += 1
  }
  return { worst, mean: sum / count, count }
}

describe('the credit descent against the per-frame track', () => {
  it('weights only the frames whose range is a measurement', () => {
    /*
     * 216 of the 373 frames in f1758–2130. Before f1794 the hull is against
     * the top edge; from f2059 the box is against the left one and then the
     * frame; nine frames of the window are one-frame transients, f1767 and a
     * jump every sixteen frames or so from f1783. The pair carries the range
     * on 61 of the 216, the stitched box on the rest.
     */
    expect(weighted.length).toBe(216)
    expect(weighted[0]?.frame).toBe(1794)
    expect(weighted.at(-1)?.frame).toBe(2058)
    /*
     * And the two range channels disagree about the closing by this much
     * where both measure it: the pair's range over the box's runs 0.907 to
     * 1.137 after calibration. The bound is that disagreement.
     */
    for (const { frame, ratio } of pairOverBox) {
      expect(ratio, `f${frame}`).toBeGreaterThan(0.9)
      expect(ratio, `f${frame}`).toBeLessThan(1.14)
    }
  })

  it('fits f1920–1960 at half the beat-fitted rail’s residual', () => {
    const tracked = against(fit.path, 1920, 1960)
    const beaten = against(DESCENT_RAIL, 1920, 1960)
    expect(tracked.count).toBe(41)
    // 0.043 against 0.090.
    expect(tracked.worst).toBeLessThan(0.05)
    expect(tracked.worst).toBeLessThan(0.55 * beaten.worst)
    // Over the whole weighted span: rms 0.033, worst 0.060.
    expect(fit.rms).toBeLessThan(0.035)
    expect(against(fit.path, 1794, 2058).worst).toBeLessThan(0.065)
  })

  it('finds a direction 6.2° from the landed one, and a throttle that never reverses', () => {
    /*
     * The direction is the other half of the answer: the beats and the track
     * disagree about the line, not only about the marks. The script keeps
     * `DESCENT_RAIL` until a capture says otherwise.
     */
    const angle =
      (Math.acos(
        Math.min(1, Vec.dot(fit.path.direction, DESCENT_RAIL.direction)),
      ) *
        180) /
      Math.PI
    expect(angle).toBeGreaterThan(5.5)
    expect(angle).toBeLessThan(7)
    const first = fit.path.advance[0]?.frame as number
    const last = fit.path.advance.at(-1)?.frame as number
    for (let f = first; f <= last; f += 0.25)
      expect(
        Vec.dot(lineVelocity(fit.path, f), fit.path.direction),
        `reverses at f${f}`,
      ).toBeGreaterThanOrEqual(0)
  })
})
