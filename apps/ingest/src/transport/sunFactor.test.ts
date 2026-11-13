import { describe, expect, it } from 'vitest'
import {
  FACTOR_SUNS,
  type FactorPartFile,
  type FitRay,
  fitPair,
  formFactor,
  judge,
  keptRays,
  partInputs,
  pooledFactor,
  refusal,
  sourceHash,
  sourceHashOf,
} from './sunFactor.ts'
import { SLAB_VIEW_SOURCE } from '@inertialref/rendering'

/** Rays whose §5.5 is the tracer's over a known factor at each sun, the clouds' own factors spread about it by `spread`. */
function raysUnder(
  pair: { l: number; a: number },
  spread: (cloud: number, ray: number) => number,
): FitRay[] {
  return [0, 1, 2].flatMap((cloud) =>
    FACTOR_SUNS.flatMap((sun) =>
      Array.from({ length: 8 }, (_, ray) => {
        const t = 1 + ray
        return {
          label: `ray ${ray}`,
          cloud: `cloud ${cloud}`,
          sun: sun.id,
          elevation: sun.elevation,
          view: 'level' as const,
          depth: 4,
          t,
          h: (t * spread(cloud, ray)) / formFactor(pair, sun.elevation),
        }
      }),
    ),
  )
}

describe('the fit of the factor', () => {
  it('finds the pair that made its rays, to the scan’s step', () => {
    const pair = { l: 0.71, a: 0.25 }
    const fitted = fitPair(raysUnder(pair, () => 1))
    expect(fitted.pair.l).toBeCloseTo(0.71, 6)
    expect(fitted.pair.a).toBeCloseTo(0.25, 6)
    for (const node of fitted.table)
      expect(node.factor).toBeCloseTo(formFactor(pair, node.elevation), 9)
  })

  it('counts each cloud and sun once at an elevation, by the geometric mean', () => {
    // Two clouds a sun whose own factors are 2 and 8 pool to 4, however many rays each has.
    const rays = (cloud: string, factor: number, count: number): FitRay[] =>
      Array.from({ length: count }, (_, i) => ({
        label: `${i}`,
        cloud,
        sun: '7-behind',
        elevation: 7,
        view: 'level',
        depth: 1,
        t: 1,
        h: 1 / factor,
      }))
    expect(pooledFactor([...rays('a', 2, 3), ...rays('b', 8, 40)])).toBeCloseTo(
      4,
      12,
    )
  })

  it('judges rays made by the pair to no error, and leaves a cloud’s own spread as the least', () => {
    const pair = { l: 0.71, a: 0.25 }
    const exact = judge(
      raysUnder(pair, () => 1),
      pair,
    )
    expect(exact.with).toBeLessThan(1e-12)
    expect(exact.least).toBeLessThan(1e-12)
    expect(exact.without).toBeGreaterThan(0.2)
    // Within a cloud and a sun the rays scatter by ±10% about its own factor: no one factor mends that.
    const scattered = judge(
      raysUnder(pair, (_, ray) => (ray % 2 === 0 ? 1.1 : 1 / 1.1)),
      pair,
    )
    // The pair leaves the spread itself; a cloud's own sum ratio, the least, is a sum's and not a logarithm's mean, and leaves it to a hundredth.
    expect(scattered.with).toBeCloseTo(Math.log(1.1), 12)
    expect(scattered.least).toBeCloseTo(Math.log(1.1), 2)
  })

  it('reads l alone at every sun where a is zero, and the floor holds a sun under the horizon', () => {
    for (const elevation of [7, 30, 90])
      expect(formFactor({ l: 0.8, a: 0 }, elevation)).toBe(0.8)
    expect(formFactor({ l: 1, a: 1 }, -10)).toBeCloseTo(
      formFactor({ l: 1, a: 1 }, 10),
      12,
    )
    expect(formFactor({ l: 1, a: 1 }, 0)).toBeCloseTo(
      Math.sqrt(1 - 0.05 ** 2) / 0.05 + 1,
      12,
    )
  })
})

describe('a part', () => {
  const part = (over: Partial<FactorPartFile> = {}): FactorPartFile => ({
    ...partInputs(64),
    cloud: 'second',
    sun: '15-ahead',
    seconds: 1,
    rays: [
      {
        label: 'kept',
        view: 'level',
        depth: 3,
        higher: 0.1,
        traced: { mean: 0.2, error: 0.01 },
      },
      {
        label: 'noisy',
        view: 'level',
        depth: 3,
        higher: 0.1,
        traced: { mean: 0.2, error: 0.03 },
      },
      {
        label: 'dark',
        view: 'above',
        depth: 3,
        higher: 0,
        traced: { mean: 0.2, error: 0.01 },
      },
    ],
    ...over,
  })

  it('is refused short of its samples, or taken on another table', () => {
    expect(refusal(part(), partInputs(64))).toBeNull()
    expect(refusal(part(), partInputs(1536))).toMatch(/samples 64/)
    expect(refusal(part({ genusHash: 'other' }), partInputs(64))).toMatch(
      /genusHash/,
    )
    expect(refusal(part({ sourceHash: 'other' }), partInputs(64))).toMatch(
      /sourceHash/,
    )
  })

  it('keeps a ray the tracer knows to a tenth and §5.5 lights', () => {
    expect(keptRays(part()).map((ray) => ray.label)).toEqual(['kept'])
    expect(keptRays(part())[0]).toMatchObject({ elevation: 15, h: 0.1, t: 0.2 })
  })
})

describe('the source a part was marched through', () => {
  it('is refused when what reads the texels moves, and not only the texels', () => {
    // Doubling the transport scales moves a uniform cloud's marched higher orders by half again with every texel the same.
    const texels = 'the same texels'
    const moved = (over: Partial<typeof SLAB_VIEW_SOURCE>) =>
      sourceHashOf({ ...SLAB_VIEW_SOURCE, ...over }, texels)
    const base = sourceHashOf(SLAB_VIEW_SOURCE, texels)
    const changes: Partial<typeof SLAB_VIEW_SOURCE>[] = [
      {
        transport: {
          ...SLAB_VIEW_SOURCE.transport,
          scales: SLAB_VIEW_SOURCE.transport.scales.map((s) => 2 * s),
        } as never,
      },
      { depthScale: 0.04 as never },
      { depthMax: 32 as never },
      { sunMuMin: 0.1 as never },
      { stretch: 0.5 as never },
      { cosines: SLAB_VIEW_SOURCE.cosines.map((c) => c * 0.99) as never },
    ]
    for (const change of changes) expect(moved(change)).not.toBe(base)
    expect(sourceHashOf(SLAB_VIEW_SOURCE, 'other texels')).not.toBe(base)
    const part = { ...partInputs(64), sourceHash: base }
    expect(
      refusal(part as never, {
        ...partInputs(64),
        sourceHash: moved(changes[0]!),
      }),
    ).toMatch(/sourceHash/)
    expect(sourceHash()).toMatch(/^[0-9a-f]{32}$/)
  })
})
