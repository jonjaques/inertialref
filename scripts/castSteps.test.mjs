import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  afterEvent,
  againstControl,
  alignFrames,
  changedStepsOf,
  controlHolds,
  floorOf,
  gapsOf,
  GRID,
  heldNoise,
  lumaGrid,
  readSteps,
  STEP,
  stepsOf,
  trailFloor,
  trailMeasure,
} from './castSteps.mjs'

/*
 * Synthetic casts: a series is a function of the path frame, and a cast is
 * the path frames it captured. So a gap is a path frame left out, the same
 * function read at both arms, and every number under test is this file's
 * arithmetic, not a decoder's.
 */

/** A deterministic noise in [−amp, amp], by path frame. */
const jitter = (k, amp) => amp * Math.sin(k * 12.9898 + 4.1414)

/** The path frames 0..n − 1 without `missing`. */
const captured = (n, missing = []) =>
  Array.from({ length: n }, (_, k) => k).filter((k) => !missing.includes(k))

/** A cast: its path frames and one series' values at them. */
const castOf = (ks, value) => ({ ks, values: ks.map(value) })

/** A camera moving at 1 level a frame, with noise well under the floor. */
const motion = (k) => 100 + k + jitter(k, 0.1)

const FLOOR = floorOf('whole')

describe('the floor', () => {
  it('is 0.4% of full scale with no held cast, and three held noises past it', () => {
    expect(FLOOR).toBeCloseTo(0.004 * 255, 10)
    expect(floorOf('opacity')).toBeCloseTo(0.004, 10)
    expect(floorOf('whole', { whole: 0.1 })).toBeCloseTo(FLOOR, 10)
    expect(floorOf('whole', { whole: 0.5 })).toBeCloseTo(1.5, 10)
  })

  it('takes a held cast’s noise as the spread of its first differences', () => {
    // A held cast whose mean wanders by a normal of σ = 0.2 a frame: the
    // MAD-scaled spread of its differences is √2·0.2, the difference of two.
    const ks = captured(400)
    let seed = 7
    const normal = () => {
      seed = (seed * 16807) % 2147483647
      const u = seed / 2147483647
      seed = (seed * 16807) % 2147483647
      const v = seed / 2147483647
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    }
    const values = ks.map(() => 50 + 0.2 * normal())
    const noise = heldNoise({ whole: values }).whole
    expect(noise).toBeGreaterThan(0.2 * Math.SQRT2 * 0.85)
    expect(noise).toBeLessThan(0.2 * Math.SQRT2 * 1.15)
  })
})

describe('a step in a moving camera’s cast', () => {
  it('reads smooth motion as no step, where frameDiff’s median floor would not', () => {
    const { ks, values } = castOf(captured(200), motion)
    expect(stepsOf(ks, values, FLOOR)).toEqual([])
  })

  it('flags a level that jumps and stays, which the strobe test passes over', () => {
    const { ks, values } = castOf(
      captured(200),
      (k) => motion(k) + (k >= 120 ? 4 : 0),
    )
    const steps = stepsOf(ks, values, FLOOR)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ from: 119, to: 120, span: 1 })
    // The residual is the jump, not the jump plus the motion's 1 a frame.
    expect(steps[0].residual).toBeCloseTo(4, 0)
  })

  it('flags a step under 6 MADs of nothing but above the floor, and none below it', () => {
    const at = (size) =>
      stepsOf(
        ...Object.values(
          castOf(captured(100), (k) => 100 + (k >= 50 ? size : 0)),
        ),
        FLOOR,
      )
    expect(at(FLOOR * 1.1)).toHaveLength(1)
    expect(at(FLOOR * 0.9)).toHaveLength(0)
  })

  it('reads a gap in smooth motion as nothing: the span scales the expectation, not the noise', () => {
    // Three path frames missing at 1 level a frame is a difference of 4. Read
    // as one frame against a median of 1, that is a step of 3, three floors.
    const { ks, values } = castOf(captured(200, [80, 81, 82]), motion)
    expect(stepsOf(ks, values, FLOOR)).toEqual([])
  })

  it('still flags a real step across a gap, at its whole size', () => {
    const { ks, values } = castOf(
      captured(200, [80, 81]),
      (k) => motion(k) + (k >= 82 ? 3 : 0),
    )
    const steps = stepsOf(ks, values, FLOOR)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ from: 79, to: 82, span: 3 })
    expect(steps[0].residual).toBeCloseTo(3, 0)
  })

  it('holds no gap within the ruling to a step, at any motion and any gaps (property)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.uniqueArray(fc.integer({ min: 20, max: 179 }), { maxLength: 6 }),
        (slope, missing) => {
          // Two in a row at most: the ruling refuses three.
          const gaps = missing.filter(
            (k) => !(missing.includes(k - 1) && missing.includes(k - 2)),
          )
          const { ks, values } = castOf(
            captured(200, gaps),
            (k) => 100 + slope * k + jitter(k, 0.1),
          )
          return stepsOf(ks, values, FLOOR).length === 0
        },
      ),
    )
  })
})

describe('the changed pixels', () => {
  const ks = captured(60)
  const counts = ks.slice(1).map(() => 1000)

  it('flags a pair past four times its window’s median', () => {
    const popped = counts.map((count, p) => (p === 30 ? 5000 : count))
    expect(changedStepsOf(ks, popped).map((one) => one.frame)).toEqual([31])
  })

  it('leaves a pair the strobe test claims to frameDiff', () => {
    const popped = counts.map((count, p) =>
      p === 30 || p === 31 ? 5000 : count,
    )
    expect(changedStepsOf(ks, popped, [31])).toEqual([])
  })

  it('scales the median by the span across a gap', () => {
    const gapped = captured(61, [31])
    const across = gapped.slice(1).map((k, p) => (k - gapped[p]) * 1000)
    expect(changedStepsOf(gapped, across)).toEqual([])
  })

  it('holds a static scene to frameDiff’s 200 px floor, since four times zero is zero', () => {
    const still = ks
      .slice(1)
      .map((_, p) => (p === 20 ? 150 : p === 40 ? 250 : 0))
    expect(changedStepsOf(ks, still).map((one) => one.frame)).toEqual([41])
  })
})

describe('against the control', () => {
  const PATH = 200

  it('reports the steps the control lacks and lists the ones it holds apart', () => {
    // A terrain pop at 60 in both arms; a cloud step at 140 in the cast alone.
    const terrain = (k) => (k >= 60 ? 5 : 0)
    const cast = castOf(
      captured(PATH),
      (k) => motion(k) + terrain(k) + (k >= 140 ? -4 : 0),
    )
    const control = castOf(captured(PATH), (k) => motion(k) + terrain(k))
    const steps = readSteps({ ks: cast.ks, series: { whole: cast.values } })
    const { lacked, shared } = againstControl(
      steps,
      {
        ks: control.ks,
        series: { whole: control.values },
        steps: readSteps({ ks: control.ks, series: { whole: control.values } }),
      },
      PATH,
    )
    expect(lacked.map((one) => one.to)).toEqual([140])
    expect(shared.map((one) => one.to)).toEqual([60])
  })

  it('finds a step in a gap in both arms as nothing in either', () => {
    // The fixture the ruling asks for: both arms drop around the same height.
    const cast = castOf(captured(PATH, [100, 101]), motion)
    const control = castOf(captured(PATH, [99, 100]), motion)
    expect(readSteps({ ks: cast.ks, series: { whole: cast.values } })).toEqual(
      [],
    )
    expect(
      readSteps({ ks: control.ks, series: { whole: control.values } }),
    ).toEqual([])
  })

  it('compares a step with the control’s change over the same path span', () => {
    // The control's own frames straddle the cast's step differently, and its
    // own step list is empty here, so only the span comparison can hold it.
    const scene = (k) => motion(k) + (k >= 71 ? 5 : 0)
    const cast = castOf(captured(PATH), scene)
    const control = castOf(captured(PATH, [70, 71, 72]), scene)
    const [step] = stepsOf(cast.ks, cast.values, FLOOR)
    expect(step).toMatchObject({ from: 70, to: 71 })
    const holds = controlHolds(
      { series: 'whole', ...step },
      { ks: control.ks, series: { whole: control.values }, steps: [] },
      // A long path, so the 3% reach is not what matches it.
      1,
    )
    expect(holds).toBe(true)
    const lacks = controlHolds(
      { series: 'whole', ...step },
      { ks: control.ks, series: { whole: control.ks.map(motion) }, steps: [] },
      1,
    )
    expect(lacks).toBe(false)
  })

  it('never lets the control hold an opacity step: it serves none', () => {
    expect(
      controlHolds(
        { series: 'opacity', from: 5, to: 6, residual: 1 },
        { ks: [], series: {}, steps: [{ series: 'opacity', from: 5, to: 6 }] },
        100,
      ),
    ).toBe(false)
  })
})

describe('the alignment and the gaps', () => {
  const log = Array.from({ length: 100 }, (_, k) => ({ k, at: 1000 + k * 16 }))

  it('matches each frame to the last log entry before its instant', () => {
    // The screencast's instants are seconds; the log's are milliseconds.
    const instants = [0, 1, 2, 5, 6].map((k) => (1000 + k * 16 + 3) / 1000)
    expect(alignFrames(5, instants, log)).toEqual({
      ks: [0, 1, 2, 5, 6],
      by: 'instants',
    })
  })

  it('assumes one path frame a capture where no instants were kept, and says so', () => {
    expect(alignFrames(3, null, log)).toEqual({ ks: [0, 1, 2], by: 'assumed' })
  })

  it('keeps a cast under 3% missing with no three in a row, and retakes the rest', () => {
    expect(gapsOf(captured(100, [10, 11, 50]), 100)).toMatchObject({
      missing: 3,
      longest: 2,
      retake: false,
    })
    expect(gapsOf(captured(100, [10, 11, 12]), 100).retake).toBe(true)
    expect(gapsOf(captured(100, [10, 20, 30, 40]), 100).retake).toBe(true)
    expect(
      gapsOf(
        captured(100).filter((k) => k % 2 === 0),
        100,
      ).retake,
    ).toBe(true)
  })
})

describe('the grid', () => {
  it('reads each cell’s mean apart from the whole frame’s', () => {
    const width = 8
    const height = 6
    const pixels = new Uint8Array(width * height * 3)
    // Cell 1,2: the second row, third column, lit white.
    for (let y = 2; y < 4; y += 1)
      for (let x = 4; x < 6; x += 1)
        pixels.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3)
    const grid = lumaGrid(pixels, width, height)
    expect(grid.cells).toHaveLength(GRID.columns * GRID.rows)
    expect(grid.cells[1 * GRID.columns + 2]).toBeCloseTo(255, 6)
    expect(grid.cells.filter((one) => one === 0)).toHaveLength(11)
    expect(grid.whole).toBeCloseTo(255 / 12, 6)
  })
})

describe('the trail', () => {
  const width = 48
  const height = 32
  const plane = (value) =>
    Float64Array.from({ length: width * height }, (_, i) =>
      value(i % width, Math.floor(i / width)),
    )

  it('reads one sample a pixel becoming eight as noise the blur removes', () => {
    const settled = plane(() => 120)
    const grainy = plane((x, y) => 120 + ((x + y) % 2 === 0 ? 12 : -12))
    expect(trailMeasure(settled, grainy, width, height, 1)).toBeCloseTo(
      12 / 255,
      6,
    )
    expect(trailMeasure(settled, grainy, width, height, 3)).toBeLessThan(
      trailFloor(),
    )
  })

  it('reads a cloud-sized smear past the floor', () => {
    const settled = plane(() => 120)
    const ghost = plane((x, y) =>
      x > 10 && x < 30 && y > 5 && y < 25 ? 140 : 120,
    )
    expect(trailMeasure(settled, ghost, width, height, 3)).toBeGreaterThan(
      trailFloor(),
    )
  })

  it('floors at 0.5% of full scale, or twice a held cast’s measure', () => {
    expect(trailFloor()).toBe(0.005)
    expect(trailFloor(0.001)).toBe(0.005)
    expect(trailFloor(0.004)).toBe(0.008)
  })
})

describe('after a cut', () => {
  const plate = Float64Array.from({ length: 12 }, () => 100)
  const plateCells = Array(12).fill(100)
  const frame = (value) => Float64Array.from({ length: 12 }, () => value)
  const floors = { rmse: 1, luminance: 1 }

  it('passes frames that approach the plate', () => {
    const values = [80, 90, 95, 99, 100]
    expect(
      afterEvent({
        frames: values.map(frame),
        cells: values.map((v) => Array(12).fill(v)),
        plate,
        plateCells,
        floors,
      }).passes,
    ).toBe(true)
  })

  it('fails a cell that overshoots the plate, though the RMSE falls', () => {
    const values = [80, 90, 103, 100]
    const result = afterEvent({
      frames: values.map(frame),
      cells: values.map((v) => Array(12).fill(v)),
      plate,
      plateCells,
      floors,
    })
    expect(result.overshoot.by).toBeCloseTo(3, 10)
    expect(result.passes).toBe(false)
  })

  it('fails an RMSE that rises past the event’s frame', () => {
    const values = [95, 90, 100]
    expect(
      afterEvent({
        frames: values.map(frame),
        cells: values.map(() => plateCells),
        plate,
        plateCells,
        floors,
      }).passes,
    ).toBe(false)
  })

  it('judges nothing without the picture’s floors', () => {
    expect(
      afterEvent({
        frames: [frame(90)],
        cells: [plateCells],
        plate,
        plateCells,
      }).passes,
    ).toBe(null)
  })
})

describe('the numbers', () => {
  it('are the rubric’s and the ruling’s', () => {
    expect(STEP).toMatchObject({
      window: 16,
      mads: 6,
      floorShare: 0.004,
      heldNoise: 3,
      changedTimes: 4,
      control: 0.03,
      gapShare: 0.03,
      gapRun: 3,
    })
  })
})
