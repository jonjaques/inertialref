import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, vec3 } from '@inertialref/spatial'
import type { ThrustDemand } from '@inertialref/simulation'
import {
  nozzleFiring,
  prepareNozzles,
  type Nozzle,
  type ThrusterLayout,
} from './thrusters.ts'
import {
  nozzleValveSeed,
  rotationStopCue,
  ThrusterVisuals,
  valveOpening,
} from './thrusterVisuals.ts'

const nozzle = (
  position: Nozzle['position'],
  exhaust: Nozzle['exhaust'],
): Nozzle => ({
  position,
  exhaust,
  radius: 0.1,
  kind: 'rcs',
})

// One valve for each sign of each torque axis, all beyond the full lever.
const layout: ThrusterLayout = {
  nozzles: [
    nozzle(vec3(0, 0, -4), Vec.UNIT_Y),
    nozzle(vec3(0, 0, -4), Vec.negate(Vec.UNIT_Y)),
    nozzle(vec3(0, 0, -4), Vec.UNIT_X),
    nozzle(vec3(0, 0, -4), Vec.negate(Vec.UNIT_X)),
    nozzle(vec3(4, 0, 0), Vec.UNIT_Y),
    nozzle(vec3(4, 0, 0), Vec.negate(Vec.UNIT_Y)),
  ],
  drive: null,
}
const neutral: ThrustDemand = Object.freeze({
  linear: Vec.ZERO,
  angular: Vec.ZERO,
  drive: 0,
})
const unit = fc.double({ min: -1, max: 1, noNaN: true })
const axes = fc.tuple(unit, unit, unit).map(([x, y, z]) => vec3(x, y, z))
const demandArb: fc.Arbitrary<ThrustDemand> = fc.record({
  linear: axes,
  angular: axes,
  drive: fc.double({ min: 0, max: 1, noNaN: true }),
})
const exactFiring = (demand: ThrustDemand): Float32Array => {
  const out = new Float32Array(layout.nozzles.length)
  nozzleFiring(prepareNozzles(layout), demand, out)
  return out
}

describe('the stop-spin picture', () => {
  it('captures the opposite direction with bounded strength and duration (property)', () => {
    fc.assert(
      fc.property(
        axes.filter((value) => Vec.length(value) > 0.1),
        fc.double({ min: 0.000001, max: 100, noNaN: true }),
        fc.double({ min: 0.001, max: 10, noNaN: true }),
        (direction, speed, authority) => {
          const spin = Object.freeze(Vec.withLength(direction, speed))
          const cue = rotationStopCue(spin, authority, 17)
          expect(cue).not.toBeNull()
          if (cue === null) return
          const strength = Vec.length(cue.angular)
          expect(strength).toBeGreaterThanOrEqual(0.12 - 1e-15)
          expect(strength).toBeLessThanOrEqual(1 + 1e-15)
          expect(Vec.dot(spin, cue.angular) / (speed * strength)).toBeCloseTo(
            -1,
            12,
          )
          expect(cue.duration).toBeGreaterThanOrEqual(0.1)
          expect(cue.duration).toBeLessThanOrEqual(0.3)
          expect(cue.at).toBe(17)
          expect(spin).toEqual(Vec.withLength(direction, speed))
        },
      ),
    )
  })

  it('has no cue for zero spin and gives a tiny stop a visible minimum', () => {
    expect(rotationStopCue(Vec.ZERO, 1, 0)).toBeNull()
    const cue = rotationStopCue(vec3(0, 0.00001, 0), 1, 0)
    expect(cue?.angular).toEqual(vec3(-0, -0.12, -0))
    expect(cue?.duration).toBe(0.1)
  })

  it('fades counter-torque even with variation off and expires while unseen', () => {
    const visuals = new ThrusterVisuals(layout)
    const cue = rotationStopCue(Vec.UNIT_Y, 1, 10)!
    const expected = exactFiring({ ...neutral, angular: cue.angular })
    expect(visuals.sample(neutral, 10, cue, false, false)).toEqual(expected)
    expect(expected[2]).toBe(0)
    expect(expected[3]).toBeGreaterThan(0)
    const midway = visuals.sample(
      neutral,
      10 + cue.duration / 2,
      cue,
      false,
      false,
    )
    expect(midway[3]).toBeCloseTo(expected[3]! / 2, 6)
    expect(
      visuals.sample(neutral, cue.at + cue.duration, cue, false, false),
    ).toEqual(exactFiring(neutral))
    expect(visuals.sample(null, 100, cue, false, false)).toEqual(
      exactFiring(neutral),
    )
    expect(visuals.sample(neutral, 9, cue, false, false)).toEqual(
      exactFiring(neutral),
    )
  })

  it('lets a new angular command replace the stop cue immediately', () => {
    const visuals = new ThrusterVisuals(layout)
    const cue = rotationStopCue(Vec.UNIT_Y, 1, 0)!
    const demand = Object.freeze({ ...neutral, angular: Vec.UNIT_Y })
    expect(visuals.sample(demand, 0.01, cue, true, true)).toEqual(
      exactFiring(demand),
    )
    expect(cue.angular).toEqual(vec3(-0, -1, -0))
  })
})

describe('the visual demand', () => {
  it('keeps the exact allocation when variation is off and reuses its array (property)', () => {
    const visuals = new ThrusterVisuals(layout)
    const held = visuals.sample(null, 0, null, false, false)
    fc.assert(
      fc.property(demandArb, (demand) => {
        expect(visuals.sample(demand, 1, null, true, false)).toBe(held)
        expect(held).toEqual(exactFiring(demand))
      }),
    )
    expect(visuals.sample(null, 2, null, false, false)).toEqual(
      exactFiring(neutral),
    )
    expect(
      new ThrusterVisuals({ nozzles: [], drive: null }).sample(
        neutral,
        1,
        null,
        true,
        true,
      ),
    ).toHaveLength(0)
  })

  it('stays between closed and fully open with any cue and demand (property)', () => {
    const visuals = new ThrusterVisuals(layout)
    const cue = rotationStopCue(vec3(1, -2, 3), 1, 0)!
    fc.assert(
      fc.property(
        demandArb,
        fc.double({ min: 0, max: 10, noNaN: true }),
        fc.boolean(),
        fc.boolean(),
        (demand, now, holding, variation) => {
          const before = { ...demand }
          for (const value of visuals.sample(
            demand,
            now,
            cue,
            holding,
            variation,
          )) {
            expect(value).toBeGreaterThanOrEqual(0)
            expect(value).toBeLessThanOrEqual(1)
          }
          expect(demand).toEqual(before)
        },
      ),
    )
  })

  it('holds with tiny directional puffs, 25–50 ms long and about 1–2 seconds apart', () => {
    const visuals = new ThrusterVisuals(layout)
    const starts: number[] = []
    const widths: number[] = []
    const directions = new Set<number>()
    let active = false
    let start = 0
    for (let tick = 0; tick <= 12000; tick += 1) {
      const now = tick / 1000
      const firing = visuals.sample(neutral, now, null, true, true)
      const fired = [...firing].filter((value) => value > 0)
      expect(fired.length).toBeLessThanOrEqual(1)
      for (const value of fired)
        expect(value).toBeLessThanOrEqual(Math.fround(0.08))
      const open = fired.length !== 0
      if (open) directions.add(firing.findIndex((value) => value > 0))
      if (open && !active) {
        starts.push(now)
        start = now
      }
      if (!open && active) widths.push(now - start)
      active = open
      expect(visuals.sample(neutral, now, null, false, true)).toEqual(
        exactFiring(neutral),
      )
      expect(visuals.sample(neutral, now, null, true, false)).toEqual(
        exactFiring(neutral),
      )
    }
    expect(starts).toHaveLength(8)
    expect(widths).toHaveLength(8)
    expect(directions.size).toBeGreaterThan(1)
    for (const width of widths) {
      // Sampling at 1 ms can shorten a pulse by one sample at either edge.
      expect(width).toBeGreaterThanOrEqual(0.024)
      expect(width).toBeLessThanOrEqual(0.051)
    }
    for (let i = 1; i < starts.length; i += 1) {
      const gap = starts[i]! - starts[i - 1]!
      expect(gap).toBeGreaterThanOrEqual(0.999)
      expect(gap).toBeLessThanOrEqual(2.001)
    }
    expect(
      new Set(
        starts
          .slice(1)
          .map((time, i) => Math.round((time - starts[i]!) * 1000)),
      ).size,
    ).toBeGreaterThan(1)
  })

  it('keeps the same puffs after skipped frames and reordered nozzles', () => {
    const visuals = new ThrusterVisuals(layout)
    const reversed = new ThrusterVisuals({
      ...layout,
      nozzles: [...layout.nozzles].reverse(),
    })
    const samples = Array.from({ length: 2000 }, (_, frame) => frame / 100)
    const expected = samples.map((now) => [
      ...visuals.sample(neutral, now, null, true, true),
    ])
    for (let frame = samples.length - 1; frame >= 0; frame -= 7) {
      expect([
        ...visuals.sample(neutral, samples[frame]!, null, true, true),
      ]).toEqual(expected[frame])
      expect(
        [
          ...reversed.sample(neutral, samples[frame]!, null, true, true),
        ].reverse(),
      ).toEqual(expected[frame])
    }
  })
})

describe('valve response', () => {
  it('uses the unvaried 30 ms opening and 90 ms closing exponential', () => {
    expect(valveOpening(0, 1, 0.02, 42, false)).toBe(1 - Math.exp(-0.02 / 0.03))
    expect(valveOpening(1, 0, 0.02, 42, false)).toBe(Math.exp(-0.02 / 0.09))
    expect(valveOpening(0.3, 0.8, 0, 42, true)).toBe(0.3)
  })

  it('gives each geometry a stable seed and a bounded timing difference', () => {
    const seeds = layout.nozzles.map(nozzleValveSeed)
    expect(new Set(seeds).size).toBe(layout.nozzles.length)
    expect(
      layout.nozzles.map((value) => nozzleValveSeed({ ...value })),
    ).toEqual(seeds)
    const rises = new Set<number>()
    for (const seed of seeds) {
      const rise = -0.03 / Math.log(1 - valveOpening(0, 1, 0.03, seed, true))
      const fall = -0.09 / Math.log(valveOpening(1, 0, 0.09, seed, true))
      expect(rise).toBeGreaterThanOrEqual(0.0295)
      expect(rise).toBeLessThanOrEqual(0.0305)
      expect(fall).toBeGreaterThanOrEqual(0.0895)
      expect(fall).toBeLessThanOrEqual(0.1105)
      rises.add(rise)
    }
    expect(rises.size).toBeGreaterThan(1)
  })

  it('has the same fixed-target response at any frame rate (property)', () => {
    const opening = fc.double({ min: 0, max: 1, noNaN: true })
    fc.assert(
      fc.property(
        opening,
        opening,
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.integer({ min: 1, max: 120 }),
        fc.integer(),
        fc.boolean(),
        (held, target, delta, frames, seed, variation) => {
          const once = valveOpening(held, target, delta, seed, variation)
          let stepped = held
          for (let frame = 0; frame < frames; frame += 1) {
            stepped = valveOpening(
              stepped,
              target,
              delta / frames,
              seed,
              variation,
            )
          }
          expect(once).toBeGreaterThanOrEqual(Math.min(held, target))
          expect(once).toBeLessThanOrEqual(Math.max(held, target))
          expect(Math.abs(stepped - once)).toBeLessThanOrEqual(2e-13)
        },
      ),
    )
  })
})
