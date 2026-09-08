import { expect, it } from 'vitest'
import fc from 'fast-check'
import { PARSEC } from '@inertialref/shared'
import { UV, vec3 } from '@inertialref/spatial'
import { rootSeed } from '@inertialref/procedural'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { createGalaxyField, type GalaxyField } from './field.ts'
import { integrateGalaxyRay } from './integral.ts'
import { LOCAL_CLOUDS } from './localDust.ts'
import { integrateStarExtinction } from './starExtinction.ts'

const field = createGalaxyField(rootSeed('inertialref'))
const aquila = LOCAL_CLOUDS.find((cloud) => cloud.name === 'Aquila Rift')!
const aquilaDirection = vec3(
  aquila.center.x + 8178,
  aquila.center.y - 20.8,
  aquila.center.z,
)
const target = (
  origin: typeof SUN_POSITION,
  direction: ReturnType<typeof vec3>,
  distance: number,
) => {
  const k =
    (distance * PARSEC) / Math.hypot(direction.x, direction.y, direction.z)
  return UV.translate(
    origin,
    vec3(direction.x * k, direction.y * k, direction.z * k),
  )
}

it('does not attenuate foreground stars with a cloud behind them', () => {
  const observer = UV.fromMeters(0, 0, 0)
  const cloud: GalaxyField = {
    ...field,
    sample(position) {
      const sample = field.sample(position),
        x = UV.approxMeters(position).x / PARSEC
      const k =
        x <= 100 || x >= 300 ? 0 : 0.05 * Math.exp(-0.5 * ((x - 200) / 20) ** 2)
      return {
        ...sample,
        extinctionPerParsec: { r: k * 0.8, g: k, b: k * 1.2 },
      }
    },
  }
  expect(
    integrateStarExtinction(cloud, observer, UV.fromMeters(100 * PARSEC, 0, 0))
      .transmittanceRgb,
  ).toEqual([1, 1, 1])
  const back = integrateStarExtinction(
    cloud,
    observer,
    UV.fromMeters(1000 * PARSEC, 0, 0),
  )
  const column = 0.05 * 20 * Math.sqrt(2 * Math.PI)
  for (const [channel, ratio] of [0.8, 1, 1.2].entries())
    expect(
      Math.abs(back.transmittanceRgb[channel]! - Math.exp(-column * ratio)),
    ).toBeLessThan(0.001)
})

it('agrees with fine shared transport for local, obscured, polar and external stars', () => {
  const cases = [
    [SUN_POSITION, vec3(1, 0, 0), 1],
    [SUN_POSITION, vec3(1, 0, 0), 50],
    [SUN_POSITION, aquilaDirection, 100],
    [SUN_POSITION, aquilaDirection, 1000],
    [SUN_POSITION, vec3(1, 0, 0), 8178],
    [SUN_POSITION, vec3(-1, 0, 0), 5000],
    [SUN_POSITION, vec3(0, 1, 0), 20000],
    [UV.fromMeters(0, 30000 * PARSEC, 0), vec3(0, -1, 0), 30000],
    [UV.fromMeters(-8178 * PARSEC, 30000 * PARSEC, 0), vec3(0, -1, 0), 40000],
  ] as const
  for (const [origin, direction, distance] of cases) {
    const exact = integrateGalaxyRay(field, origin, direction, {
      distanceParsecs: distance,
      maxStepParsecs: 0.25,
    })
    const measured = integrateStarExtinction(
      field,
      origin,
      target(origin, direction, distance),
    )
    exact.transmittanceRgb.forEach((value, c) =>
      expect(Math.abs(measured.transmittanceRgb[c]! - value)).toBeLessThan(
        Math.max(0.001, value * 0.01),
      ),
    )
  }
})

it('keeps transparent and coincident rays exact and all finite transmissions bounded', () => {
  const transparent = createGalaxyField(rootSeed('clear'), { dustScale: 0 })
  fc.assert(
    fc.property(
      fc.tuple(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
      ),
      ([x, y, z]) => {
        const star = UV.translate(
          SUN_POSITION,
          vec3(x * PARSEC, y * PARSEC, z * PARSEC),
        )
        expect(
          integrateStarExtinction(transparent, SUN_POSITION, star)
            .transmittanceRgb,
        ).toEqual([1, 1, 1])
        const value = integrateStarExtinction(field, SUN_POSITION, star)
        for (const t of value.transmittanceRgb) {
          expect(t).toBeGreaterThanOrEqual(0)
          expect(t).toBeLessThanOrEqual(1)
        }
        expect(value.transmittanceRgb[0]).toBeGreaterThanOrEqual(
          value.transmittanceRgb[1],
        )
        expect(value.transmittanceRgb[1]).toBeGreaterThanOrEqual(
          value.transmittanceRgb[2],
        )
      },
    ),
    { numRuns: 24 },
  )
  expect(
    integrateStarExtinction(field, SUN_POSITION, SUN_POSITION).transmittanceRgb,
  ).toEqual([1, 1, 1])
})

it('resolves long inclined columns across the disk without depending on query order', () => {
  const indices = [17, 30, 43, 49, 55, 63, 67, 79, 83, 91, 102, 111]
  const rows = indices.map((i) => {
    const outside = i % 3 === 0
    const origin = outside
      ? UV.fromMeters(
          (((i * 3571) % 20000) - 10000) * PARSEC,
          30000 * PARSEC,
          0,
        )
      : i % 3 === 1
        ? SUN_POSITION
        : UV.fromMeters(
            (((i * 3571) % 40000) - 20000) * PARSEC,
            (((i * 151) % 300) - 150) * PARSEC,
            (((i * 7919) % 40000) - 20000) * PARSEC,
          )
    const direction = outside
      ? vec3(((i * 547) % 12000) - 6000, -30000, ((i * 79) % 12000) - 6000)
      : vec3(Math.cos(i * 2.399), 0.6 * Math.sin(i * 1.31), Math.sin(i * 2.399))
    const distance = outside
      ? Math.hypot(direction.x, direction.y, direction.z)
      : Math.min(15000, 10 ** (1 + ((i * 13) % 40) / 10))
    const star = target(origin, direction, distance)
    const result = integrateStarExtinction(field, origin, star)
    const exact = integrateGalaxyRay(field, origin, direction, {
      distanceParsecs: distance,
      maxStepParsecs: 0.25,
    })
    exact.transmittanceRgb.forEach((value, c) =>
      expect(Math.abs(result.transmittanceRgb[c]! - value)).toBeLessThan(
        Math.max(0.001, value * 0.01),
      ),
    )
    return { origin, star, result }
  })
  for (const row of rows.toReversed())
    expect(integrateStarExtinction(field, row.origin, row.star)).toEqual(
      row.result,
    )
})
