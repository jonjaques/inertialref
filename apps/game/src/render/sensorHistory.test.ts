import { expect, it } from 'vitest'
import { SensorHistory } from './sensorHistory.ts'

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
