import { expect, it } from 'vitest'
import { GALAXY_ARMS, armTangencies } from './arms.ts'
it.each([
  ['scutum-centaurus', 30.5],
  ['sagittarius-carina', 49.3],
  ['sagittarius-carina', 282],
  ['scutum-centaurus', 310],
  ['norma-outer', 328],
  ['near-3kpc', 24],
])('holds the %s tangent near %s degrees', (id, longitude) => {
  const arm = GALAXY_ARMS.find((a) => a.id === id)!
  const errors = armTangencies(arm).map((l) =>
    Math.abs(((l - Number(longitude) + 540) % 360) - 180),
  )
  expect(Math.min(...errors)).toBeLessThan(3)
})
