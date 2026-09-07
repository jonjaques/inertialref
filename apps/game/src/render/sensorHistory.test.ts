import { expect, it } from 'vitest'
import fc from 'fast-check'
import {
  createRenderOrigin,
  maintainOrigin,
  orientationToRenderSpace,
  Quaternion,
  toRenderSpace,
  UV,
  vec3,
} from '@inertialref/spatial'
import { SensorHistory } from './sensorHistory.ts'

it('keeps Automatic history through consecutive origin rebases at a distant address', () => {
  const history = new SensorHistory()
  const start = UV.fromMeters(8e20, -3e20, 5e20)
  let origin = createRenderOrigin(start)
  let generation = 0
  let distance = 0
  let time = 0
  for (const dt of [0, 0.01, 0.015, 0.02, 0.025, 0.01, 0.015, 0.02]) {
    time += dt
    distance += dt * 400_000
    const position = UV.translate(start, vec3(distance, 0, 0))
    origin = maintainOrigin(origin, position)
    const current = history.advance('automatic:flight', time, {
      origin,
      position: toRenderSpace(origin, position),
      orientation: Quaternion.IDENTITY,
    })
    if (generation === 0) generation = current
    expect(current).toBe(generation)
  }
  expect(origin.generation).toBeGreaterThan(3)
  expect(history.accepts(generation, 'automatic:flight', time)).toBe(true)
})

it('keeps a steady journey independent of frame duration and origin placement', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 1, max: 1e12, noNaN: true }),
      fc.array(fc.double({ min: 0.001, max: 0.1, noNaN: true }), {
        minLength: 4,
        maxLength: 25,
      }),
      (speed, intervals) => {
        const history = new SensorHistory()
        const start = UV.fromMeters(2e20, -3e20, 4e20)
        let origin = createRenderOrigin(start)
        const generation = history.advance('automatic', 0, {
          origin,
          position: vec3(0, 0, 0),
          orientation: Quaternion.IDENTITY,
        })
        let time = 0
        for (const dt of intervals) {
          time += dt
          const position = UV.translate(start, vec3(time * speed, 0, 0))
          const previous = origin
          origin = maintainOrigin(origin, position)
          expect(
            history.advance('automatic', time, {
              origin,
              position: toRenderSpace(origin, position),
              orientation: Quaternion.IDENTITY,
            }),
          ).toBe(generation)
          expect(history.motionReset).toBe(origin !== previous)
        }
      },
    ),
  )
})

it('separates reanchored optical history from the physical camera orientation', () => {
  const history = new SensorHistory()
  const position = UV.fromMeters(1e18, -2e18, 3e18)
  const first = createRenderOrigin(position)
  const generation = history.advance('automatic', 0, {
    origin: first,
    position: toRenderSpace(first, position),
    orientation: Quaternion.IDENTITY,
  })
  const second = createRenderOrigin(
    UV.translate(position, vec3(3000, 2000, 1000)),
    Quaternion.fromAxisAngle(vec3(0, 1, 0), 0.5),
  )
  expect(
    history.advance('automatic', 0.016, {
      origin: second,
      position: toRenderSpace(second, position),
      orientation: orientationToRenderSpace(second, Quaternion.IDENTITY),
    }),
  ).toBe(generation)
  expect(history.motionReset).toBe(true)
})

it('rejects a true physical jump before readback and starts fresh motion after the cut', () => {
  const history = new SensorHistory()
  const camera = (x: number) => ({
    position: vec3(x, 0, 0),
    orientation: Quaternion.IDENTITY,
  })
  const generation = history.advance('automatic', 0, camera(0))
  history.advance('automatic', 0.016, camera(10))
  history.advance('automatic', 0.032, camera(20))
  expect(
    history.accepts(generation, 'automatic', 0.048, false, camera(100_000)),
  ).toBe(false)
  const cut = history.advance('automatic', 0.048, camera(100_000))
  expect(cut).toBe(generation + 1)
  expect(history.motionReset).toBe(true)
  expect(history.accepts(generation, 'automatic', 0.048)).toBe(false)
  expect(history.advance('automatic', 0.064, camera(100_010))).toBe(cut)
  expect(history.motionReset).toBe(false)
})

it('rejects an orientation cut and explicit same-time photographic changes', () => {
  const history = new SensorHistory()
  const camera = { position: vec3(0, 0, 0), orientation: Quaternion.IDENTITY }
  const generation = history.advance('automatic:held:10', 1, camera)
  const turned = {
    ...camera,
    orientation: Quaternion.fromAxisAngle(vec3(0, 1, 0), Math.PI / 2),
  }
  expect(
    history.accepts(generation, 'automatic:held:10', 1, false, turned),
  ).toBe(false)
  const cut = history.advance('automatic:held:10', 1, turned)
  expect(cut).toBe(generation + 1)
  expect(history.advance('automatic:held:11', 1, turned)).toBe(cut + 1)
  expect(history.motionReset).toBe(true)
  expect(history.accepts(cut, 'automatic:held:11', 1)).toBe(false)
})

it('rejects readings across a camera cut, mode switch, scrub and retirement', () => {
  const history = new SensorHistory()
  const first = history.advance('automatic:earth', 1)
  expect(history.accepts(first, 'automatic:earth', 1)).toBe(true)
  history.advance('automatic:luna', 1)
  expect(history.accepts(first, 'automatic:earth', 1)).toBe(false)
  const second = history.advance('automatic:luna', 2)
  history.advance('manual:luna', 2)
  expect(history.accepts(second, 'automatic:luna', 2)).toBe(false)
  const third = history.advance('automatic:luna', 3)
  history.advance('automatic:luna', 0)
  expect(history.accepts(third, 'automatic:luna', 3)).toBe(false)
  const fourth = history.advance('automatic:luna', 1)
  history.retire()
  expect(history.accepts(fourth, 'automatic:luna', 1)).toBe(false)
})

it('allows a moving exposure to read back, but never mutates a held frame', () => {
  const history = new SensorHistory()
  const submitted = history.advance('automatic', 1)
  history.advance('automatic', 1.016)
  expect(history.accepts(submitted, 'automatic', 1.016)).toBe(true)
  expect(history.accepts(submitted, 'automatic', 1.016, true)).toBe(false)
  expect(history.accepts(submitted, 'manual', 1.016)).toBe(false)
  expect(history.accepts(submitted, 'automatic', 9)).toBe(false)
})
