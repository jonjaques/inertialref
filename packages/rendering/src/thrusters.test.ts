import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Vec, type Vec3, vec3 } from '@inertialref/spatial'
import type { ThrustDemand } from '@inertialref/simulation'
import {
  driveThrottle,
  type Nozzle,
  nozzleFiring,
  nozzleWrench,
  prepareNozzles,
  type ThrusterLayout,
  TORQUE_LEVER,
} from './thrusters.ts'

const unit = fc.double({ min: -1, max: 1, noNaN: true })
const axes = fc.tuple(unit, unit, unit).map(([x, y, z]) => vec3(x, y, z))
const demandArb: fc.Arbitrary<ThrustDemand> = fc.record({
  linear: axes,
  angular: axes,
})

/** A direction that is not degenerate: at least a tenth long before normalizing. */
const direction = fc
  .tuple(unit, unit, unit)
  .map(([x, y, z]) => vec3(x, y, z))
  .filter((v) => Vec.length(v) > 0.1)
  .map((v) => Vec.normalize(v))

const metres = fc.double({ min: -20, max: 20, noNaN: true })
const nozzleArb: fc.Arbitrary<Nozzle> = fc.record({
  position: fc.tuple(metres, metres, metres).map(([x, y, z]) => vec3(x, y, z)),
  exhaust: direction,
  radius: fc.double({ min: 0.05, max: 1, noNaN: true }),
  kind: fc.constantFrom('rcs', 'pod'),
})
const layoutArb: fc.Arbitrary<ThrusterLayout> = fc
  .array(nozzleArb, { minLength: 1, maxLength: 12 })
  .map((nozzles) => ({ nozzles, drive: null }))

const fire = (layout: ThrusterLayout, demand: ThrustDemand): Float32Array => {
  const out = new Float32Array(layout.nozzles.length)
  nozzleFiring(prepareNozzles(layout), demand, out)
  return out
}

/** A layout mirrored through the x = 0 plane. */
const mirrorX = (v: Vec3): Vec3 => vec3(-v.x, v.y, v.z)
/** A rotation mirrored through the same plane: the x component keeps its sense, the others flip. */
const mirrorSpin = (v: Vec3): Vec3 => vec3(v.x, -v.y, -v.z)

describe('the wrench of one nozzle', () => {
  it('thrusts against the exhaust and turns about the centre by the right hand', () => {
    // A jet at the bow, on the axis, blowing up: thrust is down, and pushing
    // the nose down pitches the ship nose-down — a negative turn about +X.
    const bow = nozzleWrench({
      position: vec3(0, 0, -16),
      exhaust: vec3(0, 1, 0),
      radius: 0.1,
      kind: 'rcs',
    })
    expect(bow.thrust).toEqual(vec3(-0, -1, -0))
    expect(bow.torque.x).toBeCloseTo(-1, 12)
    expect(bow.leverage).toBe(1)
  })

  it('has no torque direction on the centre of mass, and less leverage near it (property)', () => {
    fc.assert(
      fc.property(direction, (exhaust) => {
        const centred = nozzleWrench({
          position: Vec.ZERO,
          exhaust,
          radius: 0.1,
          kind: 'rcs',
        })
        expect(centred.torque).toEqual(Vec.ZERO)
        expect(centred.leverage).toBe(0)
        // Along its own exhaust line the lever is zero too, wherever it sits.
        const inline = nozzleWrench({
          position: Vec.scale(exhaust, 7),
          exhaust,
          radius: 0.1,
          kind: 'rcs',
        })
        expect(Vec.length(inline.torque)).toBeLessThan(1e-9)
        expect(inline.leverage).toBeLessThan(1e-9)
      }),
    )
  })

  it('reaches full leverage at the named lever', () => {
    const at = (lever: number) =>
      nozzleWrench({
        position: vec3(lever, 0, 0),
        exhaust: vec3(0, 1, 0),
        radius: 0.1,
        kind: 'rcs',
      }).leverage
    expect(at(TORQUE_LEVER / 2)).toBeCloseTo(0.5, 12)
    expect(at(TORQUE_LEVER)).toBe(1)
    expect(at(TORQUE_LEVER * 10)).toBe(1)
  })
})

describe('which nozzles fire', () => {
  it('none, for no demand (property)', () => {
    fc.assert(
      fc.property(layoutArb, (layout) => {
        const out = fire(layout, { linear: Vec.ZERO, angular: Vec.ZERO })
        for (const value of out) expect(value).toBe(0)
      }),
    )
  })

  it('every firing nozzle helps: the set never works against the demand (property)', () => {
    fc.assert(
      fc.property(layoutArb, demandArb, (layout, demand) => {
        const { wrenches } = prepareNozzles(layout)
        const out = fire(layout, demand)
        let help = 0
        for (let i = 0; i < out.length; i += 1) {
          const value = out[i] as number
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(1)
          const wrench = wrenches[i]
          if (wrench === undefined) throw new Error('one wrench per nozzle')
          const own =
            Vec.dot(wrench.thrust, demand.linear) +
            wrench.leverage * Vec.dot(wrench.torque, demand.angular)
          // A valve fires only when its own contribution is positive.
          if (value > 0) expect(own).toBeGreaterThan(0)
          help += value * own
        }
        expect(help).toBeGreaterThanOrEqual(0)
      }),
    )
  })

  it('asks no more of a nozzle for less demand (property)', () => {
    fc.assert(
      fc.property(
        layoutArb,
        demandArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (layout, demand, k) => {
          const full = fire(layout, demand)
          const part = fire(layout, {
            linear: Vec.scale(demand.linear, k),
            angular: Vec.scale(demand.angular, k),
          })
          for (let i = 0; i < full.length; i += 1)
            expect(part[i] as number).toBeLessThanOrEqual(
              (full[i] as number) + 1e-12,
            )
        },
      ),
    )
  })

  it('is mirror-symmetric: a mirrored hull under a mirrored demand fires the mirrored set (property)', () => {
    fc.assert(
      fc.property(layoutArb, demandArb, (layout, demand) => {
        const mirrored: ThrusterLayout = {
          nozzles: layout.nozzles.map((nozzle) => ({
            ...nozzle,
            position: mirrorX(nozzle.position),
            exhaust: mirrorX(nozzle.exhaust),
          })),
          drive: null,
        }
        const left = fire(layout, demand)
        const right = fire(mirrored, {
          linear: mirrorX(demand.linear),
          angular: mirrorSpin(demand.angular),
        })
        for (let i = 0; i < left.length; i += 1)
          expect(right[i] as number).toBeCloseTo(left[i] as number, 9)
      }),
    )
  })

  it('opens the pair a couple needs, and shuts the one that would fight it', () => {
    // A bow jet blowing up and a stern jet blowing down, on the axis: the
    // couple that pitches the nose down. Pitch-down lights both; pitch-up
    // lights neither.
    const layout: ThrusterLayout = {
      nozzles: [
        {
          position: vec3(0, 0, -16),
          exhaust: vec3(0, 1, 0),
          radius: 0.1,
          kind: 'rcs',
        },
        {
          position: vec3(0, 0, 12),
          exhaust: vec3(0, -1, 0),
          radius: 0.5,
          kind: 'pod',
        },
      ],
      drive: null,
    }
    const down = fire(layout, { linear: Vec.ZERO, angular: vec3(-1, 0, 0) })
    expect(Array.from(down)).toEqual([1, 1])
    const up = fire(layout, { linear: Vec.ZERO, angular: vec3(1, 0, 0) })
    expect(Array.from(up)).toEqual([0, 0])
    // A translation down lights only the jet whose thrust is down — the bow
    // one — at full, and the stern one not at all.
    const sink = fire(layout, { linear: vec3(0, -1, 0), angular: Vec.ZERO })
    expect(Array.from(sink)).toEqual([1, 0])
  })
})

describe('the drive', () => {
  it('owns the forward axis when there is one, and the valves take it when there is not', () => {
    // A stern valve whose exhaust leans aft helps a burn ahead — unless a
    // drive is doing the burning.
    const stern: Nozzle = {
      position: vec3(3, 3, 12),
      exhaust: Vec.normalize(vec3(0.7, 0.7, 0.25)),
      radius: 0.5,
      kind: 'pod',
    }
    const ahead: ThrustDemand = { linear: vec3(0, 0, -1), angular: Vec.ZERO }
    const withDrive = fire(
      { nozzles: [stern], drive: { position: vec3(0, 0, 21), radius: 3 } },
      ahead,
    )
    const without = fire({ nozzles: [stern], drive: null }, ahead)
    expect(withDrive[0]).toBe(0)
    expect(without[0]).toBeGreaterThan(0.2)
    // The drive takes nothing else: a strafe still lights the valve either way.
    const strafe: ThrustDemand = { linear: vec3(-1, 0, 0), angular: Vec.ZERO }
    expect(
      fire(
        { nozzles: [stern], drive: { position: vec3(0, 0, 21), radius: 3 } },
        strafe,
      )[0],
    ).toBeGreaterThan(0.5)
  })

  it('opens on a burn ahead and stays shut for a retro (property)', () => {
    fc.assert(
      fc.property(demandArb, (demand) => {
        const throttle = driveThrottle(demand)
        expect(throttle).toBeGreaterThanOrEqual(0)
        expect(throttle).toBeLessThanOrEqual(1)
        if (demand.linear.z < 0)
          expect(throttle).toBeCloseTo(-demand.linear.z, 12)
        else expect(throttle).toBe(0)
      }),
    )
  })
})
