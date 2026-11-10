import {
  SLAB_REFERENCE,
  SLAB_SOURCE,
  SLAB_VIEW_SOURCE,
  halfFloatsFromBase64,
} from '@inertialref/rendering'
import { beforeAll, describe, expect, it } from 'vitest'
import { tabulate } from './slabForms.ts'
import { MIDPOINT_BEARINGS } from './slabSource.ts'
import {
  THREE_GRID,
  VIEW_BEARINGS,
  VIEW_GRID,
  sourceMedium,
  threeForms,
  viewForm,
} from './slabSourceTable.ts'
import {
  SLAB_STREAMS,
  SOURCE_RADIUS,
  blackSurfaceFlux,
  referenceStage,
  slabPopulation,
  type SlabPopulation,
} from './slabTables.ts'
import { halfDecimal } from './slabText.ts'

/*
 * The committed tables recomputed from the Mie series. Each case is the
 * generator's own arithmetic on a part of its work small enough to run
 * here: tens of seconds, where the whole of it is half an hour of four
 * cores.
 */

/**
 * A value printed to five figures, against the same value recomputed: half
 * a unit in the fifth figure is 5 × 10⁻⁵ of a value that begins with a one.
 */
const FIVE_FIGURES = 6e-5

let population: SlabPopulation

beforeAll(() => {
  population = slabPopulation(SOURCE_RADIUS)
})

describe('the reference’s rows, recomputed', () => {
  const pairs = [
    { depth: 5, sunMu: 0.5, set: 'grid' },
    { depth: 7, sunMu: 0.7, set: 'held' },
    { depth: 2, sunMu: 1, set: 'thin' },
  ] as const
  const committed = (
    depth: number,
    sunMu: number,
    viewMu: number,
    azimuth: number,
    side: string,
  ) =>
    SLAB_REFERENCE.rows.find(
      (row) =>
        row.radius === SOURCE_RADIUS &&
        row.depth === depth &&
        row.sunMu === sunMu &&
        row.viewMu === viewMu &&
        row.azimuth === azimuth &&
        row.side === side,
    )!

  it('are both media’s at the zenith, at the committed stream counts', () => {
    // Straight up or down only the azimuthal mean arrives, so the true
    // medium's 256 streams cost three modes and not 256.
    const stage = referenceStage(population, {
      pairs,
      views: [1],
      azimuths: [0],
    })
    expect(stage.streams).toEqual(SLAB_STREAMS)
    expect(stage.rows).toHaveLength(6)
    for (const row of stage.rows) {
      const kept = committed(row.depth, row.sunMu, 1, 0, row.side)
      for (const field of ['truth', 'scaled', 'first'] as const)
        row[field].forEach((value, band) =>
          expect(Math.abs(value / kept[field][band]! - 1)).toBeLessThan(
            FIVE_FIGURES,
          ),
        )
    }
    for (const flux of stage.fluxes) {
      const kept = SLAB_REFERENCE.reflected.find(
        (item) =>
          item.radius === SOURCE_RADIUS &&
          item.depth === flux.depth &&
          item.sunMu === flux.sunMu,
      )!
      for (const field of ['truth', 'scaled'] as const)
        flux[field].forEach((value, band) =>
          expect(Math.abs(value / kept[field][band]! - 1)).toBeLessThan(
            FIVE_FIGURES,
          ),
        )
    }
  }, 120_000)

  it('are the renderer’s medium’s off the zenith, every azimuthal mode, in green', () => {
    const green = { ...population, bands: [population.bands[1]!] }
    const stage = referenceStage(green, {
      // The true medium is not compared here, and is solved at a stream
      // count that costs seconds.
      streams: { truth: 32, scaled: SLAB_STREAMS.scaled },
      pairs,
      views: [0.4],
      azimuths: [45, 180],
    })
    for (const row of stage.rows) {
      const kept = committed(row.depth, row.sunMu, 0.4, row.azimuth, row.side)
      expect(Math.abs(row.scaled[0]! / kept.scaled[1] - 1)).toBeLessThan(
        FIVE_FIGURES,
      )
      expect(Math.abs(row.first[0]! / kept.first[1] - 1)).toBeLessThan(
        FIVE_FIGURES,
      )
    }
  }, 120_000)

  it('move under 0.5% between 64 and 128 streams, the renderer’s medium over the domain', () => {
    const green = { ...population, bands: [population.bands[1]!] }
    const stage = referenceStage(green, {
      streams: { truth: 32, scaled: 64 },
      pairs: pairs.slice(0, 2),
    })
    let worst = 0
    for (const row of stage.rows) {
      if (!row.domain) continue
      const kept = committed(
        row.depth,
        row.sunMu,
        row.viewMu,
        row.azimuth,
        row.side,
      )
      worst = Math.max(worst, Math.abs(row.scaled[0]! / kept.scaled[1] - 1))
    }
    // The scaled phase's delta-M share is 0.03 at 64 streams and 0.02 at
    // 128, so little of it is smoothed at either count.
    expect(worst).toBeLessThan(0.005)
  }, 120_000)
})

describe('the source tables’ cells, recomputed', () => {
  // One node as both layers is one chain of doublings a mode: a row of a
  // table across its suns, and across its slabs.

  it('are the three-term table’s half floats, under every sun, where the two depths are one node', () => {
    const node = Math.floor(SLAB_SOURCE.nodes / 2)
    const medium = sourceMedium(population, 'formula')
    const form = threeForms(medium.asymmetry ** 2).find(
      (item) => item.name === 'three-relative',
    )!
    const made = tabulate(medium, THREE_GRID, SLAB_STREAMS.scaled, [form], {
      rows: [node],
      columns: [node],
      bearings: MIDPOINT_BEARINGS,
    })
    const terms = made.tables.get(form.name)!
    for (let sun = 0; sun < SLAB_SOURCE.suns; sun += 1) {
      const cell = (sun * SLAB_SOURCE.nodes + node) * SLAB_SOURCE.nodes + node
      for (let term = 0; term < 3; term += 1)
        expect(halfDecimal(terms[cell * 4 + term]!)).toBe(
          SLAB_SOURCE.terms[cell * 3 + term],
        )
    }
  }, 120_000)

  it('are the view table’s texels, under every sun at every cosine of both hemispheres', () => {
    const { nodes, suns, cosines } = SLAB_VIEW_SOURCE
    const slabs = 2 * cosines.length
    const committed = halfFloatsFromBase64(
      SLAB_VIEW_SOURCE.texels,
      nodes * nodes * suns * slabs * 4,
      'the view table',
    )
    const node = Math.floor(nodes / 2)
    const form = viewForm({ name: 'views', blend: 'angle' })
    const made = tabulate(
      sourceMedium(population, 'moment'),
      VIEW_GRID,
      SLAB_STREAMS.scaled,
      [form],
      { rows: [node], columns: [node], bearings: VIEW_BEARINGS },
    )
    const texels = made.tables.get(form.name)!
    expect(texels).toHaveLength(committed.length)
    for (let slab = 0; slab < slabs; slab += 1)
      for (let sun = 0; sun < suns; sun += 1) {
        const cell = (((slab * suns + sun) * nodes + node) * nodes + node) * 4
        for (let channel = 0; channel < 4; channel += 1)
          expect(Math.f16round(texels[cell + channel]!)).toBe(
            committed[cell + channel],
          )
      }
  }, 120_000)
})

describe('the black-surface flux, recomputed', () => {
  it('is the oracle’s on the true medium at every depth, both suns', () => {
    const flux = blackSurfaceFlux(population)
    expect(flux).toHaveLength(SLAB_REFERENCE.flux.length)
    flux.forEach((value, at) =>
      expect(Math.abs(value / SLAB_REFERENCE.flux[at]! - 1)).toBeLessThan(
        FIVE_FIGURES,
      ),
    )
  }, 120_000)
})
