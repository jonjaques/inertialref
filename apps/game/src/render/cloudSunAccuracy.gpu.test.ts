import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
} from 'three/webgpu'
import {
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  length,
  Loop,
  max,
  select,
  storage,
  uint,
  uniform,
} from 'three/tsl'
import {
  type ScenarioId,
  scenarioCoverage,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { altitudeAt, shellCrossingFrom, sunMuAt } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget, CloudSample } from './cloudNodes.ts'
import { SUN_GRID_SIZE } from './cloudSunGrid.ts'
import {
  LOOKING_UP,
  RIG_EARTH_RADIUS,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import landed from './cloudSunAccuracy.landed.json' with { type: 'json' }
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun grid's optical depth against a march through the field (§8.6):
 * T_cloud's error in five scenarios at two suns, at lightTaps 2 and 4.
 *
 * **Every figure is held to the landed one.** `cloudSunAccuracy.landed.json`
 * is the instrument's document on the landed code:
 * `choices-2026-11-10T11-49-33Z-sunAccuracy.json` of phase 0's
 * measurements, taken at `51c96da4` on the Mac mini (Mac18,5, Apple M6). A
 * case's RMS, its bias and its worst sample may each pass the landed value
 * by a tenth and no more. One scenario runs in every `pnpm test:gpu`,
 * fair-cumulus under both suns; all ten cases run under IR_CLOUD_MEASURE=1,
 * which also writes `.data/clouds/sunAccuracy.json`. The bound is this
 * adapter's: it is asserted where the adapter offers timestamps, which is
 * how the suite tells a workstation from CI's hosted device, and there the
 * figures are still taken and held finite.
 *
 * The bounds tighten and are never loosened. A change that moves a figure
 * replaces the landed document in the commit that moves it, so the diff
 * shows the old figure and the new.
 *
 * The field is the system's own (`createCloudField`), its bakes driven by
 * frames built as the sensor builds them, over Earth turned so the eye, 2 m
 * up, stands where the scenario's cover is thickest: under a blob or a band
 * a fixed place may hold no cloud for kilometers. The samples are a lattice
 * of 24 × 24 columns 4 km either side of the eye, eight heights through
 * each layer, and every one the field holds cloud at is scored: the
 * light's T_cloud — its taps, then the grid's optical depth beyond them —
 * against exp(−∫σ·f ds) by 256 steps of the same field medium to the
 * union's top along the sun, f the medium's fraction, as the grid stores
 * σ·f. Every sample is resolved, its footprint 0.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/sunAccuracy.json'
/** The adapter the landed figures were taken on is a workstation's: it offers timestamps. */
const WORKSTATION = await adapterOffers('timestamp-query')
/** A figure may pass its landed value by a tenth (phase 1 design §6.3). */
const SLACK = 1.1
/**
 * The scenario every run of the suite takes, at both suns. Under the high
 * sun a kilometer of taps reaches most of the way out of a cumulus, so the
 * case holds the taps and reads little of the grid: with a fifth of the
 * grid's depth lost, each of its six figures is still inside its bound, and
 * with the taps' depth halved its RMS at two taps is 0.162 against a bound
 * of 0.146. Under the low sun the path past the taps is long, and the loss
 * in the grid moves the bias at four taps from 0.0004 to 0.0006.
 */
const ALWAYS: ScenarioId = 'fair-cumulus'

const CSS = { width: 1024, height: 576 } as const
const SCENARIOS: readonly ScenarioId[] = [
  'fair-cumulus',
  'two-decks',
  'anvil',
  'overcast',
  'cirrus-over-cumulus',
]
/** Degrees over the eye's horizon. */
const SUNS = [37.5, 5] as const
const TAPS = [2, 4] as const
const REFERENCE_STEPS = 256
const ACROSS = 24
/** Meters either side of the eye: inside the grid's window (25.6 km). */
const REACH = 4000
const HEIGHTS_A_LAYER = 8
const EYE = 2
const POINTS = ACROSS * ACROSS * HEIGHTS_A_LAYER * 3
/** The rig's instant: the blobs' period index the CPU's cover is read at. */
const TIME = 50_000
const SETTLE_MIN = 12
const SETTLE_MAX = 240
/** Directions the place is chosen from: a Fibonacci sphere. */
const PLACES = 4096

const R = RIG_EARTH_RADIUS
const radians = (d: number): number => (d * Math.PI) / 180

/** The body-fixed direction where every layer's cover is thickest, its least layer's first. */
function thickest(scenario: ScenarioId): Vec3 {
  const s = WEATHER_SCENARIOS[scenario]
  let best: Vec3 = { x: 0, y: 1, z: 0 }
  let score = -1
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let k = 0; k < PLACES; k += 1) {
    const y = 1 - (2 * (k + 0.5)) / PLACES
    const ring = Math.sqrt(1 - y * y)
    const d = {
      x: Math.cos(golden * k) * ring,
      y,
      z: Math.sin(golden * k) * ring,
    }
    const cover = Math.min(
      ...s.layers.map((_, layer) => scenarioCoverage(s, layer, d, TIME)),
    )
    if (cover > score) {
      score = cover
      best = d
    }
  }
  return best
}

/** The turn that carries a body-fixed direction onto the render's +Y, over which the rig's eye stands. */
function turnOnto(direction: Vec3): Quat {
  const up = { x: 0, y: 1, z: 0 }
  const axis = Vec.cross(direction, up)
  const sine = Vec.length(axis)
  if (sine < 1e-12) return Q.IDENTITY
  return Q.fromAxisAngle(
    Vec.scale(axis, 1 / sine),
    Math.atan2(sine, Vec.dot(direction, up)),
  )
}

/**
 * The lattice, eye-relative and body-fixed, float64 then float32: a column
 * `d` meters out along the ground stands on the sphere, its height's point
 * (R + h)·(sin φ, cos φ) from the center at φ = d/R, less the eye's.
 */
function lattice(scenario: ScenarioId, turn: Quat): Float32Array {
  const into = new Float32Array(POINTS * 4)
  const back = Q.conjugate(turn)
  let n = 0
  const heights = WEATHER_SCENARIOS[scenario].layers.flatMap((layer) =>
    Array.from(
      { length: HEIGHTS_A_LAYER },
      (_, k) =>
        layer.base + ((k + 0.5) / HEIGHTS_A_LAYER) * (layer.top - layer.base),
    ),
  )
  for (const h of heights)
    for (let j = 0; j < ACROSS; j += 1)
      for (let i = 0; i < ACROSS; i += 1) {
        const x = REACH * ((2 * (i + 0.5)) / ACROSS - 1)
        const z = REACH * ((2 * (j + 0.5)) / ACROSS - 1)
        const d = Math.hypot(x, z)
        const phi = d / R
        const out = d === 0 ? 0 : ((R + h) * Math.sin(phi)) / d
        const render: Vec3 = {
          x: x * out,
          y: (R + h) * Math.cos(phi) - (R + EYE),
          z: z * out,
        }
        const fixed = Q.rotate(back, render)
        into.set([fixed.x, fixed.y, fixed.z, 0], 4 * n)
        n += 1
      }
  return into
}

/* ------------------------------------------------------------------------- */

let gpu: GpuSession
let field: CloudField

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

interface Scored {
  readonly rms: number
  readonly worst: number
  /** Mean signed error: positive where the grid passes more sun. */
  readonly bias: number
}

interface Case {
  readonly scenario: string
  readonly sunDegrees: number
  readonly place: { readonly latitude: number; readonly longitude: number }
  readonly samples: number
  readonly inCloud: number
  readonly meanReference: number
  readonly grid: Readonly<Record<string, Scored>>
}

/** The landed figures of a case, or a failure: a case with no bound is a case that cannot fail. */
function landedCase(found: Case): Case {
  const pinned = (landed.cases as readonly Case[]).find(
    (one) =>
      one.scenario === found.scenario && one.sunDegrees === found.sunDegrees,
  )
  if (pinned === undefined)
    throw new Error(
      `no landed figures for ${found.scenario} at ${found.sunDegrees}°`,
    )
  return pinned
}

/** Hold a case's every figure to its landed one, at both tap counts. */
function hold(found: Case): void {
  const what = `${found.scenario} at ${found.sunDegrees}°`
  // Cloud to score, and a transmittance error is at most 1.
  expect(found.inCloud, what).toBeGreaterThan(0)
  const pinned = landedCase(found)
  for (const taps of TAPS) {
    const now = found.grid[taps]!
    const then = pinned.grid[taps]!
    for (const figure of [now.rms, now.worst, now.bias])
      expect(Number.isFinite(figure), `${what}, ${taps} taps`).toBe(true)
    expect(now.worst, what).toBeLessThanOrEqual(1)
    if (!WORKSTATION) continue
    expect(now.rms, `${what}, ${taps} taps: rms`).toBeLessThanOrEqual(
      then.rms * SLACK,
    )
    expect(now.worst, `${what}, ${taps} taps: worst`).toBeLessThanOrEqual(
      then.worst * SLACK,
    )
    expect(
      Math.abs(now.bias),
      `${what}, ${taps} taps: bias`,
    ).toBeLessThanOrEqual(Math.abs(then.bias) * SLACK)
  }
}

describe('the sun’s optical depth against the field', () => {
  /** Score the grid at both tap counts on the real field, a scenario at a time, at each of its suns. */
  async function measure(
    scenarios: readonly ScenarioId[],
    suns: readonly number[],
  ): Promise<Case[]> {
    const renderer = gpu.renderer
    const offsets = new StorageBufferAttribute(new Float32Array(POINTS * 4), 4)
    const out = new StorageBufferAttribute(new Float32Array(POINTS * 2), 1)
    const count = uniform(0, 'uint')
    const body = field.uniforms.served

    const sampleOf = (offset: Node<'vec3'>): CloudSample => ({
      offset,
      distance: length(offset),
      altitude: altitudeAt(body, offset),
      sunMu: sunMuAt(body, offset),
      footprint: float(0),
    })
    const pointKernel = (
      scored: (sample: CloudSample) => Node<'float'>,
    ): ComputeNode => {
      const from = storage(offsets, 'vec4', POINTS)
      const into = storage(out, 'float', POINTS * 2)
      return Fn(() => {
        If(instanceIndex.lessThan(count), () => {
          const offset = from.element(instanceIndex).xyz.toVar()
          const sample = sampleOf(offset)
          const medium = field.medium(sample, body)
          const at = instanceIndex.mul(uint(2))
          into.element(at).assign(medium.sigma.mul(medium.fraction))
          into.element(at.add(uint(1))).assign(scored(sample))
        })
      })().compute(POINTS)
    }
    // exp(−∫σ·f ds) by 256 steps of the field to the union's top along the sun.
    const reference = pointKernel((sample) => {
      const top = shellCrossingFrom(
        body,
        sample.offset,
        body.sun,
        body.boundariesHigh.y,
      )
      const reach = select(top.hit, max(top.far, 0), float(0))
      const step = reach.div(REFERENCE_STEPS).toVar()
      const tau = float(0).toVar()
      Loop(REFERENCE_STEPS, ({ i }: { i: Node<'int'> }) => {
        const point = sample.offset.add(
          body.sun.mul(float(i).add(0.5).mul(step)),
        )
        const medium = field.medium(sampleOf(point), body)
        tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
      })
      return exp(tau.negate())
    })
    const grid = pointKernel(
      (sample) => field.sun(sample, field.medium(sample, body), body).cloud,
    )

    let previous: CloudFrame | null = null
    const frameAt = (stance: RigStance, levers: CloudLevers): CloudFrame => {
      const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
      if (frame === null) throw new Error('no frame: nothing served')
      previous = frame
      const budget: CloudBudget = {
        slices: 8,
        tiles: 1,
        jump: frame.jump,
        sunSlices: SUN_GRID_SIZE[2],
      }
      field.write(frame)
      field.render(renderer, frame, budget)
      return frame
    }
    const settle = (stance: RigStance, levers: CloudLevers): void => {
      for (let n = 0; n < SETTLE_MAX; n += 1) {
        frameAt(stance, levers)
        if (n >= SETTLE_MIN && field.bakes.every((bake) => !bake.pending))
          return
      }
      throw new Error(`the bakes still owe work after ${SETTLE_MAX} frames`)
    }
    const read = async (kernel: ComputeNode): Promise<Float32Array> => {
      await gpu.compute(kernel)
      return new Float32Array(await gpu.readBuffer(out))
    }

    const results: Case[] = []
    for (const scenario of scenarios) {
      const place = thickest(scenario)
      const turn = turnOnto(place)
      const points = lattice(scenario, turn)
      ;(offsets.array as Float32Array).set(points)
      offsets.needsUpdate = true
      count.value = points.length / 4
      for (const elevation of suns) {
        const stance: RigStance = {
          eye: EYE,
          looking: LOOKING_UP,
          turn,
          air: true,
          sun: {
            x: 0,
            y: Math.sin(radians(elevation)),
            z: -Math.cos(radians(elevation)),
          },
        }
        const levers = (lightTaps: (typeof TAPS)[number]): CloudLevers => ({
          ...DEFAULT_CLOUD_LEVERS,
          on: true,
          weather: scenario,
          lightTaps,
        })
        settle(stance, levers(2))
        const truth = await read(reference)
        const inCloud: number[] = []
        for (let k = 0; k < count.value; k += 1)
          if (truth[2 * k]! > 0) inCloud.push(k)
        const scored: Record<string, Scored> = {}
        for (const taps of TAPS) {
          // The taps are a uniform: one frame writes it, and builds nothing.
          frameAt(stance, levers(taps))
          const got = await read(grid)
          const miss = inCloud.map((k) => got[2 * k + 1]! - truth[2 * k + 1]!)
          scored[taps] = {
            rms: Math.sqrt(
              miss.reduce((s, v) => s + v * v, 0) / Math.max(miss.length, 1),
            ),
            worst: Math.max(0, ...miss.map(Math.abs)),
            bias: miss.reduce((s, v) => s + v, 0) / Math.max(miss.length, 1),
          }
        }
        results.push({
          scenario,
          sunDegrees: elevation,
          place: {
            latitude: (Math.asin(place.y) * 180) / Math.PI,
            longitude: (Math.atan2(place.x, place.z) * 180) / Math.PI,
          },
          samples: count.value,
          inCloud: inCloud.length,
          meanReference:
            inCloud.reduce((s, k) => s + truth[2 * k + 1]!, 0) /
            Math.max(inCloud.length, 1),
          grid: scored,
        })
      }
    }

    for (const kernel of [reference, grid]) kernel.dispose()
    offsets.dispose()
    out.dispose()
    return results
  }

  it('holds fair-cumulus under both suns to its landed figures, in every run of the suite', async () => {
    const found = await measure([ALWAYS], SUNS)
    expect(found.map((one) => [one.scenario, one.sunDegrees])).toEqual(
      SUNS.map((sun) => [ALWAYS, sun]),
    )
    for (const one of found) hold(one)
  }, 120_000)

  it.skipIf(!MEASURE)(
    'holds all ten cases to their landed figures, and writes them',
    async () => {
      const results = await measure(SCENARIOS, SUNS)
      expect(results).toHaveLength(landed.cases.length)
      for (const found of results) hold(found)

      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudSunAccuracy.gpu.test.ts: T_cloud through the sun grid against a 256-step march of the field to the union top, at in-cloud samples (§8.6)',
            body: 'Earth',
            eyeMeters: EYE,
            lattice: {
              columns: ACROSS * ACROSS,
              reachMeters: REACH,
              heightsALayer: HEIGHTS_A_LAYER,
            },
            referenceSteps: REFERENCE_STEPS,
            units: 'transmittance, absolute',
            cases: results,
          },
          null,
          2,
        )}\n`,
      )
    },
    600_000,
  )
})
