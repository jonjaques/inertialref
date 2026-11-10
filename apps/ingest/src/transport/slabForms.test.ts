import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { firstOrder, solveSlab } from './addingDoubling.ts'
import { halfRangeGauss, henyeyGreensteinMoments } from './legendre.ts'
import {
  ALONG,
  COSINE,
  ONE,
  harmonic,
  hemispheres,
  lobeBasis,
  quadratureCosines,
  stretched,
  tabulate,
  threeTerms,
  times,
  viewNodes,
  type SourceForm,
} from './slabForms.ts'
import {
  higherOrders,
  lobe,
  slabRay,
  sourceSamples,
  type SourceDirections,
  type SourceGrid,
  type SourceRay,
  type SourceTable,
} from './slabSource.ts'

const AXES = { suns: 3, sunMuMin: 0.2, depthScale: 0.02, depthMax: 16 } as const
const ISOTROPIC = {
  moments: Float64Array.of(1),
  convolved: Float64Array.of(1),
  asymmetry: 0,
}

/** The directions of a sixteen-stream run under a sun at μ₀ 0.2: seventeen bearings with both ends. */
function directionsOf(): SourceDirections {
  let kept: SourceDirections | undefined
  sourceSamples(
    ISOTROPIC,
    { ...AXES, suns: 2, nodes: 2 },
    16,
    { bearings: { count: 17, ends: true } },
    (cell, _, directions) => {
      if (cell.sun === 0) kept = directions
    },
  )
  return kept!
}

const DIRECTIONS = directionsOf()

/** A sample's ray. */
function rayOf(at: number): SourceRay {
  return {
    sunMu: DIRECTIONS.sunMu,
    muV: DIRECTIONS.muV[at]!,
    along: DIRECTIONS.along[at]!,
    nu: DIRECTIONS.nu[at]!,
  }
}

/** A source over the directions, from a function of each one's ray. */
function sourceOf(value: (ray: SourceRay) => number): Float64Array {
  return Float64Array.from(DIRECTIONS.muV, (_, at) => value(rayOf(at)))
}

/** What a form's fit reads back along a ray. */
function readBack(
  form: SourceForm,
  fitted: Float64Array,
  ray: SourceRay,
): number {
  let sum = 0
  for (const read of form.reads(ray))
    for (let channel = 0; channel < 4; channel += 1)
      sum += fitted[read.slab * 4 + channel]! * read.weights[channel]!
  return sum
}

const ray = (viewMu: number, azimuth: number, side = 'reflected'): SourceRay =>
  slabRay({
    depth: 1,
    sunMu: 0.2,
    viewMu,
    azimuth,
    side: side as 'reflected' | 'transmitted',
  })

describe('a bearing’s bases', () => {
  it('are the harmonics of the angle between the light’s bearing and the sun’s', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0, max: 180, noNaN: true }),
        fc.integer({ min: 0, max: 3 }),
        (viewMu, azimuth, k) => {
          const at = ray(viewMu, azimuth)
          expect(harmonic(k).at(at)).toBeCloseTo(
            Math.cos((k * azimuth * Math.PI) / 180),
            9,
          )
          // A stretch of one is no stretch; any stretch keeps the two ends.
          expect(stretched(k, 1).at(at)).toBeCloseTo(harmonic(k).at(at), 9)
          expect(stretched(k, 0.65).at(ray(viewMu, 0))).toBeCloseTo(1, 12)
          expect(stretched(k, 0.65).at(ray(viewMu, 180))).toBeCloseTo(
            (-1) ** k,
            9,
          )
        },
      ),
    )
  })

  it('stretch the bearings near the sun’s: a quarter turn is 0.64 of the half circle at 0.65', () => {
    // ψ(90°) = π·0.5^0.65 = 114.7°, so cos ψ is already negative there.
    expect(stretched(1, 0.65).at(ray(0.5, 90))).toBeCloseTo(
      Math.cos(Math.PI * 0.5 ** 0.65),
      12,
    )
    expect(stretched(1, 0.65).at(ray(0.5, 90))).toBeLessThan(-0.4)
  })

  it('give a ray along the normal a right angle, where it has no bearing', () => {
    expect(harmonic(1).at(ray(1, 30))).toBeCloseTo(0, 12)
    expect(harmonic(2).at(ray(1, 30))).toBeCloseTo(-1, 12)
    expect(harmonic(0).at(ray(1, 30))).toBe(1)
  })

  it('are the ray’s own cosine, its part along the sun’s bearing, a lobe, and products of them', () => {
    const at = ray(0.4, 60, 'transmitted')
    expect(ONE.at(at)).toBe(1)
    expect(COSINE.at(at)).toBe(-0.4)
    expect(ALONG.at(at)).toBeCloseTo(Math.sqrt(1 - 0.16) * 0.5, 12)
    expect(lobeBasis(0.5).at(at)).toBeCloseTo(lobe(at.nu, 0.5), 12)
    expect(times(COSINE, ALONG).at(at)).toBeCloseTo(
      -0.4 * Math.sqrt(1 - 0.16) * 0.5,
      12,
    )
    expect(times(COSINE, ALONG).name).toBe('μ·h')
  })
})

describe('the cosines a view is tabulated at', () => {
  it('are the oracle’s own, the nearest to each target, ascending and distinct', () => {
    const rule = halfRangeGauss(64).nodes
    const picked = quadratureCosines(128, [1, 0, 0.3, 0.3001])
    expect(picked).toHaveLength(3)
    expect(picked[0]).toBe(Math.min(...rule))
    expect(picked[2]).toBe(Math.max(...rule))
    for (const cosine of picked) expect(rule).toContain(cosine)
    expect(Math.abs(picked[1]! - 0.3)).toBeLessThan(0.02)
  })
})

describe('the view’s cosine as a coordinate', () => {
  const cosines = quadratureCosines(16, [0, 0.3, 0.7, 1])
  const basis = [0, 1, 2, 3].map((k) => stretched(k, 0.65))
  const form = viewNodes({
    name: 'views',
    cosines,
    basis,
    measure: 'relative',
    blend: 'angle',
  })

  it('is a slab a cosine a hemisphere, the lit face’s first', () => {
    expect(cosines).toHaveLength(4)
    expect(form.slabs).toBe(8)
    expect(form.reads(ray(cosines[1]!, 40))[0]!.slab).toBe(1)
    expect(form.reads(ray(cosines[1]!, 40, 'transmitted'))[0]!.slab).toBe(5)
  })

  it('fits a source that is its bases exactly, and reads it back at every bearing of a node', () => {
    // A source whose bearing is the four bases at every cosine, with
    // coefficients that differ by cosine and by hemisphere.
    const source = sourceOf(
      (at) =>
        3 +
        at.muV +
        (0.5 + at.muV * at.muV) * basis[1]!.at(at) +
        0.2 * basis[2]!.at(at) -
        0.1 * at.muV * basis[3]!.at(at),
    )
    const fitted = form.fit(source, DIRECTIONS)
    const bearings = DIRECTIONS.azimuths.length
    for (const cosine of cosines) {
      const node = DIRECTIONS.cosines.indexOf(cosine)
      for (const from of [node, DIRECTIONS.cosines.length + node])
        for (let a = 0; a < bearings; a += 1) {
          const at = from * bearings + a
          expect(readBack(form, fitted, rayOf(at))).toBeCloseTo(source[at]!, 6)
        }
    }
  })

  it('blends the two cosines a ray lies between in the polar angle, and reads an end alone past it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 180, noNaN: true }),
        (viewMu, azimuth) => {
          const reads = form.reads(ray(viewMu, azimuth))
          expect(reads.length).toBeLessThanOrEqual(2)
          // The first basis is one, so the first weights are the blend's shares.
          expect(
            reads.reduce((sum, read) => sum + read.weights[0], 0),
          ).toBeCloseTo(1, 12)
          if (reads.length === 2) {
            const [low, high] = reads as [(typeof reads)[0], (typeof reads)[0]]
            expect(high.slab).toBe(low.slab + 1)
            const angle =
              low.weights[0] * Math.acos(cosines[low.slab]!) +
              high.weights[0] * Math.acos(cosines[high.slab]!)
            expect(angle).toBeCloseTo(Math.acos(viewMu), 10)
          }
        },
      ),
    )
    expect(form.reads(ray(0.99999, 10))).toHaveLength(1)
    expect(form.reads(ray(0.99999, 10))[0]!.slab).toBe(3)
    expect(form.reads(ray(0.001, 10))[0]!.slab).toBe(0)
  })

  it('holds sin θ between the pole and the next cosine, which a blend in the cosine reads low', () => {
    // A first harmonic goes as sin θ, a square root in the cosine at the
    // pole. Halfway in angle between the last two cosines, 0.763 and 0.980,
    // the blend in the angle is 0.6% under it, the chord's own; the blend
    // in the cosine is 3.0% under.
    const flat = viewNodes({
      name: 'flat',
      cosines,
      basis,
      measure: 'relative',
      blend: 'cosine',
    })
    const source = sourceOf(
      (at) => 2 + Math.sqrt(1 - at.muV * at.muV) * basis[1]!.at(at),
    )
    const [lower, upper] = [cosines[2]!, cosines[3]!]
    const middle = Math.cos((Math.acos(lower) + Math.acos(upper)) / 2)
    const exact = 2 + Math.sqrt(1 - middle * middle)
    const byAngle = readBack(form, form.fit(source, DIRECTIONS), ray(middle, 0))
    const byCosine = readBack(
      flat,
      flat.fit(source, DIRECTIONS),
      ray(middle, 0),
    )
    expect(Math.abs(byAngle / exact - 1)).toBeLessThan(0.01)
    expect(byCosine / exact - 1).toBeLessThan(-0.025)
  })

  it('reads the nearer cosine alone when asked for one read a step', () => {
    const near = viewNodes({
      name: 'near',
      cosines,
      basis,
      measure: 'relative',
      blend: 'nearest',
    })
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (viewMu) => {
        const reads = near.reads(ray(viewMu, 70))
        expect(reads).toHaveLength(1)
        const angle = Math.acos(viewMu)
        const nearest = cosines.reduce((best, cosine) =>
          Math.abs(Math.acos(cosine) - angle) <
          Math.abs(Math.acos(best) - angle)
            ? cosine
            : best,
        )
        expect(cosines[reads[0]!.slab]).toBe(nearest)
        expect(reads[0]!.weights[0]).toBe(1)
      }),
    )
  })

  it('refuses a cosine the oracle does not hold, and a fifth basis', () => {
    const off = viewNodes({
      name: 'off',
      cosines: [0.5],
      basis,
      measure: 'relative',
    })
    expect(() =>
      off.fit(
        sourceOf(() => 1),
        DIRECTIONS,
      ),
    ).toThrow(/not one of the oracle's quadrature cosines/)
    expect(() =>
      viewNodes({
        name: 'five',
        cosines,
        basis: [...basis, ONE],
        measure: 'relative',
      }),
    ).toThrow(/not one texel/)
  })
})

describe('the hemispheres fitted apart', () => {
  it('hold a step across the horizon, which one cosine over the sphere cannot', () => {
    const step = sourceOf((at) => (at.muV > 0 ? 0.3 : 0.02))
    const apart = hemispheres({
      name: 'hemispheres',
      basis: [ONE, COSINE],
      measure: 'relative',
    })
    expect(apart.slabs).toBe(2)
    const fitted = apart.fit(step, DIRECTIONS)
    expect(readBack(apart, fitted, ray(0.6, 20))).toBeCloseTo(0.3, 9)
    expect(readBack(apart, fitted, ray(0.6, 20, 'transmitted'))).toBeCloseTo(
      0.02,
      9,
    )
    const whole = threeTerms({
      lobe: 0.5,
      measure: 'relative',
      withLobe: false,
    })
    const one = whole.fit(step, DIRECTIONS)
    expect(
      Math.abs(readBack(whole, one, ray(0.05, 20)) / 0.3 - 1),
    ).toBeGreaterThan(0.5)
  })

  it('take a second read for a fifth term, and no ninth', () => {
    const basis = [ONE, COSINE, ALONG, times(COSINE, COSINE), lobeBasis(0.5)]
    const wide = hemispheres({ name: 'wide', basis, measure: 'absolute' })
    expect(wide.slabs).toBe(4)
    const source = sourceOf(
      (at) =>
        1 +
        0.5 * at.muV +
        0.2 * at.along +
        at.muV ** 2 +
        0.1 * lobe(at.nu, 0.5),
    )
    const fitted = wide.fit(source, DIRECTIONS)
    const at = ray(0.45, 100, 'transmitted')
    expect(wide.reads(at)).toHaveLength(2)
    expect(wide.reads(at).map((read) => read.slab)).toEqual([2, 3])
    expect(readBack(wide, fitted, at)).toBeCloseTo(
      1 - 0.225 + 0.2 * at.along + 0.2025 + 0.1 * lobe(at.nu, 0.5),
      6,
    )
    expect(() =>
      hemispheres({
        name: 'nine',
        basis: Array.from({ length: 9 }, () => ONE),
        measure: 'absolute',
      }),
    ).toThrow()
  })
})

describe('a fit’s measure', () => {
  it('counts a sample’s error over the sample, or as it is', () => {
    // A source a constant cannot hold: one direction in four is ten times
    // the rest. Least squares on the source lands on the weighted mean;
    // over the source, on Σ(1/s)/Σ(1/s²), which is nearer the many.
    const source = sourceOf((at) => (at.muV > 0.5 ? 10 : 1))
    const constant = (measure: 'absolute' | 'relative'): number =>
      hemispheres({ name: measure, basis: [ONE], measure }).fit(
        source,
        DIRECTIONS,
      )[0]!
    let sum = 0
    let total = 0
    let inverse = 0
    let inverseSquare = 0
    DIRECTIONS.muV.forEach((muV, at) => {
      if (muV <= 0) return
      const weight = DIRECTIONS.solid[at]!
      sum += weight * source[at]!
      total += weight
      inverse += weight / source[at]!
      inverseSquare += weight / source[at]! ** 2
    })
    expect(constant('absolute')).toBeCloseTo(sum / total, 6)
    expect(constant('relative')).toBeCloseTo(inverse / inverseSquare, 6)
    expect(constant('relative')).toBeLessThan(constant('absolute') / 2)
  })
})

describe('a form tabulated from the oracle', () => {
  it('is three terms exactly where scattering is isotropic, so a slab rebuilds to the table’s read', () => {
    const grid: SourceGrid = { ...AXES, nodes: 24 }
    const forms = (['absolute', 'relative'] as const).flatMap((measure) =>
      [true, false].map((withLobe) =>
        threeTerms({ lobe: 0.3, measure, withLobe }),
      ),
    )
    expect(forms.map((form) => form.name)).toEqual([
      'three-absolute',
      'three-absolute-plain',
      'three-relative',
      'three-relative-plain',
    ])
    const made = tabulate(ISOTROPIC, grid, 16, forms)
    const absolute = made.tables.get('three-absolute')!
    // An isotropic source has no cosine and no lobe in it, by either measure.
    for (let cell = 0; cell < absolute.length; cell += 4) {
      expect(Math.abs(absolute[cell + 1]!)).toBeLessThan(1e-9)
      expect(Math.abs(absolute[cell + 2]!)).toBeLessThan(1e-9)
      expect(absolute[cell + 3]).toBe(0)
      for (const name of ['three-relative', 'three-absolute-plain'])
        expect(made.tables.get(name)![cell]).toBeCloseTo(absolute[cell]!, 9)
    }
    const form = forms[0]!
    const table: SourceTable = { ...grid, slabs: 1, terms: absolute }
    const depths = [0.5, 2, 5, 12]
    // The table's own suns, so the read is between depth nodes alone.
    const suns = [1, 0.6, 0.2]
    const views = [0.3, 0.7, 1]
    const oracle = solveSlab({
      medium: { moments: [1] },
      depths,
      suns,
      views,
      azimuths: [0],
      streams: 32,
    })
    let cell = 0
    for (const depth of depths)
      for (const sunMu of suns)
        for (const viewMu of views) {
          for (const side of ['reflected', 'transmitted'] as const) {
            const view = { depth, sunMu, viewMu, azimuth: 0, side }
            const rebuilt =
              firstOrder(depth, sunMu, viewMu, side) / (4 * Math.PI) +
              higherOrders(table, form.reads(slabRay(view)), view, 0)
            // What is left is the read between 24 nodes a depth axis:
            // measured, 0.55% at worst, through the deepest slab.
            expect(Math.abs(rebuilt / oracle[side][cell]! - 1)).toBeLessThan(
              0.01,
            )
          }
          cell += 1
        }
  })

  it('leaves the nodes it was not asked for at zero, and lays a slab after a slab', () => {
    const grid: SourceGrid = { ...AXES, nodes: 6 }
    const moments = henyeyGreensteinMoments(0.5, 40)
    const form = hemispheres({
      name: 'apart',
      basis: [ONE, COSINE],
      measure: 'absolute',
    })
    const made = tabulate(
      { moments, convolved: moments, asymmetry: 0.5 },
      grid,
      8,
      [form],
      { rows: [2], columns: [4] },
    )
    const table = made.tables.get('apart')!
    expect(table).toHaveLength(2 * 3 * 6 * 6 * 4)
    expect(made.modes).toBeGreaterThan(1)
    for (let slab = 0; slab < 2; slab += 1)
      for (let sun = 0; sun < 3; sun += 1)
        for (let bottom = 0; bottom < 6; bottom += 1)
          for (let top = 0; top < 6; top += 1) {
            const value =
              table[(((slab * 3 + sun) * 6 + bottom) * 6 + top) * 4]!
            if (top === 2 && bottom === 4) expect(value).toBeGreaterThan(0)
            else expect(value).toBe(0)
          }
    // Half a scaled depth under the lit face of a slab eight deep, what
    // comes back up from below is most of the light there is to scatter:
    // the source toward the lit face, the first slab, is the larger.
    // (c₀ + c₁·μ_v) at μ_v = ±0.6.
    const at = (slab: number, muV: number): number => {
      const cell = (((slab * 3 + 2) * 6 + 4) * 6 + 2) * 4
      return table[cell]! + table[cell + 1]! * muV
    }
    expect(at(0, 0.6)).toBeGreaterThan(1.1 * at(1, -0.6))
  })
})
