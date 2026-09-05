import { expect, it } from 'vitest'
import { GALAXY_ARMS, armTangencies, armRadius, armStrength } from './arms.ts'
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

it('keeps the wrapped field continuous across the azimuth seam', async () => {
  const { armStrength } = await import('./arms.ts')
  for (const radius of [3000, 5000, 8000, 12000, 18000])
    expect(armStrength(radius, Math.PI - 1e-8)).toBeCloseTo(
      armStrength(radius, -Math.PI + 1e-8),
      5,
    )
})

it.each(GALAXY_ARMS)(
  'keeps $id ridge density continuous across its pitch kink',
  (arm) => {
    const beta = (arm.kinkDegrees * Math.PI) / 180
    const radius = armRadius(arm, beta) + 300
    expect(
      Math.abs(
        armStrength(radius, beta - 1e-9) - armStrength(radius, beta + 1e-9),
      ),
    ).toBeLessThan(1e-6)
  },
)
