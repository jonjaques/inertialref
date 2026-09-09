import { expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { createGalaxyField } from './field.ts'

it('places the Sun in a low-extinction cavity without removing its stars', () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const sample = field.sample(SUN_POSITION)
  expect(sample.extinctionPerParsec.g).toBeLessThan(2e-4)
  expect(sample.totalPerCubicParsec).toBeCloseTo(0.1, 14)
})

import fc from 'fast-check'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { equatorialToGalactic } from '../catalog/astrometry.ts'
import {
  LOCAL_CLOUDS,
  localBubbleFactor,
  localCloudExtinction,
} from './localDust.ts'

it('keeps the Galactic center, north pole and Aquila in the catalogue frame', () => {
  const pole = equatorialToGalactic(192.85948, 27.12825)
  expect(pole.b).toBeCloseTo(Math.PI / 2, 7)
  const center = equatorialToGalactic(266.4051, -28.936175)
  expect(Math.cos(center.l)).toBeCloseTo(1, 8)
  expect(center.b).toBeCloseTo(0, 4)
  const a = LOCAL_CLOUDS.find((c) => c.name === 'Aquila Rift')!
  const l = (Math.atan2(-a.center.z, a.center.x + 8178) * 180) / Math.PI
  expect(l).toBeGreaterThan(20)
  expect(l).toBeLessThan(50)
  expect(a.center.y).toBeGreaterThan(20.8)
})

it('keeps the cavity bounded and the compact clouds positive and continuous', () => {
  fc.assert(
    fc.property(
      fc.tuple(
        ...Array.from({ length: 3 }, () =>
          fc.double({ min: -2000, max: 2000, noNaN: true }),
        ),
      ),
      ([x = 0, y = 0, z = 0]) => {
        const f = localBubbleFactor(x - 8178, y + 20.8, z)
        expect(f).toBeGreaterThanOrEqual(0.2)
        expect(f).toBeLessThanOrEqual(1)
        expect(
          localCloudExtinction(x - 8178, y + 20.8, z),
        ).toBeGreaterThanOrEqual(0)
      },
    ),
  )
  for (const c of LOCAL_CLOUDS) {
    const bound =
      Math.hypot(c.center.x + 8178, c.center.y - 20.8, c.center.z) +
      5 * Math.max(c.sigma.x, c.sigma.y, c.sigma.z)
    expect(bound).toBeLessThan(1500)
    const f = createGalaxyField(rootSeed('local'))
    const p = UV.fromMeters(
      c.center.x * PARSEC,
      c.center.y * PARSEC,
      c.center.z * PARSEC,
    )
    const near = f.sample(p).extinctionPerParsec.g
    expect(near).toBeGreaterThan(c.extinctionPerParsec * 0.99)
    expect(
      Math.abs(
        f.sample(UV.translate(p, vec3(0.01 * PARSEC, 0, 0))).extinctionPerParsec
          .g - near,
      ),
    ).toBeLessThan(1e-5)
  }
})
