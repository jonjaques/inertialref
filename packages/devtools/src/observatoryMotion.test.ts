import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openSession } from './session.ts'

const recipe = {
  durationSeconds: 20,
  azimuthDelta: Math.PI / 6,
  elevationDelta: 0.08,
  distanceFactor: 0.8,
}

describe('finite observatory motion', () => {
  it('moves through a bounded presentation recipe and stops exactly at its end', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.focus('s:SOL/b:5', { ease: false })
    eye.setLook(0.08, 0.04)
    const before = eye.status()
    expect(eye.startMotion(recipe)).toBe(true)
    const revision = eye.mutationRevision
    expect(eye.status().traveling).toBe(false)
    expect(eye.status().motion?.durationSeconds).toBe(20)
    eye.sample(10)
    const middle = eye.status()
    expect(middle.state.azimuth).toBeGreaterThan(before.state.azimuth)
    expect(middle.state.azimuth).toBeLessThan(
      before.state.azimuth + recipe.azimuthDelta,
    )
    expect(middle.state.distance).toBeLessThan(before.state.distance)
    expect(middle.state.distance).toBeGreaterThan(
      before.state.distance * recipe.distanceFactor,
    )
    expect(eye.mutationRevision).toBe(revision)
    eye.sample(10)
    const final = eye.status()
    expect(final.state.azimuth).toBeCloseTo(
      before.state.azimuth + recipe.azimuthDelta,
      12,
    )
    expect(final.state.distance).toBeCloseTo(
      before.state.distance * recipe.distanceFactor,
      5,
    )
    expect(final.motion).toBeNull()
    expect(final.look).toEqual(before.look)
    eye.sample(100)
    expect(eye.status().state).toEqual(final.state)
    expect(eye.mutationRevision).toBe(revision)
    session.dispose()
  })

  it.each([false, true])(
    'preserves canonical inputs when paused is %s',
    (paused) => {
      const guided = openSession()
      const control = openSession()
      guided.world.clock.setPaused(paused)
      control.world.clock.setPaused(paused)
      const eye = guided.harness.observatory
      eye.focus('s:SOL/b:5', { ease: false })
      eye.startMotion(recipe)
      const before = eye.status().state
      for (let frame = 0; frame < 120; frame++) {
        guided.world.advance(1 / 60)
        control.world.advance(1 / 60)
        eye.sample(1 / 60)
      }
      expect(eye.status().state).not.toEqual(before)
      expect(guided.world.stateHash()).toBe(control.world.stateHash())
      guided.dispose()
      control.dispose()
    },
  )

  it('stops at the sampled pose without changing the view revision', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.focus('s:SOL/b:5', { ease: false })
    eye.startMotion(recipe)
    eye.sample(5)
    const before = eye.status().state
    const revision = eye.mutationRevision
    expect(eye.stopMotion()).toBe(true)
    expect(eye.mutationRevision).toBe(revision)
    eye.sample(50)
    expect(eye.status().state).toEqual(before)
    expect(eye.stopMotion()).toBe(false)
    session.dispose()
  })

  it('lets a visitor replace the motion without the old recipe returning', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.focus('s:SOL/b:5', { ease: false })
    eye.startMotion(recipe)
    eye.sample(2)
    eye.setDistance(eye.status().state.distance * 1.3)
    expect(eye.status().motion).toBeNull()
    const desired = eye.status().desired
    for (let frame = 0; frame < 500; frame++) eye.sample(1 / 60)
    expect(eye.status().state).toEqual(desired)
    session.dispose()
  })

  it('does not install an orbit recipe on the surface', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.stand('s:SOL/b:2', { latitude: 0, longitude: 0, height: 2 })
    const before = eye.status()
    const revision = eye.mutationRevision
    expect(eye.startMotion(recipe)).toBe(false)
    expect(eye.status()).toEqual(before)
    expect(eye.mutationRevision).toBe(revision)
    session.dispose()
  })

  it('holds orbit bounds and frame partition independence across valid recipes', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 12, max: 90, noNaN: true }),
        fc.double({ min: -Math.PI / 4, max: Math.PI / 4, noNaN: true }),
        fc.double({ min: 0.8, max: 1.3, noNaN: true }),
        (durationSeconds, azimuthDelta, distanceFactor) => {
          const a = openSession()
          const b = openSession()
          for (const session of [a, b]) {
            const eye = session.harness.observatory
            eye.focus('s:SOL/b:5', { ease: false })
            eye.setDistance(eye.bounds().min, false)
            eye.startMotion({
              ...recipe,
              durationSeconds,
              azimuthDelta,
              distanceFactor,
            })
          }
          a.harness.observatory.sample(durationSeconds / 2)
          for (let frame = 0; frame < 10; frame++)
            b.harness.observatory.sample(durationSeconds / 20)
          const first = a.harness.observatory.status().state
          const second = b.harness.observatory.status().state
          expect(first.azimuth).toBeCloseTo(second.azimuth, 12)
          expect(first.distance).toBeCloseTo(second.distance, 5)
          expect(first.distance).toBeGreaterThanOrEqual(
            a.harness.observatory.bounds().min,
          )
          expect(first.distance).toBeLessThanOrEqual(
            a.harness.observatory.bounds().max,
          )
          a.dispose()
          b.dispose()
        },
      ),
      { numRuns: 12 },
    )
  })
})
