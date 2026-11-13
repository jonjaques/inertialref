import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ATMOSPHERE_GAIN,
  atmosphereRecipe,
  bakeMultipleScattering,
  bakeTransmittance,
  MULTI_SCATTER_FLOOR,
  transmittanceFrom,
  zenithSkyRadiance,
} from './atmosphere.ts'
import {
  bakeSkyMoments,
  darkSkyTable,
  marchSkyFaces,
  marchSkyMoments,
  SKY_BLOCK_COLUMNS,
  SKY_TABLE_HEIGHT,
  SKY_TABLE_WIDTH,
  type SkyAir,
  type SkyMoments,
  skyDirections,
  skyMomentsAt,
  skyMomentsOf,
  skyRadiance,
  NO_SKY_ROWS,
  skyRowAt,
  skyRowShares,
  skyRowsOf,
} from './skyIrradiance.ts'

/*
 * The sky table is the air's own sky, summed. Each texel is a quadrature of
 * the march `zenithSkyRadiance` takes, so the tests hold three things: that
 * the march is that one, that the quadrature has converged where a cloud
 * reads it, and that the table hands back what the quadrature summed.
 */

// Earth's authored haze, and the shell ratio and heights `buildScene` gives it.
const haze = {
  color: { r: 0.3, g: 0.55, b: 1 },
  limb: { r: 1, g: 0.6, b: 0.3 },
  thickness: 1,
  aerosolAngstrom: 1.3,
  ozone: 300,
}
const recipe = atmosphereRecipe(haze, 1.0157, {
  rayleigh: 8.5 / 6371,
  aerosol: 1.2 / 6371,
})
const transmittance = bakeTransmittance(recipe)
const multiScatter = bakeMultipleScattering(recipe, transmittance)
const air: SkyAir = { recipe, transmittance, multiScatter }
const table = bakeSkyMoments(recipe, transmittance, multiScatter)
const ceiling = recipe.topRatio - 1

/** A row's radius and a column's sun cosine, as the bake lays them out. */
const rowShares = skyRowShares(table.rows)
const rowRadius = (y: number) => 1 + rowShares[y]! * ceiling
const columnSun = (k: number) => (k / (SKY_BLOCK_COLUMNS - 1)) * 2 - 1

/**
 * Three suns, as the columns hold them: 60.6° up, 5.6° up and 5.6° under
 * the horizon. Three rows where clouds stand: the datum, 5.3 km and
 * 10.6 km on Earth. The rows between them, at 3.9, 7.5 and 15.6 km, hold
 * the same 0.3% under the two suns over the horizon and 1.6% to 2.1% of
 * L̄ under the one 5.6° under it: twilight's quadrature, not the rows'.
 */
const SUNS = [29, 17, 14] as const
const ROWS = [0, 11, 13] as const

/**
 * The reference: 2,016 directions, 32 heights over the horizon and 16 under
 * it by 42 azimuths, at the bake's own 16 samples a direction. The same
 * march at a finer sphere, so what it measures is the bake's quadrature.
 * The march's own step count is a separate error, shared with Ψ's bake:
 * against 64 samples a direction it is 0.6% at noon on the datum and 2%
 * at nautical twilight, measured once and not held here.
 */
const REFERENCE = { above: 32, below: 16, azimuths: 42, steps: 16 }

/**
 * 1% of L̄, and 1% of π·L̄ on each difference: a difference's error in
 * irradiance as a share of the sky's mean irradiance. At these nine texels
 * the bake measured 0.92%, 0.005 and 0.008.
 */
const MEAN_TOLERANCE = 0.01
const DIFFERENCE_TOLERANCE = 0.01

/** The texel's moments as the bake stored them: L̄ decoded, Δ and Δ_s as they are. */
function texel(y: number, k: number, c: number) {
  const at = (block: number) =>
    table.data[(y * SKY_TABLE_WIDTH + block * 34 + 1 + k) * 4 + c] as number
  return { mean: Math.exp(at(0)), up: at(1), sunward: at(2) }
}

describe('the sky’s march', () => {
  it('is the air’s own: straight up it is zenithSkyRadiance, to rounding', () => {
    for (const r of [1, 1.002, 1.008])
      for (const mu of [0.9, 0.3, 0.02, -0.08]) {
        const marched = skyRadiance(air, r, mu, [0, 0, 1], {
          steps: 32,
          sunlight: (radius, m) => transmittanceFrom(radius, m, recipe),
        })
        const zenith = zenithSkyRadiance(recipe, multiScatter, r, mu)
        for (let c = 0; c < 3; c += 1)
          expect(marched[c]! * ATMOSPHERE_GAIN).toBeCloseTo(zenith[c]!, 12)
      }
  })
})

describe('the sky’s quadrature', () => {
  it('weighs the whole sphere, 4π, at any height and count', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1.1, noNaN: true }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 16 }),
        (r, above, below, azimuths) => {
          const directions = skyDirections(r, { above, below, azimuths })
          let total = 0
          for (let i = 3; i < directions.length; i += 4)
            total += directions[i] as number
          // Under no heights at all the sphere's lower half goes unweighed.
          const expected =
            below === 0 ? 2 * Math.PI * (1 - horizon(r)) : 4 * Math.PI
          expect(total).toBeCloseTo(expected, 9)
        },
      ),
    )
  })

  it('gives Δ = 2 for a sky uniform above the datum and dark below, and no Δ_s', () => {
    const directions = skyDirections(1, { above: 6, below: 3, azimuths: 4 })
    const moments = skyMomentsOf(directions, (_x, _y, z, out) => {
      out.fill(z > 0 ? 0.8 : 0)
    })
    for (let c = 0; c < 3; c += 1) {
      expect(moments.up[c]).toBeCloseTo(2, 12)
      expect(moments.sunward[c]).toBeCloseTo(0, 12)
      expect(moments.mean[c]).toBeCloseTo(0.4, 12)
    }
  })

  it('gives no difference for a uniform sky, and none for a sky with no light', () => {
    const directions = skyDirections(1.004, { above: 5, below: 4, azimuths: 3 })
    const uniform = skyMomentsOf(directions, (_x, _y, _z, out) => {
      out.fill(0.3)
    })
    const none = skyMomentsOf(directions, (_x, _y, _z, out) => {
      out.fill(0)
    })
    for (let c = 0; c < 3; c += 1) {
      expect(uniform.mean[c]).toBeCloseTo(0.3, 12)
      expect(uniform.up[c]).toBeCloseTo(0, 12)
      expect(uniform.sunward[c]).toBeCloseTo(0, 12)
      expect(none.mean[c]).toBe(MULTI_SCATTER_FLOOR)
      expect([none.up[c], none.sunward[c]]).toEqual([0, 0])
    }
  })

  it('equals 2,016 directions within 1% at three suns and three cloud heights', () => {
    for (const y of ROWS)
      for (const k of SUNS) {
        const reference = marchSkyMoments(
          air,
          rowRadius(y),
          columnSun(k),
          REFERENCE,
        )
        for (let c = 0; c < 3; c += 1) {
          const baked = texel(y, k, c)
          const where = `row ${y}, column ${k}, band ${c}`
          // Half-float is not in the way: the bake is the Float32 table.
          expect(
            Math.abs(baked.mean / reference.mean[c]! - 1),
            where,
          ).toBeLessThan(MEAN_TOLERANCE)
          expect(Math.abs(baked.up - reference.up[c]!), where).toBeLessThan(
            DIFFERENCE_TOLERANCE,
          )
          expect(
            Math.abs(baked.sunward - reference.sunward[c]!),
            where,
          ).toBeLessThan(DIFFERENCE_TOLERANCE)
        }
      }
  }, 120_000)

  it('holds each face’s difference exactly: π·L̄·Δ is the irradiance above less below', () => {
    const quadrature = { above: 8, below: 4, azimuths: 6, steps: 12 }
    for (const [r, mu] of [
      [1, 0.5],
      [1.001, 0.1],
      [1.003, -0.08],
    ] as const) {
      const moments = marchSkyMoments(air, r, mu, quadrature)
      const faces = marchSkyFaces(air, r, mu, quadrature)
      for (let c = 0; c < 3; c += 1) {
        const scale = Math.PI * moments.mean[c]!
        expect(faces.above[c]! - faces.below[c]!).toBeCloseTo(
          scale * moments.up[c]!,
          12,
        )
        expect(faces.sunward[c]! - faces.away[c]!).toBeCloseTo(
          scale * moments.sunward[c]!,
          12,
        )
      }
    }
  })
})

describe('the sky table', () => {
  it('reads back what the bake summed, the mean through its logarithm', () => {
    for (const y of [0, 5, 15])
      for (const k of [0, 14, 31]) {
        const read = skyMomentsAt(table, rowShares[y]!, columnSun(k))
        const summed = marchSkyMoments(air, rowRadius(y), columnSun(k))
        for (let c = 0; c < 3; c += 1) {
          // The table is Float32, and ln L̄ reaches −69 at the floor, where
          // a float's last place is 4·10⁻⁶ of the mean.
          expect(read.mean[c]! / summed.mean[c]!).toBeCloseTo(1, 4)
          expect(read.up[c]).toBeCloseTo(summed.up[c]!, 5)
          expect(read.sunward[c]).toBeCloseTo(summed.sunward[c]!, 5)
          expect(read.upper[c]).toBeCloseTo(summed.upper[c]!, 5)
        }
      }
  })

  it('repeats each block’s edge columns in its guards, so no read blends two blocks', () => {
    for (let y = 0; y < SKY_TABLE_HEIGHT; y += 1)
      for (let block = 0; block < 3; block += 1)
        for (let c = 0; c < 4; c += 1) {
          const at = (x: number) =>
            table.data[(y * SKY_TABLE_WIDTH + block * 34 + x) * 4 + c]
          expect(at(0)).toBe(at(1))
          expect(at(33)).toBe(at(32))
        }
  })

  it('reads the mean geometrically between columns, as Ψ is read', () => {
    const y = 2
    const [low, high] = [16, 17]
    const half = (columnSun(low) + columnSun(high)) / 2
    const read = skyMomentsAt(table, rowShares[y]!, half)
    for (let c = 0; c < 3; c += 1)
      expect(read.mean[c]).toBeCloseTo(
        Math.sqrt(texel(y, low, c).mean * texel(y, high, c).mean),
        12,
      )
  })

  it('is dark for an air with no shell, and so is its stand-in', () => {
    const dark = bakeSkyMoments(
      { topRatio: 1 } as never,
      transmittance,
      multiScatter,
    )
    expect(dark).toEqual(darkSkyTable())
    for (const source of [dark, darkSkyTable(1)])
      for (const h of [0, 0.5, 1])
        for (const mu of [-1, 0, 1]) {
          const read = skyMomentsAt(source, h, mu)
          for (let c = 0; c < 3; c += 1) {
            expect(read.mean[c]! / MULTI_SCATTER_FLOOR).toBeCloseTo(1, 4)
            expect([read.up[c], read.sunward[c], read.upper[c]]).toEqual([
              0, 0, 0,
            ])
          }
        }
  })

  it('lies inside the bounds a difference can take, ±4, and its mean is positive', () => {
    for (let y = 0; y < SKY_TABLE_HEIGHT; y += 1)
      for (let k = 0; k < SKY_BLOCK_COLUMNS; k += 1)
        for (let c = 0; c < 3; c += 1) {
          const { mean, up, sunward } = texel(y, k, c)
          expect(mean).toBeGreaterThan(0)
          expect(Math.abs(up)).toBeLessThanOrEqual(4)
          expect(Math.abs(sunward)).toBeLessThanOrEqual(4)
        }
  })
})

/*
 * The airs the page builds for Earth and for the cornerstones' world
 * (`g:milky-way/s:P222_3_2_k/b:3`), as `buildScene` derives them: the
 * authored haze, `airTopRatio` and `airHeights`. The air's depth in meters
 * turns a cloud's height into the table's share of it.
 */
const PAGE_AIRS = [
  {
    name: 'Earth',
    depth: 100_000,
    haze: {
      color: { r: 0.28, g: 0.48, b: 0.95 },
      limb: { r: 0.92, g: 0.42, b: 0.2 },
      thickness: 1,
      aerosolAngstrom: 1.3,
      ozone: 300,
    },
    topRatio: 1.015678559428874,
    heights: {
      rayleigh: 0.0013326775514542883,
      aerosol: 0.00018814271314648775,
    },
    clouds: [700, 1000, 1700, 2400, 3400, 6000, 8100, 11_100],
  },
  {
    name: 'the cornerstones’ world',
    depth: 78_442.93911360748,
    haze: {
      color: { r: 0.28, g: 0.48, b: 0.95 },
      limb: { r: 0.86, g: 0.45, b: 0.26 },
      thickness: 1,
      aerosolAngstrom: 1.3,
      ozone: 0,
    },
    topRatio: 1.02,
    heights: {
      rayleigh: 0.002698194357920808,
      aerosol: 0.0003777472101089132,
    },
    // `regimeWeather(P222_3_2_k IV, 'fair-cumulus')`'s cumulus level.
    clouds: [1000, 1700, 2400],
  },
] as const

/**
 * The irradiance on each side of a horizontal and a vertical face under the
 * sky the trace draws from three moments, `L̄·max(0, 1 + ¾(Δ·ω_z + Δ_s·ω_x))`,
 * by a midpoint rule over the sphere: above, below, sunward, away. The
 * clamp at zero leaves no closed form where |Δ| or |Δ_s| passes 4/3.
 */
function traceSides(mean: number, up: number, sunward: number): number[] {
  const rings = 48
  const arcs = 96
  const sides = [0, 0, 0, 0]
  const weight = (2 / rings) * ((2 * Math.PI) / arcs)
  for (let i = 0; i < rings; i += 1) {
    const z = -1 + ((i + 0.5) / rings) * 2
    const ring = Math.sqrt(1 - z * z)
    for (let j = 0; j < arcs; j += 1) {
      const x = Math.cos(((j + 0.5) / arcs) * 2 * Math.PI) * ring
      const light =
        mean * Math.max(0, 1 + 0.75 * (up * z + sunward * x)) * weight
      sides[z > 0 ? 0 : 1]! += light * Math.abs(z)
      sides[x > 0 ? 2 : 3]! += light * Math.abs(x)
    }
  }
  return sides
}

/**
 * The worst of three bands, of L̄ and of the four sides the trace forms, as
 * a share of the quadrature's own at the height: what the table's read
 * between rows costs a cloud, with the sky's form on both sides of it.
 */
function rowError(read: SkyMoments, exact: SkyMoments): number {
  let worst = 0
  for (let c = 0; c < 3; c += 1) {
    worst = Math.max(worst, Math.abs(read.mean[c]! / exact.mean[c]! - 1))
    const got = traceSides(read.mean[c]!, read.up[c]!, read.sunward[c]!)
    const want = traceSides(exact.mean[c]!, exact.up[c]!, exact.sunward[c]!)
    for (let k = 0; k < 4; k += 1)
      worst = Math.max(worst, Math.abs(got[k]! / want[k]! - 1))
  }
  return worst
}

/**
 * 3% of the quadrature, at every cloud height and sun. Rows even in the
 * optical depth above held 2.8% on Earth and 2.3% on the world with the
 * exact transmittance at the bake and the read (ruling 007); rows even in
 * height miss by up to 60% under 6 km.
 */
const ROW_TOLERANCE = 0.03

describe('the upper side’s term, c', () => {
  it('is zero under a sky linear in direction', () => {
    const directions = skyDirections(1, { above: 6, below: 3, azimuths: 8 })
    const moments = skyMomentsOf(directions, (x, _y, z, out) => {
      out[0] = 0.5 * (1 + 0.75 * (0.8 * z + 0.3 * x))
      out[1] = 0.5 * (1 + 0.75 * (-0.4 * z))
      out[2] = 0.5
    })
    for (let c = 0; c < 3; c += 1) expect(moments.upper[c]).toBeCloseTo(0, 12)
  })

  it('makes the upper side the quadrature’s own, and the lower by Δ', () => {
    for (const r of [1, 1.0005, 1.004])
      for (const mu of [0.9, 0.26, -0.05]) {
        const moments = marchSkyMoments(air, r, mu)
        const faces = marchSkyFaces(air, r, mu)
        for (let c = 0; c < 3; c += 1) {
          const scale = Math.PI * moments.mean[c]!
          const { up, upper } = moments
          expect(scale * (1 + up[c]! / 2 + upper[c]!)).toBeCloseTo(
            faces.above[c]!,
            12,
          )
          expect(scale * (1 - up[c]! / 2 + upper[c]!)).toBeCloseTo(
            faces.below[c]!,
            12,
          )
        }
      }
  })

  it('is band k’s in block k’s alpha, and the guards repeat it', () => {
    const y = 4
    for (const k of [0, 17, 31]) {
      const summed = marchSkyMoments(air, rowRadius(y), columnSun(k))
      for (let block = 0; block < 3; block += 1) {
        const at = (x: number) =>
          table.data[(y * SKY_TABLE_WIDTH + block * 34 + x) * 4 + 3]!
        expect(at(1 + k)).toBeCloseTo(summed.upper[block]!, 5)
      }
    }
  })
})

describe('the sky table’s rows', () => {
  it('rise with height, stand where the read finds them, and crowd into the first scale heights', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.001, max: 1.1, noNaN: true }),
        fc.double({ min: 1e-4, max: 0.01, noNaN: true }),
        fc.double({ min: 1e-5, max: 0.003, noNaN: true }),
        (topRatio, rayleigh, aerosol) => {
          const rows = skyRowsOf(
            atmosphereRecipe(haze, topRatio, { rayleigh, aerosol }),
          )
          const shares = skyRowShares(rows)
          expect(shares[0]).toBe(0)
          for (let y = 1; y < SKY_TABLE_HEIGHT; y += 1) {
            expect(shares[y]!).toBeGreaterThan(shares[y - 1]!)
            expect(skyRowAt(rows, shares[y]!)).toBeCloseTo(
              y / (SKY_TABLE_HEIGHT - 1),
              9,
            )
          }
          // The last row stands under the top, and the cell under it is
          // the widest: the rows are closer where the air is.
          expect(shares[SKY_TABLE_HEIGHT - 1]!).toBeLessThan(1)
          expect(shares[1]! - shares[0]!).toBeLessThan(
            shares[SKY_TABLE_HEIGHT - 1]! - shares[SKY_TABLE_HEIGHT - 2]!,
          )
        },
      ),
    )
  })

  it('hold the last row over it, to the top, where the sky from above is not yet dark', () => {
    const last = rowShares[SKY_TABLE_HEIGHT - 1]!
    for (const mu of [-0.1, 0.3, 0.9]) {
      const atLast = skyMomentsAt(table, last, mu)
      for (const over of [(last + 1) / 2, 1, 2]) {
        expect(skyRowAt(table.rows, over)).toBe(1)
        const read = skyMomentsAt(table, over, mu)
        // The bisection places the last row within a few ulps of 1.
        for (let c = 0; c < 3; c += 1) {
          expect(read.mean[c]! / atLast.mean[c]!).toBeCloseTo(1, 9)
          expect(read.up[c]!).toBeCloseTo(atLast.up[c]!, 9)
          expect(read.sunward[c]!).toBeCloseTo(atLast.sunward[c]!, 9)
        }
      }
      // Light comes down on a face there: Δ under 2, the value of a sky
      // dark above.
      for (let c = 0; c < 3; c += 1) expect(atLast.up[c]!).toBeLessThan(1.9)
    }
  })

  it('is read as one row by a table that holds no sky', () => {
    const dark = darkSkyTable()
    expect(dark.rows).toEqual(NO_SKY_ROWS)
    for (const h of [0, 0.3, 1]) expect(skyRowAt(dark.rows, h)).toBe(0)
  })

  it('refuse a table that does not carry them', () => {
    const { rows: _, ...bare } = table
    expect(() => skyMomentsAt(bare, 0.1, 0.5)).toThrow(/no rows/)
  })
})

describe('the sky table between its rows', () => {
  for (const page of PAGE_AIRS)
    it(`holds every cloud height on ${page.name} within 3% of the quadrature there`, () => {
      const pageRecipe = atmosphereRecipe(
        page.haze,
        page.topRatio,
        page.heights,
      )
      const pageTransmittance = bakeTransmittance(pageRecipe)
      const pageMultiScatter = bakeMultipleScattering(
        pageRecipe,
        pageTransmittance,
      )
      const pageAir: SkyAir = {
        recipe: pageRecipe,
        transmittance: pageTransmittance,
        multiScatter: pageMultiScatter,
      }
      const pageTable = bakeSkyMoments(
        pageRecipe,
        pageTransmittance,
        pageMultiScatter,
      )
      const misses: string[] = []
      for (const height of page.clouds)
        for (const elevation of [15, 30, 50, 65]) {
          const mu = Math.sin((elevation * Math.PI) / 180)
          const share = height / page.depth
          const error = rowError(
            skyMomentsAt(pageTable, share, mu),
            marchSkyMoments(pageAir, 1 + share * (pageRecipe.topRatio - 1), mu),
          )
          if (!(error <= ROW_TOLERANCE))
            misses.push(
              `${height} m, ${elevation}°: ${(100 * error).toFixed(1)}%`,
            )
        }
      expect(misses).toEqual([])
    })
})

function horizon(r: number): number {
  return -Math.sqrt(Math.max(0, 1 - 1 / (r * r)))
}
