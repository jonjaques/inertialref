import { describe, expect, it } from 'vitest'
import {
  analyticCumulus,
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  type CumulusProbe,
  type CumulusReference,
  fixtureMedium,
  viewSun,
} from '@inertialref/rendering'
import {
  ANALYTIC,
  ANALYTIC_A_BIN,
  ANALYTIC_CASES,
  ANALYTIC_PIXELS,
  assemble,
  caseOf,
  depthImage,
  findCumulus,
  PROBES_A_BIN,
  probesOf,
  reduceCase,
  REFERENCE_PIXELS,
  REFERENCE_SAMPLES,
  referenceText,
  selectProbes,
  SUBJECTS,
  subjectFixture,
  traceCase,
} from './cumulusTables.ts'

const MEDIUM = fixtureMedium(analyticCumulus(ANALYTIC))
const DEPTHS = depthImage(MEDIUM, ANALYTIC_PIXELS)

describe('the pixels a case traces', () => {
  it.each(CUMULUS_VIEWS)(
    'are drawn inside their masks under the $id view',
    (view) => {
      const probes = selectProbes(DEPTHS, ANALYTIC_PIXELS, view, 4)
      const depthAt = (x: number, y: number): number =>
        DEPTHS[y * ANALYTIC_PIXELS + x]!
      const cloudy = [...DEPTHS].filter((depth) => depth >= 0.02)
      const deep = [...cloudy].sort((a, b) => a - b)[
        Math.floor(0.9 * (cloudy.length - 1))
      ]!
      const sun = viewSun(view)
      let middleX = 0
      let middleY = 0
      let weight = 0
      DEPTHS.forEach((depth, index) => {
        if (depth < 0.02) return
        weight += depth
        middleX += depth * (index % ANALYTIC_PIXELS)
        middleY += depth * Math.floor(index / ANALYTIC_PIXELS)
      })
      for (const { mask, bin, pixel, depth } of probes) {
        const [x, y] = pixel
        expect(depth).toBe(depthAt(x, y))
        if (mask === 'rim') {
          expect(depth).toBeGreaterThan((bin * 3) / 8)
          expect(depth).toBeLessThanOrEqual(((bin + 1) * 3) / 8)
          // Beside the silhouette: clear sky within four pixels.
          let clear = false
          for (let dy = -4; dy <= 4; dy += 1)
            for (let dx = -4; dx <= 4; dx += 1)
              if (depthAt(x + dx, y + dy) < 0.02) clear = true
          expect(clear).toBe(true)
        }
        if (mask === 'edge') {
          expect(depth).toBeGreaterThan((bin * 5) / 8)
          expect(depth).toBeLessThanOrEqual(((bin + 1) * 5) / 8)
          // On the side of the cloud's middle the sun is on.
          expect(
            (x - middleX / weight) * sun[0] - (y - middleY / weight) * sun[1],
          ).toBeGreaterThan(0)
        }
        if (mask === 'core') expect(depth).toBeGreaterThanOrEqual(deep)
        if (mask === 'base') expect(depth).toBeGreaterThanOrEqual(2)
      }
      for (const mask of ['rim', 'edge', 'core', 'base'] as const) {
        const held = probes.filter((probe) => probe.mask === mask)
        expect(held.length).toBeGreaterThan(0)
        for (let bin = 0; bin < 8; bin += 1)
          expect(
            held.filter((probe) => probe.bin === bin).length,
          ).toBeLessThanOrEqual(4)
      }
      // The draw is the seed's: the same pixels from the same image.
      expect(selectProbes(DEPTHS, ANALYTIC_PIXELS, view, 4)).toEqual(probes)
    },
  )

  it('are none where the image holds no cloud', () => {
    expect(selectProbes(new Float64Array(64), 8, CUMULUS_VIEWS[0]!, 4)).toEqual(
      [],
    )
  })
})

describe('a case’s curves', () => {
  const probe = (
    mask: CumulusProbe['mask'],
    bin: number,
    depth: number,
    radiance: number,
    error: number,
  ): CumulusProbe => ({
    case: 'c',
    mask,
    bin,
    pixel: [0, 0],
    depth,
    radiance: [radiance, 2 * radiance, 0],
    error: [error, 2 * error, 0],
  })

  it('are each bin’s mean over the core’s median, with the ratio’s error', () => {
    const { curves, medians } = reduceCase('c', [
      probe('core', 0, 9, 1, 0.1),
      probe('core', 0, 9, 3, 0.1),
      probe('core', 0, 9, 2, 0.1),
      probe('base', 0, 4, 0.5, 0.02),
      probe('rim', 2, 0.8, 4, 0.3),
      probe('rim', 2, 1.0, 6, 0.4),
      probe('rim', 5, 2.0, 1, 0.1),
      probe('edge', 0, 0.3, 2, 0.2),
      // Another case's pixel, which this case's curves do not read.
      { ...probe('rim', 2, 0.9, 100, 1), case: 'other' },
    ])
    expect(medians.core[0]).toBe(2)
    expect(medians.base[0]).toBe(0.5)
    // The median's error: the mean's, √(0.03)/3, times √(π/2).
    const coreError = (Math.sqrt(Math.PI / 2) * Math.sqrt(0.03)) / 3
    expect(medians.coreError[0]).toBeCloseTo(coreError, 5)
    const rim = curves.find(
      (curve) => curve.mask === 'rim' && curve.band === 0,
    )!
    expect(rim.bins).toEqual([2, 5])
    expect(rim.depth).toEqual([0.9, 2])
    expect(rim.radiance).toEqual([2.5, 0.5])
    expect(rim.error[0]).toBeCloseTo(
      2.5 * Math.hypot(0.25 / 5, coreError / 2),
      5,
    )
    // The green band is twice the red everywhere, so its ratios are the red's.
    const green = curves.find(
      (curve) => curve.mask === 'rim' && curve.band === 1,
    )!
    expect(green.radiance).toEqual(rim.radiance)
    // A band with no light in its core has no curve to divide.
    expect(
      curves.find((curve) => curve.mask === 'rim' && curve.band === 2)!.bins,
    ).toEqual([])
    expect(curves).toHaveLength(6)
  })
})

describe('the analytic member', () => {
  const { analytic } = CUMULUS_REFERENCE

  it('is the generator’s own: its fixture, its four cases and its pixels', () => {
    expect(analytic.fixture).toEqual(ANALYTIC)
    expect(analytic.cases.map(({ id }) => id)).toEqual([
      'analytic:forward',
      'analytic:side',
      'analytic:back',
      'analytic:side:ground',
    ])
    for (const [index, spec] of analytic.cases.entries()) {
      const { view, ground } = ANALYTIC_CASES[index]!
      expect(spec).toEqual(
        caseOf('analytic', view, ANALYTIC_PIXELS, REFERENCE_SAMPLES, ground),
      )
      const drawn = selectProbes(DEPTHS, ANALYTIC_PIXELS, view, ANALYTIC_A_BIN)
      const held = analytic.probes.filter((probe) => probe.case === spec.id)
      expect(
        held.map(({ mask, bin, pixel }) => ({ mask, bin, pixel })),
      ).toEqual(drawn.map(({ mask, bin, pixel }) => ({ mask, bin, pixel })))
    }
  })

  it('is lit from below by its ground: the side view’s base is brighter over one', () => {
    const base = (id: string): number =>
      analytic.probes
        .filter((probe) => probe.case === id && probe.mask === 'base')
        .reduce((sum, probe) => sum + probe.radiance[1], 0)
    expect(base('analytic:side:ground')).toBeGreaterThan(
      1.1 * base('analytic:side'),
    )
  })

  it('is reproduced by tracing a pixel of each case again, to the file’s six figures', () => {
    for (const spec of analytic.cases) {
      const committed = analytic.probes.find(
        (probe) => probe.case === spec.id && probe.mask === 'rim',
      )!
      const [again] = probesOf(
        spec,
        traceCase(MEDIUM, spec, [committed], 0, spec.samples),
      )
      expect(again).toEqual(committed)
    }
  })

  it('holds every pixel to a few percent: the estimator’s error at 4,096 samples', () => {
    const relative = analytic.probes.flatMap((probe) =>
      probe.radiance.map((value, band) => probe.error[band]! / value),
    )
    expect(relative).toHaveLength(analytic.probes.length * 3)
    // Measured: 1.9% in the mean and 5.5% at worst.
    expect(
      relative.reduce((sum, value) => sum + value, 0) / relative.length,
    ).toBeLessThan(0.035)
    expect(Math.max(...relative)).toBeLessThan(0.08)
  })
})

describe('a case traced in parts', () => {
  const spec = caseOf('analytic', CUMULUS_VIEWS[1]!, ANALYTIC_PIXELS, 16)
  const pixels = selectProbes(DEPTHS, ANALYTIC_PIXELS, CUMULUS_VIEWS[1]!, 1)
  const subject = {
    id: 'analytic',
    regime: 'fair-cumulus',
    thickness: null,
    time: 0,
    place: {
      corner: { x: 1, y: 0, z: 0 },
      east: { x: 0, y: 0, z: -1 },
      north: { x: 0, y: 1, z: 0 },
      size: ANALYTIC.size,
      voxel: ANALYTIC.voxel,
      base: 0,
    },
  } as const
  const part = (from: number, to: number) => ({
    spec,
    subject,
    from,
    to,
    probes: traceCase(MEDIUM, spec, pixels, from, to),
  })
  const join = (parts: readonly ReturnType<typeof part>[]): CumulusReference =>
    assemble(parts, CUMULUS_REFERENCE.analytic, () => [
      { subject: 'analytic', index: 0, sigma: 1, radius: 10 },
    ])

  it('joins to the case traced whole, whatever the order of its files', () => {
    const whole = join([part(0, 16)])
    const parts = join([part(10, 16), part(0, 4), part(4, 10)])
    expect(parts.probes).toEqual(whole.probes)
    expect(parts.curves).toEqual(whole.curves)
    expect(parts.medians).toEqual(whole.medians)
    expect(whole.cases).toEqual([spec])
    expect(whole.subjects).toEqual([subject])
    expect(whole.voxels).toHaveLength(1)
    expect(whole.genusHash).toMatch(/^[0-9a-f]{32}$/)
    expect(whole.probes.every((probe) => probe.radiance[0] >= 0)).toBe(true)
  })

  it('refuses a case that is short of its samples, or holds some twice', () => {
    expect(() => join([part(0, 4), part(10, 16)])).toThrow(/4 to 10 missing/)
    expect(() => join([part(0, 10), part(4, 16)])).toThrow(/twice/)
    expect(() => join([part(0, 10)])).toThrow(/10 of its 16/)
  })

  it('traces a pixel drawn for two masks once, and reads it the same in both', () => {
    const twice = traceCase(
      MEDIUM,
      spec,
      [pixels[0]!, { ...pixels[0]!, mask: 'core', bin: 0 }],
      0,
      8,
    )
    expect(twice[1]!.sums).toBe(twice[0]!.sums)
  })
})

describe('the generated file', () => {
  it('is the committed reference’s own text, and holds nothing of the run that wrote it', () => {
    const text = referenceText(CUMULUS_REFERENCE)
    expect(referenceText(CUMULUS_REFERENCE)).toBe(text)
    const body = text.slice(text.indexOf('CumulusReference = ') + 19)
    expect(JSON.parse(body)).toEqual(CUMULUS_REFERENCE)
    const header = text.slice(0, text.indexOf('*/'))
    expect(header).toMatch(/Droplet table [0-9a-f]{32}/)
    expect(header).not.toMatch(/Apple|Node v|\d s\b|second/)
  })
})

describe('the subjects', () => {
  it('are a cumulus and a congestus on the design’s grid, at the design’s counts', () => {
    expect(SUBJECTS.map(({ id }) => id)).toEqual(['cumulus', 'congestus'])
    for (const { size, voxel } of SUBJECTS) {
      expect(size).toEqual([160, 96, 160])
      expect(voxel).toBe(20)
    }
    // Two masks of eight bins, the core and the base: 288 pixels a case.
    expect((2 * 8 + 2) * PROBES_A_BIN).toBe(288)
    expect(REFERENCE_PIXELS).toBe(256)
    expect(REFERENCE_SAMPLES).toBe(4096)
  })

  it('find one cloud of today’s field that stands clear of its grid', () => {
    // The search at a sixth of its resolution, which a test can afford: the
    // reference's own is 2.5 million evaluations of the field.
    const search = {
      ...SUBJECTS[0]!,
      size: [32, 20, 32] as const,
      voxel: 100,
      side: 9600,
      spacing: 150,
    }
    const subject = findCumulus(search)
    expect(findCumulus(search)).toEqual(subject)
    // On the voxel lattice, under the level's base by the margin.
    expect(subject.place.base % 100).toBe(0)
    expect(subject.place.corner.y % 100).toBe(0)
    const fixture = subjectFixture(subject)
    const cloudy = fixture.extinction.filter((value) => value > 0).length
    expect(cloudy).toBeGreaterThan(100)
    // Clear of every face: no cloudy voxel in the grid's outer shell.
    const [nx, ny, nz] = fixture.size
    fixture.extinction.forEach((value, index) => {
      const i = index % nx
      const k = Math.floor(index / nx) % nz
      const j = Math.floor(index / (nx * nz))
      const shell =
        i === 0 ||
        k === 0 ||
        j === 0 ||
        i === nx - 1 ||
        k === nz - 1 ||
        j === ny - 1
      if (shell) expect(value).toBe(0)
    })
  })
})
