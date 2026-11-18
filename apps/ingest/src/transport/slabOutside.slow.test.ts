import {
  SLAB_REFERENCE,
  SLAB_VIEW_SOURCE,
  halfFloatsFromBase64,
} from '@inertialref/rendering'
import { beforeAll, describe, expect, it } from 'vitest'
// The texels are reached by path: the package's index does not export them.
import { SLAB_VIEW_SOURCE_TEXELS } from '../../../../packages/rendering/src/slabSourceTexels.generated.ts'
import { judgeValues, type SlabScale } from './slabJudge.ts'
import {
  OUTSIDE_SETS,
  SAMPLE_STREAMS,
  deepFigures,
  outsideFigures,
  outsideRows,
  outsideSample,
} from './slabOutside.ts'
import type { SourceTable } from './slabSource.ts'
import { viewForm } from './slabSourceTable.ts'
import { slabPopulation, type SlabPopulation } from './slabTables.ts'
import { OUTSIDE_JUDGED } from './slabVerdict.ts'

/*
 * The committed view table off the rubric's domain, against the oracle
 * solved here: each set of `slabOutside.ts` at its first and last depths,
 * at 64 streams, held to the figures the generated file records for that
 * sample. The generator judges the whole sets at 128 streams; this is the
 * part of that judgment small enough to run, and it fails if the table, its
 * read or the oracle moves.
 */

/** A printed figure against the same figure recomputed: four figures. */
const PRINTED = 2e-4

/**
 * Times on this Mac mini (Mac18,5, Apple M6): 7.2 to 8.5 s a set, 2.5 s
 * the deep one, and the three populations 4 s together, beside other jobs;
 * alone, 4.8 to 6.1 s a set, 1.6 s the deep set and 3.7 s the populations.
 * CI's hosted `slow` stage took more than 5.4 times this Mac's time on the
 * populations, past a 20 s timeout. Each timeout is five times a hosted
 * factor of six over the higher figure, rounded up to 10 s.
 */
const A_SET = 260_000
const DEEP = 80_000
const POPULATIONS = 120_000

const { nodes, suns, cosines, transport } = SLAB_VIEW_SOURCE
const table: SourceTable = {
  nodes,
  suns,
  sunMuMin: SLAB_VIEW_SOURCE.sunMuMin,
  depthScale: SLAB_VIEW_SOURCE.depthScale,
  depthMax: SLAB_VIEW_SOURCE.depthMax,
  slabs: 2 * cosines.length,
  terms: halfFloatsFromBase64(
    SLAB_VIEW_SOURCE_TEXELS.texels,
    SLAB_VIEW_SOURCE.texelCount,
    'the view table',
  ),
}
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

const populations = new Map<number, SlabPopulation>()
beforeAll(() => {
  for (const radius of [6, 10, 16])
    populations.set(radius, slabPopulation(radius))
}, POPULATIONS)

/** A set's sample, solved at every radius it is judged at. */
function sampleRows(name: keyof typeof OUTSIDE_SETS) {
  const set = OUTSIDE_SETS[name]
  return set.radii.flatMap((radius) =>
    outsideRows(outsideSample(set), populations.get(radius)!, SAMPLE_STREAMS),
  )
}

describe('the view table off the domain', () => {
  for (const name of OUTSIDE_JUDGED)
    it(
      `reads the ${name} set’s sample to the worst and RMS its file records, and no worse`,
      () => {
        const judged = outsideFigures(
          judgeValues(table, form, scales, sampleRows(name)),
        )
        const kept = SLAB_VIEW_SOURCE.outside[name].sample
        expect(judged.count).toBe(kept.count)
        expect(judged.worst).toBeLessThanOrEqual(kept.worst + PRINTED)
        expect(judged.rms).toBeLessThanOrEqual(kept.rms + PRINTED)
        expect(Math.abs(judged.worst - kept.worst)).toBeLessThan(PRINTED)
        expect(Math.abs(judged.rms - kept.rms)).toBeLessThan(PRINTED)
      },
      A_SET,
    )

  it(
    'holds transmitted light within 5% past the last node by diffusion’s law, where the held read is far over',
    () => {
      const rows = sampleRows('deep')
      const extended = deepFigures(judgeValues(table, form, scales, rows))
      const held = deepFigures(
        judgeValues(table, form, scales, rows, { extend: false }),
      )
      const { deep } = SLAB_VIEW_SOURCE
      deep.depths.forEach((depth, at) => {
        const of = (figures: typeof extended, side: string) =>
          figures.find((item) => item.side === side && item.depth === depth)!
            .worst
        expect(of(extended, 'transmitted')).toBeLessThan(0.05)
        expect(
          Math.abs(of(extended, 'transmitted') - deep.sample.transmitted[at]!),
        ).toBeLessThan(PRINTED)
        // The reflected side is the held read's: a ceiling at its figure.
        expect(of(extended, 'reflected')).toBeLessThanOrEqual(
          deep.sample.reflected[at]! + PRINTED,
        )
        expect(of(held, 'transmitted')).toBeGreaterThan(0.5)
      })
    },
    DEEP,
  )
})
