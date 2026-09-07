import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV, Vec, Quaternion as Q } from '@inertialref/spatial'
import { isUsableLens, LENS_PRESETS, type Lens } from '@inertialref/rendering'
import { openSession } from './session.ts'

it('travels from Earth orbit to 30 kpc above the center and returns without canonical writes', () => {
  let lens: Lens = LENS_PRESETS.flight
  const session = openSession({
    workers: null,
    render: {
      framingLens: () => lens,
      setFlightLens: (next) => {
        lens = next
      },
    },
  })
  try {
    const ir = session.harness
    ir.galaxyJourney(0)
    const before = session.world.stateHash()
    const start = ir.observerSample(0)!
    expect(ir.observerStatus()!.altitude).toBeCloseTo(64_000_000, 1)
    expect(isUsableLens(lens)).toBe(true)
    ir.galaxyJourney(1, 12)
    let previous = start
    let previousDistance = ir.observerStatus()!.state.distance
    for (let i = 0; i < 720; i++) {
      const pose = ir.observerSample(1 / 60)!
      const distance = ir.observerStatus()!.state.distance
      expect(distance).toBeGreaterThanOrEqual(previousDistance)
      expect(distance / previousDistance).toBeLessThan(1.07)
      expect(
        Vec.dot(
          Q.basis(pose.orientation).forward,
          Q.basis(previous.orientation).forward,
        ),
      ).toBeGreaterThan(0.999999)
      expect(Object.values(pose.position).every(Number.isFinite)).toBe(true)
      expect(session.world.stateHash()).toBe(before)
      previous = pose
      previousDistance = distance
    }
    ir.observerSample(0.01)
    expect(
      UV.distance(ir.observatory.eye!, UV.fromMeters(0, 30000 * PARSEC, 0)) /
        PARSEC,
    ).toBeLessThan(1e-8)
    ir.galaxyJourney(0, 12)
    for (let i = 0; i < 721; i++) ir.observerSample(1 / 60)
    expect(UV.distance(ir.observatory.eye!, start.position)).toBeLessThan(0.001)
    expect(session.world.stateHash()).toBe(before)
    expect(ir.observerStatus()!.travelling).toBe(false)
    expect(ir.observerStatus()!.journey?.progress).toBe(0)
    ir.look('s:SOL/b:2', { ease: false })
    expect(ir.observerStatus()!.journey).toBeNull()
  } finally {
    session.dispose()
  }
})

it('rejects invalid travel before changing the camera or lens', () => {
  const session = openSession({ workers: null })
  try {
    const ir = session.harness
    ir.look('s:SOL/b:2', { ease: false })
    const before = ir.observerSample(0)
    for (const p of [NaN, Infinity, -0.1, 1.1])
      expect(() => ir.galaxyJourney(p)).toThrow('Galaxy journey progress')
    for (const s of [-1, Infinity, NaN])
      expect(() => ir.galaxyJourney(1, s)).toThrow('Galaxy journey duration')
    expect(ir.observerSample(0)).toEqual(before)
  } finally {
    session.dispose()
  }
})

it.each([0, 0.75, 1])(
  'recenters free look when seeking progress %s',
  (progress) => {
    const session = openSession({ workers: null })
    try {
      const ir = session.harness
      ir.galaxyJourney(0.5)
      ir.observatory.setLook(Math.PI, 0)
      ir.galaxyJourney(progress)
      const pose = ir.observerSample(0)!
      const earth = session.world.frames.pose(
        ir.observatory.target!.frame,
        session.world.clock.renderTime,
      ).position
      expect(
        Vec.dot(
          Q.basis(pose.orientation).forward,
          Vec.normalize(UV.difference(earth, pose.position)),
        ),
      ).toBeCloseTo(1, 12)
    } finally {
      session.dispose()
    }
  },
)

it('partitions presentation time equally and reverses from the current position', () => {
  const a = openSession({ workers: null }),
    b = openSession({ workers: null })
  try {
    for (const session of [a, b]) {
      session.harness.galaxyJourney(0)
      session.harness.galaxyJourney(1, 36)
    }
    a.harness.observerSample(9)
    for (let i = 0; i < 540; i++) b.harness.observerSample(1 / 60)
    expect(a.harness.observerStatus()!.journey!.progress).toBeCloseTo(
      b.harness.observerStatus()!.journey!.progress,
      12,
    )
    const before = a.harness.observerSample(0)!
    const progress = a.harness.observerStatus()!.journey!.progress
    a.harness.galaxyJourney(0, 10)
    expect(a.harness.observerSample(0)).toEqual(before)
    a.harness.observerSample(5)
    expect(a.harness.observerStatus()!.journey!.progress).toBeCloseTo(
      progress / 2,
      12,
    )
    a.harness.galaxyJourney(a.harness.observerStatus()!.journey!.progress)
    const held = a.harness.observerSample(0)
    expect(a.harness.observerSample(100)).toEqual(held)
    a.harness.galaxyJourney(1, 36)
    a.harness.observatory.drag(5, 3)
    const dragged = a.harness.observerSample(0)
    expect(a.harness.observerSample(5)).toEqual(dragged)
    a.harness.galaxyView('face-on')
    expect(a.harness.observerStatus()!.journey).toBeNull()
  } finally {
    a.dispose()
    b.dispose()
  }
})

it('resumes from a manually orbited pose and holds without snapping back to the route angles', () => {
  const session = openSession({ workers: null })
  try {
    const ir = session.harness
    ir.galaxyJourney(0.6)
    ir.observatory.setLook(0.3, -0.1)
    ir.observatory.drag(45, -20)
    const start = ir.observerSample(0)!
    ir.galaxyJourney(1, 12)
    const resumed = ir.observerSample(0)!
    expect(UV.distance(resumed.position, start.position)).toBeLessThan(0.001)
    expect(resumed.orientation).toEqual(start.orientation)
    ir.observerSample(4)
    const holding = ir.observerSample(0)!
    ir.observatory.holdGalaxyJourney()
    expect(ir.observerSample(10)).toEqual(holding)
    ir.galaxyJourney(1, 12)
    ir.observerSample(12)
    expect(
      UV.distance(ir.observatory.eye!, UV.fromMeters(0, 30000 * PARSEC, 0)) /
        PARSEC,
    ).toBeLessThan(1e-8)
  } finally {
    session.dispose()
  }
})
