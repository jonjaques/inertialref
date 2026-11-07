import { describe, expect, it } from 'vitest'
import { analyzeFrames, reportFrames } from './frameDiff.mjs'

/*
 * A run of frames as a model of what is in them, so the counts under test are
 * this file's arithmetic and not ImageMagick's. Frame `i` sits `position(i)`
 * pixels along a pan and departs from the scene by `departure(i)` pixels of
 * its own. Two frames differ by the sensor's `noise`, by the pan between them,
 * and by any departure they do not share. That makes the count a function of
 * two paths rather than of a pair index, which is what the port has to be: the
 * skip comparison asks about frames that are not adjacent.
 */
const run = (
  n,
  { noise = 0, position = () => 0, departure = () => 0 } = {},
) => {
  const paths = Array.from(
    { length: n },
    (_, i) => `cast/${String(i).padStart(4, '0')}.jpg`,
  )
  const index = new Map(paths.map((one, i) => [one, i]))
  const asked = []
  const changed = async (a, b) => {
    const i = index.get(a)
    const j = index.get(b)
    asked.push([i, j])
    const departed =
      departure(i) === departure(j) ? 0 : departure(i) + departure(j)
    return noise + Math.abs(position(i) - position(j)) + departed
  }
  return { paths, changed, asked }
}

const analyze = ({ paths, changed }, timestamps = null) =>
  analyzeFrames(paths, timestamps, { changed })

/** Seconds at a steady rate, as a cast or a trace reports them. */
const at = (n, fps) => Array.from({ length: n }, (_, i) => i / fps)

const frames = (list) => list.map((one) => one.frame)

/** The lunar terrain strobe: one frame in 26 departs by 30,050 px. */
const strobe = () =>
  run(182, { departure: (i) => (i % 26 === 13 ? 30_050 : 0) })

describe('analyzeFrames', () => {
  it('reads a static run as quiet: every pair 0 px, nothing isolated', async () => {
    expect(await analyze(run(30))).toEqual({
      frames: 30,
      pairs: Array(29).fill(0),
      quiet: 0,
      isolated: [],
      events: [],
      period: null,
      hz: null,
    })
  })

  it('holds a static run to a 200 px floor, since six times a zero median admits every stray pixel', async () => {
    const departing = (px) =>
      analyze(run(30, { departure: (i) => (i === 12 ? px : 0) }))
    expect((await departing(200)).isolated).toEqual([])
    const above = await departing(201)
    expect(above.isolated).toEqual([{ frame: 12, changed: 201, skip: 0 }])
    // One event has no gap to measure, so it has no period.
    expect(above.period).toBeNull()
  })

  it('raises the floor to six times the median pair on a noisy run', async () => {
    // Noise puts 100 px between any two frames, so the median is 100 and the
    // floor is 600: a 500 px departure reads 600 against its neighbors.
    const departing = (px) =>
      analyze(run(30, { noise: 100, departure: (i) => (i === 12 ? px : 0) }))
    const below = await departing(500)
    expect(below.quiet).toBe(100)
    expect(below.isolated).toEqual([])
    expect((await departing(501)).isolated).toEqual([
      { frame: 12, changed: 601, skip: 100 },
    ])
  })

  it('finds nothing isolated in a moving camera, because the skip pair differs as much as its neighbors', async () => {
    // Still for 40 frames, then panning 5,000 px a frame. The median pair is
    // 0, so all 19 panning pairs clear the floor; only the skip comparison
    // tells them from a strobe.
    const pan = await analyze(
      run(60, { position: (i) => Math.max(0, i - 40) * 5000 }),
    )
    expect(pan.quiet).toBe(0)
    expect(pan.pairs.filter((px) => px > 200)).toHaveLength(19)
    expect(pan.isolated).toEqual([])
  })

  it('isolates a frame only when its neighbors differ by less than a quarter of its departure', async () => {
    // Frame 12 departs by 4,000 px and the camera moves `d` px as it ends.
    const neighbors = (d) =>
      analyze(
        run(30, {
          position: (i) => (i >= 13 ? d : 0),
          departure: (i) => (i === 12 ? 4000 : 0),
        }),
      )
    expect((await neighbors(1000)).isolated).toEqual([])
    expect(frames((await neighbors(999)).isolated)).toEqual([12])
  })

  it('measures a one-frame flash every 26 frames at 60 fps as period 26, about 2.3 Hz', async () => {
    const flash = strobe()
    const found = await analyze(flash, at(182, 60))
    expect(frames(found.events)).toEqual([13, 39, 65, 91, 117, 143, 169])
    expect(found.isolated).toEqual(
      found.events.map((one) => ({
        frame: one.frame,
        changed: 30_050,
        skip: 0,
      })),
    )
    expect(found.period).toBe(26)
    expect(found.hz).toBeCloseTo(60 / 26, 9)
    // 181 adjacent pairs, then one skip pair around each departure: the frames
    // either side of it, which are not adjacent to each other.
    expect(flash.asked).toHaveLength(181 + 7)
    expect(flash.asked.slice(181)).toEqual(
      frames(found.events).map((frame) => [frame - 1, frame + 1]),
    )
  })

  it('takes the period as the median gap, so a flash missed once does not move it', async () => {
    // The flash at 65 never departs, so the gaps are 26, 52, 26.
    const missed = await analyze(
      run(140, {
        departure: (i) => ([13, 39, 91, 117].includes(i) ? 30_050 : 0),
      }),
    )
    expect(frames(missed.events)).toEqual([13, 39, 91, 117])
    expect(missed.period).toBe(26)
  })

  it('keeps the period and gives no rate when the timestamps cannot be trusted', async () => {
    // One short, as a cast that lost its last timestamp would be.
    const short = await analyze(strobe(), at(181, 60))
    expect(short.period).toBe(26)
    expect(short.hz).toBeNull()
    // Every frame at one instant, as a trace whose clock never advanced.
    const still = await analyze(strobe(), Array(182).fill(0))
    expect(still.period).toBe(26)
    expect(still.hz).toBeNull()
  })

  it('folds a departure three frames behind another into one event, so gaps alternating 3 and 23 recur every 26', async () => {
    // The terrain collapse: the disk drops to a coarse level, then the level
    // under it arrives three frames later.
    const collapse = await analyze(
      run(140, {
        departure: (i) => (i % 26 === 10 ? 30_050 : i % 26 === 13 ? 8000 : 0),
      }),
    )
    expect(frames(collapse.isolated)).toEqual([
      10, 13, 36, 39, 62, 65, 88, 91, 114, 117,
    ])
    expect(frames(collapse.events)).toEqual([10, 36, 62, 88, 114])
    expect(collapse.period).toBe(26)
  })

  it('merges departures five frames apart, and not six', async () => {
    const apart = (gap) =>
      analyze(
        run(30, {
          departure: (i) => (i === 10 ? 30_050 : i === 10 + gap ? 8000 : 0),
        }),
      )
    expect(frames((await apart(5)).events)).toEqual([10])
    expect(frames((await apart(6)).events)).toEqual([10, 16])
  })

  it('counts pixels with ImageMagick unless told otherwise, and says so when it cannot run', async () => {
    // The default drive.mjs and traceFrames.mjs rely on. Without `magick`
    // on PATH the spawn fails; with it, the frames do not exist. Both are
    // the same error, and neither is a count.
    await expect(
      analyzeFrames(['missing/0000.jpg', 'missing/0001.jpg']),
    ).rejects.toThrow('ImageMagick failed — is `magick` on PATH?')
  })
})

describe('reportFrames', () => {
  const quiet = {
    frames: 120,
    pairs: [],
    quiet: 3,
    isolated: [],
    events: [],
    period: null,
    hz: null,
  }
  const clear =
    'frames 120, quiet pair 3 px\n' +
    'no isolated frames — nothing strobes, or the camera is moving and this cannot tell'

  it('calls a quiet run below 40 fps subsampled rather than an all-clear', () => {
    expect(reportFrames(quiet, 39.9)).toBe(
      `${clear} — and 39.9 fps is subsampling the page, so this is not an all-clear`,
    )
  })

  it('trusts a quiet run at 40 fps, and one with no rate to judge it by', () => {
    expect(reportFrames(quiet, 40)).toBe(clear)
    expect(reportFrames(quiet)).toBe(clear)
    // traceFrames.mjs passes 0 for a trace whose frames share one timestamp.
    expect(reportFrames(quiet, 0)).toBe(clear)
  })

  it('names the first six events of a strobe and gives its rate in hertz', async () => {
    const found = await analyze(strobe(), at(182, 60))
    expect(reportFrames(found, 60)).toBe(
      [
        'frames 182, quiet pair 0 px',
        '7 events over 7 isolated frames, every 26 frames — 2.31 Hz',
        ...[13, 39, 65, 91, 117, 143].map(
          (frame) =>
            `  frame ${frame}: 30050 px against its neighbors, 0 px between them`,
        ),
        '  …and 1 more',
      ].join('\n'),
    )
  })

  it('reports a strobe it saw at any rate, with a period it cannot measure from one event', async () => {
    // A departure seen is evidence even at 18 fps; the caveat is for a
    // result that would otherwise read as an all-clear.
    const once = await analyze(
      run(30, { departure: (i) => (i === 12 ? 30_050 : 0) }),
    )
    expect(reportFrames(once, 18)).toBe(
      [
        'frames 30, quiet pair 0 px',
        '1 events over 1 isolated frames, every ? frames',
        '  frame 12: 30050 px against its neighbors, 0 px between them',
      ].join('\n'),
    )
  })
})
