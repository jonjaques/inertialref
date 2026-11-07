import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CONTOUR_FLOOR, CONTOUR_POINTS } from '@inertialref/protocol'
import {
  contourOf,
  parseLoudnessFrames,
  parseLoudnessSummary,
  parseSilenceCues,
  planGain,
} from './loudness.ts'

/*
 * The logs below are ffmpeg 9.0's own output over Stellardrone's "Messier 45",
 * trimmed but not rewritten, so a change in what ffmpeg prints shows up here
 * as a parse failure rather than as a catalog full of NaN.
 */
const SUMMARY_LOG = `[Parsed_silencedetect_0 @ 0x7993010f00] silence_start: 0
[Parsed_silencedetect_0 @ 0x7993010f00] silence_end: 3.31093 | silence_duration: 3.31093
[Parsed_silencedetect_0 @ 0x7993010f00] silence_start: 145.030136
[Parsed_silencedetect_0 @ 0x7993010f00] silence_end: 146.44068 | silence_duration: 1.410544
[Parsed_ebur128_1 @ 0x7993010fc0] Summary:
[Parsed_ebur128_1 @ 0x7568c489c0] Summary:

  Integrated loudness:
    I:         -15.0 LUFS
    Threshold: -26.4 LUFS

  Loudness range:
    LRA:        16.1 LU
    Threshold: -36.4 LUFS
    LRA low:   -28.3 LUFS
    LRA high:  -12.2 LUFS

  True peak:
    Peak:       -1.0 dBFS
`

const FRAME_LOG = `[Parsed_ebur128_0 @ 0x77e8c48900] t: 0.0999773  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -72.5 -72.9 dBFS  TPK: -72.5 -72.9 dBFS
[Parsed_ebur128_0 @ 0x77e8c48900] t: 0.199977   TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -71.4 -71.3 dBFS  TPK: -71.4 -71.3 dBFS
[Parsed_ebur128_0 @ 0x77e8c48900] t: 3.899977   TARGET:-23 LUFS    M: -67.2 S: -70.9     I: -68.5 LUFS       LRA:   0.0 LU  FTPK: -57.4 -61.2 dBFS  TPK: -57.4 -58.9 dBFS
`

describe('parseLoudnessSummary', () => {
  it('reads the integrated loudness, the range and the true peak', () => {
    expect(parseLoudnessSummary(SUMMARY_LOG)).toEqual({
      integrated: -15,
      range: 16.1,
      truePeak: -1,
    })
  })

  it('reads the last summary, not a frame line', () => {
    // A frame line carries `I:` too; the summary is what follows it.
    expect(parseLoudnessSummary(FRAME_LOG + SUMMARY_LOG).integrated).toBe(-15)
  })

  it('reads a peak of silence as minus infinity', () => {
    const silent = SUMMARY_LOG.replace('-1.0 dBFS', '-inf dBFS')
    expect(parseLoudnessSummary(silent).truePeak).toBe(Number.NEGATIVE_INFINITY)
  })

  it('refuses a log with no summary', () => {
    expect(() => parseLoudnessSummary(FRAME_LOG)).toThrow(/no summary/)
  })
})

describe('parseLoudnessFrames', () => {
  it('reads each frame’s time and short-term loudness', () => {
    expect(parseLoudnessFrames(FRAME_LOG)).toEqual([
      { t: 0.0999773, shortTerm: -120.7 },
      { t: 0.199977, shortTerm: -120.7 },
      { t: 3.899977, shortTerm: -70.9 },
    ])
  })
})

describe('parseSilenceCues', () => {
  it('takes the lead-in and the tail and nothing in between', () => {
    expect(parseSilenceCues(SUMMARY_LOG, 146.44068)).toEqual({
      start: 3.311,
      end: 145.03,
    })
  })

  it('leaves a rest in the middle of a piece alone', () => {
    const log =
      'silence_start: 60.5\nsilence_end: 62.1 | silence_duration: 1.6\n'
    expect(parseSilenceCues(log, 300)).toEqual({ start: 0, end: 300 })
  })

  it('reads a silence that is never ended as the tail', () => {
    expect(parseSilenceCues('silence_start: 290.25\n', 300)).toEqual({
      start: 0,
      end: 290.25,
    })
  })

  it('falls back to the whole file for a file that is all silence', () => {
    expect(parseSilenceCues('silence_start: 0\n', 12)).toEqual({
      start: 0,
      end: 12,
    })
  })
})

describe('contourOf', () => {
  it('has the catalog’s length, inside the floor and full scale', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc.double({ min: 0, max: 299.9, noNaN: true }),
            shortTerm: fc.oneof(
              fc.double({ min: -130, max: 3, noNaN: true }),
              fc.constant(Number.NEGATIVE_INFINITY),
            ),
          }),
        ),
        (frames) => {
          const contour = contourOf(frames, 300)
          expect(contour).toHaveLength(CONTOUR_POINTS)
          for (const point of contour) {
            expect(Number.isInteger(point)).toBe(true)
            expect(point).toBeGreaterThanOrEqual(CONTOUR_FLOOR)
            expect(point).toBeLessThanOrEqual(0)
          }
        },
      ),
    )
  })

  it('reads a constant level back as that level everywhere', () => {
    fc.assert(
      fc.property(fc.integer({ min: -60, max: -6 }), (level) => {
        const frames = Array.from({ length: 3_000 }, (_, i) => ({
          t: i / 10,
          shortTerm: level,
        }))
        expect(new Set(contourOf(frames, 300))).toEqual(new Set([level]))
      }),
    )
  })

  it('averages power, not decibels', () => {
    // Two frames at −20 and −40 in one slot: the power mean is −23.0, where a
    // mean of the decibels would say −30.
    const contour = contourOf(
      [
        { t: 0, shortTerm: -20 },
        { t: 0.1, shortTerm: -40 },
      ],
      100,
      1,
    )
    expect(contour).toEqual([-23])
  })
})

describe('planGain', () => {
  const target = { integrated: -18, truePeak: -1 }

  it('never puts the true peak above the ceiling less the margin', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -40, max: -5, noNaN: true }),
        fc.double({ min: -20, max: 6, noNaN: true }),
        (integrated, truePeak) => {
          const { gain } = planGain({ integrated, truePeak }, target, 0.3)
          expect(truePeak + gain).toBeLessThanOrEqual(
            target.truePeak - 0.3 + 0.006,
          )
        },
      ),
    )
  })

  it('reaches the target exactly when the ceiling allows it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -30, max: -8, noNaN: true }),
        // A peak-to-loudness ratio under 16.7 dB, the most a track can have and
        // still reach −18 LUFS with its peak 0.3 dB under a −1 dBTP ceiling.
        fc.double({ min: 3, max: 16.5, noNaN: true }),
        (integrated, crest) => {
          const plan = planGain(
            { integrated, truePeak: integrated + crest },
            target,
            0.3,
          )
          expect(plan.capped).toBe(false)
          expect(integrated + plan.gain).toBeCloseTo(target.integrated, 1)
        },
      ),
    )
  })

  it('caps a very dynamic recording at the ceiling and says so', () => {
    // The Satie, as the spike measured it: −25.9 LUFS with a −6.8 dBTP peak.
    expect(planGain({ integrated: -25.9, truePeak: -6.8 }, target)).toEqual({
      gain: 5.5,
      capped: true,
    })
  })
})
