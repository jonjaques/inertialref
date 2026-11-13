import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { length, uniform } from 'three/tsl'
import {
  iceAggregate,
  mieDroplets,
  PHASE_ATLAS,
  SLAB_REFERENCE,
  type SlabReferenceRow,
} from '@inertialref/rendering'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import {
  marchProbe,
  placeBody,
  placeSun,
  type ProbeOptions,
  type ProbeRay,
  type Triple,
} from './cloudMarchRig.ts'
import {
  CLOUD_STAND_INS,
  type CloudSample,
  type CloudSunDepthNodes,
  type CloudSunFn,
  exactSlabSun,
  slabMedium,
} from './cloudNodes.ts'
import { CloudPhase } from './cloudPhase.ts'
import {
  CLOUD_SUN_FACTORS,
  type CloudSource,
  createCloudSource,
} from './cloudSource.ts'
import { cloudSunFn } from './cloudSunlight.ts'
import { CLOUD_TRANSPORTS } from './cloudLevers.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The slab gate (rubric rows 1 and 2): a plane slab's leaving radiance and
 * its reflected flux through the shipped step, against the adding-doubling
 * oracle's solution of the renderer's own scaled medium (`SLAB_REFERENCE`).
 *
 * Both rows are declared: the source table's own reconstruction is 5.75%
 * at worst on the domain and 1.97% in the flux, in Node, at 224 Gauss
 * points a ray. So each is a ceiling at the figure measured here, and a
 * figure near the table's is the form's and not the march's.
 *
 * A ray is the mean of eight, their first steps shortened by eight evenly
 * spaced shares, as a held still's frames are. The slab is a kilometer
 * thick on a body of Earth's radius, and the eye stands a meter outside
 * the face it looks at, so the sphere bends a 5 km slant by 0.05°.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(8, 8)
})

afterAll(() => {
  gpu.dispose()
})

const BASE = 1000
/** A kilometer of slab, unless a rig asks for another thickness. */
const THICKNESS = 1000
const JITTERS = 8
/** The sun's angular radius the reference's first order is read through: 959.63″. */
const SUN_RADIUS = (959.63 / 3600) * (Math.PI / 180)
const BANDS = [0, 1, 2] as const

/** The view from the eye whose light leaves a face at `mu` to its normal, `azimuth` degrees from the sun's light's bearing. */
function viewOf(
  side: SlabReferenceRow['side'],
  mu: number,
  azimuth: number,
): Triple {
  const sine = Math.sqrt(1 - mu * mu)
  const phi = (azimuth * Math.PI) / 180
  // The sun stands toward +X, so its light travels toward −X: light to
  // the eye at an azimuth of zero travels that way too, and the eye looks
  // back along it.
  return [
    sine * Math.cos(phi),
    side === 'reflected' ? -mu : mu,
    -sine * Math.sin(phi),
  ]
}

/** The scattering angle of a view, degrees: between the sun's light and the light to the eye. */
function scatteringAngle(sunMu: number, view: Triple): number {
  const sun: Triple = [Math.sqrt(1 - sunMu * sunMu), sunMu, 0]
  const cosine = sun[0] * view[0] + sun[1] * view[1] + sun[2] * view[2]
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}

interface Rig {
  readonly uniforms: CloudUniforms
  readonly source: CloudSource
  /** Place a slab of an unscaled depth at a radius under a sun, seen from a side. */
  place(
    radius: number,
    depth: number,
    sunMu: number,
    side: SlabReferenceRow['side'],
  ): void
  /** The level's cumuliform share, which the factor of the sun is blended by. */
  share(convective: number): void
  /** Each view's light, the mean of its jitters. */
  light(views: readonly Triple[]): Promise<Triple[]>
  dispose(): void
}

/**
 * A march over one slab whose extinction and radius are uniforms, so one
 * kernel draws every slab of the domain.
 */
async function rig(options: {
  /** The shipped sun, its taps over a cache that holds the slab's own depths; or the slab's exact sun. */
  readonly sun: 'shipped' | 'exact'
  /** The committed phase through the reference's sun, or none: the light after first order alone. */
  readonly phase: boolean
  readonly march?: ProbeOptions['march']
  /** Meters. A thin slab is flat under a grazing sun, whose ray through a kilometer of it climbs 28 m of the sphere. */
  readonly thickness?: number
}): Promise<Rig> {
  const TOP = BASE + (options.thickness ?? THICKNESS)
  const uniforms = createCloudUniforms()
  const body = uniforms.served
  const sigma = uniform(0)
  const radius = uniform(10)
  const slab = { base: BASE, top: TOP, sigma, radius }
  const exact = exactSlabSun([slab])
  const source = createCloudSource()
  await source.load()
  const droplets = mieDroplets()
  const phase = new CloudPhase(droplets, iceAggregate())
  phase.serve(SUN_RADIUS, null)
  await phase.warm(gpu.renderer)
  const shipped = (field: Parameters<typeof cloudSunFn>[0]['medium']) => {
    const sampleAt = (offset: CloudSample['offset']): CloudSample => ({
      offset,
      distance: length(offset),
      altitude: altitudeAt(body, offset),
      sunMu: sunMuAt(body, offset),
      footprint: uniform(0),
    })
    // The slab's own depths, as a cache that held them exactly would.
    const cache: CloudSunDepthNodes = {
      depths(offset) {
        const at = sampleAt(offset)
        const depth = exact(at, field(at, body), body).depth
        return {
          toSun: depth.x,
          whole: depth.y,
          weight: uniform(1),
          behind: uniform(1),
        }
      },
    }
    return cloudSunFn({ uniforms, medium: field, depth: cache })
  }
  const sun: (field: Parameters<typeof shipped>[0]) => CloudSunFn =
    options.sun === 'shipped' ? shipped : () => exact
  const probe = marchProbe(gpu, uniforms, slabMedium([slab]), {
    sun,
    phase: options.phase ? phase : CLOUD_STAND_INS.phase(0),
    // A sky of nothing, read from its table: the placeholder's Ψ is one
    // on the rig's stand-in tables, and would light every slab alike.
    light: { source, sky: CLOUD_STAND_INS.sky(0) },
    march: { ...options.march, skyTable: true },
  })
  return {
    uniforms,
    source,
    place(r, depth, sunMu, side) {
      placeBody(uniforms, {
        eye: side === 'reflected' ? TOP + 1 : BASE - 1,
        layers: [[BASE, TOP]],
      })
      placeSun(uniforms, sunMu)
      const media = SLAB_REFERENCE.media.find((item) => item.radius === r)!
      // The renderer's medium: the depth with the diffraction out of it.
      const scaled = ((1 - media.share) * depth) / (TOP - BASE)
      sigma.value = scaled
      radius.value = r
      const { layers } = body
      layers.sigma.value.set(scaled, scaled, scaled)
      layers.radius.value.set(r, r, r)
      layers.radiusMin.value.set(r, r, r)
      layers.radiusMax.value.set(r, r, r)
      layers.phaseRow.value.set(PHASE_ATLAS.dropletRow, 0, 0)
      layers.phaseRows.value.set(droplets.radii, droplets.radii, droplets.radii)
      layers.phaseRadius.value.set(
        droplets.radiusMin,
        droplets.radiusMin,
        droplets.radiusMin,
      )
      uniforms.trace.lightTaps.value = 4
    },
    share(convective) {
      const { l, a } = CLOUD_SUN_FACTORS.cumulus!
      source.levels.factor.value.set(l, l, l)
      source.levels.slope.value.set(a, a, a)
      body.climate.convective.value.set(convective, convective, convective)
    },
    async light(views) {
      const rays: ProbeRay[] = views.flatMap((direction) =>
        Array.from({ length: JITTERS }, (_, k) => ({
          direction,
          jitter: (k + 0.5) / JITTERS,
        })),
      )
      const sums: Triple[] = []
      for (let from = 0; from < rays.length; from += 64) {
        const probed = await probe(rays.slice(from, from + 64))
        probed.forEach(({ light }, i) => {
          const view = Math.floor((from + i) / JITTERS)
          const sum = sums[view] ?? [0, 0, 0]
          sums[view] = [
            sum[0] + light[0] / JITTERS,
            sum[1] + light[1] / JITTERS,
            sum[2] + light[2] / JITTERS,
          ]
        })
      }
      return sums
    },
    dispose() {
      phase.dispose()
      source.dispose()
      uniforms.dispose()
    },
  }
}

/** The reference's rows by slab: a radius, a depth, a sun and a side. */
function slabs(): Map<string, SlabReferenceRow[]> {
  const bySlab = new Map<string, SlabReferenceRow[]>()
  for (const row of SLAB_REFERENCE.rows) {
    const key = `${row.radius}|${row.depth}|${row.sunMu}|${row.side}`
    const rows = bySlab.get(key) ?? []
    rows.push(row)
    bySlab.set(key, rows)
  }
  return bySlab
}

interface Judged {
  /** The worst relative error on the domain's grid and held-out slabs, and where. */
  worst: number
  at: string
  /** Root mean square and the count over 5%, on the same. */
  rms: number
  over: number
  count: number
  /** The worst on the thin slabs, which no row turns on. */
  thin: number
}

/**
 * A rig's radiance against the oracle's on every row of the domain.
 * `whole` compares the march's whole light; otherwise the march's light is
 * the light after first order, and the oracle's own first order stands
 * beside it, which is how the table's header figure was taken.
 */
async function judge(
  held: Rig,
  maxSteps: number,
  whole: boolean,
): Promise<Judged> {
  const out: Judged = { worst: 0, at: '', rms: 0, over: 0, count: 0, thin: 0 }
  let squares = 0
  for (const rows of slabs().values()) {
    const { radius, depth, sunMu, side, set } = rows[0]!
    held.place(radius, depth, sunMu, side)
    held.uniforms.trace.maxSteps.value = maxSteps
    const views = rows.map((row) => viewOf(side, row.viewMu, row.azimuth))
    // The convention is the reference's own, held by its angle a row.
    rows.forEach((row, i) => {
      expect(
        Math.abs(scatteringAngle(sunMu, views[i]!) - row.angle),
      ).toBeLessThan(0.05)
    })
    const light = await held.light(views)
    rows.forEach((row, i) => {
      if (!row.domain) return
      for (const band of BANDS) {
        const got = light[i]![band] + (whole ? 0 : row.first[band])
        const error = Math.abs(got / row.scaled[band] - 1)
        expect(Number.isFinite(error)).toBe(true)
        if (set === 'thin') {
          out.thin = Math.max(out.thin, error)
          continue
        }
        out.count += 1
        squares += error * error
        if (error > 0.05) out.over += 1
        if (error > out.worst) {
          out.worst = error
          out.at = `${radius} µm, band ${band}, τ ${depth}, μ₀ ${sunMu}, μ ${row.viewMu} at ${row.azimuth}°, ${side}`
        }
      }
    })
  }
  out.rms = Math.sqrt(squares / out.count)
  return out
}

/** Eight Gauss–Legendre points on (0, 1), and their weights. */
const GAUSS: readonly (readonly [number, number])[] = [
  [0.0198550717512319, 0.0506142681451881],
  [0.1016667612931866, 0.1111905172266872],
  [0.2372337950418355, 0.1568533229389436],
  [0.4082826787521751, 0.181341891689181],
  [0.5917173212478249, 0.181341891689181],
  [0.7627662049581645, 0.1568533229389436],
  [0.8983332387068134, 0.1111905172266872],
  [0.9801449282487681, 0.0506142681451881],
]
const AZIMUTHS = 16

/**
 * The reflected flux's worst relative error over the domain's slabs: the
 * march's light after first order summed at eight Gauss points in μ and
 * sixteen azimuths, with the oracle's first order's flux beside it,
 * against the oracle's flux on the renderer's medium.
 */
async function judgeFlux(
  held: Rig,
  maxSteps: number,
): Promise<{ worst: number; at: string; thin: number }> {
  const out = { worst: 0, at: '', thin: 0 }
  const views = GAUSS.flatMap(([mu]) =>
    Array.from({ length: AZIMUTHS }, (_, k) =>
      viewOf('reflected', mu, (360 * (k + 0.5)) / AZIMUTHS),
    ),
  )
  for (const slab of SLAB_REFERENCE.reflected) {
    held.place(slab.radius, slab.depth, slab.sunMu, 'reflected')
    held.uniforms.trace.maxSteps.value = maxSteps
    const light = await held.light(views)
    for (const band of BANDS) {
      let flux = 0
      GAUSS.forEach(([mu, weight], g) => {
        for (let k = 0; k < AZIMUTHS; k += 1)
          flux +=
            (light[g * AZIMUTHS + k]![band] * mu * weight * 2 * Math.PI) /
            AZIMUTHS
      })
      // Over the flux arriving, μ₀ on a face under a unit beam.
      const got = flux / slab.sunMu + slab.first[band]
      const error = Math.abs(got / slab.scaled[band] - 1)
      if (slab.set === 'thin') out.thin = Math.max(out.thin, error)
      else if (error > out.worst) {
        out.worst = error
        out.at = `${slab.radius} µm, band ${band}, τ ${slab.depth}, μ₀ ${slab.sunMu}`
      }
    }
  }
  return out
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`
const told = (name: string, judged: Judged): string =>
  `${name}: worst ${percent(judged.worst)} at ${judged.at}; RMS ${percent(judged.rms)}; ${judged.over} of ${judged.count} over 5%; thin slabs ${percent(judged.thin)}`

describe('a slab’s radiance and reflected flux, through the shipped step', () => {
  let shipped: Rig
  let exact: Rig

  beforeAll(async () => {
    shipped = await rig({ sun: 'shipped', phase: false })
    exact = await rig({ sun: 'exact', phase: false })
  }, 120_000)

  afterAll(() => {
    shipped.dispose()
    exact.dispose()
  })

  /*
   * Row 1, declared: the bar is 5%, and the table's own reconstruction is
   * 5.75% at its worst point, which is the worst point here. On the Mac
   * mini (Mac18,5, Apple M6): 5.79% with the shipped sun at both budgets
   * and with the exact sun, 1.32% root mean square, 13 of 6,246 radiances
   * over 5%; 9.88% on the thin slabs, which no row turns on. The ceilings
   * stand a fifth of a point and seven radiances off those, for an adapter
   * whose sampler weighs a texel otherwise. Retaken by whoever cuts the
   * table again.
   */
  it('holds row 1 at its measured 5.8% where the bar is 5%, with the shipped sun at step budgets of 192 and 128', async () => {
    for (const budget of [192, 128]) {
      const judged = await judge(shipped, budget, false)
      console.info(
        told(`cloudSlab: row 1, shipped sun, ${budget} steps`, judged),
      )
      expect(judged.count).toBe(6246)
      expect(judged.worst).toBeLessThan(0.06)
      expect(judged.rms).toBeLessThan(0.015)
      expect(judged.over).toBeLessThanOrEqual(20)
      expect(judged.thin).toBeLessThan(0.11)
    }
    const beside = await judge(exact, 192, false)
    console.info(told('cloudSlab: row 1, exact sun, 192 steps', beside))
    expect(beside.worst).toBeLessThan(0.06)
  }, 600_000)

  /*
   * Row 2, declared: the bar is 2% and the table's own figure is 1.97%.
   * Here 1.98% with either sun at either budget, at 6 µm, 440 nm, τ 5
   * under a sun straight above; 2.82% on the thin slabs. The ceiling
   * stands seven hundredths of a point off the figure. Without the light
   * behind the 1% exit it is 2.14% on the CPU.
   */
  it('holds row 2 at its measured 1.98% of the reflected flux, where the bar is 2%', async () => {
    for (const [name, held, budget] of [
      ['shipped sun, 192 steps', shipped, 192],
      ['shipped sun, 128 steps', shipped, 128],
      ['exact sun, 192 steps', exact, 192],
    ] as const) {
      const flux = await judgeFlux(held, budget)
      console.info(
        `cloudSlab: row 2, ${name}: worst ${percent(flux.worst)} at ${flux.at}; thin slabs ${percent(flux.thin)}`,
      )
      expect(flux.worst).toBeLessThan(0.0205)
      expect(flux.thin).toBeLessThan(0.035)
    }
  }, 600_000)

  it('holds row 1 through the march’s own first order as well, the committed phase under the reference’s sun', async () => {
    const whole = await rig({ sun: 'shipped', phase: true })
    const judged = await judge(whole, 192, true)
    console.info(told('cloudSlab: row 1, the march’s own first order', judged))
    // 5.83% here, 15 radiances over 5%.
    expect(judged.worst).toBeLessThan(0.06)
    expect(judged.over).toBeLessThanOrEqual(22)
    whole.dispose()
  }, 600_000)

  /*
   * The instrument, watched failing. A source held from a step's start is
   * 15.7% off at worst on the CPU where the two ends read 6.4%: the same
   * march with `sourceAtStart` must read past a tenth, or these gates
   * could not tell the two. Here it reads 10.5% at worst and 250
   * radiances over 5% where the two ends read 13.
   */
  it('reads 250 radiances over 5% with the source held from a step’s start, where the two ends read 13', async () => {
    const held = await rig({
      sun: 'shipped',
      phase: false,
      march: { sourceAtStart: true },
    })
    const judged = await judge(held, 192, false)
    console.info(told('cloudSlab: the source held from a step’s start', judged))
    expect(judged.worst).toBeGreaterThan(0.08)
    expect(judged.over).toBeGreaterThan(100)
    held.dispose()
  }, 600_000)

  /*
   * The factor of the sun is a cumuliform level's. On a slab whose level
   * has no cumuliform share the `'slab'` transport and the `'plane'` one
   * draw one picture, so the gates above hold whichever the lever is at;
   * on a level that is all cumulus the two differ by the factor itself.
   */
  it('draws a stratiform slab alike with the factor of the sun on and off, and a cumuliform one apart by the factor', async () => {
    const views = [0.2, 0.6, 1].flatMap((mu) =>
      [0, 90, 180].map((azimuth) => viewOf('reflected', mu, azimuth)),
    )
    const draw = async (convective: number, transport: number) => {
      shipped.place(10, 20, 0.5, 'reflected')
      shipped.uniforms.trace.maxSteps.value = 192
      shipped.share(convective)
      shipped.uniforms.trace.transport.value = transport
      const light = await shipped.light(views)
      shipped.share(0)
      shipped.uniforms.trace.transport.value = 0
      return light
    }
    const SLAB = CLOUD_TRANSPORTS.indexOf('slab')
    const PLANE = CLOUD_TRANSPORTS.indexOf('plane')
    const stratiform = [await draw(0, SLAB), await draw(0, PLANE)] as const
    const cumuliform = [await draw(1, SLAB), await draw(1, PLANE)] as const
    const { l, a } = CLOUD_SUN_FACTORS.cumulus!
    const factor = l * (1 + (a * Math.sqrt(1 - 0.5 * 0.5)) / 0.5)
    views.forEach((_, i) => {
      for (const band of BANDS) {
        expect(stratiform[0][i]![band]).toBeGreaterThan(0)
        expect(stratiform[0][i]![band]).toBe(stratiform[1][i]![band])
        expect(cumuliform[1][i]![band]).toBe(stratiform[1][i]![band])
        expect(
          Math.abs(cumuliform[0][i]![band] / cumuliform[1][i]![band] - factor),
        ).toBeLessThan(1e-4 * factor)
      }
    })
  }, 600_000)

  /*
   * A slab is a level whose columns do not spread, so a step that reads
   * it as statistics and one that reads it resolved stand in one slab:
   * the far march and the fine march handed one set of statistics differ
   * only by the two Gauss points, which stand 1/√k, a hundredth, to each
   * side of the one depth: 0.09% to 0.22% here, the most on the
   * deepest slab under a sun straight above.
   */
  it('lights a slab alike read resolved and read as its level’s statistics, within half a percent', async () => {
    const views = [0.2, 0.6, 1].flatMap((mu) =>
      [0, 90, 180].map((azimuth) => viewOf('reflected', mu, azimuth)),
    )
    for (const [depth, sunMu] of [
      [5, 0.2],
      [20, 0.5],
      [50, 1],
    ] as const) {
      exact.place(10, depth, sunMu, 'reflected')
      exact.uniforms.trace.maxSteps.value = 192
      exact.uniforms.camera.pixelAngle.value = 0
      const resolved = await exact.light(views)
      // A footprint a thousand cells wide a meter out: every step reads
      // its level's statistics.
      exact.uniforms.camera.pixelAngle.value = 1e6
      const statistical = await exact.light(views)
      exact.uniforms.camera.pixelAngle.value = 0
      let worst = 0
      views.forEach((_, i) => {
        for (const band of BANDS)
          worst = Math.max(
            worst,
            Math.abs(statistical[i]![band] / resolved[i]![band] - 1),
          )
      })
      console.info(
        `cloudSlab: τ ${depth} under μ₀ ${sunMu}, read as statistics against resolved: ${percent(worst)} apart at worst`,
      )
      expect(worst).toBeLessThan(5e-3)
    }
  }, 600_000)
})

describe('a deck under a sun below its horizon', () => {
  /*
   * Under a sun below a sample's horizon the lit face is the base: the
   * sun's depths are sided that way, and the view's cosine turns over
   * with it. A deck seen from below under a sun 3° under the horizon is
   * the same deck seen from above under a sun 3° over it, mirrored, and
   * a view cosine left in the upper frame reads the wrong hemisphere of
   * the table: the source's two hemispheres differ by half at a face.
   *
   * The slab is ten meters thick: under a grazing sun a kilometer of slab
   * holds 19 km of the sun's ray, which climbs 28 m of the sphere, and the
   * mirror is a plane's.
   */
  it('lights a deck from below under a sun 3° under the horizon as the same deck from above under a sun 3° over it', async () => {
    const held = await rig({ sun: 'exact', phase: false, thickness: 10 })
    const sunMu = Math.sin((3 * Math.PI) / 180)
    const views = [0.15, 0.5, 0.9].flatMap((mu) =>
      [0, 60, 120, 180].map((azimuth) => [mu, azimuth] as const),
    )
    for (const depth of [2, 20]) {
      held.place(10, depth, sunMu, 'reflected')
      held.uniforms.trace.maxSteps.value = 192
      const above = await held.light(
        views.map(([mu, azimuth]) => viewOf('reflected', mu, azimuth)),
      )
      // The mirror: the eye under the base, the sun under the horizon, and
      // every view turned over.
      held.place(10, depth, -sunMu, 'transmitted')
      const below = await held.light(
        views.map(([mu, azimuth]) => viewOf('transmitted', mu, azimuth)),
      )
      let worst = 0
      views.forEach((_, i) => {
        for (const band of BANDS) {
          expect(above[i]![band]).toBeGreaterThan(0)
          worst = Math.max(
            worst,
            Math.abs(below[i]![band] / above[i]![band] - 1),
          )
        }
      })
      console.info(
        `cloudSlab: a deck of τ ${depth} mirrored about its middle under a sun 3° under: ${percent(worst)} apart at worst`,
      )
      expect(worst).toBeLessThan(5e-3)
    }
    held.dispose()
  }, 600_000)
})
