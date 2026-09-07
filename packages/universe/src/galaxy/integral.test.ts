import fc from 'fast-check'
import { expect, it } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { UV, vec3 } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import {
  createGalaxyField,
  type GalaxyField,
  type GalaxyPopulation,
} from './field.ts'
import { GALAXY_RADIANCE_FACTOR, integrateGalaxyRay } from './integral.ts'
const field = createGalaxyField(rootSeed('inertialref'))
const clearField = createGalaxyField(rootSeed('inertialref'), { dustScale: 0 })
it('integrates a homogeneous emitter with the analytic path length and 4π conversion', () => {
  const homogeneous: GalaxyField = {
    ...field,
    sample: () => ({
      populations: {
        thinDisk: 2,
        thickDisk: 0,
        youngArms: 0,
        barBulge: 0,
        halo: 0,
      },
      totalPerCubicParsec: 2,
      emissionSolarPerCubicParsec: 3,
      emissionRgb: { r: 1, g: 1, b: 1 },
      extinctionPerParsec: { r: 0, g: 0, b: 0 },
      dustArmStrength: 0,
      dustModulation: 1,
      warpParsecs: 0,
      armStrength: 0,
    }),
  }
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 500, noNaN: true }),
      (distanceParsecs) => {
        const result = integrateGalaxyRay(
          homogeneous,
          UV.fromMeters(0, 0, 0),
          vec3(1, 2, 3),
          { distanceParsecs },
        )
        expect(result.starsPerSquareParsec).toBeCloseTo(2 * distanceParsecs, 8)
        expect(result.radianceNanowatts).toBeCloseTo(
          3 * distanceParsecs * GALAXY_RADIANCE_FACTOR,
          6,
        )
      },
    ),
  )
})
it('returns no light for a ray missing the bounded volume', () => {
  expect(
    integrateGalaxyRay(
      field,
      UV.fromMeters(0, 30000 * PARSEC, 0),
      vec3(1, 0, 0),
    ).samples,
  ).toBe(0)
})
it.each([vec3(1, 0, 0), vec3(0, 1, 0), vec3(1, 0, -1)])(
  'converges on nonzero interior rays %o',
  (direction) => {
    const a = integrateGalaxyRay(field, SUN_POSITION, direction, {
      maxStepParsecs: 100,
    })
    const b = integrateGalaxyRay(field, SUN_POSITION, direction, {
      maxStepParsecs: 25,
    })
    expect(a.radianceNanowatts).toBeGreaterThan(0)
    expect(Number.isFinite(a.radianceNanowatts)).toBe(true)
    expect(
      Math.abs(a.radianceNanowatts / b.radianceNanowatts - 1),
    ).toBeLessThan(0.01)
    expect(a.rgbNanowatts.reduce((x, y) => x + y, 0)).toBeCloseTo(
      a.radianceNanowatts,
      8,
    )
  },
)
it('rejects parameters that cannot describe a finite integral', () => {
  expect(() => integrateGalaxyRay(field, SUN_POSITION, vec3(0, 0, 0))).toThrow()
  expect(() =>
    integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
      maxStepParsecs: 0,
    }),
  ).toThrow()
  expect(() =>
    integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
      distanceParsecs: Infinity,
    }),
  ).toThrow()
})
it('adds the diagnostic population rays back to the complete radiance', () => {
  const origin = UV.fromMeters(-3000 * PARSEC, 12000 * PARSEC, -1000 * PARSEC),
    direction = vec3(0, -1, 0)
  const total = integrateGalaxyRay(field, origin, direction)
  let sum = 0
  for (const population of [
    'thinDisk',
    'thickDisk',
    'youngArms',
    'barBulge',
    'halo',
  ] as const)
    sum += integrateGalaxyRay(field, origin, direction, {
      population,
    }).radianceNanowatts
  expect(sum).toBeCloseTo(total.radianceNanowatts, 8)
})

it.each(['youngArm', 'constructor', '__proto__', null])(
  'rejects an unknown runtime population %s even when the ray misses the field',
  (population) => {
    expect(() =>
      integrateGalaxyRay(
        field,
        UV.fromMeters(0, 30000 * PARSEC, 0),
        vec3(1, 0, 0),
        { population: population as unknown as GalaxyPopulation },
      ),
    ).toThrow('Unknown galaxy population')
  },
)

it('resolves the observer neighborhood while keeping the reference quadrature explicit', () => {
  const options = { distanceParsecs: 100 }
  const reference = integrateGalaxyRay(
    field,
    SUN_POSITION,
    vec3(1, 0, 0),
    options,
  )
  const observer = integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, 0), {
    ...options,
    sampling: 'observer',
  })
  expect(observer.samples).toBeGreaterThan(reference.samples)
  expect(
    Math.abs(observer.radianceNanowatts / reference.radianceNanowatts - 1),
  ).toBeLessThan(0.01)
})

it.each([
  [-8178, 20.8, 0, 1, 0, 0],
  [-8178, 20.8, 0, -1, 0, 0],
  [-8178, 20.8, 0, 0, 1, 0],
  [-8178, 20.8, 0, 0, -1, 0],
  [-8178, 20.8, 0, 1, 0, -1],
  [-7900, 1000, 0, 1, -0.1, 0.1],
  [-24000, 600, 3000, 0.5, -0.05, -1],
  [3000, -20, 1000, -1, 0.01, 0.2],
  [0, 30000, 0, 0.2, -1, 0.1],
])(
  'converges without dust from observer (%s, %s, %s) within the live iteration budget',
  (x, y, z, dx, dy, dz) => {
    const origin = UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC)
    const direction = vec3(dx, dy, dz)
    const live = integrateGalaxyRay(clearField, origin, direction, {
      distanceParsecs: 100000,
      sampling: 'observer',
    })
    const fine = integrateGalaxyRay(clearField, origin, direction, {
      distanceParsecs: 100000,
      sampling: 'observer',
      maxStepParsecs: 10,
    })
    expect(live.samples).toBeLessThan(16384)
    expect(live.radianceNanowatts).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++)
      expect(
        Math.abs(live.rgbNanowatts[i]! / fine.rgbNanowatts[i]! - 1),
      ).toBeLessThan(0.01)
  },
)

it('integrates a homogeneous absorbing emitter within each interval analytically', () => {
  const absorbing: GalaxyField = {
    ...field,
    sample: (position) => ({
      ...field.sample(position),
      totalPerCubicParsec: 2,
      emissionSolarPerCubicParsec: 3,
      emissionRgb: { r: 1, g: 1, b: 1 },
      extinctionPerParsec: { r: 0.01, g: 0.02, b: 0.03 },
    }),
  }
  const result = integrateGalaxyRay(
    absorbing,
    UV.fromMeters(0, 0, 0),
    vec3(1, 0, 0),
    { distanceParsecs: 100 },
  )
  for (const [i, k] of [0.01, 0.02, 0.03].entries())
    expect(result.rgbNanowatts[i]).toBeCloseTo(
      ((1 - Math.exp(-k * 100)) / k) * GALAXY_RADIANCE_FACTOR,
      6,
    )
  expect(result.starsPerSquareParsec).toBeCloseTo(200, 10)
})

it('attenuates a rear source through foreground dust while preserving foreground emission', () => {
  const sample = field.sample(UV.fromMeters(0, 0, 0))
  const layered = (dustFirst: boolean): GalaxyField => ({
    ...field,
    sample: (position) => {
      const dust = UV.approxMeters(position).x / PARSEC < 100 === dustFirst
      return {
        ...sample,
        totalPerCubicParsec: dust ? 0 : 2,
        emissionRgb: dust ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 },
        extinctionPerParsec: dust
          ? { r: 0.01, g: 0.02, b: 0.03 }
          : { r: 0, g: 0, b: 0 },
      }
    },
  })
  const ray = (dustFirst: boolean) =>
    integrateGalaxyRay(
      layered(dustFirst),
      UV.fromMeters(0, 0, 0),
      vec3(1, 0, 0),
      { distanceParsecs: 200, maxStepParsecs: 25 },
    )
  const obscured = ray(true),
    foreground = ray(false)
  for (const [i, q] of [1, 2, 3].entries()) {
    expect(obscured.rgbNanowatts[i]).toBeCloseTo(
      100 * Math.exp(-q) * GALAXY_RADIANCE_FACTOR,
      8,
    )
    expect(foreground.rgbNanowatts[i]).toBeCloseTo(
      100 * GALAXY_RADIANCE_FACTOR,
      8,
    )
    expect(obscured.transmittanceRgb[i]).toBeCloseTo(Math.exp(-q), 12)
    expect(foreground.transmittanceRgb[i]).toBeCloseTo(Math.exp(-q), 12)
  }
  expect(obscured.starsPerSquareParsec).toBe(foreground.starsPerSquareParsec)
})

it('keeps zero-dust transport exactly equal to emission-only midpoint quadrature', () => {
  const points: ReturnType<typeof clearField.sample>[] = []
  const recording: GalaxyField = {
    ...clearField,
    sample: (p) => {
      const sample = clearField.sample(p)
      points.push(sample)
      return sample
    },
  }
  const ray = integrateGalaxyRay(recording, SUN_POSITION, vec3(1, 0, 0), {
    distanceParsecs: 100,
    maxStepParsecs: 5,
  })
  const expected = [0, 0, 0]
  for (const sample of points) {
    expected[0]! += sample.emissionRgb.r * 5
    expected[1]! += sample.emissionRgb.g * 5
    expected[2]! += sample.emissionRgb.b * 5
  }
  expect(ray.rgbNanowatts).toEqual(
    expected.map((v) => v * GALAXY_RADIANCE_FACTOR),
  )
  expect(ray.transmittanceRgb).toEqual([1, 1, 1])
  expect(ray.opticalDepthRgb).toEqual([0, 0, 0])
})

it('bounds transmission and increases attenuation when a fixed column gains dust', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 4, noNaN: true }),
      fc.double({ min: 0, max: 4, noNaN: true }),
      fc.double({ min: -1, max: 1, noNaN: true }),
      (a, b, dy) => {
        const run = (scale: number) =>
          integrateGalaxyRay(
            createGalaxyField(field.seed, { dustScale: scale }),
            SUN_POSITION,
            vec3(1, dy, 0.2),
            { distanceParsecs: 1000, maxStepParsecs: 10 },
          )
        const less = run(Math.min(a, b)),
          more = run(Math.max(a, b))
        for (let i = 0; i < 3; i++) {
          expect(more.transmittanceRgb[i]).toBeGreaterThanOrEqual(0)
          expect(less.transmittanceRgb[i]).toBeLessThanOrEqual(1)
          expect(more.transmittanceRgb[i]!).toBeLessThanOrEqual(
            less.transmittanceRgb[i]! + 1e-14,
          )
          expect(more.rgbNanowatts[i]!).toBeLessThanOrEqual(
            less.rgbNanowatts[i]! + 1e-9,
          )
          expect(more.transmittanceRgb[i]).toBeCloseTo(
            Math.exp(-more.opticalDepthRgb[i]!),
            12,
          )
        }
        expect(more.starsPerSquareParsec).toBe(less.starsPerSquareParsec)
      },
    ),
    { numRuns: 30 },
  )
})

it('reduces transmittance along successively longer portions of a ray', () => {
  let previous = [1, 1, 1]
  for (const distanceParsecs of [0, 100, 200, 500, 1000, 5000]) {
    const ray = integrateGalaxyRay(field, SUN_POSITION, vec3(1, 0, -0.2), {
      distanceParsecs,
      maxStepParsecs: 5,
    })
    for (let i = 0; i < 3; i++)
      expect(ray.transmittanceRgb[i]!).toBeLessThanOrEqual(previous[i]!)
    previous = [...ray.transmittanceRgb]
  }
})

it.each([
  ['interior', -8178, 20.8, 0, 1, 0, 0],
  ['anticenter', -8178, 20.8, 0, -1, 0, 0],
  ['north', -8178, 20.8, 0, 0, 1, 0],
  ['south', -8178, 20.8, 0, 0, -1, 0],
  ['oblique', -8178, 20.8, 0, 1, 0, -1],
  ['rim', -24000, 600, 3000, 0.5, -0.05, -1],
  ['crossing', -7900, 1000, 0, 1, -0.1, 0.1],
  ['dense', 3000, -20, 1000, -1, 0.01, 0.2],
  ['face-on', 0, 30000, 0, 0.2, -1, 0.1],
  ['edge-on', 0, 0, 40000, 0, 0, -1],
] as const)(
  'converges the textured %s ray against a quarter-parsec reference',
  (_name, x, y, z, dx, dy, dz) => {
    const origin = UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC),
      direction = vec3(dx, dy, dz)
    const run = (maxStepParsecs: number) =>
      integrateGalaxyRay(field, origin, direction, {
        distanceParsecs: 100000,
        sampling: 'settled',
        maxStepParsecs,
      })
    const reference = run(0.25),
      fine = run(0.5),
      settled = run(100)
    expect(settled.samples).toBeLessThan(16384)
    for (let i = 0; i < 3; i++) {
      expect(
        Math.abs(settled.rgbNanowatts[i]! / reference.rgbNanowatts[i]! - 1),
      ).toBeLessThan(0.01)
      expect(
        Math.abs(fine.rgbNanowatts[i]! / reference.rgbNanowatts[i]! - 1),
      ).toBeLessThan(0.0001)
      expect(
        Math.abs(fine.opticalDepthRgb[i]! / reference.opticalDepthRgb[i]! - 1),
      ).toBeLessThan(0.0001)
    }
  },
)

it.each([0, 1e-12, 1e-7, 0.009999, 0.01, 1, 100])(
  'retains the homogeneous source term at optical depth %s',
  (q) => {
    const sample = clearField.sample(SUN_POSITION)
    const uniform: GalaxyField = {
      ...clearField,
      sample: () => ({
        ...sample,
        emissionRgb: { r: 1, g: 1, b: 1 },
        extinctionPerParsec: { r: q, g: q, b: q },
      }),
    }
    const result = integrateGalaxyRay(uniform, SUN_POSITION, vec3(1, 0, 0), {
      distanceParsecs: 1,
    })
    const expected = q === 0 ? 1 : -Math.expm1(-q) / q
    for (let i = 0; i < 3; i++) {
      expect(result.rgbNanowatts[i]! / GALAXY_RADIANCE_FACTOR).toBeCloseTo(
        expected,
        9,
      )
      expect(result.transmittanceRgb[i]).toBeCloseTo(Math.exp(-q), 14)
      expect(result.opticalDepthRgb[i]).toBe(q)
    }
  },
)

it('widens settled intervals through the transparent halo without truncating the path', () => {
  const origin = UV.fromMeters(0, 5000 * PARSEC, 30000 * PARSEC)
  const direction = vec3(0, 0, -1)
  const sample = clearField.sample(origin)
  const homogeneous: GalaxyField = {
    ...clearField,
    sample: () => ({ ...sample, totalPerCubicParsec: 1 }),
  }
  const settled = integrateGalaxyRay(homogeneous, origin, direction, {
    sampling: 'settled',
  })
  const fine = integrateGalaxyRay(homogeneous, origin, direction, {
    sampling: 'observer',
    maxStepParsecs: 10,
  })
  expect(settled.samples).toBeLessThan(fine.samples / 5)
  expect(settled.starsPerSquareParsec).toBeCloseTo(60000, 8)
  expect(fine.starsPerSquareParsec).toBeCloseTo(60000, 8)
})

/** The edge-on instrument at 40 kpc, and the angle one texel of a 240×135 target subtends under its 55° lens. */
const EDGE_ON = UV.fromMeters(0, 0, 40000 * PARSEC)
const EDGE_ON_TEXEL = (55 * Math.PI) / 180 / 135
const edgeOnRay = (across: number, up: number) => vec3(across, up, -1)

it('integrates the exact field along the pixel center unless a pixel angle is given', () => {
  fc.assert(
    fc.property(
      fc.double({ min: -0.4, max: 0.4, noNaN: true }),
      fc.double({ min: -0.02, max: 0.02, noNaN: true }),
      fc.constantFrom('reference', 'observer', 'settled' as const),
      (across, up, sampling) => {
        const options = { sampling, maxStepParsecs: 100 }
        expect(
          integrateGalaxyRay(field, EDGE_ON, edgeOnRay(across, up), {
            ...options,
            pixelAngle: 0,
          }),
        ).toEqual(
          integrateGalaxyRay(field, EDGE_ON, edgeOnRay(across, up), options),
        )
      },
    ),
    { numRuns: 12 },
  )
  for (const pixelAngle of [-1e-3, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() =>
      integrateGalaxyRay(field, EDGE_ON, edgeOnRay(0, 0), { pixelAngle }),
    ).toThrow('pixel angle')
})

it('keeps the strip mean while filtering the dust a texel cannot resolve', () => {
  /*
   * Seventeen texels along the plane and seventeen at 300 pc above it, the
   * exact center rays against the filtered ones. Filtering the density to
   * its mean under a convex transport is a slight underestimate of the mean
   * transmission — Jensen the other way — and it is measured: the filtered
   * sum is 0.994 of the exact one in the plane and 0.997 above it, settled;
   * 0.993 and 0.998 at the observer profile. The floor under the settled
   * intervals is what cuts the sample count: 40,988 to 12,760 in the plane
   * and 22,635 to 8,689 above it. The observer law already exceeds the
   * floor from 40 kpc, so that profile's count is unchanged and only its
   * texture is filtered.
   */
  for (const sampling of ['settled', 'observer'] as const)
    for (const up of [0, 300 / 40000]) {
      const exact = [0, 0, 0],
        filtered = [0, 0, 0]
      let exactSamples = 0,
        filteredSamples = 0
      for (let i = -8; i <= 8; i++) {
        const direction = edgeOnRay(i * EDGE_ON_TEXEL, up)
        const a = integrateGalaxyRay(field, EDGE_ON, direction, {
          sampling,
          maxStepParsecs: 100,
        })
        const b = integrateGalaxyRay(field, EDGE_ON, direction, {
          sampling,
          maxStepParsecs: 100,
          pixelAngle: EDGE_ON_TEXEL,
        })
        a.rgbNanowatts.forEach((v, c) => (exact[c]! += v))
        b.rgbNanowatts.forEach((v, c) => (filtered[c]! += v))
        exactSamples += a.samples
        filteredSamples += b.samples
      }
      for (let c = 0; c < 3; c++) {
        expect(filtered[c]! / exact[c]!).toBeGreaterThan(0.99)
        expect(filtered[c]! / exact[c]!).toBeLessThan(1.005)
      }
      if (sampling === 'settled')
        expect(filteredSamples).toBeLessThan(exactSamples / 2.5)
      else expect(filteredSamples).toBe(exactSamples)
    }
})

it('is closer to a supersampled texel than the center ray where the profile is smooth', () => {
  // 600 pc above the plane, where a texel spans no scale height and what
  // varies inside it is the dust texture alone: the filtered ray is 5.6%
  // from the 5×5 mean and the center ray 6.3%, settled. In the plane both
  // are 14–20% from it — a 140 pc texel spans several scale heights of a
  // profile neither filters — and that is the image's aliasing, not the
  // filter's; the strip test above is the claim made there.
  const up = 600 / 40000
  const mean = [0, 0, 0]
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const across = ((i + 0.5) / 5 - 0.5) * EDGE_ON_TEXEL
      const rise = ((j + 0.5) / 5 - 0.5) * EDGE_ON_TEXEL
      integrateGalaxyRay(field, EDGE_ON, edgeOnRay(across, up + rise), {
        sampling: 'settled',
        maxStepParsecs: 100,
      }).rgbNanowatts.forEach((v, c) => (mean[c]! += v / 25))
    }
  const error = (rgb: readonly number[]) =>
    Math.max(...rgb.map((v, c) => Math.abs(v / mean[c]! - 1)))
  const center = error(
    integrateGalaxyRay(field, EDGE_ON, edgeOnRay(0, up), {
      sampling: 'settled',
      maxStepParsecs: 100,
    }).rgbNanowatts,
  )
  const filtered = error(
    integrateGalaxyRay(field, EDGE_ON, edgeOnRay(0, up), {
      sampling: 'settled',
      maxStepParsecs: 100,
      pixelAngle: EDGE_ON_TEXEL,
    }).rgbNanowatts,
  )
  expect(filtered).toBeLessThan(center)
  expect(filtered).toBeLessThan(0.07)
})
