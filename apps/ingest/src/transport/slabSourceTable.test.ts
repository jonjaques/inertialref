import * as rendering from '@inertialref/rendering'
import {
  SLAB_REFERENCE,
  SLAB_SOURCE,
  SLAB_VIEW_SOURCE,
  halfFloatsFromBase64,
} from '@inertialref/rendering'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
// The texels are reached by path: the package's index does not export them.
import { SLAB_VIEW_SOURCE_TEXELS } from '../../../../packages/rendering/src/slabSourceTexels.generated.ts'
import { iceTransport } from './slabIce.ts'
import { quadratureCosines } from './slabForms.ts'
import { judge, type SlabScale } from './slabJudge.ts'
import type { SourceTable } from './slabSource.ts'
import {
  SOURCE_AXES,
  THREE_GRID,
  TRANSPORT_RADII,
  VIEW_COSINES,
  VIEW_GRID,
  VIEW_STRETCH,
  formulaScales,
  judgmentLine,
  sourceForms,
  sourceScales,
  texelsText,
  threeForms,
  viewForm,
  type TransportRow,
} from './slabSourceTable.ts'
import { SLAB_DOMAIN, SLAB_STREAMS, SOURCE_RADIUS } from './slabTables.ts'
import { halfDecimal } from './slabText.ts'

/*
 * The committed source tables, held to themselves: each is read here by
 * what its own header says of its layout, and every figure the header
 * states is recomputed from the table and the committed reference.
 */

const rows = SLAB_REFERENCE.rows
const fluxes = SLAB_REFERENCE.reflected

/** A printed figure against the same figure recomputed: four figures, and rows printed to five. */
const PRINTED = 2e-4

describe('the view table', () => {
  const { nodes, suns, cosines, transport } = SLAB_VIEW_SOURCE
  const slabs = 2 * cosines.length
  const texels = halfFloatsFromBase64(
    SLAB_VIEW_SOURCE_TEXELS.texels,
    SLAB_VIEW_SOURCE.texelCount,
    'the view table',
  )
  const table: SourceTable = {
    nodes,
    suns,
    sunMuMin: SLAB_VIEW_SOURCE.sunMuMin,
    depthScale: SLAB_VIEW_SOURCE.depthScale,
    depthMax: SLAB_VIEW_SOURCE.depthMax,
    slabs,
    terms: texels,
  }
  // The form, from nothing but what the generated file says of itself.
  const form = viewForm({
    name: 'views',
    blend: 'angle',
    cosines: SLAB_VIEW_SOURCE.cosines,
    stretch: SLAB_VIEW_SOURCE.stretch,
  })
  const scales: SlabScale[] = SLAB_REFERENCE.media.map((media) => ({
    radius: media.radius,
    share: media.share,
    asymmetry: 1 - transport.scales[transport.radii.indexOf(media.radius)]!,
  }))

  it('is a 3D texture of half floats on the generator’s axes, under a megabyte', () => {
    expect({
      nodes,
      suns,
      sunMuMin: table.sunMuMin,
      depthScale: table.depthScale,
      depthMax: table.depthMax,
    }).toEqual(VIEW_GRID)
    expect(VIEW_GRID).toMatchObject(SOURCE_AXES)
    expect(SLAB_VIEW_SOURCE.radius).toBe(SOURCE_RADIUS)
    expect(SLAB_VIEW_SOURCE.stretch).toBe(VIEW_STRETCH)
    // Four half floats a texel: what the table costs on the GPU.
    expect(nodes * nodes * suns * slabs * 8).toBeLessThanOrEqual(1_000_000)
    expect(SLAB_VIEW_SOURCE.texelCount).toBe(nodes * nodes * suns * slabs * 4)
    expect(SLAB_VIEW_SOURCE_TEXELS.count).toBe(SLAB_VIEW_SOURCE.texelCount)
  })

  it('keeps its texels in a module of their own, which the package’s index does not export', () => {
    // 1,280,000 characters: a module that reads the table's constants
    // must not carry them, and a page reaches them by import().
    expect(SLAB_VIEW_SOURCE_TEXELS.texels).toHaveLength(
      (SLAB_VIEW_SOURCE.texelCount * 2 * 4) / 3,
    )
    expect(SLAB_VIEW_SOURCE).not.toHaveProperty('texels')
    expect(rendering).not.toHaveProperty('SLAB_VIEW_SOURCE_TEXELS')
  })

  it('is tabulated at the oracle’s own cosines, the horizon and the normal among them', () => {
    const own = quadratureCosines(SLAB_STREAMS.scaled, VIEW_COSINES)
    expect(cosines).toHaveLength(VIEW_COSINES.length)
    cosines.forEach((cosine, i) => {
      expect(Math.abs(cosine / own[i]! - 1)).toBeLessThan(1e-8)
      if (i > 0) expect(cosine).toBeGreaterThan(cosines[i - 1]!)
    })
    expect(cosines[0]).toBeLessThan(0.001)
    expect(cosines.at(-1)).toBeGreaterThan(0.999)
  })

  it('has no source where there is no slab, and a positive mean term everywhere else', () => {
    for (let slab = 0; slab < slabs; slab += 1)
      for (let sun = 0; sun < suns; sun += 1)
        for (let bottom = 0; bottom < nodes; bottom += 1)
          for (let top = 0; top < nodes; top += 1) {
            const cell =
              (((slab * suns + sun) * nodes + bottom) * nodes + top) * 4
            if (top === 0 && bottom === 0)
              expect(Array.from(texels.subarray(cell, cell + 4))).toEqual([
                0, 0, 0, 0,
              ])
            else expect(texels[cell]).toBeGreaterThan(0)
          }
  })

  it('rebuilds the oracle’s slabs through its own read to the figures its header records', () => {
    const rebuilt = judge(table, form, scales, rows, fluxes)
    const kept = SLAB_VIEW_SOURCE.reconstruction
    expect(
      Math.abs(rebuilt.error - SLAB_VIEW_SOURCE.reconstructionError),
    ).toBeLessThan(PRINTED)
    for (const figure of [
      'grid',
      'held',
      'rms',
      'median',
      'ninetyFifth',
      'ninetyNinth',
      'flux',
    ] as const)
      expect(Math.abs(rebuilt[figure] - kept[figure])).toBeLessThan(PRINTED)
    rebuilt.thin.forEach((error, at) =>
      expect(Math.abs(error - kept.thin[at]!)).toBeLessThan(PRINTED),
    )
    expect(rebuilt.count).toBe(kept.count)
    // A radiance at 5% to four figures may fall on either side of it.
    expect(Math.abs(rebuilt.over - kept.over)).toBeLessThanOrEqual(1)
    expect(rebuilt.worst).not.toBe('')
  })

  it('is at the rubric’s 2% in the reflected flux, and over its 5% in a radiance', () => {
    // The forecast for the rubric's rows 1 and 2, in Node, both declared
    // misses at these sizes. Row 2 reads 2.00%: the sun's coordinate held
    // a 64th of a slice inside its slab costs 0.06 point of it under a sun
    // straight above, where the read takes a 64th of the next sun's slice.
    // When either line turns, its row is met in Node and the line goes.
    expect(SLAB_VIEW_SOURCE.reconstructionError).toBeGreaterThan(0.05)
    expect(SLAB_VIEW_SOURCE.reconstructionError).toBeLessThan(0.06)
    expect(SLAB_VIEW_SOURCE.reconstruction.flux).toBeLessThan(0.0201)
    // The miss is a few radiances in a thousand: 99% are inside 4%.
    const { over, count, ninetyNinth, rms } = SLAB_VIEW_SOURCE.reconstruction
    expect(count).toBe(
      rows.filter((row) => row.domain && row.set !== 'thin').length * 3,
    )
    expect(over / count).toBeLessThan(0.004)
    expect(ninetyNinth).toBeLessThan(0.04)
    expect(rms).toBeLessThan(0.015)
  })

  it('is inside 5% at its own radius: what is over is the other radii’s distance from it', () => {
    const own = judge(
      table,
      form,
      scales,
      rows.filter((row) => row.radius === SOURCE_RADIUS),
      [],
    )
    expect(own.error).toBeLessThan(0.05)
    for (const radius of SLAB_DOMAIN.radii) {
      if (radius === SOURCE_RADIUS) continue
      const other = judge(
        table,
        form,
        scales,
        rows.filter((row) => row.radius === radius),
        [],
      )
      expect(other.error).toBeGreaterThan(own.error)
    }
  })

  it('reads a radius’s transport depth by the scaled phase’s own first moment, which is over the formula’s', () => {
    expect(transport.radii).toEqual([...TRANSPORT_RADII])
    expect(transport.scales).toHaveLength(transport.radii.length)
    transport.scales.forEach((scale, i) => {
      if (i > 0) expect(scale).toBeLessThan(transport.scales[i - 1]!)
    })
    for (const media of SLAB_REFERENCE.media) {
      const scale = transport.scales[transport.radii.indexOf(media.radius)]!
      // χ′₁ − g′, times the radius: 0.051 to 0.054 µm over the domain.
      const over = (1 - scale - media.asymmetry) * media.radius
      expect(over).toBeGreaterThan(0.045)
      expect(over).toBeLessThan(0.06)
    }
    // By the formula's g′ the same table is a point worse in the flux.
    const byFormula = judge(
      table,
      form,
      formulaScales(
        SLAB_REFERENCE.media.map((media) => ({
          ...media,
          moment: scales.find((scale) => scale.radius === media.radius)!
            .asymmetry,
        })),
      ),
      [],
      fluxes,
    )
    expect(byFormula.flux).toBeGreaterThan(
      SLAB_VIEW_SOURCE.reconstruction.flux + 0.005,
    )
  })
})

describe('the ice rows’ transport scale', () => {
  it('is 1 − χ′₁ of each committed ice row, about twice the droplets’', () => {
    const rows = iceTransport()
    const { radii, scales } = SLAB_VIEW_SOURCE.iceTransport
    expect(rows.map((row) => row.radius)).toEqual(radii)
    rows.forEach((row, i) => {
      // Printed to six figures.
      expect(Math.abs(1 - row.moment - scales[i]!)).toBeLessThan(1e-6)
      // The clipped peak's mean cosine is near one, so χ′₁ is near the
      // formula's g′. They are 0.0024 apart at most, at 120 µm: the
      // table's own first moment is under its bulk g by 0.16% there, the
      // reduction's limit (package T4's), and χ′₁ carries it over 1 − f_δ.
      expect(Math.abs(row.moment - row.asymmetry)).toBeLessThan(0.0025)
    })
    const droplet = SLAB_VIEW_SOURCE.transport.scales
    expect(Math.min(...scales)).toBeGreaterThan(1.6 * Math.max(...droplet))
  })
})

describe('the three-term table', () => {
  const form = threeForms(SLAB_SOURCE.lobe).find(
    (item) => item.name === 'three-relative',
  )!
  /** The table as a march's texture: a fourth channel that is no term. */
  const table: SourceTable = {
    ...THREE_GRID,
    slabs: 1,
    terms: Float64Array.from(
      { length: (SLAB_SOURCE.terms.length / 3) * 4 },
      (_, at) =>
        at % 4 === 3 ? 0 : SLAB_SOURCE.terms[(at >> 2) * 3 + (at % 4)]!,
    ),
  }

  it('is three half floats a node on the first grid, as the contract’s test holds it', () => {
    expect({
      nodes: SLAB_SOURCE.nodes,
      suns: SLAB_SOURCE.suns,
      sunMuMin: SLAB_SOURCE.sunMuMin,
      depthScale: SLAB_SOURCE.depthScale,
      depthMax: SLAB_SOURCE.depthMax,
    }).toEqual(THREE_GRID)
    expect(SLAB_SOURCE.terms).toHaveLength(
      SLAB_SOURCE.suns * SLAB_SOURCE.nodes * SLAB_SOURCE.nodes * 3,
    )
    for (const term of SLAB_SOURCE.terms) expect(halfDecimal(term)).toBe(term)
    const media = SLAB_REFERENCE.media.find(
      (item) => item.radius === SLAB_SOURCE.radius,
    )!
    expect(SLAB_SOURCE.lobe).toBeCloseTo(media.asymmetry ** 2, 6)
  })

  it('rebuilds the oracle’s slabs to the figures its header records, by the formula’s g′', () => {
    const rebuilt = judge(table, form, SLAB_REFERENCE.media, rows, fluxes)
    const kept = SLAB_SOURCE.reconstruction
    expect(
      Math.abs(rebuilt.error - SLAB_SOURCE.reconstructionError),
    ).toBeLessThan(PRINTED)
    for (const figure of ['grid', 'held', 'rms', 'flux'] as const)
      expect(Math.abs(rebuilt[figure] - kept[figure])).toBeLessThan(PRINTED)
  })

  it('is over the rubric’s 5% and 2% tenfold: three terms do not hold a slab under an oblique sun', () => {
    expect(SLAB_SOURCE.reconstructionError).toBeGreaterThan(0.5)
    expect(SLAB_SOURCE.reconstruction.flux).toBeGreaterThan(0.1)
    expect(SLAB_SOURCE.reconstructionError).toBeGreaterThan(
      10 * SLAB_VIEW_SOURCE.reconstructionError,
    )
  })
})

describe('the generator’s forms', () => {
  it('are named apart, and a grid’s stage fits them all on one solution', () => {
    const names = sourceForms(0.75).map((form) => form.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'three-relative',
      'three-relative-plain',
      'three-absolute',
      'three-absolute-plain',
      'hemispheres',
      'hemispheres-plain',
      'hemispheres-wide',
      'views-fourier',
      'views',
      'views-nearest',
      'views-dense',
    ])
    // Reads a step: one, or two.
    const ray = { sunMu: 0.5, muV: 0.33, along: 0.2, nu: 0.1 }
    const reads = Object.fromEntries(
      sourceForms(0.75).map((form) => [form.name, form.reads(ray).length]),
    )
    expect(reads).toMatchObject({
      'three-relative': 1,
      hemispheres: 1,
      'hemispheres-wide': 2,
      'views-fourier': 2,
      views: 2,
      'views-nearest': 1,
      'views-dense': 1,
    })
  })

  it('give a view form ten cosines a hemisphere, or the ones it is handed', () => {
    expect(viewForm({ name: 'views', blend: 'angle' }).slabs).toBe(
      2 * VIEW_COSINES.length,
    )
    expect(
      viewForm({ name: 'few', blend: 'angle', cosines: [0.1, 0.9] }).slabs,
    ).toBe(4)
  })
})

describe('a radius’s scale', () => {
  const transport: TransportRow[] = [
    { radius: 6, share: 0.47, asymmetry: 0.72, moment: 0.73 },
    { radius: SOURCE_RADIUS, share: 0.48, asymmetry: 0.74, moment: 0.745 },
  ]

  it('is the moment a table’s convention names', () => {
    expect(sourceScales('formula', transport).map((s) => s.asymmetry)).toEqual([
      0.72, 0.74,
    ])
    expect(sourceScales('moment', transport)).toEqual([
      { radius: 6, share: 0.47, asymmetry: 0.73 },
      { radius: SOURCE_RADIUS, share: 0.48, asymmetry: 0.745 },
    ])
  })

  it('by the formula on a table cut by the moment keeps the table’s own radius where it is', () => {
    const [other, own] = formulaScales(transport)
    expect(own!.asymmetry).toBeCloseTo(0.745, 12)
    // 1 − g′ in the ratio the formula gives the two radii.
    expect((1 - other!.asymmetry) / (1 - own!.asymmetry)).toBeCloseTo(
      0.28 / 0.26,
      12,
    )
  })
})

describe('a table’s texels as text', () => {
  it('are little-endian half floats in base64, each rounded once', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -60000, max: 60000, noNaN: true }), {
          minLength: 1,
          maxLength: 40,
        }),
        (values) => {
          const back = halfFloatsFromBase64(
            texelsText(Float64Array.from(values)),
            values.length,
            'a table',
          )
          values.forEach((value, at) =>
            expect(back[at] === Math.f16round(value)).toBe(true),
          )
        },
      ),
    )
    // Just over halfway between two half floats. Through a float32 it is
    // the halfway point itself, and the tie goes down to the even one.
    const over = 1 + 2 ** -11 + 2 ** -40
    expect(Math.fround(over)).toBe(1 + 2 ** -11)
    expect(
      halfFloatsFromBase64(texelsText(Float64Array.of(over)), 1, 'one')[0],
    ).toBe(1 + 2 ** -10)
  })
})

describe('a judgment’s line', () => {
  it('carries the columns a report does', () => {
    const line = judgmentLine('views', {
      error: 0.0564,
      grid: 0.0564,
      held: 0.05,
      thin: [0.092, 0.098, 0.084],
      rms: 0.0134,
      median: 0.0073,
      ninetyFifth: 0.0284,
      ninetyNinth: 0.0395,
      flux: 0.0196,
      worst: 'somewhere',
      bySun: [
        [1, 0.034],
        [0.2, 0.0564],
      ],
      byDepth: [[5, 0.0564]],
      over: 18,
      count: 6246,
    })
    expect(line).toBe(
      'views                    | worst 5.64% rms 1.34% | p50 0.73% p95 2.84% p99 3.95% | flux 1.96% | over 5%: 18 of 6246 | μ₀ 1: 3.4 0.2: 5.6 | τ 5: 5.6 | thin 9.2 9.8 8.4 | at somewhere',
    )
  })
})
