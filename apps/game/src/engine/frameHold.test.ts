import { expect, it } from 'vitest'
import { framesHeld, holdFrames } from './frameHold.ts'

it('holds while any measurement holds, and a release counts once', () => {
  expect(framesHeld()).toBe(false)
  const first = holdFrames()
  expect(framesHeld()).toBe(true)
  const second = holdFrames()
  first()
  // Releasing the first again must not lift the second's hold.
  first()
  expect(framesHeld()).toBe(true)
  second()
  expect(framesHeld()).toBe(false)
})
