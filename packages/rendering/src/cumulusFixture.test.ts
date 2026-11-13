import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  analyticCumulus,
  CUMULUS_DATUM,
  CUMULUS_FIELD_SUN,
  CUMULUS_VIEWS,
  cumulusAir,
  type CumulusFixture,
  cumulusFixture,
  cumulusSky,
  cumulusSkyHeight,
  cumulusSkyRadiance,
  cumulusSkyTable,
  type CumulusSubject,
  fixtureMedium,
  fixtureVoxel,
  genusHash,
  isolateCumulus,
  mediumAt,
  mediumDepth,
  movedVoxels,
  PHASE_CONE_NODE,
  PHASE_NODE,
  phaseConeReach,
  phaseDensity,
  phaseNodeAt,
  phaseRow,
  phaseSample,
  recordVoxels,
  subjectWeather,
  TRACE_BRICK,
  traceMedium,
  tracePhase,
  viewRay,
  viewSun,
} from './cumulusFixture.ts'
import { CUMULUS_REFERENCE } from './cumulusReference.generated.ts'
import {
  angleOf,
  diffractionShare,
  mieDroplets,
  radiusOf,
  samplePhase,
} from './mieTable.ts'
import { skyMomentsAt } from './skyIrradiance.ts'
import { cloudFieldAt } from './weatherField.ts'
import { levelProfile } from './weatherGenus.ts'

const TABLE = mieDroplets()
const PHASE = tracePhase(TABLE)

/** A cut of the fair-weather field at a corner `east` and `north` of the search's origin. */
const subjectAt = (east: number, north: number): CumulusSubject => {
  const draft: CumulusSubject = {
    id: 'test',
    regime: 'fair-cumulus',
    thickness: null,
    time: 0,
    place: {
      corner: { x: CUMULUS_DATUM, y: north, z: -east },
      east: { x: 0, y: 0, z: -1 },
      north: { x: 0, y: 1, z: 0 },
      size: [24, 16, 24],
      voxel: 100,
      base: 0,
    },
  }
  // A voxel under the level's base, whatever a calibration makes the base.
  const base = subjectWeather(draft).weather.levels[0].base - 100
  return { ...draft, place: { ...draft.place, base } }
}

/**
 * A cut of today's field, coarse enough to build in a test, at the place of
 * a 19 km square that holds the most cloud. The place is searched for and
 * not written down: the field's recipe moves, and a place written down held
 * 2,000 cloudy voxels under one recipe and 51 under the next.
 */
const SUBJECT: CumulusSubject = (() => {
  let best = subjectAt(0, 0)
  let most = -1
  for (let e = 0; e < 8; e += 1)
    for (let n = 0; n < 8; n += 1) {
      const subject = subjectAt(e * 2400, n * 2400)
      const { weather, clock } = subjectWeather(subject)
      const [nx, ny, nz] = subject.place.size
      let cloudy = 0
      // Every fourth voxel a side: 144 reads a candidate.
      for (let j = 1; j < ny; j += 4)
        for (let k = 1; k < nz; k += 4)
          for (let i = 1; i < nx; i += 4)
            if (
              fixtureVoxel(
                weather,
                clock,
                CUMULUS_FIELD_SUN,
                subject.place,
                (j * nz + k) * nx + i,
              ).sigma > 0
            )
              cloudy += 1
      if (cloudy > most) {
        most = cloudy
        best = subject
      }
    }
  return best
})()

const fieldFixture = (subject: CumulusSubject): CumulusFixture => {
  const { weather, clock } = subjectWeather(subject)
  return cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, subject.place)
}

describe('the fixture', () => {
  const fixture = fieldFixture(SUBJECT)
  const { weather, clock } = subjectWeather(SUBJECT)

  it('holds the field at every voxel’s center, laid out [up][north][east]', () => {
    const [nx, , nz] = SUBJECT.place.size
    const { voxel, base } = SUBJECT.place
    for (const [i, j, k] of [
      [0, 0, 0],
      [5, 9, 17],
      [23, 15, 23],
      [12, 6, 3],
      [7, 11, 20],
    ] as const) {
      const index = (j * nz + k) * nx + i
      // East is −z and north is +y at this place; up is the corner's own
      // direction, 0.08° off +x, as the fixture lays its heights.
      const { corner } = SUBJECT.place
      const length = Math.hypot(corner.x, corner.y, corner.z)
      const h = base + (j + 0.5) * voxel
      const at = cloudFieldAt(
        weather,
        clock,
        CUMULUS_FIELD_SUN,
        {
          x: corner.x + (corner.x / length) * h,
          y: corner.y + (k + 0.5) * voxel + (corner.y / length) * h,
          z: corner.z - (i + 0.5) * voxel + (corner.z / length) * h,
        },
        // The resolved field: no footprint, whatever the voxel's size.
        0,
      )
      expect(fixture.sigma[index]).toBe(Math.fround(at.sigma * at.fraction))
      expect(fixture.radius[index]).toBe(Math.fround(at.radius))
    }
    // Not a grid of clear air, which every layout would pass.
    expect(fixture.sigma.filter((value) => value > 0).length).toBeGreaterThan(
      200,
    )
  })

  it('unscales by the level’s own ratio: the true extinction is σ′ over one less the diffraction’s share', () => {
    const profile = levelProfile(weather.levels[0])
    const ratio = profile.sigma / profile.scaled
    // Q_ext is 2.04 to 2.27 on the table, so the ratio is 1.79 to 1.96.
    expect(ratio).toBeGreaterThan(1.78)
    expect(ratio).toBeLessThan(1.97)
    // To float32's rounding of each of the two arrays.
    fixture.sigma.forEach((sigma, index) => {
      expect(
        Math.abs(fixture.extinction[index]! - sigma * ratio),
      ).toBeLessThanOrEqual(2e-7 * sigma * ratio)
    })
    const index = fixture.sigma.findIndex((value) => value > 0)
    expect(
      fixtureVoxel(weather, clock, CUMULUS_FIELD_SUN, SUBJECT.place, index)
        .extinction,
    ).toBeCloseTo(fixture.extinction[index]!, 9)
  })

  it('keeps the cloud that stands clear over a larger one a face cuts, and says when every cloud is cut', () => {
    const size = [9, 5, 9] as const
    const count = size[0] * size[1] * size[2]
    const at = (i: number, j: number, k: number): number =>
      (j * size[2] + k) * size[0] + i
    const corner = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const
    const extinction = new Float32Array(count)
    // Three voxels in the middle, two of one in a far part of it, and five
    // in a corner, which three faces cut.
    for (const [i, j, k] of [
      [4, 2, 4],
      [5, 2, 4],
      [4, 3, 4],
      [7, 2, 7],
      [7, 3, 7],
      ...corner,
    ] as const)
      extinction[at(i, j, k)] = 0.01
    const three: CumulusFixture = {
      size,
      voxel: 20,
      base: 0,
      sigma: extinction.map((value) => value / 2),
      radius: new Float32Array(count).fill(10),
      extinction,
    }
    const clear = isolateCumulus(three)
    expect(clear.voxels).toBe(3)
    expect(clear.touches).toBe(false)
    expect(clear.fixture.extinction[at(0, 0, 0)]).toBe(0)
    expect(clear.fixture.sigma[at(1, 0, 0)]).toBe(0)
    expect(clear.fixture.extinction[at(7, 2, 7)]).toBe(0)
    expect(clear.fixture.extinction[at(5, 2, 4)]).toBeGreaterThan(0)
    expect(clear.fixture.extinction.filter((value) => value > 0)).toHaveLength(
      3,
    )
    // With only the corner's cloud there is none that stands clear.
    const cut = isolateCumulus({
      ...three,
      extinction: extinction.map((value, index) =>
        corner.some(([i, j, k]) => index === at(i, j, k)) ? value : 0,
      ),
    })
    expect(cut.voxels).toBe(5)
    expect(cut.touches).toBe(true)
    // And a grid of clear air holds no cloud to cut.
    const none = isolateCumulus({
      ...three,
      extinction: new Float32Array(count),
    })
    expect(none.voxels).toBe(0)
    expect(none.touches).toBe(false)
  })

  it('cuts an analytic cumulus that stands clear of its grid, scaled voxel by voxel', () => {
    const analytic = analyticCumulus({
      size: [40, 32, 40],
      voxel: 50,
      sigma: 0.012,
    })
    const whole = isolateCumulus(analytic)
    expect(whole.touches).toBe(false)
    // One body: masking its neighbors off removes nothing.
    expect(whole.voxels).toBe(
      analytic.extinction.filter((value) => value > 0).length,
    )
    expect(Math.max(...analytic.extinction)).toBeLessThanOrEqual(0.012)
    expect(Math.max(...analytic.extinction)).toBeGreaterThan(0.01)
    analytic.extinction.forEach((extinction, index) => {
      expect(analytic.sigma[index]).toBeCloseTo(
        extinction * (1 - diffractionShare(TABLE, analytic.radius[index]!)),
        9,
      )
    })
  })
})

describe('the medium a tracer reads', () => {
  const analytic = analyticCumulus({
    size: [20, 16, 20],
    voxel: 100,
    sigma: 0.02,
  })
  const medium = fixtureMedium(analytic)
  const out = new Float64Array(2)

  it('returns a voxel at its center and nothing a voxel outside the grid', () => {
    const [nx, , nz] = analytic.size
    for (const [i, j, k] of [
      [10, 8, 10],
      [7, 6, 9],
      [12, 10, 8],
    ] as const) {
      const index = (j * nz + k) * nx + i
      mediumAt(medium, i + 1, j + 1, k + 1, out)
      expect(out[0]).toBeCloseTo(analytic.extinction[index]!, 12)
      if (out[0]! > 0) expect(out[1]).toBeCloseTo(analytic.radius[index]!, 9)
    }
    mediumAt(medium, -0.5, 8, 8, out)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
  })

  it('weighs the radius by what scatters: a clear neighbor has no say', () => {
    const two = traceMedium(
      [2, 1, 1],
      [10, 10, 10],
      new Float32Array([0.02, 0]),
      new Float32Array([8, 30]),
    )
    mediumAt(two, 1.5, 1, 1, out)
    expect(out[0]).toBeCloseTo(Math.fround(0.02) / 2, 12)
    expect(out[1]).toBeCloseTo(8, 12)
  })

  it('bounds every point of a brick, and the points a nudge past its faces (property)', () => {
    const high = medium.bricks.map((b) => b * TRACE_BRICK)
    const coordinate = (axis: number) =>
      fc.double({ min: 0, max: high[axis]! - 1e-9, noNaN: true })
    fc.assert(
      fc.property(
        coordinate(0),
        coordinate(1),
        coordinate(2),
        fc.constantFrom(-1e-3, 0, 1e-3),
        (qx, qy, qz, nudge) => {
          const brick = [qx, qy, qz].map((q, axis) =>
            Math.min(
              medium.bricks[axis]! - 1,
              Math.max(0, Math.floor((q + nudge) / TRACE_BRICK)),
            ),
          )
          const bound =
            medium.majorant[
              (brick[1]! * medium.bricks[2] + brick[2]!) * medium.bricks[0] +
                brick[0]!
            ]!
          mediumAt(medium, qx, qy, qz, out)
          expect(out[0]).toBeLessThanOrEqual(bound)
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('integrates a uniform block to its depth, the half-voxel ramps included', () => {
    const block = traceMedium(
      [4, 4, 4],
      [50, 25, 50],
      new Float32Array(64).fill(0.02),
      new Float32Array(64).fill(10),
    )
    // Straight up through the middle: four voxels of 25 m at 0.02.
    expect(mediumDepth(block, [100, -500, 100], [0, 1, 0])).toBeCloseTo(2, 6)
    // A ray that misses the grid crosses nothing.
    expect(mediumDepth(block, [-500, -500, 100], [0, 1, 0])).toBe(0)
  })
})

describe('the phase a tracer samples', () => {
  const rows = [0, 11, 18, 31]

  it('is a density: every row and band integrates to one by its own rule', () => {
    const half = PHASE.angles / 2
    for (const row of rows)
      for (let band = 0; band < 3; band += 1) {
        const at = phaseNodeAt(PHASE, row, band)
        const node = (i: number, c: number): number =>
          PHASE.nodes[at + i * PHASE_NODE + c]!
        let total = 0
        for (let i = 0; i + 1 < PHASE.angles; i += 1) {
          const width =
            i + 1 < half
              ? node(i + 1, 2) - node(i, 2)
              : (i < half ? 2 - node(i, 2) : node(i, 2)) - node(i + 1, 2)
          expect(width).toBeGreaterThan(0)
          const piece = Math.PI * (node(i, 0) + node(i + 1, 0)) * width
          // The cumulative share steps by each interval's own.
          expect(node(i + 1, 1) - node(i, 1)).toBeCloseTo(piece, 12)
          total += piece
        }
        expect(total).toBeCloseTo(1, 12)
        expect(node(0, 1)).toBe(0)
        expect(node(PHASE.angles - 1, 1)).toBe(1)
      }
  })

  it('keeps each node’s distance from the nearer end of the cosine', () => {
    for (const i of [0, 1, 200, 511, 512, 900, 1023]) {
      const theta = angleOf(TABLE, i)
      const expected = i < 512 ? 1 - Math.cos(theta) : 1 + Math.cos(theta)
      const held = PHASE.nodes[i * PHASE_NODE + 2]!
      // At the first node the cosine is 3 × 10⁻¹¹ from one, which the
      // half-angle form holds and `1 − cos` in float64 holds to five figures.
      expect(Math.abs(held - expected)).toBeLessThan(1e-5 * held + 1e-16)
    }
    expect(PHASE.nodes[PHASE_NODE + 2]).toBeGreaterThan(0)
    expect(PHASE.nodes[PHASE_NODE + 2]).toBeLessThan(1e-10)
  })

  it('is the table’s own read within a percent, between its nodes', () => {
    let worst = 0
    for (const row of rows)
      for (let band = 0; band < 3; band += 1)
        for (let k = 0; k < 500; k += 1) {
          const theta = (Math.PI * (k + 0.37)) / 500
          const own = phaseDensity(
            PHASE,
            phaseNodeAt(PHASE, row, band),
            2 * Math.sin(theta / 2) ** 2,
            2 * Math.cos(theta / 2) ** 2,
          )
          const table = samplePhase(
            TABLE,
            Math.cos(theta),
            radiusOf(TABLE, row),
          )[band]!
          worst = Math.max(worst, Math.abs(own / table - 1))
        }
    // Linear in the cosine against linear in the index, and one
    // normalization against another: measured at 0.5%.
    expect(worst).toBeLessThan(0.01)
  })

  it('draws from exactly the density it evaluates (property)', () => {
    const drawn = new Float64Array(3)
    fc.assert(
      fc.property(
        fc.constantFrom(...rows),
        fc.integer({ min: 0, max: 2 }),
        fc.double({ min: 0, max: 1 - 2 ** -32, noNaN: true }),
        (row, band, u) => {
          const at = phaseNodeAt(PHASE, row, band)
          phaseSample(PHASE, at, u, drawn)
          const [m, s, density] = drawn as unknown as [number, number, number]
          expect(m).toBeGreaterThanOrEqual(0)
          expect(m + s).toBeCloseTo(2, 12)
          // The density the draw reports is the one the evaluation finds
          // at the drawn angle, which is what gives a walk a weight of one.
          expect(phaseDensity(PHASE, at, m, s)).toBeCloseTo(
            density,
            9 - Math.log10(Math.max(1, density)),
          )
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('inverts the cumulative share: equal steps of u fill each interval by its share', () => {
    const at = phaseNodeAt(PHASE, 18, 1)
    const drawn = new Float64Array(3)
    const steps = 200_000
    // Angles' bounds, as nodes, and the draws that fall between each pair.
    const bounds = [0, 40, 150, 400, 512, 700, 1000, 1023]
    const counts = new Array<number>(bounds.length - 1).fill(0)
    const forward = (i: number): number =>
      i < 512
        ? PHASE.nodes[at + i * PHASE_NODE + 2]!
        : 2 - PHASE.nodes[at + i * PHASE_NODE + 2]!
    for (let k = 0; k < steps; k += 1) {
      phaseSample(PHASE, at, (k + 0.5) / steps, drawn)
      const bin = bounds.findIndex(
        (bound, index) => index > 0 && drawn[0]! <= forward(bound),
      )
      counts[bin - 1]! += 1
    }
    counts.forEach((count, index) => {
      const share =
        PHASE.nodes[at + bounds[index + 1]! * PHASE_NODE + 1]! -
        PHASE.nodes[at + bounds[index]! * PHASE_NODE + 1]!
      // A stratified u misplaces at most one draw at each bound.
      expect(Math.abs(count / steps - share)).toBeLessThanOrEqual(2 / steps)
    })
  })

  it('blends two rows by the table’s own share, and ends its cone on a node', () => {
    expect(phaseRow(PHASE, radiusOf(TABLE, 18))[0]).toBe(18)
    expect(phaseRow(PHASE, radiusOf(TABLE, 18))[1]).toBeCloseTo(0, 9)
    const [row, share] = phaseRow(
      PHASE,
      Math.sqrt(radiusOf(TABLE, 7) * radiusOf(TABLE, 8)),
    )
    expect(row).toBe(7)
    expect(share).toBeCloseTo(0.5, 9)
    expect(phaseRow(PHASE, 1)).toEqual([0, 0])
    expect(phaseRow(PHASE, 100)).toEqual([PHASE.rows - 2, 1])
    expect(phaseConeReach(PHASE)).toBeCloseTo(
      1 - Math.cos(angleOf(TABLE, PHASE_CONE_NODE)),
      12,
    )
    // The sun's disk is inside the cone, with room to spare.
    expect(angleOf(TABLE, PHASE_CONE_NODE)).toBeGreaterThan((5 * Math.PI) / 180)
  })
})

describe('the views', () => {
  it('place the sun at the rubric’s three angles from the eye’s line', () => {
    expect(CUMULUS_VIEWS.map((view) => view.angle)).toEqual([15, 90, 165])
    for (const view of CUMULUS_VIEWS) {
      const sun = viewSun(view)
      expect(Math.hypot(...sun)).toBeCloseTo(1, 12)
      // The eye looks north, along +z.
      expect((Math.acos(sun[2]) * 180) / Math.PI).toBeCloseTo(view.angle, 9)
      expect(sun[1]).toBeGreaterThan(0)
    }
  })

  it('start a pixel’s ray south of the grid, through the pixel’s center', () => {
    const medium = traceMedium(
      [8, 4, 8],
      [50, 50, 50],
      new Float32Array(256),
      new Float32Array(256),
    )
    // The image is as wide as the grid's longer side: 400 m over 4 pixels.
    expect(viewRay(medium, 4, 0, 0)).toEqual([50, 250, -50])
    expect(viewRay(medium, 4, 3, 3)).toEqual([350, -50, -50])
  })
})

describe('a reference and the field it was traced through', () => {
  const recorded = recordVoxels(fieldFixture(SUBJECT), 200)

  it('records cloudy voxels by a seed, the same ones every time', () => {
    expect(recorded).toHaveLength(200)
    expect(recorded.every(({ sigma }) => sigma > 0)).toBe(true)
    expect(recordVoxels(fieldFixture(SUBJECT), 200)).toEqual(recorded)
    expect(new Set(recorded.map(({ index }) => index)).size).toBe(200)
  })

  it('finds no voxel moved while the field stands, and most of them once it drifts', () => {
    expect(movedVoxels(SUBJECT, recorded)).toEqual([])
    // An hour of the regime's 8 m/s wind carries the cloud 29 km off.
    const later = movedVoxels({ ...SUBJECT, time: 3600 }, recorded)
    expect(later.length).toBeGreaterThan(100)
    // And a layer of another thickness is another profile at every height.
    const [low] = subjectWeather(SUBJECT).weather.levels
    const thicker = movedVoxels(
      { ...SUBJECT, thickness: low.top - low.base + 300 },
      recorded,
    )
    expect(thicker.length).toBeGreaterThan(100)
  })

  it('hashes the genus table to 32 hex digits', () => {
    expect(genusHash()).toMatch(/^[0-9a-f]{32}$/)
    expect(genusHash()).toBe(genusHash())
  })

  it(
    'holds the committed reference to today’s field and today’s genus table',
    { timeout: 30_000 },
    () => {
      // With no subject the reference claims nothing of the field, and its
      // hash is empty. With one, every voxel it carries is still the field's.
      if (CUMULUS_REFERENCE.subjects.length === 0) {
        expect(CUMULUS_REFERENCE.genusHash).toBe('')
        expect(CUMULUS_REFERENCE.voxels).toEqual([])
        expect(CUMULUS_REFERENCE.cases).toEqual([])
        return
      }
      expect(CUMULUS_REFERENCE.genusHash).toBe(genusHash())
      for (const subject of CUMULUS_REFERENCE.subjects) {
        const voxels = CUMULUS_REFERENCE.voxels.filter(
          (voxel) => voxel.subject === subject.id,
        )
        expect(voxels.length).toBeGreaterThanOrEqual(100)
        expect(movedVoxels(subject, voxels)).toEqual([])
      }
      // And a reference whose subjects are nudged is caught: a voxel to the
      // east is another place of the cloud.
      const [first] = CUMULUS_REFERENCE.subjects
      const { corner, voxel } = first!.place
      const nudged = {
        ...first!,
        place: { ...first!.place, corner: { ...corner, z: corner.z - voxel } },
      }
      expect(
        movedVoxels(
          nudged,
          CUMULUS_REFERENCE.voxels.filter(
            ({ subject }) => subject === first!.id,
          ),
        ).length,
      ).toBeGreaterThan(100)
    },
  )
})

describe('the sky a case of the field stands under', () => {
  it('is Earth’s air as the scene hands it to the bake', () => {
    const { haze, topRatio, heights } = cumulusAir()
    // 100 km of haze over 6,378 km, an 8.5 km gas and a 1.2 km aerosol.
    expect(topRatio).toBeCloseTo(1 + 100_000 / 6_378_137, 12)
    expect(heights.rayleigh).toBeCloseTo(8_500 / 6_378_137, 12)
    expect(heights.aerosol).toBeCloseTo(1_200 / 6_378_137, 12)
    expect(haze.thickness).toBe(1)
    expect(cumulusSkyHeight(50_000)).toBeCloseTo(0.5, 12)
    expect(cumulusSkyHeight(-10)).toBe(0)
  })

  it('is the table’s own read at a height and a view’s sun', () => {
    for (const view of CUMULUS_VIEWS) {
      const { sky, at } = cumulusSky(view, 1700)
      expect(at).toEqual({ height: 1700, sunMu: viewSun(view)[1] })
      expect(sky).toEqual(
        skyMomentsAt(cumulusSkyTable(), cumulusSkyHeight(1700), at.sunMu),
      )
      for (let band = 0; band < 3; band += 1) {
        expect(sky.mean[band]).toBeGreaterThan(0.005)
        expect(sky.mean[band]).toBeLessThan(0.1)
      }
      // The blue sky is the brightest, and at a low sun the sunward side
      // is the brighter one.
      expect(sky.mean[2]).toBeGreaterThan(sky.mean[0])
      expect(sky.sunward[1]).toBeGreaterThan(0)
    }
    // One table, baked once.
    expect(cumulusSkyTable()).toBe(cumulusSkyTable())
  })

  it('is linear in direction with the three moments, floored at nothing', () => {
    const sky = {
      mean: [2, 2, 2],
      up: [0.8, 0.8, 0.8],
      sunward: [-0.4, -0.4, -0.4],
    } as const
    const sun = [0.6, 0.5, Math.sqrt(1 - 0.61)] as const
    let mean = 0
    let up = 0
    let sunward = 0
    const directions = 20_000
    const golden = Math.PI * (3 - Math.sqrt(5))
    const flat = Math.hypot(sun[0], sun[2])
    for (let i = 0; i < directions; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / directions
      const r = Math.sqrt(1 - y * y)
      const d = [r * Math.cos(golden * i), y, r * Math.sin(golden * i)] as const
      const [value] = cumulusSkyRadiance(sky, sun, d)
      mean += value / directions
      // The irradiance on a face from its front less that from its back is
      // the integral of L·(ω·n) over the sphere.
      up += (value * d[1] * 4 * Math.PI) / directions
      sunward +=
        (value * ((d[0] * sun[0] + d[2] * sun[2]) / flat) * 4 * Math.PI) /
        directions
    }
    expect(mean).toBeCloseTo(2, 3)
    expect(up / (Math.PI * 2)).toBeCloseTo(0.8, 3)
    expect(sunward / (Math.PI * 2)).toBeCloseTo(-0.4, 3)
    // Where the form falls under zero there is no light, not a negative one.
    expect(
      cumulusSkyRadiance(
        { mean: [1, 1, 1], up: [0, 0, 0], sunward: [2, 2, 2] },
        [1, 0, 0],
        [-1, 0, 0],
      ),
    ).toEqual([0, 0, 0])
  })

  it('is held alone on the scaled medium, a row a scaled row, inside the sky’s own bounds and the row’s rest', () => {
    const { cases, scaled, scaledSky } = CUMULUS_REFERENCE
    expect(scaledSky).toHaveLength(scaled.length)
    let under = 0
    scaledSky.forEach((row, index) => {
      const beside = scaled[index]!
      expect(row.case).toBe(beside.case)
      expect(row.pixel).toEqual(beside.pixel)
      const { sky } = cases.find(({ id }) => id === row.case)!
      for (let b = 0; b < 3; b += 1) {
        // Every path ends on the sky, so a pixel is a mean of its radiances:
        // none is over the brightest direction, 1 + ¾·|(up, sunward)| of
        // the mean, and none is negative.
        expect(row.sky[b]).toBeGreaterThanOrEqual(0)
        expect(row.sky[b]).toBeLessThanOrEqual(
          sky.mean[b]! * (1 + 0.75 * Math.hypot(sky.up[b]!, sky.sunward[b]!)),
        )
        // What is left of `rest` is the sun's light past its first order,
        // which is not negative: held at five of the two errors together.
        // Measured, the lowest is 1.34 under and 6 of 5,106 are under at all.
        const left = beside.rest[b]! - row.sky[b]!
        expect(left).toBeGreaterThan(
          -5 * Math.hypot(beside.restError[b]!, row.skyError[b]!),
        )
        if (left < 0) under += 1
      }
    })
    expect(under).toBeLessThan(0.01 * 3 * scaledSky.length + 1)
  })
})
